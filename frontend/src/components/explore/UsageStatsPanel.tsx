/**
 * 探索画布 · 使用情况统计（教师/管理员可见）
 * 隐私口径：仅行为计数与时间，不含提问内容/画布内容。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input, Select, Table, Tag, Tooltip, message } from 'antd'
import { ReloadOutlined, SafetyCertificateOutlined, WarningOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { careEvents, usageStats, type CareEventsData, type CareStudentRow, type UsageStudentRow, type UsageStatsData } from '../../api/explore'

interface Props { readonly?: boolean }

const UsageStatsPanel: React.FC<Props> = () => {
  const { t } = useTranslation('explore')
  const [data, setData] = useState<UsageStatsData | null>(null)
  const [care, setCare] = useState<CareEventsData | null>(null)
  const [days, setDays] = useState(14)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [gradeFilter, setGradeFilter] = useState<string>('')
  const [classFilter, setClassFilter] = useState<string>('')
  // 默认只看有使用记录的学生：1400 行零值是噪音，勾掉可看全员
  const [onlyActive, setOnlyActive] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try { setData(await usageStats(days)) }
    catch (e: any) { message.error(e?.response?.data?.detail || t('statsLoadFail')) }
    finally { setLoading(false) }
    // 关怀台账仅管理员可读：教师拿 403 属于正常，静默不显示即可
    try { setCare(await careEvents(days)) }
    catch { setCare(null) }
  }, [days, t])

  useEffect(() => { void load() }, [load])

  const rows = useMemo(() => {
    let r = data?.students || []
    if (gradeFilter) r = r.filter((x) => x.grade === gradeFilter)
    if (classFilter) r = r.filter((x) => String(x.class) === classFilter)
    const kw = query.trim()
    if (kw) r = r.filter((x) => (x.name + x.username + x.class + x.grade).includes(kw))
    if (onlyActive) r = r.filter((x) => x.active_days > 0
      || x.asks + x.topics + x.svgs + x.minds + x.images + x.tts + x.archives + x.points + x.badges > 0
      || x.canvases > 0 || !!x.last_active)
    return r
  }, [data, query, gradeFilter, classFilter, onlyActive])

  const gradeOptions = useMemo(() => {
    const seen: string[] = []
    for (const x of data?.students || []) if (x.grade && !seen.includes(x.grade)) seen.push(x.grade)
    return seen.map((g) => ({ value: g, label: g }))
  }, [data])
  const classOptions = useMemo(() => {
    const set = new Set((data?.students || [])
      .filter((x) => !gradeFilter || x.grade === gradeFilter)
      .map((x) => String(x.class || '').trim()).filter(Boolean))
    return Array.from(set).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
      .map((s) => ({ value: s, label: s + ' ' + t('classSuffix') }))
  }, [data, gradeFilter, t])

  const maxAsks = Math.max(1, ...(data?.trend || []).map((x) => x.asks))

  // 关怀台账跟随上面同一套年级/班级/搜索筛选，管理员点通知进来就能直接定位到人
  const careRows = useMemo(() => {
    let r = care?.students || []
    if (gradeFilter) r = r.filter((x) => x.grade === gradeFilter)
    if (classFilter) r = r.filter((x) => String(x.class) === classFilter)
    const kw = query.trim()
    if (kw) r = r.filter((x) => (x.name + x.username + x.class + x.grade).includes(kw))
    return r
  }, [care, gradeFilter, classFilter, query])

  const careCols = [
    { title: t('careColStudent'), dataIndex: 'name', key: 'cn', width: 150,
      render: (_: string, r: CareStudentRow) => <span>{r.name}<span style={{ color: '#aab', fontSize: 11, marginInlineStart: 4 }}>{r.username}</span></span> },
    { title: t('careColClass'), key: 'cc', width: 110,
      render: (_: unknown, r: CareStudentRow) => `${r.grade} ${r.class ? r.class + ' ' + t('classSuffix') : ''}`.trim() || '—' },
    { title: t('careColCount'), key: 'cnt', width: 130,
      render: (_: unknown, r: CareStudentRow) => <>
        <Tag color="orange">{r.count}</Tag>
        {r.flag_count > 0 && <Tooltip title={t('careFlagTip')}><Tag color="gold">{t('careFlagTag', { n: r.flag_count })}</Tag></Tooltip>}
      </> },
    { title: t('careColLast'), dataIndex: 'last_at', key: 'ca', width: 150, render: (v: string) => v || '—' },
  ]

  const cols = [
    { title: t('stColStudent'), dataIndex: 'name', key: 'name', fixed: 'left' as const, width: 130,
      render: (_: string, r: UsageStudentRow) => <span>{r.name}<span style={{ color: '#aab', fontSize: 11, marginInlineStart: 4 }}>{r.username}</span></span> },
    { title: t('stColClass'), key: 'cls', width: 100, render: (_: unknown, r: UsageStudentRow) => `${r.grade} ${r.class ? r.class + ' 班' : ''}` },
    { title: t('stColActiveDays'), dataIndex: 'active_days', key: 'ad', width: 84, sorter: (a: UsageStudentRow, b: UsageStudentRow) => a.active_days - b.active_days, defaultSortOrder: 'descend' as const },
    { title: t('stColAsks'), dataIndex: 'asks', key: 'asks', width: 76, sorter: (a: UsageStudentRow, b: UsageStudentRow) => a.asks - b.asks,
      render: (v: number) => v > 0 ? <Tag color="blue">{v}</Tag> : v },
    { title: t('stColTopics'), dataIndex: 'topics', key: 'tp', width: 76 },
    { title: t('stColSvgs'), dataIndex: 'svgs', key: 'sv', width: 76 },
    { title: t('stColMinds'), dataIndex: 'minds', key: 'md', width: 76 },
    { title: t('stColImages'), dataIndex: 'images', key: 'im', width: 76 },
    { title: t('stColTts'), dataIndex: 'tts', key: 'tt', width: 76 },
    { title: t('stColArchives'), dataIndex: 'archives', key: 'ar', width: 84, sorter: (a: UsageStudentRow, b: UsageStudentRow) => a.archives - b.archives,
      render: (v: number) => v > 0 ? <Tag color="green">{v}</Tag> : v },
    { title: t('stColPoints'), dataIndex: 'points', key: 'pt', width: 80 },
    { title: t('stColBadges'), dataIndex: 'badges', key: 'bd', width: 80 },
    { title: t('stColCanvases'), key: 'cv', width: 90, render: (_: unknown, r: UsageStudentRow) => `${r.canvases} / ${r.pages}` },
    { title: t('stColLast'), dataIndex: 'last_active', key: 'la', width: 130, render: (v: string) => v || '—' },
  ]

  const s = data?.summary
  return (
    <div style={{ paddingTop: 4 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Select value={days} onChange={setDays} style={{ width: 110 }}
          options={[{ value: 7, label: t('statsDays7') }, { value: 14, label: t('statsDays14') }, { value: 30, label: t('statsDays30') }]} />
        <span style={{ fontSize: 13 }}><b>{t('statsGradeLabel')}</b></span>
        <Select allowClear placeholder={t('statsGradePh')} value={gradeFilter || undefined} onChange={(v) => { setGradeFilter(v || ''); setClassFilter('') }} options={gradeOptions} style={{ width: 110 }} />
        <span style={{ fontSize: 13 }}><b>{t('statsClassLabel')}</b></span>
        <Select allowClear placeholder={t('statsClassPh')} value={classFilter || undefined} onChange={(v) => setClassFilter(v || '')}
          options={classOptions} style={{ width: 110 }} />
        <Input allowClear placeholder={t('statsSearchPh')} value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 180 }} />
        <Checkbox checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)}>{t('statsOnlyActive')}</Checkbox>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('statsRefresh')}</Button>
      </div>
      {s && (
        <div style={{ color: 'var(--text-secondary, #888)', fontSize: 12, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>{t('statsSummary', { students: s.students, active: s.active_recent, asks: s.asks_total, archives: s.archives_total })}</span>
          <Tag style={{ marginInlineStart: 0 }} color={s.scope === 'all' ? 'purple' : 'blue'}>{s.scope === 'all' ? t('statsScopeAll') : t('statsScopeTeacher')}</Tag>
        </div>
      )}

      {careRows.length > 0 && (
        <div style={{ marginBottom: 12, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 10, padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, marginBottom: 4, color: '#874d00' }}>
            <WarningOutlined />
            {t('careTitle')}
            <Tag color="orange" style={{ marginInlineStart: 4 }}>{care?.total ?? 0}</Tag>
          </div>
          <div style={{ fontSize: 12, color: '#8c6d1f', marginBottom: 8 }}>{t('careNote')}</div>
          <Table
            rowKey="username"
            size="small"
            pagination={careRows.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
            dataSource={careRows}
            columns={careCols as never}
          />
        </div>
      )}

      {!!(data?.trend?.length) && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 72, marginBottom: 12, padding: '0 2px' }}>
          {data!.trend.slice(-14).map((d) => (
            <Tooltip key={d.date} title={d.date + ' · ' + t('statsTrendTip', { asks: d.asks, active: d.active, archives: d.archives })}>
              <div style={{ flex: 1, maxWidth: 40, textAlign: 'center' }}>
                <div style={{ height: 48, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
                  <div style={{ width: '60%', borderRadius: 3, background: '#69b1ff', height: Math.max(3, Math.round((d.asks / maxAsks) * 46)) }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary, #999)' }}>{d.date.slice(5)}</div>
              </div>
            </Tooltip>
          ))}
        </div>
      )}

      <Table
        rowKey="username"
        size="small"
        loading={loading}
        dataSource={rows as UsageStudentRow[]}
        columns={cols as never}
        scroll={{ x: 1200 }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (n) => t('statsTotal', { n }) }}
      />

      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary, #999)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <SafetyCertificateOutlined />
        {t('statsPrivacyNote')}
      </div>
    </div>
  )
}

export default UsageStatsPanel