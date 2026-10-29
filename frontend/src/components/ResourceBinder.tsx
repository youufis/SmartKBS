/**
 * 知识点「绑定资源」管理弹窗
 *
 * 2026-10-26 改版（方案见 docs/kp-resource-binding/00-方案建议.md）：
 * 1. 类型清单不再在前端硬编码 —— 由 GET /resource-types 下发（后端 resource_registry.py
 *    是唯一真源），「任务」跟着全站改名「作业」、「同步练习」上架都只改一处。
 * 2. 类型一次只看一类（单选 chips，默认「网页资源」），但**已选篮跨类型累计**：
 *    勾几个课件 → 切到作业再勾一个 → 一次提交全绑上，不用为一个知识点开四遍弹窗。
 * 3. 资源一多也能选：左侧分类栏（知识点匹配 / 内容小类 / 学科 / 年级 / 时间 / 状态 /
 *    已绑情况 / 来源）+ 卡片网格，与「共享资源」页同一套交互；候选接口一次拉全量、
 *    本地分类翻页，不再有 `LIMIT 200` 静默截断。
 * 4. 提交走一次 /bindings/batch，不再 for 循环串行 POST；重复项静默跳过。
 * 5. 已绑定区改用 KpResourceCard，与知识点详情面板一套 UI（含上移/下移/解绑）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Checkbox, Empty, Input, Modal, Pagination, Segmented,
  Space, Spin, Tag, Tooltip, Typography, message,
} from 'antd'
import {
  AppstoreOutlined, BarsOutlined, ClearOutlined, MenuUnfoldOutlined,
  PlusOutlined, ReloadOutlined, SearchOutlined, StarFilled,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import * as curriculumApi from '../api/curriculum'
import type { BindableResourceType, ResourceCandidate } from '../api/curriculum'
import type { CurriculumResource } from '../types'
import KpResourceCard from './KpResourceCard'
import { useIsMobile } from '../hooks/useIsMobile'
import { getFileKind } from '../utils/fileKind'
import { compactClassScope } from '../utils/classScope'
import { isResourceKind } from '../constants/resourceKinds'
import {
  FALLBACK_RESOURCE_TYPES, prettyResourceName, resourceIcon, resourceTypeLabel,
  sourceBadgeLabel, sourceLabel, subKindLabel,
} from '../utils/resourceType'

const { Text } = Typography

/** 真的没东西可选时，给一行"去别处创建"的出口（平时不占版面） */
const CREATE_LINKS: { key: string; path: string }[] = [
  { key: 'practice', path: '/practice' },
  { key: 'task', path: '/tasks' },
  { key: 'interaction_quiz', path: '/interaction' },
  { key: 'html', path: '/html-files' },
]

/** 候选条目主键：跨类型累计选择，必须带类型前缀 */
const keyOf = (it: ResourceCandidate) => `${it.type}:${it.id}`
const keyOfBound = (r: CurriculumResource) => `${r.resource_type}:${r.resource_id}`

/** 知识点匹配档：越小越相关，默认排序用它 */
const KP_RANK: Record<string, number> = { exact: 0, contains: 1, chapter: 2, none: 3 }

const DAY = 86400000


type DimKey = 'kp' | 'kind' | 'subject' | 'grade' | 'owner' | 'time' | 'status' | 'bound' | 'source'
interface FacetOption { value: string; label: string; n: number }

const splitList = (raw: string) =>
  String(raw || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean)

/** 时间分档（与 ResourceBrowser 同口径） */
function timeBucket(createdAt: string, nowMs: number): string {
  if (!createdAt) return 'earlier'
  const d = new Date(createdAt.trim().replace(' ', 'T')).getTime()
  if (Number.isNaN(d)) return 'earlier'
  const diff = nowMs - d
  if (diff < 7 * DAY) return 'week'
  if (diff < 30 * DAY) return 'month'
  return 'earlier'
}

/** 内容小类：网页课件看 AI 产物后缀，下载文件看扩展名；活动类资源没有这一维 */
function kindOf(it: ResourceCandidate): string {
  if (it.type === 'html') return it.sub_kind || 'other'
  if (it.type === 'download') return getFileKind(it.name)
  return ''
}

/** 已绑情况：本知识点已绑 / 绑给了别的知识点 / 还没绑过 */
function boundBucket(it: ResourceCandidate): string {
  if (it.bound_here) return 'here'
  return it.bound_other > 0 ? 'other' : 'unbound'
}

const errDetail = (err: unknown): string => {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
  // 422 的 detail 是数组，老代码直接拼模板串 → 老师看到 [object Object]
  if (Array.isArray(detail)) return String(detail[0]?.msg || detail[0] || '')
  return typeof detail === 'string' ? detail : ''
}

