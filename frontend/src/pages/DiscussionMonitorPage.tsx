import React, { useState, useEffect, useRef } from 'react'
import {
  Card, Button, Space, Typography, Tag, message, Spin,
  Row, Col, Statistic, Progress, Modal, Rate,
} from 'antd'
import {
  TeamOutlined, MessageOutlined, FieldTimeOutlined,
  ArrowLeftOutlined, WarningOutlined, BulbOutlined,
  ThunderboltOutlined, DownloadOutlined,
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

  // AI 总结相关
  const [summaryModal, setSummaryModal] = useState(false)
  const [summaryData, setSummaryData] = useState<any>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [generatingSummary, setGeneratingSummary] = useState(false)
  const [activeGroupId, setActiveGroupId] = useState<number | null>(null)

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

  // AI 生成小组总结
  const handleGenerateSummary = async (groupId: number) => {
    setActiveGroupId(groupId)
    setGeneratingSummary(true)
    setSummaryModal(true)
    setSummaryData(null)
    try {
      const { data } = await apiClient.post(`/api/interaction/groups/${groupId}/ai-summary`)
      if (data.status === 'ok') {
        message.success('AI 总结生成成功')
        setSummaryData(data)
      } else {
        message.error(data.content || 'AI 总结生成失败')
        setSummaryData(null)
      }
    } catch (err: any) {
      message.error('AI 总结失败: ' + (err?.response?.data?.detail || err?.message))
      setSummaryData(null)
    } finally {
      setGeneratingSummary(false)
    }
  }

  // 查看已有总结
  const handleViewSummary = async (groupId: number) => {
    setActiveGroupId(groupId)
    setSummaryLoading(true)
    setSummaryModal(true)
    setSummaryData(null)
    try {
      const { data } = await apiClient.get(`/api/interaction/groups/${groupId}/summary`)
      if (data.has_summary) {
        setSummaryData(data)
      } else {
        // 没有总结，自动生成
        setSummaryLoading(false)
        await handleGenerateSummary(groupId)
        return
      }
    } catch {
      setSummaryData(null)
    } finally {
      setSummaryLoading(false)
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
                  <Space size="small">
                    {data.status === 'active' && (
                      <Button
                        size="small"
                        onClick={() => navigate(`/discussion-room/${g.id}?discussion_id=${discId}`)}
                      >
                        进入
                      </Button>
                    )}
                    <Button
                      size="small"
                      icon={<BulbOutlined />}
                      onClick={() => handleViewSummary(g.id)}
                    >
                      AI 总结
                    </Button>
                  </Space>
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

      {/* AI 总结弹窗 */}
      <Modal
        title={
          <Space>
            <BulbOutlined style={{ color: '#faad14' }} />
            <span>AI 讨论归纳总结 - {data?.groups.find(g => g.id === activeGroupId)?.name || ''}</span>
          </Space>
        }
        open={summaryModal}
        onCancel={() => setSummaryModal(false)}
        footer={[
          <Button key="close" onClick={() => setSummaryModal(false)}>关闭</Button>,
          <Button key="export" icon={<DownloadOutlined />}
            disabled={!summaryData?.content}
            onClick={() => {
              const token = localStorage.getItem('smartkb_token')
              window.open(`/api/interaction/groups/${activeGroupId}/summary/export?token=${token}`, '_blank')
            }}>
            导出 Word
          </Button>,
          activeGroupId && (
            <Button key="regenerate" type="primary" icon={<ThunderboltOutlined />}
              loading={generatingSummary}
              onClick={() => handleGenerateSummary(activeGroupId)}>
              重新生成
            </Button>
          ),
        ]}
        width={700}
      >
        <Spin spinning={summaryLoading || generatingSummary}>
          {summaryData?.content?.parsed ? (
            <div style={{ padding: '8px 0' }}>
              <div style={{ marginBottom: 20 }}>
                <Text strong style={{ fontSize: 16, color: '#1677ff' }}>📝 总体归纳</Text>
                <div style={{
                  marginTop: 8, padding: 12, background: '#f6ffed',
                  borderRadius: 8, border: '1px solid #b7eb8f', lineHeight: 1.8,
                  fontSize: 14, color: '#333',
                }}>
                  {summaryData.content.parsed.summary || '（暂无内容）'}
                </div>
              </div>

              {summaryData.content.parsed.key_points?.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <Text strong style={{ fontSize: 16, color: '#1677ff' }}>💡 关键观点</Text>
                  <div style={{ marginTop: 8 }}>
                    {summaryData.content.parsed.key_points.map((point: string, i: number) => (
                      <div key={i} style={{
                        padding: '8px 12px', marginBottom: 6,
                        background: '#fff7e6', borderRadius: 6,
                        border: '1px solid #ffd591', fontSize: 14,
                      }}>
                        <Text strong style={{ color: '#fa8c16' }}>观点{i + 1}：</Text>
                        {point}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {summaryData.content.parsed.ai_comment && (
                <div style={{ marginBottom: 20 }}>
                  <Text strong style={{ fontSize: 16, color: '#1677ff' }}>🤖 AI 评价与建议</Text>
                  <div style={{
                    marginTop: 8, padding: 12, background: '#e6f7ff',
                    borderRadius: 8, border: '1px solid #91d5ff',
                    fontSize: 14, lineHeight: 1.8,
                  }}>
                    {summaryData.content.parsed.ai_comment}
                  </div>
                </div>
              )}

              {summaryData.content.parsed.score && (
                <div style={{ marginBottom: 12 }}>
                  <Text strong style={{ fontSize: 16, color: '#1677ff' }}>⭐ 综合评分</Text>
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12 }}>
                    <Rate
                      disabled
                      value={Math.round(parseInt(summaryData.content.parsed.score) / 2)}
                      count={5}
                      style={{ fontSize: 20 }}
                    />
                    <Text style={{ fontSize: 20, fontWeight: 'bold', color: '#fa8c16' }}>
                      {summaryData.content.parsed.score}/10
                    </Text>
                  </div>
                </div>
              )}

              <details style={{ marginTop: 16 }}>
                <summary style={{ cursor: 'pointer', color: '#888', fontSize: 13 }}>
                  查看原始 AI 回复
                </summary>
                <pre style={{
                  marginTop: 8, padding: 12, background: '#f5f5f5',
                  borderRadius: 6, fontSize: 12, color: '#666',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: 300, overflow: 'auto',
                }}>
                  {summaryData.content.raw_content || summaryData.content}
                </pre>
              </details>
            </div>
          ) : summaryData?.content?.raw_content ? (
            <div style={{ padding: '8px 0' }}>
              <div style={{
                padding: 16, background: '#f6ffed',
                borderRadius: 8, border: '1px solid #b7eb8f',
                lineHeight: 1.8, fontSize: 14,
                whiteSpace: 'pre-wrap',
              }}>
                {summaryData.content.raw_content}
              </div>
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Text type="secondary">正在生成总结...</Text>
            </div>
          )}
        </Spin>
      </Modal>
    </div>
  )
}

export default DiscussionMonitorPage
