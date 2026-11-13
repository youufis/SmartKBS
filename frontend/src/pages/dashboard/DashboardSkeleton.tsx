/**
 * 看板骨架屏：按角色真实栅格铺骨架块，结构先到位、数字后填，感知等待更短。
 * 学生首行是「今日要事 + 成长档案」，教师首行是「今日待办行动条」——与加载完成后的布局一致，不跳。
 */
import React from 'react'
import { Card, Col, Row, Skeleton } from 'antd'

const DashboardSkeleton: React.FC<{ isStudent?: boolean }> = ({ isStudent = false }) => (
  <div aria-busy="true" aria-live="polite">
    <Card size="small" style={{ marginBottom: 16, borderRadius: 10 }}>
      <Skeleton active title={{ width: '38%' }} paragraph={{ rows: 1, width: ['60%'] }} />
    </Card>
    {isStudent ? (
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} lg={16}>
          <Card size="small"><Skeleton active title={{ width: '30%' }} paragraph={{ rows: 4 }} /></Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card size="small"><Skeleton active title={{ width: '40%' }} paragraph={{ rows: 3 }} /></Card>
        </Col>
      </Row>
    ) : (
      <Card size="small" style={{ marginBottom: 16 }}>
        <Skeleton active title={false} paragraph={{ rows: 2, width: ['46%', '70%'] }} />
      </Card>
    )}
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
