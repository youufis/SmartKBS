import { studentLabel } from '../utils/studentLabel'
import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, Table, Tabs, Button, Space, Typography, Tag, Modal,
  Form, Input, Select, InputNumber, message, Empty, Spin,
  Tooltip, Popconfirm,
} from 'antd'
import {
  TeamOutlined, PlusOutlined, PlayCircleOutlined,
  StopOutlined, MessageOutlined, UserOutlined,
  FieldTimeOutlined, RobotOutlined, BulbOutlined,
  ReloadOutlined, DeleteOutlined, EyeOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const { Title, Text } = Typography
const { TextArea } = Input

const DiscussionPage: React.FC = () => {
  const { t } = useTranslation('discussion')
  const navigate = useNavigate()

  const getAiRoleLabel = React.useCallback((role: string) => {
    const map: Record<string, string> = {
      observer: t('aiRoleObserver'),
      guide: t('aiRoleGuide'),
      proactive: t('aiRoleProactive'),
      judge: t('aiRoleJudge'),
      mixed: t('aiRoleMixed'),
    }
    return map[role] || role
  }, [t])

  const STATUS_MAP: Record<string, { label: string; color: string }> = {
    pending: { label: t('pendingDiscussions'), color: 'default' },
    active: { label: t('activeDiscussions'), color: 'green' },
    ended: { label: t('endedDiscussions'), color: 'red' },
  }
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  const [discussions, setDiscussions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [aiModal, setAiModal] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [detailModal, setDetailModal] = useState<any>(null)
  const [activeTab, setActiveTab] = useState('all')
  const [createForm] = Form.useForm()
  const [aiForm] = Form.useForm()
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])
  const [discussionScope, setDiscussionScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes',
    target_grade: '',
    target_class: '',
    target_users: '',
  })

  // 从系统配置加载课程列表
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjectOptions(data.subjects)
    }).catch(() => {})
  }, [])

  // 加载讨论列表
  const loadDiscussions = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/discussions')
      setDiscussions(Array.isArray(data) ? data : [])
    } catch {
      message.error(t('loadFail'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    (async () => {
      await loadDiscussions()
    })()
  }, [loadDiscussions])

  // 创建讨论
  const handleCreate = async () => {
    try {
      await createForm.validateFields()
      setCreateLoading(true)
      const values = createForm.getFieldsValue()
      await apiClient.post('/api/interaction/discussions', {
        ...values,
        target_scope: discussionScope.target_scope,
        target_grade: discussionScope.target_grade,
        target_class: discussionScope.target_class,
        target_users: discussionScope.target_users,
      })
      message.success(t('createSuccess'))
      setCreateOpen(false)
      createForm.resetFields()
      setDiscussionScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
      loadDiscussions()
    } catch (err: any) {
      if (err?.errorFields) return
      message.error(t('createFailWithReason', { reason: err?.response?.data?.detail || err?.message }))
    } finally {
      setCreateLoading(false)
    }
  }

  // AI 生成讨论方案
  const handleAiGenerate = async () => {
    try {
      await aiForm.validateFields()
      setAiLoading(true)
      const values = aiForm.getFieldsValue()
      const { data } = await apiClient.post('/api/interaction/discussions/ai-generate', values)
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result && result.status === 'ok' && result.data) {
          createForm.setFieldsValue(result.data)
          message.success(t('aiPlanGenerated'))
          setAiModal(false)
          setCreateOpen(true)
        } else {
          message.error(result?.content || t('aiGenerateFail'))
        }
      } else if (data.status === 'ok' && data.data) {
        createForm.setFieldsValue(data.data)
        message.success(t('aiPlanGenerated'))
        setAiModal(false)
        setCreateOpen(true)
      } else {
        message.error(data.content || t('aiGenerateFail'))
      }
    } catch (err: any) {
      if (err?.errorFields) return
      message.error(t('generateFailWithReason', { reason: err?.response?.data?.detail || err?.message }))
    } finally {
      setAiLoading(false)
    }
  }

  // 开始讨论
  const handleStart = async (id: number) => {
    try {
      const { data } = await apiClient.post(`/api/interaction/discussions/${id}/start`)
      message.success(data.message || t('startSuccess'))
      loadDiscussions()
    } catch (err: any) {
      message.error(t('startFailWithReason', { reason: err?.response?.data?.detail || err?.message }))
    }
  }

  // 结束讨论
  const handleEnd = async (id: number) => {
    try {
      await apiClient.post(`/api/interaction/discussions/${id}/end`)
      message.success(t('endSuccess'))
      loadDiscussions()
    } catch (err: any) {
      message.error(t('operationFailWithReason', { reason: err?.response?.data?.detail || err?.message }))
    }
  }

  // 重新开始讨论
  const handleRestart = async (id: number) => {
    try {
      await apiClient.post(`/api/interaction/discussions/${id}/restart`)
      message.success(t('restartSuccess'))
      loadDiscussions()
    } catch (err: any) {
      message.error(t('operationFailWithReason', { reason: err?.response?.data?.detail || err?.message }))
    }
  }

  // 删除讨论
  const handleDelete = async (id: number) => {
    try {
      await apiClient.delete(`/api/interaction/discussions/${id}`)
      message.success(t('deleteSuccess'))
      loadDiscussions()
    } catch (err: any) {
      message.error(t('deleteFailWithReason', { reason: err?.response?.data?.detail || err?.message }))
    }
  }

  // 加入讨论
  const handleJoin = async (id: number) => {
    try {
      await apiClient.post(`/api/interaction/discussions/${id}/join`)
      message.success(t('joinSuccess'))
      loadDiscussions()
    } catch (err: any) {
      message.error(t('joinFailWithReason', { reason: err?.response?.data?.detail || err?.message }))
    }
  }

  // 查看详情
  const handleDetail = async (id: number) => {
    try {
      const { data } = await apiClient.get(`/api/interaction/discussions/${id}`)
      setDetailModal(data)
    } catch {
      message.error(t('getDetailFail'))
    }
  }

  // 进入讨论区（教师视角）
  const handleEnterGroup = (groupId: number, discussionId: number) => {
    navigate(`/discussion-room/${groupId}?discussion_id=${discussionId}`)
  }

  // 过滤列表
  const filtered = activeTab === 'all'
    ? discussions
    : discussions.filter(d => d.status === activeTab)

  // ── 创建讨论表单 ──
  const renderCreateForm = () => (
    <Form form={createForm} layout="vertical" style={{ maxWidth: 600 }}>
      <Form.Item name="title" label={t('discussionTopic')} rules={[{ required: true, message: t('discussionTopicRequired') }]}>
        <Input placeholder={t('discussionTopicPlaceholder')} />
      </Form.Item>
      <Form.Item name="description" label={t('discussionDescription')}>
        <TextArea rows={3} placeholder={t('discussionDescPlaceholder')} />
      </Form.Item>
      <Form.Item name="subject" label={t('subject')}>
          <Select placeholder={t('selectSubject')} allowClear>
            {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            <Select.Option value="人工智能通识">{t('aiGeneralKnowledge')}</Select.Option>
          </Select>
      </Form.Item>
      <Form.Item name="group_mode" label={t('groupMode')} initialValue="none">
        <Select>
          <Select.Option value="none">{t('noGroupMode')}</Select.Option>
          <Select.Option value="auto">{t('autoGroup')}</Select.Option>
          <Select.Option value="random">{t('randomGroup')}</Select.Option>
        </Select>
      </Form.Item>
      <Form.Item noStyle shouldUpdate={(prev, cur) => prev.group_mode !== cur.group_mode}>
        {({ getFieldValue }) => {
          const mode = getFieldValue('group_mode')
          if (mode === 'none') return null
          return mode === 'auto' ? (
            <Form.Item name="members_per_group" label={t('membersPerGroup')} initialValue={4}
              rules={[{ required: true, message: t('membersPerGroupRequired') }]}>
              <InputNumber min={2} max={10} style={{ width: '100%' }} />
            </Form.Item>
          ) : (
            <Form.Item name="group_count" label={t('groupCount')} initialValue={4}
              rules={[{ required: true, message: t('groupCountRequired') }]}>
              <InputNumber min={1} max={20} style={{ width: '100%' }} />
            </Form.Item>
          )
        }}
      </Form.Item>
      <Form.Item name="ai_role" label={t('aiRole')} initialValue="mixed">
        <Select>
          <Select.Option value="observer">{t('aiRoleObserverFull')}</Select.Option>
          <Select.Option value="guide">{t('aiRoleGuideFull')}</Select.Option>
          <Select.Option value="proactive">{t('aiRoleProactiveFull')}</Select.Option>
          <Select.Option value="judge">{t('aiRoleJudgeFull')}</Select.Option>
          <Select.Option value="mixed">{t('aiRoleMixedFull')}</Select.Option>
        </Select>
      </Form.Item>
      <Form.Item name="duration_minutes" label={t('durationMinutes')} initialValue={30}>
        <InputNumber min={5} max={120} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item label={t('targetScope')}>
        <ActivityScopeSelector value={discussionScope} onChange={setDiscussionScope} />
      </Form.Item>
      <Form.Item name="require_summary" label={t('submitRequirement')} valuePropName="checked" initialValue={false}>
        <Select>
          <Select.Option value={false}>{t('noSubmit')}</Select.Option>
          <Select.Option value={true}>{t('groupSubmit')}</Select.Option>
        </Select>
      </Form.Item>
    </Form>
  )

  // ── 讨论卡片 ──
  const renderDiscussionCard = (disc: any) => {
    const statusInfo = STATUS_MAP[disc.status] || { label: t('unknown'), color: 'default' }
    return (
      <Card
        key={disc.id}
        size="small"
        style={{ marginBottom: 12 }}
        actions={
          isTeacherOrAdmin
            ? [
                <Tooltip title={t('viewDetails')}><TeamOutlined onClick={() => handleDetail(disc.id)} /></Tooltip>,
                ...(disc.status === 'pending' ? [
                  <Tooltip title={t('startDiscussionTooltip')}><PlayCircleOutlined style={{ color: '#52c41a' }} onClick={() => handleStart(disc.id)} /></Tooltip>,
                ] : []),
                ...(disc.status === 'active' ? [
                  <Popconfirm title={t('confirmEnd')} onConfirm={() => handleEnd(disc.id)}>
                    <Tooltip title={t('endDiscussionTooltip')}><StopOutlined style={{ color: '#ff4d4f' }} /></Tooltip>
                  </Popconfirm>,
                ] : []),
                ...(disc.status === 'ended' ? [
                  <Tooltip title={t('restartDiscussionTooltip')}><ReloadOutlined style={{ color: '#52c41a' }} onClick={() => handleRestart(disc.id)} /></Tooltip>,
                  <Popconfirm title={t('confirmDeleteAll')} onConfirm={() => handleDelete(disc.id)}>
                    <Tooltip title={t('deleteDiscussionTooltip')}><DeleteOutlined style={{ color: '#ff4d4f' }} /></Tooltip>,
                  </Popconfirm>,
                ] : []),
              ]
            : [
                ...(disc.has_joined && disc.status === 'active'
                  ? [<Tooltip title={disc.group_mode === 'none' ? t('enterDiscussion') : t('enterGroup')}><TeamOutlined onClick={() => navigate(`/discussion-room/${disc.my_group.id}?discussion_id=${disc.id}`)} /></Tooltip>]
                  : disc.status === 'active' && !disc.has_joined
                  ? [<Tooltip title={t('joinDiscussion')}><MessageOutlined onClick={() => handleJoin(disc.id)} /></Tooltip>]
                  : []),
              ]
        }
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <Space>
              <div className="markdown-content" style={{ fontWeight: 600 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ p: ({children}) => <>{children}</> }}>{disc.title}</ReactMarkdown>
              </div>
              <Tag color={statusInfo.color}>{statusInfo.label}</Tag>
              {disc.subject && <Tag>{disc.subject}</Tag>}
            </Space>
            {disc.description && (
              <div className="markdown-content" style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{disc.description}</ReactMarkdown>
              </div>
            )}
          </div>
        </div>
        <div style={{ marginTop: 8, display: 'flex', gap: 16, fontSize: 13, color: '#888' }}>
          <span><TeamOutlined /> {disc.total_members || 0}{t('people')}{t('participants')}</span>
          <span><MessageOutlined /> {disc.total_messages || 0}{t('messages_')}</span>
          <span><RobotOutlined /> {getAiRoleLabel(disc.ai_role)}</span>
          {disc.duration_minutes > 0 && (
            <span><FieldTimeOutlined /> {disc.duration_minutes}{t('minutes')}</span>
          )}
        </div>
        {isStudent && disc.has_joined && disc.status === 'active' && disc.my_group && (
          <div style={{ marginTop: 4 }}>
            <Tag color="blue">{disc.group_mode === 'none' ? t('joinedChat') : `${t('myGroup')}: ${disc.my_group.name || `第${disc.my_group.group_index}组`}`}</Tag>
          </div>
        )}
      </Card>
    )
  }

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <TeamOutlined style={{ fontSize: 24, color: '#1677ff' }} />
          <Title level={4} style={{ margin: 0 }}>{t('title')}</Title>
        </Space>

        {isTeacherOrAdmin && (
          <Space style={{ marginBottom: 16 }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              {t('createDiscussion')}
            </Button>
            <Button icon={<BulbOutlined />} onClick={() => { setAiModal(true); aiForm.resetFields(); }}>
              {t('aiGeneratePlan')}
            </Button>
          </Space>
        )}

        <Tabs activeKey={activeTab} onChange={setActiveTab} tabBarStyle={{ marginBottom: 16 }}>
          <Tabs.TabPane tab={t('allDiscussions')} key="all" />
          <Tabs.TabPane tab={t('pendingDiscussions')} key="pending" />
          <Tabs.TabPane tab={t('activeDiscussions')} key="active" />
          <Tabs.TabPane tab={t('endedDiscussions')} key="ended" />
        </Tabs>

        <Spin spinning={loading}>
          {filtered.length === 0 ? (
            <Empty description={t('noDiscussions')} />
          ) : (
            <Table
              dataSource={filtered}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total) => t('totalDiscussions', { total }), pageSizeOptions: ['5', '10', '20', '50'] }}
              expandable={{
                expandedRowRender: (disc: any) => (
                  <div style={{ padding: '8px 0 4px 32px' }}>
                    {disc.description && (
                      <div className="markdown-content" style={{ marginBottom: 10 }}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{disc.description}</ReactMarkdown>
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 24, fontSize: 13, color: '#888', flexWrap: 'wrap' }}>
                      <span><TeamOutlined /> {t('participants')}：{disc.total_members || 0}</span>
                      <span><MessageOutlined /> {t('messageCount')}：{disc.total_messages || 0}</span>
                      <span><RobotOutlined /> {t('aiRole_')}：{getAiRoleLabel(disc.ai_role) || '-'}</span>
                      {disc.duration_minutes > 0 && (
                        <span><FieldTimeOutlined /> {t('duration')}：{disc.duration_minutes} {t('minutes')}</span>
                      )}
                      <span><UserOutlined /> {t('creator')}：{disc.creator_name || disc.creator_username || '-'}</span>
                      {disc.grade && <span>{t('applicableGrade')}：{disc.grade}</span>}
                      {disc.classes && <span>{t('applicableClass')}：{disc.classes}</span>}
                      {isStudent && disc.has_joined && disc.status === 'active' && disc.my_group && (
                        <Tag color="blue" style={{ margin: 0 }}>{disc.group_mode === 'none' ? t('joinedChat') : `${t('myGroup')}: ${disc.my_group.name || t('groupN', { n: disc.my_group.group_index })}`}</Tag>
                      )}
                    </div>
                    {isTeacherOrAdmin && (
                      <div style={{ marginTop: 10, borderTop: '1px solid #f0f0f0', paddingTop: 10 }}>
                        <Space>
                          <span style={{ fontSize: 13, color: '#888' }}>📋 {t('aiSummary')}：</span>
                          {disc.status === 'pending' && <Tag style={{ margin: 0 }}>{t('notStarted')}</Tag>}
                          {disc.status === 'active' && <Tag color="processing" style={{ margin: 0 }}>{t('inProgress')}</Tag>}
                          {disc.status === 'ended' && disc.has_summary && (
                            <>
                              <Tag color="success" style={{ margin: 0 }}>✅ {t('summaryDone')}</Tag>
                              <Button type="link" size="small" icon={<EyeOutlined />}
                                onClick={() => navigate(`/discussion-monitor/${disc.id}`)}
                                style={{ padding: 0 }}>
                                {t('viewSummary')}
                              </Button>
                            </>
                          )}
                          {disc.status === 'ended' && !disc.has_summary && (
                            <Tag color="default" style={{ margin: 0 }}>⏳ {t('pendingSummary')}</Tag>
                          )}
                        </Space>
                      </div>
                    )}
                  </div>
                ),
                rowExpandable: () => true,
              }}
              columns={[
                {
                  title: t('discussionTopic'), dataIndex: 'title', key: 'title',
                  render: (title: string, disc: any) => {
                    const statusInfo = STATUS_MAP[disc.status] || { label: t('unknown'), color: 'default' }
                    return (
                      <Space>
                        <div className="markdown-content" style={{ fontWeight: 600, cursor: 'pointer' }} onClick={() => handleDetail(disc.id)}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ p: ({children}) => <>{children}</> }}>{title}</ReactMarkdown>
                        </div>
                        <Tag color={statusInfo.color}>{statusInfo.label}</Tag>
                        {disc.subject && <Tag>{disc.subject}</Tag>}
                      </Space>
                    )
                  },
                },
                {
                  title: t('participation'), key: 'members', width: 110,
                  render: (_: any, disc: any) => (
                    <Text type="secondary">
                      <TeamOutlined /> {disc.total_members || 0}{t('people')} | <MessageOutlined /> {disc.total_messages || 0}
                    </Text>
                  ),
                },
                {
                  title: t('actions'), key: 'actions', width: 200,
                  render: (_: any, disc: any) => (
                    <Space size="small">
                      <Tooltip title={t('viewDetails')}>
                        <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => handleDetail(disc.id)} />
                      </Tooltip>
                      {isTeacherOrAdmin ? (
                        <>
                          {disc.status === 'pending' && (
                            <Button type="link" size="small" icon={<PlayCircleOutlined />}
                              onClick={() => handleStart(disc.id)} style={{ color: '#52c41a' }}>{t('start')}</Button>
                          )}
                          {disc.status === 'active' && (
                            <Popconfirm title={t('confirmEnd')} onConfirm={() => handleEnd(disc.id)}>
                              <Button type="link" size="small" icon={<StopOutlined />} danger>{t('end')}</Button>
                            </Popconfirm>
                          )}
                          {disc.status === 'ended' && (
                            <>
                              <Button type="link" size="small" icon={<ReloadOutlined />}
                                onClick={() => handleRestart(disc.id)} style={{ color: '#52c41a' }}>{t('restart')}</Button>
                              <Popconfirm title={t('confirmDeleteDiscussion')} onConfirm={() => handleDelete(disc.id)}>
                                <Button type="link" size="small" icon={<DeleteOutlined />} danger>{t('delete')}</Button>
                              </Popconfirm>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          {disc.has_joined && disc.status === 'active' && (
                            <Button type="link" size="small" icon={<TeamOutlined />}
                              onClick={() => navigate(`/discussion-room/${disc.my_group.id}?discussion_id=${disc.id}`)}>
                              {disc.group_mode === 'none' ? t('enterDiscussion') : `${t('enterGroup')}${disc.my_group ? `(${disc.my_group.name || t('groupN', { n: disc.my_group.group_index })})` : ''}`}
                            </Button>
                          )}
                          {disc.status === 'active' && !disc.has_joined && (
                            <Button type="link" size="small" icon={<MessageOutlined />}
                              onClick={() => handleJoin(disc.id)}>{t('joinDiscussion')}</Button>
                          )}
                        </>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </Spin>
      </Card>

      {/* 创建讨论弹窗 */}
      <Modal
        title={t('createDiscussionTitle')}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreate}
        confirmLoading={createLoading}
        width={640}
        okText={t('createDisc')}
      >
        {renderCreateForm()}
      </Modal>

      {/* 讨论详情弹窗（教师） */}
      <Modal
        title={<span className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ p: ({children}) => <>{children}</> }}>{detailModal?.title || t('discussionDetail')}</ReactMarkdown></span>}
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={null}
        width={700}
      >
        {detailModal && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Tag color={STATUS_MAP[detailModal.status]?.color}>
                {STATUS_MAP[detailModal.status]?.label}
              </Tag>
              <Tag>{detailModal.subject || t('noSubject')}</Tag>
              <span style={{ marginLeft: 12, color: '#888' }}>
                <RobotOutlined /> {getAiRoleLabel(detailModal.ai_role)}
              </span>
            </div>

            {detailModal.description && (
              <div className="markdown-content" style={{ marginBottom: 16, color: '#666' }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{detailModal.description}</ReactMarkdown>
              </div>
            )}

            {isTeacherOrAdmin && (
              <Button
                icon={<TeamOutlined />}
                style={{ marginBottom: 16 }}
                onClick={() => navigate(`/discussion-monitor/${detailModal.id}`)}
              >
                {t('monitorPanel')}
              </Button>
            )}

            <Title level={5}>{t('groupList')}</Title>
            {detailModal.groups?.map((g: any) => (
              <Card
                key={g.id}
                size="small"
                title={`${g.name || t('groupN', { n: g.group_index })}`}
                style={{ marginBottom: 8 }}
                extra={
                  <Space>
                    <Text type="secondary">{g.members?.length || 0}{t('people')}</Text>
                    {detailModal.status === 'active' && (
                      <Button size="small" onClick={() => handleEnterGroup(g.id, detailModal.id)}>
                        {t('enterRoom')}
                      </Button>
                    )}
                  </Space>
                }
              >
                <Space wrap>
                  {g.members?.length > 0 ? g.members.map((m: any) => (
                    <Tag key={m.username} icon={<UserOutlined />}>{studentLabel(m)}</Tag>
                  )) : <Text type="secondary">{t('noMembers')}</Text>}
                </Space>
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary">{t('messageCount')}: {g.message_count || 0}</Text>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Modal>

      {/* AI generate plan modal */}
      <Modal
        title={t('aiGenerateTopic')}
        open={aiModal}
        onCancel={() => setAiModal(false)}
        onOk={handleAiGenerate}
        confirmLoading={aiLoading}
        okText={t('generatePlan')}
      >
        <Form form={aiForm} layout="vertical">
          <Form.Item name="topic" label={t('discussionTopic')} rules={[{ required: true, message: t('discussionTopicRequired') }]}>
            <Input placeholder={t('discussionTopicPlaceholder')} />
          </Form.Item>
          <Form.Item name="subject" label={t('subject')} initialValue={subjectOptions[0] || ''}>
            <Select>
              {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="ai_role" label={t('aiRole')} initialValue="mixed">
            <Select>
              <Select.Option value="observer">{t('aiRoleObserver')}</Select.Option>
              <Select.Option value="guide">{t('aiRoleGuide')}</Select.Option>
              <Select.Option value="proactive">{t('aiRoleProactive')}</Select.Option>
              <Select.Option value="judge">{t('aiRoleJudge')}</Select.Option>
              <Select.Option value="mixed">{t('aiRoleMixed')}</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="duration_minutes" label={t('estimatedDuration')} initialValue={30}>
            <InputNumber min={5} max={120} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="group_mode" label={t('groupMode')} initialValue="none">
            <Select>
              <Select.Option value="none">{t('noGroupMode')}</Select.Option>
              <Select.Option value="auto">{t('autoGroup')}</Select.Option>
              <Select.Option value="random">{t('randomGroup')}</Select.Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

export default DiscussionPage
