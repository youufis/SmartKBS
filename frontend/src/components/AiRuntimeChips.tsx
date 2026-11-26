/**
 * AiRuntimeChips —— 模型接入 + 知识库选用 的统一状态胶囊（教师端）
 *
 * 【为什么要有它】以前这件事散在三处：对话页手写两颗 span、本地文库页一个 Tag、
 * 系统配置页一份表单，口径各说各话。教师在任何一个日常页面上都问不出
 * "现在到底是谁在回答我、这次查没查知识库"——而这两件事恰恰决定了回答能不能采信。
 *
 * 【口径】
 *   1. 胶囊只描述**当前生效**的那一路，生效判定来自服务端 /api/config/ai-runtime
 *      （它读 get_ai_config() 与 llm_provider.effective_engine()，与真实调用链同源），
 *      前端不排优先级、不猜引擎；
 *   2. 模型名直接上胶囊："云端模型"是档名，不等于"用的是 qwen3.7-flash"，教师排障时
 *      要核对的是名字本身；但名字太长（或窗口太窄、页头放不下）就自动退回只显档名，
 *      名字完整留在明细里 —— 宁可少一层信息，也不让页头换行；
 *   3. ⚠ 只有一个触发条件——某一路"已启用但未就绪"把链路压到了更低一级。
 *      已就绪但被更高优先级压制的那一路不算异常，只在明细里中性标注"未参与"；
 *      曾经设计过"待命"态，因为它既不需要用户处理、又让人误以为出了问题而否掉；
 *   4. 学生端不显示（角色判定收在组件里，接入方不必各自再判一遍）；
 *   5. 明细只解释"现在是什么、为什么"，不放"去系统配置调整"这类入口 ——
 *      配置只有管理员能改，教师看了是无从下手，管理员本来就知道在哪。
 *
 * 【样式】配色一律取 antd token 的语义色（colorPrimaryBg / colorSuccessBg /
 * colorWarningBg / colorFillTertiary），五套主题含暗夜星空自动跟随，
 * 不再复写对话页那种硬编码 hex。
 */
import React, { useEffect, useState } from 'react'
import { Grid, Popover, theme } from 'antd'
import {
  CloudOutlined, DatabaseOutlined, DesktopOutlined,
  ExclamationCircleOutlined, SwapOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { AiRuntimeKb, AiRuntimeModel, KbEffective } from '../api/aiRuntime'
import { subscribeAiRuntime, useAiRuntimeStore } from '../stores/aiRuntimeStore'
import { useAuthStore } from '../stores/authStore'
import { useIsMobile } from '../hooks/useIsMobile'
import { modelFitsChip } from '../utils/aiRuntimeLabel'

export interface AiRuntimeChipsProps {
  /** 简报/学情这类"数据直连大模型、本就不走检索"的页面只看模型，免得"未启用知识库"看着像报错 */
  show?: 'both' | 'model' | 'kb'
  /** compact 用于卡片标题、弹层等窄位：只留档名，模型名与文档数进明细 */
  density?: 'default' | 'compact'
  className?: string
  style?: React.CSSProperties
}

type Tone = 'cloud' | 'local' | 'hybrid' | 'neutral'

const MONO = 'ui-monospace, SFMono-Regular, Consolas, Menlo, monospace'

/** 语义色四套：云端=蓝、本地=绿、本地优先=金、无/未知=中性灰 */
function usePalette(): Record<Tone, { bg: string; bd: string; fg: string }> {
  const { token } = theme.useToken()
  return {
    cloud: { bg: token.colorPrimaryBg, bd: token.colorPrimaryBorder, fg: token.colorPrimaryTextActive },
    local: { bg: token.colorSuccessBg, bd: token.colorSuccessBorder, fg: token.colorSuccessTextActive },
    hybrid: { bg: token.colorWarningBg, bd: token.colorWarningBorder, fg: token.colorWarningTextActive },
    neutral: { bg: token.colorFillTertiary, bd: token.colorBorderSecondary, fg: token.colorTextSecondary },
  }
}

const Row: React.FC<{ k: string; v: React.ReactNode; note?: React.ReactNode; warn?: boolean }> = ({ k, v, note, warn }) => {
  const { token } = theme.useToken()
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '2px 0' }}>
      <span style={{ flex: '0 0 76px', fontSize: 12, color: token.colorTextTertiary }}>{k}</span>
      <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 12, color: warn ? token.colorWarningText : token.colorText }}>
        {v}
        {note && (
          <span style={{ display: 'block', fontSize: 11, color: token.colorTextTertiary, marginTop: 1 }}>
            {note}
          </span>
        )}
      </span>
    </div>
  )
}

const Mono: React.FC<{ text: string }> = ({ text }) => <span style={{ fontFamily: MONO }}>{text}</span>

