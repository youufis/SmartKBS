import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert, Button, Card, Checkbox, DatePicker, Drawer, Empty,
  Pagination, Popconfirm, Progress, Segmented, Select, Skeleton, Space, Spin,
  Statistic, Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  ArrowDownOutlined, ArrowUpOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined,
  FileTextOutlined, FilterOutlined, HistoryOutlined, LeftOutlined,
  ReloadOutlined, RightOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip as RechartsTooltip, XAxis, YAxis,
} from 'recharts'
import dayjs, { type Dayjs } from 'dayjs'
import PageHeader from '../components/PageHeader'
import { useIsMobile } from '../hooks/useIsMobile'
import { message } from '../utils/feedback'
import { useAuthStore } from '../stores/authStore'
import * as api from '../api/briefing'
import type {
  BriefingFilter, BriefingJob, BriefingMetrics, BriefingPeriod, BriefingPreview,
  BriefingReport, BriefingSection,
} from '../api/briefing'

const { Text, Paragraph } = Typography

const PERIODS = ['week', 'month', 'year'] as const

const SEVERITY_COLOR: Record<string, string> = {
  info: 'var(--border-color)',
  warning: 'var(--warning-color, #faad14)',
  good: 'var(--success-color, #52c41a)',
}

const shortRange = (start: string, end: string) => {
  const s = (start || '').slice(5, 10).replace('-', '.')
  const e = (end || '').slice(5, 10).replace('-', '.')
  return s && e ? `${s}–${e}` : (start || '').slice(0, 10)
}

const deltaColor = (delta: number) => (
  delta > 0 ? 'var(--success-color, #52c41a)'
    : delta < 0 ? 'var(--danger-color, #ff4d4f)'
      : 'var(--text-secondary)'
)

const errorText = (e: any, fallback: string) => {
  const detail = e?.response?.data?.detail
  return typeof detail === 'string' && detail.trim() ? detail : fallback
}

const reportPeriodText = (report: BriefingReport, t: (k: string, o?: any) => string) => (
  `${report.period_start.slice(0, 10)} ~ ${report.period_end.slice(0, 10)} · ${t(`period.${report.period_type}`)}`
)

