import { Collapse, Empty, Tag, Typography } from 'antd'
import { ThunderboltOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LadderBoardRow } from '../../../api/classLadder'

const { Text } = Typography

interface Props {
  records: LadderBoardRow[]
}

/** 本场流水：折叠面板，倒序列出每局结果 */
export default function LadderRecords({ records }: Props) {
  const { t } = useTranslation('classLadder')
  return (
    <Collapse ghost items={[{
      key: 'rec',
      label: <span><ThunderboltOutlined /> {t('recordsTitle')} · {t('recordsCount', { count: records.length })}</span>,
      children: records.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('recordsEmpty')} />
        : (
          <div className="cl-detail">
            {records.map((r, i) => (
              <div key={r.id} className="cl-detail-row">
                <Text type="secondary" style={{ width: 34 }}>#{records.length - i}</Text>
                <Text strong style={{ width: 88 }}>{r.student_name}</Text>
                <Tag color={r.status === 'win' ? 'green' : r.status === 'lost' ? 'orange' : 'default'}>
                  {t('boardReached', { n: r.reached_level })}
                </Tag>
                <span style={{ color: 'var(--cl-ink-dim)' }}>{t('correctCount')} {r.correct_count}</span>
                <span style={{ marginLeft: 'auto', fontWeight: 700 }}>{t('ladderScore')} {r.ladder_score}</span>
                <span style={{ width: 70, textAlign: 'right', color: 'var(--cl-ok)' }}>{t('pointsUnit', { n: r.correct_count })}</span>
              </div>
            ))}
          </div>
        ),
    }]} />
  )
}
