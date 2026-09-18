/** 学生近期考试成绩（总分灰底 + 得分柱，通过/未通过区分色） */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Space, Tag, Typography } from 'antd'
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { FileAddOutlined } from '@ant-design/icons'
import type { DashboardSummary } from '../../api/dashboard'
import { tooltipStyle, useChartTheme } from './chartTheme'

const { Text } = Typography

const ExamScoresCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const results = (summary.exam_results ?? []).slice(0, 6)

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <FileAddOutlined style={{ color: '#1677ff', fontSize: 14 }} />
          <Text style={{ fontSize: 13 }}>{t('recentScores')}</Text>
        </Space>
      }
      extra={summary.exam_avg_rate != null && (
        <Tag color={summary.exam_avg_rate >= 60 ? 'green' : 'orange'} style={{ margin: 0 }}>
          {t('scores.avgRate', { v: summary.exam_avg_rate })}
        </Tag>
      )}
      styles={{ body: { padding: '4px 8px 0', minHeight: 190 } }}
    >
      {results.length > 0 ? (
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={results.map((r) => ({
            name: r.title.length > 6 ? r.title.slice(0, 6) + '…' : r.title,
            score: Math.round(r.score),
            total: Math.round(r.total_score),
            passed: r.passed,
          }))} margin={{ top: 8, right: 2, left: -10, bottom: 0 }}>
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: ct.tick }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: ct.tick }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={tooltipStyle(ct)} />
            <Bar dataKey="total" fill={ct.placeholder} radius={[3, 3, 0, 0]} maxBarSize={18} name={t('scores.total')} />
            <Bar dataKey="score" radius={[3, 3, 0, 0]} maxBarSize={18} name={t('scores.mine')}>
              {results.map((entry, idx) => (<Cell key={idx} fill={entry.passed ? '#52c41a' : '#ff7a45'} />))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ textAlign: 'center', padding: '64px 0', color: ct.empty, fontSize: 12 }}>
          {t('chart.noExamData')}
        </div>
      )}
    </Card>
  )
}

export default ExamScoresCard
