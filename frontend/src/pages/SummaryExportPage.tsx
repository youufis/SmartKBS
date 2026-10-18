/**
 * 学生活动成绩汇总导出
 * 跨活动类型 (考试/测验/任务/练习/代码/课程/抢答/闯关/投票/讨论/课堂积分) 汇总,
 * 支持按年级 / 班级 / 学生 / 活动类型 / 时间范围筛选后导出 Excel (多 Sheet) 或 CSV (单表)。
 * 下拉级联: 年级来自后端主数据 → 选年级后加载班级 → 年级+班级确定后加载学生。
 * 权限: 管理员全量; 教师仅自己创建的活动 × 任教年级班级学生 (后端强制)。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button, Card, DatePicker, Dropdown, Select, Space, Table, Tabs, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  DownloadOutlined, FileExcelOutlined, FileTextOutlined, ReloadOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import {
  extractErrorDetail, fetchSummaryClasses, fetchSummaryMeta, fetchSummaryPreview,
  fetchSummaryStudents, summaryDownloadUrl,
  type ActivityAggRow, type ClassAggRow, type StudentAggRow, type StudentLite,
  type SummaryMeta, type SummaryPreview, type SummaryRecord, type SummaryTypeMeta,
} from '../api/summaryExport'
import apiClient from '../api/client'
import MobileCardTable from '../components/MobileCardTable'
import ScopeTag from '../components/ScopeTag'
import { useIsMobile } from '../hooks/useIsMobile'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

type CsvSheetKey = 'records' | 'student' | 'activity' | 'class'

const KIND_COLORS: Record<string, string> = { score: 'blue', participation: 'green', points: 'gold' }

const numOr = (v: number | null | undefined): React.ReactNode =>
  v === null || v === undefined || Number.isNaN(v) ? '-' : v

const rateOr = (v: number | null | undefined): React.ReactNode =>
  v === null || v === undefined ? '-' : `${v}%`

async function blobError(e: any): Promise<string> {
  const data = e?.response?.data
  if (data instanceof Blob) {
    try {
      const text = await data.text()
      const parsed = JSON.parse(text)
      if (parsed?.detail) return String(parsed.detail)
    } catch { /* 非 JSON 错误体 */ }
  }
  return e?.response?.data?.detail || e?.message || '导出失败'
}