const BriefingPage: React.FC = () => {
  const { t } = useTranslation('briefing')
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin'
  const isMobile = useIsMobile()

  const [options, setOptions] = useState<api.BriefingOptions | null>(null)
  const [periodType, setPeriodType] = useState<string>('week')
  const [anchor, setAnchor] = useState<Dayjs | null>(null)
  const [subjects, setSubjects] = useState<string[]>([])
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [teacher, setTeacher] = useState<string>('')

  const [report, setReport] = useState<BriefingReport | null>(null)
  const [preview, setPreview] = useState<BriefingPreview | null>(null)
  const [periodInfo, setPeriodInfo] = useState<BriefingPeriod | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [job, setJob] = useState<BriefingJob | null>(null)
  const [exporting, setExporting] = useState(false)
  const [viewingHistory, setViewingHistory] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<any[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyPage, setHistoryPage] = useState(1)
  const [historyType, setHistoryType] = useState('all')
  const [historyLoading, setHistoryLoading] = useState(false)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [versions, setVersions] = useState<{ id: number; version: number }[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [yearMode, setYearMode] = useState('school_year')
  const timerRef = useRef<number | null>(null)
  const reqSeq = useRef(0)
  const versionsSeq = useRef(0)
  const historySeq = useRef(0)
  const optionsSeq = useRef(0)

  const filters: BriefingFilter = useMemo(() => ({
    period_type: periodType,
    year_mode: yearMode,
    anchor: anchor ? anchor.format('YYYY-MM-DD') : '',
    subject: subjects.join(','),
    grade: grades.join(','),
    class: classes.join(','),
    teacher,
  }), [periodType, yearMode, anchor, subjects, grades, classes, teacher])

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const applyDetail = useCallback((detail: BriefingReport, fromHistory = false) => {
    setReport(detail)
    setPreview(null)
    setLoadError('')
    setViewingHistory(fromHistory)
    try {
      // 同一快照的多个版本共享动作勾选进度
      setChecked(JSON.parse(localStorage.getItem(`briefing_actions_${detail.snapshot_id}`) || '{}'))
    } catch { setChecked({}) }
    const seq = ++versionsSeq.current
    api.getVersions(detail.id)
      .then(items => { if (seq === versionsSeq.current) setVersions(items) })
      .catch(() => { if (seq === versionsSeq.current) setVersions([]) })
  }, [])

  const loadDetail = useCallback(async (id: number, fromHistory = false) => {
    const seq = ++reqSeq.current
    setLoading(true)
    try {
      const detail = await api.getDetail(id)
      if (seq !== reqSeq.current) return
      applyDetail(detail, fromHistory)
    } catch (e: any) {
      if (seq !== reqSeq.current) return
      const text = errorText(e, t('error.load'))
      setLoadError(text)
      message.error(text)
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [applyDetail, t])

  const loadCurrent = useCallback(async () => {
    // 快速切筛选时旧请求可能后到，用序号丢弃过期响应
    const seq = ++reqSeq.current
    setLoading(true)
    setLoadError('')
    setViewingHistory(false)
    clearTimer()
    setJob(null)
    try {
      const latest = await api.getLatest(filters)
      if (seq !== reqSeq.current) return
      if (latest.period) setPeriodInfo(latest.period)
      if (latest.exists && latest.report?.id) {
        const detail = await api.getDetail(latest.report.id)
        if (seq !== reqSeq.current) return
        applyDetail(detail, false)
      } else {
        const previewData = await api.getPreview(filters)
        if (seq !== reqSeq.current) return
        setReport(null)
        setPreview(previewData)
        setPeriodInfo(previewData.period)
      }
    } catch (e: any) {
      if (seq !== reqSeq.current) return
      const text = errorText(e, t('error.load'))
      setReport(null)
      setPreview(null)
      setLoadError(text)
      message.error(text)
    } finally {
      if (seq === reqSeq.current) setLoading(false)
    }
  }, [filters, applyDetail, clearTimer, t])

  const fetchOptions = useCallback(async (teacherValue = '') => {
    const seq = ++optionsSeq.current
    try {
      const o = await api.getOptions(teacherValue)
      if (seq !== optionsSeq.current) return
      setOptions(o)
      if (o.year_mode) setYearMode(o.year_mode)
    } catch { /* 选项读不到时保留当前可选值 */ }
  }, [])

  useEffect(() => {
    fetchOptions()
  }, [fetchOptions])

  const changeTeacher = async (value?: string) => {
    const next = value || ''
    setTeacher(next)
    setGrades([])
    setClasses([])
    setSubjects([])
    // 管理员的年级/班级/学科选项跟随所选教师收敛，避免拼出越权组合
    await fetchOptions(next)
  }

  const resetFilters = () => {
    setSubjects([])
    setGrades([])
    setClasses([])
    setTeacher('')
    setAnchor(null)
  }

  const changePeriodType = (value: string) => {
    if (viewingHistory) {
      setViewingHistory(false)
      if (value === periodType) {
        loadCurrent()
        return
      }
    }
    setPeriodType(value)
  }

  const backToCurrent = () => {
    setViewingHistory(false)
    loadCurrent()
  }

  useEffect(() => { loadCurrent() }, [loadCurrent])

  useEffect(() => () => clearTimer(), [clearTimer])

  const pollJob = useCallback((jobId: string, fromHistory = false) => {
    clearTimer()
    const startedAt = Date.now()
    timerRef.current = window.setInterval(async () => {
      if (Date.now() - startedAt > 180_000) {
        clearTimer()
        setJob(null)
        message.info(t('job.stillRunning'))
        return
      }
      try {
        const j = await api.getJob(jobId)
        setJob(j)
        if (j.status === 'done' && j.report_id) {
          clearTimer()
          await loadDetail(j.report_id, fromHistory)
          setJob(null)
        } else if (j.status === 'failed') {
          clearTimer()
          setJob(null)
          message.error(j.error || t('error.generate'))
        } else if (j.status === 'empty') {
          clearTimer()
          setJob(null)
          message.info(t('status.empty'))
          if (fromHistory && j.report_id) {
            await loadDetail(j.report_id, true)
          } else {
            await loadCurrent()
          }
        }
      } catch {
        clearTimer()
        setJob(null)
        message.error(t('error.generate'))
      }
    }, 1200)
  }, [clearTimer, loadDetail, loadCurrent, t])

  const generate = async (force: boolean) => {
    if (job) return
    if (!force && preview?.is_empty) {
      message.info(t('preview.noDataTitle'))
      return
    }
    setJob({ id: '', status: 'pending', progress: 5, stage: t('job.start') } as BriefingJob)
    try {
      const res = await api.generate({ ...filters, force })
      if (res.existed && res.report_id) {
        await loadDetail(res.report_id, false)
        setJob(null)
        return
      }
      if (res.job_id) pollJob(res.job_id, false)
    } catch (e: any) {
      setJob(null)
      message.error(errorText(e, t('error.generate')))
    }
  }

  const regenerateReport = async (reportId: number) => {
    if (job) return
    setJob({ id: '', status: 'pending', progress: 5, stage: t('job.start') } as BriefingJob)
    try {
      const res = await api.regenerate(reportId)
      if (res.job_id) pollJob(res.job_id, viewingHistory)
    } catch (e: any) {
      setJob(null)
      message.error(errorText(e, t('error.generate')))
    }
  }

  const onExport = async () => {
    if (!report || report.status === 'empty') return
    setExporting(true)
    try {
      const res = await api.exportWord(report.id)
      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `教学简报_${report.period_start.slice(0, 10)}.docx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      message.error(errorText(e, t('error.export')))
    } finally {
      setExporting(false)
    }
  }

  const loadHistory = async (page: number, type = historyType) => {
    const seq = ++historySeq.current
    setHistoryLoading(true)
    try {
      // 历史不按当前周期过滤：列表本身就带周期标签，按月报/周报混排更好找
      const res = await api.listReports({
        page, size: 10, type: type && type !== 'all' ? type : undefined,
      })
      if (seq !== historySeq.current) return
      setHistory(res.items || [])
      setHistoryTotal(res.total || 0)
      setHistoryPage(page)
    } catch (e: any) {
      if (seq !== historySeq.current) return
      setHistory([])
      setHistoryTotal(0)
      message.error(errorText(e, t('error.load')))
    } finally {
      if (seq === historySeq.current) setHistoryLoading(false)
    }
  }

  const openHistory = async () => {
    setHistoryOpen(true)
    await loadHistory(1, historyType)
  }

  const removeHistory = async (item: any) => {
    try {
      await api.deleteReport(item.id)
      message.success(t('history.deleted'))
      if (report?.snapshot_id === item.snapshot_id) await loadCurrent()
      const nextPage = history.length === 1 && historyPage > 1 ? historyPage - 1 : historyPage
      await loadHistory(nextPage, historyType)
    } catch (e: any) {
      message.error(errorText(e, t('history.deleteFailed')))
    }
  }

  const toggleAction = (key: string) => {
    if (!report) return
    const next = { ...checked, [key]: !checked[key] }
    setChecked(next)
    try {
      localStorage.setItem(`briefing_actions_${report.snapshot_id}`, JSON.stringify(next))
    } catch { /* 隐私模式/配额满时仅保留本次会话勾选 */ }
  }

  const shiftPeriod = (dir: number) => {
    const base = anchor ?? dayjs()
    const unit = periodType === 'day' ? 'day' : periodType === 'week' ? 'week'
      : periodType === 'month' ? 'month' : 'year'
    setAnchor(base.add(dir, unit))
  }

  const buildShareText = () => {
    if (!report) return ''
    const lines: string[] = [report.headline, '']
    const s1 = report.sections.find(x => x.key === 'S1')
    ;(s1?.bullets || []).slice(0, 5).forEach(b => lines.push(`· ${b}`))
    const s9 = report.sections.find(x => x.key === 'S9')
    if (s9?.actions?.length) {
      lines.push('', t('share.next'))
      s9.actions.slice(0, 3).forEach(a => lines.push(`· ${a.text}`))
    }
    lines.push('', `${report.period_start.slice(0, 10)} ~ ${report.period_end.slice(0, 10)} · ${report.filter_label}`)
    return lines.join('\n')
  }

  const copySummary = async () => {
    const text = buildShareText()
    if (!text) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      message.success(t('share.copied'))
    } catch {
      message.error(t('share.failed'))
    }
  }

  const classOptions = useMemo(() => {
    const all = options?.classes || []
    return (grades.length ? all.filter(c => grades.includes(c.grade)) : all)
      .map(c => ({ value: c.name, label: c.name }))
  }, [options, grades])

  const metrics = (report?.metrics || {}) as BriefingMetrics
  const learning = (metrics.learning || {}) as NonNullable<BriefingMetrics['learning']>
  const participation = (metrics.participation || {}) as NonNullable<BriefingMetrics['participation']>
  const tasks = (metrics.tasks || {}) as NonNullable<BriefingMetrics['tasks']>
  const alerts = (metrics.alerts || []) as NonNullable<BriefingMetrics['alerts']>
  const isEmptyReport = !!report && (report.status === 'empty' || !!metrics.is_empty)
  const busy = loading || !!job
  const currentFilterLabel = report?.filter_label || preview?.scope?.filter_label || ''
  const periodText = report ? reportPeriodText(report, t) : (periodInfo?.label || t('subtitle'))

  const statusTag = report ? (
    report.status === 'empty'
      ? <Tag>{t('status.empty')}</Tag>
      : report.status === 'degraded'
        ? <Tag color="orange">{t('status.degraded')}</Tag>
        : <Tag color="green">{t('status.done')}</Tag>
  ) : preview ? <Tag>{t('status.notGenerated')}</Tag> : null

  const filterBar = (
    <Space wrap size={10}>
      <Segmented
        value={viewingHistory && report ? report.period_type : periodType}
        onChange={v => changePeriodType(String(v))}
        options={PERIODS.map(p => ({ value: p, label: t(`period.${p}`) }))}
      />
      <Space.Compact>
        <Button icon={<LeftOutlined />} aria-label={t('filter.prev')} onClick={() => shiftPeriod(-1)} />
        <DatePicker
          value={anchor}
          onChange={setAnchor}
          allowClear
          placeholder={t('filter.current')}
          style={{ width: 132 }}
        />
        <Button icon={<RightOutlined />} aria-label={t('filter.next')} onClick={() => shiftPeriod(1)} />
      </Space.Compact>
      {isAdmin && (
        <Select
          allowClear showSearch optionFilterProp="label"
          style={{ minWidth: 150 }} placeholder={t('filter.teacher')}
          value={teacher || undefined}
          onChange={changeTeacher}
          options={(options?.teachers || []).map(x => ({ value: x.username, label: `${x.name}（${x.username}）` }))}
        />
      )}
      <Select
        mode="multiple" allowClear maxTagCount="responsive"
        style={{ minWidth: 130 }} placeholder={t('filter.subject')}
        value={subjects} onChange={setSubjects}
        options={(options?.subjects || []).map(s => ({ value: s, label: s }))}
      />
      <Select
        mode="multiple" allowClear maxTagCount="responsive"
        style={{ minWidth: 120 }} placeholder={t('filter.grade')}
        value={grades}
        onChange={v => { setGrades(v); setClasses([]) }}
        options={(options?.grades || []).map(g => ({ value: g, label: g }))}
      />
      <Select
        mode="multiple" allowClear maxTagCount="responsive"
        style={{ minWidth: 150 }} placeholder={t('filter.class')}
        value={classes} onChange={setClasses}
        options={classOptions}
      />
    </Space>
  )

  return (
    <div>
      <PageHeader
        icon={<FileTextOutlined />}
        title={t('title')}
        subtitle={
          <Space size={8} wrap>
            <span>{periodText}</span>
            {currentFilterLabel && !isMobile && <Text type="secondary">{currentFilterLabel}</Text>}
            {statusTag}
          </Space>
        }
        extra={isMobile ? (
          <Space size={6}>
            <Button
              size="small" icon={<CopyOutlined />}
              disabled={!report || isEmptyReport || busy} onClick={copySummary}
            >
              {t('action.copy')}
            </Button>
            <Button size="small" icon={<HistoryOutlined />} onClick={openHistory}>{t('action.history')}</Button>
          </Space>
        ) : (
          <Space wrap size={8}>
            <Button icon={<HistoryOutlined />} onClick={openHistory}>{t('action.history')}</Button>
            <Button
              icon={<CopyOutlined />} disabled={!report || isEmptyReport || busy}
              onClick={copySummary}
            >
              {t('action.copy')}
            </Button>
            <Button icon={<ReloadOutlined />} disabled={busy} onClick={loadCurrent}>
              {t('action.refresh')}
            </Button>
            {report && (
              <Button
                icon={<DownloadOutlined />} loading={exporting}
                disabled={isEmptyReport || busy} onClick={onExport}
              >
                {t('action.export')}
              </Button>
            )}
            <Button
              type="primary" icon={<ThunderboltOutlined />}
              loading={!!job}
              disabled={loading || (!report && (!preview || preview.is_empty))}
              onClick={() => (report ? regenerateReport(report.id) : generate(false))}
            >
              {report ? t('action.regenerate') : t('action.generate')}
            </Button>
          </Space>
        )}
      >
        {isMobile ? (
          <Space wrap size={8} style={{ width: '100%' }}>
            <Segmented
              size="small"
              value={viewingHistory && report ? report.period_type : periodType}
              onChange={v => changePeriodType(String(v))}
              options={PERIODS.map(p => ({ value: p, label: t(`period.${p}`) }))}
            />
            <Button size="small" icon={<FilterOutlined />} onClick={() => setFilterOpen(true)}>
              {t('filter.title')}
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>{currentFilterLabel || t('filter.current')}</Text>
          </Space>
        ) : filterBar}
      </PageHeader>

      {loadError && !report && (
        <Card style={{ marginBottom: 16 }}>
          <Alert
            type="error"
            showIcon
            message={t('error.load')}
            description={loadError}
            action={(
              <Space>
                <Button size="small" onClick={loadCurrent}>{t('error.retry')}</Button>
                <Button size="small" onClick={resetFilters}>{t('error.clearFilters')}</Button>
              </Space>
            )}
          />
        </Card>
      )}

      {loadError && report && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message={loadError}
          onClose={() => setLoadError('')}
        />
      )}

      {viewingHistory && report && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('history.viewing', {
            period: reportPeriodText(report, t),
            scope: report.filter_label || currentFilterLabel || '—',
          })}
          action={<Button size="small" onClick={backToCurrent}>{t('history.back')}</Button>}
        />
      )}

      {job && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Space style={{ width: '100%' }} orientation="vertical" size={4}>
            <Space>
              <ReloadOutlined spin />
              <Text>{job.stage || t('status.generating')}</Text>
              <Text type="secondary">{t('job.hint')}</Text>
            </Space>
            <Progress percent={job.progress || 5} size="small" />
          </Space>
        </Card>
      )}

      {loading && !report && <Skeleton active paragraph={{ rows: 10 }} />}

      {!loading && !report && preview && (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space orientation="vertical" size={4}>
                <Text strong>{preview.is_empty ? t('preview.noDataTitle') : t('preview.title')}</Text>
                <Text type="secondary">
                  {preview.is_empty
                    ? t('preview.noDataDesc')
                    : isMobile
                      ? t('preview.mobileHint')
                      : t('preview.desc', {
                        activities: preview.summary?.activity_total ?? 0,
                        samples: preview.summary?.samples ?? 0,
                      })}
                </Text>
              </Space>
            }
          >
            <Space wrap size={24} style={{ justifyContent: 'center' }}>
              <Statistic title={t('kpi.activities')} value={preview.summary?.activity_total ?? 0} suffix={t('unit.items')} />
              <Statistic title={t('kpi.samples')} value={preview.summary?.samples ?? 0} suffix={t('unit.times')} />
              <Statistic title={t('kpi.avgRate')} value={preview.summary?.avg_rate ?? '—'} suffix={preview.summary?.avg_rate != null ? '%' : ''} />
              <Statistic title={t('kpi.praise')} value={preview.summary?.praise_count ?? 0} suffix={t('unit.people')} />
            </Space>
          </Empty>
        </Card>
      )}

      {report && (
        <>
          <Space wrap size={8} style={{ marginBottom: 12 }}>
            <Tag>{t(`period.${report.period_type}`)}</Tag>
            {report.filter_label && (
              <Text type="secondary" style={{ fontSize: 12 }}>{report.filter_label}</Text>
            )}
            {report.created_at && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('report.generatedAt', { time: report.created_at.slice(5, 16) })}
              </Text>
            )}
            {versions.length > 1 && (
              <Tooltip title={t('version.hint')}>
                <Select
                  size="small" style={{ width: 108 }} value={report.id}
                  onChange={(id: number) => loadDetail(id, viewingHistory)}
                  options={versions.map(v => ({
                    value: v.id,
                    label: t('version.label', { n: v.version }),
                  }))}
                />
              </Tooltip>
            )}
          </Space>

          {isEmptyReport ? (
            <Card>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={(
                  <Space orientation="vertical" size={4}>
                    <Text strong>{t('emptyReport.title')}</Text>
                    <Text type="secondary">{t('emptyReport.desc')}</Text>
                  </Space>
                )}
              >
                {viewingHistory && (
                  <Button onClick={backToCurrent}>{t('history.back')}</Button>
                )}
              </Empty>
            </Card>
          ) : (
            <Spin spinning={loading} tip={t('status.loading')}>
              <div>
                <div style={{
                  display: 'grid', gap: 12, marginBottom: 16,
                  gridTemplateColumns: isMobile
                    ? 'repeat(2, minmax(0,1fr))'
                    : 'repeat(auto-fit, minmax(150px, 1fr))',
                }}>
                  <Kpi
                    title={t('kpi.avgRate')}
                    value={learning.avg_rate} suffix="%"
                    delta={learning.delta}
                    hint={!learning.enough_sample ? t('kpi.sampleShort') : ''}
                  />
                  <Kpi title={t('kpi.participation')} value={participation.rate} suffix="%" />
                  <Kpi title={t('kpi.activities')} value={metrics.activity?.total ?? 0} suffix={t('unit.items')} />
                  <Kpi title={t('kpi.pending')} value={tasks.pending_grading ?? 0} suffix={t('unit.copies')} />
                  <div style={{ gridColumn: isMobile ? 'span 2' : undefined }}>
                    <Kpi title={t('kpi.alerts')} value={alerts.length} suffix={t('unit.people')} />
                  </div>
                </div>

                <Card size="small" style={{ marginBottom: 16 }} styles={{ body: { padding: '10px 14px' } }}>
                  <Space size={isMobile ? 10 : 28} orientation={isMobile ? 'vertical' : 'horizontal'} wrap>
                    <Text type="secondary" style={{ fontSize: 12 }}>{t('compare.title')}</Text>
                    {[
                      { label: t('kpi.activities'), cur: metrics.activity?.total, prev: (metrics as any).prev_summary?.activity_total, unit: t('unit.items') },
                      { label: t('kpi.avgRate'), cur: learning.avg_rate, prev: (metrics as any).prev_summary?.avg_rate, unit: '%' },
                      { label: t('kpi.participation'), cur: participation.rate, prev: (metrics as any).prev_summary?.participation_rate, unit: '%' },
                    ].map((row, i) => {
                      const delta = row.cur != null && row.prev != null
                        ? Math.round((row.cur - row.prev) * 10) / 10 : null
                      return (
                        <span key={i} style={{ fontSize: 13 }}>
                          <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>{row.label}</Text>
                          <Text strong>{row.cur != null ? `${row.cur}${row.unit}` : '—'}</Text>
                          <Text type="secondary" style={{ fontSize: 12, margin: '0 6px' }}>
                            {t('compare.prev')} {row.prev != null ? `${row.prev}${row.unit}` : '—'}
                          </Text>
                          {delta != null && delta !== 0 && (
                            <span style={{ color: deltaColor(delta), fontSize: 12 }}>
                              {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}{row.unit === '%' ? 'pp' : row.unit}
                            </span>
                          )}
                        </span>
                      )
                    })}
                  </Space>
                </Card>

                {alerts.length > 0 && (
                  <Card size="small" title={t('alerts.title')} style={{ marginBottom: 16 }}>
                    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                      {alerts.slice(0, isMobile ? 6 : 12).map((a, i) => (
                        <div key={`${a.student}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Tag color={a.level === 'red' ? 'red' : 'gold'} style={{ marginInlineEnd: 0 }}>
                            {a.level === 'red' ? t('alerts.red') : t('alerts.yellow')}
                          </Tag>
                          <Text strong>{a.student}</Text>
                          {a.class && <Text type="secondary" style={{ fontSize: 12 }}>{a.class}</Text>}
                          <Text type="secondary" style={{ fontSize: 12 }}>{a.reason}</Text>
                        </div>
                      ))}
                    </Space>
                  </Card>
                )}

                {report.headline && (
                  <Card size="small" style={{ marginBottom: 16 }}>
                    <Text strong style={{ fontSize: 15 }}>{report.headline}</Text>
                  </Card>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {report.sections.map(sec => (
                    <SectionCard
                      key={sec.key}
                      section={sec}
                      praise={sec.key === 'S6' ? metrics.praise : undefined}
                      checked={checked}
                      onToggle={toggleAction}
                      t={t}
                      mobile={isMobile}
                    />
                  ))}
                </div>
              </div>
            </Spin>
          )}
        </>
      )}

      <Drawer
        title={t('history.title')} open={historyOpen}
        styles={{ wrapper: { width: isMobile ? '100%' : 380 } }}
        onClose={() => setHistoryOpen(false)}
      >
        <Segmented
          block
          value={historyType}
          style={{ marginBottom: 12 }}
          onChange={v => {
            const next = String(v)
            setHistoryType(next)
            loadHistory(1, next)
          }}
          options={[
            { value: 'all', label: t('history.all') },
            ...PERIODS.map(p => ({ value: p, label: t(`period.${p}`) })),
          ]}
        />
        {historyLoading ? (
          <Skeleton active paragraph={{ rows: 5 }} />
        ) : history.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('history.empty')} />
        ) : (
          <div>
            {history.map(item => (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                style={{
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '10px 6px',
                  borderBottom: '1px solid var(--border-color)', cursor: 'pointer',
                  borderRadius: 6,
                  background: report?.snapshot_id === item.snapshot_id
                    ? 'var(--fill-quaternary, #f5f5f5)' : undefined,
                }}
                onClick={() => { setHistoryOpen(false); loadDetail(item.id, true) }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setHistoryOpen(false)
                    loadDetail(item.id, true)
                  }
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Space size={6}>
                    <span style={{ fontWeight: 500 }}>{shortRange(item.period_start, item.period_end)}</span>
                    <Tag>{t(`period.${item.period_type}`)}</Tag>
                  </Space>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                    {item.filter_label}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{item.created_at}</div>
                </div>
                <span onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                  <Popconfirm
                    title={t('history.deleteConfirm')} okText={t('history.delete')}
                    cancelText={t('filter.cancel')} onConfirm={() => removeHistory(item)}
                  >
                    <Button
                      type="text" size="small" danger icon={<DeleteOutlined />}
                      aria-label={t('history.delete')}
                    />
                  </Popconfirm>
                </span>
              </div>
            ))}
            {historyTotal > 10 && (
              <Pagination
                style={{ textAlign: 'center', marginTop: 12 }}
                size="small" current={historyPage} pageSize={10} total={historyTotal}
                showSizeChanger={false} onChange={p => loadHistory(p, historyType)}
              />
            )}
          </div>
        )}
      </Drawer>

      <Drawer
        title={t('filter.title')} open={filterOpen} onClose={() => setFilterOpen(false)}
        styles={{ wrapper: { width: '100%' } }}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Space.Compact style={{ width: '100%' }}>
            <Button icon={<LeftOutlined />} aria-label={t('filter.prev')} onClick={() => shiftPeriod(-1)} />
            <DatePicker
              value={anchor} onChange={setAnchor} allowClear
              placeholder={t('filter.current')} style={{ flex: 1 }}
            />
            <Button icon={<RightOutlined />} aria-label={t('filter.next')} onClick={() => shiftPeriod(1)} />
          </Space.Compact>
          {isAdmin && (
            <Select
              allowClear showSearch optionFilterProp="label" style={{ width: '100%' }}
              placeholder={t('filter.teacher')} value={teacher || undefined}
              onChange={changeTeacher}
              options={(options?.teachers || []).map(x => ({ value: x.username, label: `${x.name}（${x.username}）` }))}
            />
          )}
          <Select
            mode="multiple" allowClear maxTagCount="responsive" style={{ width: '100%' }}
            placeholder={t('filter.subject')} value={subjects} onChange={setSubjects}
            options={(options?.subjects || []).map(x => ({ value: x, label: x }))}
          />
          <Select
            mode="multiple" allowClear maxTagCount="responsive" style={{ width: '100%' }}
            placeholder={t('filter.grade')} value={grades}
            onChange={v => { setGrades(v); setClasses([]) }}
            options={(options?.grades || []).map(x => ({ value: x, label: x }))}
          />
          <Select
            mode="multiple" allowClear maxTagCount="responsive" style={{ width: '100%' }}
            placeholder={t('filter.class')} value={classes} onChange={setClasses}
            options={classOptions}
          />
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Button onClick={resetFilters}>
              {t('filter.reset')}
            </Button>
            <Button type="primary" onClick={() => setFilterOpen(false)}>{t('filter.done')}</Button>
          </Space>
        </Space>
      </Drawer>

    </div>
  )
}

