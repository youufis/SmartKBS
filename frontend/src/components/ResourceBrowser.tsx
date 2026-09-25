/**
 * 资源共享浏览器：左侧分类栏 + 顶部统计条 + 网格/列表双视图
 * 学生端「共享资源」与教师端「共享给我的」共用，靠 mode 切换分类维度与默认视图
 * variant='files' 时是「共享文件」浏览器：条目可以是目录（点进去浏览文件夹）或单个文件（直接下载）
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  Button, Card, Empty, Input, Pagination, Select, Space, Spin, Tag, theme, Tooltip, Typography,
} from 'antd'
import {
  AppstoreOutlined, BarsOutlined, BookOutlined, ClockCircleOutlined, CloseCircleOutlined,
  DownloadOutlined, EyeInvisibleOutlined, EyeOutlined, FileZipOutlined, FolderOpenOutlined,
  FolderOutlined, GlobalOutlined, InboxOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  ReloadOutlined, SearchOutlined, ShareAltOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useThemeStore } from '../stores/themeStore'
import { getFileIcon } from '../utils/fileIcon'
import { compactClassScope } from '../utils/classScope'
import { getFileKind, KIND_COLOR, DOC_KINDS, MEDIA_KINDS } from '../utils/fileKind'

const { Text } = Typography

export interface BrowserItem {
  id: number
  name: string
  urlPath: string
  filePath: string
  resourceType: string
  ownerUsername: string
  ownerName?: string
  ownerRole?: number | null
  shareScope?: string
  targetGrade?: string
  targetClass?: string
  createdAt?: string
  viewedAt?: string | null
  viewCount?: number
  courseName?: string
  kpName?: string
  bindingCount?: number
  /** 条目类型：dir=目录型共享（点开是浏览文件夹），其余按单个文件处理 */
  entryType?: 'file' | 'dir'
  /** 名称后面的补充信息（文件大小、目录内文件数），只展示不参与分类 */
  sub?: string
}

type Dim = 'status' | 'time' | 'kind' | 'course' | 'owner' | 'scope'
interface Sel { dim: Dim | null; value: string }

const DAY = 86400000

const UNGROUPED = '__none__'

