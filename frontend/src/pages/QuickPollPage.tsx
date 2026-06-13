/**
 * QuickPollPage — 快速投票（独立页）
 * 从 InteractionPage 提取，独立的投票功能页面
 */
import React, { useState, useEffect } from 'react'
import FormulaRenderer from '../components/FormulaRenderer'
import {
  Card, Button, Space, Typography, List, Tag, Modal,
  Form, Input, Select, message, Empty, Spin, Radio, Popconfirm,
  Checkbox, Progress, Divider, Pagination,
} from 'antd'
import {
  BarChartOutlined, PlusOutlined, CheckCircleOutlined,
  RobotOutlined, EditOutlined, DeleteOutlined, DownloadOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography
const { TextArea } = Input

const QuickPollPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  // ── 投票 ──
  const [polls, setPolls] = useState<any[]>([])
  const [pollLoading, setPollLoading] = useState(false)
  const [pollModal, setPollModal] = useState(false)
  const [votedPolls, setVotedPolls] = useState<Record<number, boolean>>({})
  const [selectedOption, setSelectedOption] = useState<Record<number, number | null>>({})
  const [selectedOptions, setSelectedOptions] = useState<Record<number, number[]>>({})
  const [pollForm] = Form.useForm()
  const [takingPoll, setTakingPoll] = useState<any>(null)
  const [pollResult, setPollResult] = useState<any>(null)
  const [aiPollModal, setAiPollModal] = useState(false)
  const [aiPollLoading, setAiPollLoading] = useState(false)
  const [aiPollResult, setAiPollResult] = useState<any>(null)
  const [aiPollForm] = Form.useForm()
  const [editPollModal, setEditPollModal] = useState<any>(null)
  const [editPollForm] = Form.useForm()

  // 列表分页
  const [pollPage, setPollPage] = useState(1)
  const [pollPageSize, setPollPageSize] = useState(10)

  // 加载投票列表
  const loadPolls = async () => {
    setPollLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/polls')
      const polls = data.polls || []
      setPolls(polls)
      const votedMap: Record<number, boolean> = {}
      for (const p of polls) {
        votedMap[p.id] = p.voted === true
      }
      setVotedPolls(votedMap)
    } catch { /* ignore */ }
    setPollLoading(false)
  }

  useEffect(() => {
    loadPolls()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── AI 生成投票 ──
  const handleAiGeneratePoll = async (values: any) => {
    setAiPollLoading(true)
    setAiPollResult(null)
    try {
      const { data } = await apiClient.post('/api/interaction/polls/ai-generate', values)
      setAiPollResult(data)
      if (data.poll) {
        message.success('AI 生成了投票')
      } else if (data.error) {
        message.warning(data.error)
      }
    } catch { message.error('AI 生成失败') }
    setAiPollLoading(false)
  }

  const handleApplyAiPoll = () => {
    if (aiPollResult?.poll) {
      pollForm.setFieldsValue({
        question: aiPollResult.poll.question,
        options: aiPollResult.poll.options.join('\n'),
        poll_type: aiPollForm.getFieldValue('poll_type') || 'single',
      })
      message.success('已填入表单，可手动修改')
      setAiPollModal(false)
    }
  }

  // ── 创建投票 ──
  const handleCreatePoll = async (values: any) => {
    const options = values.options.split('\n').filter((l: string) => l.trim())
    if (options.length < 2) { message.warning('至少需要2个选项'); return }
    try {
      await apiClient.post('/api/interaction/polls', {
        question: values.question,
        options,
        poll_type: values.poll_type || 'single',
      })
      message.success('投票创建成功')
      setPollModal(false)
      pollForm.resetFields()
      await loadPolls()
    } catch (err: any) {
      message.error(err.response?.data?.detail || '创建失败')
    }
  }

  // ── 投票 ──
  const handleVote = async (pollId: number) => {
    const poll = polls.find(p => p.id === pollId)
    if (!poll) return
    const isMultiple = poll.poll_type === 'multiple'

    if (isMultiple) {
      const selOpts = selectedOptions[pollId] || []
      if (selOpts.length === 0) { message.warning('请至少选择一个选项'); return }
      const indicesStr = selOpts.sort().join(',')
      try {
        await apiClient.post(`/api/interaction/polls/${pollId}/vote`, null, {
          params: { option_indices: indicesStr },
        })
        message.success('投票成功')
        setVotedPolls({ ...votedPolls, [pollId]: true })
        await loadPolls()
        setTakingPoll(null)
      } catch (err: any) {
        message.error(err.response?.data?.detail || '投票失败')
      }
    } else {
      const selOpt = selectedOption[pollId]
      if (selOpt === undefined || selOpt === null) { message.warning('请选择一个选项'); return }
      try {
        await apiClient.post(`/api/interaction/polls/${pollId}/vote`, null, {
          params: { option_index: selOpt },
        })
        message.success('投票成功')
        setVotedPolls({ ...votedPolls, [pollId]: true })
        await loadPolls()
        setTakingPoll(null)
      } catch (err: any) {
        message.error(err.response?.data?.detail || '投票失败')
      }
    }
  }

  const handleViewPollResults = async (pollId: number) => {
    try {
      const { data } = await apiClient.get(`/api/interaction/polls/${pollId}/results`)
      setPollResult(data)
    } catch { message.error('加载结果失败') }
  }

  const handleStartPoll = (poll: any) => {
    setSelectedOption({})
    setSelectedOptions({})
    setTakingPoll(poll)
    setPollResult(null)
  }

  // ── 编辑/删除 ──
  const handleDeletePoll = async (id: number) => {
    try { await apiClient.delete(`/api/interaction/polls/${id}`); message.success('已删除'); await loadPolls() }
    catch { message.error('删除失败') }
  }

  const handleEditPoll = async () => {
    const values = await editPollForm.validateFields()
    try {
      await apiClient.put(`/api/interaction/polls/${editPollModal.id}`, {
        question: values.question,
        options: values.options.split('\n').filter((l: string) => l.trim()),
        poll_type: values.poll_type || 'single',
      })
      message.success('已更新'); setEditPollModal(null); await loadPolls()
    } catch { message.error('更新失败') }
  }

  return (
    <div>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <BarChartOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>快速投票</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              即时反馈 · 课堂表决
            </Text>
          </Space>
        </div>
      </Card>

      <Card>
        {isTeacherOrAdmin && (
          <Space style={{ marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setPollModal(true)}>
              创建投票
            </Button>
            <Button icon={<RobotOutlined />} onClick={() => setAiPollModal(true)}>
              AI 生成
            </Button>
          </Space>
        )}
        <Spin spinning={pollLoading}>
          {polls.length === 0 ? <Empty description="暂无活跃投票" /> : (
            <>
            <List
              dataSource={polls.slice((pollPage - 1) * pollPageSize, pollPage * pollPageSize)}
              renderItem={(poll: any) => {
                const isMultiple = poll.poll_type === 'multiple'
                const hasVoted = poll.voted ?? votedPolls[poll.id]
                return (
                  <Card size="small" style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1 }}>
                        <Text strong><FormulaRenderer content={poll.question} /></Text>
                        <div style={{ marginTop: 4 }}>
                          <Tag color={isMultiple ? 'purple' : 'blue'}>
                            {isMultiple ? '多选' : '单选'}
                          </Tag>
                          <Tag color="blue">{poll.creator_name || poll.creator_username}</Tag>
                          <Text type="secondary" style={{ fontSize: 12 }}>{poll.unique_voters || poll.total_votes} 人参与</Text>
                        </div>
                      </div>
                      <Space>
                        {isStudent && !hasVoted && (
                          <Button size="small" type="primary" icon={<CheckCircleOutlined />}
                            onClick={() => handleStartPoll(poll)}>开始投票</Button>
                        )}
                        {isStudent && hasVoted && (
                          <Button size="small" icon={<BarChartOutlined />}
                            onClick={() => handleViewPollResults(poll.id)}>已投票</Button>
                        )}
                        {isTeacherOrAdmin && (
                          <>
                            <Button size="small" icon={<BarChartOutlined />}
                              onClick={() => handleViewPollResults(poll.id)}>查看结果</Button>
                            <Button size="small" icon={<DownloadOutlined />}
                              onClick={() => {
                                const token = localStorage.getItem('smartkb_token')
                                window.open(`/api/export/poll/${poll.id}?token=${token}`, '_blank')
                              }}>导出</Button>
                            <Button size="small" type="text" icon={<EditOutlined />}
                              onClick={() => {
                                editPollForm.setFieldsValue({
                                  question: poll.question,
                                  options: poll.options.map((o: any) => o.text).join('\n'),
                                  poll_type: poll.poll_type,
                                })
                                setEditPollModal(poll)
                              }} />
                            <Popconfirm title="删除此投票？" onConfirm={() => handleDeletePoll(poll.id)}>
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          </>
                        )}
                      </Space>
                    </div>
                  </Card>
                )
              }}
            />
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Pagination
                current={pollPage} pageSize={pollPageSize} total={polls.length}
                showSizeChanger showTotal={(t) => `共 ${t} 个投票`}
                pageSizeOptions={['5', '10', '20', '50']}
                onChange={(p, ps) => { setPollPage(p); setPollPageSize(ps) }}
                size="small"
              />
            </div>
            </>
          )}
        </Spin>
      </Card>

      {/* ── 投票弹窗 ── */}
      <Modal title={takingPoll?.question} open={!!takingPoll && !pollResult}
        onCancel={() => { setTakingPoll(null); setPollResult(null) }}
        footer={[
          <Button key="submit" type="primary" onClick={() => handleVote(takingPoll?.id)}>提交投票</Button>,
        ]}
        width={500}>
        {takingPoll?.options?.map((opt: any, i: number) => (
          <div key={i} style={{ marginBottom: 8, padding: '8px 12px', background: '#fafafa', borderRadius: 4, border: '1px solid #f0f0f0' }}>
            {takingPoll.poll_type === 'multiple' ? (
              <Checkbox
                checked={(selectedOptions[takingPoll.id] || []).includes(i)}
                onChange={(e) => {
                  const current = selectedOptions[takingPoll.id] || []
                  const updated = e.target.checked
                    ? [...current, i]
                    : current.filter((v: number) => v !== i)
                  setSelectedOptions({ ...selectedOptions, [takingPoll.id]: updated })
                }}
              >
                {opt.text}
              </Checkbox>
            ) : (
              <Radio
                checked={selectedOption[takingPoll.id] === i}
                onChange={() => setSelectedOption({ ...selectedOption, [takingPoll.id]: i })}
              >
                {opt.text}
              </Radio>
            )}
          </div>
        ))}
      </Modal>

      {/* ── 投票结果弹窗（投票后或教师查看） ── */}
      <Modal title={pollResult?.question || '投票结果'} open={!!pollResult}
        onCancel={() => setPollResult(null)}
        footer={<Button onClick={() => setPollResult(null)}>关闭</Button>}
        width={500}>
        {pollResult && (
          <>
            <Space style={{ marginBottom: 12 }}>
              <Tag color={pollResult.poll_type === 'multiple' ? 'purple' : 'blue'}>
                {pollResult.poll_type === 'multiple' ? '多选' : '单选'}
              </Tag>
            </Space>
            {pollResult.options?.map((opt: any, i: number) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text>{opt.text}</Text>
                  <Text type="secondary">{opt.votes} 票 ({opt.percentage || 0}%)</Text>
                </div>
                <Progress percent={opt.percentage || 0} size="small" />
              </div>
            ))}
            <Divider />
            <Text type="secondary">共 {pollResult.unique_voters || pollResult.total_votes} 人参与</Text>
            {pollResult.poll_type === 'multiple' && pollResult.unique_voters ? (
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                （共 {pollResult.total_votes} 票）
              </Text>
            ) : null}
          </>
        )}
      </Modal>

      {/* ── AI 生成投票弹窗 ── */}
      <Modal title={<Space><RobotOutlined />AI 生成投票</Space>} open={aiPollModal}
        onCancel={() => { setAiPollModal(false); setAiPollResult(null) }}
        footer={aiPollResult?.poll ? [
          <Button key="cancel" onClick={() => { setAiPollModal(false); setAiPollResult(null) }}>取消</Button>,
          <Button key="apply" type="primary" onClick={handleApplyAiPoll}>填入表单</Button>,
        ] : null}>
        <Form form={aiPollForm} layout="vertical" onFinish={handleAiGeneratePoll}>
          <Form.Item name="topic" label="投票主题" rules={[{ required: true }]}>
            <Input placeholder="例如：你更喜欢哪种学习方式？" />
          </Form.Item>
          <Form.Item name="poll_type" label="投票类型" initialValue="single">
            <Select>
              <Select.Option value="single">单选投票</Select.Option>
              <Select.Option value="multiple">多选投票</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="option_count" label="选项数量" initialValue={4}>
            <Select>
              {[2, 3, 4, 5, 6].map(n => <Select.Option key={n} value={n}>{n} 个</Select.Option>)}
            </Select>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={aiPollLoading} icon={<RobotOutlined />} block>
            AI 生成
          </Button>
        </Form>
        {aiPollResult?.poll && (
          <div style={{ marginTop: 12 }}>
            <Text strong>投票问题：</Text>
            <Text>{aiPollResult.poll.question}</Text>
            <div style={{ marginTop: 8 }}>
              {aiPollResult.poll.options.map((opt: string, i: number) => (
                <div key={i} style={{ padding: '2px 0' }}>• {opt}</div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {/* ── 创建投票弹窗 ── */}
      <Modal title="创建快速投票" open={pollModal} onCancel={() => setPollModal(false)}
        footer={null}>
        <Form form={pollForm} layout="vertical" onFinish={handleCreatePoll}>
          <Form.Item name="question" label="投票问题" rules={[{ required: true }]}>
            <Input placeholder="例如：你更喜欢哪种编程语言？" />
          </Form.Item>
          <Form.Item name="poll_type" label="投票类型" initialValue="single">
            <Select>
              <Select.Option value="single">单选投票</Select.Option>
              <Select.Option value="multiple">多选投票</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="options" label="选项（每行一个）" rules={[{ required: true }]}>
            <TextArea rows={4} placeholder="每行一个选项&#10;例如：&#10;Python&#10;JavaScript&#10;C++" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>创建投票</Button>
        </Form>
      </Modal>

      {/* ── 编辑投票弹窗 ── */}
      <Modal title="编辑投票" open={!!editPollModal} onCancel={() => setEditPollModal(null)}
        onOk={handleEditPoll} okText="保存">
        <Form form={editPollForm} layout="vertical">
          <Form.Item name="question" label="问题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="poll_type" label="投票类型">
            <Select>
              <Select.Option value="single">单选投票</Select.Option>
              <Select.Option value="multiple">多选投票</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="options" label="选项（每行一个）" rules={[{ required: true }]}>
            <TextArea rows={4} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default QuickPollPage
