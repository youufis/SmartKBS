/** 任务清单骨架屏：镜像新版布局（页头 + 聚焦条 + 筛选面板两节基础项 + 分组卡），结构先到位、数字后填 */
import React from 'react'
import { Card, Skeleton } from 'antd'

const RowSkeleton: React.FC<{ rows?: number }> = ({ rows = 1 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0' }}>
    <Skeleton.Avatar active size={36} shape="square" style={{ borderRadius: 10, flexShrink: 0 }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <Skeleton active title={{ width: '46%' }} paragraph={{ rows, width: rows > 1 ? ['72%', '55%'] : ['72%'] }} />
    </div>
    <Skeleton.Button active size="small" style={{ width: 84, flexShrink: 0 }} />
  </div>
)

const PillRow: React.FC<{ widths: number[] }> = ({ widths }) => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' }}>
    {widths.map((w, i) => (
      <Skeleton.Button key={i} active size="small" style={{ width: w, minWidth: 48 }} />
    ))}
  </div>
)

const TaskTodoSkeleton: React.FC = () => (
  <div aria-busy="true" aria-live="polite">
    <Card style={{ borderRadius: 8 }}>
      <Skeleton active title={{ width: '30%' }} paragraph={{ rows: 1, width: ['52%'] }} />
      {/* 聚焦条占位 */}
      <Card size="small" style={{ marginTop: 14, borderRadius: 8 }} styles={{ body: { padding: '12px 14px' } }}>
        <Skeleton active title={false} paragraph={{ rows: 1, width: ['86%'] }} />
      </Card>
      {/* 筛选面板占位：默认展开的分类 + 截止时间两行 pill */}
      <Card size="small" style={{ marginTop: 14, borderRadius: 8 }} styles={{ body: { padding: '8px 12px' } }}>
        <PillRow widths={[64, 80, 76, 80, 84, 72]} />
        <PillRow widths={[52, 64, 60, 56, 68, 64]} />
      </Card>
      <div style={{ marginTop: 16 }}>
        <Skeleton active title={false} paragraph={{ rows: 1, width: ['40%'] }} />
      </div>
      <Card size="small" style={{ marginTop: 12, borderRadius: 8 }} styles={{ body: { padding: '0 16px 8px' } }}>
        <RowSkeleton />
        <RowSkeleton />
      </Card>
      <Card size="small" style={{ marginTop: 16, borderRadius: 8 }} styles={{ body: { padding: '0 16px 8px' } }}>
        <RowSkeleton />
        <RowSkeleton rows={1} />
      </Card>
    </Card>
  </div>
)

export default TaskTodoSkeleton
