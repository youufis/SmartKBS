import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Card, Checkbox, Descriptions, Popconfirm, Segmented, Space, Table, Tag, Typography } from 'antd'
import { message } from '../utils/feedback'
import {
  DatabaseOutlined, DeleteOutlined, ReloadOutlined, RollbackOutlined, SaveOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'

const { Text } = Typography

/**
 * 备份与恢复（一个 Tab、一张表）
 *
 * 为什么合并成一张表：原来「数据备份」和「配置备份与恢复」上下两节，标题、说明、分页各来一遍，
 * 使用者要先搞清楚"哪一节才是要点的"。两种恢复的差别只是**范围**（整机回退 / 只回退配置），
 * 不是两个功能 —— 所以合并成一张表，用类型筛选切换，行上的操作按范围自适应。
 *
 * 顶部「数据存放位置」卡：数据到底在哪个目录、多大、磁盘还剩多少、配置当前健康状态。
 * 「升级后像丢了数据」的第一现场几乎都是路径（换目录、换 Windows 账号、安装目录里还有一份旧库）。
 */

interface BackupItem {
  name: string
  kind: 'upgrade' | 'restore_point' | 'config_guard'
  created_at: string
  size_mb: number
  files: string[]
  databases: string[]
  has_config: boolean
  has_content: boolean
  content_files: number
  has_source_tar: boolean
  restorable: boolean
  version: string
  warnings: string[]
  path: string
}

interface ConfigSource {
  id: string
  kind: string
  label: string
  path: string
  exists: boolean
  is_current: boolean
  size: number
  mtime: string
  keys: number
  subjects: number
  score: number
  factory_default: boolean
}

interface DirBrief { path: string; exists: boolean; files: number; bytes: number }

interface StorageInfo {
  storage_dir: string
  db_dir: string
  media_root: string
  config_file: string
  config_history_count: number
  db: Record<string, number>
  legacy_db: Record<string, number>
  desktop_layout: boolean
  legacy_data_at_risk: boolean
  upgrade_backups: DirBrief
  selfheal: DirBrief
  content: Record<string, DirBrief>
  disk: { total_gb: number; free_gb: number }
  config_health: {
    status: string; detail: string; score: number; subjects: number; factory_default: boolean
    exists: boolean; backup_exists: boolean; history_count: number
  }
}

const mb = (bytes: number) => (bytes > 0 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '-')

const StorageCard: React.FC = () => {
  const { t } = useTranslation('system')
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [checking, setChecking] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/api/config/storage')
      setInfo(data)
    } catch {
      setInfo(null)   // 老后端没有这个接口：整卡不显示，不影响下面的备份表
    }
  }, [])

  useEffect(() => { load() }, [load])

  const recheck = async () => {
    setChecking(true)
    try {
      const { data } = await apiClient.post('/api/config/alert')
      message.success(data?.notified ? t('storageAlertSent') : t('storageAlertNone'))
      await load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('storageAlertFailed'))
    } finally {
      setChecking(false)
    }
  }

  if (!info) return null
  const h = info.config_health || ({} as any)
  const bad = h.status && h.status !== 'ok'

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={<span><DatabaseOutlined /> {t('storageTitle')}</span>}
      extra={<Button size="small" icon={<ReloadOutlined />} onClick={recheck} loading={checking}>{t('storageRecheck')}</Button>}
    >
      {bad && (
        <Alert type={h.status === 'factory_default' ? 'error' : 'warning'} showIcon style={{ marginBottom: 12 }}
          title={h.status === 'factory_default' ? t('storageHealthFactory') : t('storageHealthBad')}
          description={h.detail || t('storageHealthHint')} />
      )}
      {info.legacy_data_at_risk && (
        <Alert type="error" showIcon style={{ marginBottom: 12 }}
          title={t('storageLegacyRisk')} description={t('storageLegacyRiskDesc')} />
      )}
      <Descriptions size="small" column={1} labelStyle={{ width: 148 }}>
        <Descriptions.Item label={t('storageDataDir')}>
          <Text copyable style={{ fontSize: 12 }}>{info.storage_dir}</Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('storageDbDir')}>
          <Space size={4} wrap>
            {Object.entries(info.db || {}).map(([name, size]) => (
              <Tag key={name} color={size ? 'blue' : 'default'}>{name} {size ? mb(size) : '-'}</Tag>
            ))}
            {info.desktop_layout && Object.entries(info.legacy_db || {})
              .filter(([, size]) => (size || 0) > 0)
              .map(([name, size]) => (
                <Tag key={`legacy-${name}`} color="red">{name} {t('storageInAppDir')} {mb(size || 0)}</Tag>
              ))}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label={t('storageContentDirs')}>
          <Space size={4} wrap>
            {Object.entries(info.content || {}).filter(([, v]) => v.exists).map(([name, v]) => (
              <Tag key={name}>{name}: {v.files} / {mb(v.bytes)}</Tag>
            ))}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label={t('storageConfig')}>
          <Text style={{ fontSize: 12 }}>{info.config_file}</Text>
          <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            {t('storageHistoryN', { n: info.config_history_count ?? 0 })}
            {' · '}{t('storageHealthScore', { score: h.score ?? '-', subjects: h.subjects ?? 0 })}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('storageBackups')}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {info.upgrade_backups?.path} · {info.upgrade_backups?.files ?? 0} {t('storageFiles')} · {mb(info.upgrade_backups?.bytes ?? 0)}
            {' · '}{info.disk?.free_gb >= 0 ? t('storageDiskFree', { free: info.disk?.free_gb ?? 0 }) : t('storageDiskUnknown')}
          </Text>
        </Descriptions.Item>
        {info.selfheal?.exists && (
          <Descriptions.Item label={t('storageSelfheal')}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {info.selfheal.path} · {info.selfheal.files} {t('storageFiles')} · {mb(info.selfheal.bytes)}
              {' · '}{t('storageSelfhealHint')}
            </Text>
          </Descriptions.Item>
        )}
      </Descriptions>
    </Card>
  )
}

