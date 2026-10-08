/** 学生近期考试成绩：按得分率画柱 + 均线参考，跨不同总分的考试才可比 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Space, Tag, Typography } from 'antd'
import {
  Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer,
  Tooltip as RTooltip, XAxis, YAxis,
} from 'recharts'
import { FileAddOutlined } from '@ant-design/icons'
import type { DashboardSummary } from '../../api/dashboard'
import { tooltipStyle, useChartTheme } from './chartTheme'

const { Text } = Typography

const ExamScoresCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const results = (summary.exam_results ?? []).slice(0, 6).map((r) => ({
    name: r.title.length > 6 ? r.title.slice(0, 6) + '…' : r.title,
    rate: r.total_score > 0 ? Math.round((r.score / r.total_score) * 100) : 0,
    score: Math.round(r.score),
    total: Math.round(r.total_score),
    passed: r.passed,
  }))
  const avg = summary.exam_avg_rate

  return (
    <Card
      size="small"
      className="dash-card"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <FileAddOutlined style={{ color: '#1677ff', fontSize: 14 }} />
          <Text style={{ fontSize: 13 }}>{t('recentScores')}</Text>
        </Space>
      }
      extra={avg != null && (
        <Tag color={avg >= 60 ? 'green' : 'orange'} style={{ margin: 0 }}>
          {t('scores.avgRate', { v: avg })}
        </Tag>
      )}
      styles={{ body: { padding: '4px 8px 0', minHeight: 190 } }}
    >
      {results.length > 0 ? (
        <ResponsiveContainer width="100%" height={170}>
          <BarChart data={results} margin={{ top: 10, right: 2, left: -14, bottom: 0 }}>
            <CartesianGrid stroke={ct.grid} vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: ct.tick }} axisLine={false} tickLine={false} interval={0} />
            <YAxis
              domain={[0, 100]} unit="%" tick={{ fontSize: 10, fill: ct.tick }}
              axisLine={false} tickLine={false} width={34}
            />
            <RTooltip
              contentStyle={tooltipStyle(ct)}
              formatter={(_v: unknown, _n: unknown, item?: { payload?: { score: number; total: number } }) => {
                const d = item?.payload
                return d ? [`${d.score} / ${d.total}`, t('scores.mine')] : []
              }}
            />
            {/* 均线：只看单场分数看不出进退，有一条平均线才知道这根比平时高还是低 */}
            {avg != null && (
              <ReferenceLine
                y={avg} stroke="#faad14" strokeDasharray="4 3"
                label={{ value: t('scores.avgLine', { v: avg }), position: 'insideTopRight', fontSize: 10, fill: '#faad14' }}
              />
            )}
            <Bar
              dataKey="rate" radius={[3, 3, 0, 0]} maxBarSize={22}
              name={t('scores.rate')} isAnimationActive animationDuration={600}
            >
              {results.map((entry, idx) => (
                <Cell key={idx} fill={entry.passed ? '#52c41a' : '#ff7a45'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ textAlign: 'center', padding: '56px 0', color: ct.empty, fontSize: 12 }}>
          {t('chart.noExamData')}
          <div style={{ marginTop: 4 }}>{t('chart.noExamDataHint')}</div>
        </div>
      )}
    </Card>
  )
}

export default ExamScoresCard