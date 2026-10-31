/**
 * 学生近期考试成绩：每场一条「标题 + 得分率条 + 百分比」
 *
 * 原来用纵向柱状图：几个中文标题挤在 200px 内互相重叠、末尾被截断；换横向条形后，
 * recharts 在这个尺寸下条根本不渲染（只剩类目标签和均分虚线）。
 * 这个卡片要回答的问题只有一个——「最近几场考得怎么样、比平时高还是低」，
 * 用 4 行进度条比坐标轴更直接，窄屏也不会被压扁。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Card, Space, Tag, Tooltip, Typography } from 'antd'
import { FileAddOutlined } from '@ant-design/icons'
import type { DashboardSummary } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'

const { Text } = Typography

const ExamScoresCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
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

  return (
    <Card
      size="small"
      className="dash-card dash-fill-card dash-center-body"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <FileAddOutlined style={{ color: '#1677ff', fontSize: 14 }} />
          <Text style={{ fontSize: 14, fontWeight: 500 }}>{t('recentScores')}</Text>
        </Space>
      }
      extra={avg != null && (
        <Tag color={avg >= 60 ? 'green' : 'orange'} style={{ margin: 0 }}>
          {t('scores.avgRate', { v: avg })}
        </Tag>
      )}
      styles={{ body: { padding: '8px 14px 10px', minHeight: 190 } }}
    >
      {results.length > 0 ? (
        <div>
          {results.map((r) => (
            <Tooltip key={r.id} title={`${r.title} · ${r.score}/${r.total}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <Text ellipsis style={{ width: 76, flexShrink: 0, fontSize: 11, color: ct.tick }}>
                  {r.title}
                </Text>
                {/* 条背景 + 均分竖线：每行都标同一位置，连起来就是一条贯穿的参考线 */}
                <span style={{ position: 'relative', flex: 1, height: 8, borderRadius: 4, overflow: 'hidden', background: ct.track }}>
                  <span
                    className="dash-bar-fill"
                    style={{
                      display: 'block', height: '100%', width: `${r.rate}%`, borderRadius: 4,
                      background: r.passed ? ct.success : ct.warning,
                    }}
                  />
                  {avg != null && (
                    <span
                      aria-hidden
                      style={{
                        position: 'absolute', top: 0, bottom: 0,
                        left: `${Math.max(0, Math.min(100, avg))}%`,
                        width: 1.5, background: ct.gold, opacity: 0.9,
                      }}
                    />
                  )}
                </span>
                <strong style={{ width: 34, flexShrink: 0, textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                  {r.rate}%
                </strong>
              </div>
            </Tooltip>
          ))}
          {avg != null && (
            <Text type="secondary" style={{ fontSize: 11 }}>{t('scores.avgHint')}</Text>
          )}
        </div>
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