interface ResourceBinderProps {
  /** 知识点 ID */
  kpId: number;
  /** 知识点名称 */
  kpName: string;
  /** 弹窗是否可见 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 绑定成功后刷新回调 */
  onRefresh?: () => void;
}

const ResourceBinder: React.FC<ResourceBinderProps> = ({ kpId, kpName, open, onClose, onRefresh }) => {
  const { t } = useTranslation('curriculum')
  const { t: tm } = useTranslation('menu')
  const navigate = useNavigate()
  const isMobile = useIsMobile()

  // ── 已绑定 ──
  const [bound, setBound] = useState<CurriculumResource[]>([])
  const [boundLoading, setBoundLoading] = useState(false)
  const [movingId, setMovingId] = useState<number | null>(null)

  // ── 候选 ──
  const [types, setTypes] = useState<BindableResourceType[]>(FALLBACK_RESOURCE_TYPES)
  // 只看一个类型；默认「网页资源」是教师备课最常找的那一类
  const [activeType, setActiveType] = useState<string>('html')
  const [items, setItems] = useState<ResourceCandidate[]>([])
  const [totals, setTotals] = useState<Record<string, number>>({})
  const [truncated, setTruncated] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [binding, setBinding] = useState(false)

  // ── 筛选 / 视图 ──
  const [kw, setKw] = useState('')
  const [sel, setSel] = useState<Partial<Record<DimKey, string | null>>>({})
  const [sort, setSort] = useState('recommended')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(24)
  const [panelOpen, setPanelOpen] = useState(true)
  const [nowMs, setNowMs] = useState(0)
  // 候选与已绑定一次只看一块（两块同时占高会把候选区挤成一行，绑几个就得先收起才好用）
  const [tab, setTab] = useState<'candidates' | 'bound'>('candidates')
  const boundListRef = useRef<HTMLDivElement | null>(null)

  // ── 跨类型累计已选 ──
  const [picked, setPicked] = useState<Map<string, ResourceCandidate>>(new Map())

  const shelfTypes = useMemo(() => types.filter((x) => x.key !== 'question'), [types])

  const loadBound = useCallback(async () => {
    setBoundLoading(true)
    try {
      const res = await curriculumApi.getKpResources(kpId)
      setBound(res.resources || [])
    } catch {
      setBound([])
    } finally {
      setBoundLoading(false)
    }
  }, [kpId])

  // 类型清单与每类可用条数：接口挂了就用兜底清单，不让弹窗打不开
  useEffect(() => {
    if (!open) return
    curriculumApi.getBindableResourceTypes()
      .then((list) => {
        if (!list.length) return
        setTypes(list)
        // 默认网页资源；万一这一类不在服务端清单里，退到清单第一项
        setActiveType((prev) => (list.some((x) => x.key === prev) ? prev : list[0].key))
      })
      .catch(() => {})
  }, [open])

  useEffect(() => {
    if (open) {
      loadBound()
      setPicked(new Map())
      setKw('')
      setSel({})
      setPage(1)
      setTab('candidates')
      setPanelOpen(!isMobile)
    }
  }, [open, loadBound, isMobile])

  const loadCandidates = useCallback(async () => {
    if (!open || !activeType) {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const res = await curriculumApi.getResourceCandidates({ types: [activeType], kp_id: kpId })
      setItems(res.items || [])
      setTotals(res.totals || {})
      setTruncated(res.truncated || {})
    } catch (err: unknown) {
      setItems([])
      message.error(errDetail(err) || t('rbLoadFailed'))
    } finally {
      setLoading(false)
    }
  }, [open, activeType, kpId, t])

  useEffect(() => { loadCandidates() }, [loadCandidates])
  useEffect(() => { setNowMs(Date.now()) }, [items])
  // ── 分类维度：计数基于「已搜索、未分类」的集合，保证点进去看到的条数一致 ──
  const searched = useMemo(() => {
    const q = kw.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => (
      it.name.toLowerCase().includes(q)
      || (it.kp_text || '').toLowerCase().includes(q)
      || (it.subject || '').toLowerCase().includes(q)
      || (it.owner || '').toLowerCase().includes(q)
      || (it.owner_name || '').toLowerCase().includes(q)
      || prettyResourceName(it.name).toLowerCase().includes(q)
    ))
  }, [items, kw])

  // 只有当前候选池里出现"不是自己建的"资源时才显示创建者：
  // 教师看到的本来就是自己名下的东西，每张卡都挂一遍"我"纯属噪音；管理员看全部，这一维是刚需。
  const showOwner = useMemo(() => items.some((i) => !i.mine), [items])

  const groupCount = useCallback((get: (it: ResourceCandidate) => string) => {
    const m = new Map<string, number>()
    for (const it of searched) {
      const v = get(it)
      if (v) m.set(v, (m.get(v) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [searched])

  /** 内容类型文案：网页资源的小类走 curriculum:subKind.*，其余大类（文件扩展名、
   *  题库 / 作业 …）走 menu:kind.*。「是不是小类」问后端下发的唯一清单
   *  （constants/resourceKinds）—— 以前是把小类名硬列在这里，新加一个 courseware
   *  就漏了，界面直接显示裸键 kind.courseware。两级文案都查不到时退回原始值。 */
  const kindLabel = useCallback((v: string) => {
    if (isResourceKind(v)) return subKindLabel(t, v)
    const key = `kind.${v}`
    const label = tm(key)
    return label === key ? v : label
  }, [t, tm])

  const statusLabel = useCallback((v: string) => {
    const map: Record<string, string> = {
      active: 'rbStatusActive', published: 'rbStatusPublished', pending: 'rbStatusPending',
      ended: 'rbStatusEnded', closed: 'rbStatusEnded', draft: 'rbStatusDraft',
    }
    return map[v] ? t(map[v]) : v
  }, [t])

  const dims = useMemo<{ key: DimKey; label: string; options: FacetOption[] }[]>(() => {
    const n = (pred: (it: ResourceCandidate) => boolean) => searched.filter(pred).length
    const list: { key: DimKey; label: string; options: FacetOption[] }[] = [
      {
        key: 'kp',
        label: t('rbDimKp'),
        options: [
          { value: 'exact', label: t('rbKpExact'), n: n((i) => i.kp_match === 'exact') },
          { value: 'contains', label: t('rbKpContains'), n: n((i) => i.kp_match === 'contains') },
          { value: 'chapter', label: t('rbKpChapter'), n: n((i) => i.kp_match === 'chapter') },
          { value: 'none', label: t('rbKpNone'), n: n((i) => (i.kp_match || 'none') === 'none') },
        ],
      },
      { key: 'kind', label: t('rbDimKind'), options: groupCount(kindOf).map(([v, c]) => ({ value: v, label: kindLabel(v), n: c })) },
      { key: 'subject', label: t('rbDimSubject'), options: groupCount((i) => i.subject).map(([v, c]) => ({ value: v, label: v, n: c })) },
      { key: 'owner', label: t('rbDimOwner'), options: groupCount((i) => i.owner_name).map(([v, c]) => ({ value: v, label: v, n: c })) },
      {
        key: 'grade',
        label: t('rbDimGrade'),
        options: groupCount((i) => splitList(i.grade)[0] || '').map(([v, c]) => ({ value: v, label: v, n: c })),
      },
      {
        key: 'time',
        label: t('rbDimTime'),
        options: [
          { value: 'week', label: t('rbThisWeek'), n: n((i) => timeBucket(i.created_at, nowMs) === 'week') },
          { value: 'month', label: t('rbThisMonth'), n: n((i) => timeBucket(i.created_at, nowMs) === 'month') },
          { value: 'earlier', label: t('rbEarlier'), n: n((i) => timeBucket(i.created_at, nowMs) === 'earlier') },
        ],
      },
      { key: 'status', label: t('rbDimStatus'), options: groupCount((i) => i.status).map(([v, c]) => ({ value: v, label: statusLabel(v), n: c })) },
      {
        key: 'bound',
        label: t('rbDimBound'),
        options: [
          { value: 'unbound', label: t('rbBoundNone'), n: n((i) => boundBucket(i) === 'unbound') },
          { value: 'other', label: t('rbBoundOther'), n: n((i) => boundBucket(i) === 'other') },
          { value: 'here', label: t('rbBoundHere'), n: n((i) => boundBucket(i) === 'here') },
        ],
      },
      {
        key: 'source',
        label: t('rbDimSource'),
        options: groupCount((i) => i.source)
          .map(([v, c]) => ({ value: v, label: sourceLabel(t, v) || v, n: c }))
          .filter((o) => !!o.label),
      },
    ]
    // 只保留当前确实有内容的维度（选「作业」时不会出现「文件类型」这种空栏）；
    // 「创建者」只在池子里真有多个人时才出现，教师端永远是 1 个人，不占地方
    return list.filter((d) => (d.key === 'owner' ? showOwner : true) && d.options.some((o) => o.n > 0))
  }, [searched, t, kindLabel, statusLabel, groupCount, nowMs, showOwner])

  const filtered = useMemo(() => searched.filter((it) => {
    for (const [dim, val] of Object.entries(sel)) {
      if (!val) continue
      switch (dim as DimKey) {
        case 'kp': if ((it.kp_match || 'none') !== val) return false; break
        case 'kind': if (kindOf(it) !== val) return false; break
        case 'subject': if (it.subject !== val) return false; break
        case 'owner': if ((it.owner_name || it.owner) !== val) return false; break
        case 'grade': if (!splitList(it.grade).includes(val)) return false; break
        case 'time': if (timeBucket(it.created_at, nowMs) !== val) return false; break
        case 'status': if (it.status !== val) return false; break
        case 'bound': if (boundBucket(it) !== val) return false; break
        case 'source': if (it.source !== val) return false; break
        default: break
      }
    }
    return true
  }), [searched, sel, nowMs])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const byNew = (a: ResourceCandidate, b: ResourceCandidate) =>
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    if (sort === 'name') {
      arr.sort((a, b) => prettyResourceName(a.name).localeCompare(prettyResourceName(b.name), 'zh-Hans-CN'))
    } else if (sort === 'new') {
      arr.sort(byNew)
    } else {
      // 推荐优先：已绑本知识点的沉底，其余按「是不是这个知识点的」→ 时间
      arr.sort((a, b) => (a.bound_here ? 1 : 0) - (b.bound_here ? 1 : 0)
        || (KP_RANK[a.kp_match] ?? 9) - (KP_RANK[b.kp_match] ?? 9)
        || byNew(a, b))
    }
    return arr
  }, [filtered, sort])

  const paged = useMemo(() => sorted.slice((page - 1) * pageSize, page * pageSize), [sorted, page, pageSize])
  useEffect(() => { setPage(1) }, [kw, sel, sort, activeType, pageSize])

  // 稳定引用：卡片/chips/摘要都要用它，包一层 useCallback 才不会把 memo 打散
  const labelOf = useCallback(
    (key: string) => resourceTypeLabel(t, key, types.find((x) => x.key === key)?.label_key),
    [t, types],
  )

  /** 收起状态下也要知道"绑了些什么"：按类型给一行摘要 */
  const boundSummary = useMemo(() => {
    const m: Record<string, number> = {}
    for (const r of bound) m[r.resource_type] = (m[r.resource_type] || 0) + 1
    return Object.entries(m).map(([k, v]) => `${labelOf(k)}×${v}`).join(' · ')
  }, [bound, labelOf])

  const pickedList = useMemo(() => [...picked.values()], [picked])
  const pickedByType = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of pickedList) m[it.type] = (m[it.type] || 0) + 1
    return m
  }, [pickedList])

  // ── 操作 ──
  /** 单选：点已选中的那颗不取消，避免"一类都不选"的空列表 */
  const pickType = (key: string) => {
    if (key === activeType) return
    setActiveType(key)
  }

  const togglePick = (it: ResourceCandidate) => {
    if (it.bound_here) return
    setPicked((prev) => {
      const next = new Map(prev)
      const k = keyOf(it)
      if (next.has(k)) next.delete(k)
      else next.set(k, it)
      return next
    })
  }

  /** 从已选里撤掉整类：跨类型累计之后，反悔一类比逐个取消快 */
  const dropType = (type: string) => {
    setPicked((prev) => {
      const next = new Map(prev)
      for (const [k, it] of next) {
        if (it.type === type) next.delete(k)
      }
      return next
    })
  }

  /** 本页全选/取消（只作用于未绑定的条目） */
  const pagePickable = paged.filter((i) => !i.bound_here)
  const pageAllPicked = pagePickable.length > 0 && pagePickable.every((i) => picked.has(keyOf(i)))
  const togglePageAll = () => {
    setPicked((prev) => {
      const next = new Map(prev)
      if (pageAllPicked) pagePickable.forEach((i) => next.delete(keyOf(i)))
      else pagePickable.forEach((i) => next.set(keyOf(i), i))
      return next
    })
  }

  const openResource = (r: CurriculumResource) => {
    if (!r.resource_url) return
    const isFile = r.resource_type === 'html' || r.resource_type === 'download'
    if (isFile) window.open(r.resource_url, '_blank', 'noopener')
    else navigate(r.resource_url)
  }

  const unbind = async (r: CurriculumResource) => {
    try {
      await curriculumApi.unbindResource(r.binding_id)
      message.success(t('rbUnbindSuccess'))
      setPicked((prev) => {
        const next = new Map(prev)
        next.delete(keyOfBound(r))
        return next
      })
      await loadBound()
      loadCandidates()
      onRefresh?.()
    } catch (err: unknown) {
      message.error(errDetail(err) || t('rbUnbindFailed'))
    }
  }

  const move = async (r: CurriculumResource, delta: -1 | 1) => {
    const idx = bound.findIndex((x) => x.binding_id === r.binding_id)
    const target = idx + delta
    if (idx < 0 || target < 0 || target >= bound.length) return
    const next = [...bound]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    setMovingId(r.binding_id)
    try {
      await curriculumApi.reorderBindings(next.map((x, i) => ({ binding_id: x.binding_id, sort_order: i })))
      await loadBound()
      onRefresh?.()
    } catch (err: unknown) {
      message.error(errDetail(err) || t('rbSortFailed'))
    } finally {
      setMovingId(null)
    }
  }

  const handleBind = async () => {
    if (!pickedList.length) return
    setBinding(true)
    try {
      const res = await curriculumApi.bindResourcesBatch({
        knowledge_point_id: kpId,
        items: pickedList.map((it, i) => ({
          resource_type: it.type, resource_id: it.id, sort_order: bound.length + i,
        })),
      })
      if (res.created) message.success(t('rbBindSuccess', { count: res.created }))
      if (res.duplicated) message.info(t('rbBindDuplicated', { count: res.duplicated }))
      for (const f of res.failed || []) {
        message.error(`${resourceTypeLabel(t, f.resource_type)}: ${f.reason}`)
      }
      if (res.created || res.duplicated) {
        setPicked(new Map())
        await loadBound()
        loadCandidates()
        onRefresh?.()
        // 绑完直接去看结果：切到「已绑定」标签页，省得以为没绑上又去开一遍知识点面板
        if (res.created) setTab('bound')
      }
    } catch (err: unknown) {
      message.error(errDetail(err) || t('rbBindFailed'))
    } finally {
      setBinding(false)
    }
  }
  // ── 渲染 ──
  const metaBits = (it: ResourceCandidate) => {
    // 依赖 showOwner / t：都在同一渲染闭包里取最新值，无需 memo
    const bits: string[] = []
    const qc = Number(it.meta?.question_count || 0)
    const score = Number(it.meta?.total_score || 0)
    const minutes = Number(it.meta?.duration || 0)
    const groups = Number(it.meta?.group_count || 0)
    if (qc) bits.push(t('rbMetaQuestions', { count: qc }))
    if (score) bits.push(t('rbMetaScore', { score }))
    if (minutes) bits.push(t('rbMetaMinutes', { minutes }))
    if (groups) bits.push(t('rbMetaGroups', { count: groups }))
    const scope = compactClassScope(it.grade, it.classes) || it.grade
    if (scope) bits.push(scope)
    if (showOwner) {
      // 系统自动生成的（错题巩固练习等）库里 owner='system'，给个能看懂的名字
      const who = it.mine ? t('rbMe') : (it.owner === 'system' ? t('rbOwnerSystem') : (it.owner_name || it.owner))
      bits.push(who)
    }
    if (it.created_at) bits.push(it.created_at.slice(0, 10))
    return bits
  }

  const cardTags = (it: ResourceCandidate) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
      <Tag style={tagStyle}>{labelOf(it.type)}</Tag>
      {it.kp_match === 'exact' && (
        <Tag color="gold" icon={<StarFilled />} style={tagStyle}>{t('rbKpExact')}</Tag>
      )}
      {it.kp_match === 'chapter' && <Tag style={tagStyle}>{t('rbKpChapter')}</Tag>}
      {kindOf(it) && <Tag style={tagStyle}>{kindLabel(kindOf(it))}</Tag>}
      {!!sourceBadgeLabel(t, it.source) && (
        <Tag color={it.source === 'wrong_book' ? 'purple' : undefined} style={tagStyle}>
          {sourceBadgeLabel(t, it.source)}
        </Tag>
      )}
      {it.bound_here && <Tag color="green" style={tagStyle}>{t('rbBoundHere')}</Tag>}
      {it.bound_other > 0 && <Tag style={tagStyle}>{t('rbBoundOtherN', { count: it.bound_other })}</Tag>}
    </div>
  )

  const renderCard = (it: ResourceCandidate) => {
    const on = picked.has(keyOf(it))
    const dead = it.bound_here
    return (
      <div
        key={keyOf(it)}
        role="checkbox"
        aria-checked={on}
        aria-disabled={dead}
        tabIndex={dead ? -1 : 0}
        title={it.name}
        onClick={() => togglePick(it)}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); togglePick(it) }
        }}
        style={{
          ...cardStyle,
          ...(on ? cardPickedStyle : null),
          ...(dead ? cardDeadStyle : null),
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <Checkbox
            checked={on}
            disabled={dead}
            style={{ marginTop: 2 }}
            onClick={(e) => e.stopPropagation()}
            onChange={() => togglePick(it)}
          />
          <span style={{ fontSize: 16, marginTop: 1, color: 'var(--text-secondary)' }}>
            {resourceIcon(it.type)}
          </span>
          <Tooltip title={it.name}>
            <span style={cardTitleStyle}>{prettyResourceName(it.name) || t('rbNoName')}</span>
          </Tooltip>
        </div>
        {cardTags(it)}
        <div style={cardMetaStyle}>{metaBits(it).join(' · ')}</div>
      </div>
    )
  }

  const renderRow = (it: ResourceCandidate) => {
    const on = picked.has(keyOf(it))
    const dead = it.bound_here
    return (
      <div
        key={keyOf(it)}
        style={{ ...rowStyle, ...(on ? cardPickedStyle : null), ...(dead ? cardDeadStyle : null) }}
        onClick={() => togglePick(it)}
      >
        <Checkbox
          checked={on}
          disabled={dead}
          onClick={(e) => e.stopPropagation()}
          onChange={() => togglePick(it)}
        />
        <span style={{ fontSize: 15, color: 'var(--text-secondary)' }}>{resourceIcon(it.type)}</span>
        <Tooltip title={it.name}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {prettyResourceName(it.name) || t('rbNoName')}
          </span>
        </Tooltip>
        {it.kp_match === 'exact' && (
          <Tag color="gold" icon={<StarFilled />} style={tagStyle}>{t('rbKpExact')}</Tag>
        )}
        <Tag style={tagStyle}>{labelOf(it.type)}</Tag>
        <span style={{ width: 210, flexShrink: 0, color: 'var(--text-tertiary)', fontSize: 12 }}>
          {metaBits(it).join(' · ')}
        </span>
      </div>
    )
  }

  const hasSel = Object.values(sel).some(Boolean)

  const facetPanel = (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text strong style={{ fontSize: 13 }}>{t('rbCategories')}</Text>
        {hasSel && (
          <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontSize: 12 }} onClick={() => setSel({})}>
            {t('rbClearFilter')}
          </Button>
        )}
      </div>
      {dims.map((d) => (
        <div key={d.key} style={{ marginBottom: 10 }}>
          <div style={dimTitleStyle}>{d.label}</div>
          {d.options.map((o) => {
            const on = sel[d.key] === o.value
            const pick = () => setSel((prev) => ({ ...prev, [d.key]: on ? null : o.value }))
            return (
              <div
                key={o.value}
                role="button"
                tabIndex={0}
                onClick={pick}
                onKeyDown={(e) => { if (e.key === 'Enter') pick() }}
                style={{ ...dimRowStyle, ...(on ? dimRowActiveStyle : null), opacity: o.n ? 1 : 0.45 }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                <span style={{ flexShrink: 0 }}>{o.n}</span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )

  return (
    <Modal
      maskClosable={false}
      open={open}
      onCancel={onClose}
      width={isMobile ? '100vw' : 'min(1180px, 94vw)'}
      style={isMobile ? { top: 0, maxWidth: '100vw', margin: 0, paddingBottom: 0 } : undefined}
      styles={{
        // 桌面：主体定高不整体滚，已绑定区与候选区各自滚，绑 20 个也不会把候选区顶出屏幕。
        // 窄屏：工具条/类型标签会换行占掉很多高度，硬切两块固定高度容易挤爆，仍让主体自己滚
        // （内层 flex:1 + minHeight:0 在自动高度容器里会按内容长高，不会塌成 0）。
        body: isMobile
          ? { maxHeight: 'calc(100vh - 168px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', paddingRight: 4 }
          : {
              height: 'min(84vh, 880px)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              paddingRight: 4,
            },
      }}
      title={
        <Space>
          <PlusOutlined />
          <span>{t('rbModalTitle')}</span>
          <Text type="secondary" style={{ fontSize: 13 }}>— {kpName}</Text>
        </Space>
      }
      footer={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            {pickedList.length ? (
              <Space size={6} wrap>
                <Text style={{ fontSize: 13 }}>{t('rbSelectedTotal', { count: pickedList.length })}</Text>
                {Object.entries(pickedByType).map(([k, v]) => (
                  <Tooltip key={k} title={t('rbRemoveType')}>
                    <Tag
                      closable
                      style={{ ...tagStyle, cursor: 'pointer' }}
                      onClose={(e) => { e.preventDefault(); dropType(k) }}
                    >
                      {labelOf(k)} × {v}
                    </Tag>
                  </Tooltip>
                ))}
                <Button type="link" size="small" icon={<ClearOutlined />} style={{ padding: 0, height: 'auto' }} onClick={() => setPicked(new Map())}>
                  {t('rbClearSelected')}
                </Button>
              </Space>
            ) : (
              <Text type="secondary" style={{ fontSize: 13 }}>{t('rbNothingSelected')}</Text>
            )}
          </div>
          <Button onClick={onClose}>{t('rbClose')}</Button>
          <Button type="primary" icon={<PlusOutlined />} loading={binding} disabled={!pickedList.length} onClick={handleBind}>
            {t('rbBindSelected', { count: pickedList.length })}
          </Button>
        </div>
      }
    >
      {/* ── 标签页：候选与已绑定各占满高度 ──
          重复绑定不靠"两块同时看见"来防：候选列表里本知识点已绑的条目会置灰 + 打「本知识点已绑」标 */}
      <div style={{ ...headRowStyle, flexShrink: 0, marginBottom: 12 }}>
        <Segmented
          value={tab}
          onChange={(v) => setTab(String(v) as 'candidates' | 'bound')}
          options={[
            { value: 'candidates', label: `${t('rbTabCandidates')} (${totals[activeType] ?? 0})` },
            { value: 'bound', label: `${t('rbTabBound')} (${bound.length})` },
          ]}
        />
        <Space size={8}>
          {tab === 'bound' && bound.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>{boundSummary}</Text>
          )}
          <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => { loadBound(); loadCandidates() }}>
            {t('rbRefresh')}
          </Button>
        </Space>
      </div>

      {tab === 'bound' ? (
        bound.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('rbNoBound')} style={{ margin: '40px 0' }} />
        ) : (
          <div ref={boundListRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
            <Spin spinning={boundLoading}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {bound.map((r, i) => (
                <KpResourceCard
                  key={r.binding_id}
                  resource={r}
                  isTeacherOrAdmin
                  isStudent={false}
                  onOpen={openResource}
                  onUnbind={unbind}
                  onMove={move}
                  canMoveUp={i > 0}
                  canMoveDown={i < bound.length - 1}
                  moving={movingId === r.binding_id}
                  dense
                />
              ))}
            </div>
            </Spin>
          </div>
        )
      ) : (
        <>
          {/* ── 挑选工具条 ── */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
            <Input
              allowClear
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder={t('rbSearchPlaceholder')}
              prefix={<SearchOutlined />}
              style={{ width: isMobile ? '100%' : 300 }}
            />
            <Segmented
              value={sort}
              onChange={(v) => setSort(String(v))}
              options={[
                { value: 'recommended', label: t('rbSortRecommended') },
                { value: 'new', label: t('rbSortNew') },
                { value: 'name', label: t('rbSortName') },
              ]}
            />
            <Segmented
              value={view}
              onChange={(v) => setView(String(v) as 'grid' | 'list')}
              options={[
                { value: 'grid', icon: <AppstoreOutlined />, tooltip: t('rbViewGrid') },
                { value: 'list', icon: <BarsOutlined />, tooltip: t('rbViewList') },
              ]}
            />
            <Button
              type={panelOpen ? 'primary' : 'default'}
              ghost={panelOpen}
              size="small"
              icon={<MenuUnfoldOutlined />}
              onClick={() => setPanelOpen((v) => !v)}
            >
              {t('rbCategories')}
            </Button>
          </div>

          {/* 类型单选：一次只看一类；已选篮在底部按类累计，切类不清空 */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center', flexShrink: 0 }}>
            {shelfTypes.map((ty) => {
              const on = activeType === ty.key
              const cnt = totals[ty.key] ?? ty.count ?? 0
              return (
                <Tag.CheckableTag key={ty.key} checked={on} onChange={() => pickType(ty.key)} style={chipStyle}>
                  <Space size={4}>
                    {resourceIcon(ty.key)}
                    {labelOf(ty.key)}
                    <Text type="secondary" style={{ fontSize: 12 }}>{cnt}</Text>
                  </Space>
                </Tag.CheckableTag>
              )
            })}
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 10, flex: 1, minHeight: 0, flexDirection: isMobile ? 'column' : 'row' }}>
            {panelOpen && (
              <div style={isMobile ? { width: '100%', maxHeight: '28vh', overflowY: 'auto', flexShrink: 0 } : { flexShrink: 0, height: '100%', overflowY: 'auto' }}>
                {facetPanel}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 2 }}>
                <Spin spinning={loading}>
                  {sorted.length === 0 ? (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={items.length ? t('rbNoMatch') : t('rbNoAvailable')}
                      style={{ margin: '40px 0' }}
                    >
                      {items.length ? (
                        <Button size="small" onClick={() => { setSel({}); setKw('') }}>{t('rbClearFilter')}</Button>
                      ) : (
                        // 「去创建」只在真的没东西可选时出现，平时不占一行
                        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                          {t('rbCreateHint')}
                          {CREATE_LINKS.map((x) => (
                            <Button
                              key={x.key}
                              type="link"
                              size="small"
                              style={{ padding: '0 4px', height: 'auto', fontSize: 12 }}
                              onClick={() => { onClose(); navigate(x.path) }}
                            >
                              {labelOf(x.key)}
                            </Button>
                          ))}
                        </span>
                      )}
                    </Empty>
                  ) : view === 'grid' ? (
                    <div style={gridStyle}>{paged.map(renderCard)}</div>
                  ) : (
                    <div style={listWrapStyle}>{paged.map(renderRow)}</div>
                  )}
                </Spin>
              </div>

              {/* 统计 + 全选 + 分页合并成一行：原来占两行，把卡片挤掉一整排 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexShrink: 0, flexWrap: 'wrap' }}>
                <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                  {t('rbTotal', { count: sorted.length })}
                  {kw || hasSel ? t('rbOfPool', { count: items.length }) : ''}
                </Text>
                {pagePickable.length > 0 && (
                  <Checkbox
                    checked={pageAllPicked}
                    indeterminate={!pageAllPicked && pagePickable.some((i) => picked.has(keyOf(i)))}
                    onChange={togglePageAll}
                  >
                    <span style={{ fontSize: 12 }}>{t('rbPickPageAll')}</span>
                  </Checkbox>
                )}
                <span style={{ flex: 1, minWidth: 0 }} />
                <Pagination
                  current={page}
                  pageSize={pageSize}
                  total={sorted.length}
                  showSizeChanger
                  pageSizeOptions={[12, 24, 48, 96]}
                  size="small"
                  showTotal={(total, range) => t('rbRange', { from: range[0], to: range[1], total })}
                  onChange={(pg, ps) => { setPage(pg); setPageSize(ps) }}
                />
              </div>
              {truncated[activeType] && (
                <div style={{ marginTop: 6, flexShrink: 0 }}>
                  <Text type="warning" style={{ fontSize: 12 }}>{t('rbTruncated')}</Text>
                </div>
              )}
            </div>
          </div>
        </>
      )}    </Modal>
  )
}

const headRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
}
const chipStyle: React.CSSProperties = {
  border: '1px solid var(--border-color-secondary)',
  borderRadius: 16,
  padding: '2px 10px',
  margin: 0,
  userSelect: 'none',
}
const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border-color-secondary)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--bg-container)',
  cursor: 'pointer',
  transition: 'border-color .15s, box-shadow .15s',
  outline: 'none',
}
const cardPickedStyle: React.CSSProperties = {
  borderColor: 'var(--primary-color)',
  boxShadow: '0 0 0 1px var(--primary-color) inset',
}
const cardDeadStyle: React.CSSProperties = {
  cursor: 'not-allowed',
  opacity: 0.6,
  background: 'var(--bg-layout)',
}
const cardTitleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  lineHeight: '20px',
  wordBreak: 'break-all',
}
const cardMetaStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 12,
  color: 'var(--text-tertiary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const tagStyle: React.CSSProperties = { margin: 0, fontSize: 11, lineHeight: '18px' }
const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
  gap: 10,
}
const listWrapStyle: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  overflow: 'hidden',
}
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 10px',
  borderBottom: '1px solid var(--border-color)',
  cursor: 'pointer',
}
const panelStyle: React.CSSProperties = {
  width: 196,
  maxWidth: '100%',
  border: '1px solid var(--border-color)',
  borderRadius: 8,
  padding: '8px 10px',
  background: 'var(--bg-container)',
  // 高度与滚动交给外层容器：窄屏收 28vh、宽屏跟着候选区铺满
}
const dimTitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-tertiary)',
  margin: '6px 0 2px',
}
const dimRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 6,
  fontSize: 12,
  padding: '3px 6px',
  borderRadius: 4,
  cursor: 'pointer',
  overflow: 'hidden',
}
const dimRowActiveStyle: React.CSSProperties = {
  background: 'var(--bg-layout)',
  color: 'var(--primary-color)',
  fontWeight: 600,
}

export default ResourceBinder
