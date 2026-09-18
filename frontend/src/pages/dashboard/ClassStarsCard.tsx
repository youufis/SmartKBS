/** 教师端：一周之星（真实积分 TOP5）+ 今日概况 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Avatar, Button, Card, Space, Typography } from 'antd'
import { CrownOutlined, RightOutlined } from '@ant-design/icons'
import type { DashboardSummary, TeacherTodo } from '../../api/dashboard'

const { Text } = Typography

const MEDALS = ['🥇', '🥈', '🥉', '4', '5']

const ClassStarsCard: React.FC<{ summary: DashboardSummary; todo: TeacherTodo | null }> = ({ summary, todo }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
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
        <div key={`${s.name}-${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: idx === stars.length - 1 ? 'none' : '1px solid rgba(128,128,128,0.12)' }}>
        <Space size={8}>
        <span style={{ width: 22, textAlign: 'center', fontSize: idx < 3 ? 15 : 12, fontWeight: 600 }}>{MEDALS[idx]}</span>
        <Avatar size={20} style={{ background: ['#faad14', '#bfbfbf', '#d48806', '#1677ff', '#722ed1'][idx], fontSize: 11 }}>
        {s.name.slice(0, 1)}
        </Avatar>
        <Text style={{ fontSize: 13 }}>{s.name}</Text>
        </Space>
        <Text strong style={{ color: '#faad14', fontSize: 12 }}>{s.points} {t('stars.pointsUnit')}</Text>
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
