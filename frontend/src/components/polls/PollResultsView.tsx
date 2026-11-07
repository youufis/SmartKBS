/**
 * 投票结果视图（弹窗内 / 投屏大屏共用）。
 *
 * 相比旧实现：按票数排序、标出领先项、区分「已投 / 应投」、注明多选合计会超过 100%。
 */
import React from 'react'
import { Progress, Space, Tag, Typography } from 'antd'

export interface PollResultOption {
  index: number
  text: string
  votes: number
  percentage: number
  leading?: boolean
}

export interface PollResultsData {
  poll_id: number
  question: string
  poll_type: string
  options: PollResultOption[]
  total_votes: number
  unique_voters: number
  expected_voters?: number
  status?: string
  ended?: boolean
  anonymous?: boolean
  ends_at?: string
  max_choices?: number
  has_voted?: boolean
  my_indices?: number[]
}

interface Props {
  data: PollResultsData | null
  /** 投屏模式：更大的字号与进度条 */
  big?: boolean
  /** 高亮"我选的"选项 */
  highlightMine?: boolean
}

const PollResultsView: React.FC<Props> = ({ data, big = false, highlightMine = true }) => {
  if (!data) return null
  const mine = new Set(highlightMine ? (data.my_indices || []) : [])
  const sorted = [...data.options].sort((a, b) => b.votes - a.votes || a.index - b.index)
  const expected = data.expected_voters || 0
  const participated = data.unique_voters || 0
  const rate = expected > 0 ? participated / expected * 100 : 0
  // 1 / 1406 这种小比例别显示成 0%，读起来像没人投
  const rateText = rate >= 1 ? `${Math.round(rate)}%` : rate > 0 ? '<1%' : '0%'

  return (
    <div>
      <div style={{ marginBottom: big ? 20 : 12 }}>
        <Space size={8} wrap style={{ marginBottom: 6 }}>
          <Tag color={data.poll_type === 'multiple' ? 'purple' : 'blue'}>
            {data.poll_type === 'multiple' ? '多选' : '单选'}
          </Tag>
          <Tag color={data.anonymous ? 'default' : 'cyan'}>{data.anonymous ? '匿名' : '记名'}</Tag>
          {data.ended
            ? <Tag>已结束</Tag>
            : <Tag color="processing">进行中</Tag>}
          {data.poll_type === 'multiple' && !!data.max_choices && (
            <Tag>每人最多 {data.max_choices} 项</Tag>
          )}
        </Space>
        <div style={{ fontSize: big ? 16 : 13, color: 'var(--text-secondary)' }}>
          已投 <strong style={{ color: 'var(--text-primary)', fontSize: big ? 22 : 15 }}>{participated}</strong>
          {expected > 0 && <> / 应投 {expected}（{rateText}）</>}
          {data.poll_type === 'multiple' && <span style={{ marginLeft: 8 }}>共 {data.total_votes} 票</span>}
        </div>
        {expected > 0 && (
          <Progress percent={rate} showInfo={false} size={big ? 'default' : 'small'}
            style={{ marginTop: 4, maxWidth: big ? 640 : 420 }} />
        )}
      </div>

      <Space orientation="vertical" style={{ width: '100%' }} size={big ? 18 : 12}>
        {sorted.map((opt, i) => (
          <div key={opt.index}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <Space size={6} style={{ minWidth: 0 }}>
                <span style={{
                  display: 'inline-block', minWidth: big ? 26 : 20, textAlign: 'center',
                  fontSize: big ? 15 : 12, color: i === 0 ? 'var(--primary-color)' : 'var(--text-tertiary)',
                }}>{i + 1}</span>
                <Typography.Text
                  strong={i === 0 || mine.has(opt.index)}
                  style={{ fontSize: big ? 22 : 14 }}
                  ellipsis={!big}
                >
                  {opt.text}
                </Typography.Text>
                {mine.has(opt.index) && <Tag color="blue">我选的</Tag>}
                {opt.leading && sorted.length > 1 && i === 0 && <Tag color="gold">领先</Tag>}
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: big ? 20 : 12, whiteSpace: 'nowrap' }}>
                {opt.votes} 票 · {opt.percentage}%
              </Typography.Text>
            </div>
            <Progress
              percent={Math.min(opt.percentage, 100)}
              showInfo={false}
              size={big ? 'default' : 'small'}
              strokeColor={i === 0 && opt.votes > 0 ? 'var(--primary-color)' : undefined}
            />
          </div>
        ))}
      </Space>

      {data.poll_type === 'multiple' && (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
          多选投票按人数计算占比，各项合计可能超过 100%
        </Typography.Text>
      )}
    </div>
  )
}

export default PollResultsView
