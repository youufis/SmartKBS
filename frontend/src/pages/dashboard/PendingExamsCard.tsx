/** 学生考试提醒卡（降噪版）：仅在"已逾期 / 7 天内截止"时出现，最多 2 场；
 *  行内只留倒计时+直达按钮（删时长/满分加压信息），卡尾一句个性化鼓励。远期考试安静躺在任务清单里。 */
import React, { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card } from 'antd'
import { ClockCircleOutlined, ExperimentOutlined, RightOutlined } from '@ant-design/icons'
import type { DashboardSummary } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'
import { parseMs } from './encourage'
import { deadlineInfo } from './fmt'
import { useNow } from './useNow'
import { Space, Tag, Typography } from 'antd'

const { Text } = Typography

const PendingExamsCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const now = useNow()
  const ct = useChartTheme()

  const soon = useMemo(() => {
    const nowMs = now
    const in7 = nowMs + 7 * 86400000
    return (summary.pending_exams ?? [])
      .filter((e) => {
        const ms = parseMs(e.end_time)
        return ms > 0 && ms < in7 // 无截止的开放考试不打扰首页
      })
      .sort((a, b) => parseMs(a.end_time) - parseMs(b.end_time))
  }, [summary, now])

  if (!soon.length) return null
  const shown = soon.slice(0, 2)
  const rest = soon.length - shown.length
  const nDone = summary.completed_exam_count ?? 0
  const avg = summary.exam_avg_rate
  const footLine = nDone > 0 && avg != null
    ? (avg >= 40 ? t('pendingExams2.avg', { n: nDone, x: Math.round(avg) }) : t('pendingExams2.low'))
    : t('pendingExams2.first')

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={<Space><ClockCircleOutlined style={{ color: ct.warning }} />{t('pendingExams2.title')}</Space>}
      extra={<Button type="link" size="small" onClick={() => navigate('/exam')}>{t('viewAll')} <RightOutlined /></Button>}
      styles={{ body: { padding: '2px 16px 10px' } }}
    >
      {shown.map((exam, idx) => {
        const dl = deadlineInfo(exam.end_time, new Date(now))
        return (
          <div
            key={exam.id}
            className="dash-row"
            style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '9px 6px', margin: '0 -6px',
              borderBottom: idx === shown.length - 1 && !rest ? 'none' : '1px solid rgba(128,128,128,0.12)',
            }}
          >
            <ExperimentOutlined style={{ fontSize: 18, color: ct.primary, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Space size={6} wrap>
                <Text style={{ fontSize: 13, fontWeight: 500 }} ellipsis={{ tooltip: exam.title }}>{exam.title}</Text>
                {dl && (
                  <Tag color={dl.level === 'overdue' ? 'red' : dl.level === 'today' ? 'orange' : 'blue'} style={{ fontSize: 10, marginInlineEnd: 0 }}>
                    {dl.level === 'overdue'
                      ? t('welcome.overdueDays', { n: dl.overdueDays })
                      : dl.level === 'today'
                        ? t('welcome.dueToday', { h: dl.hoursLeft })
                        : t('welcome.daysToExam', { n: dl.days })}
                  </Tag>
                )}
              </Space>
            </div>
            <Button type="primary" size="small" style={{ flexShrink: 0 }} onClick={() => navigate(`/exam-take/${exam.id}`)}>
              {t('startExam')}
            </Button>
          </div>
        )
      })}
      {rest > 0 && (
        <div style={{ paddingTop: 6 }}>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => navigate('/exam')}>
            {t('pendingExams2.more', { n: rest })} <RightOutlined style={{ fontSize: 10 }} />
          </Button>
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{footLine}</Text>
      </div>
    </Card>
  )
}

export default PendingExamsCard
