/**
 * QuestionBankAnalyticsPage — 题库统计分析
 *
 * 题型 / 难度 / 学科 / 知识点 / 创建者 / 质量检查。
 * 所有图表和表格共用同一套筛选条件，点击统计项可回到题目明细。
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, DatePicker, Empty, Input, Row, Select,
  Space, Spin, Statistic, Table, Tag, Typography, message, Modal,
} from 'antd'
import {
  ArrowLeftOutlined, BarChartOutlined, DownloadOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import dayjs, { type Dayjs } from 'dayjs'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from 'recharts'
import * as questionsApi from '../api/questions'
import { TYPE_LABELS, TYPE_OPTIONS } from '../constants/questionTypes'
import KnowledgePointSelect, { joinKps } from '../components/KnowledgePointSelect'
import { reportLoadError } from '../utils/loadError'

const { Text, Title } = Typography
const { RangePicker } = DatePicker
const PIE_COLORS = ['#1677ff', '#52c41a', '#faad14', '#ff4d4f', '#722ed1', '#13c2c2', '#eb2f96']

interface AnalyticsFilters {
  subject: string
  type: string
  difficulty: string
  creator: string
}

const EMPTY_FILTERS: AnalyticsFilters = { subject: '', type: '', difficulty: '', creator: '' }

/** 后端 detail 可能是字符串，也可能是 FastAPI 422 的对象数组；必须转成字符串再渲染。 */
function errorText(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((x: any) => (typeof x === 'string' ? x : (x?.msg || JSON.stringify(x))))
      .join('；')
  }
  if (detail && typeof detail === 'object') {
    return String(detail.msg || JSON.stringify(detail))
  }
  return e?.message || fallback
}

