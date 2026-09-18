/** 学生待考列表（含截止倒计时） */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Space, Tag, Typography } from 'antd'
import { ClockCircleOutlined, ExperimentOutlined, RightOutlined } from '@ant-design/icons'
import type { DashboardSummary } from '../../api/dashboard'
import { deadlineInfo } from './fmt'

const { Text } = Typography

const PendingExamsCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const exams = summary.pending_exams ?? []
  if (exams.length === 0) return null
  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={<Space><ClockCircleOutlined style={{ color: '#faad14' }} />{t('pendingExams')}</Space>}
      extra={<Button type="link" size="small" onClick={() => navigate('/exam')}>{t('viewAll')} <RightOutlined /></Button>}
      styles={{ body: { padding: '2px 16px 8px' } }}
    >
      {exams.map((exam, idx) => {
        const dl = deadlineInfo(exam.end_time)
        return (
          <div
            key={exam.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0',
              borderBottom: idx === exams.length - 1 ? 'none' : '1px solid rgba(128,128,128,0.12)',
            }}
          >
            <ExperimentOutlined style={{ fontSize: 20, color: '#1677ff', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Space size={6} wrap>
                <Text style={{ fontSize: 13, fontWeight: 500 }}>{exam.title}</Text>
                {dl && (
                  <Tag
                    color={dl.level === 'overdue' ? 'red' : dl.level === 'today' ? 'orange' : 'blue'}
                    style={{ fontSize: 10, marginInlineEnd: 0 }}
                  >
                    {dl.level === 'overdue'
                      ? t('welcome.overdueDays', { n: dl.overdueDays })
                      : dl.level === 'today'
                        ? t('welcome.dueToday', { h: dl.hoursLeft })
                        : t('welcome.daysToExam', { n: dl.days })}
                  </Tag>
                )}
              </Space>
              <Space size={12} style={{ marginTop: 2 }}>
                <Tag style={{ fontSize: 11, marginInlineEnd: 0 }}>{exam.subject}</Tag>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('duration', { minutes: exam.duration })}</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>{t('points', { score: exam.total_score })}</Text>
              </Space>
            </div>
            <Button type="primary" size="small" style={{ flexShrink: 0 }} onClick={() => navigate(`/exam-take/${exam.id}`)}>
              {t('startExam')}
            </Button>
          </div>
        )
      })}
    </Card>
  )
}

export default PendingExamsCard
