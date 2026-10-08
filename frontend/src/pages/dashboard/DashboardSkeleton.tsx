/**
 * 看板骨架屏（批次 2）
 *
 * 原来首屏是一个居中 Spin：整页 400px 空白转圈，既看不出结构也显得更慢。
 * 这里按真实栅格铺骨架块，结构先到位、数字后填，感知等待明显更短。
 */
import React from 'react'
import { Card, Col, Row, Skeleton } from 'antd'

const DashboardSkeleton: React.FC = () => (
  <div aria-busy="true" aria-live="polite">
    <Card size="small" style={{ marginBottom: 16, borderRadius: 10 }}>
      <Skeleton active title={{ width: '38%' }} paragraph={{ rows: 1, width: ['60%'] }} />
    </Card>
    <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
      {[0, 1, 2, 3].map((i) => (
        <Col xs={12} md={6} key={i}>
          <Card size="small">
            <Skeleton active title={{ width: '50%' }} paragraph={{ rows: 1, width: ['70%'] }} />
          </Card>
        </Col>
      ))}
    </Row>
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={10}>
        <Card size="small"><Skeleton active title={false} paragraph={{ rows: 4 }} /></Card>
      </Col>
      <Col xs={24} md={12} lg={6}>
        <Card size="small"><Skeleton active title={false} paragraph={{ rows: 4 }} /></Card>
      </Col>
      <Col xs={24} md={12} lg={8}>
        <Card size="small"><Skeleton active title={false} paragraph={{ rows: 4 }} /></Card>
      </Col>
    </Row>
  </div>
)

export default DashboardSkeleton