const SummaryExportPage: React.FC = () => {
  const { t } = useTranslation('summary')
  const isMobile = useIsMobile()

  const [meta, setMeta] = useState<SummaryMeta | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)

  const [grade, setGrade] = useState<string>('')
  const [cls, setCls] = useState<string>('')
  const [students, setStudents] = useState<string[]>([])
  const [types, setTypes] = useState<string[]>([])
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [teacher, setTeacher] = useState<string>('')

  // ── 级联选项 (来自后端, 不硬编码) ──
  const [classOptions, setClassOptions] = useState<string[]>([])
  const [classesLoading, setClassesLoading] = useState(false)
  const [studentList, setStudentList] = useState<StudentLite[]>([])
  const [studentsLoading, setStudentsLoading] = useState(false)
  const [studentsMeta, setStudentsMeta] = useState<{ total: number; truncated: boolean }>({ total: 0, truncated: false })

  const [data, setData] = useState<SummaryPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState<'excel' | 'csv' | null>(null)
  const [activeTab, setActiveTab] = useState('records')
  const [mPage, setMPage] = useState(1)

  const loadMeta = async () => {
    setMetaLoading(true)
    try {
      setMeta(await fetchSummaryMeta())
    } catch (err) {
      message.error(extractErrorDetail(err))
    } finally {
      setMetaLoading(false)
    }
  }

  useEffect(() => { void loadMeta() }, [])

  // 年级变化 → 重置班级/学生选择, 动态加载该年级可见班级
  useEffect(() => {
    setCls('')
    setStudents([])
    setStudentList([])
    setStudentsMeta({ total: 0, truncated: false })
    if (!grade) {
      setClassOptions([])
      return
    }
    let cancelled = false
    setClassesLoading(true)
    fetchSummaryClasses(grade)
      .then((list) => { if (!cancelled) setClassOptions(list) })
      .catch((err) => { if (!cancelled) message.error(extractErrorDetail(err)) })
      .finally(() => { if (!cancelled) setClassesLoading(false) })
    return () => { cancelled = true }
  }, [grade])

  // 年级/班级变化 → 动态加载学生 (需先选年级; 未选班级=整个年级)
  useEffect(() => {
    if (!grade) return
    let cancelled = false
    setStudentsLoading(true)
    fetchSummaryStudents(grade, cls)
      .then((r) => {
        if (cancelled) return
        setStudentList(r.students)
        setStudentsMeta({ total: r.total, truncated: r.truncated })
        // 换班级后剔除不在新范围内的已选学生
        const valid = new Set(r.students.map((s) => s.username))
        setStudents((prev) => {
          const next = prev.filter((u) => valid.has(u))
          return next.length === prev.length ? prev : next
        })
      })
      .catch((err) => { if (!cancelled) message.error(extractErrorDetail(err)) })
      .finally(() => { if (!cancelled) setStudentsLoading(false) })
    return () => { cancelled = true }
  }, [grade, cls])

  const currentFilters = useMemo(() => ({
    grade,
    cls,
    usernames: students.join(','),
    types: types.join(','),
    start: range?.[0] ? range[0]!.format('YYYY-MM-DD') : '',
    end: range?.[1] ? range[1]!.format('YYYY-MM-DD') : '',
    teacher,
  }), [grade, cls, students, types, range, teacher])

  const filterKey = useMemo(() => JSON.stringify(currentFilters), [currentFilters])

  // 筛选一变，旧预览立即失效，避免"看到 A 班、导出 B 班"
  useEffect(() => {
    setData(null)
  }, [filterKey])

  const doPreview = async () => {
    setLoading(true)
    try {
      setData(await fetchSummaryPreview(currentFilters))
    } catch (err) {
      message.error(extractErrorDetail(err))
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  const openDownload = async (kind: 'excel' | 'csv', sheet?: CsvSheetKey) => {
    if (!data) return
    setExporting(kind)
    try {
      const res = await apiClient.get(summaryDownloadUrl(kind, currentFilters, sheet), {
        responseType: 'blob',
        timeout: 300000,
      })
      const dispo = String(res.headers['content-disposition'] || '')
      const match = /filename\*=UTF-8''([^;]+)/i.exec(dispo)
      const fallback = kind === 'excel' ? '学生活动汇总.xlsx' : '学生活动汇总.csv'
      const filename = match ? decodeURIComponent(match[1]) : fallback
      const href = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = href
      a.download = filename
      a.click()
      URL.revokeObjectURL(href)
    } catch (e: any) {
      message.error(await blobError(e))
    } finally {
      setExporting(null)
    }
  }

  const typeList: SummaryTypeMeta[] = meta?.activity_types || []
  const typeLabel = (tk: string): string => {
    const found = typeList.find((x) => x.key === tk)
    return found ? t(`summaryExport.type.${tk}`, { defaultValue: found.label }) : tk
  }
  const typeKind = (tk: string): string => typeList.find((x) => x.key === tk)?.kind || 'score'

  const studentOptions = useMemo(
    () => studentList.map((s) => ({
      value: s.username,
      label: `${s.name || s.username} (${s.username})`,
    })),
    [studentList],
  )

  // ── 明细表列 ──
  // 年级/班级统一走 ScopeTag(variant='text'): 同一套格式化 + 限宽截断 + 悬停全文
  const gradeClassCell = (grade: string, cls: string | number) => (
    <ScopeTag variant="text" grade={String(grade ?? '')} classes={String(cls ?? '')} />
  )
  const recordColumns: ColumnsType<SummaryRecord> = [
    { title: t('summaryExport.col.gradeClass'), key: 'grade_class', width: 110,
      render: (_, r) => gradeClassCell(r.grade, r.class_name) },
    { title: t('summaryExport.col.student'), key: 'student', width: 120,
      render: (_, r) => (
        <div>
          <div>{r.student_name || '-'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{r.username}</div>
        </div>
      ) },
    {
      title: t('summaryExport.col.type'), dataIndex: 'type_label', width: 110,
      render: (_: string, r) => <Tag color={KIND_COLORS[r.kind]}>{r.type_label}</Tag>,
    },
    { title: t('summaryExport.col.activity'), dataIndex: 'activity_title', ellipsis: { showTitle: false },
      render: (v: string) => <Tooltip title={v} placement="topLeft">{v}</Tooltip> },
    { title: t('summaryExport.col.creator'), dataIndex: 'creator_username', width: 90 },
    // 得分统一 100 分制（随堂测验的老卷已由后端折算）：得分就写得分本身，
    // 满分不是 100 的（如满分 120 的试卷）才补一句得分率帮老师换算
    { title: t('summaryExport.col.score'), key: 'score', width: 140,
      render: (_, r) => (r.total_score == null
        ? numOr(r.score)
        : `${numOr(r.score)} / ${numOr(r.total_score)}`
          + (Number(r.total_score) === 100 ? '' : `（${rateOr(r.rate)}）`)) },
    { title: t('summaryExport.col.status'), dataIndex: 'status', width: 120 },
    { title: t('summaryExport.col.time'), dataIndex: 'time', width: 150 },
  ]

  // ── 学生汇总列 (动态类型矩阵) ──
  const studentColumns: ColumnsType<StudentAggRow> = useMemo(() => {
    const base: ColumnsType<StudentAggRow> = [
      { title: t('summaryExport.col.gradeClass'), key: 'grade_class', width: 110, fixed: 'left',
        render: (_, r) => gradeClassCell(r.grade, r.class_name) },
      { title: t('summaryExport.col.student'), key: 'student', width: 120, fixed: 'left',
        render: (_, r) => (
          <div>
            <div>{r.name || r.username}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{r.username}</div>
          </div>
        ) },
    ]
    const dyn: ColumnsType<StudentAggRow> = Object.keys(data?.types || {}).map((k) => ({
      title: typeLabel(k),
      key: k,
      width: 140,
      render: (_: unknown, r: StudentAggRow) => {
        const cell = r.types?.[k]
        if (!cell || !cell.count) return '-'
        if (typeKind(k) === 'score') return `${cell.count} / ${numOr(cell.avg_rate)}%`
        if (typeKind(k) === 'points') return numOr(cell.points)
        return cell.count
      },
    }))
    const tail: ColumnsType<StudentAggRow> = [
      { title: t('summaryExport.col.totalDone'), dataIndex: 'total_done', width: 110, render: numOr },
      { title: t('summaryExport.col.overallRate'), dataIndex: 'overall_avg_rate', width: 130, render: rateOr },
    ]
    return [...base, ...dyn, ...tail]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, meta])

  // ── 按活动汇总列 ──
  const activityColumns: ColumnsType<ActivityAggRow> = [
    { title: t('summaryExport.col.type'), dataIndex: 'type_label', width: 110, render: (v: string, r) => <Tag color={KIND_COLORS[r.kind]}>{v}</Tag> },
    { title: t('summaryExport.col.activity'), dataIndex: 'activity_title', ellipsis: { showTitle: false },
      render: (v: string, r) => (
        <Tooltip title={v} placement="topLeft">
          <div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>ID: {String(r.activity_id ?? '-')}</div>
          </div>
        </Tooltip>
      ) },
    { title: t('summaryExport.col.creator'), dataIndex: 'creator_username', width: 90 },
    { title: t('summaryExport.col.participation'), key: 'participation', width: 130,
      render: (_, r) => `${numOr(r.participants)} / ${numOr(r.expected)}（${rateOr(r.participation_rate)}）` },
    { title: t('summaryExport.col.rateStats'), key: 'rate_stats', width: 190,
      render: (_, r) => (
        <div>
          <div>{t('summaryExport.col.avgRate')}: {rateOr(r.avg_rate)} · {t('summaryExport.col.passRate')}: {rateOr(r.pass_rate)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('summaryExport.col.maxRate')}: {rateOr(r.max_rate)} · {t('summaryExport.col.minRate')}: {rateOr(r.min_rate)}</div>
        </div>
      ) },
    { title: t('summaryExport.col.lastTime'), dataIndex: 'last_time', width: 150, render: (v: string) => v || '-' },
  ]

  // ── 按班级汇总列 ──
  const classColumns: ColumnsType<ClassAggRow> = useMemo(() => {
    const base: ColumnsType<ClassAggRow> = [
      { title: t('summaryExport.col.gradeClass'), key: 'grade_class', width: 120,
        render: (_, r) => gradeClassCell(r.grade, r.class_name) },
      { title: t('summaryExport.col.studentCount'), dataIndex: 'students', width: 90 },
    ]
    const dyn: ColumnsType<ClassAggRow> = Object.keys(data?.types || {}).map((k) => ({
      title: typeLabel(k),
      key: k,
      width: 130,
      render: (_: unknown, r: ClassAggRow) => {
        const cell = r.types?.[k]
        if (!cell || !cell.count) return '-'
        if (typeKind(k) === 'score') return `${cell.count} / ${numOr(cell.avg_rate)}%`
        return cell.count
      },
    }))
    const tail: ColumnsType<ClassAggRow> = [
      { title: t('summaryExport.col.totalDone'), dataIndex: 'total_done', width: 110, render: numOr },
      { title: t('summaryExport.col.overallRate'), dataIndex: 'overall_avg_rate', width: 130, render: rateOr },
      { title: t('summaryExport.col.pointsTotal'), dataIndex: 'points_total', width: 110, render: numOr },
    ]
    return [...base, ...dyn, ...tail]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, meta])

  // ── 窄屏卡片视图：只挑手机上看得过来的字段，动态类型列排在最后 ──
  const MCARD = 10
  const dynKeys = Object.keys(data?.types || {})
  const pickCols = (cols: any[], keys: string[], withDyn = false) => [
    ...keys.map((k) => cols.find((c) => String(c.dataIndex ?? c.key) === k)),
    ...(withDyn ? dynKeys.map((k) => cols.find((c) => String(c.key) === k)) : []),
  ].filter(Boolean) as any[]
  const cardList = (rows: any[], cols: any[], rowKey: any) => (
    <MobileCardTable
      dataSource={(rows || []).slice((mPage - 1) * MCARD, mPage * MCARD)}
      columns={cols}
      rowKey={rowKey}
      pagination={{ current: mPage, pageSize: MCARD, total: (rows || []).length, onChange: setMPage }}
    />
  )

  const scopeText = [
    grade || t('summaryExport.scope.allGrades'),
    cls,
    students.length ? t('summaryExport.scope.pickedStudents', { count: students.length }) : '',
    types.length ? `${t('summaryExport.scope.types')}: ${types.length}` : t('summaryExport.scope.allTypes'),
    range?.[0] || range?.[1] ? `${range?.[0]?.format('YYYY-MM-DD') || '…'} ~ ${range?.[1]?.format('YYYY-MM-DD') || '…'}` : '',
    teacher ? `${t('summaryExport.teacher')}: ${meta?.teachers?.find((x) => x.username === teacher)?.name || teacher}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div style={{ padding: 16 }}>
      <Title level={4} style={{ marginBottom: 4 }}>{t('summaryExport.title')}</Title>
      <Text type="secondary">{t('summaryExport.subtitle')}</Text>

      <Card size="small" style={{ margin: '12px 0' }}>
        <Space wrap size={8}>
          <Select
            style={{ minWidth: 120 }} allowClear placeholder={t('summaryExport.grade')}
            value={grade || undefined} loading={metaLoading}
            onChange={(v) => setGrade(v || '')}
            options={(meta?.grades || []).map((g) => ({ value: g, label: g }))}
          />
          <Select
            style={{ minWidth: 120 }} allowClear placeholder={t('summaryExport.class')}
            value={cls || undefined} disabled={!grade} loading={classesLoading}
            onChange={(v) => setCls(v || '')}
            options={classOptions.map((c) => ({ value: c, label: c }))}
          />
          <Select
            mode="multiple" allowClear showSearch maxTagCount={3} style={{ minWidth: 220 }}
            placeholder={grade ? t('summaryExport.students') : t('summaryExport.pickGradeFirst')}
            optionFilterProp="label" disabled={!grade} loading={studentsLoading}
            value={students} onChange={setStudents} options={studentOptions}
          />
          {studentsMeta.truncated && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('summaryExport.studentsTruncated', { shown: studentList.length, total: studentsMeta.total })}
            </Text>
          )}
          <Select
            mode="multiple" allowClear maxTagCount={3} style={{ minWidth: 220 }}
            placeholder={t('summaryExport.types')}
            value={types} onChange={setTypes}
            options={typeList.map((x) => ({
              value: x.key,
              label: t(`summaryExport.type.${x.key}`, { defaultValue: x.label }),
            }))}
          />
          <RangePicker
            value={range as [Dayjs, Dayjs] | null}
            onChange={(v) => setRange(v as [Dayjs | null, Dayjs | null] | null)}
          />
          {meta?.is_admin && (
            <Select
              style={{ minWidth: 150 }} allowClear showSearch optionFilterProp="label"
              placeholder={t('summaryExport.teacher')}
              value={teacher || undefined} onChange={(v) => setTeacher(v || '')}
              options={(meta.teachers || []).map((x) => ({ value: x.username, label: `${x.name} (${x.username})` }))}
            />
          )}
          <Tooltip title={t('summaryExport.reloadMetaTip')}>
            <Button icon={<ReloadOutlined />} onClick={() => void loadMeta()} />
          </Tooltip>
          <Button type="primary" icon={<ThunderboltOutlined />} loading={loading} onClick={() => void doPreview()}>
            {t('summaryExport.query')}
          </Button>
          <Button
            icon={<FileExcelOutlined />} disabled={!data || !!exporting}
            loading={exporting === 'excel'}
            onClick={() => void openDownload('excel')}
          >
            {t('summaryExport.excel')}
          </Button>
          <Dropdown
            disabled={!data || !!exporting}
            menu={{
              items: [
                { key: 'records', label: t('summaryExport.csvSheets.records') },
                { key: 'student', label: t('summaryExport.csvSheets.student') },
                { key: 'activity', label: t('summaryExport.csvSheets.activity') },
                { key: 'class', label: t('summaryExport.csvSheets.class') },
              ],
              onClick: ({ key }) => void openDownload('csv', key as CsvSheetKey),
            }}
          >
            <Button icon={<FileTextOutlined />} loading={exporting === 'csv'} disabled={!data || !!exporting}>
              {t('summaryExport.csv')} <DownloadOutlined />
            </Button>
          </Dropdown>
        </Space>
      </Card>

      {data && (
        <Card
          className="se-scope-card"
          size="small"
          title={<Space><Text>{t('summaryExport.scopeLabel')}：{scopeText}</Text></Space>}
          extra={
            <Text type="secondary">
              {t('summaryExport.stats', {
                population: data.population_size,
                records: data.total_records,
                preview: data.records.length,
              })}
            </Text>
          }
        >
          <Tabs
            className="se-tabs"
            activeKey={activeTab}
            onChange={(k) => { setActiveTab(k); setMPage(1) }}
            items={[
              {
                key: 'records',
                label: t('summaryExport.tabs.records'),
                children: (
                  isMobile ?
                    cardList(data.records, pickCols(recordColumns, ['student_name', 'type_label', 'activity_title', 'score', 'rate', 'time']),
                      (r: SummaryRecord) => `${r.username}|${r.type}|${r.activity_id}|${r.time}`)
                    :
                  <Table<SummaryRecord>
                    rowKey={(r) => `${r.username}|${r.type}|${r.activity_id}|${r.time}`}
                    size="small" columns={recordColumns} dataSource={data.records}
                    scroll={{ x: 1080 }}
                    pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (x) => `${x}` }}
                  />
                ),
              },
              {
                key: 'student',
                label: t('summaryExport.tabs.student'),
                children: (
                  isMobile ?
                    cardList(data.by_student, pickCols(studentColumns, ['name', 'username', 'total_done', 'overall_avg_rate'], true), 'username') :
                  <Table<StudentAggRow>
                    rowKey="username" size="small" columns={studentColumns}
                    dataSource={data.by_student} scroll={{ x: 1300 }}
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                  />
                ),
              },
              {
                key: 'activity',
                label: t('summaryExport.tabs.activity'),
                children: (
                  isMobile ?
                    cardList(data.by_activity, pickCols(activityColumns, ['type_label', 'activity_title', 'participants', 'participation_rate', 'avg_rate', 'pass_rate']),
                      (r: ActivityAggRow) => `${r.type}|${r.activity_id}`) :
                  <Table<ActivityAggRow>
                    rowKey={(r) => `${r.type}|${r.activity_id}`} size="small"
                    columns={activityColumns} dataSource={data.by_activity} scroll={{ x: 1000 }}
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                  />
                ),
              },
              {
                key: 'class',
                label: t('summaryExport.tabs.class'),
                children: (
                  isMobile ?
                    cardList(data.by_class, pickCols(classColumns, ['grade', 'class_name', 'students', 'total_done', 'overall_avg_rate', 'points_total'], true),
                      (r: ClassAggRow) => `${r.grade}|${r.class_name}`) :
                  <Table<ClassAggRow>
                    rowKey={(r) => `${r.grade}|${r.class_name}`} size="small"
                    columns={classColumns} dataSource={data.by_class} scroll={{ x: 1250 }}
                    pagination={false}
                  />
                ),
              },
            ]}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>{t('summaryExport.previewNote')}</Text>
        </Card>
      )}
    </div>
  )
}

export default SummaryExportPage
