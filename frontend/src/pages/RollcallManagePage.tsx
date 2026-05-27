import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Button, message, Space, Typography, Modal, Tag,
  Spin, Empty, Descriptions, Divider, Tooltip, Statistic, Row, Col,
} from 'antd'
import {
  ReloadOutlined, DeleteOutlined, HistoryOutlined,
  TeamOutlined, BarChartOutlined, EyeOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'

const { Text, Title } = Typography

interface Session {
  teacher: string
  grade: string
  class: string
  student_count: number
  history_count: number
}

interface SessionDetail {
  teacher: string
  grade: string
  class: string
  weights: Record<string, number>
  history: { student: string; time: string; result: string; points: number }[]
  picked_in_round: string[]
  last_time: number | null
  updated: string
  student_count: number
  history_count: number
}

const RollcallManagePage: React.FC = () => {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [detailVisible, setDetailVisible] = useState(false)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/api/rollcall/admin/sessions')
      setSessions(data.sessions || [])
    } catch {
      message.error('加载点名会话列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    apiClient.get('/api/rollcall/admin/sessions')
      .then(({ data }) => setSessions(data.sessions || []))
      .catch(() => message.error('加载点名会话列表失败'))
      .finally(() => setLoading(false))
  }, [])

  const viewDetail = async (s: Session) => {
    setDetailLoading(true)
    setDetailVisible(true)
    try {
      const { data } = await apiClient.get('/api/rollcall/admin/detail', {
        params: { teacher: s.teacher, grade: s.grade, class: s.class },
      })
      setDetail(data)
    } catch {
      message.error('加载详情失败')
      setDetailVisible(false)
    } finally {
      setDetailLoading(false)
    }
  }

  const handleReset = async (s: Session) => {
    try {
      await apiClient.post('/api/rollcall/admin/reset', {
        teacher: s.teacher, grade: s.grade, class: s.class,
      })
      message.success(`已重置 ${s.grade}·${s.class}`)
      loadSessions()
      if (detailVisible) setDetailVisible(false)
    } catch {
      message.error('重置失败')
    }
  }

  const columns = [
    {
      title: '教师',
      dataIndex: 'teacher',
      key: 'teacher',
      render: (t: string) => <Tag color={t === 'root' ? 'blue' : 'default'}>{t}</Tag>,
    },
    { title: '年级', dataIndex: 'grade', key: 'grade' },
    { title: '班级', dataIndex: 'class', key: 'class' },
    {
      title: '学生数', dataIndex: 'student_count', key: 'student_count',
      sorter: (a: Session, b: Session) => a.student_count - b.student_count,
    },
    {
      title: '抽取次数', dataIndex: 'history_count', key: 'history_count',
      sorter: (a: Session, b: Session) => a.history_count - b.history_count,
    },
    {
      title: '操作', key: 'actions',
      render: (_: unknown, record: Session) => (
        <Space>
          <Tooltip title="查看详情">
            <Button icon={<EyeOutlined />} size="small" onClick={() => viewDetail(record)} />
          </Tooltip>
          <Tooltip title="重置数据">
            <Button icon={<DeleteOutlined />} size="small" danger
              onClick={() => {
                Modal.confirm({
                  title: '确认重置',
                  content: `确定要重置 ${record.grade}·${record.class} 的全部点名数据吗？`,
                  onOk: () => handleReset(record),
                })
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  const resultColor = (r: string) => {
    switch (r) {
      case 'correct': return 'green'
      case 'incorrect': return 'red'
      case 'skip': return 'orange'
      default: return 'default'
    }
  }

  const resultLabel = (r: string) => {
    switch (r) {
      case 'correct': return '正确'
      case 'incorrect': return '错误'
      case 'skip': return '跳过'
      default: return r
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space>
            <HistoryOutlined style={{ fontSize: 24, color: '#1677ff' }} />
            <Title level={4} style={{ margin: 0 }}>点名数据管理</Title>
          </Space>
          <Button icon={<ReloadOutlined />} onClick={loadSessions} loading={loading}>
            刷新
          </Button>
        </div>

        {sessions.length === 0 && !loading ? (
          <Empty description="暂无点名数据" />
        ) : (
          <Table
            dataSource={sessions}
            columns={columns}
            rowKey={(r) => `${r.teacher}|${r.grade}|${r.class}`}
            loading={loading}
            pagination={false}
            size="middle"
          />
        )}

        <Divider />
        <Row gutter={16}>
          <Col span={8}>
            <Statistic title="总会话数" value={sessions.length} prefix={<TeamOutlined />} />
          </Col>
          <Col span={8}>
            <Statistic
              title="总学生数"
              value={sessions.reduce((s, x) => s + x.student_count, 0)}
              prefix={<TeamOutlined />}
            />
          </Col>
          <Col span={8}>
            <Statistic
              title="总抽取次数"
              value={sessions.reduce((s, x) => s + x.history_count, 0)}
              prefix={<BarChartOutlined />}
            />
          </Col>
        </Row>
      </Card>

      {/* ── 详情弹窗 ── */}
      <Modal
        title={
          detail
            ? `点名详情 · ${detail.teacher} · ${detail.grade} ${detail.class}`
            : '加载中...'
        }
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailVisible(false)}>关闭</Button>,
          detail && (
            <Button key="reset" danger onClick={() => {
              Modal.confirm({
                title: '确认重置',
                content: `确定要重置 ${detail.grade}·${detail.class} 的全部数据？`,
                onOk: () => handleReset(detail),
              })
            }}>
              重置本班数据
            </Button>
          ),
        ]}
        width={800}
      >
        {detailLoading ? <Spin style={{ display: 'block', padding: 60 }} /> : detail ? (
          <div>
            <Descriptions column={3} size="small" bordered>
              <Descriptions.Item label="教师"><Tag>{detail.teacher}</Tag></Descriptions.Item>
              <Descriptions.Item label="年级">{detail.grade}</Descriptions.Item>
              <Descriptions.Item label="班级">{detail.class}</Descriptions.Item>
              <Descriptions.Item label="学生数">{detail.student_count}</Descriptions.Item>
              <Descriptions.Item label="抽取次数">{detail.history_count}</Descriptions.Item>
              <Descriptions.Item label="本轮已抽">{detail.picked_in_round.length} 人</Descriptions.Item>
              <Descriptions.Item label="最后更新">{detail.updated}</Descriptions.Item>
            </Descriptions>

            <Divider>⚖️ 权重分布</Divider>
            {Object.keys(detail.weights).length === 0 ? (
              <Text type="secondary">暂无权重数据</Text>
            ) : (
              <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      <th style={thStyle}>学生</th>
                      <th style={thStyle}>权重</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(detail.weights)
                      .sort(([, a], [, b]) => b - a)
                      .map(([name, w]) => (
                        <tr key={name}>
                          <td style={tdStyle}>{name}</td>
                          <td style={tdStyle}>
                            <Tag color={w >= 8 ? 'green' : w >= 5 ? 'orange' : 'red'}>{w}</Tag>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            <Divider>📜 抽取历史 ({detail.history.length} 条)</Divider>
            {detail.history.length === 0 ? (
              <Text type="secondary">暂无历史记录</Text>
            ) : (
              <div style={{ maxHeight: 300, overflow: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      <th style={thStyle}>时间</th>
                      <th style={thStyle}>学生</th>
                      <th style={thStyle}>结果</th>
                      <th style={thStyle}>积分</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...detail.history].reverse().map((h, i) => (
                      <tr key={i}>
                        <td style={tdStyle}>{h.time}</td>
                        <td style={tdStyle}>{h.student}</td>
                        <td style={tdStyle}>
                          <Tag color={resultColor(h.result)}>{resultLabel(h.result)}</Tag>
                        </td>
                        <td style={tdStyle}>{h.points > 0 ? `+${h.points}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

const thStyle: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #f0f0f0',
  fontWeight: 600, fontSize: 13,
}
const tdStyle: React.CSSProperties = {
  padding: '6px 12px', borderBottom: '1px solid #f0f0f0', fontSize: 13,
}

export default RollcallManagePage
