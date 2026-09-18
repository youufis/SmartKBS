/** 学生能力画像：全部基于真实正确率/完成率（替代原拍脑袋公式） */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Space, Tooltip, Typography } from 'antd'
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer } from 'recharts'
import { QuestionCircleOutlined } from '@ant-design/icons'
import type { DashboardSummary } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'
import { pct } from './fmt'

const { Text } = Typography

const AbilityRadarCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()

  const practiceTotal = (summary.completed_practice_count ?? 0) + (summary.pending_practice_count ?? 0)
  const dims = [
    { d: t('radar.exam'), v: pct(summary.exam_avg_rate) },
    { d: t('radar.coursePractice'), v: pct(summary.course_practice_avg_accuracy) },
    { d: t('radar.practice'), v: practiceTotal > 0 ? pct(((summary.completed_practice_count ?? 0) / practiceTotal) * 100) : 0 },
    { d: t('radar.wrongBook'), v: (summary.wrong_book_total ?? 0) > 0 ? pct(((summary.wrong_book_mastered ?? 0) / (summary.wrong_book_total ?? 1)) * 100) : 0 },
  ]
  const hasData = dims.some((x) => x.v > 0)

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={
        <Space size={4}>
          <Text style={{ fontSize: 13 }}>{t('radar.title')}</Text>
          <Tooltip title={t('radar.hint')}>
            <QuestionCircleOutlined style={{ color: ct.tick, fontSize: 12 }} />
          </Tooltip>
        </Space>
      }
      styles={{ body: { padding: '0 2px 2px', minHeight: 190 } }}
    >
      {hasData ? (
        <ResponsiveContainer width="100%" height={186}>
          <RadarChart data={dims} outerRadius="68%">
            <PolarGrid stroke={ct.grid} />
            <PolarAngleAxis dataKey="d" tick={{ fontSize: 10, fill: ct.tick }} />
            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
            <Radar dataKey="v" stroke="#722ed1" fill="#722ed1" fillOpacity={0.25} strokeWidth={1.5}
              name={t('radar.title')} />
          </RadarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ textAlign: 'center', padding: '56px 12px', color: ct.empty, fontSize: 12 }}>
          {t('radar.noData')}
        </div>
      )}
    </Card>
  )
}

export default AbilityRadarCard
