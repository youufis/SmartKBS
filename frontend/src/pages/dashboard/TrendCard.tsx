/**
 * 近 7 天学习动态：每天两根柱（积分 / 对话）+ 环比角标
 *
 * 这张图原来用 recharts 面积图，随后发现三个问题叠在一起：
 * ① 数据只有 7 天且常常 1~2 天非零，面积图把其余天画成贴底的空线，看着像图表坏了；
 * ② 数值域常常 0~3，自动分档会给出 0/0/0/10 这种重复刻度；
 * ③ 换柱状后，显式 ticks / domain 在该版本下算出 22/-29/-89 这类错误刻度，柱高也归零。
 * 只有 7 个数据点，用 DOM 画柱比配图表库更稳，窄屏也不会被压扁。
 */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Skeleton, Space, Tag, Tooltip, Typography } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, RiseOutlined } from '@ant-design/icons'
import { getLearningTrend, type LearningTrend } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'
import { reportLoadError } from '../../utils/loadError'

const { Text } = Typography

/** 当天活跃度：积分 + 行为 + 对话，够单调也够真实 */
const dayValue = (p: LearningTrend['series'][number]) =>
  (p.points ?? 0) + (p.chats ?? 0) + (p.actions ?? 0)

const CHART_HEIGHT = 96
const BAR_WIDTH = 9

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
  // 判定与绘制字段一致：只看 points / chats，避免"有课堂活动、没学习记录"也画出一张空图
  const hasData = series.some((p) => (p.points ?? 0) + (p.chats ?? 0) > 0)
  const peak = series.reduce((m, p) => Math.max(m, Number(p.points) || 0, Number(p.chats) || 0), 0)

  // 环比：最后一天相对前一天，给"死图"一个变化方向
  const last = series.length ? dayValue(series[series.length - 1]) : 0
  const prev = series.length > 1 ? dayValue(series[series.length - 2]) : 0
  const delta = last - prev

  // 高度按容器百分比：卡片被同行更高的卡撑高时，柱子跟着长，不会在下面留一条空白
  const barStyle = (v: number, color: string): React.CSSProperties => ({
    width: BAR_WIDTH,
    height: v > 0 ? `${Math.max(5, (v / Math.max(peak, 1)) * 100)}%` : 0,
    minHeight: v > 0 ? 3 : 0,
    background: color,
    borderRadius: 2,
    transition: 'height 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
  })

  return (
    <Card
      size="small"
      className="dash-card dash-fill-card"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <RiseOutlined style={{ color: '#13c2c2', fontSize: 14 }} />
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{t('trend.title')}</Text>
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
      styles={{ body: { padding: '10px 12px 8px', minHeight: 190 } }}
    >
      {!trend ? (
        <Skeleton active title={false} paragraph={{ rows: 4 }} style={{ paddingTop: 8 }} />
      ) : hasData ? (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, flex: 1, minHeight: CHART_HEIGHT, paddingTop: 6 }}>
            {series.map((p) => (
              <Tooltip
                key={p.label}
                title={t('trend.heatTip', { day: p.label, points: p.points ?? 0, chats: p.chats ?? 0, actions: p.actions ?? 0 })}
              >
                <div
                  style={{
                    flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end',
                    justifyContent: 'center', gap: 2, cursor: 'default',
                  }}
                >
                  <span style={barStyle(Number(p.points) || 0, '#1677ff')} />
                  <span style={barStyle(Number(p.chats) || 0, '#13c2c2')} />
                </div>
              </Tooltip>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 2, borderTop: `1px solid ${ct.grid}`, paddingTop: 4 }}>
            {series.map((p) => (
              <span key={p.label} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: ct.tick }}>
                {p.label}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 8, fontSize: 11, color: ct.tick }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: '#1677ff' }} />{t('trend.points')}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: '#13c2c2' }} />{t('trend.chats')}
            </span>
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
