import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Card, message, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import { DeleteOutlined, HistoryOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons'
import apiClient from '../api/client'

const { Text } = Typography

/**
 * 配置备份与恢复
 *
 * 用在什么时候：升级或误操作把整份 system_config.json 打回出厂默认值 —— 表现是
 * 课程列表只剩「人工智能」、APPID 与知识库配置为空，但服务本身照常运行。
 * 后端把所有历史副本（当前 / .bak / 旧位置 backend/ / 各类备份目录）列出来并按
 * "健康分"排序：出厂默认值同样是 111 个键、约 5KB，只看大小分不出来，只能靠
 * APPID、版本号、知识库这几个指纹判断。
 */

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

const ConfigRestorePanel: React.FC = () => {
  // 与系统配置页其余面板保持一致：文案都在 system 命名空间里（默认命名空间读不到会直接显示 key）
  const { t } = useTranslation('system')
  const [items, setItems] = useState<ConfigSource[]>([])
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState('')
  const [removing, setRemoving] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/config/sources')
      setItems(data?.sources || [])
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('configRestoreLoadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  const restore = async (row: ConfigSource) => {
    setPending(row.id)
    try {
      const { data } = await apiClient.post('/api/config/restore', { source: row.id })
      message.success(t('configRestoreOk', { n: data?.changed_count ?? 0 }))
      const keys: string[] = data?.changed_keys || []
      if (keys.length) {
        message.info(t('configRestoreChanged', { keys: keys.slice(0, 8).join('、') }))
      }
      // 页面上的配置表单状态很复杂，恢复后整体重载最稳（也保证各 Tab 拿到新值）
      setTimeout(() => window.location.reload(), 1500)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('configRestoreFailed'))
    } finally {
      setPending('')
    }
  }

  // 只允许删"备份类"副本：当前使用中与旧位置的真实配置留着，避免误删唯一可用的一份
  const deletable = (r: ConfigSource) => r.exists && !r.is_current
    && r.kind !== 'current' && r.kind !== 'legacy_backend'

  const remove = async (row: ConfigSource) => {
    setRemoving(row.id)
    try {
      await apiClient.post('/api/config/sources/delete', { source: row.id })
      message.success(t('configRestoreDeleted'))
      await load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('configRestoreDeleteFailed'))
    } finally {
      setRemoving('')
    }
  }

  const columns: any[] = [
    {
      title: t('configRestoreColSource'),
      dataIndex: 'label',
      width: 200,
      render: (_: any, r: ConfigSource) => (
        <Space direction="vertical" size={0} style={{ lineHeight: 1.4 }}>
          <Space size={4} wrap>
            <Text strong>{r.label}</Text>
            {r.is_current && <Tag color="blue">{t('configRestoreCurrent')}</Tag>}
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.path}</Text>
        </Space>
      ),
    },
    { title: t('configRestoreColTime'), dataIndex: 'mtime', width: 130, render: (v: string) => v || '-' },
    {
      title: t('configRestoreColContent'),
      width: 170,
      render: (_: any, r: ConfigSource) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('configRestoreContentLine', {
            subjects: r.subjects, keys: r.keys, kb: (r.size / 1024).toFixed(1),
          })}
        </Text>
      ),
    },
    {
      title: t('configRestoreColStatus'),
      width: 120,
      render: (_: any, r: ConfigSource) => {
        if (!r.exists) return <Tag>{t('configRestoreMissing')}</Tag>
        if (r.factory_default) return <Tag color="red">{t('configRestoreDefault')}</Tag>
        return <Tag color="green">{t('configRestoreUsable')}</Tag>
      },
    },
    {
      title: t('configRestoreColAction'),
      width: 180,
      render: (_: any, r: ConfigSource) => (
        <Space size={4}>
          <Popconfirm
            title={t('configRestoreConfirmTitle')}
            description={t('configRestoreConfirmDesc')}
            okText={t('configRestoreConfirmOk')}
            cancelText={t('cancel')}
            disabled={!r.exists || r.is_current}
            onConfirm={() => restore(r)}
          >
            <Button
              size="small"
              icon={<RollbackOutlined />}
              danger={r.factory_default}
              disabled={!r.exists || r.is_current}
              loading={pending === r.id}
            >
              {t('configRestoreAction')}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t('configRestoreDeleteConfirm')}
            okText={t('configRestoreDeleteOk')}
            cancelText={t('cancel')}
            disabled={!deletable(r)}
            onConfirm={() => remove(r)}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              disabled={!deletable(r)}
              loading={removing === r.id}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title={<span><HistoryOutlined /> {t('configRestoreTitle')}</span>}
      style={{ marginBottom: 16 }}
      extra={<Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>{t('refresh')}</Button>}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title={t('configRestoreAlertTitle')}
        description={t('configRestoreAlertDesc')}
      />
      <Table
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        columns={columns}
        pagination={{ pageSize: 5, showSizeChanger: true, pageSizeOptions: [5, 10, 20], showTotal: (n) => t('configRestoreTotal', { n }) }}
        locale={{ emptyText: t('configRestoreEmpty') }}
      />
    </Card>
  )
}

export default ConfigRestorePanel
