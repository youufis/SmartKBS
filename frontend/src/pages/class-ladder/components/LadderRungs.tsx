import { StarOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LadderLevel } from '../../../api/classLadder'

interface Props {
  rows: LadderLevel[]
  curLevel: number
}

/** 左侧闯关阶梯：15 级，从高到低；当前关高亮、已过关着色、安全关虚线 */
export default function LadderRungs({ rows, curLevel }: Props) {
  const { t } = useTranslation('classLadder')
  return (
    <section className="cl-ladder cl-panel">
      <h2><StarOutlined /> {t('ladderTitle')}</h2>
      <div className="cl-rungs">
        {rows.map((row) => {
          const cls = row.level === curLevel ? ' now' : (curLevel && row.level < curLevel ? ' done' : '') + (row.safe ? ' safe' : '')
          return (
            <div key={row.level} className={`cl-rung${cls}`}>
              <span className="lv">{t('levelLabel', { n: row.level })}</span>
              <span>{row.score} {t('scoreUnit')}{row.safe ? ` · ${t('safeShort')}` : ''}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
