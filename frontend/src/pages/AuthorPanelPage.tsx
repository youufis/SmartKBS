import React, { useState, useEffect, useCallback } from 'react'
import {
  Typography, Table, Card, Row, Col, Statistic, Tag, Button, Modal, message, Popconfirm, Space, Tooltip
} from 'antd'
import {
  EyeOutlined, GlobalOutlined, ApiOutlined, TeamOutlined,
  LoginOutlined, EnvironmentOutlined, DeleteOutlined, ReloadOutlined, DownloadOutlined, ClearOutlined,
  CompressOutlined
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useTranslation } from 'react-i18next'

interface Deployment {
  id: number
  node_id: string
  hostname: string
  caller_ip: string
  public_ip: string
  country: string
  region: string
  city: string
  isp: string
  app_version: string
  platform: string
  first_sync: string
  last_sync: string
  sync_count: number
  online: boolean
  minutes_ago: number
  active_days?: number | null
  ledger_first_seen?: string
  total_hits?: number
  ip_count?: number
  ip_list?: string[]
  ip_active_days?: number | null
}

interface Stats {
  total_nodes: number
  online_nodes: number
  today_active: number
  weekly_active: number
  country_distribution: { country: string; count: number }[]
}

// 距今时长: 后端用服务器时间算好分钟数, 前端只负责口语化展示
const fmtAgo = (minutes: number | undefined, t: any) => {
  if (minutes === undefined || minutes === null || minutes < 0) return '-'
  if (minutes < 60) return t('agoMinutes', { n: minutes })
  if (minutes < 1440) return t('agoHours', { n: Math.floor(minutes / 60) })
  return t('agoDays', { n: Math.floor(minutes / 1440) })
}

