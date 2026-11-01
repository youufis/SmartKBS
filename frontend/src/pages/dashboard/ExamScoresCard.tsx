/**
 * 学生近期考试成绩：每场一条「标题 + 得分率条 + 分数」，可切成柱状或折线。
 *
 * 历史：原来用纵向柱状图，几个中文标题挤在 200px 内互相重叠、末尾被截断；换横向条形后，
 * recharts 在这个尺寸下条根本不渲染（只剩类目标签和均分虚线）。所以三种形式全用 DOM/SVG 手写。
 *
 * 这个卡片要回答两个问题——「最近几场考得怎么样」「比平时高还是低」：
 * - progress / bars：条形长度 + 均分参考线，回答第一个
 * - line：按考试顺序连起来，回答「在进步还是在退步」
 * 右侧数字从「得分率」改成「78/100」：条长已经表达比例，再写一遍百分比是冗余，
 * 而绝对分数是条长读不出来的信息。得分率退到 Tooltip 里。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Card, Space, Tag, Tooltip, Typography } from 'antd'
import {
  AlignLeftOutlined, BarChartOutlined, FileAddOutlined, LineChartOutlined,
} from '@ant-design/icons'
import type { DashboardSummary } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'
import { useChartVariant } from './chartVariant'
import VariantSwitch from './VariantSwitch'
import ChartEmpty from './ChartEmpty'

const { Text } = Typography

const SCORE_POOL = ['progress', 'bars', 'line'] as const
type ScoreVariant = (typeof SCORE_POOL)[number]

const VARIANT_ICON: Record<ScoreVariant, React.ReactNode> = {
  progress: <AlignLeftOutlined />,
  bars: <BarChartOutlined />,
  line: <LineChartOutlined />,
}

/** 柱区/折线区高度（px），柱与点都按它算百分比 */
const PLOT_H = 78

const ExamScoresCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()
  const ct = useChartTheme()
  const [variant, chooseVariant] = useChartVariant('scores', SCORE_POOL)
  // 卡片只放最近 4 场，再多就没有「最近」的意思了
  const results = (summary.exam_results ?? []).slice(0, 4).map((r) => ({
    id: r.id,
    title: r.title,
    rate: r.total_score > 0 ? Math.round((r.score / r.total_score) * 100) : 0,
    score: Math.round(r.score),
    total: Math.round(r.total_score),
    passed: r.passed,
  }))
  const avg = summary.exam_avg_rate
  const n = Math.max(results.length, 1)

  const barColor = (passed: boolean) => (passed ? ct.success : ct.warning)

  const renderProgress = () => (
    <div>
      {results.map((r) => (
        <Tooltip key={r.id} title={`${r.title} · ${t('scores.rate')} ${r.rate}%`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
            <Text ellipsis style={{ width: 76, flexShrink: 0, fontSize: 11, color: ct.tick }}>
              {r.title}
            </Text>
            {/* 条背景 + 均分竖线：每行都标同一位置，连起来就是一条贯穿的参考线 */}
            <span style={{ position: 'relative', flex: 1, height: 8, borderRadius: 4, overflow: 'hidden', background: ct.track }}>
              <span
                className="dash-bar-fill"
                style={{ display: 'block', height: '100%', width: `${r.rate}%`, borderRadius: 4, background: barColor(r.passed) }}
              />
              {avg != null && (
                <span
                  aria-hidden
                  style={{
                    position: 'absolute', top: 0, bottom: 0, left: `${Math.max(0, Math.min(100, avg))}%`,
                    width: 1.5, background: ct.gold, opacity: 0.9,
                  }}
                />
              )}
            </span>
            <strong style={{
              width: 54, flexShrink: 0, textAlign: 'right', fontSize: 12,
              fontVariantNumeric: 'tabular-nums', color: barColor(r.passed),
            }}>
              {r.score}<span style={{ color: ct.tick, fontWeight: 400 }}>/{r.total}</span>
            </strong>
          </div>
        </Tooltip>
      ))}
      {avg != null && <Text type="secondary" style={{ fontSize: 11 }}>{t('scores.avgHint')}</Text>}
    </div>
  )

  const renderBars = () => (
    <div>
      <div style={{ position: 'relative' }}>
        {/* 均分参考线贯穿所有柱，和 progress 里那条虚线同一含义 */}
        {avg != null && (
          <div
            aria-hidden
            style={{
              position: 'absolute', left: 0, right: 0, zIndex: 1,
              bottom: 18 + (PLOT_H * Math.max(0, Math.min(100, avg))) / 100,
              borderTop: `1px dashed ${ct.gold}`, opacity: 0.85, pointerEvents: 'none',
            }}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, paddingBottom: 18 }}>
          {results.map((r) => (
            <Tooltip key={r.id} title={`${r.title} · ${r.rate}% · ${r.score}/${r.total}`}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'default' }}>
                <span style={{ fontSize: 10, color: ct.tick, fontVariantNumeric: 'tabular-nums' }}>{r.rate}%</span>
                <span
                  style={{
                    width: 'min(28px, 72%)', height: Math.max(4, (PLOT_H * r.rate) / 100),
                    background: barColor(r.passed), borderRadius: '3px 3px 1px 1px',
                    transition: 'height 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                />
              </div>
            </Tooltip>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, borderTop: `1px solid ${ct.grid}`, paddingTop: 4 }}>
          {results.map((r) => (
            <span
              key={r.id}
              style={{
                flex: 1, minWidth: 0, textAlign: 'center', fontSize: 10, color: ct.tick,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {r.title}
            </span>
          ))}
        </div>
      </div>
    </div>
  )

  const renderLine = () => {
    const xAt = (i: number) => ((i + 0.5) / n) * 100
    const yAt = (v: number) => PLOT_H * (1 - v / 100)
    const pts = results.map((r, i) => `${xAt(i).toFixed(2)},${yAt(r.rate).toFixed(2)}`).join(' ')
    return (
      <div>
        <div style={{ position: 'relative', height: PLOT_H }}>
          <svg
            viewBox={`0 0 100 ${PLOT_H}`} preserveAspectRatio="none"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            aria-hidden
          >
            <line x1="0" y1={PLOT_H} x2="100" y2={PLOT_H} stroke={ct.grid} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {avg != null && (
              <line
                x1="0" y1={yAt(avg).toFixed(2)} x2="100" y2={yAt(avg).toFixed(2)}
                stroke={ct.gold} strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke"
              />
            )}
            {results.length > 1 && (
              <polyline
                points={pts} fill="none" stroke={ct.primary} strokeWidth={1.5}
                strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {results.map((r, i) => (
            <Tooltip key={r.id} title={`${r.title} · ${r.rate}% · ${r.score}/${r.total}`}>
              <span
                style={{
                  position: 'absolute', left: `${xAt(i)}%`, top: yAt(r.rate),
                  width: 7, height: 7, marginLeft: -3.5, marginTop: -3.5, boxSizing: 'border-box',
                  borderRadius: '50%', background: barColor(r.passed),
                  border: '1.5px solid var(--ant-color-bg-container, #fff)', cursor: 'default',
                }}
              />
            </Tooltip>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, borderTop: `1px solid ${ct.grid}`, paddingTop: 4 }}>
          {results.map((r) => (
            <span
              key={r.id}
              style={{
                flex: 1, minWidth: 0, textAlign: 'center', fontSize: 10, color: ct.tick,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {r.title}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <Card
      size="small"
      className={`dash-card dash-fill-card ${results.length > 0 ? 'dash-top-body' : 'dash-center-body'}`}
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <FileAddOutlined style={{ color: '#1677ff', fontSize: 14 }} />
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{t('recentScores')}</Text>
        </Space>
      }
      extra={
        <Space size={6} wrap={false}>
          {avg != null && (
            <Tag color={avg >= 60 ? 'green' : 'orange'} style={{ margin: 0 }}>
              {t('scores.avgRate', { v: avg })}
            </Tag>
          )}
          {results.length > 0 && (
            <VariantSwitch
              title={t('chart.switchTitle')}
              value={variant}
              onChange={chooseVariant}
              options={SCORE_POOL.map((k) => ({ key: k, icon: VARIANT_ICON[k], label: t(`scores.view.${k}`) }))}
            />
          )}
        </Space>
      }
      styles={{ body: { padding: '8px 14px 10px', minHeight: 190 } }}
    >
      {results.length === 0 ? (
        <ChartEmpty
          text={t('chart.noExamData')}
          hint={t('chart.noExamDataHint')}
          action={{ label: t('chart.goExam'), onClick: () => navigate('/exam') }}
        />
      ) : variant === 'bars' ? (
        <>
          {renderBars()}
          {avg != null && <Text type="secondary" style={{ fontSize: 11 }}>{t('scores.avgHint')}</Text>}
        </>
      ) : variant === 'line' ? (
        <>
          {renderLine()}
          {avg != null && <Text type="secondary" style={{ fontSize: 11 }}>{t('scores.avgHint')}</Text>}
        </>
      ) : (
        renderProgress()
      )}
    </Card>
  )
}

export default ExamScoresCard
