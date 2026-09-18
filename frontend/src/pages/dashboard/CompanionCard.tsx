/** AI 学伴留言卡：展示最新推送 + 未读角标，点击进入学伴对话 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, Space, Typography } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import { useCompanionStore } from '../../stores/companionStore'
import { friendlyTime } from './fmt'

const { Text, Paragraph } = Typography

const CompanionCard: React.FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const pushes = useCompanionStore((s) => s.pushes)
  const unreadCount = useCompanionStore((s) => s.unreadCount)

  const latest = pushes.slice(0, 2)

  return (
    <Card
      size="small"
      title={
        <Space size={6}>
          <span style={{ fontSize: 16 }}>🧠</span>
          <span style={{ fontSize: 13 }}>{t('companion.title')}</span>
          {unreadCount > 0 && <Badge count={unreadCount} size="small" />}
        </Space>
      }
      extra={
        <Button type="link" size="small" onClick={() => navigate('/chat?companion=1')}>
          {t('companion.chat')} <RightOutlined />
        </Button>
      }
      styles={{ body: { padding: '8px 16px 12px' } }}
    >
      {latest.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>{t('companion.empty')}</Text>
      ) : (
        latest.map((p) => (
          <div key={p.id} style={{ marginBottom: 8, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 16, lineHeight: '20px' }}>💬</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Space size={6}>
                <Text strong style={{ fontSize: 12.5 }}>{p.title || p.push_type_label}</Text>
                {!p.is_read && <Badge status="processing" />}
              </Space>
              <Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ fontSize: 12, margin: 0 }}>
                {p.content}
              </Paragraph>
              <Text type="secondary" style={{ fontSize: 11 }}>{friendlyTime(p.created_at)}</Text>
            </div>
          </div>
        ))
      )}
    </Card>
  )
}

export default CompanionCard
