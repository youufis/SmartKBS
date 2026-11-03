import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert, Button, Card, Checkbox, Descriptions, message, Popconfirm, Space, Table, Tag, Typography,
} from 'antd'
import {
  DatabaseOutlined, DeleteOutlined, ReloadOutlined, RollbackOutlined, SaveOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import ConfigRestorePanel from './ConfigRestorePanel'

const { Text } = Typography

/**
 * 备份与恢复（一个 Tab 里放三件事）
 *
 * ① 「数据存放位置」：数据到底在哪个目录、多大、磁盘还剩多少，以及配置当前健康状态。
 *    「升级后像丢了数据」的第一现场几乎都是路径（换目录、换 Windows 账号、
 *    安装目录里还残留一份旧库），先把位置摊开，比让人翻日志快得多。
 * ② 「数据备份」：默认只备两个数据库 + 系统配置（快、小、够用）；
 *    勾「整站备份」再附带内容目录（root/stu/上传媒体等），恢复时按"只补缺失"并回，
 *    绝不覆盖现有文件。桌面版与源码包部署没有 git 链路，也能正常备份（源码快照自动跳过）。
 * ③ 「配置备份与恢复」：只回滚 system_config.json，用于"配置被打回出厂默认值"这种局部故障。
 *
 * 三者放一起：触发场景往往是同一次升级，用户不该在两个页面之间找。
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

interface StorageInfo {
  storage_dir: string
  db_dir: string
  media_root: string
  config_file: string
  config_history_count: number
  upgrade_backups: { path: string; exists: boolean; files: number; bytes: number }
  content: Record<string, { path: string; exists: boolean; files: number; bytes: number }>
  db: Record<string, number>
  legacy_db: Record<string, number>
  desktop_layout: boolean
  legacy_data_at_risk: boolean
  disk: { total_gb: number; free_gb: number }
  config_health: {
    status: string
    detail: string
    score: number
    subjects: number
    factory_default: boolean
    exists: boolean
    backup_exists: boolean
    history_count: number
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
      setInfo(null)   // 老后端没有这个接口：整卡不显示即可，不影响备份列表
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
        <Alert
          type={h.status === 'factory_default' ? 'error' : 'warning'}
          showIcon
          style={{ marginBottom: 12 }}
          title={h.status === 'factory_default' ? t('storageHealthFactory') : t('storageHealthBad')}
          description={h.detail || t('storageHealthHint')}
        />
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
            {' · '}{t('storageDiskFree', { gb: info.disk?.free_gb ?? 0 })}
          </Text>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  )
}


const DataBackupCard: React.FC = () => {
  const { t } = useTranslation('system')
  const [items, setItems] = useState<BackupItem[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [acting, setActing] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(5)
  const [total, setTotal] = useState(0)
  const [fullBackup, setFullBackup] = useState(false)
  const [summary, setSummary] = useState({ total_size_mb: 0, disk_free_mb: -1 })

  const load = useCallback(async (p: number, ps: number) => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/system/upgrade/backups', {
        params: { page: p, page_size: ps },
      })
      setItems(data?.backups || [])
      setTotal(data?.total ?? data?.count ?? 0)
      setSummary({ total_size_mb: data?.total_size_mb ?? 0, disk_free_mb: data?.disk_free_mb ?? -1 })
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupLoadingFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    load(page, pageSize)
  }, [load, page, pageSize])

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
      const warns: string[] = data?.warnings || []
      warns.slice(0, 2).forEach((w) => message.warning(w))
      setPage(1)
      await load(1, pageSize)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupFailed'))
    } finally {
      setCreating(false)
    }
  }

  const restore = async (r: BackupItem) => {
    setActing(`${r.name}:restore`)
    try {
      const { data } = await apiClient.post(
        `/api/system/upgrade/backups/${encodeURIComponent(r.name)}/restore`)
      const parts: string[] = [...(data?.databases || [])]
      if (data?.config_restored) parts.push(t('backupConfigShort'))
      const contentN = Object.values(data?.content_restored || {})
        .reduce((a: number, b: any) => a + Number(b || 0), 0)
      if (contentN) parts.push(`${t('backupContentTag')}+${contentN}`)
      message.success(t('backupRestoreOk', { items: parts.join('、') || '-' }))
      ;(data?.notes || []).slice(0, 3).forEach((n: string) => message.warning(n))
      await load(page, pageSize)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupRestoreFailed'))
    } finally {
      setActing('')
    }
  }

  const remove = async (r: BackupItem) => {
    setActing(`${r.name}:delete`)
    try {
      const { data } = await apiClient.delete(
        `/api/system/upgrade/backups/${encodeURIComponent(r.name)}`)
      message.success(t('backupDeleted', { mb: data?.freed_mb ?? 0 }))
      if (data?.warning) message.warning(data.warning)
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page
      setPage(nextPage)
      await load(nextPage, pageSize)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupDeleteFailed'))
    } finally {
      setActing('')
    }
  }

  const contentCell = (r: BackupItem) => (
    <Space size={[4, 4]} wrap>
      {r.databases.map((f) => <Tag key={f} color="blue">{f}</Tag>)}
      {r.has_config && <Tag color="purple">{t('backupConfigShort')}</Tag>}
      {r.has_content && <Tag color="cyan">{t('backupContentTag')} {r.content_files}</Tag>}
      {r.has_source_tar && <Tag color="green">{t('backupSourceTar')}</Tag>}
      {!r.databases.length && !r.has_config && !r.has_content && !r.has_source_tar
        && r.files.map((f) => <Tag key={f}>{f}</Tag>)}
      {!r.databases.length && !r.has_config && !r.has_content && !r.has_source_tar && !r.files.length
        && <Text type="secondary">-</Text>}
    </Space>
  )

  const columns: any[] = [
    {
      title: t('backupColName'),
      dataIndex: 'name',
      width: 250,
      render: (_: any, r: BackupItem) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.4 }}>
          <Space size={4} wrap>
            <Text strong>{r.name}</Text>
            {r.kind === 'restore_point' && <Tag color="orange">{t('backupKindRestorePoint')}</Tag>}
            {r.kind === 'config_guard' && <Tag color="gold">{t('backupKindConfigGuard')}</Tag>}
            {!!r.version && <Tag>{r.version}</Tag>}
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.path}</Text>
          {(r.warnings || []).slice(0, 1).map((w) => (
            <Text key={w} type="warning" style={{ fontSize: 11 }}>{w}</Text>
          ))}
        </Space>
      ),
    },
    { title: t('backupColTime'), dataIndex: 'created_at', width: 165 },
    {
      title: t('backupColSize'), dataIndex: 'size_mb', width: 95,
      render: (v: number) => <Text>{v} MB</Text>,
    },
    { title: t('backupColContent'), render: (_: any, r: BackupItem) => contentCell(r) },
    {
      title: t('backupColAction'),
      width: 178,
      render: (_: any, r: BackupItem) => (
        <Space size={4}>
          <Popconfirm
            title={t('backupRestoreConfirmTitle')}
            description={r.has_content ? t('backupRestoreConfirmDesc') : t('backupRestoreConfirmNoContent')}
            okText={t('backupRestoreConfirmOk')}
            cancelText={t('cancel')}
            onConfirm={() => restore(r)}
          >
            <Button
              size="small"
              icon={<RollbackOutlined />}
              disabled={!r.restorable || (!!acting && acting !== `${r.name}:restore`)}
              loading={acting === `${r.name}:restore`}
            >
              {t('backupRestore')}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t('backupDeleteConfirm')}
            description={total <= 1 ? t('backupDeleteLastHint') : undefined}
            okText={t('backupDeleteOk')}
            cancelText={t('cancel')}
            onConfirm={() => remove(r)}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              loading={acting === `${r.name}:delete`}
              disabled={!!acting && acting !== `${r.name}:delete`}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title={<span><DatabaseOutlined /> {t('backupDataTitle')}</span>}
      style={{ marginBottom: 16 }}
      extra={
        <Space>
          <Checkbox checked={fullBackup} onChange={(e) => setFullBackup(e.target.checked)}>
            {t('backupScopeFull')}
          </Checkbox>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => load(page, pageSize)} loading={loading}>
            {t('refresh')}
          </Button>
          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={create} loading={creating}>
            {creating ? t('backupCreating') : t('backupNow')}
          </Button>
        </Space>
      }
    >
      <Alert type="info" showIcon style={{ marginBottom: 4 }}
        title={t('backupDataAlertTitle')}
        description={fullBackup ? t('backupDataDescFull') : t('backupDataDesc')} />
      <Text type="secondary" style={{ fontSize: 12 }}>
        {t('backupSummary', { n: total, mb: summary.total_size_mb, free: summary.disk_free_mb })}
      </Text>
      <Table
        rowKey="name"
        size="small"
        style={{ marginTop: 8 }}
        loading={loading}
        dataSource={items}
        columns={columns}
        locale={{ emptyText: t('backupEmpty') }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [5, 10, 20],
          showTotal: (n) => t('backupTotal', { n }),
          onChange: (p, ps) => {
            setPage(p)
            setPageSize(ps)
          },
        }}
      />
    </Card>
  )
}

const BackupPanel: React.FC = () => (
  <>
    <StorageCard />
    <DataBackupCard />
    <ConfigRestorePanel />
  </>
)

export default BackupPanel
