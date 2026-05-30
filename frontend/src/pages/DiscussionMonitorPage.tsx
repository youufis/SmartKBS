import React, { useState, useEffect, useRef } from 'react'
import {
  Card, Button, Space, Typography, Tag, message, Spin,
  Row, Col, Statistic, Progress,
} from 'antd'
import {
  TeamOutlined, MessageOutlined, FieldTimeOutlined,
  ArrowLeftOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useParams, useNavigate } from 'react-router-dom'
import apiClient from '../api/client'

const { Title, Text } = Typography

interface GroupStatus {
  id: number
  group_index: number
  name: string
  member_count: number
  message_count: number
  last_active: string
  last_preview: string
  is_cold: boolean
}

interface MonitorData {
  discussion_id: number
  title: string
  status: string
  total_groups: number
  total_members: number
  total_messages: number
  cold_groups: number
  online_count: number
  groups: GroupStatus[]
}

const DiscussionMonitorPage: React.FC = () => {
  const { discId } = useParams<{ discId: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<MonitorData | null>(null)
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadMonitor = async () => {
    if (!discId) return
    try {
      const { data: res } = await apiClient.get(`/api/interaction/discussions/${discId}/monitor`)
      setData(res)
    } catch {
      message.error('加载监控数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMonitor()
    timerRef.current = setInterval(loadMonitor, 5000) // 每 5 秒刷新
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [discId])

  if (loading) return <Spin size="large" style={{ display: 'block', marginTop: 100 }} />

  if (!data) return <div style={{ textAlign: 'center', padding: 60 }}>讨论不存在</div>

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/discussion')} />
          <Title level={4} style={{ margin: 0 }}>📊 讨论监控</Title>
          <Text>— {data.title}</Text>
          <Tag color={data.status === 'active' ? 'green' : 'red'}>
            {data.status === 'active' ? '进行中' : '已结束'}
          </Tag>
        </Space>

        {/* 统计概览 */}
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={4}>
            <Card size="small">
              <Statistic title="小组数" value={data.total_groups} prefix={<TeamOutlined />} />
            </Card>
          </Col>
          <Col span={5}>
            <Card size="small">
              <Statistic title="参与人数" value={data.total_members} prefix={<TeamOutlined />} />
            </Card>
          </Col>
          <Col span={5}>
            <Card size="small">
              <Statistic title="消息总数" value={data.total_messages} prefix={<MessageOutlined />} />
            </Card>
          </Col>
          <Col span={5}>
            <Card size="small">
              <Statistic
                title="在线人数"
                value={data.online_count}
                prefix={<FieldTimeOutlined />}
                valueStyle={{ color: data.online_count > 0 ? '#52c41a' : '#999' }}
              />
            </Card>
          </Col>
          <Col span={5}>
            <Card size="small">
              <Statistic
                title="冷场小组"
                value={data.cold_groups}
                prefix={<WarningOutlined />}
                valueStyle={{ color: data.cold_groups > 0 ? '#ff4d4f' : '#52c41a' }}
                suffix={`/ ${data.total_groups}`}
              />
            </Card>
          </Col>
        </Row>

        {/* 小组状态卡片 */}
        <Title level={5}>各小组状态</Title>
        <Row gutter={[12, 12]}>
          {data.groups.map(g => (
            <Col span={8} key={g.id}>
              <Card
                size="small"
                title={
                  <Space>
                    {g.name}
                    {g.is_cold ? (
                      <Tag color="red" style={{ fontSize: 11 }}>❄️ 冷场</Tag>
                    ) : (
                      <Tag color="green" style={{ fontSize: 11 }}>💬 活跃</Tag>
                    )}
                  </Space>
                }
                extra={
                  data.status === 'active' && (
                    <Button
                      size="small"
                      onClick={() => navigate(`/discussion-room/${g.id}?discussion_id=${discId}`)}
                    >
                      进入
                    </Button>
                  )
                }
              >
                <div style={{ fontSize: 13 }}>
                  <div style={{ marginBottom: 4 }}>
                    <TeamOutlined /> {g.member_count} 人 &nbsp;
                    <MessageOutlined /> {g.message_count} 条
                  </div>
                  {g.last_preview && (
                    <div style={{ color: '#888', marginBottom: 4, fontSize: 12 }}>
                      最后消息: {g.last_preview}
                    </div>
                  )}
                  {g.last_active && (
                    <div style={{ color: '#aaa', fontSize: 11 }}>
                      最后活跃: {g.last_active}
                    </div>
                  )}
                </div>
                <div style={{ marginTop: 8 }}>
                  <Progress
                    percent={Math.min(100, Math.round((g.message_count / Math.max(1, data.total_messages)) * 100))}
                    size="small"
                    showInfo={false}
                    strokeColor={g.is_cold ? '#ff4d4f' : '#52c41a'}
                  />
                </div>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>
    </div>
  )
}

export default DiscussionMonitorPage
