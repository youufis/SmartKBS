import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Button, message, Modal, Input, Tag, Space,
  Typography, Spin, Popconfirm, Popover, Drawer, Tooltip,
} from 'antd'
import {
  PlusOutlined, SendOutlined, ReloadOutlined, DeleteOutlined,
  CheckCircleOutlined, EyeOutlined, UndoOutlined,
  RobotOutlined, BarChartOutlined,
} from '@ant-design/icons'
import * as tasksApi from '../api/tasks'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import type { TaskInfo } from '../types'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import { useChatStore, setTaskFilename } from '../stores/chatStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const TaskPage: React.FC = () => {
  const { t } = useTranslation('system')
  const user = useAuthStore((s) => s.user)
  const messages = useChatStore((s) => s.messages)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const username = user?.username || ''
  const isStudent = user?.role === 'student'

  // ── 等级辅助函数 ──
  const getGradeLevel = (score: number): { label: string; color: string } => {
    if (score >= 90) return { label: t('excellent'), color: 'green' }
    if (score >= 75) return { label: t('good'), color: 'blue' }
    if (score >= 60) return { label: t('pass'), color: 'orange' }
    if (score >= 40) return { label: t('poor'), color: 'red' }
    return { label: t('fail'), color: 'default' }
  }

  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [createModal, setCreateModal] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [taskDesc, setTaskDesc] = useState('')
  const [taskScope, setTaskScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes',
    target_grade: '',
    target_class: '',
    target_users: '',
  })
  const [submitModal, setSubmitModal] = useState(false)
  const [selectedTask, setSelectedTask] = useState<TaskInfo | null>(null)

  // 提交详情
  const [submissionsDrawer, setSubmissionsDrawer] = useState(false)
  const [submissionsData, setSubmissionsData] = useState<{
    task_name: string; task_status: string; submissions: tasksApi.TaskSubmission[]; count: number
  }>({ task_name: '', task_status: '', submissions: [], count: 0 })
  const [submissionsLoading, setSubmissionsLoading] = useState(false)
  const [viewTask, setViewTask] = useState<TaskInfo | null>(null)

  // 查看学生提交内容
  const [contentDrawer, setContentDrawer] = useState(false)
  const [studentContent, setStudentContent] = useState('')
  const [contentLoading, setContentLoading] = useState(false)

  // AI 批改
  const [aiGradingTaskId, setAiGradingTaskId] = useState<string | null>(null)
  const [gradesMap, setGradesMap] = useState<Record<string, tasksApi.AIGradeResult>>({})
  const [classSummary, setClassSummary] = useState<tasksApi.AIClassSummary | null>(null)
  const [gradesLoading, setGradesLoading] = useState(false)

  // 学生查看自己的批改
  const [myGradeModal, setMyGradeModal] = useState(false)
  const [myGrade, setMyGrade] = useState<tasksApi.AIGradeResult | null>(null)
  const [myGradeTaskName, setMyGradeTaskName] = useState('')
  const [myGradeLoading, setMyGradeLoading] = useState(false)

  const loadTasks = useCallback(async () => {
    setLoading(true)
    try {
      const { tasks: list } = await tasksApi.getActiveTasks()
      setTasks(list)
    } catch {
      message.error(t('loadTaskListFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { loadTasks() }, [loadTasks])

  // ── 创建任务 ──
  const handleCreate = async () => {
    if (!taskName.trim()) { message.warning(t('enterTaskName')); return }
    try {
      const res = await tasksApi.createTask(taskName.trim(), taskDesc.trim(), taskScope)
      message.success(res.message)
      setCreateModal(false)
      setTaskName('')
      setTaskDesc('')
      setTaskScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('createFailed'))
    }
  }

  // ── 结束任务 ──
  const handleEnd = async (taskId: string) => {
    try {
      const res = await tasksApi.endTask(taskId)
      message.success(res.message)
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('endFailed'))
    }
  }

  // ── 删除任务 ──
  const handleDelete = async (taskId: string) => {
    try {
      const res = await tasksApi.deleteTask(taskId)
      message.success(res.message)
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('taskDeleteFailed'))
    }
  }

  // ── 提交任务 ──
  const handleSubmit = async () => {
    if (!selectedTask) return
    const content = messages.map(m =>
      `**${m.role === 'user' ? t('user') : t('assistant')}**: ${m.content}`
    ).join('\n\n---\n\n')
    if (!content.trim()) {
      message.warning(t('emptyChatWarning'))
      return
    }
    try {
      const res = await tasksApi.submitTask(selectedTask.id, content)
      message.success(res.message)
      setTaskFilename(selectedTask.name)
      setSubmitModal(false)
      setSelectedTask(null)
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('submitFailed'))
    }
  }

  // ── 查看单个学生提交内容 ──
  const handleViewContent = async (studentUsername: string) => {
    if (!viewTask) return
    setContentLoading(true)
    setContentDrawer(true)
    setStudentContent(t('loading'))
    try {
      const data = await tasksApi.getTaskSubmissions(viewTask.id, studentUsername)
      setStudentContent(data.student_content || t('noSubmissionContent'))
    } catch (err: any) {
      setStudentContent(`❌ ${err?.response?.data?.detail || err.message}`)
    } finally {
      setContentLoading(false)
    }
  }

  // ── 回退学生提交 ──
  const handleRevert = async (taskId: string, studentUsername: string) => {
    try {
      const msg = await tasksApi.revertSubmission(taskId, studentUsername)
      message.success(msg)
      // 刷新提交列表
      if (viewTask) handleViewSubmissions(viewTask)
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('taskRollbackFailed'))
    }
  }

  // ── AI 批改 ──
  const handleAiGrade = async (taskId: string) => {
    setAiGradingTaskId(taskId)
    try {
      const res = await tasksApi.aiGradeTask(taskId)
      message.success(res.message)
      const map: Record<string, tasksApi.AIGradeResult> = {}
      if (res.grades && res.grades.length > 0) {
        res.grades.forEach(g => { map[g.student] = g })
        setGradesMap(map)
      } else {
        message.warning(t('aiGradingFailed'))
      }
      if (res.summary) setClassSummary(res.summary)
    } catch (err: any) {
      message.error(t('aiGradeFailed') + ': ' + (err?.response?.data?.detail || err.message || t('unknownError')))
    } finally {
      setAiGradingTaskId(null)
    }
  }

  // ── 加载批改结果 ──
  const loadGrades = async (taskId: string) => {
    setGradesLoading(true)
    try {
      const res = await tasksApi.getTaskGrades(taskId)
      const map: Record<string, tasksApi.AIGradeResult> = {}
      if (res.grades && res.grades.length > 0) {
        res.grades.forEach(g => { map[g.student] = g })
        setGradesMap(map)
      }
      if (res.summary) setClassSummary(res.summary)
    } catch {
      // 忽略，可能还没有批改结果
    } finally {
      setGradesLoading(false)
    }
  }

  // ── 查看提交详情（同时加载批改结果） ──
  const handleViewSubmissions = async (task: TaskInfo) => {
    setViewTask(task)
    setSubmissionsDrawer(true)
    setSubmissionsLoading(true)
    try {
      const data = await tasksApi.getTaskSubmissions(task.id)
      setSubmissionsData({
        task_name: data.task_name,
        task_status: data.task_status,
        submissions: data.submissions,
        count: data.submission_count,
      })
      // 同时加载批改结果
      loadGrades(task.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('loadDetailFailed'))
      setSubmissionsData({ task_name: '', task_status: '', submissions: [], count: 0 })
    } finally {
      setSubmissionsLoading(false)
    }
  }

  // ── 学生查看自己的批改结果 ──
  const handleViewMyGrade = async (task: TaskInfo) => {
    setMyGradeTaskName(task.name)
    setMyGradeModal(true)
    setMyGradeLoading(true)
    try {
      const res = await tasksApi.getTaskGrades(task.id)
      if (res.grades && res.grades.length > 0) {
        setMyGrade(res.grades[0])
      } else {
        setMyGrade(null)
      }
    } catch {
      setMyGrade(null)
    } finally {
      setMyGradeLoading(false)
    }
  }

  // ── 列定义 ──
  const studentStatusColumn = {
    title: t('myStatus'), key: 'myStatus', width: 100,
    render: (_: any, record: TaskInfo) => {
      const submitted = record.submissions?.includes(username)
      return submitted
        ? <Tag color="success">{t('submitted')}</Tag>
        : <Tag color="default">{t('notSubmitted')}</Tag>
    },
  }

  const columns = [
    { title: t('taskName'), dataIndex: 'name', key: 'name', width: 180 },
    {
      title: t('taskDescription'), dataIndex: 'description', key: 'description', width: 200,
      render: (d: string) => d ? (
        <Typography.Paragraph ellipsis={{ rows: 1 }} style={{ margin: 0, fontSize: 13, color: '#666' }}>
          {d}
        </Typography.Paragraph>
      ) : <Typography.Text type="secondary" style={{ fontSize: 12 }}>--</Typography.Text>,
    },
    { title: t('taskCreator'), dataIndex: 'creator', key: 'creator', width: 80 },
    {
      title: t('status'), dataIndex: 'status', key: 'status', width: 70,
      render: (s: string) => (
        <Tag color={s === 'active' ? 'green' : 'default'}>
          {s === 'active' ? t('inProgress') : t('ended')}
        </Tag>
      ),
    },
    { title: t('createdTime'), dataIndex: 'created_time', key: 'created_time', width: 160 },
    ...(isStudent
      ? [studentStatusColumn]
      : [{
          title: t('submittedCount'), key: 'submissions', width: 100,
          render: (_: any, record: TaskInfo) => {
            const names = (record as any).submissions_names || []
            const count = record.submissions?.length || 0
            if (count === 0) return <Typography.Text type="secondary">{t('zeroPeople')}</Typography.Text>
            return (
              <Popover
                title={t('submittedStudents')}
                content={
                  <div style={{ maxHeight: 200, overflow: 'auto' }}>
                    {names.map((n: string, i: number) => (
                      <div key={i} style={{ padding: '2px 0' }}>{n}</div>
                    ))}
                  </div>
                }
                trigger="click"
              >
                <Button type="link" size="small">{t('peopleCount', { count })} 👤</Button>
              </Popover>
            )
          },
        }]
    ),
    {
      title: t('actions'), key: 'action', width: 280,
      render: (_: any, record: TaskInfo) => (
        <Space size="small" wrap>
          {isStudent && record.status === 'active' && (
            <Tooltip title={t('submitAction')}>
              <Button size="small" type="primary" icon={<SendOutlined />}
                onClick={() => { setSelectedTask(record); setSubmitModal(true) }}
              />
            </Tooltip>
          )}
          {isStudent && record.submissions?.includes(username) && (
            <Tooltip title={t('scoreAction')}>
              <Button size="small" icon={<BarChartOutlined />}
                onClick={() => handleViewMyGrade(record)}
              />
            </Tooltip>
          )}
          {isAdminOrTeacher && (
            <Tooltip title={t('details')}>
              <Button size="small" icon={<EyeOutlined />}
                onClick={() => handleViewSubmissions(record)}
              />
            </Tooltip>
          )}
          {isAdminOrTeacher && record.submissions && record.submissions.length > 0 && (
            <Tooltip title={t('aiGradeTooltip')}>
              <Button size="small" icon={<RobotOutlined />}
                loading={aiGradingTaskId === record.id}
                onClick={() => handleAiGrade(record.id)}
              />
            </Tooltip>
          )}
          {isAdminOrTeacher && record.status === 'active' && (
            <Popconfirm
              title={t('confirmEndTitle', { name: record.name })}
              description={t('confirmEndDesc')}
              onConfirm={() => handleEnd(record.id)}
              okText={t('confirmEndOk')} cancelText={t('cancel')}
            >
              <Tooltip title={t('endAction')}>
                <Button size="small" icon={<CheckCircleOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
          {isAdminOrTeacher && (
            <Popconfirm
              title={t('confirmDeleteTitle', { name: record.name })}
              onConfirm={() => handleDelete(record.id)}
              okText={t('confirmDeleteOk')} cancelText={t('cancel')}
            >
              <Tooltip title={t('deleteAction')}>
                <Button size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('taskManagement')}</Typography.Title>
          {isAdminOrTeacher && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
              {t('createTask')}
            </Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={loadTasks}>{t('refresh')}</Button>
        </Space>

        <Spin spinning={loading}>
          <Table
            dataSource={tasks}
            columns={columns}
            rowKey="id"
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('totalTasks', { count: total }), pageSizeOptions: ['10', '20', '50'] }}
            size="small"
            locale={{ emptyText: t('noActiveTasks') }}
          />
        </Spin>
      </Card>

      {/* 创建任务弹窗 */}
      <Modal
        title={t('createNewTask')}
        open={createModal}
        onOk={handleCreate}
        onCancel={() => { setCreateModal(false); setTaskName(''); setTaskDesc(''); setTaskScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' }) }}
        okText={t('createTask')} cancelText={t('cancel')}
        width={640}
      >
        <Input
          placeholder={t('taskNamePlaceholder')}
          value={taskName}
          onChange={(e) => setTaskName(e.target.value)}
        />
        <Input.TextArea
          placeholder={t('taskDescPlaceholder')}
          value={taskDesc}
          onChange={(e) => setTaskDesc(e.target.value)}
          rows={3}
          style={{ marginTop: 12 }}
        />
        <div style={{ marginTop: 16 }}>
          <ActivityScopeSelector value={taskScope} onChange={setTaskScope} />
        </div>
      </Modal>

      {/* 提交任务确认弹窗 */}
      <Modal
        title={t('submitToTask', { name: selectedTask?.name || '' })}
        open={submitModal}
        onOk={handleSubmit}
        onCancel={() => { setSubmitModal(false); setSelectedTask(null) }}
        okText={t('confirmSubmit')} cancelText={t('cancel')}
      >
        <Space orientation="vertical">
          <Typography.Text>
            {t('submitContentDesc')} <strong>{selectedTask?.name}</strong>？
          </Typography.Text>
          {selectedTask?.description && (
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('taskDescLabel')}{selectedTask.description}
            </Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('totalMessagesCount', { count: messages.length })}
          </Typography.Text>
        </Space>
      </Modal>

      {/* 提交详情侧栏 */}
      <Drawer
        title={`📋 ${submissionsData.task_name || t('loading')}`}
        placement="right"
        size={760}
        open={submissionsDrawer}
        onClose={() => { setSubmissionsDrawer(false); setContentDrawer(false) }}
      >
        <Spin spinning={submissionsLoading || gradesLoading}>
          <Space style={{ marginBottom: 16 }} wrap>
            <Tag color={submissionsData.task_status === 'active' ? 'green' : 'default'}>
              {submissionsData.task_status === 'active' ? t('inProgress') : t('ended')}
            </Tag>
            {Object.keys(gradesMap).length > 0 && (
              <Tag color="blue" icon={<RobotOutlined />}>
                {t('gradedCount', { graded: Object.keys(gradesMap).length, total: submissionsData.count })}
              </Tag>
            )}
            {viewTask && submissionsData.submissions.length > 0 && (
              <Button size="small" icon={<RobotOutlined />}
                loading={aiGradingTaskId === viewTask.id}
                onClick={() => handleAiGrade(viewTask.id)}
              >{Object.keys(gradesMap).length > 0 ? t('regrade') : t('aiGradeAction')}</Button>
            )}
          </Space>

          {classSummary && (
            <Card size="small" style={{ marginBottom: 16, background: '#f0f5ff', border: '1px solid #adc6ff' }}>
              <Space orientation="vertical" style={{ width: '100%' }} size={4}>
                <Typography.Text strong style={{ color: '#1d39c4' }}>
                  <RobotOutlined /> {t('classGradingSummary')}
                </Typography.Text>
                {(classSummary.class_average != null) && (
                  <Space wrap>
                    <Tag color="blue">{t('avgScore')}{classSummary.class_average?.toFixed?.(1) ?? classSummary.class_average}</Tag>
                    <Tag color="green">{t('highestScore')}{classSummary.highest_score}</Tag>
                    <Tag color="orange">{t('lowestScore')}{classSummary.lowest_score}</Tag>
                    <Tag>{t('totalStudents')}{classSummary.total_students}</Tag>
                  </Space>
                )}
                <Typography.Paragraph style={{ fontSize: 13, margin: '4px 0', color: '#595959' }}>
                  💡 {classSummary.overall_comment}
                </Typography.Paragraph>
                {classSummary.teaching_suggestions && (
                  <Typography.Paragraph style={{ fontSize: 13, margin: 0, color: '#1d39c4', background: '#f0f5ff', padding: '4px 8px', borderRadius: 4 }}>
                    {t('teachingSuggestions')}{classSummary.teaching_suggestions}
                  </Typography.Paragraph>
                )}
              </Space>
            </Card>
          )}

          {submissionsData.submissions.length === 0 ? (
            <Typography.Text type="secondary">{t('noSubmissions')}</Typography.Text>
          ) : (
            <>
              <Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>
                {t('submittedStudentsCount', { count: submissionsData.count })}
                {Object.keys(gradesMap).length > 0 && (
                  <Typography.Text style={{ fontSize: 12, marginLeft: 8 }} type="secondary">
                    {t('sortedByScoreDesc')}
                  </Typography.Text>
                )}
              </Typography.Text>
              <Table
                dataSource={(() => {
                  const list = submissionsData.submissions.map(s => {
                    const g = gradesMap[s.username]
                    const level = g ? getGradeLevel(g.score) : null
                    return { ...s, grade: g, level, key: s.username }
                  })
                  return list.sort((a, b) => {
                    if (a.grade && b.grade) return b.grade.score - a.grade.score
                    if (a.grade) return -1
                    if (b.grade) return 1
                    return 0
                  })
                })()}
                expandable={{
                  expandedRowRender: (r: any) => {
                    if (!r.grade) return <Typography.Text type="secondary">{t('noGradeData')}</Typography.Text>
                    return (
                      <div style={{ padding: '8px 0 4px 0' }}>
                        <Typography.Paragraph style={{ fontSize: 13, margin: '0 0 8px 0', color: '#595959' }}>
                          💬 {r.grade.comment}
                        </Typography.Paragraph>
                        {r.grade.strengths?.length > 0 && (
                          <div style={{ marginBottom: 6 }}>
                            <Typography.Text style={{ fontSize: 12, color: '#52c41a' }}>
                              {t('strengths')}{r.grade.strengths.join('、')}
                            </Typography.Text>
                          </div>
                        )}
                        {r.grade.weaknesses?.length > 0 && (
                          <div style={{ marginBottom: 6 }}>
                            <Typography.Text style={{ fontSize: 12, color: '#ff4d4f' }}>
                              {t('weaknesses')}{r.grade.weaknesses.join('、')}
                            </Typography.Text>
                          </div>
                        )}
                        {r.grade.feedback && (
                          <div style={{ padding: '6px 8px', background: '#f0f5ff', borderRadius: 4, marginTop: 4 }}>
                            <Typography.Text style={{ fontSize: 12, color: '#1d39c4' }}>
                              {t('suggestions')}{r.grade.feedback}
                            </Typography.Text>
                          </div>
                        )}
                      </div>
                    )
                  },
                  rowExpandable: (r: any) => !!r.grade,
                }}
                columns={[
                  {
                    title: '#', key: 'index', width: 36,
                    render: (_: any, __: any, i: number) => i + 1,
                  },
                  {
                    title: t('student'), key: 'student', width: 80,
                    render: (_: any, r: any) => (
                      <Typography.Text strong style={{ fontSize: 12 }}>{r.name}</Typography.Text>
                    ),
                  },
                  {
                    title: t('scoreGrade'), key: 'score', width: 110,
                    render: (_: any, r: any) => r.grade ? (
                      <Space align="center" size={2}>
                        <Typography.Text strong style={{ fontSize: 14, color: '#52c41a', minWidth: 24 }}>
                          {r.grade.score}
                        </Typography.Text>
                        <Tag color={r.level.color} style={{ margin: 0, fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>{r.level.label}</Tag>
                      </Space>
                    ) : <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('pendingGrading')}</Typography.Text>,
                  },
                  {
                    title: t('actions'), key: 'action', width: 66,
                    render: (_: any, r: any) => (
                      <Space size={2}>
                        <Tooltip title={t('viewSubmissionContent')}>
                          <Button size="small" type="text" icon={<EyeOutlined />}
                            onClick={() => handleViewContent(r.username)}
                          />
                        </Tooltip>
                        <Popconfirm
                          title={t('confirmRevert', { name: r.name })}
                          description={t('revertDesc')}
                          onConfirm={() => handleRevert(viewTask?.id || '', r.username)}
                          okText={t('confirmOk')} cancelText={t('cancel')}
                        >
                          <Tooltip title={t('revertSubmission')}>
                            <Button size="small" type="text" icon={<UndoOutlined />} />
                          </Tooltip>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
                rowKey="key"
                size="small"
                pagination={false}
                locale={{ emptyText: t('emptyData') }}
              />
            </>
          )}
        </Spin>

        {/* 学生提交内容抽屉 */}
        <Drawer
          title={t('contentTitle')}
          placement="right"
          size={520}
          open={contentDrawer}
          onClose={() => setContentDrawer(false)}
          getContainer={false}
          style={{ position: 'absolute' }}
        >
          <Spin spinning={contentLoading}>
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {studentContent || t('noContent')}
              </ReactMarkdown>
            </div>
          </Spin>
        </Drawer>
      </Drawer>

      <style>{`
        .markdown-content p { margin-bottom: 4px; }
        .markdown-content pre { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow-x: auto; }
        .markdown-content code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
      `}</style>

      {/* 学生查看自己的批改结果 */}
      <Modal
        title={t('gradingResult', { name: myGradeTaskName })}
        open={myGradeModal}
        onCancel={() => setMyGradeModal(false)}
        footer={<Button onClick={() => setMyGradeModal(false)}>{t('close')}</Button>}
        width={520}
      >
        <Spin spinning={myGradeLoading}>
          {myGrade ? (
            <Space orientation="vertical" style={{ width: '100%' }} size={12}>
              <Card size="small" style={{ background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                <Space align="center" size={16}>
                  <div style={{ textAlign: 'center' }}>
                    <Typography.Title level={2} style={{ color: '#52c41a', margin: 0 }}>
                      {myGrade.score}
                    </Typography.Title>
                    <Tag color={getGradeLevel(myGrade.score).color} style={{ margin: 0 }}>
                      {getGradeLevel(myGrade.score).label}
                    </Tag>
                  </div>
                  <div style={{ flex: 1 }}>
                    <Typography.Text style={{ fontSize: 13, color: '#595959' }}>
                      {myGrade.comment}
                    </Typography.Text>
                  </div>
                </Space>
              </Card>

              {myGrade.strengths && myGrade.strengths.length > 0 && (
                <div>
                  <Typography.Text strong style={{ color: '#52c41a' }}>{t('strengthsTitle')}</Typography.Text>
                  <ul style={{ margin: '4px 0 0 0', paddingLeft: 20 }}>
                    {myGrade.strengths.map((s, i) => (
                      <li key={i}><Typography.Text style={{ fontSize: 13 }}>{s}</Typography.Text></li>
                    ))}
                  </ul>
                </div>
              )}

              {myGrade.weaknesses && myGrade.weaknesses.length > 0 && (
                <div>
                  <Typography.Text strong style={{ color: '#ff4d4f' }}>{t('weaknessesTitle')}</Typography.Text>
                  <ul style={{ margin: '4px 0 0 0', paddingLeft: 20 }}>
                    {myGrade.weaknesses.map((w, i) => (
                      <li key={i}><Typography.Text style={{ fontSize: 13 }}>{w}</Typography.Text></li>
                    ))}
                  </ul>
                </div>
              )}

              {myGrade.feedback && (
                <Card size="small" style={{ background: '#f0f5ff', border: '1px solid #adc6ff' }}>
                  <Typography.Text strong style={{ color: '#1d39c4' }}>{t('improvementSuggestions')}</Typography.Text>
                  <Typography.Paragraph style={{ margin: '4px 0 0 0', fontSize: 13 }}>
                    {myGrade.feedback}
                  </Typography.Paragraph>
                </Card>
              )}

              {myGrade.graded_at && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {t('gradedAt')}{myGrade.graded_at}
                </Typography.Text>
              )}
            </Space>
          ) : (
            <Typography.Text type="secondary">{t('noGradeResult')}</Typography.Text>
          )}
        </Spin>
      </Modal>
    </div>
  )
}

export default TaskPage