const QuestionBankAnalyticsPage: React.FC = () => {
  const { t } = useTranslation('questions')
  const navigate = useNavigate()
  const [filters, setFilters] = useState<AnalyticsFilters>(EMPTY_FILTERS)
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [keyword, setKeyword] = useState('')
  const [kpFilter, setKpFilter] = useState<string[]>([])
  const [data, setData] = useState<questionsApi.QuestionAnalytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditCreator, setAuditCreator] = useState('')
  const [auditData, setAuditData] = useState<questionsApi.CreatorAuditResult | null>(null)
  const [auditTarget, setAuditTarget] = useState('')
  const [auditSelected, setAuditSelected] = useState<React.Key[]>([])
  const [auditSubmitting, setAuditSubmitting] = useState(false)

  const params = useMemo(() => ({
    ...filters,
    keyword: keyword || undefined,
    knowledge_points: joinKps(kpFilter) || undefined,
    start_date: range?.[0]?.format('YYYY-MM-DD'),
    end_date: range?.[1]?.format('YYYY-MM-DD'),
  }), [filters, keyword, kpFilter, range])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setData(await questionsApi.getQuestionAnalytics(params))
    } catch (e: any) {
      const detail = e?.response?.data?.detail
      const legacyRoute = Array.isArray(detail)
        && detail.some((x: any) => Array.isArray(x?.loc) && x.loc.includes('question_id'))
      const msg = e?.response?.status === 404 || legacyRoute
        ? t('analyticsBackendRestart')
        : errorText(e, t('analyticsLoadFailed'))
      setData(null)
      setError(msg)
      message.error(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [params])

  const meta = data?.meta
  const typeData = useMemo(() => {
    const counts = new Map((data?.by_type || []).map(x => [x.type, x.count]))
    const rows = TYPE_OPTIONS.map(opt => ({
      key: opt.value,
      label: opt.label,
      count: counts.get(opt.value) || 0,
    }))
    for (const item of data?.by_type || []) {
      if (!TYPE_OPTIONS.some(x => x.value === item.type)) {
        rows.push({ key: item.type, label: item.type, count: item.count })
      }
    }
    return rows
  }, [data])

  const difficultyData = useMemo(() => {
    const labels: Record<string, string> = {
      easy: t('easy'), medium: t('medium'), hard: t('hard'),
      unknown: t('analyticsDifficultyUnknown'),
    }
    return (data?.by_difficulty || []).map(x => ({
      ...x,
      label: labels[x.difficulty] || x.difficulty,
    }))
  }, [data, t])

  const goList = () => {
    const q = new URLSearchParams()
    if (filters.subject) q.set('subject', filters.subject)
    if (filters.type) q.set('type', filters.type)
    if (filters.difficulty) q.set('difficulty', filters.difficulty)
    if (filters.creator) q.set('creator', filters.creator)
    if (kpFilter.length) q.set('knowledge_points', joinKps(kpFilter))
    if (keyword) q.set('keyword', keyword)
    if (range?.[0]) q.set('start_date', range[0].format('YYYY-MM-DD'))
    if (range?.[1]) q.set('end_date', range[1].format('YYYY-MM-DD'))
    navigate({ pathname: '/question-bank', search: q.toString() })
  }

  const exportCsv = () => {
    if (!data) return
    const lines: string[][] = [
      [t('analyticsTotal'), String(data.summary.total)],
      [t('analyticsTypes'), String(data.summary.type_count)],
      [t('analyticsKnowledgePoints'), String(data.summary.knowledge_point_count)],
      [t('analyticsCreators'), String(data.summary.creator_count)],
      [],
      [t('analyticsByType'), t('analyticsCount')],
      ...data.by_type.map(x => [TYPE_LABELS[x.type] || x.type, String(x.count)]),
      [],
      [t('analyticsByDifficulty'), t('analyticsCount')],
      ...data.by_difficulty.map(x => [x.difficulty, String(x.count)]),
      [],
      [t('analyticsBySubject'), t('analyticsCount')],
      ...data.by_subject.map(x => [x.subject, String(x.count)]),
      [],
      [t('analyticsKpTable'), t('analyticsCount')],
      ...data.knowledge_points.map(x => [x.name, String(x.count)]),
      [],
      [t('analyticsCreatorTable'), t('analyticsCount')],
      ...data.by_creator.map(x => [x.name || x.username, String(x.count)]),
    ]
    const csv = '\ufeff' + lines.map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = href
    a.download = `题库统计_${dayjs().format('YYYYMMDD_HHmm')}.csv`
    a.click()
    URL.revokeObjectURL(href)
  }

  const reset = () => {
    setFilters(EMPTY_FILTERS)
    setRange(null)
    setKeyword('')
    setKpFilter([])
  }

  const roleLabel = (role: number) => (
    role === 0 ? t('analyticsRoleAdmin') : role === 1 ? t('analyticsRoleTeacher') : t('analyticsRoleStudent')
  )

  const openAudit = async (creator: string) => {
    setAuditOpen(true)
    setAuditCreator(creator)
    setAuditLoading(true)
    setAuditData(null)
    setAuditSelected([])
    try {
      const res = await questionsApi.getQuestionCreatorAudit(creator)
      setAuditData(res)
      const activeIds = res.questions.filter(q => q.status === 'active').map(q => q.id)
      setAuditSelected(activeIds)
      const preferred = res.targets.find(x => x.role === 1)?.username || res.targets[0]?.username || ''
      setAuditTarget(preferred)
    } catch (e: any) {
      message.error(errorText(e, t('analyticsLoadFailed')))
    } finally {
      setAuditLoading(false)
    }
  }

  const handleTransfer = async () => {
    if (!auditCreator || !auditTarget || auditSelected.length === 0) {
      message.warning(t('analyticsSelectQuestions'))
      return
    }
    setAuditSubmitting(true)
    try {
      const res = await questionsApi.transferQuestionCreator({
        from_username: auditCreator,
        to_username: auditTarget,
        question_ids: auditSelected.map(Number),
      })
      message.success(t('analyticsTransferSuccess', { count: res.transferred || 0 }))
      await openAudit(auditCreator)
      await load()
    } catch (e: any) {
      message.error(errorText(e, t('analyticsLoadFailed')))
    } finally {
      setAuditSubmitting(false)
    }
  }

  const handleArchive = () => {
    if (!auditCreator || auditSelected.length === 0) {
      message.warning(t('analyticsSelectQuestions'))
      return
    }
    Modal.confirm({
      title: t('analyticsConfirmArchive'),
      okType: 'danger',
      okText: t('analyticsArchive'),
      cancelText: t('cancel'),
      onOk: async () => {
        setAuditSubmitting(true)
        try {
          const res = await questionsApi.archiveQuestionCreator({
            from_username: auditCreator,
            question_ids: auditSelected.map(Number),
          })
          message.success(t('analyticsArchiveSuccess', { count: res.archived || 0 }))
          await openAudit(auditCreator)
          await load()
        } catch (e: any) {
          message.error(errorText(e, t('analyticsLoadFailed')))
        } finally {
          setAuditSubmitting(false)
        }
      },
    })
  }

  const summary = data?.summary
  const creatorColumns = [
    {
      title: t('analyticsCreator'), key: 'creator', width: 180,
      render: (_: any, r: questionsApi.QuestionAnalyticsCreator) => (
        <div>
          <Text strong>{r.name || r.username}</Text>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {r.username}
            <Tag color={r.role === 0 ? 'purple' : r.role === 1 ? 'blue' : 'red'} style={{ marginLeft: 6 }}>
              {roleLabel(r.role)}
            </Tag>
            {r.role !== 0 && r.role !== 1 && <Tag color="red">{t('analyticsAnomaly')}</Tag>}
          </div>
        </div>
      ),
    },
    { title: t('analyticsCount'), dataIndex: 'count', key: 'count', width: 90, sorter: (a: any, b: any) => a.count - b.count },
    {
      title: t('questionType'), key: 'types',
      render: (_: any, r: questionsApi.QuestionAnalyticsCreator) => (
        <Space wrap size={2}>
          {Object.entries(r.types).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => (
            <Tag key={k} color="blue">{TYPE_LABELS[k] || k} {v}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: t('subject'), key: 'subjects', width: 180,
      render: (_: any, r: questionsApi.QuestionAnalyticsCreator) => (
        <Text type="secondary">
          {Object.entries(r.subjects).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' · ') || '-'}
        </Text>
      ),
    },
    {
      title: t('analyticsLastCreated'), dataIndex: 'last_created_at', key: 'last', width: 150,
      render: (v: string) => v?.slice(0, 16) || '-',
    },
    {
      title: t('analyticsCreatorAudit'), key: 'audit', width: 120,
      render: (_: any, r: questionsApi.QuestionAnalyticsCreator) => (
        r.role !== 0 && r.role !== 1 ? (
          <Button size="small" type="link" onClick={() => void openAudit(r.username)}>
            {t('analyticsTransfer')}
          </Button>
        ) : null
      ),
    },
  ]

  return (
    <div>
      <Card style={{ marginBottom: 12 }}>
        <Row justify="space-between" align="middle" gutter={[12, 12]}>
          <Col>
            <Space>
              <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/question-bank')} />
              <BarChartOutlined style={{ fontSize: 22, color: '#1677ff' }} />
              <div>
                <Title level={4} style={{ margin: 0 }}>{t('analyticsTitle')}</Title>
                <Text type="secondary">{t('analyticsSubtitle')}</Text>
              </div>
            </Space>
          </Col>
          <Col>
            <Space>
              <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={!data}>{t('analyticsExport')}</Button>
              <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('refresh')}</Button>
              <Button type="primary" onClick={goList}>{t('analyticsViewList')}</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Select
            allowClear placeholder={t('analyticsAllSubjects')} style={{ width: 140 }}
            value={filters.subject || undefined}
            onChange={v => setFilters(f => ({ ...f, subject: v || '' }))}
            options={(meta?.subjects || []).map(x => ({ value: x, label: x }))}
          />
          <Select
            allowClear placeholder={t('analyticsAllTypes')} style={{ width: 130 }}
            value={filters.type || undefined}
            onChange={v => setFilters(f => ({ ...f, type: v || '' }))}
            options={TYPE_OPTIONS.map(x => ({ value: x.value, label: x.label }))}
          />
          <Select
            allowClear placeholder={t('analyticsAllDifficulties')} style={{ width: 130 }}
            value={filters.difficulty || undefined}
            onChange={v => setFilters(f => ({ ...f, difficulty: v || '' }))}
            options={[
              { value: 'easy', label: t('easy') },
              { value: 'medium', label: t('medium') },
              { value: 'hard', label: t('hard') },
            ]}
          />
          <Select
            allowClear showSearch optionFilterProp="label"
            placeholder={t('analyticsAllCreators')} style={{ width: 180 }}
            value={filters.creator || undefined}
            onChange={v => setFilters(f => ({ ...f, creator: v || '' }))}
            options={(meta?.creators || []).map(x => ({ value: x.username, label: `${x.name} (${x.username})` }))}
          />
          <KnowledgePointSelect
            subject={filters.subject}
            value={kpFilter}
            onChange={(v) => setKpFilter(Array.isArray(v) ? v : [v])}
            extraOptions={(data?.knowledge_points || []).map(x => x.name)}
            style={{ minWidth: 260 }}
            placeholder={t('analyticsKnowledgePointFilter')}
          />
          <RangePicker value={range} onChange={v => setRange(v as [Dayjs | null, Dayjs | null] | null)} />
          <Input.Search
            allowClear placeholder={t('analyticsKeyword')} style={{ width: 190 }}
            onChange={e => { if (!e.target.value) setKeyword('') }}
            onSearch={v => setKeyword(v.trim())}
          />
          <Button onClick={reset}>{t('analyticsReset')}</Button>
        </Space>
      </Card>

      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {loading && !data ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : !summary || summary.total === 0 ? (
        <Card><Empty description={t('analyticsEmpty')} /></Card>
      ) : (
        <>
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={12} sm={8} md={4}><Card size="small"><Statistic title={t('analyticsTotal')} value={summary.total} /></Card></Col>
            <Col xs={12} sm={8} md={4}><Card size="small"><Statistic title={t('analyticsTypes')} value={summary.type_count} /></Card></Col>
            <Col xs={12} sm={8} md={4}><Card size="small"><Statistic title={t('analyticsKnowledgePoints')} value={summary.knowledge_point_count} /></Card></Col>
            <Col xs={12} sm={8} md={4}><Card size="small"><Statistic title={t('analyticsCreators')} value={summary.creator_count} /></Card></Col>
            <Col xs={12} sm={8} md={4}><Card size="small"><Statistic title={t('analyticsKpCoverage')} value={summary.knowledge_point_coverage} suffix="%" /></Card></Col>
            <Col xs={12} sm={8} md={4}><Card size="small"><Statistic title={t('analyticsMediaCoverage')} value={summary.media_coverage} suffix="%" /></Card></Col>
          </Row>

          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} lg={12}>
              <Card size="small" title={t('analyticsByType')}>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={typeData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} />
                    <RTooltip />
                    <Bar dataKey="count" fill="#1677ff" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </Col>
            <Col xs={24} lg={6}>
              <Card size="small" title={t('analyticsByDifficulty')}>
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={difficultyData} dataKey="count" nameKey="label" innerRadius={55} outerRadius={90}>
                      {difficultyData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <RTooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </Card>
            </Col>
            <Col xs={24} lg={6}>
              <Card size="small" title={t('analyticsBySubject')}>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.by_subject} layout="vertical" margin={{ left: 10, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="subject" width={75} tick={{ fontSize: 11 }} />
                    <RTooltip />
                    <Bar dataKey="count" fill="#52c41a" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </Col>
          </Row>

          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} lg={12}>
              <Card size="small" title={t('analyticsTimeline')}>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={data.timeline}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} />
                    <RTooltip />
                    <Area type="monotone" dataKey="count" stroke="#1677ff" fill="#1677ff33" />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title={t('analyticsKpTop')}>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.knowledge_points.slice(0, 15)} layout="vertical" margin={{ left: 10, right: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
                    <RTooltip />
                    <Bar dataKey="count" fill="#722ed1" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            </Col>
          </Row>

          <Card size="small" title={t('analyticsCreatorTable')} style={{ marginBottom: 12 }}>
            <Table
              size="small" rowKey="username" columns={creatorColumns as any}
              dataSource={data.by_creator} pagination={{ pageSize: 10, showSizeChanger: true }}
              scroll={{ x: 850 }}
            />
          </Card>

          <Card size="small" title={`${t('analyticsKpTable')} (${data.knowledge_point_total})`} style={{ marginBottom: 12 }}>
            <Table
              size="small" rowKey="name"
              dataSource={data.knowledge_points}
              pagination={{ pageSize: 10, showSizeChanger: true }}
              columns={[
                { title: t('analyticsKnowledgePoints'), dataIndex: 'name' },
                { title: t('analyticsCount'), dataIndex: 'count', width: 100, sorter: (a: any, b: any) => a.count - b.count },
                { title: '%', dataIndex: 'percent', width: 90, render: (v: number) => `${v}%` },
              ]}
            />
          </Card>

          <Alert
            type="info"
            showIcon
            message={t('analyticsKpAllowedHint')}
            style={{ marginBottom: 12 }}
          />
          <Card size="small" title={t('analyticsQuality')}>
            <Row gutter={[12, 12]}>
              <Col xs={12} md={4}><Statistic title={t('analyticsNoKp')} value={data.quality.no_knowledge_point} /></Col>
              <Col xs={12} md={4}><Statistic title={t('analyticsNoExplanation')} value={data.quality.no_explanation} /></Col>
              <Col xs={12} md={4}><Statistic title={t('analyticsNoMedia')} value={data.quality.no_media} /></Col>
              <Col xs={12} md={4}><Statistic title={t('analyticsPendingMedia')} value={data.quality.pending_media} /></Col>
              <Col xs={12} md={4}><Statistic title={t('analyticsOptionIssues')} value={data.quality.option_issues} /></Col>
              <Col xs={12} md={4}><Statistic title={t('analyticsDuplicates')} value={data.quality.duplicate_groups} /></Col>
            </Row>
          </Card>
        </>
      )}

      <Modal
        maskClosable={false}
        open={auditOpen}
        title={`${t('analyticsCreatorAudit')} · ${auditCreator}`}
        width={860}
        onCancel={() => setAuditOpen(false)}
        footer={[
          <Button key="close" onClick={() => setAuditOpen(false)}>{t('cancel')}</Button>,
          <Button key="archive" danger loading={auditSubmitting} onClick={handleArchive}>
            {t('analyticsArchive')}
          </Button>,
          <Button key="transfer" type="primary" loading={auditSubmitting} onClick={handleTransfer}>
            {t('analyticsTransfer')}
          </Button>,
        ]}
      >
        {auditLoading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
        ) : auditData ? (
          <>
            <Alert type="warning" showIcon message={t('analyticsAnomalyDesc')} style={{ marginBottom: 12 }} />
            <Space style={{ marginBottom: 12 }} wrap>
              <Text strong>{t('analyticsTransferTarget')}</Text>
              <Select
                style={{ width: 240 }}
                value={auditTarget || undefined}
                onChange={setAuditTarget}
                options={auditData.targets.map(x => ({
                  value: x.username,
                  label: `${x.name} (${x.username}) · ${roleLabel(x.role)}`,
                }))}
              />
              <Text type="secondary">{t('analyticsSelectedCount', { count: auditSelected.length })}</Text>
            </Space>
            <Table
              size="small"
              rowKey="id"
              dataSource={auditData.questions}
              pagination={{ pageSize: 10, showSizeChanger: true }}
              rowSelection={{
                selectedRowKeys: auditSelected,
                onChange: setAuditSelected,
                getCheckboxProps: (r: any) => ({ disabled: r.status !== 'active' }),
              }}
              columns={[
                { title: 'ID', dataIndex: 'id', width: 80 },
                { title: t('questionType'), dataIndex: 'type', width: 100, render: (v: string) => TYPE_LABELS[v] || v },
                { title: t('subject'), dataIndex: 'subject', width: 100 },
                { title: t('statusLabel'), dataIndex: 'status', width: 90 },
                { title: t('createdTime'), dataIndex: 'created_at', width: 150, render: (v: string) => v?.slice(0, 16) || '-' },
                { title: t('question'), dataIndex: 'question_text', ellipsis: true },
              ]}
              scroll={{ x: 760 }}
            />
          </>
        ) : (
          <Empty description={t('analyticsAuditEmpty')} />
        )}
      </Modal>
    </div>
  )
}

export default QuestionBankAnalyticsPage
