import { useTranslation } from 'react-i18next'
import type { LadderBoardRow } from '../../../api/classLadder'

interface Props {
  board: LadderBoardRow[]
}

/** 右侧本场红榜：按阶梯分排序，榜首着色 */
export default function LadderBoardPanel({ board }: Props) {
  const { t } = useTranslation('classLadder')
  return (
    <aside className="cl-board cl-panel">
      <h2>🏆 {t('boardTitle')}</h2>
      {board.length === 0 ? <div className="empty">{t('boardEmpty')}</div> : board.map((r, i) => (
        <div key={r.id} className={`cl-row${i === 0 ? ' top1' : ''}`}>
          <span className="rk">{i + 1}</span>
          <span className="nm">{r.student_name}</span>
          <span className="sc">{r.ladder_score}</span>
        </div>
      ))}
      {board.length > 0 && (
        <div className="empty" style={{ marginTop: 6 }}>
          {t('boardReached', { n: board[0].reached_level })} · {t('correctCount')} {board[0].correct_count}
        </div>
      )}
    </aside>
  )
}