const AuthorPanelPage: React.FC = () => {
  const { t } = useTranslation('system')
  const [loading, setLoading] = useState(false)
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [stats, setStats] = useState<Stats | null>(null)
  const [mapModalOpen, setMapModalOpen] = useState(false)
  const [deleting, setDeleting] = useState<number | null>(null)

  const loadData = useCallback(async (p: number, ps: number) => {
    setLoading(true)
    try {
      const [deployRes, statsRes] = await Promise.all([
        apiClient.get(`/api/config-sync/nodes?page=${p}&page_size=${ps}`),
        apiClient.get('/api/config-sync/summary'),
      ])
      setDeployments(deployRes.data.nodes || []),
      setTotal(deployRes.data.total || 0)
      setStats(statsRes.data)
    } catch (err) {
      console.error('加载数据失败', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData(page, pageSize)
  }, [page, pageSize, loadData])

  const handleDelete = async (id: number) => {
    setDeleting(id)
    try {
      await apiClient.delete(`/api/config-sync/record/${id}`)
      loadData(page, pageSize)
    } catch (err) {
    } finally {
      setDeleting(null)
    }
  }

  const handleClearAll = async () => {
    try {
      await apiClient.delete('/api/config-sync/clear')
      loadData(1, pageSize)
      setPage(1)
    } catch {
    }
  }

  const handleDeduplicate = async () => {
    try {
      const { data } = await apiClient.post('/api/config-sync/deduplicate')
      message.success(t('deduplicateComplete', { remaining: data.remaining }))
      loadData(1, pageSize)
      setPage(1)
    } catch {
    }
  }

  const handleExport = async () => {
    try {
      const { data } = await apiClient.get('/api/config-sync/export')
      const blob = new Blob([JSON.stringify(data.nodes, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `sync-logs-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
    }
  }

  const handleTableChange = (pagination: any) => {
    setPage(pagination.current)
    setPageSize(pagination.pageSize)
  }

  // V6.9 A 方案：11 列合并为 6 列两行制，全量字段收进 tooltip
  const shortPlatform = (pv?: string) => {
    if (!pv) return ''
    const parts = pv.split(/[-/\s]+/).filter(Boolean)
    const v = parts.slice(0, 2).join(' ')
    return v.length > 16 ? v.slice(0, 16) : v
  }

  const columns = [
    {
      title: t('status'), key: 'online', width: 96, fixed: 'left' as const,
      render: (_: any, r: Deployment) => (
        <div>
          <Tag color={r.online ? 'green' : 'default'} style={{ marginRight: 0 }}>
            {r.online ? `🟢 ${t('nodeOnline')}` : `⚪ ${t('nodeOffline')}`}
          </Tag>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{fmtAgo(r.minutes_ago, t)}</div>
        </div>
      ),
    },
    {
      title: t('device'), key: 'device', width: 150,
      render: (_: any, r: Deployment) => (
        <Tooltip title={`${t('nodeId')}: ${r.node_id}`}>
          <div>
            <div style={{ fontWeight: 500 }}>{r.hostname || '-'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{(r.node_id || '').slice(0, 8)}</div>
          </div>
        </Tooltip>
      ),
    },
    {
      title: t('network'), key: 'network', width: 220,
      render: (_: any, r: Deployment) => {
        const diff = !!r.public_ip && r.public_ip !== r.caller_ip
        return (
          <div>
            <span style={{ fontFamily: 'monospace' }}>{r.caller_ip || '-'}</span>
            {(r.ip_count ?? 1) > 1 && (
              <Tooltip title={`${t('ipMultiTip')}：${(r.ip_list || []).join('、')}`}>
                <Tag color="blue" style={{ marginLeft: 6, fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>
                  {t('ipMulti', { n: r.ip_count })}
                </Tag>
              </Tooltip>
            )}
            {diff && (
              <Tooltip title={`${t('publicIp')}: ${r.public_ip}`}>
                <Tag color="orange" style={{ marginLeft: 6, fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>
                  {t('ipDiff')}
                </Tag>
              </Tooltip>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {[r.country, r.city].filter((x) => x && x !== '未知').join(' ') || t('geoUnknown')}
              {r.isp ? ` · ${r.isp}` : ''}
            </div>
          </div>
        )
      },
    },
    {
      title: t('version'), key: 'version', width: 110,
      render: (_: any, r: Deployment) => (
        <Tooltip title={r.platform || '-'}>
          <div>
            <div>{r.app_version || '-'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{shortPlatform(r.platform)}</div>
          </div>
        </Tooltip>
      ),
    },
    {
      title: t('activeDays'), key: 'active', width: 92,
      sorter: (a: Deployment, b: Deployment) => (a.active_days ?? 0) - (b.active_days ?? 0),
      render: (_: any, r: Deployment) => (
        <Tooltip title={`${t('firstSeen')}: ${r.ledger_first_seen || r.first_sync} · ${t('heartbeatTimes', { n: r.total_hits ?? r.sync_count })}${(r.ip_active_days ?? 0) > 0 && r.ip_active_days !== r.active_days ? ` · ${t('ipActiveDaysTip', { n: r.ip_active_days })}` : ''}`}>
          <div>
            <span style={{ fontWeight: 500 }}>{r.active_days ?? '-'}</span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 2 }}>{t('unitDay')}</span>
          </div>
        </Tooltip>
      ),
    },
    {
      title: t('actions'), key: 'action', width: 60, fixed: 'right' as const,
      render: (_: any, r: Deployment) => (
        <Popconfirm
          title={t('confirmDeleteRecord')}
          onConfirm={() => handleDelete(r.id)}
          okText={t('confirmOk')}
          cancelText={t('cancel')}
        >
          <Button type="link" danger size="small" icon={<DeleteOutlined />} loading={deleting === r.id} />
        </Popconfirm>
      ),
    },
  ]

  const countryColumns = [
    { title: t('country'), dataIndex: 'country', key: 'country' },
    { title: t('deploymentCount'), dataIndex: 'count', key: 'count' },
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      <Typography.Title level={4} style={{ marginBottom: 8 }}>
        <ApiOutlined /> {t('console')}
      </Typography.Title>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        {t('systemOverview')}
      </Typography.Text>

      {/* 统计卡片 */}
      {stats && (
        <Row gutter={[10, 10]} style={{ marginBottom: 12 }}>
          {[
            { title: t('totalNodes'), value: stats.total_nodes, icon: <GlobalOutlined /> },
            { title: t('onlineNodes'), value: stats.online_nodes, icon: <ApiOutlined />,
              suffix: `/ ${stats.total_nodes}`, color: stats.online_nodes > 0 ? '#3f8600' : undefined },
            { title: t('todayActive'), value: stats.today_active, icon: <LoginOutlined /> },
            { title: t('weeklyActive'), value: stats.weekly_active, icon: <TeamOutlined /> },
            { title: t('countryRegion'), value: stats.country_distribution.length, icon: <EnvironmentOutlined />,
              suffix: t('unitCount'), onClick: () => setMapModalOpen(true) },
          ].map((c, idx) => (
            <Col key={idx} flex="1 1 0" style={{ minWidth: 128 }}>
              <Card size="small" hoverable onClick={c.onClick} style={c.onClick ? { cursor: 'pointer' } : undefined}>
                <Statistic
                  title={<span style={{ fontSize: 12 }}>{c.title}</span>}
                  value={c.value}
                  prefix={c.icon}
                  suffix={c.suffix}
                  valueStyle={{ fontSize: 18, color: c.color }}
                />
              </Card>
            </Col>
          ))}        </Row>
      )}

      {/* 节点列表 */}
      <Card
        title={
          <Space>
            <EyeOutlined />
            <span>{t('syncRecords')}</span>
            <Tag color="blue">{t('totalRecords', { count: total })}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>
              {t('export')}
            </Button>
            <Popconfirm
              title={t('confirmClearAll')}
              onConfirm={handleClearAll}
              okText={t('confirmOk')}
              cancelText={t('cancel')}
            >
              <Button size="small" danger icon={<ClearOutlined />}>
                {t('clearAll')}
              </Button>
            </Popconfirm>
            <Popconfirm
              title={t('confirmDeduplicate')}
              onConfirm={handleDeduplicate}
              okText={t('confirmOk')}
              cancelText={t('cancel')}
            >
              <Button size="small" icon={<CompressOutlined />}>
                {t('ipDeduplicate')}
              </Button>
            </Popconfirm>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => loadData(page, pageSize)}>
              {t('refresh')}
            </Button>
          </Space>
        }
      >
        <Table
          dataSource={deployments}
          columns={columns}
          rowKey="id"
          size="small"
          pagination={{
            current: page,
            pageSize: pageSize,
            total: total,
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50', '100'],
            showTotal: (total: number) => t('totalRecords', { count: total }),
          }}
          onChange={handleTableChange}
          scroll={{ x: 760 }}
          loading={loading}
        />
      </Card>

      {/* 国家分布弹窗 */}
      <Modal
        title={t('countryDistribution')}
        open={mapModalOpen}
        onCancel={() => setMapModalOpen(false)}
        footer={null}
        width={500}
      >
        {stats && (
          <Table
            dataSource={stats.country_distribution}
            columns={countryColumns}
            rowKey="country"
            size="small"
            pagination={false}
          />
        )}
      </Modal>
    </Card>
  )
}

export default AuthorPanelPage