const Kpi: React.FC<{
  title: string; value?: number | null; suffix?: string; delta?: number | null; hint?: string
}> = ({ title, value, suffix, delta, hint }) => (
  <Card size="small" styles={{ body: { padding: '12px 14px' } }}>
    <Tooltip title={hint || undefined}>
      <Statistic
        title={<span style={{ fontSize: 12 }}>{title}</span>}
        value={value ?? '—'}
        suffix={<span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{value != null ? suffix : ''}</span>}
        styles={{ content: { fontSize: 22 } }}
      />
    </Tooltip>
    <div style={{ height: 16, fontSize: 12 }}>
      {delta != null && (
        <span style={{ color: deltaColor(delta) }}>
          {delta !== 0 && (delta > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />)} {Math.abs(delta)}pp
        </span>
      )}
      {hint && <Text type="secondary" style={{ fontSize: 12, marginLeft: delta != null ? 8 : 0 }}>{hint}</Text>}
    </div>
  </Card>
)

const Bars: React.FC<{ data: { name: string; value: number | null }[]; narrow?: boolean }> = ({ data, narrow }) => {
  if (!data.length) return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>
  const max = Math.max(1, ...data.map(d => d.value || 0))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      {data.map((d, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: `${narrow ? 88 : 132}px 1fr 48px`, gap: 8, alignItems: 'center' }}>
          <Text ellipsis style={{ fontSize: 12 }} title={d.name}>{d.name}</Text>
          <div style={{ height: 8, background: 'var(--fill-quaternary, #f0f0f0)', borderRadius: 4 }}>
            <div style={{
              width: d.value == null || d.value <= 0 ? 0 : `${Math.max(2, (d.value / max) * 100)}%`,
              height: 8, borderRadius: 4,
              background: d.value != null && d.value < 60 ? 'var(--warning-color, #faad14)' : 'var(--primary-color, #1677ff)',
            }} />
          </div>
          <Text style={{ fontSize: 12, textAlign: 'right' }}>{d.value != null ? `${d.value}%` : '—'}</Text>
        </div>
      ))}
    </div>
  )
}

