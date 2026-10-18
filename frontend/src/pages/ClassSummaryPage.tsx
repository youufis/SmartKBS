/**
 * ClassSummaryPage — AI 课堂总结（独立页）
 *
 * 2026-10：统计范围改为「班级 + 时间窗 + 学科」；
 * 页面先展示数据快照，再按需生成 AI 报告；AI 失败/超时有明确提示；
 * 导出复用已生成报告，不再第二次调用模型。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, Button, Card, Col, Collapse, DatePicker, Empty, List,
  Row, Select, Space, Spin, Statistic, Tag, Typography, message,
} from 'antd'
import {
  BarChartOutlined, DownloadOutlined, RobotOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import FormulaRenderer from '../components/FormulaRenderer'
import apiClient from '../api/client'
import { pollAiTaskWithProgress } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { reportLoadError } from '../utils/loadError'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

interface SummaryStats {
  quiz_count?: number
  poll_count?: number
  question_count?: number
  discussion_count?: number
  student_count?: number
  class_student_count?: number
  participation_rate?: number
  avg_quiz_score?: number
  pending_question_count?: number
}

interface SummarySource {
  type: string
  id: number
  title: string
  created_at: string
  participants: number
}

async function downloadWord(url: string, filename: string) {
  const { data } = await apiClient.get(url, { responseType: 'blob', timeout: 300000 })
  const blob = new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
  const href = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.click()
  URL.revokeObjectURL(href)
}

async function exportError(e: any, fallback: string): Promise<string> {
  const data = e?.response?.data
  if (data instanceof Blob) {
    try {
      const text = await data.text()
      const parsed = JSON.parse(text)
      if (parsed?.detail) return String(parsed.detail)
    } catch { /* 非 JSON 错误体 */ }
  }
  return e?.response?.data?.detail || e?.message || fallback
}

