import { Button, Tooltip } from 'antd'
import { FullscreenExitOutlined, FullscreenOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LadderSession, LadderRun as LadderRunT } from '../../../api/classLadder'
import type { SpeechFailure } from '../../../hooks/useNameSpeech'
import { LF_I18N, LF_ICON } from '../constants'
import { classChipLabel } from '../utils'
import type { LadderLifeline, LadderReveal } from '../types'

interface Props {
  session: LadderSession | null
  run: LadderRunT | null
  curLevel: number
  maxLevels: number
  rolling: boolean
  rollName: string
  reveal: LadderReveal | null
  speechFailure: SpeechFailure | null
  onRetrySpeech: () => void
  lifelines: LadderLifeline[]
  onLifeline: (type: string) => void
  busy: boolean
  remaining: number
  fs: boolean
  onToggleFs: () => void
}

/** 顶部条：标题 / 本题作答（含念名失败重试）/ 场次与关卡 chip / 锦囊 / 倒计时环 / 全屏 */
export default function LadderBar(p: Props) {
  const { t } = useTranslation('classLadder')
  const { run, session } = p
  return (
    <div className="cl-bar">
      <div className="cl-brand"><span className="dot" /><h1>{t('title')}</h1></div>
      {run && (
        <div className="cl-whochip">
          <span className="lb">{t('studentIs')}：</span>
          <span className={`nm${p.rolling ? ' rolling' : ''}`}>
            {p.rolling ? p.rollName : run.student}
          </span>
          {p.reveal && p.reveal.score > 0 && <span className="sc">{t('scoreAdded', { score: p.reveal.score })}</span>}
          {p.speechFailure && (
            <span className="sf">
              {p.speechFailure.kind === 'network' ? t('speakFailed') : (p.speechFailure.message || t('speakFailed'))}
              <Button type="link" size="small" style={{ fontSize: 12, padding: '0 4px' }}
                onClick={() => { p.onRetrySpeech() }}>{t('speakRetry')}</Button>
            </span>
          )}
        </div>
      )}
      {session && <div className="cl-chip gold">{session.topic || session.subject || t('title')}</div>}
      {session && <div className="cl-chip">{classChipLabel(session)}</div>}
      {run && <div className="cl-chip">{t('levelOf', { n: p.curLevel || run.reached_level, total: p.maxLevels })}</div>}
      {run && <div className="cl-chip gold">{t('totalScore')} {run.ladder_score}</div>}
      <div className="cl-spacer" />
      {run?.status === 'playing' && (
        <div className="cl-lfs">
          {p.lifelines.map((lf) => {
            const used = run.lifelines_used?.includes(lf.type)
            const label = t(LF_I18N[lf.type] || 'lifelineRemoveOne')
            return (
              <div key={lf.type} className={`cl-lf${used ? ' used' : ''}`} data-disabled={used || p.busy ? '1' : '0'}
                title={`${label}（得分 ×${lf.discount}）`}
                onClick={() => !used && p.onLifeline(lf.type)}>
                <div className="ico">{LF_ICON[lf.type] || '💡'}</div>
                <div className="nm">{label}</div>
              </div>
            )
          })}
        </div>
      )}
      {run?.status === 'playing' && run.time_limit_sec > 0 && (
        <div className={`cl-timer${p.remaining <= 10 ? ' hot' : ''}`}>
          <svg width="64" height="64">
            <circle className="track" cx="32" cy="32" r="27" fill="none" strokeWidth="6" />
            <circle className="arc" cx="32" cy="32" r="27" fill="none" strokeWidth="6"
              strokeDasharray={169.6}
              strokeDashoffset={169.6 * (1 - p.remaining / Math.max(1, run.time_limit_sec))} />
          </svg>
          <b>{p.remaining}</b>
        </div>
      )}
      <Tooltip title={p.fs ? t('exitFullscreen') : t('fullscreen')}>
        <Button size="small" icon={p.fs ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={p.onToggleFs} />
      </Tooltip>
    </div>
  )
}