const ResourceBrowser: React.FC<{
  items: BrowserItem[]
  mode: 'student' | 'teacher'
  /** html=课件资源（默认，与旧版行为一致）；files=共享文件（含目录型条目） */
  variant?: 'html' | 'files'
  loading?: boolean
  onOpen: (item: BrowserItem) => void
  onReshare?: (item: BrowserItem) => void
  /** 逐条目判断能否「再共享」：文件中心里只有自己名下也有同一份时才值得再共享 */
  canReshare?: (item: BrowserItem) => boolean
  /** 覆盖条目主操作按钮的文案与图标（文件版是「下载」/「浏览」） */
  openLabel?: string
  openIcon?: React.ReactNode
  /** 是否显示「阅读状态」维度。教师端浏览文件不留痕，默认给关掉免得永远「未读」 */
  showStatus?: boolean
  onRefresh?: () => void
}> = ({ items, mode, variant = 'html', loading, onOpen, onReshare, canReshare, openLabel, openIcon, showStatus, onRefresh }) => {
  const { t } = useTranslation('menu')
  const { token } = theme.useToken()
  const isDark = useThemeStore((s) => s.current) === 'midnight'
  const isFiles = variant === 'files'
  // 阅读状态：HTML 侧维持原样；文件侧只有学生有浏览留痕
  const showStatusOn = showStatus ?? !(isFiles && mode === 'teacher')
  // 偏好分开存，避免「共享文件」把「共享资源」的视图/排序/每页条数覆盖掉
  const prefKey = isFiles ? `smartkb_rb_files_${mode}` : `smartkb_rb_${mode}`

  const [kw, setKw] = useState('')
  const [sel, setSel] = useState<Sel>({ dim: null, value: '' })
  const [sort, setSort] = useState(showStatusOn ? 'unseen' : 'new')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(24)
  const [collapsed, setCollapsed] = useState(false)
  const [nowMs, setNowMs] = useState(0)

  // 时间基准放进 state：渲染期不取时间，倒计时/相对时间随数据刷新推进
  useEffect(() => { setNowMs(Date.now()) }, [items])

  // 记住偏好（学生端与教师端分开记）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(prefKey)
      if (raw) {
        const p = JSON.parse(raw) as { view?: string; sort?: string; pageSize?: number }
        if (p.view === 'grid' || p.view === 'list') setView(p.view)
        if (p.sort) setSort(p.sort)
        if (p.pageSize) setPageSize(p.pageSize)
      }
    } catch { /* 隐私模式忽略 */ }
  }, [prefKey])

  useEffect(() => {
    try { localStorage.setItem(prefKey, JSON.stringify({ view, sort, pageSize })) } catch { /* 忽略 */ }
  }, [prefKey, view, sort, pageSize])

  useEffect(() => { setPage(1) }, [kw, sel, sort, mode])

  const kindOf = (it: BrowserItem) =>
    it.entryType === 'dir' ? 'dir' : getFileKind(it.filePath || it.name || '')
  /** 是否给这条目摆「再共享」按钮（外部可逐条判断） */
  const canShare = (it: BrowserItem) => (canReshare ? canReshare(it) : !!onReshare)
  /** 目录条目统一用「打开的文件夹」图标，不跟扩展名猜 */
  const entryIcon = (it: BrowserItem, fontSize: number) =>
    it.entryType === 'dir'
      ? <FolderOpenOutlined style={{ color: KIND_COLOR.dir, fontSize }} />
      : getFileIcon(it.filePath || it.name, { fontSize })
  /** 条目主操作：目录/文件的行为差异由调用方的 onOpen 决定 */
  const itemOpen = (it: BrowserItem) => onOpen(it)
  /** 条目主操作按钮：外部指定优先，否则目录=浏览、文件=下载、课件=打开 */
  const openTextOf = (it: BrowserItem) =>
    openLabel || (isFiles ? (it.entryType === 'dir' ? t('rb.browse') : t('rb.download')) : t('rb.open'))
  const openIconOf = (it: BrowserItem) =>
    openIcon
    || (isFiles
      ? (it.entryType === 'dir' ? <FolderOpenOutlined /> : <DownloadOutlined />)
      : <GlobalOutlined />)

  const searched = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return items
    return items.filter((it) =>
      `${it.name} ${it.ownerName || ''} ${it.ownerUsername} ${it.courseName || ''} ${it.kpName || ''}`
        .toLowerCase().includes(k))
  }, [items, kw])

  const inWeek = (ts?: string) => {
    if (!ts || !nowMs) return false
    const d = new Date(ts.trim().replace(' ', 'T')).getTime()
    return !Number.isNaN(d) && nowMs - d <= 7 * DAY
  }
  const inMonth = (ts?: string) => {
    if (!ts || !nowMs) return false
    const d = new Date(ts.trim().replace(' ', 'T')).getTime()
    return !Number.isNaN(d) && nowMs - d <= 30 * DAY
  }

  const matchSel = (it: BrowserItem): boolean => {
    if (!sel.dim) return true
    switch (sel.dim) {
      case 'status': return sel.value === 'unseen' ? !it.viewedAt : !!it.viewedAt
      case 'time':
        if (sel.value === 'week') return inWeek(it.createdAt)
        if (sel.value === 'month') return inMonth(it.createdAt) && !inWeek(it.createdAt)
        return !inMonth(it.createdAt)
      case 'kind': return kindOf(it) === sel.value
      case 'course': return (it.courseName || UNGROUPED) === sel.value
      case 'owner': return (it.ownerName || it.ownerUsername) === sel.value
      case 'scope': return (it.shareScope || '') === sel.value
      default: return true
    }
  }

  const shown = useMemo(() => {
    const arr = searched.filter(matchSel)
    const cmp = (a: BrowserItem, b: BrowserItem) => {
      switch (sort) {
        case 'new': return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        case 'name': return a.name.localeCompare(b.name, 'zh-Hans-CN')
        case 'owner': return String(a.ownerName || a.ownerUsername).localeCompare(String(b.ownerName || b.ownerUsername), 'zh-Hans-CN')
        case 'unseen':
        default: {
          const av = a.viewedAt ? 1 : 0
          const bv = b.viewedAt ? 1 : 0
          return av - bv || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
        }
      }
    }
    return [...arr].sort(cmp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, sel, sort, nowMs])

  const paged = useMemo(() => shown.slice((page - 1) * pageSize, page * pageSize), [shown, page, pageSize])

  // ── 各维度的选项与计数（计数基于「已搜索、未分类」的集合，保证与点击后看到的一致）──
  const facet = (pred: (it: BrowserItem) => boolean) => searched.filter(pred).length
  const kindOptions = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of searched) m.set(kindOf(i), (m.get(kindOf(i)) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
      .map(([v, n]) => ({ value: v, label: t(`kind.${v}`), n }))
  }, [searched, t])
  const courseOptions = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of searched) {
      const key = i.courseName || UNGROUPED
      m.set(key, (m.get(key) || 0) + 1)
    }
    const rows = [...m.entries()].filter(([k]) => k !== UNGROUPED).sort((a, b) => b[1] - a[1])
    const none = m.get(UNGROUPED)
    if (none) rows.push([t('rb.noCourse'), none])
    return rows.map(([v, n]) => ({ value: v === t('rb.noCourse') ? UNGROUPED : v, label: v, n }))
  }, [searched, t])
  const ownerOptions = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of searched) {
      const key = i.ownerName || i.ownerUsername
      m.set(key, (m.get(key) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, label: v, n }))
  }, [searched])
  const scopeOptions = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of searched) m.set(i.shareScope || '?', (m.get(i.shareScope || '?') || 0) + 1)
    const label = (v: string) => v === 'all' ? t('rb.scopeAll') : v === 'staff' ? t('rb.scopeStaff')
      : v === 'class' ? t('rb.scopeClass') : v === 'teacher' ? t('rb.scopeUser') : v
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, label: label(v), n }))
  }, [searched, t])

  const DIMS: { key: Dim; label: string; icon: React.ReactNode; options: { value: string; label: string; n: number }[] }[] = [
    ...(showStatusOn ? [{
      key: 'status' as Dim,
      label: t('rb.dimStatus'),
      icon: <EyeOutlined />,
      options: [
        { value: 'unseen', label: mode === 'teacher' ? t('rb.unread') : t('rb.unseen'), n: facet((i: BrowserItem) => !i.viewedAt) },
        { value: 'seen', label: mode === 'teacher' ? t('rb.read') : t('rb.seen'), n: facet((i: BrowserItem) => !!i.viewedAt) },
      ],
    }] : []),
    {
      key: 'time',
      label: t('rb.dimTime'),
      icon: <ClockCircleOutlined />,
      options: [
        { value: 'week', label: t('rb.thisWeek'), n: facet((i) => inWeek(i.createdAt)) },
        { value: 'month', label: t('rb.thisMonth'), n: facet((i) => inMonth(i.createdAt) && !inWeek(i.createdAt)) },
        { value: 'earlier', label: t('rb.earlier'), n: facet((i) => !inMonth(i.createdAt)) },
      ],
    },
    {
      key: 'kind',
      label: isFiles ? t('rb.dimKindFiles') : t('rb.dimKind'),
      icon: <AppstoreOutlined />,
      options: kindOptions,
    },
    { key: 'course', label: t('rb.dimCourse'), icon: <BookOutlined />, options: courseOptions },
    { key: 'owner', label: t('rb.dimOwner'), icon: <TeamOutlined />, options: ownerOptions },
    { key: 'scope', label: t('rb.dimScope'), icon: <GlobalOutlined />, options: scopeOptions },
  ]

  const relTime = (ts?: string) => {
    if (!ts) return ''
    const d = new Date(ts.trim().replace(' ', 'T')).getTime()
    if (Number.isNaN(d)) return ts.slice(0, 10)
    if (!nowMs) return ts.slice(0, 10)
    const diff = nowMs - d
    if (diff < DAY) return t('rb.today')
    if (diff < 2 * DAY) return t('rb.yesterday')
    if (diff < 30 * DAY) return t('rb.daysAgo', { count: Math.floor(diff / DAY) })
    return ts.slice(0, 10)
  }

  const roleTag = (r?: number | null) =>
    r === 0 ? t('rb.ownerAdmin') : r === 1 ? t('rb.ownerTeacher') : r === 2 ? t('rb.ownerStudent') : ''

  const fullScope = (it: BrowserItem) => {
    const g = (it.targetGrade || '').trim()
    const list = String(it.targetClass || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean)
    if (!list.length) return g || t('rb.scopeClass')
    return `${g ? `${g} · ` : ''}${list.map((c) => (g && c.startsWith(g) ? c.slice(g.length) : c)).join('、')}`
  }

  const metaTags = (it: BrowserItem) => {
    const kind = kindOf(it)
    return (
      <Space size={4} wrap style={{ marginTop: 2 }}>
        {it.kpName && (
          <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0 }} color="blue">
            {it.kpName.length > 12 ? `${it.kpName.slice(0, 12)}…` : it.kpName}
          </Tag>
        )}
        <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0, color: KIND_COLOR[kind], borderColor: KIND_COLOR[kind], background: 'transparent' }}>
          {t(`kind.${kind}`)}
        </Tag>
        {it.shareScope && it.shareScope !== 'all' && (
          <Tooltip title={it.shareScope === 'class' ? fullScope(it) : undefined}>
            <Tag style={{ fontSize: 10, lineHeight: '16px', marginInlineEnd: 0, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle' }}>
              {it.shareScope === 'class'
                ? compactClassScope(it.targetGrade || '', it.targetClass || '') || t('rb.scopeClass')
                : it.shareScope === 'staff' ? t('rb.scopeStaff') : t('rb.scopeUser')}
            </Tag>
          </Tooltip>
        )}
      </Space>
    )
  }

  const stripCells: {
    key: string; label: string; n: number; color: string; icon: React.ReactNode; on: boolean; next: Sel
  }[] = [
    ...(showStatusOn ? [{
      key: 'unseen', label: mode === 'teacher' ? t('rb.unread') : t('rb.unseen'),
      n: facet((i: BrowserItem) => !i.viewedAt), color: token.colorError, icon: <EyeInvisibleOutlined />,
      on: sel.dim === 'status' && sel.value === 'unseen', next: { dim: 'status' as Dim, value: 'unseen' },
    }] : []),
    {
      key: 'week', label: t('rb.thisWeek'), n: facet((i) => inWeek(i.createdAt)),
      color: token.colorPrimary, icon: <ClockCircleOutlined />,
      on: sel.dim === 'time' && sel.value === 'week', next: { dim: 'time' as Dim, value: 'week' },
    },
    isFiles ? {
      key: 'dir', label: t('kind.dir'), n: facet((i) => i.entryType === 'dir'),
      color: KIND_COLOR.dir, icon: <FolderOpenOutlined />,
      on: sel.dim === 'kind' && sel.value === 'dir', next: { dim: 'kind' as Dim, value: 'dir' },
    } : {
      key: 'web', label: t('kind.web'), n: facet((i) => kindOf(i) === 'web'),
      color: KIND_COLOR.web, icon: <GlobalOutlined />,
      on: sel.dim === 'kind' && sel.value === 'web', next: { dim: 'kind' as Dim, value: 'web' },
    },
    {
      key: 'doc', label: t('rb.docGroup'), n: facet((i) => DOC_KINDS.includes(kindOf(i))),
      color: '#722ed1', icon: <FolderOutlined />,
      on: sel.dim === 'kind' && DOC_KINDS.includes(sel.value as never), next: { dim: 'kind' as Dim, value: 'word' },
    },
    isFiles ? {
      key: 'zip', label: t('kind.zip'), n: facet((i) => kindOf(i) === 'zip'),
      color: KIND_COLOR.zip, icon: <FileZipOutlined />,
      on: sel.dim === 'kind' && sel.value === 'zip', next: { dim: 'kind' as Dim, value: 'zip' },
    } : {
      key: 'media', label: t('rb.mediaGroup'), n: facet((i) => MEDIA_KINDS.includes(kindOf(i))),
      color: '#fa8c16', icon: <AppstoreOutlined />,
      on: sel.dim === 'kind' && MEDIA_KINDS.includes(sel.value as never), next: { dim: 'kind' as Dim, value: 'video' },
    },
  ]

  /** 已选分类的展示文案（避免把 unseen/week/class 这类代码直接丢到界面上） */
  const valueLabel = (sl: Sel): string => {
    if (!sl.dim) return ''
    if (sl.dim === 'kind') return t(`kind.${sl.value}` as never)
    if (sl.dim === 'status') {
      if (sl.value === 'unseen') return mode === 'teacher' ? t('rb.unread') : t('rb.unseen')
      return mode === 'teacher' ? t('rb.read') : t('rb.seen')
    }
    if (sl.dim === 'time') {
      return sl.value === 'week' ? t('rb.thisWeek') : sl.value === 'month' ? t('rb.thisMonth') : t('rb.earlier')
    }
    if (sl.dim === 'scope') {
      return sl.value === 'all' ? t('rb.scopeAll') : sl.value === 'staff' ? t('rb.scopeStaff')
        : sl.value === 'class' ? t('rb.scopeClass') : sl.value === 'teacher' ? t('rb.scopeUser') : sl.value
    }
    if (sl.dim === 'course') return sl.value === UNGROUPED ? t('rb.noCourse') : sl.value
    return sl.value
  }

  const border = `1px solid ${token.colorBorderSecondary}`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ─── 工具行 ─── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Space size={8} wrap>
          <Input
            allowClear size="small" style={{ width: 220 }}
            prefix={<SearchOutlined style={{ color: token.colorTextDescription }} />}
            placeholder={isFiles ? t('rb.searchPhFiles') : t('rb.searchPh')}
            value={kw} onChange={(e) => setKw(e.target.value)}
          />
          <Select
            size="small" style={{ width: 120 }} value={sort} onChange={setSort}
            options={[
              ...(showStatusOn ? [{ value: 'unseen', label: t('rb.sortUnseen') }] : []),
              { value: 'new', label: t('rb.sortNew') },
              { value: 'name', label: t('rb.sortName') },
              { value: 'owner', label: t('rb.sortOwner') },
            ]}
          />
        </Space>
        <Space size={6}>
          <Tooltip title={view === 'grid' ? t('rb.viewList') : t('rb.viewGrid')}>
            <Button size="small" icon={view === 'grid' ? <BarsOutlined /> : <AppstoreOutlined />} onClick={() => setView(view === 'grid' ? 'list' : 'grid')} />
          </Tooltip>
          {onRefresh && <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} loading={loading} />}
        </Space>
      </div>

      {/* ─── 统计条 ─── */}
      <Card size="small" styles={{ body: { padding: '2px 6px' } }} style={{ borderRadius: 8 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {stripCells.map((c, idx) => (
            <div
              key={c.key}
              role="button"
              tabIndex={0}
              onClick={() => setSel(c.on ? { dim: null, value: '' } : c.next)}
              onKeyDown={(e) => { if (e.key === 'Enter') setSel(c.on ? { dim: null, value: '' } : c.next) }}
              style={{
                flex: '1 1 116px', minWidth: 108, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px',
                borderInlineStart: idx === 0 ? 'none' : border,
                background: c.on ? (isDark ? 'rgba(79,140,255,0.12)' : `${c.color}12`) : 'transparent',
                boxShadow: c.on ? `inset 0 0 0 1px ${c.color}` : 'none',
              }}
            >
              <span style={{ fontSize: 16, color: c.n > 0 ? c.color : token.colorTextDescription }}>{c.icon}</span>
              <span style={{ minWidth: 0 }}>
                <Text type="secondary" style={{ fontSize: 11.5, display: 'block', lineHeight: 1.25, whiteSpace: 'nowrap' }}>{c.label}</Text>
                <span style={{ fontSize: 17, fontWeight: 600, color: c.n > 0 ? c.color : token.colorTextDescription }}>{c.n}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        {/* ─── 左侧分类栏 ─── */}
        <div style={{ width: collapsed ? 36 : 196, flexShrink: 0, transition: 'width .25s' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            {!collapsed && <Text strong style={{ fontSize: 13 }}>{t('rb.categories')}</Text>}
            <Button
              type="text" size="small"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              title={collapsed ? t('rb.expandPanel') : t('rb.collapsePanel')}
            />
          </div>
          {!collapsed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div
                onClick={() => setSel({ dim: null, value: '' })}
                style={{
                  padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500,
                  background: !sel.dim ? (isDark ? 'rgba(79,140,255,0.16)' : '#e6f4ff') : 'transparent',
                  color: !sel.dim ? token.colorPrimary : token.colorText,
                }}
              >
                <InboxOutlined style={{ marginRight: 6 }} />
                {isFiles ? t('rb.allFiles') : t('rb.all')} ({searched.length})
              </div>
              {DIMS.map((d) => (
                <div key={d.key} style={{ marginTop: 6 }}>
                  <Text type="secondary" style={{ fontSize: 11.5, display: 'block', padding: '2px 10px' }}>
                    <span style={{ marginRight: 4 }}>{d.icon}</span>{d.label}
                  </Text>
                  {d.options.map((o) => {
                    const on = sel.dim === d.key && sel.value === o.value
                    return (
                      <div
                        key={`${d.key}-${o.value}`}
                        onClick={() => setSel(on ? { dim: null, value: '' } : { dim: d.key, value: o.value })}
                        style={{
                          padding: '5px 10px 5px 18px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5,
                          display: 'flex', justifyContent: 'space-between', gap: 6,
                          background: on ? (isDark ? 'rgba(79,140,255,0.16)' : '#e6f4ff') : 'transparent',
                          color: on ? token.colorPrimary : token.colorText,
                        }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                        <span style={{ flexShrink: 0, color: on ? token.colorPrimary : token.colorTextDescription }}>{o.n}</span>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ─── 内容区 ─── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {sel.dim && (
            <Space size={6} style={{ marginBottom: 8 }}>
              <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                {DIMS.find((d) => d.key === sel.dim)?.label}: {valueLabel(sel)}
              </Tag>
              <Button type="link" size="small" style={{ padding: 0 }} icon={<CloseCircleOutlined />} onClick={() => setSel({ dim: null, value: '' })}>
                {t('rb.clearFilter')}
              </Button>
            </Space>
          )}

          <Spin spinning={!!loading}>
            {shown.length === 0 ? (
              <Card style={{ borderRadius: 8 }}>
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={<Text type="secondary">
                    {kw || sel.dim
                      ? t('rb.noMatch')
                      : mode === 'teacher'
                        ? (isFiles ? t('rb.emptyTeacherFiles') : t('rb.emptyTeacher'))
                        : (isFiles ? t('rb.emptyStudentFiles') : t('rb.emptyStudent'))}
                  </Text>}
                />
              </Card>
            ) : view === 'grid' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(252px, 1fr))', gap: 10 }}>
                {paged.map((it) => {
                  const kind = kindOf(it)
                  return (
                    <Card
                      key={it.id}
                      size="small"
                      hoverable
                      onClick={() => itemOpen(it)}
                      style={{ borderRadius: 8, cursor: 'pointer' }}
                      styles={{ body: { padding: '10px 12px' } }}
                    >
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 18, lineHeight: '22px', color: KIND_COLOR[kind], flexShrink: 0 }}>
                          {entryIcon(it, 18)}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                            overflow: 'hidden', fontSize: 13.5, fontWeight: 500, lineHeight: 1.35,
                          }}>
                            {it.name}
                          </div>
                          {it.sub && (
                            <Text type="secondary" style={{ fontSize: 11.5 }}>{it.sub}</Text>
                          )}
                          {metaTags(it)}
                        </div>
                        {showStatusOn && !it.viewedAt && (
                          <Tooltip title={mode === 'teacher' ? t('rb.unread') : t('rb.unseen')}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: token.colorError, flexShrink: 0, marginTop: 6 }} />
                          </Tooltip>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 8 }}>
                        <Text type="secondary" style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <UserOutlined style={{ marginRight: 4 }} />
                          {it.ownerName || it.ownerUsername}{roleTag(it.ownerRole) ? ` · ${roleTag(it.ownerRole)}` : ''}
                          {it.createdAt ? ` · ${relTime(it.createdAt)}` : ''}
                        </Text>
                        <Space size={4} style={{ flexShrink: 0 }}>
                          {(it.viewCount ?? 0) > 0 && (
                            <Text type="secondary" style={{ fontSize: 11 }}><EyeOutlined /> {it.viewCount}</Text>
                          )}
                          {onReshare && canShare(it) && (
                            <Tooltip title={t('rb.reshare')}>
                              <Button size="small" type="text" icon={<ShareAltOutlined style={{ fontSize: 13 }} />}
                                onClick={(e) => { e.stopPropagation(); onReshare(it) }} />
                            </Tooltip>
                          )}
                        </Space>
                      </div>
                    </Card>
                  )
                })}
              </div>
            ) : (
              <div style={{ border, borderRadius: 8, overflow: 'hidden' }}>
                {paged.map((it, idx) => {
                  const kind = kindOf(it)
                  return (
                    <div
                      key={it.id}
                      onClick={() => itemOpen(it)}
                      style={{
                        display: 'grid', gridTemplateColumns: 'minmax(180px,3fr) 1.2fr 0.9fr 1.1fr 0.8fr auto',
                        gap: 8, alignItems: 'center', padding: '9px 12px', cursor: 'pointer',
                        background: idx % 2 ? (isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)') : 'transparent',
                        borderBottom: idx === paged.length - 1 ? 'none' : border,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ flexShrink: 0 }}>{entryIcon(it, 16)}</span>
                        <Text style={{ fontSize: 13 }} ellipsis>{it.name}</Text>
                        {it.sub && (
                          <Text type="secondary" style={{ fontSize: 11.5, flexShrink: 0 }}>{it.sub}</Text>
                        )}
                        {showStatusOn && !it.viewedAt && (
                          <Tag color="red" style={{ fontSize: 10, marginInlineEnd: 0, lineHeight: '15px' }}>{mode === 'teacher' ? t('rb.unread') : t('rb.unseen')}</Tag>
                        )}
                      </div>
                      <Text type="secondary" style={{ fontSize: 12 }} ellipsis>{it.kpName || it.courseName || '—'}</Text>
                      <Tag style={{ fontSize: 10, marginInlineEnd: 0, color: KIND_COLOR[kind], borderColor: KIND_COLOR[kind], background: 'transparent' }}>{t(`kind.${kind}`)}</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }} ellipsis>{it.ownerName || it.ownerUsername}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>{relTime(it.createdAt)}</Text>
                      <Space size={4}>
                        {onReshare && canShare(it) && (
                          <Tooltip title={t('rb.reshare')}>
                            <Button size="small" type="text" icon={<ShareAltOutlined />} onClick={(e) => { e.stopPropagation(); onReshare(it) }} />
                          </Tooltip>
                        )}
                        <Button size="small" type="primary" ghost icon={openIconOf(it)} onClick={(e) => { e.stopPropagation(); itemOpen(it) }}>
                          {openTextOf(it)}
                        </Button>
                      </Space>
                    </div>
                  )
                })}
              </div>
            )}
          </Spin>

          {/* 文件版条目普遍少，一页装得下也保留这一行：总数与「每页条数」要能看见、能改 */}
          {shown.length > 0 && (shown.length > pageSize || isFiles) && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <Pagination
                size="small"
                current={page}
                pageSize={pageSize}
                total={shown.length}
                showSizeChanger
                pageSizeOptions={['12', '24', '48', '96']}
                onChange={(p, ps) => {
                  if (ps && ps !== pageSize) { setPageSize(ps); setPage(1) } else { setPage(p) }
                }}
                showTotal={(n) => t('rb.total', { count: n })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ResourceBrowser
