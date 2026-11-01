/**
 * 近 7 天学习动态：积分主图 + 活跃轨，三种等价形式（柱 / 折线 / 热力格）。
 *
 * 历史包袱与取舍：
 * ① 这张卡原来用 recharts 面积图，后来发现 7 天常常只有 1~2 天非零，面积图把其余天
 *    画成贴底的空线，看着像图表坏了；换柱状后 recharts 在该尺寸下又算出 22/-29/-89
 *    这类错误刻度，柱高直接归零。结论是：**这张卡的所有形式都用 DOM/SVG 手写**，
 *    不要再把图表库引回来，否则同类问题会立刻重现。
 * ② 原实现把「积分（几十上百）」和「对话（0~3）」画在同一根轴上、共用同一个峰值归一化，
 *    结果对话柱永远贴地——信息已经丢了。现在拆成两条轨：上轨积分，下轨活跃度，
 *    各自按自身峰值缩放，谁也不压谁。
 * ③ 原环比用 points+chats+actions 算，但画面只画 points/chats，会出现「柱子没变、
 *    环比却在跳」。现在两处口径统一为 points。
 *
 * 形式切换见 chartVariant.ts：按日期稳定轮换，用户手动选过就一直是那个。
 */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Skeleton, Space, Tooltip, Typography } from 'antd'
import {
  AppstoreOutlined, ArrowDownOutlined, ArrowUpOutlined, BarChartOutlined, LineChartOutlined, RiseOutlined,
} from '@ant-design/icons'
import { getLearningTrend, type LearningTrend, type TrendPoint } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'
import { useChartVariant } from './chartVariant'
import VariantSwitch from './VariantSwitch'
import ChartEmpty from './ChartEmpty'
import { reportLoadError } from '../../utils/loadError'

const { Text } = Typography

const TREND_POOL = ['bars', 'line', 'heat'] as const
type TrendVariant = (typeof TREND_POOL)[number]

const VARIANT_ICON: Record<TrendVariant, React.ReactNode> = {
  bars: <BarChartOutlined />,
  line: <LineChartOutlined />,
  heat: <AppstoreOutlined />,
}

/** 主图区总高（px）。折线/热力格的坐标按它算，所以是常量而不是百分比 */
const CHART_H = 88
/** 顶部留给数值标签的高度：柱顶到 100% 时数字会顶出画布，得先留出来 */
const LABEL_H = 16
/** 实际绘图高度 */
const PLOT_H = CHART_H - LABEL_H

const mainPoints = (p: TrendPoint) => Number(p.points) || 0
/** 活跃度 = 对话 + 行为；与积分分开成轨，不再和积分抢同一根轴 */
const activityOf = (p: TrendPoint) => (Number(p.chats) || 0) + (Number(p.actions) || 0)

