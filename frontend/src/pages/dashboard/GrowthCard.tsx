/** 学生成长档案：称号进度 + 徽章墙 + 学科称号 + 错题复习 CTA */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Progress, Space, Tag, Tooltip, Typography } from 'antd'
import { RightOutlined } from '@ant-design/icons'
import { getSubjectTitles, type DashboardSummary, type SubjectTitle } from '../../api/dashboard'
import { useChartTheme } from './chartTheme'
import { reportLoadError } from '../../utils/loadError'

const { Text } = Typography

const GrowthCard: React.FC<{ summary: DashboardSummary }> = ({ summary }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const [subjects, setSubjects] = useState<SubjectTitle[]>([])

  useEffect(() => {
    let cancelled = false
    getSubjectTitles().then((d) => {
      // 只保留真正答过题的学科：入门(level=1) 是零题量的兜底档，列出来反而像“白送的称号”
      if (!cancelled && Array.isArray(d)) setSubjects(d.filter((s) => (s.question_count ?? 0) > 0))
    }).catch((err) => { if (!cancelled) reportLoadError(err, { key: 'dashboard.GrowthCard' }) })
    return () => { cancelled = true }
  }, [])

  const practiceDone = summary.completed_practice_count ?? 0
  const practiceAll = practiceDone + (summary.pending_practice_count ?? 0)
  const mastery = [
    (summary.wrong_book_total ?? 0) > 0 && {
      label: t('growth.mWrong'), pct: Math.round(((summary.wrong_book_mastered ?? 0) / (summary.wrong_book_total ?? 1)) * 100), color: '#52c41a',
    },
    practiceAll > 0 && { label: t('growth.mPractice'), pct: Math.round((practiceDone / practiceAll) * 100), color: '#1677ff' },
    (summary.course_practice_count ?? 0) > 0 && {
      label: t('growth.mCourse'), pct: Math.max(0, Math.min(100, Math.round(summary.course_practice_avg_accuracy ?? 0))), color: '#722ed1',
    },
  ].filter(Boolean) as { label: string; pct: number; color: string }[]
  const questTimes = summary.quest_completed_count ?? 0
  const quizTimes = summary.quick_quiz_participated ?? 0
  const practiceTimes = practiceDone
  const badgesHint = `${t('growth.badges')}: ${summary.badges_unlocked ?? 0}/${summary.badges_total ?? 0}`

  return (
    <Card
      size="small"
      className="dash-card"
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

      {/* 掌握度：两个比率条 + 一行参与计数。原来这三类活动是三个孤立数字，
          放在一起才能看出"哪一类做得多、哪一类掌握得差" */}
      {mastery.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('growth.mastery')}：</Text>
          <div className="dash-stagger" style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {mastery.map((m) => (
              <div key={m.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ width: 60, flexShrink: 0, color: ct.tick, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label}</span>
                <span
                  style={{
                    flex: 1, height: 6, borderRadius: 3, overflow: 'hidden',
                    background: ct.isDark ? 'rgba(255,255,255,0.10)' : '#f0f0f0',
                  }}
                >
                  <span
                    className="dash-bar-fill"
                    style={{ display: 'block', height: '100%', width: `${m.pct}%`, background: m.color }}
                  />
                </span>
                <strong style={{ width: 38, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.pct}%</strong>
              </div>
            ))}
          </div>
          <Text type="secondary" style={{ fontSize: 11 }}>{t('growth.joined', { quest: questTimes, quiz: quizTimes, practice: practiceTimes })}</Text>
        </div>
      )}
      {/* 学科称号 */}
      {subjects.length === 0 && (
        <div style={{ marginBottom: 10 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('growth.subjectNone')}</Text>
        </div>
      )}
      {subjects.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('growth.subjectTitles')}：</Text>
          <Space size={4} wrap style={{ marginTop: 2 }}>
            {subjects.slice(0, 5).map((s) => (
              <Tooltip
                key={s.subject}
                title={`${s.emoji || ''} ${s.subject} · ${t('growth.answered', { count: s.question_count ?? 0 })} · ${s.name}`}
              >
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
