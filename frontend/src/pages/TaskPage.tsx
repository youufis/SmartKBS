import { studentLabel } from '../utils/studentLabel'
import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Button, message, Modal, Input, Tag, Space, Checkbox, Alert, Radio,
  Typography, Spin, Popconfirm, Popover, Drawer, Tooltip, Collapse, Select, Empty,
} from 'antd'
import {
  PlusOutlined, SendOutlined, ReloadOutlined, DeleteOutlined,
  CheckCircleOutlined, EyeOutlined, UndoOutlined,
  RobotOutlined, BarChartOutlined, QuestionCircleOutlined, BulbOutlined, ExpandAltOutlined,
  EditOutlined,
} from '@ant-design/icons'
import * as tasksApi from '../api/tasks'
import { useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import ScopeTag from '../components/ScopeTag'

import type { TaskInfo } from '../types'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import { useChatStore, setTaskFilename } from '../stores/chatStore'
import FormulaRenderer from '../components/FormulaRenderer'
import ResetActivityButton from '../components/ResetActivityButton'
import MobileCardTable from '../components/MobileCardTable'
import { HomeworkForm, HomeworkBoard, HomeworkSubmitModal } from './task/HomeworkPanel'
import { emptyHomework, homeworkFromTask, type HomeworkValue } from './task/homeworkModel'
import { useIsMobile } from '../hooks/useIsMobile'
import useSubjectOptions from '../hooks/useSubjectOptions'

const TaskPage: React.FC = () => {
  const { t } = useTranslation('system')
  const user = useAuthStore((s) => s.user)
  const messages = useChatStore((s) => s.messages)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const username = user?.username || ''
  const isStudent = user?.role === 'student'
  const isMobile = useIsMobile()

  // ── 等级辅助函数 ──
  const getGradeLevel = (score: number): { label: string; color: string } => {
    if (score >= 90) return { label: t('excellent'), color: 'green' }
    if (score >= 75) return { label: t('good'), color: 'blue' }
    if (score >= 60) return { label: t('pass'), color: 'orange' }
    if (score >= 40) return { label: t('poor'), color: 'red' }
    return { label: t('fail'), color: 'default' }
  }

  // ── 要求点（批改依据 = 教师填的任务名称/说明）──
  const criterionMeta = (status?: string) => {
    if (status === 'met') return { icon: '✅', color: 'success', label: t('criterionMet') }
    if (status === 'missing') return { icon: '❌', color: 'error', label: t('criterionMissing') }
    return { icon: '🟡', color: 'warning', label: t('criterionPartial') }
  }

  // 全班层面的要求点达成情况标签色（中英文案都能落位）
  const reviewColor = (status?: string) => {
    const v = status || ''
    if (/普遍达成|全部达成|^met|good/i.test(v)) return 'success'
    if (/普遍缺失|缺失|未达成|^missing|poor/i.test(v)) return 'error'
    return 'warning'
  }

  const renderCriteria = (criteria?: tasksApi.GradeCriterion[]) => {
    if (!criteria || criteria.length === 0) return null
    return (
      <div style={{ marginBottom: 8 }}>
        <Typography.Text style={{ fontSize: 12, fontWeight: 600 }}>{t('criteriaTitle')}</Typography.Text>
        {criteria.map((cr, i) => {
          const meta = criterionMeta(cr.status)
          return (
            <div key={i} style={{ marginTop: 2, paddingLeft: 4 }}>
              <Typography.Text style={{ fontSize: 12 }}>
                {meta.icon} {cr.item}
                <Tag color={meta.color} style={{ marginInlineStart: 6, marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>
                  {meta.label}
                </Tag>
                {cr.evidence && (
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 6 }}>
                    {cr.evidence}
                  </Typography.Text>
                )}
              </Typography.Text>
            </div>
          )
        })}
      </div>
    )
  }

  const [tasks, setTasks] = useState<TaskInfo[]>([])
  // 首页「待批改任务」带 ?grading=pending 直达：只列还有未批改提交的任务
  const [searchParams, setSearchParams] = useSearchParams()
  const [pendingOnly, setPendingOnly] = useState(() => searchParams.get('grading') === 'pending')
  const setPendingFilter = (v: boolean) => {
    setPendingOnly(v)
    const next = new URLSearchParams(searchParams)
    if (v) next.set('grading', 'pending')
    else next.delete('grading')
    setSearchParams(next, { replace: true })
  }
  const visibleTasks = pendingOnly && !isStudent ? tasks.filter((x) => (x.pending_grade_count ?? 0) > 0) : tasks
  const [loading, setLoading] = useState(false)
  const MOBILE_CARD_PAGE = 8            // 窄屏卡片列表每页条数
  const [mPage, setMPage] = useState(1)
  const [createModal, setCreateModal] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [taskDesc, setTaskDesc] = useState('')
  // 学科：与其它活动一致（默认取系统配置的第一个），落库后列表/活动监控才显示科目
  const [taskSubject, setTaskSubject] = useState('')
  // 正在编辑的作业 id（null = 新建）：同一个弹窗两用
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const { subjects: subjectOptions } = useSubjectOptions()
  // 学科清单到位后补默认值（留空太容易漏填，作业就没有科目了）
  useEffect(() => {
    if (subjectOptions.length > 0) setTaskSubject(prev => prev || subjectOptions[0])
  }, [subjectOptions])
  const [taskScope, setTaskScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes',
    target_grade: '',
    target_class: '',
    target_users: '',
  })
  // 文件作业参数：对话作业保持默认值即可，后端按 conversation 走老路径
  const [hw, setHw] = useState<HomeworkValue>(emptyHomework())
  const [submitModal, setSubmitModal] = useState(false)
  const [fileSubmitOpen, setFileSubmitOpen] = useState(false)
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
  // 单个学生批改的行内 loading（键为学生用户名）
  const [aiGradingStudent, setAiGradingStudent] = useState<string | null>(null)

  // 使用说明：不占版面，点标题旁「使用说明」弹窗查看（学生端/教师端同一交互）
  const [guideOpen, setGuideOpen] = useState(false)
  // AI 起草作业（生成名称与要求草稿，教师改完再创建）
  const [aiDraftOpen, setAiDraftOpen] = useState(false)
  const [aiIdea, setAiIdea] = useState('')
  const [aiDuration, setAiDuration] = useState('')
  const [aiDraftLoading, setAiDraftLoading] = useState(false)
  const [aiDraft, setAiDraft] = useState<tasksApi.HomeworkDraft | null>(null)
  // 起草前先定形态：对话作业与文件作业的要求写法完全不同，不能用同一套 prompt
  const [aiDraftMode, setAiDraftMode] = useState<'conversation' | 'file' | 'mixed'>('conversation')
  // 作业要求全文弹窗：列表里只显示两行，长文点「查看」
  const [reqModal, setReqModal] = useState<string | null>(null)

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
      if (editingTaskId) {
        const res = await tasksApi.updateTask(editingTaskId, {
          name: taskName.trim(), description: taskDesc.trim(), subject: taskSubject,
          // 截止/限额/维度随时可改；提交方式已由后端在有提交时锁死
          ...hw,
        })
        message.success(res.message)
        setCreateModal(false)
        setEditingTaskId(null)
        setTaskName(''); setTaskDesc('')
        loadTasks()
        return
      }
      const res = await tasksApi.createTask(taskName.trim(), taskDesc.trim(), taskScope, taskSubject,
        hw.submit_mode === 'conversation' ? undefined : hw)
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

  // ── 只批改一位学生：重批某个人或补批新提交，不动其他学生的成绩 ──
  const handleAiGradeStudent = async (taskId: string, student: string, label: string) => {
    setAiGradingStudent(student)
    try {
      const res = await tasksApi.aiGradeStudent(taskId, student)
      if (res.grade) setGradesMap((prev) => ({ ...prev, [student]: res.grade }))
      if (res.summary) setClassSummary(res.summary)
      message.success(t('aiGradeStudentSuccess', { name: label }))
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || err?.message || t('aiGradeFailed'))
    } finally {
      setAiGradingStudent(null)
    }
  }

  const openAiDraft = () => {
    setAiDraft(null)
    // 默认跟随创建表单里已选的提交方式，教师切了形态再来起草就不会拿到对话作业的要求
    setAiDraftMode(hw.submit_mode)
    setAiDraftOpen(true)
  }

  const handleAiDraft = async () => {
    if (!aiIdea.trim()) { message.warning(t('aiIdeaRequired')); return }
    setAiDraftLoading(true)
    try {
      const res = await tasksApi.aiDraftHomework({
        idea: aiIdea.trim(),
        grade: taskScope.target_grade,
        class: taskScope.target_class,
        duration_minutes: aiDuration,
        submit_mode: aiDraftMode,
        total_score: hw.total_score,
      })
      setAiDraft(res)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || err?.message || t('aiDraftFailed'))
    } finally {
      setAiDraftLoading(false)
    }
  }

  const useAiDraft = () => {
    if (!aiDraft) return
    setTaskName(aiDraft.name.slice(0, 60))
    setTaskDesc(aiDraft.description)
    // 文件作业的草稿连评分维度和要收的文件类型一起带过去，教师只需微调
    setHw((prev) => ({
      ...prev,
      submit_mode: aiDraftMode,
      rubric: aiDraft.rubric || prev.rubric,
      allowed_exts: aiDraft.allowed_exts ?? prev.allowed_exts,
    }))
    setAiDraftOpen(false)
    setCreateModal(true)
  }

  const asSteps = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
  const guideSteps = asSteps(t(isStudent ? 'guide.studentSteps' : 'guide.teacherSteps', { returnObjects: true }))

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

  // 文件作业（file/mixed）与对话作业在抽屉里走两套界面
  const isFileTask = (t0?: string) => !!t0 && t0 !== 'conversation'

  // ── 列定义 ──
  const studentStatusColumn = {
    title: t('myStatus'), key: 'myStatus', width: 120,
    render: (_: any, record: TaskInfo) => {
      const submitted = record.submissions?.includes(username)
      const mode = record.submit_mode && record.submit_mode !== 'conversation'
      return (
        <Space size={4} wrap>
          <Tag color={submitted ? 'success' : 'default'}>
            {submitted ? t('hwSubmittedShort') : t('notSubmitted')}
          </Tag>
          {/* 文件作业批完默认待复核，学生先看到"批改中"而不是空白 */}
          {submitted && mode && record.publish_status !== 'published' && (
            <Tag color="processing">{t('hwGradingSoon')}</Tag>
          )}
        </Space>
      )
    },
  }

  const columns = [
    {
      title: t('taskName'), dataIndex: 'name', key: 'name', width: 210,
      render: (name: string, r: TaskInfo) => (
        <Space size={4} wrap>
          <span>{name}</span>
          {/* 一眼分清交文件还是交对话记录（老作业没有该字段时按对话作业显示） */}
          {isFileTask(r.submit_mode) ? (
            <Tag color="purple" style={{ marginInlineEnd: 0 }}>
              {r.submit_mode === 'mixed' ? t('hwModeMixed') : t('hwModeFile')}
            </Tag>
          ) : (
            <Tag style={{ marginInlineEnd: 0 }}>{t('hwModeConversation')}</Tag>
          )}
        </Space>
      ),
    },
    // 科目：创建作业时选的（tasks.subject），列表以前没展示
    { title: t('subject'), dataIndex: 'subject', key: 'subject', width: 90,
      render: (v: string) => v || '-' },
    {
      title: t('taskDescription'), dataIndex: 'description', key: 'description', width: 230,
      render: (d: string) => d ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
          <Typography.Paragraph
            ellipsis={{ rows: 2 }}
            style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', flex: 1, minWidth: 0 }}
            title={d.length > 60 ? undefined : d}
          >
            {d}
          </Typography.Paragraph>
          <Tooltip title={t('viewRequirement')}>
            <Button size="small" type="text" icon={<ExpandAltOutlined />}
              style={{ flex: 'none' }} onClick={() => setReqModal(d)}
            />
          </Tooltip>
        </div>
      ) : <Typography.Text type="secondary" style={{ fontSize: 12 }}>--</Typography.Text>,
    },
    { title: t('taskCreator'), dataIndex: 'creator', key: 'creator', width: 80 },
    { title: t('gradeClass'), key: 'scope', width: 160,
      render: (_: any, r: any) => (
        <ScopeTag scope={r.target_scope} grade={r.target_grade} classes={r.target_class} users={r.target_users} />
      ),
    },
    {
      title: t('status'), dataIndex: 'status', key: 'status', width: 70,
      render: (s: string) => (
        <Tag color={s === 'active' ? 'green' : 'default'}>
          {s === 'active' ? t('inProgress') : t('ended')}
        </Tag>
      ),
    },
    { title: t('createdTime'), dataIndex: 'created_time', key: 'created_time', width: 160 },
    {
      title: t('hwDeadline'), key: 'deadline', width: 150,
      render: (_: any, r: TaskInfo) => {
        if (!r.deadline_at) return <Typography.Text type="secondary">-</Typography.Text>
        const passed = new Date(r.deadline_at.replace(' ', 'T')).getTime() < Date.now()
        return (
          <Space size={4}>
            <Typography.Text style={{ fontSize: 12 }} type={passed ? 'danger' : undefined}>{r.deadline_at}</Typography.Text>
            {passed && <Tag color="red">{t('hwClosed')}</Tag>}
          </Space>
        )
      },
    },
    ...(isStudent
      ? [studentStatusColumn]
      : [{
          title: t('submittedCount'), key: 'submissions', width: 156,
          render: (_: any, record: TaskInfo) => {
            const names = (record as any).submissions_names || []
            const count = record.submissions?.length || 0
            if (count === 0) return <Typography.Text type="secondary">{t('zeroPeople')}</Typography.Text>
            const pending = record.pending_grade_count ?? 0
            return (
              <Space size={4}>
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
              {pending > 0 && (
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('pendingGradeTag', { n: pending })}</Tag>
              )}
              </Space>
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
                onClick={() => {
                  setSelectedTask(record)
                  // 交文件与交对话记录是两套表单，按作业形态分流
                  if (record.submit_mode && record.submit_mode !== 'conversation') setFileSubmitOpen(true)
                  else setSubmitModal(true)
                }}
              >{isMobile ? t('submitAction') : null}</Button>
            </Tooltip>
          )}
          {isStudent && record.submissions?.includes(username) && (
            <Tooltip title={t('scoreAction')}>
              <Button size="small" icon={<BarChartOutlined />}
                onClick={() => handleViewMyGrade(record)}
              >{isMobile ? t('scoreAction') : null}</Button>
            </Tooltip>
          )}
          {isAdminOrTeacher && (
            <Tooltip title={t('details')}>
              <Button size="small" icon={<EyeOutlined />}
                onClick={() => handleViewSubmissions(record)}
              />
            </Tooltip>
          )}
          {/* 编辑：名称/要求/学科（老作业的科目也在这里补） */}
          {isAdminOrTeacher && (
            <Tooltip title={t('edit')}>
              <Button size="small" icon={<EditOutlined />}
                onClick={() => {
                  setEditingTaskId(record.id)
                  setTaskName(record.name || '')
                  setTaskDesc(record.description || '')
                  setTaskSubject(record.subject || '')
                  setHw(homeworkFromTask(record))
                  setCreateModal(true)
                }}
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
            <ResetActivityButton activityType="task" activityId={record.id}
              iconOnly stopPropagation onSuccess={loadTasks} />
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

  // 窄屏卡片：把「作业名称」提到首位当卡片标题，其余列依次成行
  const cardColumns = (() => {
    const i = columns.findIndex((c: any) => c.key === 'name')
    return i > 0 ? [columns[i], ...columns.slice(0, i), ...columns.slice(i + 1)] : columns
  })()

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 12 }} wrap>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('taskManagement')}</Typography.Title>
          <Button size="small" type="text" icon={<QuestionCircleOutlined />} onClick={() => setGuideOpen(true)}>
            {t('guide.showTip')}
          </Button>
          {isAdminOrTeacher && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
              {t('createTask')}
            </Button>
          )}
          {isAdminOrTeacher && (
            <Button icon={<BulbOutlined />} onClick={openAiDraft}>{t('aiCreateTask')}</Button>
          )}
          <Button icon={<ReloadOutlined />} onClick={loadTasks}>{t('refresh')}</Button>
          {isAdminOrTeacher && (
            <Checkbox checked={pendingOnly} onChange={(e) => setPendingFilter(e.target.checked)}>
              {t('pendingGradeFilter')}
            </Checkbox>
          )}
        </Space>

        <Spin spinning={loading}>
          {isMobile && isStudent ? (
            /* 窄屏：作业列表改卡片，「提交」按钮不必横向滚动才能点到（教师端保持表格） */
            <MobileCardTable
              dataSource={visibleTasks.slice((mPage - 1) * MOBILE_CARD_PAGE, mPage * MOBILE_CARD_PAGE)}
              columns={cardColumns}
              rowKey="id"
              pagination={{ current: mPage, pageSize: MOBILE_CARD_PAGE, total: visibleTasks.length, onChange: setMPage }}
              emptyText={<Empty description={t('noActiveTasks')} />}
            />
          ) : (
            <Table className="nowrap-cells-table"
              dataSource={visibleTasks}
              columns={columns}
              rowKey="id"
              pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('totalTasks', { count: total }), pageSizeOptions: ['10', '20', '50'] }}
              size="small"
              locale={{ emptyText: t('noActiveTasks') }}
            />
          )}
        </Spin>
      </Card>

      {/* 创建任务弹窗 */}
      <Modal maskClosable={false}
        title={editingTaskId ? t('edit') : t('createNewTask')}
        open={createModal}
        onOk={handleCreate}
        onCancel={() => {
          setCreateModal(false); setEditingTaskId(null)
          setTaskName(''); setTaskDesc('')
          setTaskSubject(subjectOptions[0] || '')
          setTaskScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
          setHw(emptyHomework())
        }}
        okText={editingTaskId ? t('save') : t('createTask')} cancelText={t('cancel')}
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
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
          {t('taskDescHint')}
        </Typography.Text>
        {/* 提交方式放在要求下面：教师第一眼就能看到「交文件」这个新形态 */}
        <HomeworkForm
          value={hw}
          onChange={setHw}
          modeLocked={!!editingTaskId}
        />
        {/* 学科：落库后作业列表与活动监控的"科目"列才显示得出来 */}
        <div style={{ marginTop: 12 }}>
          <Select
            value={taskSubject || undefined}
            onChange={setTaskSubject}
            style={{ width: 160 }}
            placeholder={t('subject')}
            options={subjectOptions.map(s => ({ value: s, label: s }))}
          />
        </div>
        {/* 目标范围只在新建时可选：改它会影响已发布作业的可见范围，编辑模式隐藏 */}
        {!editingTaskId && (
          <div style={{ marginTop: 16 }}>
            <ActivityScopeSelector value={taskScope} onChange={setTaskScope} />
          </div>
        )}
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
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('taskDescLabel')}</Typography.Text>
              <div className="markdown-content requirement-box">
                <FormulaRenderer content={selectedTask.description} breaks />
              </div>
            </div>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('totalMessagesCount', { count: messages.length })}
          </Typography.Text>
        </Space>
      </Modal>

      {/* 文件作业：学生上传弹窗（对话作业仍走上面的确认弹窗） */}
      {selectedTask && isFileTask(selectedTask.submit_mode) && (
        <HomeworkSubmitModal
          task={selectedTask}
          open={fileSubmitOpen}
          onClose={() => { setFileSubmitOpen(false); setSelectedTask(null) }}
          onSubmitted={() => { loadTasks() }}
        />
      )}

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
            {viewTask && !isFileTask(viewTask.submit_mode) && submissionsData.submissions.length > 0 && (
              <Button size="small" icon={<RobotOutlined />}
                loading={aiGradingTaskId === viewTask.id}
                onClick={() => handleAiGrade(viewTask.id)}
              >{Object.keys(gradesMap).length > 0 ? t('regrade') : t('aiGradeAction')}</Button>
            )}
          </Space>

          {viewTask?.description && (
            <Collapse size="small" style={{ marginBottom: 12 }}
              items={[{
                key: 'requirement',
                label: (
                  <Space size={6}>
                    <Typography.Text style={{ fontSize: 13 }}>{t('requirementCollapseTitle')}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('charCount', { count: (viewTask.description || '').length })}
                    </Typography.Text>
                  </Space>
                ),
                children: (
                  <div className="markdown-content requirement-box" style={{ maxHeight: 280 }}>
                    <FormulaRenderer content={viewTask.description} breaks />
                  </div>
                ),
              }]}
            />
          )}

          {viewTask && !viewTask.description && (
            <Alert type="warning" showIcon style={{ marginBottom: 16 }}
              title={t('noRequirementWarning')}
            />
          )}

          {viewTask && isFileTask(viewTask.submit_mode) && (
            <HomeworkBoard
              task={viewTask}
              roster={submissionsData.submissions.map((x) => ({ username: x.username, name: x.name }))}
              onChanged={loadTasks}
            />
          )}

          {!isFileTask(viewTask?.submit_mode) && classSummary && (
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
                {classSummary.overall_comment && (
                  <Typography.Paragraph style={{ fontSize: 13, margin: '4px 0', color: 'var(--text-secondary)' }}>
                    💡 {classSummary.overall_comment}
                  </Typography.Paragraph>
                )}
                {(classSummary.requirement_review?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <Typography.Text style={{ fontSize: 12, fontWeight: 600, color: '#1d39c4' }}>
                      {t('requirementReviewTitle')}
                    </Typography.Text>
                    {classSummary.requirement_review!.map((rr, i) => (
                      <div key={i} style={{ fontSize: 12, marginTop: 2, paddingLeft: 4 }}>
                        • {rr.item}
                        {rr.class_status && (
                          <Tag color={reviewColor(rr.class_status)}
                            style={{ marginInlineStart: 6, marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>
                            {rr.class_status}
                          </Tag>
                        )}
                        {rr.note && (
                          <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 6 }}>{rr.note}</Typography.Text>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {classSummary.teaching_suggestions && (
                  <Typography.Paragraph style={{ fontSize: 13, margin: 0, color: '#1d39c4', background: '#f0f5ff', padding: '4px 8px', borderRadius: 4 }}>
                    {t('teachingSuggestions')}{classSummary.teaching_suggestions}
                  </Typography.Paragraph>
                )}
              </Space>
            </Card>
          )}

          {isFileTask(viewTask?.submit_mode) ? null : submissionsData.submissions.length === 0 ? (
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
                    return { ...s, gradeInfo: g, level, key: s.username }  // grade 保留后端年级字符串, 勿覆盖(否则 studentLabel 渲染 [object Object])
                  })
                  return list.sort((a, b) => {
                    if (a.gradeInfo && b.gradeInfo) return b.gradeInfo.score - a.gradeInfo.score
                    if (a.gradeInfo) return -1
                    if (b.gradeInfo) return 1
                    return 0
                  })
                })()}
                expandable={{
                  expandedRowRender: (r: any) => {
                    if (!r.gradeInfo) return <Typography.Text type="secondary">{t('noGradeData')}</Typography.Text>
                    return (
                      <div style={{ padding: '8px 0 4px 0' }}>
                        {renderCriteria(r.gradeInfo.criteria)}
                        <Typography.Paragraph style={{ fontSize: 13, margin: '0 0 8px 0', color: 'var(--text-secondary)' }}>
                          💬 {r.gradeInfo.comment}
                        </Typography.Paragraph>
                        {r.gradeInfo.strengths?.length > 0 && (
                          <div style={{ marginBottom: 6 }}>
                            <Typography.Text style={{ fontSize: 12, color: '#52c41a' }}>
                              {t('strengths')}{r.gradeInfo.strengths.join('、')}
                            </Typography.Text>
                          </div>
                        )}
                        {r.gradeInfo.weaknesses?.length > 0 && (
                          <div style={{ marginBottom: 6 }}>
                            <Typography.Text style={{ fontSize: 12, color: '#ff4d4f' }}>
                              {t('weaknesses')}{r.gradeInfo.weaknesses.join('、')}
                            </Typography.Text>
                          </div>
                        )}
                        {r.gradeInfo.feedback && (
                          <div style={{ padding: '6px 8px', background: '#f0f5ff', borderRadius: 4, marginTop: 4 }}>
                            <Typography.Text style={{ fontSize: 12, color: '#1d39c4' }}>
                              {t('suggestions')}{r.gradeInfo.feedback}
                            </Typography.Text>
                          </div>
                        )}
                        {r.gradeInfo.graded_at && (
                          <div style={{ marginTop: 6 }}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {t('gradedAt')}{r.gradeInfo.graded_at}
                            </Typography.Text>
                          </div>
                        )}
                      </div>
                    )
                  },
                  rowExpandable: (r: any) => !!r.gradeInfo,
                }}
                columns={[
                  {
                    title: '#', key: 'index', width: 36,
                    render: (_: any, __: any, i: number) => i + 1,
                  },
                  {
                    title: t('student'), key: 'student', width: 168,
                    render: (_: any, r: any) => (
                      <Typography.Text strong style={{ fontSize: 12 }}>{studentLabel(r)}</Typography.Text>
                    ),
                  },
                  {
                    title: t('scoreGrade'), key: 'score', width: 110,
                    render: (_: any, r: any) => r.gradeInfo ? (
                      <Space align="center" size={2}>
                        <Typography.Text strong style={{ fontSize: 14, color: '#52c41a', minWidth: 24 }}>
                          {r.gradeInfo.score}
                        </Typography.Text>
                        <Tag color={r.level.color} style={{ margin: 0, fontSize: 11, lineHeight: '16px', padding: '0 4px' }}>{r.level.label}</Tag>
                      </Space>
                    ) : <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('pendingGrading')}</Typography.Text>,
                  },
                  {
                    title: t('actions'), key: 'action', width: 96,
                    render: (_: any, r: any) => (
                      <Space size={2}>
                        {viewTask && (
                          <Tooltip title={r.gradeInfo ? t('aiRegradeStudentTooltip') : t('aiGradeStudentTooltip')}>
                            <Button size="small" type="text" icon={<RobotOutlined />}
                              loading={aiGradingStudent === r.username}
                              onClick={() => handleAiGradeStudent(viewTask.id, r.username, studentLabel(r))}
                            />
                          </Tooltip>
                        )}
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
              <FormulaRenderer content={studentContent || t('noContent')} />
            </div>
          </Spin>
        </Drawer>
      </Drawer>

      <style>{`
        .requirement-box { max-height: 320px; overflow: auto; padding: 8px 10px; background: var(--bg-layout, #fafafa); border: 1px solid var(--border-color, #f0f0f0); border-radius: 4px; }
        .requirement-box ol, .requirement-box ul { margin: 4px 0; padding-left: 20px; }
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
                    <Typography.Text style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                      {myGrade.comment}
                    </Typography.Text>
                  </div>
                </Space>
              </Card>

              {renderCriteria(myGrade.criteria)}

              {/* 文件作业的维度分与迟交标记（对话作业没有这两项，自动不显示） */}
              {myGrade.dim_scores && Object.keys(myGrade.dim_scores).length > 0 && (
                <Space wrap size={4}>
                  {Object.entries(myGrade.dim_scores).map(([k, v]) => (
                    <Tag key={k}>{k} {Number(v)}</Tag>
                  ))}
                </Space>
              )}
              {myGrade.late_submitted && <Tag color="volcano">{t('hwLate')}</Tag>}

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

      {/* 使用说明：点标题旁「使用说明」弹出，学生端与教师端各自一套步骤 */}
      <Modal
        title={<Space><QuestionCircleOutlined />{isStudent ? t('guide.studentTitle') : t('guide.teacherTitle')}</Space>}
        open={guideOpen}
        onCancel={() => setGuideOpen(false)}
        footer={<Button type="primary" onClick={() => setGuideOpen(false)}>{t('gotIt')}</Button>}
        width={640}
      >
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text style={{ fontSize: 13 }}>
            {isStudent ? t('guide.studentIntro') : t('guide.teacherIntro')}
          </Typography.Text>
          <div className="requirement-box">
            {guideSteps.map((step, i) => (
              <Typography.Paragraph key={i} style={{ fontSize: 13, margin: '4px 0' }}>{i + 1}. {step}</Typography.Paragraph>
            ))}
          </div>
        </Space>
      </Modal>

      {/* AI 起草作业：先出草稿，教师确认后填入创建表单 */}
      <Modal
        maskClosable={false}
        title={<Space><BulbOutlined />{t('aiCreateTitle')}</Space>}
        open={aiDraftOpen}
        onCancel={() => setAiDraftOpen(false)}
        width={700}
        footer={
          <Space wrap>
            <Button onClick={() => setAiDraftOpen(false)}>{t('cancel')}</Button>
            <Button loading={aiDraftLoading} onClick={handleAiDraft}>
              {aiDraft ? t('aiRegenerate') : t('aiGenerate')}
            </Button>
            <Button type="primary" disabled={!aiDraft || aiDraftLoading} onClick={useAiDraft}>
              {t('aiDraftUse')}
            </Button>
          </Space>
        }
      >
        <Spin spinning={aiDraftLoading} tip={t('aiDraftLoading')}>
          <Space orientation="vertical" size={10} style={{ width: '100%' }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('aiDraftModeLabel')}</Typography.Text>
              <Radio.Group
                style={{ display: 'block', marginTop: 4 }}
                value={aiDraftMode}
                onChange={(e) => { setAiDraftMode(e.target.value); setAiDraft(null) }}
                optionType="button"
                options={[
                  { value: 'conversation', label: t('hwModeConversation') },
                  { value: 'file', label: t('hwModeFile') },
                  { value: 'mixed', label: t('hwModeMixed') },
                ]}
              />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('aiCreateIntro')}</Typography.Text>
            <Input.TextArea
              rows={3}
              placeholder={t('aiIdeaPlaceholder')}
              value={aiIdea}
              onChange={(e) => setAiIdea(e.target.value)}
              maxLength={500}
              showCount
            />
            <Space wrap size={8}>
              <Typography.Text style={{ fontSize: 13 }}>{t('aiDurationLabel')}</Typography.Text>
              <Select
                size="small"
                style={{ width: 120 }}
                value={aiDuration}
                onChange={(v: string) => setAiDuration(v)}
                options={[
                  { value: '', label: t('aiDurationFree') },
                  { value: '10', label: t('aiDuration10') },
                  { value: '20', label: t('aiDuration20') },
                  { value: '40', label: t('aiDuration40') },
                ]}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('aiAudienceHint')}</Typography.Text>
            </Space>
            {aiDraft && (
              <Card
                size="small"
                title={t('aiDraftPreview')}
                style={{ background: '#f6ffed', borderColor: '#b7eb8f' }}
              >
                <Space orientation="vertical" size={6} style={{ width: '100%' }}>
                  <Typography.Text strong>{aiDraft.name}</Typography.Text>
                  <div className="markdown-content requirement-box">
                    <FormulaRenderer content={aiDraft.description} breaks />
                  </div>
                  {(aiDraft.dims?.length ?? 0) > 0 && (
                    <Space wrap size={4}>
                      {aiDraft.dims!.map((d, i) => (
                        <Tag key={i} color="purple">{d.name} {d.max}</Tag>
                      ))}
                    </Space>
                  )}
                  {aiDraft.allowed_exts && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('hwAllowedTypes')}: {aiDraft.allowed_exts}
                    </Typography.Text>
                  )}
                  {aiDraft.tips && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>💡 {aiDraft.tips}</Typography.Text>
                  )}
                </Space>
              </Card>
            )}
          </Space>
        </Spin>
      </Modal>

      {/* 作业要求全文：列表只显示两行，长文在这里完整看 */}
      <Modal
        title={t('requirementModalTitle')}
        open={!!reqModal}
        onCancel={() => setReqModal(null)}
        footer={<Button onClick={() => setReqModal(null)}>{t('close')}</Button>}
        width={640}
      >
        <div className="markdown-content requirement-box" style={{ maxHeight: 460 }}>
          {/* breaks：教师与 AI 写的要求里大量用单个换行分段，不转硬换行就会糊成一段 */}
          <FormulaRenderer content={reqModal || ''} breaks />
        </div>
      </Modal>
    </div>
  )
}

export default TaskPage