type ChartSpec = NonNullable<BriefingSection['charts']>[number]

const ChartBlock: React.FC<{ chart: ChartSpec; narrow?: boolean }> = ({ chart, narrow }) => {
  if (chart.type === 'line' && chart.data.length >= 2) {
    return (
      <div style={{ height: narrow ? 190 : 220, marginTop: 8 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chart.data} margin={{ top: 8, right: 8, left: narrow ? -18 : -10, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--border-color)" />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} width={narrow ? 30 : 36} />
            <RechartsTooltip />
            <Line
              type="monotone" dataKey="value" stroke="var(--primary-color, #1677ff)"
              strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    )
  }
  return <Bars data={chart.data} narrow={narrow} />
}

const SectionCard: React.FC<{
  section: BriefingSection
  praise?: api.BriefingMetrics['praise']
  checked: Record<string, boolean>
  onToggle: (k: string) => void
  t: (k: string, o?: any) => string
  mobile?: boolean
}> = ({ section, praise, checked, onToggle, t, mobile }) => {
  const isPraise = section.key === 'S6'
  const hasPraise = isPraise && ((praise?.students?.length || 0) + (praise?.classes?.length || 0) > 0)

  return (
    <Card
      size="small"
      styles={{ body: { padding: '14px 16px' } }}
      style={{
        borderLeft: `3px solid ${isPraise ? '#d48806' : SEVERITY_COLOR[section.severity || 'info']}`,
        background: isPraise ? 'linear-gradient(90deg, rgba(250,219,20,0.06), transparent 60%)' : undefined,
      }}
    >
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
        <Text strong>{section.title}</Text>
        {praise?.coverage != null && isPraise && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('praise.coverage', { n: praise.coverage })}
          </Text>
        )}
      </Space>

      {section.narrative && (
        <Paragraph style={{ margin: '8px 0 0', fontSize: 13 }}>{section.narrative}</Paragraph>
      )}

      {hasPraise && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${mobile ? 140 : 200}px, 1fr))`, gap: 8 }}>
            {praise!.students.map((s, i) => (
              <div key={i} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg-container)' }}>
                <Space size={6} style={{ marginBottom: 2 }}>
                  <Tag color="gold" style={{ marginInlineEnd: 0 }}>{s.title}</Tag>
                  <Text strong>{s.name}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{s.class}</Text>
                </Space>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{s.reason}</div>
              </div>
            ))}
          </div>
          {!!praise!.classes.length && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {praise!.classes.map((c, i) => (
                <Space key={i} size={8}>
                  <Tag color="gold">{c.title}</Tag>
                  <Text strong>{c.name}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{c.reason}</Text>
                </Space>
              ))}
            </div>
          )}
          {!!praise!.vacant?.length && (
            <div style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('praise.vacant')}：{praise!.vacant.slice(0, 6).map(v => v.title).join('、')}
              </Text>
            </div>
          )}
        </div>
      )}

      {!hasPraise && !!section.bullets?.length && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--text-secondary)' }}>
          {section.bullets.map((b, i) => <li key={i} style={{ marginBottom: 2 }}>{b}</li>)}
        </ul>
      )}

      {section.charts?.map((c, i) => (
        <div key={i} style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{c.title}</Text>
          <ChartBlock chart={c} narrow={mobile} />
        </div>
      ))}

      {section.tables?.map((tb, i) => (
        <div key={i} style={{ marginTop: 10 }}>
          {mobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(tb.rows || []).slice(0, 30).map((r, ri) => (
                <div key={ri} style={{
                  border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 10px',
                }}>
                  {tb.columns.map((c, ci) => (
                    <div key={ci} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.7 }}>
                      <span style={{ color: 'var(--text-secondary)', flex: '0 0 56px' }}>{c}</span>
                      <span style={{ flex: 1, wordBreak: 'break-all' }}>{r[ci]}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <Table
              size="small" rowKey="key" pagination={false}
              columns={tb.columns.map((c, ci) => ({ title: c, dataIndex: `c${ci}`, ellipsis: true }))}
              dataSource={(tb.rows || []).map((r, ri) => {
                const row: Record<string, unknown> = { key: ri }
                r.forEach((v, ci) => { row[`c${ci}`] = v })
                return row
              })}
            />
          )}
        </div>
      ))}

      {!!section.actions?.length && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {section.actions.map((a, i) => {
            const key = `${section.key}-${i}`
            return (
              <Checkbox key={key} checked={!!checked[key]} onChange={() => onToggle(key)}>
                <Text delete={!!checked[key]}>{a.text}</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>（{a.basis}）</Text>
              </Checkbox>
            )
          })}
        </div>
      )}
    </Card>
  )
}

export default BriefingPage
