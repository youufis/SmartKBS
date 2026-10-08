/** 学生能力画像：雷达看形状，下方数值行走"看得懂/可回退"的另一半 */
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
    { d: t('radar.exam'), v: pct(summary.exam_avg_rate), color: '#1677ff' },
    { d: t('radar.coursePractice'), v: pct(summary.course_practice_avg_accuracy), color: '#13c2c2' },
    { d: t('radar.practice'), v: practiceTotal > 0 ? pct(((summary.completed_practice_count ?? 0) / practiceTotal) * 100) : 0, color: '#722ed1' },
    { d: t('radar.wrongBook'), v: (summary.wrong_book_total ?? 0) > 0 ? pct(((summary.wrong_book_mastered ?? 0) / (summary.wrong_book_total ?? 1)) * 100) : 0, color: '#52c41a' },
  ]
  const hasData = dims.some((x) => x.v > 0)

  return (
    <Card
      size="small"
      className="dash-card"
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
        <>
          <ResponsiveContainer width="100%" height={150}>
            <RadarChart data={dims} outerRadius="66%">
              <PolarGrid stroke={ct.grid} />
              <PolarAngleAxis dataKey="d" tick={{ fontSize: 10, fill: ct.tick }} />
              <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
              <Radar
                dataKey="v" stroke="#722ed1" fill="#722ed1" fillOpacity={0.25} strokeWidth={1.5}
                name={t('radar.title')} isAnimationActive animationDuration={600}
              />
            </RadarChart>
          </ResponsiveContainer>
          {/* 数值行：雷达只给形状，具体多少必须能用文字读到（也是色盲/打印场景的回退） */}
          <div className="dash-stagger" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px', padding: '0 10px 6px', fontSize: 11 }}>
            {dims.map((x) => (
              <span key={x.d} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <i style={{ width: 6, height: 6, borderRadius: 1, background: x.color }} />
                <span style={{ color: ct.tick }}>{x.d}</span>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{x.v}%</strong>
              </span>
            ))}
          </div>
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: '56px 12px', color: ct.empty, fontSize: 12 }}>
          {t('radar.noData')}
          <div style={{ marginTop: 4 }}>{t('radar.noDataHint')}</div>
        </div>
      )}
    </Card>
  )
}

export default AbilityRadarCard