const TrendCard: React.FC = () => {
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const [trend, setTrend] = useState<LearningTrend | null>(null)
  const [variant, chooseVariant] = useChartVariant('trend', TREND_POOL)

  useEffect(() => {
    let cancelled = false
    getLearningTrend(7).then((d) => { if (!cancelled) setTrend(d) }).catch((err) => { if (!cancelled) reportLoadError(err, { key: 'dashboard.TrendCard' }) })
    return () => { cancelled = true }
  }, [])

  const series = trend?.series ?? []
  // 判定与绘制字段一致：只看 points / chats，避免「有课堂活动、没学习记录」也画出一张空图
  const hasData = series.some((p) => (p.points ?? 0) + (p.chats ?? 0) > 0)
  const peak = series.reduce((m, p) => Math.max(m, mainPoints(p)), 0)
  const actPeak = series.reduce((m, p) => Math.max(m, activityOf(p)), 0)
  const n = Math.max(series.length, 1)

  // 环比：最后一天相对前一天，口径与画面一致（只看积分）
  const last = series.length ? mainPoints(series[series.length - 1]) : 0
  const prev = series.length > 1 ? mainPoints(series[series.length - 2]) : 0
  const delta = last - prev

  /** 柱/点的高度百分比：峰值封顶 100%，非零至少 4%（否则 1 分和 0 分看起来一样） */
  const heightPct = (v: number) => (v > 0 ? Math.max(4, (v / Math.max(peak, 1)) * 100) : 0)

  const tip = (p: TrendPoint) => t('trend.heatTip', {
    day: p.label, points: p.points ?? 0, chats: p.chats ?? 0, actions: p.actions ?? 0,
  })

  /** 柱状：只给峰值与最后一天标数字，7 根全标会挤成一团 */
  const renderBars = () => (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: '100%' }}>
      {series.map((p, i) => {
        const v = mainPoints(p)
        const h = heightPct(v)
        const showVal = v > 0 && (v === peak || i === series.length - 1)
        return (
          <Tooltip key={p.label} title={tip(p)}>
            <div style={{ position: 'relative', flex: 1, height: '100%', cursor: 'default' }}>
              <span
                style={{
                  position: 'absolute', bottom: `calc(${h}% + 3px)`, left: 0, right: 0, textAlign: 'center',
                  fontSize: 10, lineHeight: '12px', color: ct.tick, fontVariantNumeric: 'tabular-nums',
                  visibility: showVal ? 'visible' : 'hidden',
                }}
              >
                {v}
              </span>
              <span
                style={{
                  position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)',
                  // 宽度自适应：教师端 4/10 宽、学生端 1/3 宽都在用这张卡，固定 9px 在宽卡里空隙过大
                  width: 'min(18px, 62%)',
                  height: v > 0 ? `${h}%` : 2,
                  background: v > 0 ? ct.primary : ct.track,
                  borderRadius: v > 0 ? '3px 3px 1px 1px' : 1,
                  transition: 'height 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              />
            </div>
          </Tooltip>
        )
      })}
    </div>
  )

  /** 折线：SVG 只画线（非等比拉伸），圆点用绝对定位的 div，避免被拉成椭圆 */
  const renderLine = () => {
    const xAt = (i: number) => ((i + 0.5) / n) * 100
    const yAt = (v: number) => PLOT_H * (1 - heightPct(v) / 100)
    const pts = series.map((p, i) => `${xAt(i).toFixed(2)},${yAt(mainPoints(p)).toFixed(2)}`).join(' ')
    return (
      <div style={{ position: 'relative', height: '100%' }}>
        <svg
          viewBox={`0 0 100 ${PLOT_H}`} preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          aria-hidden
        >
          <line x1="0" y1={PLOT_H} x2="100" y2={PLOT_H} stroke={ct.grid} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          {series.length > 1 && (
            <polyline
              points={pts} fill="none" stroke={ct.primary} strokeWidth={1.5}
              strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        {series.map((p, i) => {
          const v = mainPoints(p)
          const on = v > 0
          return (
            <Tooltip key={p.label} title={tip(p)}>
              <span
                style={{
                  position: 'absolute',
                  left: `${xAt(i)}%`,
                  top: yAt(v),
                  width: on ? 7 : 5, height: on ? 7 : 5,
                  marginLeft: on ? -3.5 : -2.5, marginTop: on ? -3.5 : -2.5,
                  boxSizing: 'border-box',
                  borderRadius: '50%',
                  background: on ? ct.primary : 'transparent',
                  border: on ? '1.5px solid var(--ant-color-bg-container, #fff)' : `1px solid ${ct.track}`,
                  cursor: 'default',
                }}
              />
            </Tooltip>
          )
        })}
      </div>
    )
  }

  /**
   * 热力格：颜色编码强度，弱数据下也不会像坐标轴那样显空。
   * 5 档太粗（14 和 12 落同档），改成按与峰值的比例连续插值。
   */
  const renderHeat = () => {
    const fill = (v: number) => {
      if (v <= 0) return ct.track
      const r = Math.min(1, v / Math.max(peak, 1))
      // 从浅蓝压到主题蓝：0.18 → 1
      return `rgba(22, 119, 255, ${(0.18 + 0.82 * r).toFixed(2)})`
    }
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: '100%' }}>
        {series.map((p) => {
          const v = mainPoints(p)
          return (
            <Tooltip key={p.label} title={tip(p)}>
              <div
                style={{
                  flex: 1, height: 36, borderRadius: 5, background: fill(v),
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, fontWeight: 500, fontVariantNumeric: 'tabular-nums',
                  // 白字只在颜色压得够深时用，否则对比度不够
                  color: v / Math.max(peak, 1) > 0.62 ? '#fff' : ct.tick,
                  transition: 'background-color 0.4s ease',
                }}
              >
                {v > 0 ? v : ''}
              </div>
            </Tooltip>
          )
        })}
      </div>
    )
  }

  return (
    <Card
      size="small"
      className="dash-card dash-fill-card dash-top-body"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <RiseOutlined style={{ color: '#13c2c2', fontSize: 14 }} />
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{t('trend.title')}</Text>
        </Space>
      }
      extra={trend && (
        <Space size={4} wrap={false}>
          {delta !== 0 && (
            <Tooltip title={t('trend.dodTip')}>
              <Text
                style={{
                  fontSize: 11, fontVariantNumeric: 'tabular-nums', marginRight: 2,
                  color: delta > 0 ? ct.success : ct.danger,
                }}
              >
                {delta > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{Math.abs(delta)}
              </Text>
            </Tooltip>
          )}
          <VariantSwitch
            title={t('chart.switchTitle')}
            value={variant}
            onChange={chooseVariant}
            options={TREND_POOL.map((k) => ({ key: k, icon: VARIANT_ICON[k], label: t(`trend.view.${k}`) }))}
          />
        </Space>
      )}
      styles={{ body: { padding: '10px 12px 8px', minHeight: 190 } }}
    >
      {!trend ? (
        <Skeleton active title={false} paragraph={{ rows: 4 }} style={{ paddingTop: 8 }} />
      ) : hasData ? (
        <>
          {/* 三种形式共用同一个绘图容器（顶部预留 LABEL_H 给数值标签），切换时卡片高度不跳 */}
          <div style={{ height: CHART_H, paddingTop: LABEL_H, boxSizing: 'border-box' }}>
            {variant === 'line' ? renderLine() : variant === 'heat' ? renderHeat() : renderBars()}
          </div>

          {/* 活跃轨：三种形式共用，保证切换后信息量不变（否则「换形式」就成了换信息） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 8 }}>
            <span style={{ fontSize: 10, color: ct.tick, flexShrink: 0, marginRight: 2 }}>
              {t('trend.activity')}
            </span>
            {series.map((p) => {
              const act = activityOf(p)
              return (
                <Tooltip key={p.label} title={tip(p)}>
                  <span
                    style={{
                      flex: 1, height: 6, borderRadius: 3, cursor: 'default',
                      background: act > 0
                        ? `rgba(19, 194, 194, ${(0.25 + 0.75 * (act / Math.max(actPeak, 1))).toFixed(2)})`
                        : ct.track,
                    }}
                  />
                </Tooltip>
              )
            })}
          </div>

          <div style={{ display: 'flex', gap: 2, borderTop: `1px solid ${ct.grid}`, paddingTop: 4, marginTop: 6 }}>
            {series.map((p) => (
              <span key={p.label} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: ct.tick }}>
                {p.label}
              </span>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8, fontSize: 11, color: ct.tick }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: ct.primary }} />{t('trend.points')}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i style={{ width: 7, height: 7, borderRadius: 2, background: '#13c2c2' }} />{t('trend.activity')}
            </span>
            {/* 「本周积分」原来是标题行的一个 Tag，与环比挤在一起且量纲不同（周累计 vs 日环比），下沉到这里 */}
            <Text style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 500, color: ct.primary }}>
              {t('trend.weekPoints', { n: trend.total_points })}
            </Text>
          </div>
        </>
      ) : (
        <ChartEmpty text={t('trend.empty')} hint={t('trend.emptyHint')} />
      )}
    </Card>
  )
}

export default TrendCard
