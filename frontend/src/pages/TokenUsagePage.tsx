import React, { useState, useEffect, useCallback } from 'react'
import { Card, Table, Statistic, Row, Col, Spin, Tag, Space, Typography, Select } from 'antd'
import { BarChartOutlined, RobotOutlined, ThunderboltOutlined, FileTextOutlined } from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

const SOURCE_LABELS: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  chat: { label: 'AI 对话', color: '#1677ff', icon: <RobotOutlined /> },
  summary: { label: '文件摘要', color: '#52c41a', icon: <FileTextOutlined /> },
  analytics: { label: '学情分析', color: '#722ed1', icon: <BarChartOutlined /> },
  quiz: { label: '试题生成', color: '#ff4d4f', icon: <ThunderboltOutlined /> },
}

const MODEL_COLORS: Record<string, string> = {
  'qwen-long': '#1677ff',
  'qwen3-vl-flash': '#52c41a',
  'deepseek-v4-flash': '#ff4d4f',
}

const RANGE_OPTIONS = [
  { label: '今日', value: 'today' },
  { label: '昨日', value: 'yesterday' },
  { label: '本周', value: 'week' },
  { label: '本月', value: 'month' },
]

const TokenUsagePage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const [rangeType, setRangeType] = useState('today')
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<{
    by_model: { model: string; input_tokens: number; output_tokens: number; total_tokens: number; requests: number }[]
    by_source: { source: string; total_tokens: number; requests: number }[]
    grand_total: number
    total_input: number
    total_output: number
    total_requests: number
  } | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const { data: res } = await apiClient.get('/api/dashboard/token-usage', {
        params: { range_type: rangeType },
      })
      setData(res)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [rangeType])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const isStudent = user?.role === 'student'

  const modelColumns = [
    { title: '模型', dataIndex: 'model', key: 'model',
      render: (m: string) => <Tag color={MODEL_COLORS[m] || '#666'}>{m}</Tag> },
    { title: '输入 Tokens', dataIndex: 'input_tokens', key: 'input' },
    { title: '输出 Tokens', dataIndex: 'output_tokens', key: 'output' },
    { title: '合计', dataIndex: 'total_tokens', key: 'total',
      render: (v: number) => <Text strong>{v.toLocaleString()}</Text> },
    { title: '请求次数', dataIndex: 'requests', key: 'requests' },
  ]

  const sourceColumns = [
    { title: '来源', dataIndex: 'source', key: 'source',
      render: (s: string) => {
        const info = SOURCE_LABELS[s] || { label: s, color: '#666', icon: null }
        return <Tag color={info.color} icon={info.icon}>{info.label}</Tag>
      }},
    { title: '消耗 Tokens', dataIndex: 'total_tokens', key: 'total',
      render: (v: number) => <Text strong>{v.toLocaleString()}</Text> },
    { title: '请求次数', dataIndex: 'requests', key: 'requests' },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Title level={4} style={{ margin: 0 }}>
          <BarChartOutlined style={{ marginRight: 8 }} />AI 用量统计
        </Title>
        <Select options={RANGE_OPTIONS} value={rangeType} onChange={setRangeType} style={{ width: 120 }} />
      </Space>

      <Spin spinning={loading}>
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} sm={6}>
            <Card><Statistic title="总消耗" value={data?.grand_total || 0} suffix="tokens" /></Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card><Statistic title="输入" value={data?.total_input || 0} suffix="tokens" valueStyle={{ color: '#1677ff' }} /></Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card><Statistic title="输出" value={data?.total_output || 0} suffix="tokens" valueStyle={{ color: '#52c41a' }} /></Card>
          </Col>
          <Col xs={12} sm={6}>
            <Card><Statistic title="请求次数" value={data?.total_requests || 0} suffix="次" /></Card>
          </Col>
        </Row>

        <Card title="按模型分组" style={{ marginBottom: 16 }}>
          <Table
            dataSource={data?.by_model || []}
            columns={modelColumns}
            rowKey="model"
            pagination={false}
            size="small"
          />
        </Card>

        {!isStudent && (
          <Card title="按来源分组">
            <Table
              dataSource={data?.by_source || []}
              columns={sourceColumns}
              rowKey="source"
              pagination={false}
              size="small"
            />
          </Card>
        )}
      </Spin>
    </div>
  )
}

export default TokenUsagePage
