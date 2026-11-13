/** 系统公告卡 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Space, Tag, Typography } from 'antd'
import { BellOutlined, RightOutlined } from '@ant-design/icons'
import type { AnnouncementItem } from '../../api/notifications'
import { useChartTheme } from './chartTheme'

const { Text, Paragraph } = Typography

/** 把 Markdown 压成一行可读纯文本（首页预览用，详情里仍是原样） */
function plainPreview(md: string): string {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const AnnouncementsCard: React.FC<{ announcements: AnnouncementItem[] }> = ({ announcements }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  // 只留 2 条、正文 1 行：首页公告是"提醒"，不是阅读器；原来 3 条各占两行，把首屏拉长了 180px
  const rows = announcements.slice(0, 2)
  if (rows.length === 0) return null
  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={<Space><BellOutlined style={{ color: ct.warning }} />{t('announcements')}</Space>}
      extra={<Button type="link" size="small" onClick={() => navigate('/announcements')}>{t('viewAll')} <RightOutlined /></Button>}
      styles={{ body: { padding: '2px 16px 8px' } }}
    >
      {rows.map((item, idx) => (
        <div
          key={item.id}
          onClick={() => navigate(`/announcements?id=${item.id}`)}
          role="button"
          tabIndex={0}
          aria-label={item.title}
          onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); navigate(`/announcements?id=${item.id}`) } }}
          className="dash-row"
          style={{
            cursor: 'pointer', padding: '8px 6px', margin: '0 -6px',
            borderBottom: idx === rows.length - 1 ? 'none' : '1px solid rgba(128,128,128,0.14)',
          }}
        >
          <Space size={6}>
            {item.is_pinned && <BellOutlined style={{ color: ct.warning, fontSize: 12 }} />}
            <Text strong style={{ fontSize: 13 }}>{item.title}</Text>
            <Tag
              color={item.priority === 'urgent' ? 'red' : item.priority === 'important' ? 'orange' : 'blue'}
              style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }}
            >
              {item.priority === 'urgent' ? t('urgent') : item.priority === 'important' ? t('important') : t('normal')}
            </Tag>
          </Space>
          {/* 公告正文是 Markdown，直接截一行会把「**2025…**」这种星号露出来（实测首页两条公告都是）。
              这里先剥成纯文本再截断；全文点进详情看。 */}
          <Paragraph ellipsis={{ rows: 1 }} type="secondary" style={{ fontSize: 12, margin: '2px 0 0' }}>
            {plainPreview(item.content)}
          </Paragraph>
        </div>
      ))}
    </Card>
  )
}

export default AnnouncementsCard
