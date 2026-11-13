/** 任务清单骨架屏：镜像页头 + 分类条 + 聚焦条 + 分组卡，结构先到位、数字后填（替代居中 Spin） */
import React from 'react'
import { Card, Skeleton } from 'antd'

const RowSkeleton: React.FC<{ rows?: number }> = ({ rows = 2 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
    <Skeleton.Avatar active size={38} shape="square" style={{ borderRadius: 10, flexShrink: 0 }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <Skeleton active title={{ width: '46%' }} paragraph={{ rows: 1, width: ['72%'] }} />
    </div>
    <Skeleton.Button active size="small" style={{ width: 84, flexShrink: 0 }} />
  </div>
)

const TaskTodoSkeleton: React.FC = () => (
  <div aria-busy="true" aria-live="polite">
    <Card style={{ borderRadius: 8 }}>
      <Skeleton active title={{ width: '30%' }} paragraph={{ rows: 1, width: ['52%'] }} />
      <Card size="small" style={{ marginTop: 14, borderRadius: 8 }} styles={{ body: { padding: '10px 8px' } }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} style={{ flex: '1 1 118px', minWidth: 112, padding: '6px 8px' }}>
              <Skeleton active title={{ width: '60%' }} paragraph={{ rows: 1, width: ['30%'] }} />
            </div>
          ))}
        </div>
      </Card>
      <Card size="small" style={{ marginTop: 14, borderRadius: 8 }} styles={{ body: { padding: '12px 14px' } }}>
        <Skeleton active title={false} paragraph={{ rows: 1, width: ['86%'] }} />
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
