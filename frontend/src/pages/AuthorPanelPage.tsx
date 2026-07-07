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
}

interface Stats {
  total_nodes: number
  today_active: number
  weekly_active: number
  country_distribution: { country: string; count: number }[]
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

  const columns = [
    { title: t('nodeId'), dataIndex: 'node_id', key: 'node_id', width: 100, ellipsis: true },
    { title: t('hostname'), dataIndex: 'hostname', key: 'hostname', width: 100 },
    { title: t('publicIp'), dataIndex: 'public_ip', key: 'public_ip', width: 120 },
    { title: t('callerIp'), dataIndex: 'caller_ip', key: 'caller_ip', width: 120 },
    {
      title: t('location'), key: 'location', width: 180,
      render: (_: any, r: Deployment) => (
        <span><EnvironmentOutlined style={{ marginRight: 4 }} />{r.country} {r.region} {r.city}</span>
      ),
    },
    { title: t('isp'), dataIndex: 'isp', key: 'isp', width: 80 },
    { title: t('version'), dataIndex: 'app_version', key: 'app_version', width: 70 },
    { title: t('platform'), dataIndex: 'platform', key: 'platform', width: 100, ellipsis: true },
    { title: t('syncTime'), dataIndex: 'first_sync', key: 'first_sync', width: 160 },
    {
      title: t('actions'), key: 'action', width: 70, fixed: 'right' as const,
      render: (_: any, r: Deployment) => (
        <Popconfirm
          title={t('confirmDeleteRecord')}
          onConfirm={() => handleDelete(r.id)}
          okText={t('confirmOk')}
          cancelText={t('cancel')}
        >
          <Button
            type="link"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deleting === r.id}
          />
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
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        {t('systemOverview')}
      </Typography.Text>

      {/* 统计卡片 */}
      {stats && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6}>
            <Card size="small" hoverable>
              <Statistic title={t('totalNodes')} value={stats.total_nodes} prefix={<GlobalOutlined />} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" hoverable>
              <Statistic title={t('todayActive')} value={stats.today_active} prefix={<LoginOutlined />} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" hoverable>
              <Statistic title={t('weeklyActive')} value={stats.weekly_active} prefix={<TeamOutlined />} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" hoverable onClick={() => setMapModalOpen(true)} style={{ cursor: 'pointer' }}>
              <Statistic title={t('countryRegion')} value={stats.country_distribution.length} prefix={<EnvironmentOutlined />} suffix={t('unitCount')} />
            </Card>
          </Col>
        </Row>
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
          rowKey="node_id"
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
          scroll={{ x: 1450 }}
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
