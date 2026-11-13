/** 最近动态时间线（角色自适应，高度自适应 + 内滚） */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, Empty, Space, Spin, Timeline, Typography } from 'antd'
import {
  AimOutlined,
  AuditOutlined, BarChartOutlined, CheckCircleOutlined, ClockCircleOutlined,
  CustomerServiceOutlined, EyeOutlined, FileAddOutlined, FireOutlined,
  ReloadOutlined, TeamOutlined, ThunderboltOutlined, TrophyOutlined,
} from '@ant-design/icons'
import type { ActivityItem } from '../../api/dashboard'
import { friendlyTime } from './fmt'
import { useChartTheme, type ChartColorToken } from './chartTheme'

const { Text } = Typography

const TYPE_CONFIG: Record<string, { color: ChartColorToken; icon: React.ReactNode }> = {
  exam: { color: 'primary', icon: <FileAddOutlined /> },
  score: { color: 'success', icon: <TrophyOutlined /> },
  task: { color: 'gold', icon: <CheckCircleOutlined /> },
  rollcall: { color: 'purple', icon: <AuditOutlined /> },
  class_drill: { color: 'magenta', icon: <AimOutlined /> },
  quiz: { color: 'danger', icon: <ThunderboltOutlined /> },
  poll: { color: 'purple', icon: <BarChartOutlined /> },
  discussion: { color: 'primary', icon: <TeamOutlined /> },
  quest: { color: 'danger', icon: <FireOutlined /> },
  quick_quiz: { color: 'purple', icon: <CustomerServiceOutlined /> },
  practice: { color: 'success', icon: <FileAddOutlined /> },
  resource_view: { color: 'primary', icon: <EyeOutlined /> },
}

interface Props {
  activities: ActivityItem[]
  loading: boolean
  error: boolean
  onRefresh: () => void
}

const ActivityTimelineCard: React.FC<Props> = ({ activities, loading, error, onRefresh }) => {
  const { t, i18n } = useTranslation('dashboard')
  const ct = useChartTheme()
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
          items={activities.slice(0, 30).map((act) => {
            const cfg = TYPE_CONFIG[act.type]
            return {
            color: cfg ? ct[cfg.color] : ct.tick,
            content: (
              <div>
                <Space>
                  {TYPE_CONFIG[act.type]?.icon}
                  <Text strong style={{ fontSize: 13 }}>{act.title}</Text>
                </Space>
                {act.detail && (
                  <div><Text type="secondary" style={{ fontSize: 12 }}>{act.detail}</Text></div>
                )}
                <div><Text type="secondary" style={{ fontSize: 11 }}>{friendlyTime(act.time, i18n.language?.startsWith('en') ? 'en-US' : 'zh-CN')}</Text></div>
              </div>
            ),
            }
          })}
        />
      )}
    </Card>
  )
}

export default ActivityTimelineCard
