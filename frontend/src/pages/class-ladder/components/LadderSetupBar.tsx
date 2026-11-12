import { Button, Popconfirm, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { DatabaseOutlined, RobotOutlined, RocketOutlined, SettingOutlined, SoundOutlined, MutedOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LadderConfig, LadderSession } from '../../../api/classLadder'
import KnowledgePointSelect from '../../../components/KnowledgePointSelect'
import { LF_I18N } from '../constants'
import type { LadderSetupApi } from '../hooks/useLadderSetup'

const { Text } = Typography

interface Props {
  setup: LadderSetupApi
  config: LadderConfig | null
  session: LadderSession | null
  activeSkin: string
  onSkinChange: (v: string) => void
  soundOn: boolean
  soundAvailable: boolean
  onToggleSound: () => void
  setupOpen: boolean
  onToggleSetup: () => void
  autoAdvance?: boolean
  onToggleAutoAdvance?: () => void
}

/** 开场设置行：对局中自动收起，只留皮肤/声音/AI/结束与展开入口 */
export default function LadderSetupBar(p: Props) {
  const { t } = useTranslation('classLadder')
  const { setup, config, session, setupOpen } = p
  // 题池的随机范围：开场后以会话为准（题池就是按它建的），还没开场就跟着当前选择
  const scopeTopic = String((session ? session.topic : setup.topic) || '').trim()
  const scopeSubject = String((session ? session.subject : setup.subject) || '').trim()
  const scopeText = scopeTopic
    || (scopeSubject ? t('scopeSubject', { subject: scopeSubject }) : t('scopeAny'))
  return (
    <div className="cl-setup">
      {setupOpen && (<>
        <Select placeholder={t('selectGradePlaceholder')} value={setup.grade || undefined} onChange={setup.handleGradeChange}
          style={{ width: 118 }} options={setup.grades.map((g) => ({ label: g, value: g }))} />
        <Select placeholder={t('selectClassPlaceholder')} value={setup.cls || undefined} onChange={setup.handleClassChange}
          style={{ width: 130 }} disabled={!setup.grade} options={setup.classes.map((c) => ({ label: c, value: c }))} />

        <Select placeholder={t('subjectPlaceholder')} value={setup.subject || undefined} allowClear
          onChange={(v) => { setup.setSubject(v || ''); setup.setCourseKp('') }}
          style={{ width: 118 }} options={setup.subjects.map((s) => ({ label: s, value: s }))} />
        <KnowledgePointSelect multiple={false} subject={setup.subject} value={setup.courseKp}
          onChange={(v) => setup.setCourseKp(String(v || ''))}
          placeholder={t('kpPlaceholder')} style={{ width: 200 }} />

        <Select value={setup.questionType} onChange={setup.setQuestionType} style={{ width: 116 }}
          options={(config?.question_types || [{ value: 'single', label: t('qtSingle') }]).map((o) => ({
            label: o.value === 'true_false' ? t('qtTrueFalse') : t('qtSingle'), value: o.value,
          }))} />
        <Select value={setup.timeLimit} onChange={setup.setTimeLimit} style={{ width: 116 }}
          options={[...(config?.time_limits || [60, 90, 120]).map((n) => ({ label: t('secondUnit', { n }), value: n })),
            { label: t('timeLimitNone'), value: 0 }]} />
        <Select value={setup.poolSize} onChange={setup.setPoolSize} style={{ width: 108 }}
          options={[15, 30, 45].map((n) => ({ label: t('poolSizeUnit', { n }), value: n }))} />
        <Tooltip title={t('safeModeTip')}>
          <Space size={6}>
            <Switch checked={setup.safeMode} onChange={setup.setSafeMode} size="small" />
            <Text style={{ fontSize: 13 }}>{t('safeModeLabel')}</Text>
          </Space>
        </Tooltip>
        <Tooltip title={t('lifelinesTip')}>
          <Select mode="multiple" allowClear maxTagCount={1} placeholder={t('lifelinesLabel')}
            value={setup.lifelinesSel} onChange={(v) => setup.setLifelinesSel(v as string[])}
            style={{ minWidth: 168, maxWidth: 232 }}
            options={(config?.lifelines || []).map((l) => ({ value: l.type, label: t(LF_I18N[l.type] || 'lifelineRemoveOne') }))}
          />
        </Tooltip>
        <Tooltip title={t('advanceModeTip')}>
          <Space size={6}>
            <Switch checked={p.autoAdvance ?? true} onChange={() => p.onToggleAutoAdvance?.()} size="small" />
            <Text style={{ fontSize: 13 }}>{(p.autoAdvance ?? true) ? t('advanceAuto') : t('advanceManual')}</Text>
          </Space>
        </Tooltip>
      </>)}

      <Button size="small" type="text" className="cl-setup-toggle" icon={<SettingOutlined />}
        onClick={p.onToggleSetup}>{setupOpen ? t('setupCollapse') : t('setupExpand')}</Button>

      <Select value={p.activeSkin} onChange={p.onSkinChange} style={{ width: 132 }}
        options={(config?.skins || []).map((s) => ({
          label: `${s.light ? '☀ ' : '🌙 '}${t(`skinNames.${s.value}`, { defaultValue: s.label })}`, value: s.value,
        }))} />

      {/* 一个声音总开关：音效（WebAudio 合成）与抽中念名一起控制 */}
      <Tooltip title={!p.soundAvailable ? t('soundDisabledByAdmin') : (p.soundOn ? t('soundOnHint') : t('soundOffHint'))}>
        <Button size="small" disabled={!p.soundAvailable}
          icon={p.soundOn && p.soundAvailable ? <SoundOutlined /> : <MutedOutlined />}
          onClick={p.onToggleSound} />
      </Tooltip>
      {/* 知识点留空＝整库随机：AI 补题没有主题可依，出回来的题也挂不上知识点边，这里置灰 */}
      <Tooltip title={
        config && !config.ai_enabled ? t('aiDisabledByAdmin')
          : !setup.topic ? t('aiNeedTopicHint') : t('aiSwitchHint')
      }>
        <Space size={6}>
          <Switch checked={setup.allowAi && Boolean(setup.topic)}
            disabled={!config?.ai_enabled || !setup.topic} onChange={setup.setAllowAi} size="small" />
          <Text type={config?.ai_enabled && setup.topic ? undefined : 'secondary'} style={{ fontSize: 13 }}>
            <RobotOutlined /> {t('aiSwitch')}
          </Text>
        </Space>
      </Tooltip>
      {/* 范围标签：整库随机 / 学科 / 知识点，投屏时一眼看出这局题从哪来 */}
      <Tag color={scopeTopic ? 'cyan' : 'default'} title={scopeText}
        style={{ maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis',
                 whiteSpace: 'nowrap', verticalAlign: 'middle', marginInlineEnd: 0 }}>
        {scopeText}
      </Tag>
      {setupOpen && (<>
        <Button type="primary" icon={<RocketOutlined />} loading={setup.opening} disabled={!setup.ready} onClick={setup.doOpenSession}>
          {session ? t('resetSession') : t('startSession')}
        </Button>
        <Button icon={<DatabaseOutlined />} loading={setup.building} disabled={!session} onClick={() => void setup.doBuildPool()}>
          {setup.building && setup.poolProgress
            ? t('poolProgress', { done: setup.poolProgress.done, total: setup.poolProgress.total })
            : (session?.pool?.total ? t('rebuildPool') : t('buildPool'))}
        </Button>
      </>)}

      <Popconfirm title={t('confirmEnd')} disabled={!session} onConfirm={() => setup.doEndSession()}>
        <Button danger disabled={!session}>{t('endSession')}</Button>
      </Popconfirm>
    </div>
  )
}
