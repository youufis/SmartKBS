/**
 * 课堂闯关（大屏版）· 容器
 *
 * 教师投屏用的「百万富翁」式单人阶梯闯关：
 *   选主题/学科/知识点 → 生成题池（题库优先，可开关 AI 补题）→ 开一场
 *   → 抽一名学生 → 连打 15 关（每关可用 3 个锦囊之一）→ 答错/超时即止
 *   → 结算上榜 → 抽下一名学生开新局。
 *
 * 规则与学生端「知识闯关」同口径；学生不使用自己的设备，本页只面向教师投屏。
 * 结构：hooks/ 状态与流程 · components/ 展示层 · theme.ts 皮肤局部主题。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { App, ConfigProvider, Divider } from 'antd'
import { useTranslation } from 'react-i18next'
import { useIsMobile } from '../../hooks/useIsMobile'
import useNameSpeech from '../../hooks/useNameSpeech'
import type { LadderSession } from '../../api/classLadder'
import { SOUND_PREF_KEY } from './constants'
import { useLadderConfig } from './hooks/useLadderConfig'
import { useLadderSkin } from './hooks/useLadderSkin'
import { useLadderBoard } from './hooks/useLadderBoard'
import { useLadderSetup } from './hooks/useLadderSetup'
import { useLadderRun } from './hooks/useLadderRun'
import { useFullscreen } from './hooks/useFullscreen'
import LadderBar from './components/LadderBar'
import LadderSetupBar from './components/LadderSetupBar'
import LadderRungs from './components/LadderRungs'
import LadderStage from './components/LadderStage'
import LadderBoardPanel from './components/LadderBoardPanel'
import LadderFooter from './components/LadderFooter'
import LadderRecords from './components/LadderRecords'
import LadderResultOverlay from './components/LadderResultOverlay'
import LadderLifelineModals from './components/LadderLifelineModals'
import './ladder.css'

const ClassLadder: React.FC = () => {
  const { t } = useTranslation('classLadder')
  // message 走 App 上下文（静态方法吃不到主题，控制台也会告警）
  const { message } = App.useApp()
  const isMobile = useIsMobile()

  const config = useLadderConfig()
  const [session, setSession] = useState<LadderSession | null>(null)
  const { activeSkin, mode, theme, handleSkinChange } = useLadderSkin(config, session)
  const board = useLadderBoard()
  const { fs, toggleFs } = useFullscreen()

  /** 开场设置行：开局后自动收起，把舞台让给题目（可随时展开） */
  const [setupOpen, setSetupOpen] = useState(true)
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_PREF_KEY) !== '0')

  // 换场/结束场次要清对局，但 run 在 setup 之后初始化 —— 用 ref 桥接
  const resetRunRef = useRef<() => void>(() => {})

  const setup = useLadderSetup({
    config, message, activeSkin, session, setSession,
    onSessionReset: () => { setSetupOpen(true); resetRunRef.current() },
    refreshBoard: board.refreshBoard,
    clearBoard: board.clearBoard,
  })

  // 语音念名（与点名/抽问同一份实现：失败只给一句人话 + 重试入口）
  const speech = useNameSpeech({
    grade: setup.grade, class: setup.cls, enabled: setup.ttsEnabled, speakOn: soundOn,
    onDisabled: () => setup.setTtsEnabled(false),
    onConfigIssue: (msg) => message.warning(msg, 6),
  })

  const run = useLadderRun({
    session, message, soundOn, speech,
    refreshBoard: board.refreshBoard,
    patchBoard: board.patchBoard,
    onRunStarted: () => setSetupOpen(false),
  })
  useEffect(() => { resetRunRef.current = run.resetRun }, [run.resetRun])

  // 声音总开关可用性：音效总闸开着 或 语音合成可用（任一可用就能控制）
  const soundAvailable = Boolean(config?.sound_enabled) || setup.ttsEnabled

  // 锦囊固定三件套（与学生端一致）：默认集由服务端下发，本场若被主题/接口指定则以其为准
  const activeLifelines = useMemo(() => {
    const all = config?.lifelines || []
    const keys = session?.lifelines?.length
      ? session.lifelines
      : (config?.default_lifelines?.length ? config.default_lifelines : ['remove_one', 'phone_friend', 'audience_vote'])
    return keys.map((k) => all.find((x) => x.type === k)).filter(Boolean) as
      { type: string; name: string; discount: number }[]
  }, [config, session])

  const ladderRows = useMemo(() => (config?.ladder || []).slice().sort((a, b) => b.level - a.level), [config])
  const curLevel = run.run?.status === 'playing' ? (run.run.current_level || 1) : 0

  if (isMobile) return <div className="cl-mobile">{t('mobileGuide')}</div>

  return (
    <ConfigProvider theme={theme}>
      <div className="cl-root" data-skin={activeSkin} data-mode={mode}>
        <div className="cl-inner">
          <LadderBar
            session={session} run={run.run} curLevel={curLevel}
            maxLevels={config?.max_levels || 15}
            rolling={run.rolling} rollName={run.rollName} reveal={run.reveal}
            speechFailure={speech.failure} onRetrySpeech={() => { void speech.retry() }}
            lifelines={activeLifelines} onLifeline={(tp) => void run.doLifeline(tp)}
            busy={run.busy} remaining={run.remaining}
            fs={fs} onToggleFs={toggleFs}
          />

          <LadderSetupBar
            setup={setup} config={config} session={session}
            activeSkin={activeSkin} onSkinChange={handleSkinChange}
            soundOn={soundOn} soundAvailable={soundAvailable}
            onToggleSound={() => setSoundOn((v) => { localStorage.setItem(SOUND_PREF_KEY, v ? '0' : '1'); return !v })}
            setupOpen={setupOpen} onToggleSetup={() => setSetupOpen((v) => !v)}
          />

          {/* ── 主区：阶梯 / 舞台 / 红榜 ── */}
          <div className="cl-main">
            <LadderRungs rows={ladderRows} curLevel={curLevel} />
            <LadderStage
              currentQ={run.currentQ} selected={run.selected} reveal={run.reveal}
              hiddenKeys={run.hiddenKeys} busy={run.busy} onSelect={run.setSelected}
            />
            <LadderBoardPanel board={board.board} />
          </div>

          <LadderFooter
            session={session} currentQ={run.currentQ} selected={run.selected}
            revealed={Boolean(run.reveal)} drawing={run.busy && run.rolling}
            onDraw={() => void run.doOpenRun()}
            onSubmit={() => void run.doSubmit(false)}
            onSkip={() => void run.doSubmit(true)}
          />

          <LadderRecords records={board.records} />

          <Divider style={{ margin: '4px 0' }} />
        </div>

        {run.result && (
          <LadderResultOverlay
            result={run.result} mode={mode}
            onNewRun={() => void run.doOpenRun()}
            onClose={() => run.setResult(null)}
          />
        )}

        <LadderLifelineModals
          mode={mode}
          lfModal={run.lfModal} onCloseLf={() => run.setLfModal(null)}
          votePanel={run.votePanel} currentQ={run.currentQ} busy={run.busy}
          onVoteChange={run.setVotePanel}
          onVoteSubmit={() => void run.submitClassVote()}
        />
      </div>
    </ConfigProvider>
  )
}

/** <App> 提供 message/modal 上下文，使提示也跟随主题 */
export default function ClassLadderPage() {
  return (
    <App>
      <ClassLadder />
    </App>
  )
}
