/** 教师端：一周之星（近7天真实积分 TOP5，含班级）+ 今日概况 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Avatar, Button, Card, Space, Tag, Typography } from 'antd'
import { CrownOutlined, RightOutlined } from '@ant-design/icons'
import type { DashboardSummary, TeacherTodo } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'

const { Text } = Typography

const MEDALS = ['🥇', '🥈', '🥉', '4', '5']
const AVATAR_COLORS = ['#faad14', '#bfbfbf', '#d48806', '#1677ff', '#722ed1']

const ClassStarsCard: React.FC<{ summary: DashboardSummary; todo: TeacherTodo | null }> = ({ summary, todo }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const stars = todo?.weekly_top_students ?? []

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <CrownOutlined style={{ color: '#faad14' }} />
          <span style={{ fontSize: 13 }}>{t('stars.title')}</span>
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>{t('stars.sub')}</Text>
        </Space>
      }
      extra={<Button type="link" size="small" onClick={() => navigate('/score')}>{t('viewAll')} <RightOutlined /></Button>}
      styles={{ body: { padding: '0 16px 8px' } }}
    >
      {stars.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('stars.empty')}</Text>
        </div>
      ) : (
        <div>
          {stars.map((s, idx) => (
            <div
              key={`${s.username}-${idx}`}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '5px 0',
                borderBottom: idx === stars.length - 1 ? 'none' : '1px solid rgba(128,128,128,0.12)',
              }}
            >
              <Space size={8} style={{ minWidth: 0 }}>
                <span style={{ width: 22, textAlign: 'center', fontSize: idx < 3 ? 15 : 12, fontWeight: 600, flexShrink: 0 }}>
                  {MEDALS[idx]}
                </span>
                <Avatar size={20} style={{ background: AVATAR_COLORS[idx], fontSize: 11, flexShrink: 0 }}>
                  {s.name.slice(0, 1)}
                </Avatar>
                <Text style={{ fontSize: 13 }} ellipsis>{s.name}</Text>
                {s.tag && (
                  <Tag
                    style={{
                      fontSize: 10, marginInlineEnd: 0, lineHeight: '16px', padding: '0 5px',
                      color: ct.tick,
                      background: ct.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)',
                      borderColor: ct.grid,
                    }}
                  >
                    {s.tag}
                  </Tag>
                )}
              </Space>
              <Text strong style={{ color: '#faad14', fontSize: 12, flexShrink: 0 }}>
                {s.points} {t('stars.pointsUnit')}
              </Text>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 2px', borderTop: '1px dashed rgba(128,128,128,0.25)', fontSize: 12 }}>
        <Text type="secondary">{t('stars.todayChat')}: <Text strong style={{ fontSize: 12 }}>{summary.today_chat_count ?? 0}</Text></Text>
        <Text type="secondary">{t('thisWeekRollcall')}: <Text strong style={{ fontSize: 12 }}>{summary.rollcall_this_week ?? 0}</Text></Text>
        <Text type="secondary">{t('stars.activeToday')}: <Text strong style={{ fontSize: 12 }}>{todo?.active_students_today ?? 0}</Text></Text>
      </div>
    </Card>
  )
}

export default ClassStarsCard
