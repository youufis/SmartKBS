/** 近 7 天学习动态：面积图看走势 + 热力条看"哪天真的有事" + 环比角标看变化 */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Skeleton, Space, Tag, Tooltip, Typography } from 'antd'
import { Area, AreaChart, Legend, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts'
import { ArrowDownOutlined, ArrowUpOutlined, RiseOutlined } from '@ant-design/icons'
import { getLearningTrend, type LearningTrend } from '../../api/dashboard'
import { tooltipStyle, useChartTheme } from './chartTheme'
import { reportLoadError } from '../../utils/loadError'

const { Text } = Typography

/** 当天活跃度：积分 + 行为 + 对话，够单调也够真实 */
const dayValue = (p: LearningTrend['series'][number]) =>
  (p.points ?? 0) + (p.chats ?? 0) + (p.actions ?? 0)

const TrendCard: React.FC = () => {
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const [trend, setTrend] = useState<LearningTrend | null>(null)

  useEffect(() => {
    let cancelled = false
    getLearningTrend(7).then((d) => { if (!cancelled) setTrend(d) }).catch((err) => { if (!cancelled) reportLoadError(err, { key: 'dashboard.TrendCard' }) })
    return () => { cancelled = true }
  }, [])

  const series = trend?.series ?? []
  const hasData = series.some((p) => dayValue(p) > 0)
  const maxDay = Math.max(1, ...series.map(dayValue))
  // 环比：最后一天相对前一天，给"死图"一个变化方向
  const last = series.length ? dayValue(series[series.length - 1]) : 0
  const prev = series.length > 1 ? dayValue(series[series.length - 2]) : 0
  const delta = last - prev

  return (
    <Card
      size="small"
      className="dash-card"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <RiseOutlined style={{ color: '#13c2c2', fontSize: 14 }} />
          <Text style={{ fontSize: 13 }}>{t('trend.title')}</Text>
        </Space>
      }
      extra={trend && (
        <Space size={6}>
          {delta !== 0 && (
            <Tag
              icon={delta > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
              color={delta > 0 ? 'green' : 'volcano'}
              style={{ margin: 0 }}
            >
              {t('trend.dod', { n: Math.abs(delta) })}
            </Tag>
          )}
          <Tag color="blue" style={{ margin: 0 }}>{t('trend.weekPoints', { n: trend.total_points })}</Tag>
        </Space>
      )}
      styles={{ body: { padding: '4px 8px 6px', minHeight: 190 } }}
    >
      {!trend ? (
        <Skeleton active title={false} paragraph={{ rows: 4 }} style={{ paddingTop: 8 }} />
      ) : hasData ? (
        <>
          <ResponsiveContainer width="100%" height={140}>
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
              <RTooltip contentStyle={tooltipStyle(ct)} />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
              <Area
                type="monotone" dataKey="points" name={t('trend.points')}
                stroke="#1677ff" strokeWidth={2} fill="url(#gPoints)"
                isAnimationActive animationDuration={600}
              />
              <Area
                type="monotone" dataKey="chats" name={t('trend.chats')}
                stroke="#13c2c2" strokeWidth={1.6} fill="url(#gChats)"
                isAnimationActive animationDuration={600}
              />
            </AreaChart>
          </ResponsiveContainer>
          {/* 热力条：面积图看趋势，这一条看"哪天真有动静"，两者回答的问题不同 */}
          <div style={{ display: 'flex', gap: 4, padding: '2px 6px 0' }}>
            {series.map((p) => {
              const v = dayValue(p)
              return (
                <Tooltip key={p.label} title={t('trend.heatTip', { day: p.label, points: p.points ?? 0, chats: p.chats ?? 0, actions: p.actions ?? 0 })}>
                  <div
                    className="dash-heat-cell"
                    style={{
                      flex: 1, height: 8, borderRadius: 2,
                      background: v > 0 ? `rgba(22,119,255,${(0.18 + 0.72 * (v / maxDay)).toFixed(2)})` : (ct.isDark ? 'rgba(255,255,255,0.08)' : '#f0f0f0'),
                    }}
                  />
                </Tooltip>
              )
            })}
          </div>
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: '56px 0', color: ct.empty, fontSize: 12 }}>
          {t('trend.empty')}
          <div style={{ marginTop: 4 }}>{t('trend.emptyHint')}</div>
        </div>
      )}
    </Card>
  )
}

export default TrendCard