import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Card, message, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import {
  DatabaseOutlined, DeleteOutlined, ReloadOutlined, RollbackOutlined, SaveOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import ConfigRestorePanel from './ConfigRestorePanel'

const { Text } = Typography

/**
 * 备份与恢复（一个 Tab 里放两件事）
 *
 * 上半「数据备份」：整站备份 —— 两个数据库 + 系统配置 + 上传的图片音频 + 当前源码快照，
 *   落到 .upgrade_backups/pre_upgrade_<时间>/。支持立即备份、整站恢复、删除、分页。
 * 下半「配置备份与恢复」：只回滚 system_config.json，用于"配置被重置成默认值"这种局部故障。
 *
 * 之所以放在一起：这两件事的触发场景往往同时出现（升级），用户不该在两个页面之间找。
 */

interface BackupItem {
  name: string
  kind: 'upgrade' | 'restore_point'
  created_at: string
  size_mb: number
  files: string[]
  has_source_tar: boolean
  path: string
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

  const load = useCallback(async (p: number, ps: number) => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/system/upgrade/backups', {
        params: { page: p, page_size: ps },
      })
      setItems(data?.backups || [])
      setTotal(data?.total ?? data?.count ?? 0)
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
      const { data } = await apiClient.post('/api/system/upgrade/backup')
      message.success(t('backupCreated', { path: data?.backup_path || '' }))
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
      const parts = [...(data?.databases || [])]
      if (data?.config_restored) parts.push(t('backupConfigShort'))
      message.success(t('backupRestoreOk', { items: parts.join('、') || '-' }))
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
      // 删掉当页最后一条时回退一页，避免停在空页
      const nextPage = items.length === 1 && page > 1 ? page - 1 : page
      setPage(nextPage)
      await load(nextPage, pageSize)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('backupDeleteFailed'))
    } finally {
      setActing('')
    }
  }

  const columns: any[] = [
    {
      title: t('backupColName'),
      dataIndex: 'name',
      width: 240,
      render: (_: any, r: BackupItem) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.4 }}>
          <Space size={4} wrap>
            <Text strong>{r.name}</Text>
            {r.kind === 'restore_point' && <Tag color="orange">{t('backupKindRestorePoint')}</Tag>}
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.path}</Text>
        </Space>
      ),
    },
    { title: t('backupColTime'), dataIndex: 'created_at', width: 165 },
    {
      title: t('backupColSize'), dataIndex: 'size_mb', width: 95,
      render: (v: number) => <Text>{v} MB</Text>,
    },
    {
      title: t('backupColContent'),
      render: (_: any, r: BackupItem) => (
        <Space size={[4, 4]} wrap>
          {r.files.map((f) => (
            <Tag key={f} color={f.endsWith('.db') ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>{f}</Tag>
          ))}
          {r.has_source_tar && <Tag color="green">{t('backupSourceTar')}</Tag>}
          {!r.files.length && !r.has_source_tar && <Text type="secondary">-</Text>}
        </Space>
      ),
    },
    {
      title: t('backupColAction'),
      width: 170,
      render: (_: any, r: BackupItem) => (
        <Space size={4}>
          <Popconfirm
            title={t('backupRestoreConfirmTitle')}
            description={t('backupRestoreConfirmDesc')}
            okText={t('backupRestoreConfirmOk')}
            cancelText={t('cancel')}
            onConfirm={() => restore(r)}
          >
            <Button
              size="small"
              icon={<RollbackOutlined />}
              loading={acting === `${r.name}:restore`}
              disabled={!!acting && acting !== `${r.name}:restore`}
            >
              {t('backupRestore')}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t('backupDeleteConfirm')}
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
          <Button size="small" icon={<ReloadOutlined />} onClick={() => load(page, pageSize)} loading={loading}>
            {t('refresh')}
          </Button>
          <Button size="small" type="primary" icon={<SaveOutlined />} onClick={create} loading={creating}>
            {creating ? t('backupCreating') : t('backupNow')}
          </Button>
        </Space>
      }
    >
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        title={t('backupDataAlertTitle')} description={t('backupDataDesc')} />
      <Table
        rowKey="name"
        size="small"
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
    <DataBackupCard />
    <ConfigRestorePanel />
  </>
)

export default BackupPanel
