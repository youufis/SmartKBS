/** 今日积分进度条：每日精选 / 热点新闻共用的细条样式（含除零防护与规则提示） */
import { Progress, Tooltip } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'

interface Props {
  earned: number
  max: number
  strokeColor?: string
  /** 规则说明（悬浮 ⓘ 显示），带 {{max}} 时由调用方插好值 */
  tip?: string
}

export default function DailyPointsBar({ earned, max, strokeColor = '#faad14', tip }: Props) {
  const safeMax = max > 0 ? max : 1
  const percent = Math.min(100, Math.round((Math.max(0, earned) / safeMax) * 100))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Progress percent={percent} size="small" strokeColor={strokeColor} showInfo={false}
        style={{ flex: 1, marginBottom: 0 }} />
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
        {Math.max(0, earned)}/{max}
        {tip && (
          <Tooltip title={tip}>
            <InfoCircleOutlined style={{ marginLeft: 4, cursor: 'help' }} />
          </Tooltip>
        )}
      </span>
    </div>
  )
}