const ClassSummaryPage: React.FC = () => {
  const { t } = useTranslation('system')
  const user = useAuthStore((s) => s.user)

  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [selectedGrade, setSelectedGrade] = useState<string>('')
  const [selectedClass, setSelectedClass] = useState<string>('')
  const [subjects, setSubjects] = useState<string[]>([])
  const [subject, setSubject] = useState('')
  const [range, setRange] = useState<[Dayjs, Dayjs]>([
    dayjs().startOf('day'),
    dayjs(),
  ])

  const [loading, setLoading] = useState(false)
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [summary, setSummary] = useState('')
  const [stats, setStats] = useState<SummaryStats | null>(null)
  const [sources, setSources] = useState<SummarySource[]>([])
  const [windowLabel, setWindowLabel] = useState('')
  const [reportId, setReportId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [emptyMsg, setEmptyMsg] = useState('')

  const rangeKey = useMemo(
    () => `${range?.[0]?.valueOf() || 0}-${range?.[1]?.valueOf() || 0}`,
    [range],
  )

  useEffect(() => {
    apiClient.get('/api/scores/my-grades')
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : []
        setGrades(list)
        if (list.length > 0) setSelectedGrade((prev) => prev || list[0])
      })
      .catch((err) => { reportLoadError(err, { key: 'classSummary.grades' }) })
    apiClient.get('/api/config/subjects')
      .then(({ data }) => setSubjects(Array.isArray(data?.subjects) ? data.subjects : []))
      .catch(() => setSubjects([]))
  }, [])

  useEffect(() => {
    setSelectedClass('')
    setClasses([])
    if (!selectedGrade) return
    apiClient.get('/api/scores/classes', {
      params: { grade: selectedGrade, teacher: user?.username || 'root' },
    })
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : []
        setClasses(list)
        if (list.length > 0) setSelectedClass((prev) => prev || list[0])
      })
      .catch((err) => { reportLoadError(err, { key: 'classSummary.classes' }) })
  }, [selectedGrade, user?.username])

  // 选择变化后旧报告必须立刻失效，避免新班级下还显示旧班总结
  useEffect(() => {
    setSummary('')
    setStats(null)
    setSources([])
    setReportId(null)
    setError('')
    setEmptyMsg('')
    setWindowLabel('')
  }, [selectedGrade, selectedClass, subject, rangeKey, user?.username])

  const snapshotSeq = useRef(0)
  const loadSnapshot = async () => {
    if (!selectedGrade || !selectedClass) return
    const seq = ++snapshotSeq.current
    setSnapshotLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/class-summary', {
        params: {
          grade: selectedGrade,
          cls: selectedClass,
          subject,
          teacher_username: user?.username,
          start: startText,
          end: endText,
          snapshot_only: 1,
        },
      })
      if (seq !== snapshotSeq.current) return
      setStats(data?.data || null)
      setSources(Array.isArray(data?.sources) ? data.sources : [])
      setWindowLabel(data?.window?.label || '')
      if (data?.empty) setEmptyMsg(data.message || t('classSummaryNoData'))
    } catch {
      // 快照失败不阻断 AI 生成，错误留给用户点击生成时提示
    } finally {
      if (seq === snapshotSeq.current) setSnapshotLoading(false)
    }
  }

  useEffect(() => {
    void loadSnapshot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedGrade, selectedClass, subject, rangeKey])

  const startText = range?.[0]?.format('YYYY-MM-DD 00:00:00') || ''
  const endText = range?.[1]?.format('YYYY-MM-DD 23:59:59') || ''

  const handleClassSummary = async () => {
    if (!selectedGrade || !selectedClass) {
      message.warning(t('classSummarySelectFirst'))
      return
    }
    setLoading(true)
    setError('')
    setEmptyMsg('')
    setSummary('')
    setReportId(null)
    try {
      const { data } = await apiClient.get('/api/interaction/class-summary', {
        params: {
          grade: selectedGrade,
          cls: selectedClass,
          subject,
          teacher_username: user?.username,
          start: startText,
          end: endText,
        },
      })
      setStats(data?.data || null)
      setSources(Array.isArray(data?.sources) ? data.sources : [])
      setWindowLabel(data?.window?.label || '')
      if (data?.empty) {
        setEmptyMsg(data.message || t('classSummaryNoData'))
        return
      }
      if (!data?.task_id) {
        setSummary(data?.summary || '')
        setReportId(data?.report_id || null)
        return
      }
      const state = await pollAiTaskWithProgress(data.task_id, undefined, 300000)
      const result: any = state.result || {}
      setSummary(result.summary || '')
      setReportId(result.report_id || null)
      if (result.data) setStats(result.data)
      if (Array.isArray(result.sources)) setSources(result.sources)
      if (result.window?.label) setWindowLabel(result.window.label)
    } catch (e: any) {
      if (e?.aiTaskTimeout) {
        setError(t('classSummaryStillRunning'))
        message.warning(t('classSummaryStillRunning'))
      } else {
        const msg = e?.response?.data?.detail || e?.message || t('generateSummaryFailed')
        setError(msg)
        message.error(msg)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleExport = async () => {
    if (!summary) {
      message.warning(t('classSummaryReportNotReady'))
      return
    }
    setExporting(true)
    try {
      const params = new URLSearchParams({
        grade: selectedGrade,
        cls: selectedClass,
        subject,
        teacher_username: user?.username || '',
        start: startText,
        end: endText,
      })
      // 旧后端不返回 report_id；此时退回旧导出入口（会重新生成），
      // 新后端有 report_id 时走缓存，避免二次调用模型。
      if (reportId) params.set('report_id', String(reportId))
      await downloadWord(
        `/api/interaction/class-summary/export?${params.toString()}`,
        `课堂总结_${selectedGrade}${selectedClass}.docx`,
      )
    } catch (e: any) {
      message.error(await exportError(e, t('classSummaryExportFailed')))
    } finally {
      setExporting(false)
    }
  }

  const sourceLabel: Record<string, string> = {
    quiz: t('classSummarySourceQuiz'),
    poll: t('classSummarySourcePoll'),
    question: t('classSummarySourceQuestion'),
    discussion: t('classSummarySourceDiscussion'),
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <RobotOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>{t('aiClassSummary')}</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              {t('classSummaryDesc')}
            </Text>
          </Space>
        </div>
      </Card>

      <Card>
        <Space wrap style={{ marginBottom: 16 }}>
          <Select
            placeholder={t('selectGrade')}
            value={selectedGrade || undefined}
            onChange={setSelectedGrade}
            style={{ width: 130 }}
            options={grades.map((g) => ({ value: g, label: g }))}
          />
          <Select
            placeholder={t('selectClass')}
            value={selectedClass || undefined}
            onChange={setSelectedClass}
            style={{ width: 130 }}
            disabled={!selectedGrade || classes.length === 0}
            options={classes.map((c) => ({ value: c, label: c }))}
          />
          <Select
            placeholder={t('allSubjects')}
            value={subject || undefined}
            onChange={(v) => setSubject(v || '')}
            allowClear
            style={{ width: 130 }}
            options={subjects.map((s) => ({ value: s, label: s }))}
          />
          <RangePicker
            value={range}
            onChange={(v) => {
              if (v?.[0] && v?.[1]) setRange([v[0], v[1]])
            }}
            allowClear={false}
            presets={[
              { label: t('classSummaryToday'), value: [dayjs().startOf('day'), dayjs()] },
              { label: t('classSummaryLast7Days'), value: [dayjs().subtract(6, 'day').startOf('day'), dayjs()] },
              { label: t('classSummaryLast30Days'), value: [dayjs().subtract(29, 'day').startOf('day'), dayjs()] },
            ]}
          />
          <Button
            type="primary"
            icon={<RobotOutlined />}
            onClick={handleClassSummary}
            loading={loading}
            disabled={!selectedGrade || !selectedClass}
          >
            {t('aiClassSummary')}
          </Button>
          <Button
            icon={<DownloadOutlined />}
            onClick={handleExport}
            loading={exporting}
            disabled={!summary}
            title={!summary ? t('classSummaryReportNotReady') : undefined}
          >
            {t('exportWord')}
          </Button>
        </Space>

        <Space wrap style={{ marginBottom: 12 }}>
          <Tag icon={<BarChartOutlined />}>
            {windowLabel || `${range[0].format('YYYY-MM-DD HH:mm')} ~ ${range[1].format('YYYY-MM-DD HH:mm')}`}
          </Tag>
          {subject ? <Tag color="blue">{subject}</Tag> : <Tag>{t('allSubjects')}</Tag>}
        </Space>

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        {emptyMsg && <Alert type="info" showIcon message={emptyMsg} style={{ marginBottom: 12 }} />}

        {(loading || snapshotLoading) && !stats && (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin size="large" />
            <div style={{ marginTop: 12, color: 'var(--text-tertiary)' }}>{t('classSummaryAnalyzing')}</div>
          </div>
        )}

        {stats && (
          <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
            <Col xs={12} sm={8} md={6} lg={4}><Statistic title={t('quizCount')} value={stats.quiz_count || 0} /></Col>
            <Col xs={12} sm={8} md={6} lg={4}><Statistic title={t('pollCount')} value={stats.poll_count || 0} /></Col>
            <Col xs={12} sm={8} md={6} lg={4}><Statistic title={t('questionCount')} value={stats.question_count || 0} /></Col>
            <Col xs={12} sm={8} md={6} lg={4}><Statistic title={t('classSummaryDiscussionCount')} value={stats.discussion_count || 0} /></Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Statistic
                title={t('classSummaryStudents')}
                value={stats.student_count || 0}
                suffix={`/ ${stats.class_student_count || 0}`}
              />
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Statistic title={t('classSummaryParticipationRate')} value={stats.participation_rate || 0} suffix="%" />
            </Col>
          </Row>
        )}

        {summary && (
          <Card style={{ background: '#f6ffed', border: '1px solid #b7eb8f', marginBottom: 12 }}>
            <div className="markdown-content">
              <FormulaRenderer content={summary} />
            </div>
          </Card>
        )}

        {sources.length > 0 && (
          <Collapse
            size="small"
            items={[{
              key: 'sources',
              label: t('classSummaryDataSources', { count: sources.length }),
              children: (
                <List
                  size="small"
                  dataSource={sources}
                  renderItem={(s) => (
                    <List.Item>
                      <Space wrap>
                        <Tag color="blue">{sourceLabel[s.type] || s.type}</Tag>
                        <Text>{s.title}</Text>
                        <Text type="secondary">{s.created_at}</Text>
                        <Text type="secondary">{t('classSummaryParticipants', { count: s.participants })}</Text>
                      </Space>
                    </List.Item>
                  )}
                />
              ),
            }]}
          />
        )}

        {!stats && !loading && !snapshotLoading && !error && !emptyMsg && (
          <Empty description={t('classSummaryEmpty')} />
        )}
      </Card>
    </Card>
  )
}

export default ClassSummaryPage
