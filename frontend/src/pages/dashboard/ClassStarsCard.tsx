/**
 * 教师端：一周之星（近7天真实积分 TOP5，含班级）+ 今日概况
 *
 * 三种形式：排行（头像+背景条）、条形（去掉头像突出差距）、领奖台（前 3 名柱高）。
 * 三者表达的是同一组积分与名次，切换不会丢信息。
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Avatar, Button, Card, Space, Tag, Tooltip, Typography } from 'antd'
import {
  BarChartOutlined, CrownOutlined, OrderedListOutlined, RightOutlined, TrophyOutlined,
} from '@ant-design/icons'
import type { DashboardSummary, TeacherTodo } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'
import { useChartVariant } from './chartVariant'
import VariantSwitch from './VariantSwitch'

const { Text } = Typography

const STARS_POOL = ['rank', 'bars', 'podium'] as const
type StarsVariant = (typeof STARS_POOL)[number]

const VARIANT_ICON: Record<StarsVariant, React.ReactNode> = {
  rank: <OrderedListOutlined />,
  bars: <BarChartOutlined />,
  podium: <TrophyOutlined />,
}

const MEDALS = ['🥇', '🥈', '🥉', '4', '5']
const AVATAR_COLORS = ['#faad14', '#bfbfbf', '#d48806', '#1677ff', '#722ed1']
const GOLD = '#faad14'

const ClassStarsCard: React.FC<{ summary: DashboardSummary; todo: TeacherTodo | null }> = ({ summary, todo }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const [variant, chooseVariant] = useChartVariant('stars', STARS_POOL)
  const stars = todo?.weekly_top_students ?? []
  const maxPts = Math.max(1, ...stars.map((s) => Number(s.points) || 0))

  // 本周点名统一按周一起算；卡片显示"轮次"，其余口径放进悬停说明，
  // 免得又把"累计"当成"本周"（老字段 rollcall_this_week 就是这么骗人的）
  const rcRounds = summary.rollcall_this_week_rounds ?? summary.rollcall_this_week ?? 0
  const rcCalls = summary.rollcall_this_week_calls ?? 0
  const rcStudents = summary.rollcall_this_week_students ?? 0
  const rcTotal = summary.rollcall_total ?? 0

  const renderRank = () => (
    <div className="dash-stagger">
      {stars.map((s, idx) => (
        <div
          key={`${s.username}-${idx}`}
          style={{
            position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            padding: '5px 0',
            borderBottom: idx === stars.length - 1 ? 'none' : '1px solid rgba(128,128,128,0.12)',
          }}
        >
          {/* 以榜首为 100% 的相对条：光看分数看不出差多少，有条才有比较 */}
          <span
            className="dash-bar-fill"
            aria-hidden
            style={{
              position: 'absolute', top: 3, bottom: 3, left: 0, borderRadius: 4,
              width: `${((Number(s.points) || 0) / maxPts) * 100}%`,
              background: idx === 0 ? 'rgba(250,173,20,0.18)' : 'rgba(22,119,255,0.10)',
              pointerEvents: 'none',
            }}
          />
          <Space size={8} style={{ minWidth: 0 }}>
            <span style={{ width: 22, textAlign: 'center', fontSize: idx < 3 ? 15 : 12, fontWeight: 600, flexShrink: 0 }}>
              {MEDALS[idx]}
            </span>
            <Avatar size={20} style={{ background: AVATAR_COLORS[idx], fontSize: 11, flexShrink: 0 }}>
              {s.name.slice(0, 1)}
            </Avatar>
            <Text style={{ fontSize: 13 }} ellipsis>{s.name}</Text>
            {s.tag && (
              <Tag
                style={{
                  fontSize: 10, marginInlineEnd: 0, lineHeight: '16px', padding: '0 5px',
                  color: ct.tick,
                  background: ct.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.03)',
                  borderColor: ct.grid,
                }}
              >
                {s.tag}
              </Tag>
            )}
          </Space>
          <Text strong style={{ color: GOLD, fontSize: 12, flexShrink: 0 }}>
            {s.points} {t('stars.pointsUnit')}
          </Text>
        </div>
      ))}
    </div>
  )

  const renderBars = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0 4px' }}>
      {stars.map((s, idx) => {
        const pts = Number(s.points) || 0
        return (
          <div key={`${s.username}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 14, flexShrink: 0, textAlign: 'right', fontSize: 11, color: ct.tick, fontVariantNumeric: 'tabular-nums' }}>
              {idx + 1}
            </span>
            <Text ellipsis style={{ width: 62, flexShrink: 0, fontSize: 12 }}>{s.name}</Text>
            <span style={{ position: 'relative', flex: 1, height: 10, borderRadius: 5, background: ct.track, overflow: 'hidden' }}>
              <span
                className="dash-bar-fill"
                style={{
                  display: 'block', height: '100%', borderRadius: 5,
                  width: `${(pts / maxPts) * 100}%`,
                  background: idx === 0 ? GOLD : ct.primary,
                }}
              />
            </span>
            <strong style={{ width: 40, flexShrink: 0, textAlign: 'right', fontSize: 11, color: GOLD, fontVariantNumeric: 'tabular-nums' }}>
              {pts}
            </strong>
          </div>
        )
      })}
    </div>
  )

  const renderPodium = () => {
    const top = stars.slice(0, 3)
    const rest = stars.slice(3)
    const MAX_BAR = 78
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, paddingTop: 10, borderBottom: `1px solid ${ct.grid}` }}>
          {top.map((s, idx) => {
            const pts = Number(s.points) || 0
            return (
              <div key={`${s.username}-${idx}`} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: ct.tick, fontVariantNumeric: 'tabular-nums', marginBottom: 2 }}>{pts}</span>
                <span
                  style={{
                    width: '74%', height: Math.max(12, (pts / maxPts) * MAX_BAR),
                    borderRadius: '4px 4px 0 0',
                    background: idx === 0 ? GOLD : idx === 1 ? 'rgba(22,119,255,0.62)' : 'rgba(22,119,255,0.36)',
                    transition: 'height 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                />
                <Text ellipsis style={{ maxWidth: '100%', fontSize: 11, marginTop: 4 }}>
                  {MEDALS[idx]} {s.name}
                </Text>
              </div>
            )
          })}
        </div>
        {rest.length > 0 && (
          <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, color: ct.tick }}>
            {rest.map((s, i) => (
              <Text key={`${s.username}-${i}`} ellipsis style={{ fontSize: 11, color: ct.tick, maxWidth: '50%' }}>
                {i + 4}. {s.name} {s.points}
              </Text>
            ))}
          </div>
        )}
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
          <CrownOutlined style={{ color: GOLD }} />
          <span style={{ fontSize: 14, fontWeight: 500 }}>{t('stars.title')}</span>
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>{t('stars.sub')}</Text>
        </Space>
      }
      extra={
        <Space size={4} wrap={false}>
          <Button type="link" size="small" onClick={() => navigate('/score')}>{t('viewAll')} <RightOutlined /></Button>
          {stars.length > 0 && (
            <VariantSwitch
              title={t('chart.switchTitle')}
              value={variant}
              onChange={chooseVariant}
              options={STARS_POOL.map((k) => ({ key: k, icon: VARIANT_ICON[k], label: t(`stars.view.${k}`) }))}
            />
          )}
        </Space>
      }
      styles={{ body: { padding: '0 16px 8px' } }}
    >
      {stars.length === 0 ? (
        // 空态也撑满卡片：同行另两张卡更高时，空态文字不会贴在上半部分
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '20px 0' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('stars.empty')}</Text>
          <div style={{ marginTop: 6 }}>
            <Button size="small" type="primary" ghost onClick={() => navigate('/interaction')}>
              {t('stars.emptyCta')}
            </Button>
          </div>
        </div>
      ) : variant === 'bars' ? (
        renderBars()
      ) : variant === 'podium' ? (
        renderPodium()
      ) : (
        renderRank()
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 2px', borderTop: '1px dashed rgba(128,128,128,0.25)', fontSize: 12, marginTop: 'auto' }}>
        <Text type="secondary">{t('stars.todayChat')}: <Text strong style={{ fontSize: 12 }}>{summary.today_chat_count ?? 0}</Text></Text>
        <Tooltip title={t('stars.weekTooltip', { rounds: rcRounds, calls: rcCalls, students: rcStudents, total: rcTotal })}>
          <Text type="secondary">{t('thisWeekRollcall')}: <Text strong style={{ fontSize: 12 }}>{rcRounds}</Text></Text>
        </Tooltip>
        <Text type="secondary">{t('stars.activeToday')}: <Text strong style={{ fontSize: 12 }}>{todo?.active_students_today ?? 0}</Text></Text>
      </div>
    </Card>
  )
}

export default ClassStarsCard
