/**
 * 学生能力画像：三种等价形式——雷达看形状、条看高低、环看各自达成度。
 *
 * 三种表达的是同一组四维数值，不含额外信息，所以随便换都不会「换掉信息」。
 * 数值行只在雷达形式下出现：条/环本身已经带数字，再列一遍就是同一组数字说两遍。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Card, Space, Tooltip, Typography } from 'antd'
import {
  AimOutlined, AlignLeftOutlined, QuestionCircleOutlined, RadarChartOutlined,
} from '@ant-design/icons'
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer } from 'recharts'
import type { DashboardSummary } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'
import { useChartVariant } from './chartVariant'
import VariantSwitch from './VariantSwitch'
import ChartEmpty from './ChartEmpty'
import { pct } from './fmt'

const { Text } = Typography

const RADAR_POOL = ['radar', 'bars', 'ring'] as const
type RadarVariant = (typeof RADAR_POOL)[number]

const VARIANT_ICON: Record<RadarVariant, React.ReactNode> = {
  radar: <RadarChartOutlined />,
  bars: <AlignLeftOutlined />,
  ring: <AimOutlined />,
}

/** 环的几何：半径定死，周长只需算一次 */
const RING_R = 24
const RING_C = 2 * Math.PI * RING_R

const AbilityRadarCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()
  const ct = useChartTheme()
  const [variant, chooseVariant] = useChartVariant('radar', RADAR_POOL)

  const practiceTotal = (summary.completed_practice_count ?? 0) + (summary.pending_practice_count ?? 0)
  const dims = [
    { d: t('radar.exam'), v: pct(summary.exam_avg_rate), color: '#1677ff' },
    { d: t('radar.coursePractice'), v: pct(summary.course_practice_avg_accuracy), color: '#13c2c2' },
    // 这一维算的是 已完成/(已完成+待完成)，语义是「完成度」不是「正确率」。
    // 和另外三个正确率维度共用 0-100 刻度容易误读，所以标签与提示都按完成度表述。
    { d: t('radar.practice'), v: practiceTotal > 0 ? pct(((summary.completed_practice_count ?? 0) / practiceTotal) * 100) : 0, color: '#722ed1' },
    { d: t('radar.wrongBook'), v: (summary.wrong_book_total ?? 0) > 0 ? pct(((summary.wrong_book_mastered ?? 0) / (summary.wrong_book_total ?? 1)) * 100) : 0, color: '#52c41a' },
  ]
  const hasData = dims.some((x) => x.v > 0)

  const renderRadar = () => (
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
  )

  const renderBars = () => (
    <div style={{ padding: '12px 14px 10px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      {dims.map((x) => (
        <div key={x.d} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 56, flexShrink: 0, fontSize: 11, color: ct.tick,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {x.d}
          </span>
          <span style={{ position: 'relative', flex: 1, height: 8, borderRadius: 4, background: ct.track, overflow: 'hidden' }}>
            <span
              className="dash-bar-fill"
              style={{
                display: 'block', height: '100%', borderRadius: 4, background: x.color,
                // 0 也不是没数据：留 2% 让「这一维还没起来」和「这一维不存在」有区别
                width: `${Math.max(2, Math.min(100, x.v))}%`,
              }}
            />
          </span>
          <strong style={{ width: 34, flexShrink: 0, textAlign: 'right', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {x.v}%
          </strong>
        </div>
      ))}
    </div>
  )

  const renderRings = () => (
    <div style={{ display: 'flex', justifyContent: 'space-around', gap: 4, padding: '18px 6px 6px' }}>
      {dims.map((x) => (
        <div key={x.d} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          <div style={{ position: 'relative', width: 58, height: 58 }}>
            <svg width={58} height={58} viewBox="0 0 58 58" aria-hidden>
              <circle cx={29} cy={29} r={RING_R} fill="none" stroke={ct.track} strokeWidth={5} />
              {x.v > 0 && (
                <circle
                  cx={29} cy={29} r={RING_R} fill="none" stroke={x.color} strokeWidth={5}
                  strokeLinecap="round"
                  strokeDasharray={`${((RING_C * Math.min(100, x.v)) / 100).toFixed(2)} ${RING_C.toFixed(2)}`}
                  transform="rotate(-90 29 29)"
                />
              )}
            </svg>
            <span
              style={{
                position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 500, fontVariantNumeric: 'tabular-nums',
              }}
            >
              {x.v}%
            </span>
          </div>
          <span
            style={{
              fontSize: 10, color: ct.tick, maxWidth: '100%', textAlign: 'center',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {x.d}
          </span>
        </div>
      ))}
    </div>
  )

  return (
    <Card
      size="small"
      // 有数据贴顶（视线从标题直接落到图形），空态居中（一句话浮在卡中间才不显空）
      className={`dash-card dash-fill-card ${hasData ? 'dash-top-body' : 'dash-center-body'}`}
      style={{ height: '100%' }}
      title={
        <Space size={4}>
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{t('radar.title')}</Text>
          <Tooltip title={t('radar.hint')}>
            <QuestionCircleOutlined style={{ color: ct.tick, fontSize: 12 }} />
          </Tooltip>
        </Space>
      }
      extra={hasData && (
        <VariantSwitch
          title={t('chart.switchTitle')}
          value={variant}
          onChange={chooseVariant}
          options={RADAR_POOL.map((k) => ({ key: k, icon: VARIANT_ICON[k], label: t(`radar.view.${k}`) }))}
        />
      )}
      styles={{ body: { padding: variant === 'radar' ? '0 2px 2px' : 0, minHeight: 190 } }}
    >
      {hasData ? (
        variant === 'bars' ? renderBars() : variant === 'ring' ? renderRings() : renderRadar()
      ) : (
        <ChartEmpty
          text={t('radar.noData')}
          hint={t('radar.noDataHint')}
          action={{ label: t('radar.cta'), onClick: () => navigate('/practice') }}
        />
      )}
    </Card>
  )
}

export default AbilityRadarCard
