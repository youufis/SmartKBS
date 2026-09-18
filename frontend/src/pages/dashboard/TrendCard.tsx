/** 近 7 天真实趋势（积分/行为/对话），替代原来按分类画的伪面积图 */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Space, Tag, Typography } from 'antd'
import { Area, AreaChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { RiseOutlined } from '@ant-design/icons'
import { getLearningTrend, type LearningTrend } from '../../api/dashboard'
import { tooltipStyle, useChartTheme } from './chartTheme'

const { Text } = Typography

const TrendCard: React.FC = () => {
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const [trend, setTrend] = useState<LearningTrend | null>(null)

  useEffect(() => {
    let cancelled = false
    getLearningTrend(7).then((d) => { if (!cancelled) setTrend(d) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const series = trend?.series ?? []
  const hasData = series.some((p) => p.points > 0 || p.actions > 0 || p.chats > 0)

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <RiseOutlined style={{ color: '#13c2c2', fontSize: 14 }} />
          <Text style={{ fontSize: 13 }}>{t('trend.title')}</Text>
        </Space>
      }
      extra={trend && (
        <Tag color="blue" style={{ margin: 0 }}>{t('trend.weekPoints', { n: trend.total_points })}</Tag>
      )}
      styles={{ body: { padding: '4px 8px 0', minHeight: 190 } }}
    >
      {hasData ? (
        <ResponsiveContainer width="100%" height={170}>
          <AreaChart data={series} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
            <defs>
              <linearGradient id="gPoints" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1677ff" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#1677ff" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gChats" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#13c2c2" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#13c2c2" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: ct.tick }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: ct.tick }} axisLine={false} tickLine={false} width={30} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle(ct)} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
            <Area type="monotone" dataKey="points" name={t('trend.points')} stroke="#1677ff" strokeWidth={2} fill="url(#gPoints)" />
            <Area type="monotone" dataKey="chats" name={t('trend.chats')} stroke="#13c2c2" strokeWidth={1.6} fill="url(#gChats)" />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <div style={{ textAlign: 'center', padding: '64px 0', color: ct.empty, fontSize: 12 }}>
          {t('trend.empty')}
        </div>
      )}
    </Card>
  )
}

export default TrendCard