const Tip: React.FC<{ tone?: 'warn' | 'info'; children: React.ReactNode }> = ({ tone = 'warn', children }) => {
  const { token } = theme.useToken()
  const warn = tone === 'warn'
  return (
    <div style={{
      display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 8,
      padding: '6px 8px', borderRadius: 6, fontSize: 12, lineHeight: 1.5,
      background: warn ? token.colorWarningBg : token.colorInfoBg,
      border: `1px solid ${warn ? token.colorWarningBorder : token.colorInfoBorder}`,
      color: warn ? token.colorWarningTextActive : token.colorText,
    }}>
      {warn && <ExclamationCircleOutlined style={{ marginTop: 2, flex: '0 0 auto' }} />}
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  )
}

function engineText(m: AiRuntimeModel, t: (k: string) => string): string {
  if (m.engine === 'local') return `${t('aiRuntimeEngineLocal')} · ${t('aiRuntimeProviderOllama')}`
  if (m.engine === 'hybrid') return `${t('aiRuntimeEngineHybrid')} · ${t('aiRuntimeProviderOllama')} → ${t('aiRuntimeProviderDashscope')}`
  return `${t('aiRuntimeEngineCloud')} · ${t('aiRuntimeProviderDashscope')}`
}

const ModelDetail: React.FC<{ m: AiRuntimeModel }> = ({ m }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  // 生效的那一组模型名：本地分流开着时，长文/视觉同样被 route() 改写成本地名
  const eff = m.provider === 'ollama' ? m.local : m.cloud
  return (
    <div style={{ width: 312 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: token.colorTextSecondary }}>
        {t('aiRuntimeSecModel')}
      </div>
      {m.config_conflict && <Tip>{t('aiRuntimeConflictTip')}</Tip>}
      <div style={{ marginTop: 6 }}>
        <Row k={t('aiRuntimeDetailEngine')} v={engineText(m, t)} warn={m.config_conflict} />
        <Row k={t('aiRuntimeDetailChatModel')} v={<Mono text={m.active} />} />
        <Row k={t('aiRuntimeDetailLongModel')} v={<Mono text={eff.long} />} />
        <Row k={t('aiRuntimeDetailVlModel')} v={<Mono text={eff.vl} />} />
        <Row k={t('aiRuntimeDetailMultimodal')} v={t('aiRuntimeMultimodalOn')} />
        {m.mode !== 'cloud' && (
          <Row
            k={t('aiRuntimeDetailLocalEngine')}
            v={<Mono text={m.local.chat} />}
            note={m.local.base ? <Mono text={m.local.base} /> : t('aiRuntimeLocalNoBase')}
          />
        )}
        {!!m.hybrid_fallback && <Row k={t('aiRuntimeDetailFallback')} v={<Mono text={m.hybrid_fallback} />} />}
      </div>
      <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 8 }}>
        {t('aiRuntimeModelFootNote')}
      </div>
    </div>
  )
}

/** 某一路知识库的四档描述：生效中 / 未参与 / 未就绪 / 未启用 */
function kbStateWord(
  effective: KbEffective, side: KbEffective,
  info: { enabled: boolean; ready: boolean }, t: (k: string) => string,
): { word: string; tone: Tone } {
  if (effective === side && info.ready) return { word: t('aiRuntimeStateActive'), tone: 'local' }
  if (!info.enabled) return { word: t('aiRuntimeStateOff'), tone: 'neutral' }
  if (!info.ready) return { word: t('aiRuntimeStateNotReady'), tone: 'hybrid' }
  return { word: t('aiRuntimeStateIdle'), tone: 'neutral' }
}

const StateWord: React.FC<{ state: { word: string; tone: Tone } }> = ({ state }) => {
  const pal = usePalette()
  return <span style={{ color: pal[state.tone].fg, fontWeight: 600 }}>{state.word}</span>
}

const KbDetail: React.FC<{ kb: AiRuntimeKb }> = ({ kb }) => {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const cloudState = kbStateWord(kb.effective, 'cloud', kb.cloud, t)
  const localState = kbStateWord(kb.effective, 'local', kb.local, t)
  const cloudNote = !kb.cloud.enabled ? undefined : kb.cloud.ready
    ? <><Mono text={kb.cloud.agent_id} />{kb.cloud.endpoint_host ? ` · ${kb.cloud.endpoint_host}` : ''}<br />
        {t('aiRuntimeCloudRecall', { topK: kb.cloud.top_k, minScore: kb.cloud.min_score })}</>
    : kb.cloud.reason
  const localNote = !kb.local.enabled ? undefined : (
    <>
      {t('aiRuntimeLocalCount', { docs: kb.local.docs, chunks: kb.local.chunks })}
      {kb.local.ready ? ` · ${t('aiRuntimeLocalVec', { n: kb.local.vec_docs })}` : ''}
      <br />
      {t('aiRuntimeLocalEmbed')}：{kb.local.embed_provider === 'local'
        ? t('aiRuntimeEmbedLocal', { model: kb.local.embed_model })
        : t('aiRuntimeEmbedCloud', { model: kb.local.embed_model })}
    </>
  )
  return (
    <div style={{ width: 312 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: token.colorTextSecondary }}>
        {t('aiRuntimeSecKb')}
      </div>
      {kb.degraded && kb.reasons.length > 0 && (
        <Tip>{kb.reasons.join('；')}</Tip>
      )}
      <div style={{ marginTop: 6 }}>
        <Row k={t('aiRuntimeKbCloud')} v={<StateWord state={cloudState} />} note={cloudNote} />
        <Row k={t('aiRuntimeKbLocal')} v={<StateWord state={localState} />} note={localNote} />
        <Row k={t('aiRuntimeDetailPriority')} v={<Mono text={t('aiRuntimePriorityChain')} />} />
      </div>
      <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 8 }}>
        {t('aiRuntimeKbFootNote')}
      </div>
    </div>
  )
}

