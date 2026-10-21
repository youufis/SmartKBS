import { AimOutlined, CheckOutlined, ForwardOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LadderSession } from '../../../api/classLadder'
import type { LadderQuestion } from '../../../api/classLadder'

interface Props {
  session: LadderSession | null
  currentQ: LadderQuestion | null
  selected: number | null
  revealed: boolean
  drawing: boolean
  onDraw: () => void
  onSubmit: () => void
  onSkip: () => void
}

/** 底部操作条：抽人开新局 / 提交作答 / 跳过（判错）+ 快捷键提示 */
export default function LadderFooter({ session, currentQ, selected, revealed, drawing, onDraw, onSubmit, onSkip }: Props) {
  const { t } = useTranslation('classLadder')
  return (
    <div className="cl-foot">
      <div className={`cl-btn ghost${!session || !session.pool?.total ? ' dim' : ''}`} onClick={onDraw}>
        <AimOutlined /> {drawing ? t('drawing') : t('drawStudent')}
      </div>
      <div className={`cl-btn gold${!currentQ || selected === null || revealed ? ' dim' : ''}`} onClick={onSubmit}>
        <CheckOutlined /> {t('submitAnswer')}
      </div>
      <div className={`cl-btn ghost${!currentQ || revealed ? ' dim' : ''}`} onClick={onSkip}>
        <ForwardOutlined /> {t('skipLevel')}
      </div>
      <div className="cl-hint">{t('kbdHint')}</div>
    </div>
  )
}
