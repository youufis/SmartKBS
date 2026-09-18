/** 最近动态时间线（角色自适应，高度自适应 + 内滚） */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, Empty, Space, Spin, Timeline, Typography } from 'antd'
import {
  AuditOutlined, BarChartOutlined, CheckCircleOutlined, ClockCircleOutlined,
  CustomerServiceOutlined, EyeOutlined, FileAddOutlined, FireOutlined,
  ReloadOutlined, TeamOutlined, ThunderboltOutlined, TrophyOutlined,
} from '@ant-design/icons'
import type { ActivityItem } from '../../api/dashboard'
import { friendlyTime } from './fmt'

const { Text } = Typography

const TYPE_CONFIG: Record<string, { color: string; icon: React.ReactNode }> = {
  exam: { color: '#1677ff', icon: <FileAddOutlined /> },
  score: { color: '#52c41a', icon: <TrophyOutlined /> },
  task: { color: '#faad14', icon: <CheckCircleOutlined /> },
  rollcall: { color: '#722ed1', icon: <AuditOutlined /> },
  quiz: { color: '#ff4d4f', icon: <ThunderboltOutlined /> },
  poll: { color: '#722ed1', icon: <BarChartOutlined /> },
  discussion: { color: '#1677ff', icon: <TeamOutlined /> },
  quest: { color: '#ff4d4f', icon: <FireOutlined /> },
  quick_quiz: { color: '#722ed1', icon: <CustomerServiceOutlined /> },
  practice: { color: '#52c41a', icon: <FileAddOutlined /> },
  resource_view: { color: '#1677ff', icon: <EyeOutlined /> },
}

interface Props {
  activities: ActivityItem[]
  loading: boolean
  error: boolean
  onRefresh: () => void
}

const ActivityTimelineCard: React.FC<Props> = ({ activities, loading, error, onRefresh }) => {
  const { t } = useTranslation('dashboard')
  return (
    <Card
      size="small"
      title={<Space><ClockCircleOutlined />{t('recentActivity')}</Space>}
      extra={<Button type="text" size="small" icon={<ReloadOutlined />} onClick={onRefresh} />}
      styles={{ body: { maxHeight: 430, overflow: 'auto', padding: '12px 16px' } }}
    >
      {loading ? (
        <Spin style={{ display: 'block', margin: '40px auto' }} />
      ) : activities.length === 0 ? (
        error ? (
          <div style={{ textAlign: 'center' }}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('activityLoadFailed')} />
            <Button size="small" onClick={onRefresh}>{t('retry')}</Button>
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('noActivity')} />
        )
      ) : (
        <Timeline
          items={activities.slice(0, 30).map((act) => ({
            color: TYPE_CONFIG[act.type]?.color || '#999',
            content: (
              <div>
                <Space>
                  {TYPE_CONFIG[act.type]?.icon}
                  <Text strong style={{ fontSize: 13 }}>{act.title}</Text>
                </Space>
                {act.detail && (
                  <div><Text type="secondary" style={{ fontSize: 12 }}>{act.detail}</Text></div>
                )}
                <div><Text type="secondary" style={{ fontSize: 11 }}>{friendlyTime(act.time)}</Text></div>
              </div>
            ),
          }))}
        />
      )}
    </Card>
  )
}

export default ActivityTimelineCard