const Chip: React.FC<{
  tone: Tone; icon: React.ReactNode; label: string; warn?: boolean;
  aria: string; detail: React.ReactNode;
}> = ({ tone, icon, label, warn, aria, detail }) => {
  const pal = usePalette()
  const c = pal[tone]
  // antd v6 的 Popover 只绑鼠标事件，不绑键盘。这颗胶囊是 role="button"、可 Tab 聚焦的，
  // 那就必须能用回车/空格打开 —— 否则键盘用户拿到的是一个"能聚焦、按了没反应"的假按钮。
  const [open, setOpen] = useState(false)
  const node = (
    <span
      role="button"
      tabIndex={0}
      aria-label={aria}
      aria-expanded={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) }
      }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
        fontSize: 12, lineHeight: '20px', padding: '1px 8px', borderRadius: 4,
        background: c.bg, color: c.fg, border: `1px solid ${c.bd}`,
        maxWidth: '100%', minWidth: 0, whiteSpace: 'nowrap',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', flex: '0 0 auto' }}>{icon}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      {warn && <ExclamationCircleOutlined style={{ color: 'var(--warning-color, #d48806)', flex: '0 0 auto' }} />}
    </span>
  )
  return (
    <Popover trigger={['hover', 'click']} placement="bottomRight" content={detail}
      open={open} onOpenChange={setOpen}>
      {node}
    </Popover>
  )
}

const AiRuntimeChips: React.FC<AiRuntimeChipsProps> = ({ show = 'both', density = 'default', className, style }) => {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const screens = Grid.useBreakpoint()
  const role = useAuthStore((s) => s.user?.role)
  const data = useAiRuntimeStore((s) => s.data)
  // 学生端不显示，也就不必为一次用不上的状态位发请求
  const visible = role === 'teacher' || role === 'admin'
  useEffect(() => (visible ? subscribeAiRuntime() : undefined), [visible])
  if (!visible || !data) return null

  // <768px 一律降级成 compact：页头那一行要塞下标题与按钮，档名足够，
  // 模型名/文档数收进明细 —— 否则两颗长胶囊会把手机上的页头挤成三行。
  const dense = density === 'compact' || isMobile
  // 首帧 screens 可能是空对象：只有明确不是 xl 才当窄屏处理，避免桌面闪一下"名字消失"
  const narrowSlot = screens.xl === false

  const m: AiRuntimeModel = data.model
  const kb: AiRuntimeKb = data.kb
  const engineLabel = t(m.engine === 'local' ? 'aiRuntimeEngineLocal'
    : m.engine === 'hybrid' ? 'aiRuntimeEngineHybrid' : 'aiRuntimeEngineCloud')
  const engineTone: Tone = m.engine === 'local' ? 'local' : m.engine === 'hybrid' ? 'hybrid' : 'cloud'
  const engineIcon = m.engine === 'local' ? <DesktopOutlined />
    : m.engine === 'hybrid' ? <SwapOutlined /> : <CloudOutlined />

  const modelChip = (
    <Chip
      tone={m.config_conflict ? 'hybrid' : engineTone}
      icon={engineIcon}
      label={dense || !modelFitsChip(m.active, !narrowSlot) ? engineLabel : `${engineLabel} · ${m.active}`}
      warn={m.config_conflict}
      aria={`${t('aiRuntimeSecModel')}：${engineLabel} ${m.active || ''}`}
      detail={<ModelDetail m={m} />}
    />
  )

  let kbTone: Tone = 'neutral'
  let kbLabel = t('aiRuntimeKbNone')
  if (kb.effective === 'cloud') { kbTone = 'cloud'; kbLabel = t('aiRuntimeKbCloud') }
  if (kb.effective === 'local') {
    kbTone = 'local'
    kbLabel = !dense && kb.local.docs
      ? `${t('aiRuntimeKbLocal')} · ${kb.local.docs} ${t('aiRuntimeDocsUnit')}`
      : t('aiRuntimeKbLocal')
  }
  if (kb.effective === 'llm' && !dense) {
    kbLabel = `${t('aiRuntimeKbNone')} · ${t('aiRuntimeKbDirectLlm')}`
  }
  const kbChip = (
    <Chip
      tone={kbTone}
      icon={<DatabaseOutlined />}
      label={kbLabel}
      warn={kb.degraded}
      aria={`${t('aiRuntimeSecKb')}：${kbLabel}`}
      detail={<KbDetail kb={kb} />}
    />
  )

  return (
    <div
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: dense ? 6 : 8, flexWrap: 'wrap', ...style }}
    >
      {show !== 'kb' && modelChip}
      {show !== 'model' && kbChip}
    </div>
  )
}

export default AiRuntimeChips
