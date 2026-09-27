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

const { Title, Text } = Typography
const { RangePicker } = DatePicker

type CsvSheetKey = 'records' | 'student' | 'activity' | 'class'

const KIND_COLORS: Record<string, string> = { score: 'blue', participation: 'green', points: 'gold' }

const numOr = (v: number | null | undefined): React.ReactNode =>
  v === null || v === undefined || Number.isNaN(v) ? '-' : v

const rateOr = (v: number | null | undefined): React.ReactNode =>
  v === null || v === undefined ? '-' : `${v}%`

const SummaryExportPage: React.FC = () => {
  const { t } = useTranslation('summary')

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
  const [activeTab, setActiveTab] = useState('records')

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

  const openDownload = (kind: 'excel' | 'csv', sheet?: CsvSheetKey) => {
    window.open(summaryDownloadUrl(kind, currentFilters, sheet), '_blank')
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
  const recordColumns: ColumnsType<SummaryRecord> = [
    { title: t('summaryExport.col.grade'), dataIndex: 'grade', width: 80 },
    { title: t('summaryExport.col.class'), dataIndex: 'class_name', width: 70 },
    { title: t('summaryExport.col.student'), dataIndex: 'student_name', width: 100 },
    { title: t('summaryExport.col.username'), dataIndex: 'username', width: 100 },
    {
      title: t('summaryExport.col.type'), dataIndex: 'type_label', width: 110,
      render: (_: string, r) => <Tag color={KIND_COLORS[r.kind]}>{r.type_label}</Tag>,
    },
    { title: t('summaryExport.col.activity'), dataIndex: 'activity_title', ellipsis: true },
    { title: t('summaryExport.col.creator'), dataIndex: 'creator_name', width: 90 },
    { title: t('summaryExport.col.score'), dataIndex: 'score', width: 80, render: numOr },
    { title: t('summaryExport.col.total'), dataIndex: 'total_score', width: 80, render: numOr },
    { title: t('summaryExport.col.rate'), dataIndex: 'rate', width: 90, render: rateOr },
    { title: t('summaryExport.col.status'), dataIndex: 'status', width: 130 },
    { title: t('summaryExport.col.time'), dataIndex: 'time', width: 160 },
  ]

  // ── 学生汇总列 (动态类型矩阵) ──
  const studentColumns: ColumnsType<StudentAggRow> = useMemo(() => {
    const base: ColumnsType<StudentAggRow> = [
      { title: t('summaryExport.col.grade'), dataIndex: 'grade', width: 80, fixed: 'left' },
      { title: t('summaryExport.col.class'), dataIndex: 'class_name', width: 70, fixed: 'left' },
      { title: t('summaryExport.col.student'), dataIndex: 'name', width: 100, fixed: 'left' },
      { title: t('summaryExport.col.username'), dataIndex: 'username', width: 100 },
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
    { title: 'ID', dataIndex: 'activity_id', width: 70, render: numOr },
    { title: t('summaryExport.col.activity'), dataIndex: 'activity_title', ellipsis: true },
    { title: t('summaryExport.col.creator'), dataIndex: 'creator_name', width: 90 },
    { title: t('summaryExport.col.expected'), dataIndex: 'expected', width: 90, render: numOr },
    { title: t('summaryExport.col.participants'), dataIndex: 'participants', width: 90, render: numOr },
    { title: t('summaryExport.col.participationRate'), dataIndex: 'participation_rate', width: 100, render: rateOr },
    { title: t('summaryExport.col.avgRate'), dataIndex: 'avg_rate', width: 100, render: rateOr },
    { title: t('summaryExport.col.maxRate'), dataIndex: 'max_rate', width: 90, render: rateOr },
    { title: t('summaryExport.col.minRate'), dataIndex: 'min_rate', width: 90, render: rateOr },
    { title: t('summaryExport.col.passRate'), dataIndex: 'pass_rate', width: 90, render: rateOr },
    { title: t('summaryExport.col.lastTime'), dataIndex: 'last_time', width: 160, render: (v: string) => v || '-' },
  ]

  // ── 按班级汇总列 ──
  const classColumns: ColumnsType<ClassAggRow> = useMemo(() => {
    const base: ColumnsType<ClassAggRow> = [
      { title: t('summaryExport.col.grade'), dataIndex: 'grade', width: 80 },
      { title: t('summaryExport.col.class'), dataIndex: 'class_name', width: 70 },
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
            icon={<FileExcelOutlined />} disabled={!data}
            onClick={() => openDownload('excel')}
          >
            {t('summaryExport.excel')}
          </Button>
          <Dropdown
            disabled={!data}
            menu={{
              items: [
                { key: 'records', label: t('summaryExport.csvSheets.records') },
                { key: 'student', label: t('summaryExport.csvSheets.student') },
                { key: 'activity', label: t('summaryExport.csvSheets.activity') },
                { key: 'class', label: t('summaryExport.csvSheets.class') },
              ],
              onClick: ({ key }) => openDownload('csv', key as CsvSheetKey),
            }}
          >
            <Button icon={<FileTextOutlined />}>{t('summaryExport.csv')} <DownloadOutlined /></Button>
          </Dropdown>
        </Space>
      </Card>

      {data && (
        <Card
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
            activeKey={activeTab}
            onChange={setActiveTab}
            items={[
              {
                key: 'records',
                label: t('summaryExport.tabs.records'),
                children: (
                  <Table<SummaryRecord>
                    rowKey={(r) => `${r.username}|${r.type}|${r.activity_id}|${r.time}`}
                    size="small" columns={recordColumns} dataSource={data.records}
                    scroll={{ x: 1300 }}
                    pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (x) => `${x}` }}
                  />
                ),
              },
              {
                key: 'student',
                label: t('summaryExport.tabs.student'),
                children: (
                  <Table<StudentAggRow>
                    rowKey="username" size="small" columns={studentColumns}
                    dataSource={data.by_student} scroll={{ x: 1600 }}
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                  />
                ),
              },
              {
                key: 'activity',
                label: t('summaryExport.tabs.activity'),
                children: (
                  <Table<ActivityAggRow>
                    rowKey={(r) => `${r.type}|${r.activity_id}`} size="small"
                    columns={activityColumns} dataSource={data.by_activity} scroll={{ x: 1400 }}
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                  />
                ),
              },
              {
                key: 'class',
                label: t('summaryExport.tabs.class'),
                children: (
                  <Table<ClassAggRow>
                    rowKey={(r) => `${r.grade}|${r.class_name}`} size="small"
                    columns={classColumns} dataSource={data.by_class} scroll={{ x: 1500 }}
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