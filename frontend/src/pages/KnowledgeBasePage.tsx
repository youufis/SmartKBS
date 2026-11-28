/** 本地知识库（独立模块页）——文档列表 / 上传队列 / 回收站 / 检索测试 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert, Button, Card, Col, Descriptions, Drawer, Dropdown, Empty, Grid, Input, Modal,
  Progress, Row, Select, Space, Statistic, Table, Tabs, Tag, theme, Tooltip, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CloudUploadOutlined, DatabaseOutlined, DeleteOutlined, FolderOpenOutlined, FolderOutlined, PlusOutlined,
  ExclamationCircleOutlined, InfoCircleOutlined, MoreOutlined, ReloadOutlined, SearchOutlined, SettingOutlined,
} from '@ant-design/icons'
import { kbApi } from '../api/kb'
import type { KbDoc, KbStats } from '../api/kb'
import AiRuntimeChips from '../components/AiRuntimeChips'
import { useAiRuntimeStore } from '../stores/aiRuntimeStore'

const EXT_OK_FALLBACK = ['.md', '.txt', '.docx', '.pdf']
const MAX_MB_FALLBACK = 20
const MAX_BATCH_FILES = 200

type QItem = {
  uid: string
  file?: File
  name: string
  size: number
  progress: number
  state: 'queued' | 'uploading' | 'done' | 'failed'
  reason?: string
  docId?: number
  skipId?: number
  skipReason?: 'duplicate' | 'in_trash'
  skipName?: string
  attempted?: boolean
}

function fmtSize(n?: number) {
  const b = Number(n || 0)
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB'
  return b + ' B'
}

export default function KnowledgeBasePage() {
  const { t } = useTranslation('knowledgeBase')
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<KbStats | null>(null)
  const [folderDrawer, setFolderDrawer] = useState(false)
  const screens = Grid.useBreakpoint()
  const [loading, setLoading] = useState(false)
  const [disabled, setDisabled] = useState(false)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [scope, setScope] = useState('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [tab, setTab] = useState('docs')
  const [folders, setFolders] = useState<{ items: any[]; uncategorized: number }>({ items: [], uncategorized: 0 })
  const [folderId, setFolderId] = useState('all')
  const [folderModal, setFolderModal] = useState<{ mode: 'create' | 'rename'; id?: number; name?: string } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [moveTarget, setMoveTarget] = useState<KbDoc | null>(null)
  const [moveFolder, setMoveFolder] = useState('none')
  const [uploadFolder, setUploadFolder] = useState('none')
  const [dragOver, setDragOver] = useState(false)
  const [selected, setSelected] = useState<React.Key[]>([])
  const [trash, setTrash] = useState<KbDoc[]>([])
  const [uploadOpen, setUploadOpen] = useState(false)
  const [queue, setQueue] = useState<QItem[]>([])
  const [detail, setDetail] = useState<any>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [testOpen, setTestOpen] = useState(false)
  const [testQ, setTestQ] = useState('')
  const [testRes, setTestRes] = useState<any>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const [refillBusy, setRefillBusy] = useState(false)
  const [purgeTarget, setPurgeTarget] = useState<KbDoc | null>(null)
  const [purgeName, setPurgeName] = useState('')
  const [replaceTarget, setReplaceTarget] = useState<KbDoc | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)

  const me = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('smartkb_user') || 'null') } catch { return null }
  }, [])
  const isAdmin = me?.role === 'admin'
  const { token } = theme.useToken()

  // 限制来自后端配置（stats.caps），前端不再写死格式/大小
  const caps = stats?.caps
  const extOkList = caps?.extensions?.length ? caps.extensions : EXT_OK_FALLBACK
  const maxMb = caps?.max_file_mb || MAX_MB_FALLBACK
  const acceptAttr = extOkList.map((e) => (e.startsWith('.') ? e : `.${e}`)).join(',')
  const extsText = extOkList.map((e) => e.replace(/^\./, '')).join(' / ')

  // 双通道索引开着、但本地那一路还没就绪（Ollama 未启动或未拉取嵌入模型）。
  // 云端向量照常可用、检索链路并没有降级，所以只在卡头留一行低干扰提示，处置步骤收进 Tooltip：
  // 原先那块整幅 Alert 占两行高，把文档列表整体下推，而它既不需要教师处理，也不说明系统出了问题。
  const localVecPending = !!stats?.dual_index && !stats?.local_ready?.model_present
  const localEmbedModel = stats?.local_ready?.model || 'bge-m3'

  // 向量缺口：已就绪、但在当前嵌入签名下没有向量记录的文档数。原先是一条整幅黄色 Alert，
  // 和上面那条同罪同判 —— 它只影响语义召回的覆盖面（关键词检索照常），不是页面故障，
  // 所以同样降成卡头一行小字，动作（立即补齐）留在旁边，不额外占高度。
  const vecGap = stats && stats.ready > 0 && stats.vec_coverage < 1
    ? Math.max(0, stats.ready - (stats.vec_docs || 0))
    : 0

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const r = await kbApi.docs({ q, status, scope, folder: folderId, page, page_size: pageSize })
      if ((r as any).detail) throw new Error((r as any).detail)
      setDocs(r.items || [])
      setTotal(r.total || 0)
      setStats(r.stats || null)
    } catch (e: any) {
      const detail = String(e?.response?.data?.detail || "")
      if (detail.includes("未启用")) {
        setDisabled(true)
      } else if (!silent) {
        message.error(detail || t('loadFailed'))
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [q, status, scope, folderId, page, pageSize, t])

  const loadRef = useRef(load)
  const docsRef = useRef(docs)
  useEffect(() => { loadRef.current = load; docsRef.current = docs })

  const loadTrash = useCallback(async () => {
    try {
      const r = await kbApi.trash()
      setTrash(r.items || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('loadFailed'))
    }
  }, [t])

  useEffect(() => { load() }, [load])
  // 启用状态优先用 stats 判定（该接口无启用守卫、不抛错），load() 里的字符串兜底仅在异常时生效
  useEffect(() => {
    kbApi.stats().then((s) => { if (s && s.enabled === false) setDisabled(true) }).catch(() => {})
    // 链路状态（云端/本地哪一路生效）改由 AiRuntimeChips 统一读取，这里不再单独拉 /kb/ai-mode
  }, [])
  useEffect(() => {
    if (tab === 'trash') loadTrash()
  }, [tab, loadTrash])

  const loadFolders = useCallback(async () => {
    try {
      const r = await kbApi.folders()
      setFolders(r || { items: [], uncategorized: 0 })
    } catch { /* 目录加载失败不阻塞列表 */ }
  }, [])

  useEffect(() => { loadFolders() }, [loadFolders])

  useEffect(() => { setSelected([]) }, [folderId, page, pageSize, q, status, scope])

  // 状态轮询：仅当存在 pending/indexing 时启动；全终态即停
  const activeKey = docs.filter(d => d.status === 'pending' || d.status === 'indexing')
    .map(d => `${d.id}:${d.status}`).join(',')
  useEffect(() => {
    if (!activeKey) return
    const timer = setInterval(async () => {
      // docs/load 一律经 ref 读取：闭包里的旧值会在切筛选后用旧参数覆盖列表
      const ids = docsRef.current
        .filter(d => d.status === 'pending' || d.status === 'indexing')
        .map(d => d.id)
      if (!ids.length) {
        clearInterval(timer)
        loadRef.current(true)
        return
      }
      try {
        const r = await kbApi.status(ids)
        const map = new Map<number, any>((r.items || []).map((x: any) => [x.id, x]))
        setDocs(prev => prev.map(d => (map.has(d.id) ? { ...d, ...map.get(d.id) } : d)))
        if ((r.items || []).every((x: any) => x.status !== 'pending' && x.status !== 'indexing')) {
          loadRef.current(true)
        }
      } catch { /* 轮询失败静默，下一轮再试 */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [activeKey])

  const patchQ = (uid: string, patch: Partial<QItem>) =>
    setQueue(prev => prev.map(x => (x.uid === uid ? { ...x, ...patch } : x)))

  const applyUploadResult = (uid: string, res: any, fallbackName: string) => {
    if (res.uploaded?.length) {
      patchQ(uid, { state: 'done', progress: 100, docId: res.uploaded[0].id })
    } else if (res.skipped?.length) {
      const sk = res.skipped[0]
      const inTrash = sk.reason === 'in_trash'
      patchQ(uid, {
        state: 'failed',
        reason: inTrash ? t('inTrash') : (sk.name ? t('duplicateNamed', { name: sk.name }) : t('duplicate')),
        skipId: sk.id, skipReason: inTrash ? 'in_trash' : 'duplicate', skipName: sk.name || fallbackName,
      })
    } else {
      patchQ(uid, { state: 'failed', reason: res.errors?.[0]?.reason || t('uploadFailed') })
    }
  }

  const processFiles = async (files: File[]) => {
    if (files.length > MAX_BATCH_FILES) message.warning(t('tooManyFiles', { n: MAX_BATCH_FILES }))
    const items: QItem[] = files.slice(0, MAX_BATCH_FILES).map((f, i) => {
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
      let reason = ''
      if (!extOkList.includes(ext)) reason = t('errExt')
      else if (f.size > maxMb * 1048576) reason = t('errSize', { mb: maxMb })
      else if (f.size === 0) reason = t('errEmpty')
      return {
        uid: `${Date.now()}-${i}-${f.name}`, file: f, name: f.name, size: f.size,
        progress: 0, state: reason ? 'failed' : 'queued', reason,
      }
    })
    setQueue(prev => [...items, ...prev])
    const valid = items.filter(x => x.state === 'queued')
    let idx = 0
    const worker = async () => {
      while (idx < valid.length) {
        const item = valid[idx++]
        patchQ(item.uid, { state: 'uploading', attempted: true })
        try {
          const res = await kbApi.upload(item.file!, (p) => patchQ(item.uid, { progress: p }), uploadFolder)
          applyUploadResult(item.uid, res, item.name)
        } catch (e: any) {
          patchQ(item.uid, { state: 'failed', reason: e?.response?.data?.detail || t('uploadFailed') })
        }
      }
    }
    await Promise.all([worker(), worker()])
    load(true)
    loadFolders()
    loadTrash()
  }

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (files.length) processFiles(files)
  }

  const folderRowStyle = (active: boolean) => ({
    display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 6,
    cursor: 'pointer', fontSize: 13, background: active ? '#e6f4ff' : 'transparent',
  })

  const submitFolder = async () => {
    try {
      if (folderModal?.mode === 'rename' && folderModal.id) {
        await kbApi.renameFolder(folderModal.id, folderName.trim())
        message.success(t('folderRenamed'))
      } else {
        await kbApi.createFolder(folderName.trim())
        message.success(t('folderCreated'))
      }
      setFolderModal(null)
      setFolderName('')
      loadFolders()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const quickCreate = (name: string) => {
    setFolderModal({ mode: 'create' })
    setFolderName(name)
  }

  const removeFolder = (f: any) => {
    Modal.confirm({
      title: t('folderDeleteTitle', { name: f.name }),
      content: t('folderDeleteConfirm'),
      okText: t('ok'), cancelText: t('cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const r = await kbApi.deleteFolder(f.id)
          message.success(t('folderDeleted', { n: r?.moved_to_none ?? 0 }))
          if (folderId === String(f.id)) setFolderId('all')
          loadFolders()
          load(true)
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('opFailed'))
        }
      },
    })
  }

  const submitMove = async () => {
    if (!moveTarget) return
    try {
      await kbApi.moveDoc(moveTarget.id, moveFolder === 'none' ? null : Number(moveFolder))
      message.success(t('moved'))
      setMoveTarget(null)
      load(true)
      loadFolders()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const restoreSkipped = async (item: QItem) => {
    if (!item.skipId) return
    try {
      await kbApi.restore(item.skipId)
      patchQ(item.uid, { state: 'done', progress: 100, skipId: undefined, skipReason: undefined, skipName: undefined })
      message.success(t('restored'))
      load(true)
      loadFolders()
      loadTrash()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const uploadAnyway = async (item: QItem) => {
    if (!item.file) return
    patchQ(item.uid, { state: 'uploading', progress: 0, reason: '', skipId: undefined, skipReason: undefined, attempted: true })
    try {
      const res = await kbApi.upload(item.file, (p) => patchQ(item.uid, { progress: p }), uploadFolder, true)
      applyUploadResult(item.uid, res, item.name)
      load(true)
      loadFolders()
      loadTrash()
    } catch (e: any) {
      patchQ(item.uid, { state: 'failed', reason: e?.response?.data?.detail || t('uploadFailed') })
    }
  }

  const retryItem = async (item: QItem) => {
    if (!item.file) return
    patchQ(item.uid, { state: 'uploading', progress: 0, reason: '', skipId: undefined, skipReason: undefined, attempted: true })
    try {
      const res = await kbApi.upload(item.file, (p) => patchQ(item.uid, { progress: p }), uploadFolder)
      applyUploadResult(item.uid, res, item.name)
      load(true)
      loadFolders()
    } catch (e: any) {
      patchQ(item.uid, { state: 'failed', reason: e?.response?.data?.detail || t('uploadFailed') })
    }
  }

  const locateDoc = (item: QItem) => {
    if (!item.skipName) return
    setUploadOpen(false)
    setTab('docs')
    setQ(item.skipName)
    setStatus('')
    setScope('all')
    setFolderId('all')
    setPage(1)
  }

  const batchRemove = () => {
    const ids = selected.map((x) => Number(x))
    if (!ids.length) return
    Modal.confirm({
      title: t('batchRemoveTitle', { n: ids.length }),
      content: t('batchRemoveConfirm'),
      okText: t('ok'),
      cancelText: t('cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        let ok = 0
        let fail = 0
        for (const id of ids) {
          try {
            await kbApi.remove(id)
            ok += 1
          } catch {
            fail += 1
          }
        }
        message.success(t('batchDone', { ok, fail }))
        setSelected([])
        load(true)
        loadFolders()
      },
    })
  }

  const openDetail = async (d: KbDoc) => {
    try {
      const r = await kbApi.detail(d.id)
      setDetail(r)
      setDetailOpen(true)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('loadFailed'))
    }
  }

  const doRemove = async (d: KbDoc) => {
    try {
      await kbApi.remove(d.id)
      message.success(t('removed'))
      load(true)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const doReindex = async (d: KbDoc) => {
    try {
      await kbApi.reindex(d.id)
      message.success(t('reindexQueued'))
      load(true)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const doRestore = async (d: KbDoc) => {
    try {
      await kbApi.restore(d.id)
      message.success(t('restored'))
      loadTrash()
      load(true)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const confirmPurge = async () => {
    if (!purgeTarget) return
    try {
      const r = await kbApi.purge(purgeTarget.id, purgeName.trim())
      message.success(t('purged', { mb: r?.freed_mb ?? 0 }))
      setPurgeTarget(null)
      setPurgeName('')
      loadTrash()
      load(true)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const doDownload = async (d: KbDoc) => {
    try {
      const blob = await kbApi.download(d.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = d.name
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const doRebuild = async () => {
    try {
      await kbApi.rebuild()
      message.success(t('rebuildQueued'))
      setRebuildOpen(false)
      load(true)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const doRefill = () => {
    Modal.confirm({
      title: t('refillTitle'),
      content: t('refillConfirm'),
      okText: t('ok'), cancelText: t('cancel'),
      onOk: async () => {
        setRefillBusy(true)
        let done = 0, failed = 0, rounds = 0
        try {
          // 服务端每轮最多处理 10 篇：自动多轮直到补完 / 出现失败 / 安全上限
          for (;;) {
            const r = await kbApi.refillVectors()
            if (!r?.ok) { message.warning(r?.error || t('opFailed')); break }
            done += r.done ?? 0; failed += r.failed ?? 0; rounds += 1
            if (!r.targeted || failed > 0 || rounds >= 20) break
          }
          if (rounds) message.success(t('refillDone', { done, failed, rounds }))
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('opFailed'))
        } finally {
          setRefillBusy(false)
          load(true)
        }
      },
    })
  }

  const runTest = async () => {
    if (!testQ.trim()) return
    setTestLoading(true)
    try {
      const r = await kbApi.searchTest(testQ.trim())
      setTestRes(r)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    } finally {
      setTestLoading(false)
    }
  }

  const onReplacePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = (e.target.files || [])[0]
    e.target.value = ''
    if (!f || !replaceTarget) return
    try {
      await kbApi.replace(replaceTarget.id, f)
      message.success(t('replaced'))
      setReplaceTarget(null)
      load(true)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('opFailed'))
    }
  }

  // 页数只对 PDF 有语义（md/txt/docx 恒为 0）：以切片数为主值，页数仅作灰色后缀，不再出现悬空的 "-"
  const chunksCell = (v: { pages?: number; chunks?: number }) => (
    <span>
      {v.chunks || 0}
      {!!v.pages && (
        <span style={{ color: '#999', fontSize: 12 }}> · {v.pages} {t('pagesUnit')}</span>
      )}
    </span>
  )

  const statusCell = (d: KbDoc) => {
    if (d.status === 'pending') return <Tag>{t('stPending')}</Tag>
    if (d.status === 'indexing') {
      return (
        <Space direction="vertical" size={0} style={{ minWidth: 120 }}>
          <Tag color="processing">{t('stIndexing')}</Tag>
          <Progress percent={d.progress || 0} size="small" />
        </Space>
      )
    }
    if (d.status === 'ready') {
      return (
        <Space size={4} wrap>
          <Tag color="success">{t('stReady')}</Tag>
          {d.vec_state === 'done' && <Tag color="blue">{t('vecDone')}</Tag>}
          {d.vec_state === 'failed' && (
            <Tooltip title={d.error || t('vecFailedTip')}>
              <Tag color="orange">{t('vecPending')}</Tag>
            </Tooltip>
          )}
        </Space>
      )
    }
    if (d.status === 'empty') {
      return (
        <Tooltip title={d.error || t('emptyTip')}>
          <Tag color="gold">{t('stEmpty')}</Tag>
        </Tooltip>
      )
    }
    if (d.status === 'failed') {
      return (
        <Tooltip title={d.error || t('failedTip')}>
          <Tag color="error">{t('stFailed')}</Tag>
        </Tooltip>
      )
    }
    return <Tag>{d.status}</Tag>
  }

  const docColumns: ColumnsType<KbDoc> = [
    {
      title: t('colName'), dataIndex: 'name', ellipsis: true,
      render: (name: string, d) => (
        <Space size={6}>
          <DatabaseOutlined />
          <Tooltip title={name}>
            <a onClick={() => openDetail(d)}>{name}</a>
          </Tooltip>
          {d.owner === me?.username && <Tag color="cyan">{t('mine')}</Tag>}
        </Space>
      ),
    },
    { title: t('colSize'), dataIndex: 'size', width: 100, render: (v: number) => fmtSize(v) },
    {
      title: t('colPages'), width: 120,
      render: (_: any, d) => chunksCell(d),
    },
    { title: t('colStatus'), width: 190, render: (_: any, d) => statusCell(d) },
    { title: t('colUpdated'), dataIndex: 'updated_at', width: 170 },
    {
      title: t('colActions'), width: 90,
      render: (_: any, d) => {
        const canRemove = isAdmin || d.owner === me?.username
        const items: any[] = [
          { key: 'detail', label: t('actDetail') },
          { key: 'download', label: t('actDownload') },
          { key: 'move', label: t('moveTo'), disabled: !(isAdmin || d.owner === me?.username) },
        ]
        if (isAdmin || d.owner === me?.username) {
          items.push({ key: 'reindex', label: t('actReindex'), disabled: d.status === 'indexing' })
        }
        if (isAdmin) {
          items.push({ key: 'replace', label: t('actReplace') })
        }
        if (canRemove) items.push({ key: 'remove', label: t('actRemove'), danger: true })
        return (
          <Dropdown
            menu={{
              items,
              onClick: ({ key }) => {
                if (key === 'detail') openDetail(d)
                if (key === 'download') doDownload(d)
                if (key === 'move') { setMoveTarget(d); setMoveFolder(d.folder_id ? String(d.folder_id) : 'none') }
                if (key === 'reindex') doReindex(d)
                if (key === 'replace') { setReplaceTarget(d); setTimeout(() => replaceRef.current?.click(), 0) }
                if (key === 'remove') {
                  Modal.confirm({
                    title: t('removeTitle', { name: d.name }),
                    content: t('removeConfirm'),
                    okText: t('ok'), cancelText: t('cancel'),
                    okButtonProps: { danger: true },
                    onOk: () => doRemove(d),
                  })
                }
              },
            }}
          >
            <Button type="text" icon={<MoreOutlined />} />
          </Dropdown>
        )
      },
    },
  ]

  const trashColumns: ColumnsType<KbDoc> = [
    { title: t('colName'), dataIndex: 'name', ellipsis: true },
    { title: t('colSize'), dataIndex: 'size', width: 100, render: (v: number) => fmtSize(v) },
    {
      title: t('colRemain'), dataIndex: 'remaining_days', width: 120,
      render: (v: number) => t('remainDays', { days: v }),
    },
    { title: t('colDeletedBy'), dataIndex: 'deleted_by', width: 120 },
    {
      title: t('colActions'), width: 180,
      render: (_: any, d) => (
        <Space>
          <Button size="small" onClick={() => doRestore(d)} disabled={!isAdmin && d.owner !== me?.username}>
            {t('actRestore')}
          </Button>
          {isAdmin && (
            <Button size="small" danger onClick={() => { setPurgeTarget(d); setPurgeName('') }}>
              {t('actPurge')}
            </Button>
          )}
        </Space>
      ),
    },
  ]

  const currentFolderName = useMemo(() => {
    if (folderId === 'all') return t('folderAll')
    if (folderId === 'none') return t('folderNone')
    return folders.items.find((x: any) => String(x.id) === folderId)?.name || t('folders')
  }, [folderId, folders, t])

  const folderPanel = (
  <Card size="small" styles={{ body: { padding: 8 } }}
    title={<span style={{ fontSize: 13 }}>{t('folders')}</span>}
    extra={<Button size="small" type="text" icon={<PlusOutlined />}
      onClick={() => { setFolderModal({ mode: 'create' }); setFolderName('') }} />}>
    <div style={folderRowStyle(folderId === 'all')} onClick={() => { setFolderId('all'); setPage(1); setFolderDrawer(false) }}>
      <FolderOutlined /><span style={{ flex: 1 }}>{t('folderAll')}</span>
      <span style={{ color: '#999' }}>{stats?.docs || 0}</span>
    </div>
    <div style={folderRowStyle(folderId === 'none')} onClick={() => { setFolderId('none'); setPage(1); setFolderDrawer(false) }}>
      <FolderOutlined /><span style={{ flex: 1 }}>{t('folderNone')}</span>
      <span style={{ color: '#999' }}>{folders.uncategorized}</span>
    </div>
    {folders.items.map((f) => (
      <div key={f.id} style={folderRowStyle(folderId === String(f.id))}
        onClick={() => { setFolderId(String(f.id)); setPage(1); setFolderDrawer(false) }}>
        <FolderOpenOutlined />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={f.name}>{f.name}</span>
        <span style={{ color: '#999' }}>{f.cnt}</span>
        {(isAdmin || f.owner === me?.username) && (
          <Dropdown trigger={['click']} menu={{
            items: [
              { key: 'rename', label: t('folderRename') },
              { key: 'del', label: t('folderDelete'), danger: true },
            ],
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation()
              if (key === 'rename') {
                setFolderModal({ mode: 'rename', id: f.id })
                setFolderName(f.name)
              } else {
                removeFolder(f)
              }
            },
          }}>
            <MoreOutlined style={{ cursor: 'pointer' }} onClick={(e) => e.stopPropagation()} />
          </Dropdown>
        )}
      </div>
    ))}
    {folders.items.length === 0 && (
      <div style={{ padding: '6px 4px', color: '#999', fontSize: 12 }}>
        {t('quickCreate')}
        <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[t('quickExam'), t('quickTextbook'), t('quickLessonPlan')].map((n) => (
            <Tag key={n} style={{ cursor: 'pointer', margin: 0 }} onClick={() => quickCreate(n)}>+{n}</Tag>
          ))}
        </div>
      </div>
    )}
  </Card>
  )

  if (disabled) {
    return (
      <div style={{ padding: 16 }}>
        <Card>
          <Alert type="warning" showIcon title={t('disabledTitle')} description={t('disabledHint')} />
        </Card>
      </div>
    )
  }

  return (
    <div style={{ padding: 16 }}>
      <Row gutter={[12, 12]} align="stretch">
        <Col xs={12} md={6}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic title={t('statDocs')} value={stats?.docs || 0} suffix={`/ ${stats?.quota_docs || '-'}`} />
            <div style={{ fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden' }}>
              <a onClick={() => { setStatus('ready'); setPage(1) }}>{t('stReady')} {stats?.ready ?? 0}</a>
              {' · '}<a onClick={() => { setStatus('processing'); setPage(1) }}>{t('stProcessing')} {Math.max(0, (stats?.docs ?? 0) - (stats?.ready ?? 0) - (stats?.failed ?? 0) - (stats?.empty ?? 0))}</a>
              {' · '}<a onClick={() => { setStatus('failed'); setPage(1) }}>{t('stFailed')} {stats?.failed ?? 0}</a>
              {' · '}<a onClick={() => { setStatus('empty'); setPage(1) }}>{t('stEmpty')} {stats?.empty ?? 0}</a>
            </div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic title={t('statChunks')} value={stats?.chunks || 0} />
            <div style={{ fontSize: 12, color: '#999', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {t('statChunksSub', { n: caps?.max_chars ?? 2500 })}
            </div>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic title={t('statVec')} value={Math.round((stats?.vec_coverage || 0) * 100)} suffix="%" />
            <Tooltip title={stats?.embed ? `${t('embedSig')}: ${stats.embed.sig}` : undefined}>
              <div style={{ fontSize: 12, color: '#999', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {(stats?.vec_channels || []).length
                  ? (stats!.vec_channels || []).map((c) => `${c.provider}·${c.model}×${c.docs}`).join('  ')
                  : `${stats?.embed?.provider || '-'}·${stats?.embed?.model || '-'}`}
              </div>
            </Tooltip>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small" style={{ height: '100%' }}>
            <Statistic title={t('statCapacity')} value={stats?.used_mb ?? stats?.size_mb ?? 0}
              suffix={`/ ${stats?.quota_mb || '-'} MB`} />
            {/* 底行与其它三卡的说明行同高（18px），进度条在其中垂直居中 */}
            <div style={{ marginTop: 2, minHeight: 18, display: 'flex', alignItems: 'center' }}>
              <Progress percent={stats?.quota_mb ? Math.min(100, Math.round(((stats?.used_mb ?? stats?.size_mb ?? 0) / stats.quota_mb) * 100)) : 0}
                size="small" style={{ marginBottom: 0, flex: 1 }} />
            </div>
          </Card>
        </Col>
      </Row>

      <Card
        style={{ marginTop: 12 }}
        title={
          <Space wrap>
            <DatabaseOutlined />{t('title')}
            <AiRuntimeChips density="compact" />
            {localVecPending && (
              <Tooltip title={t('localChannelHint', { model: localEmbedModel })} styles={{ root: { maxWidth: 380, lineHeight: 1.7 } }}>
                {/* 可聚焦：键盘 Tab 到它也能看到同一份说明 */}
                <span tabIndex={0} style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'default', whiteSpace: 'nowrap' }}>
                  <InfoCircleOutlined style={{ marginInlineEnd: 4 }} />{t('localChannelPending')}
                </span>
              </Tooltip>
            )}
            {vecGap > 0 && (
              <Tooltip title={t('vecGapAlert', { n: vecGap })} styles={{ root: { maxWidth: 380, lineHeight: 1.7 } }}>
                <span tabIndex={0} style={{ fontSize: 12, color: token.colorWarningText, cursor: 'default', whiteSpace: 'nowrap' }}>
                  <ExclamationCircleOutlined style={{ marginInlineEnd: 4 }} />{t('vecGapInline', { n: vecGap })}
                </span>
              </Tooltip>
            )}
            {vecGap > 0 && isAdmin && (
              <Button size="small" type="link" loading={refillBusy} onClick={doRefill}
                style={{ paddingInline: 2, fontSize: 12, color: token.colorWarningText }}>
                {t('vecGapAction')}
              </Button>
            )}
          </Space>
        }
        extra={
          <Space>
            <Button type="primary" icon={<CloudUploadOutlined />}
              onClick={() => { setUploadFolder(folderId === 'all' ? 'none' : folderId); setUploadOpen(true) }}>
              {t('upload')}
            </Button>
            {!isAdmin && (
              <Button icon={<SearchOutlined />} onClick={() => { setTestOpen(true); setTestRes(null) }}>{t('menuTest')}</Button>
            )}
            {isAdmin && (
              <Dropdown
                menu={{
                  items: [
                    { key: 'test', label: t('menuTest') },
                    { key: 'refill', label: t('menuRefill'), disabled: refillBusy },
                    { key: 'rebuild', label: t('menuRebuild') },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'test') { setTestOpen(true); setTestRes(null) }
                    if (key === 'refill') doRefill()
                    if (key === 'rebuild') setRebuildOpen(true)
                  },
                }}
              >
                <Button icon={<SettingOutlined />}>{t('maintenance')}</Button>
              </Dropdown>
            )}
          </Space>
        }
      >
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'docs',
              label: t('tabDocs'),
              children: (
                <>
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    {screens.md !== false ? (
                      <div style={{ width: 210, flexShrink: 0 }}>{folderPanel}</div>
                    ) : null}
                    <div style={{ flex: 1, minWidth: screens.md !== false ? 320 : 0 }}>
                  <Space wrap style={{ marginBottom: 12 }}>
                    {screens.md === false && (
                      <Button icon={<FolderOutlined />} onClick={() => setFolderDrawer(true)}>{currentFolderName}</Button>
                    )}
                    <Input allowClear prefix={<SearchOutlined />} placeholder={t('searchPh')}
                      value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} style={{ width: 220 }} />
                    <Select value={status} onChange={(v) => { setStatus(v); setPage(1) }} style={{ width: 150 }}
                      options={[
                        { value: '', label: t('stAll') },
                        { value: 'ready', label: t('stReady') },
                        { value: 'processing', label: t('stProcessing') },
                        { value: 'failed', label: t('stFailed') },
                        { value: 'empty', label: t('stEmpty') },
                      ]} />
                    <Select value={scope} onChange={(v) => { setScope(v); setPage(1) }} style={{ width: 140 }}
                      options={[
                        { value: 'all', label: t('scopeAll') },
                        { value: 'mine', label: t('scopeMine') },
                      ]} />
                    <Button icon={<ReloadOutlined />} onClick={() => { load(); useAiRuntimeStore.getState().load(true) }}>{t('refresh')}</Button>
                    {selected.length > 0 && (
                      <Button danger icon={<DeleteOutlined />} onClick={batchRemove}>
                        {t('batchRemove', { n: selected.length })}
                      </Button>
                    )}
                  </Space>
                  <Table
                    rowKey="id"
                    size="middle"
                    rowSelection={{
                      selectedRowKeys: selected,
                      onChange: (keys) => setSelected(keys),
                      getCheckboxProps: (d) => ({
                        disabled: !(isAdmin || d.owner === me?.username),
                      }),
                    }}
                    columns={docColumns}
                    dataSource={docs}
                    loading={loading}
                    scroll={{ x: 980 }}
                    pagination={{
                      current: page, pageSize, total, showSizeChanger: true,
                      pageSizeOptions: [20, 50],
                      onChange: (p, ps) => { setPage(p); setPageSize(ps) },
                    }}
                    locale={{ emptyText: <Empty description={t('emptyDesc')} /> }}
                  />
                    </div>
                  </div>
                </>
              ),
            },
            {
              key: 'trash',
              // 教师回收站只列自己的文档，徽标计数不能借用全校 stats.trash_docs
              label: `${t('tabTrash')}${isAdmin && stats?.trash_docs ? ` (${stats.trash_docs})` : ''}`,
              children: (
                <>
                  <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                    title={t('trashNotice', { days: caps?.trash_days ?? 30 })}
                    description={!isAdmin ? t('trashMine') : undefined} />
                  <Table rowKey="id" size="middle" columns={trashColumns} dataSource={trash}
                    pagination={false} scroll={{ x: 700 }} />
                </>
              ),
            },
          ]}
        />
      </Card>

      <input ref={fileRef} type="file" multiple accept={acceptAttr}
        style={{ display: 'none' }} onChange={onPick} />
      <input ref={replaceRef} type="file" accept={acceptAttr}
        style={{ display: 'none' }} onChange={onReplacePick} />

      <Modal
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        title={<Space><CloudUploadOutlined style={{ color: '#1677ff' }} />{t('uploadTitle')}</Space>}
        width={560}
        centered
        mask={{ closable: false }}
        footer={[
          <Button key="clear" onClick={() => setQueue([])} disabled={queue.some((x) => x.state === 'uploading')}>
            {t('clearDone')}
          </Button>,
          <Button key="close" type="primary" onClick={() => setUploadOpen(false)}>{t('close')}</Button>,
        ]}
      >
        <div
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const fs = Array.from(e.dataTransfer.files || [])
            if (fs.length) processFiles(fs)
          }}
          style={{
            border: `1.5px dashed ${dragOver ? '#1677ff' : '#b7d4ff'}`,
            borderRadius: 12,
            padding: '30px 16px',
            textAlign: 'center',
            cursor: 'pointer',
            background: dragOver ? '#e6f4ff' : 'linear-gradient(180deg, #f8fbff 0%, #f2f7ff 100%)',
            transition: 'border-color .2s, background .2s',
          }}
        >
          <div style={{
            width: 56, height: 56, margin: '0 auto 10px', borderRadius: '50%',
            background: '#e6f4ff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <CloudUploadOutlined style={{ fontSize: 28, color: '#1677ff' }} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 500 }}>{t('dropHint')}</div>
          <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 6 }}>{t('uploadRules', { exts: extsText, mb: maxMb })}</div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 6 }}>{t('moveTarget')}</div>
          <Select style={{ width: '100%' }} value={uploadFolder} onChange={setUploadFolder}
            options={[{ value: 'none', label: t('folderNone') },
              ...folders.items.map((f) => ({ value: String(f.id), label: f.name }))]} />
        </div>

        {queue.length > 0 && (
          <div style={{
            marginTop: 16, maxHeight: 280, overflowY: 'auto',
            border: '1px solid #f0f0f0', borderRadius: 8, padding: '2px 12px', background: '#fcfcfc',
          }}>
            {queue.map((item) => (
              <div key={item.uid} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                  <span style={{ fontSize: 12, color: '#999', flexShrink: 0 }}>{fmtSize(item.size)}</span>
                </div>
                <div style={{ marginTop: 4 }}>
                  {item.state === 'queued' && <Tag>{t('qWaiting')}</Tag>}
                  {item.state === 'uploading' && <Progress percent={item.progress} size="small" />}
                  {item.state === 'done' && <Tag color="success">{t('qDone')}</Tag>}
                  {item.state === 'failed' && <Tag color="error">{item.reason || t('qFailed')}</Tag>}
                  {item.state === 'failed' && !item.skipId && item.attempted && (
                    <Button size="small" style={{ marginLeft: 6 }} onClick={() => retryItem(item)}>{t('retry')}</Button>
                  )}
                  {item.state === 'failed' && item.skipId && item.skipReason === 'in_trash' && (
                    <Space size={4} style={{ marginTop: 4 }}>
                      <Button size="small" onClick={() => restoreSkipped(item)}>{t('restoreExisting')}</Button>
                      <Button size="small" type="primary" onClick={() => uploadAnyway(item)}>{t('uploadAnyway')}</Button>
                    </Space>
                  )}
                  {item.state === 'failed' && item.skipId && item.skipReason === 'duplicate' && (
                    <Space size={4} style={{ marginTop: 4 }}>
                      <Button size="small" type="primary" onClick={() => locateDoc(item)}>{t('locate')}</Button>
                    </Space>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Drawer open={detailOpen} onClose={() => setDetailOpen(false)} size={640} title={detail?.name}>
        {detail && (
          <>
            <Descriptions size="small" column={2} bordered items={[
              { key: 'size', label: t('colSize'), children: fmtSize(detail.size) },
              { key: 'pages', label: t('colPages'), children: chunksCell(detail) },
              { key: 'status', label: t('colStatus'), children: statusCell(detail) },
              { key: 'owner', label: t('colOwner'), children: detail.owner || '-' },
              { key: 'created', label: t('colCreated'), children: detail.created_at || '-' },
              { key: 'updated', label: t('colUpdated'), children: detail.updated_at || '-' },
            ]} />
            {detail.error && <Alert style={{ marginTop: 12 }} type="warning" showIcon title={detail.error} />}
            <Typography.Title level={5} style={{ marginTop: 16 }}>{t('previewTitle')}</Typography.Title>
            {(detail.chunks_preview || []).length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('noPreview')} />}
            {(detail.chunks_preview || []).map((c: any, i: number) => (
              <Card key={i} size="small" style={{ marginBottom: 8 }}
                title={`#${(c.ord ?? i) + 1} ${c.title || ''}`}>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{(c.text || '').slice(0, 400)}</div>
              </Card>
            ))}
            <Typography.Title level={5} style={{ marginTop: 16 }}>{t('auditTitle')}</Typography.Title>
            {(detail.audit || []).map((a: any, i: number) => (
              <div key={i} style={{ fontSize: 12, color: '#666' }}>
                {a.created_at} · {a.action} · {a.username || '-'}
              </div>
            ))}
          </>
        )}
      </Drawer>

      <Modal open={!!folderModal}
        onCancel={() => { setFolderModal(null); setFolderName('') }}
        title={folderModal?.mode === 'rename' ? t('folderRename') : t('newFolder')}
        okText={t('ok')} cancelText={t('cancel')}
        okButtonProps={{ disabled: !folderName.trim() }}
        onOk={submitFolder}>
        <Input value={folderName} maxLength={30} placeholder={t('folderNamePh')}
          onChange={(e) => setFolderName(e.target.value)} onPressEnter={submitFolder} />
      </Modal>

      <Modal open={!!moveTarget} onCancel={() => setMoveTarget(null)}
        title={t('moveTitle', { name: moveTarget?.name || '' })}
        okText={t('ok')} cancelText={t('cancel')} onOk={submitMove}>
        <Select style={{ width: '100%' }} value={moveFolder} onChange={setMoveFolder}
          options={[{ value: 'none', label: t('folderNone') },
            ...folders.items.map((f) => ({ value: String(f.id), label: `${f.name} (${f.cnt})` }))]} />
      </Modal>

      <Modal open={testOpen} onCancel={() => setTestOpen(false)} footer={null} title={t('testTitle')} width={680}>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={testQ} onChange={(e) => setTestQ(e.target.value)} onPressEnter={runTest}
            placeholder={t('testPh')} />
          <Button type="primary" loading={testLoading} onClick={runTest}>{t('runTest')}</Button>
        </Space.Compact>
        {testRes && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
              {t('testStat', {
                ms: testRes.stat?.elapsed_ms ?? 0,
                kw: testRes.stat?.kw ?? 0,
                vec: testRes.stat?.vec?.ok ? t('vecOn') : t('vecOff'),
              })}
            </div>
            {(testRes.items || []).map((h: any, i: number) => (
              <Card key={i} size="small" style={{ marginBottom: 8 }}
                title={<span>{`${i + 1}. 《${h.doc_name}》 ${h.title || ''}`}
                  <Tag style={{ marginLeft: 8 }} color="blue">{h.score}</Tag>
                  <Tag>{h.cos}</Tag>
                  <Tag color="geekblue">{(h.legs || []).join('+')}</Tag>
                </span>}>
                <div style={{ fontSize: 13 }}>{(h.text || '').slice(0, 220)}</div>
              </Card>
            ))}
            {(testRes.items || []).length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
          </div>
        )}
      </Modal>

      <Modal open={rebuildOpen} onCancel={() => setRebuildOpen(false)} title={t('rebuildTitle')}
        okText={t('ok')} cancelText={t('cancel')} onOk={doRebuild}>
        <Alert type="warning" showIcon title={t('rebuildWarn')} />
      </Modal>

      <Drawer open={screens.md === false && folderDrawer} onClose={() => setFolderDrawer(false)} size={280} title={t('folders')}>
        {folderPanel}
      </Drawer>

      <Modal open={!!purgeTarget} onCancel={() => setPurgeTarget(null)} title={t('purgeTitle')}
        okText={t('purgeOk')} cancelText={t('cancel')}
        okButtonProps={{ danger: true, disabled: purgeName.trim() !== (purgeTarget?.name || '') }}
        onOk={confirmPurge}>
        <p>{t('purgeConfirm', { name: purgeTarget?.name || '' })}</p>
        <Input value={purgeName} onChange={(e) => setPurgeName(e.target.value)}
          placeholder={purgeTarget?.name || ''} />
      </Modal>
    </div>
  )
}
