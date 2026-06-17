import React, { useState, useEffect, useCallback } from 'react'
import {
  Typography, Table, Card, Row, Col, Statistic, Tag, Button, Modal, message, Popconfirm, Space
} from 'antd'
import {
  EyeOutlined, GlobalOutlined, ApiOutlined, TeamOutlined,
  LoginOutlined, EnvironmentOutlined, DeleteOutlined, ReloadOutlined
} from '@ant-design/icons'
import apiClient from '../api/client'

interface Deployment {
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
  const [loading, setLoading] = useState(false)
  const [deployments, setDeployments] = useState<Deployment[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [stats, setStats] = useState<Stats | null>(null)
  const [mapModalOpen, setMapModalOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

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

  const handleDelete = async (nodeId: string) => {
    setDeleting(nodeId)
    try {
      await apiClient.delete(`/api/config-sync/nodes/${nodeId}`)
      message.success('已删除')
      loadData(page, pageSize)
    } catch (err) {
      message.error('删除失败')
    } finally {
      setDeleting(null)
    }
  }

  const handleTableChange = (pagination: any) => {
    setPage(pagination.current)
    setPageSize(pagination.pageSize)
  }

  const columns = [
    { title: '节点ID', dataIndex: 'node_id', key: 'node_id', width: 100, ellipsis: true },
    { title: '主机名', dataIndex: 'hostname', key: 'hostname', width: 100 },
    { title: '出口IP', dataIndex: 'public_ip', key: 'public_ip', width: 120 },
    { title: '请求IP', dataIndex: 'caller_ip', key: 'caller_ip', width: 120 },
    {
      title: '地理位置', key: 'location', width: 180,
      render: (_: any, r: Deployment) => (
        <span><EnvironmentOutlined style={{ marginRight: 4 }} />{r.country} {r.region} {r.city}</span>
      ),
    },
    { title: '运营商', dataIndex: 'isp', key: 'isp', width: 80 },
    { title: '版本', dataIndex: 'app_version', key: 'app_version', width: 70 },
    { title: '平台', dataIndex: 'platform', key: 'platform', width: 100, ellipsis: true },
    { title: '上报时间', dataIndex: 'first_sync', key: 'first_sync', width: 160 },
    {
      title: '操作', key: 'action', width: 70, fixed: 'right' as const,
      render: (_: any, r: Deployment) => (
        <Popconfirm
          title="确定删除此记录？"
          onConfirm={() => handleDelete(r.node_id)}
          okText="确定"
          cancelText="取消"
        >
          <Button
            type="link"
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={deleting === r.node_id}
          />
        </Popconfirm>
      ),
    },
  ]

  const countryColumns = [
    { title: '国家/地区', dataIndex: 'country', key: 'country' },
    { title: '部署数', dataIndex: 'count', key: 'count' },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Typography.Title level={3} style={{ marginBottom: 8 }}>
        <ApiOutlined /> 控制台
      </Typography.Title>
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
        系统运行概览
      </Typography.Text>

      {/* 统计卡片 */}
      {stats && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6}>
            <Card size="small" hoverable>
              <Statistic title="总节点数" value={stats.total_nodes} prefix={<GlobalOutlined />} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" hoverable>
              <Statistic title="今日活跃" value={stats.today_active} prefix={<LoginOutlined />} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" hoverable>
              <Statistic title="本周活跃" value={stats.weekly_active} prefix={<TeamOutlined />} />
            </Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card size="small" hoverable onClick={() => setMapModalOpen(true)} style={{ cursor: 'pointer' }}>
              <Statistic title="国家/地区" value={stats.country_distribution.length} prefix={<EnvironmentOutlined />} suffix="个" />
            </Card>
          </Col>
        </Row>
      )}

      {/* 节点列表 */}
      <Card
        title={
          <Space>
            <EyeOutlined />
            <span>节点列表</span>
            <Tag color="blue">共 {total} 条</Tag>
          </Space>
        }
        extra={
          <Button size="small" icon={<ReloadOutlined />} onClick={() => loadData(page, pageSize)}>
            刷新
          </Button>
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
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          onChange={handleTableChange}
          scroll={{ x: 1450 }}
          loading={loading}
        />
      </Card>

      {/* 国家分布弹窗 */}
      <Modal
        title="🌍 国家/地区分布"
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
    </div>
  )
}

export default AuthorPanelPage
