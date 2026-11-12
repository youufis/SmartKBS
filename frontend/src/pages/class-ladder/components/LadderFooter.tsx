import { AimOutlined, CheckOutlined, ClockCircleOutlined, ForwardOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LadderSession } from '../../../api/classLadder'
import type { LadderQuestion } from '../../../api/classLadder'

interface Props {
  session: LadderSession | null
  currentQ: LadderQuestion | null
  selected: number | null
  revealed: boolean
  drawing: boolean
  pending?: boolean
  timedOut?: boolean
  onDraw: () => void
  onSubmit: () => void
  onSkip: () => void
  onNext?: () => void
  onTimeout?: () => void
}

/** 底部操作条：抽人开新局 / 提交作答 / 跳过（判错）+ 快捷键提示 */
export default function LadderFooter({ session, currentQ, selected, revealed, drawing,
  pending, timedOut, onDraw, onSubmit, onSkip, onNext, onTimeout }: Props) {
  const { t } = useTranslation('classLadder')
  return (
    <div className="cl-foot">
      <div className={`cl-btn ghost${!session || !session.pool?.total ? ' dim' : ''}`} onClick={onDraw}>
        <AimOutlined /> {drawing ? t('drawing') : t('drawStudent')}
      </div>
      {pending ? (
        <div className="cl-btn gold" onClick={onNext}>
          <ForwardOutlined /> {t('nextLevel')} · N
        </div>
      ) : (
        <div className={`cl-btn gold${!currentQ || selected === null || revealed ? ' dim' : ''}`} onClick={onSubmit}>
          <CheckOutlined /> {t('submitAnswer')}
        </div>
      )}
      {timedOut ? (
        <div className="cl-btn dangerish" onClick={onTimeout}>
          <ClockCircleOutlined /> {t('timeoutJudgeBtn')}
        </div>
      ) : (
        <div className={`cl-btn ghost${!currentQ || revealed ? ' dim' : ''}`} onClick={onSkip}>
          <ForwardOutlined /> {t('skipLevel')}
        </div>
      )}
      <div className="cl-hint">{t('kbdHint')}</div>
    </div>
  )
}
