/** 学生成长档案：称号进度 + 徽章墙 + 学科称号 + 错题复习 CTA */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Progress, Space, Tag, Tooltip, Typography } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import { getSubjectTitles, type DashboardSummary, type SubjectTitle } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'

const { Text } = Typography

const GrowthCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const [subjects, setSubjects] = useState<SubjectTitle[]>([])

  useEffect(() => {
    let cancelled = false
    getSubjectTitles().then((d) => {
      if (!cancelled && Array.isArray(d)) setSubjects(d.filter((s) => s.level > 0))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const badgesHint = `${t('growth.badges')}: ${summary.badges_unlocked ?? 0}/${summary.badges_total ?? 0}`

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={
        <Space size={6}>
          <span>🌱</span>
          <span style={{ fontSize: 13 }}>{t('growth.title')}</span>
        </Space>
      }
      extra={
        <Button type="link" size="small" onClick={() => navigate('/score')}>
          {t('viewAll')} <RightOutlined />
        </Button>
      }
      styles={{ body: { padding: '10px 16px 12px' } }}
    >
      {/* 称号进度 */}
      <div style={{ marginBottom: 10 }}>
        <Space size={6} style={{ marginBottom: 2 }}>
          <Text style={{ fontSize: 16 }}>{summary.title_emoji || '🏅'}</Text>
          <Text strong style={{ fontSize: 13 }}>
            {summary.title_name || '-'} <Text type="secondary" style={{ fontSize: 11 }}>Lv.{summary.title_level ?? 0}</Text>
          </Text>
        </Space>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Progress percent={summary.title_progress ?? 0} size="small" style={{ flex: 1, margin: 0 }} showInfo={false} />
          <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            {summary.next_title_name
              ? t('growth.nextTitle', { name: summary.next_title_name })
              : t('growth.maxTitle')}
          </Text>
        </div>
      </div>

      {/* 徽章 */}
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Tag color="gold" style={{ margin: 0, fontSize: 12 }}>🏆 {badgesHint}</Tag>
        <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} onClick={() => navigate('/score')}>
          {t('growth.badgeWall')} <RightOutlined style={{ fontSize: 10 }} />
        </Button>
      </div>

      {/* 学科称号 */}
      {subjects.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('growth.subjectTitles')}：</Text>
          <Space size={4} wrap style={{ marginTop: 2 }}>
            {subjects.slice(0, 5).map((s) => (
              <Tooltip key={s.subject} title={`${s.name} · ${s.question_count}`}>
                <Tag color="geekblue" style={{ margin: 0, fontSize: 11 }}>{s.subject}</Tag>
              </Tooltip>
            ))}
          </Space>
        </div>
      )}

      {/* 错题复习 CTA */}
      <div
        style={{
          borderRadius: 8, padding: '8px 12px', cursor: 'pointer',
          background: (summary.wrong_book_pending ?? 0) > 0 ? 'rgba(255,77,79,0.08)' : ct.isDark ? 'rgba(255,255,255,0.04)' : '#f6ffed',
          border: `1px solid ${(summary.wrong_book_pending ?? 0) > 0 ? 'rgba(255,77,79,0.3)' : ct.isDark ? '#2e3038' : '#b7eb8f'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}
        onClick={() => navigate('/wrong-book')}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            {(summary.wrong_book_pending ?? 0) > 0
              ? `📕 ${t('growth.wrongCta', { n: summary.wrong_book_pending })}`
              : `✅ ${t('growth.wrongClear')}`}
          </div>
          {(summary.wrong_book_mastered ?? 0) > 0 && (
            <Text type="secondary" style={{ fontSize: 11 }}>{t('growth.wrongMastered', { n: summary.wrong_book_mastered })}</Text>
          )}
        </div>
        <Button size="small" type={(summary.wrong_book_pending ?? 0) > 0 ? 'primary' : 'default'} danger={(summary.wrong_book_pending ?? 0) > 0}>
          {t('growth.review')}
        </Button>
      </div>
    </Card>
  )
}

export default GrowthCard
