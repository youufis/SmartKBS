/** 本地知识库（独立模块页）——文档列表 / 上传队列 / 回收站 / 检索测试 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert, Button, Card, Col, Descriptions, Drawer, Dropdown, Empty, Input, Modal,
  Progress, Row, Select, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography, message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CloudUploadOutlined, DatabaseOutlined, DeleteOutlined, FolderOpenOutlined, FolderOutlined, PlusOutlined,
  MoreOutlined, ReloadOutlined, SearchOutlined, SettingOutlined,
} from '@ant-design/icons'
import { kbApi } from '../api/kb'
import type { KbDoc, KbStats } from '../api/kb'

const EXT_OK = ['.md', '.txt', '.docx', '.pdf']
const MAX_MB = 20

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
  const [purgeTarget, setPurgeTarget] = useState<KbDoc | null>(null)
  const [purgeName, setPurgeName] = useState('')
  const [replaceTarget, setReplaceTarget] = useState<KbDoc | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)

  const me = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('smartkb_user') || 'null') } catch { return null }
  }, [])
  const isAdmin = me?.role === 'admin'

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

  const loadTrash = useCallback(async () => {
    try {
      const r = await kbApi.trash()
      setTrash(r.items || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('loadFailed'))
    }
  }, [t])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (tab === 'trash' && isAdmin) loadTrash()
  }, [tab, isAdmin, loadTrash])

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
    const ids = docs.filter(d => d.status === 'pending' || d.status === 'indexing').map(d => d.id)
    const timer = setInterval(async () => {
      try {
        const r = await kbApi.status(ids)
        const map = new Map<number, any>((r.items || []).map((x: any) => [x.id, x]))
        setDocs(prev => prev.map(d => (map.has(d.id) ? { ...d, ...map.get(d.id) } : d)))
        if ((r.items || []).every((x: any) => x.status !== 'pending' && x.status !== 'indexing')) {
          load(true)
        }
      } catch { /* 轮询失败静默，下一轮再试 */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [activeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const patchQ = (uid: string, patch: Partial<QItem>) =>
    setQueue(prev => prev.map(x => (x.uid === uid ? { ...x, ...patch } : x)))

  const processFiles = async (files: File[]) => {
    const items: QItem[] = files.slice(0, 20).map((f, i) => {
      const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase()
      let reason = ''
      if (!EXT_OK.includes(ext)) reason = t('errExt')
      else if (f.size > MAX_MB * 1048576) reason = t('errSize', { mb: MAX_MB })
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
        patchQ(item.uid, { state: 'uploading' })
        try {
          const res = await kbApi.upload(item.file!, (p) => patchQ(item.uid, { progress: p }), uploadFolder)
          if (res.uploaded?.length) {
            patchQ(item.uid, { state: 'done', progress: 100, docId: res.uploaded[0].id })
          } else if (res.skipped?.length) {
            const why = res.skipped[0].reason === 'in_trash' ? t('inTrash') : t('duplicate')
            patchQ(item.uid, { state: 'failed', reason: why, skipId: res.skipped[0].id })
          } else {
            patchQ(item.uid, { state: 'failed', reason: res.errors?.[0]?.reason || t('uploadFailed') })
          }
        } catch (e: any) {
          patchQ(item.uid, { state: 'failed', reason: e?.response?.data?.detail || t('uploadFailed') })
        }
      }
    }
    await Promise.all([worker(), worker()])
    load(true)
    loadFolders()
    if (isAdmin) loadTrash()
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
      patchQ(item.uid, { state: 'done', progress: 100, skipId: undefined })
      message.success(t('restored'))
      load(true)
      loadFolders()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('opFailed'))
    }
  }

  const uploadAnyway = async (item: QItem) => {
    if (!item.file) return
    patchQ(item.uid, { state: 'uploading', progress: 0, reason: '', skipId: undefined })
    try {
      const res = await kbApi.upload(item.file, (p) => patchQ(item.uid, { progress: p }), uploadFolder, true)
      if (res.uploaded?.length) {
        patchQ(item.uid, { state: 'done', progress: 100 })
        load(true)
        loadFolders()
      } else {
        patchQ(item.uid, { state: 'failed', reason: res.errors?.[0]?.reason || t('uploadFailed') })
      }
    } catch (e: any) {
      patchQ(item.uid, { state: 'failed', reason: e?.response?.data?.detail || t('uploadFailed') })
    }
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
      title: t('colPages'), width: 110,
      render: (_: any, d) => `${d.pages || '-'} / ${d.chunks || 0}`,
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
        if (isAdmin) {
          items.push({ key: 'reindex', label: t('actReindex'), disabled: d.status === 'indexing' })
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
          <Button size="small" onClick={() => doRestore(d)}>{t('actRestore')}</Button>
          <Button size="small" danger onClick={() => { setPurgeTarget(d); setPurgeName('') }}>
            {t('actPurge')}
          </Button>
        </Space>
      ),
    },
  ]

  if (disabled) {
    return (
      <div style={{ padding: 16 }}>
        <Card>
          <Alert type="warning" showIcon message={t('disabledTitle')} description={t('disabledHint')} />
        </Card>
      </div>
    )
  }

  return (
    <div style={{ padding: 16 }}>
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title={t('statDocs')} value={stats?.docs || 0}
            suffix={`/ ${stats?.quota_docs || '-'}`} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title={t('statChunks')} value={stats?.chunks || 0} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title={t('statVec')} value={Math.round((stats?.vec_coverage || 0) * 100)} suffix="%" /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>{t('statCapacity')}</div>
            <Progress percent={stats?.quota_mb ? Math.min(100, Math.round(((stats?.used_mb ?? stats?.size_mb ?? 0) / stats.quota_mb) * 100)) : 0} size="small" />
            <div style={{ fontSize: 12, color: '#999' }}>
              {stats?.used_mb ?? stats?.size_mb ?? 0} / {stats?.quota_mb || '-'} MB
              {stats?.trash_docs ? ` · ${t('trashHint', { n: stats.trash_docs })}` : ''}
            </div>
          </Card>
        </Col>
      </Row>

      <Card
        style={{ marginTop: 12 }}
        title={<Space><DatabaseOutlined />{t('title')}</Space>}
        extra={
          <Space>
            <Button type="primary" icon={<CloudUploadOutlined />}
              onClick={() => { setUploadFolder(folderId === 'all' ? 'none' : folderId); setUploadOpen(true) }}>
              {t('upload')}
            </Button>
            {isAdmin && (
              <Dropdown
                menu={{
                  items: [
                    { key: 'test', label: t('menuTest') },
                    { key: 'rebuild', label: t('menuRebuild') },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'test') { setTestOpen(true); setTestRes(null) }
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
        {stats?.dual_index && !stats?.local_ready?.model_present && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('localChannelHint', { model: stats?.local_ready?.model || 'bge-m3' })}
          />
        )}
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
                    <div style={{ width: 210, flexShrink: 0 }}>
                      <Card size="small" bodyStyle={{ padding: 8 }}
                        title={<span style={{ fontSize: 13 }}>{t('folders')}</span>}
                        extra={<Button size="small" type="text" icon={<PlusOutlined />}
                          onClick={() => { setFolderModal({ mode: 'create' }); setFolderName('') }} />}>
                        <div style={folderRowStyle(folderId === 'all')} onClick={() => { setFolderId('all'); setPage(1) }}>
                          <FolderOutlined /><span style={{ flex: 1 }}>{t('folderAll')}</span>
                          <span style={{ color: '#999' }}>{stats?.docs || 0}</span>
                        </div>
                        <div style={folderRowStyle(folderId === 'none')} onClick={() => { setFolderId('none'); setPage(1) }}>
                          <FolderOutlined /><span style={{ flex: 1 }}>{t('folderNone')}</span>
                          <span style={{ color: '#999' }}>{folders.uncategorized}</span>
                        </div>
                        {folders.items.map((f) => (
                          <div key={f.id} style={folderRowStyle(folderId === String(f.id))}
                            onClick={() => { setFolderId(String(f.id)); setPage(1) }}>
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
                              {['试题', '教材', '教案'].map((n) => (
                                <Tag key={n} style={{ cursor: 'pointer', margin: 0 }} onClick={() => quickCreate(n)}>+{n}</Tag>
                              ))}
                            </div>
                          </div>
                        )}
                      </Card>
                    </div>
                    <div style={{ flex: 1, minWidth: 320 }}>
                  <Space wrap style={{ marginBottom: 12 }}>
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
                    <Button icon={<ReloadOutlined />} onClick={() => load()}>{t('refresh')}</Button>
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
            ...(isAdmin ? [{
              key: 'trash',
              label: `${t('tabTrash')}${stats?.trash_docs ? ` (${stats.trash_docs})` : ''}`,
              children: (
                <>
                  <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('trashNotice')} />
                  <Table rowKey="id" size="middle" columns={trashColumns} dataSource={trash}
                    pagination={false} scroll={{ x: 700 }} />
                </>
              ),
            }] : []),
          ]}
        />
      </Card>

      <input ref={fileRef} type="file" multiple accept=".md,.txt,.docx,.pdf"
        style={{ display: 'none' }} onChange={onPick} />
      <input ref={replaceRef} type="file" accept=".md,.txt,.docx,.pdf"
        style={{ display: 'none' }} onChange={onReplacePick} />

      <Modal
        open={uploadOpen}
        onCancel={() => setUploadOpen(false)}
        title={<Space><CloudUploadOutlined style={{ color: '#1677ff' }} />{t('uploadTitle')}</Space>}
        width={560}
        centered
        maskClosable={false}
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
          <div style={{ fontSize: 12, color: '#8c8c8c', marginTop: 6 }}>{t('uploadRules', { mb: MAX_MB })}</div>
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
                  {item.state === 'failed' && item.skipId && (
                    <Space size={4} style={{ marginTop: 4 }}>
                      <Button size="small" onClick={() => restoreSkipped(item)}>{t('restoreExisting')}</Button>
                      <Button size="small" type="primary" onClick={() => uploadAnyway(item)}>{t('uploadAnyway')}</Button>
                    </Space>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <Drawer open={detailOpen} onClose={() => setDetailOpen(false)} width={640} title={detail?.name}>
        {detail && (
          <>
            <Descriptions size="small" column={2} bordered items={[
              { key: 'size', label: t('colSize'), children: fmtSize(detail.size) },
              { key: 'pages', label: t('colPages'), children: `${detail.pages || '-'} / ${detail.chunks || 0}` },
              { key: 'status', label: t('colStatus'), children: statusCell(detail) },
              { key: 'owner', label: t('colOwner'), children: detail.owner || '-' },
              { key: 'created', label: t('colCreated'), children: detail.created_at || '-' },
              { key: 'updated', label: t('colUpdated'), children: detail.updated_at || '-' },
            ]} />
            {detail.error && <Alert style={{ marginTop: 12 }} type="warning" showIcon message={detail.error} />}
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
        <Alert type="warning" showIcon message={t('rebuildWarn')} />
      </Modal>

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
