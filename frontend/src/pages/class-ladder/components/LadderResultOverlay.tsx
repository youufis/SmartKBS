import { AimOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import FormulaRenderer from '../../../components/FormulaRenderer'
import { CONFETTI_COLORS } from '../constants'
import type { LadderResult } from '../types'

interface Props {
  result: LadderResult
  mode: 'light' | 'dark'
  onNewRun: () => void
  onClose: () => void
}

/** 结算遮罩：通关撒彩带；四张数据卡 + 最后一题解析 + 抽下一人/看红榜 */
export default function LadderResultOverlay({ result, mode, onNewRun, onClose }: Props) {
  const { t } = useTranslation('classLadder')
  return (
    <div className={`cl-overlay${mode === 'light' ? ' light' : ''}`}>
      {result.run.status === 'win' && (
        <div className="cl-cf">
          {CONFETTI_COLORS.map((c, i) => (
            <i key={i} style={{ left: `${8 + i * 15}%`, background: c, animationDuration: `${4.5 + i * 0.5}s` }} />
          ))}
        </div>
      )}
      <div className="cl-ovbox">
        <div className={`cl-ovtitle ${result.run.status === 'win' ? 'win' : result.run.status === 'timeout' ? 'timeout' : 'lose'}`}>
          {result.run.status === 'win' ? t('winTitle') : result.run.status === 'timeout' ? t('timeoutTitle') : t('loseTitle')}
        </div>
        <div className="cl-ovsub">
          {result.run.student} · {t('boardReached', { n: result.run.reached_level })} · {t('gameOver')}
        </div>
        <div className="cl-ovcards">
          <div className="cl-ovcard"><div className="k">{t('reachedLevel')}</div><div className="v">{result.run.reached_level}</div></div>
          <div className="cl-ovcard"><div className="k">{t('correctCount')}</div><div className="v">{result.run.correct_count}</div></div>
          <div className="cl-ovcard gold"><div className="k">{t('ladderScore')}</div><div className="v">{result.run.ladder_score}</div></div>
          <div className="cl-ovcard gold"><div className="k">{t('pointsAwarded')}</div><div className="v">+{result.run.points_awarded}</div></div>
        </div>
        {result.detail.length > 0 && (
          <div className="cl-ovans">
            {(() => {
              const last = result.detail[result.detail.length - 1]
              return (
                <>
                  {t('levelLabel', { n: last.level })} · {t('answerIs')}：<b>{last.correct_answer || '—'}</b>
                  {last.selected ? ` · ${t('yourPick')}：${last.selected}` : ''}
                  {last.explanation ? <div style={{ marginTop: 6, fontSize: 15, color: 'var(--cl-ink-dim)' }}>
                    <FormulaRenderer content={last.explanation} /></div> : null}
                </>
              )
            })()}
          </div>
        )}
        <div className="cl-ovbtns">
          <div className="cl-btn gold" onClick={onNewRun}><AimOutlined /> {t('newRun')}</div>
          <div className="cl-btn ghost" onClick={onClose}>{t('seeBoard')}</div>
        </div>
      </div>
    </div>
  )
}