type Scope = 'all' | 'backup' | 'config'

interface MergedRow {
  key: string
  scope: 'backup' | 'config'
  name: string
  path: string
  created: string
  sizeText: string
  tags: React.ReactNode
  status: React.ReactNode
  restorable: boolean
  deletable: boolean
  warning?: string
  backup?: BackupItem
  source?: ConfigSource
}

const BackupTableCard: React.FC = () => {
  const { t } = useTranslation('system')
  const [backups, setBackups] = useState<BackupItem[]>([])
  const [sources, setSources] = useState<ConfigSource[]>([])
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState('')
  const [creating, setCreating] = useState(false)
  const [fullBackup, setFullBackup] = useState(false)
  const [scope, setScope] = useState<Scope>('all')
  const [meta, setMeta] = useState({ total_size_mb: 0, disk_free_mb: -1, dir: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [b, s] = await Promise.all([
        apiClient.get('/api/system/upgrade/backups', { params: { page: 1, page_size: 100 } }),
        apiClient.get('/api/config/sources'),
      ])
      setBackups(b.data?.backups || [])
      setMeta({ total_size_mb: b.data?.total_size_mb ?? 0, disk_free_mb: b.data?.disk_free_mb ?? -1, dir: b.data?.dir ?? '' })
      // 「使用中」那份不进表（顶部数据位置卡已经写了它的路径与健康分），不存在的副本也不占行
      setSources((s.data?.sources || []).filter((x: ConfigSource) => x.exists && x.kind !== 'current'))
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupLoadingFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { load() }, [load])

  const create = async () => {
    setCreating(true)
    try {
      const { data } = await apiClient.post('/api/system/upgrade/backup', null, {
        params: { include_content: fullBackup },
      })
      const parts: string[] = [...(data?.databases || [])]
      if (data?.config?.length) parts.push(t('backupConfigShort'))
      if (data?.content_dirs?.length) parts.push(`${t('backupContentTag')}(${data.content_dirs.length})`)
      if (data?.source_tar) parts.push(t('backupSourceTar'))
      message.success(t('backupCreated', { items: parts.join('、') || '-' }))
      ;(data?.warnings || []).slice(0, 2).forEach((w: string) => message.warning(w))
      await load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupFailed'))
    } finally {
      setCreating(false)
    }
  }

  const restoreBackup = async (r: BackupItem) => {
    setActing(`b:${r.name}`)
    try {
      const { data } = await apiClient.post(
        `/api/system/upgrade/backups/${encodeURIComponent(r.name)}/restore`)
      const parts: string[] = [...(data?.databases || [])]
      if (data?.config_restored) parts.push(t('backupConfigShort'))
      const n = Object.values(data?.content_restored || {})
        .reduce((a: number, b: any) => a + Number(b || 0), 0)
      if (n) parts.push(`${t('backupContentTag')}+${n}`)
      message.success(t('backupRestoreOk', { items: parts.join('、') || '-' }))
      ;(data?.notes || []).slice(0, 3).forEach((x: string) => message.warning(x))
      await load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupRestoreFailed'))
    } finally {
      setActing('')
    }
  }

  const restoreConfig = async (r: ConfigSource) => {
    setActing(`c:${r.id}`)
    try {
      const { data } = await apiClient.post('/api/config/restore', { source: r.id })
      message.success(t('configRestoreOk', { n: data?.changed_count ?? 0 }))
      const keys: string[] = data?.changed_keys || []
      if (keys.length) message.info(t('configRestoreChanged', { keys: keys.slice(0, 8).join('、') }))
      setTimeout(() => window.location.reload(), 1500)   // 配置整页重载最稳（各 Tab 都要拿新值）
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('configRestoreFailed'))
    } finally {
      setActing('')
    }
  }

  const removeRow = async (row: MergedRow) => {
    setActing(`d:${row.key}`)
    try {
      if (row.scope === 'backup' && row.backup) {
        const { data } = await apiClient.delete(
          `/api/system/upgrade/backups/${encodeURIComponent(row.backup.name)}`)
        message.success(t('backupDeleted', { mb: data?.freed_mb ?? 0 }))
        if (data?.warning) message.warning(data.warning)
      } else if (row.source) {
        await apiClient.post('/api/config/sources/delete', { source: row.source.id })
        message.success(t('configRestoreDeleted'))
      }
      await load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupDeleteFailed'))
    } finally {
      setActing('')
    }
  }

  const rows: MergedRow[] = useMemo(() => {
    const out: MergedRow[] = []
    if (scope !== 'config') {
      backups.forEach((b) => out.push({
        key: `b:${b.name}`,
        scope: 'backup',
        name: b.name,
        path: b.path,
        created: b.created_at,
        sizeText: `${b.size_mb} MB`,
        tags: (
          <Space size={[4, 4]} wrap>
            {b.databases.map((f) => <Tag key={f} color="blue">{f}</Tag>)}
            {b.has_config && <Tag color="purple">{t('backupConfigShort')}</Tag>}
            {b.has_content && <Tag color="cyan">{t('backupContentTag')} {b.content_files}</Tag>}
            {b.has_source_tar && <Tag color="green">{t('backupSourceTar')}</Tag>}
            {!b.databases.length && !b.has_config && !b.has_content && !b.has_source_tar
              && (b.files.length ? b.files.map((f) => <Tag key={f}>{f}</Tag>) : <Text type="secondary">-</Text>)}
          </Space>
        ),
        status: b.kind === 'restore_point'
          ? <Tag color="orange">{t('backupKindRestorePoint')}</Tag>
          : (b.databases.length
            ? <Tag color="green">{t('statusFull')}</Tag>
            : <Tag color="gold">{t('backupKindConfigGuard')}</Tag>),
        restorable: !!b.restorable,
        deletable: true,
        warning: (b.warnings || [])[0],
        backup: b,
      }))
    }
    if (scope !== 'backup') {
      sources.forEach((c) => out.push({
        key: `c:${c.id}`,
        scope: 'config',
        name: c.label,
        path: c.path,
        created: c.mtime,
        sizeText: `${(c.size / 1024).toFixed(1)} KB`,
        tags: (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('configRestoreContentLine', { subjects: c.subjects, keys: c.keys, kb: (c.size / 1024).toFixed(1) })}
            {' · '}{t('storageHealthScore', { score: c.score, subjects: c.subjects })}
          </Text>
        ),
        status: c.factory_default
          ? <Tag color="red">{t('configRestoreDefault')}</Tag>
          : <Tag color="green">{t('configRestoreUsable')}</Tag>,
        restorable: c.exists,
        // 真实配置（当前使用中/旧位置）与 .bak（主配置缺失时唯一可用）由后端拒绝删除
        deletable: c.kind !== 'legacy_backend',
        source: c,
      }))
    }
    return out
  }, [backups, sources, scope, t])

  const columns: any[] = [
    {
      title: t('colItem'),
      dataIndex: 'name',
      width: 280,
      render: (_: any, r: MergedRow) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.4 }}>
          <Space size={4} wrap>
            <Tag color={r.scope === 'backup' ? 'geekblue' : 'purple'}>
              {r.scope === 'backup' ? t('tagScopeBackup') : t('tagScopeConfig')}
            </Tag>
            <Text strong>{r.name}</Text>
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.path}</Text>
          {r.warning && <Text type="warning" style={{ fontSize: 11 }}>{r.warning}</Text>}
        </Space>
      ),
    },
    { title: t('backupColTime'), dataIndex: 'created', width: 160, render: (v: string) => v || '-' },
    { title: t('backupColSize'), dataIndex: 'sizeText', width: 92 },
    { title: t('backupColContent'), dataIndex: 'tags' },
    { title: t('configRestoreColStatus'), dataIndex: 'status', width: 132 },
    {
      title: t('backupColAction'),
      width: 190,
      render: (_: any, r: MergedRow) => (
        <Space size={4}>
          <Popconfirm
            title={r.scope === 'backup' ? t('backupRestoreConfirmTitle') : t('configRestoreConfirmTitle')}
            description={r.scope === 'backup'
              ? (r.backup?.has_content ? t('backupRestoreConfirmDesc') : t('backupRestoreConfirmNoContent'))
              : t('configRestoreConfirmDesc')}
            okText={t('backupRestoreConfirmOk')}
            cancelText={t('cancel')}
            disabled={!r.restorable}
            onConfirm={() => (r.scope === 'backup' && r.backup
              ? restoreBackup(r.backup) : (r.source ? restoreConfig(r.source) : undefined))}
          >
            <Button size="small" icon={<RollbackOutlined />} disabled={!r.restorable}
              loading={acting === `b:${r.backup?.name}` || acting === `c:${r.source?.id}`}>
              {r.scope === 'backup' ? t('restoreFull') : t('restoreConfigOnly')}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t('backupDeleteConfirm')}
            description={rows.length <= 1 ? t('backupDeleteLastHint') : undefined}
            okText={t('backupDeleteOk')}
            cancelText={t('cancel')}
            disabled={!r.deletable}
            onConfirm={() => removeRow(r)}
          >
            <Button size="small" type="text" danger icon={<DeleteOutlined />}
              disabled={!r.deletable} loading={acting === `d:${r.key}`} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title={<span><DatabaseOutlined /> {t('backupDataTitle')}</span>}
      extra={
        <Space wrap>
          <Segmented
            size="small"
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={[
              { label: t('scopeAll'), value: 'all' },
              { label: t('scopeBackups'), value: 'backup' },
              { label: t('scopeConfigs'), value: 'config' },
            ]}
          />
          <Checkbox checked={fullBackup} onChange={(e) => setFullBackup(e.target.checked)}>
            {t('backupScopeFull')}
          </Checkbox>
          <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>{t('refresh')}</Button>
          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={create} loading={creating}>
            {creating ? t('backupCreating') : t('backupNow')}
          </Button>
        </Space>
      }
    >
      <Alert type="info" showIcon style={{ marginBottom: 8 }}
        title={t('mergedAlertTitle')} description={t('mergedAlertDesc')} />
      <Text type="secondary" style={{ fontSize: 12 }}>
        {t('backupSummary', { n: backups.length, mb: meta.total_size_mb,
          free: meta.disk_free_mb >= 0 ? meta.disk_free_mb : '-' })}
        {' · '}{meta.dir}
      </Text>
      <Table<MergedRow>
        rowKey="key"
        size="small"
        style={{ marginTop: 8 }}
        loading={loading}
        dataSource={rows}
        columns={columns}
        locale={{ emptyText: t('backupEmpty') }}
        pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50],
          showTotal: (n) => t('backupTotal', { n }) }}
      />
    </Card>
  )
}

const BackupPanel: React.FC = () => (
  <>
    <StorageCard />
    <BackupTableCard />
  </>
)

export default BackupPanel
