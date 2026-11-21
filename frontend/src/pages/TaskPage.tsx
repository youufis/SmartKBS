import { studentLabel } from '../utils/studentLabel'
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Card, Table, Button, Modal, Input, Tag, Space, Checkbox, Alert, Radio, Typography, Spin, Popconfirm, Popover, Tooltip, Collapse, Select, Empty, Dropdown } from 'antd'
import { message, modalApi } from '../utils/feedback'
import {
  PlusOutlined, SendOutlined, ReloadOutlined, DeleteOutlined,
  CheckCircleOutlined, EyeOutlined, UndoOutlined,
  RobotOutlined, BarChartOutlined, QuestionCircleOutlined, BulbOutlined, ExpandAltOutlined,
  EditOutlined, MoreOutlined, DownloadOutlined, CopyOutlined, NotificationOutlined,
} from '@ant-design/icons'
import * as tasksApi from '../api/tasks'
import ListFilterBar from '../components/ListFilterBar'
import PageHeader from '../components/PageHeader'
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
import {
  emptyHomework, homeworkFromTask, startAndPollFileGrading,
  type HomeworkValue,
} from './task/homeworkModel'
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
  // 列表查找/分类：关键词（名称/要求）+ 状态（进行中/已结束）+ 学科
  const [taskKw, setTaskKw] = useState('')
  const [taskFilter, setTaskFilter] = useState('all')
  const [taskSubjectFilter, setTaskSubjectFilter] = useState('')
  // 三态：进行中 / 已截止 / 已结束（P1-4）。"已截止"是后端按服务器时间算出来的派生态，
  // 不改变 status 的含义 —— 教师仍然可以随时点「结束」，截止也不会把补批改与改分的窗口关掉
  const taskStatusOf = (x: any): 'active' | 'expired' | 'ended' => (
    x?.effective_status
    || (x?.status === 'active' ? (x?.expired ? 'expired' : 'active') : 'ended'))

  const taskMatched = useMemo(() => {
    const base = pendingOnly && !isStudent
      ? tasks.filter((x) => (x.pending_grade_count ?? 0) > 0)
      : tasks
    const k = taskKw.trim().toLowerCase()
    return base.filter((x) => {
      if (taskSubjectFilter && String(x.subject || '').trim() !== taskSubjectFilter) return false
      if (!k) return true
      return `${x.name || ''} ${x.description || ''} ${x.creator || ''}`.toLowerCase().includes(k)
    })
  }, [tasks, pendingOnly, isStudent, taskKw, taskSubjectFilter])
  const taskStatusCount = useMemo(() => ({
    active: taskMatched.filter((x) => taskStatusOf(x) === 'active').length,
    expired: taskMatched.filter((x) => taskStatusOf(x) === 'expired').length,
    ended: taskMatched.filter((x) => taskStatusOf(x) === 'ended').length,
  }), [taskMatched])
  const visibleTasks = taskFilter === 'all'
    ? taskMatched
    : taskMatched.filter((x) => taskStatusOf(x) === taskFilter)
  const [loading, setLoading] = useState(false)
  const MOBILE_CARD_PAGE = 8            // 窄屏卡片列表每页条数
  const [mPage, setMPage] = useState(1)
  const [createModal, setCreateModal] = useState(false)
  const [taskName, setTaskName] = useState('')
  const [taskDesc, setTaskDesc] = useState('')
  // 学科：与其它活动一致（默认取系统配置的第一个），落库后列表/活动监控才显示学科
  const [taskSubject, setTaskSubject] = useState('')
  // 正在编辑的作业 id（null = 新建）：同一个弹窗两用
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  // 提交方式只在"已有学生提交"后锁死（与后端同一条判据，P0-4）；
  // 以前编辑态无条件锁，选错形态又没人交过，就只能删了重建
  const [editModeLocked, setEditModeLocked] = useState(false)
  // 复制模式下的源作业 id：非空时"确定"走 /duplicate，范围选择器一定可编辑
  const [copySourceId, setCopySourceId] = useState<string | null>(null)
  const { subjects: subjectOptions } = useSubjectOptions()
  // 学科清单到位后补默认值（留空太容易漏填，作业就没有学科了）
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
  const [submissionsModal, setSubmissionsModal] = useState(false)
  const [submissionsData, setSubmissionsData] = useState<{
    task_name: string; task_status: string; submissions: tasksApi.TaskSubmission[]; count: number;
    expected_count?: number
  }>({ task_name: '', task_status: '', submissions: [], count: 0, expected_count: 0 })
  const [submissionsLoading, setSubmissionsLoading] = useState(false)
  const [viewTask, setViewTask] = useState<TaskInfo | null>(null)
  // 深链 ?open=<作业id> 只处理一次（列表是异步来的，effect 会跑到第二遍）
  const deepLinkOpened = useRef(false)


  // 查看学生提交内容
  const [contentModal, setContentModal] = useState(false)
  const [studentContent, setStudentContent] = useState('')
  const [contentLoading, setContentLoading] = useState(false)

  // AI 批改：两种形态统一走后台任务，这里只记"哪份作业 / 哪个人"正在跑
  // （键为 task.id，单人重批为 task.id:student）
  const [gradingJobKey, setGradingJobKey] = useState<string | null>(null)
  // 应交名单按需取（列表气泡点开才查），不在 /active 里逐作业算范围
  const [rosterMap, setRosterMap] = useState<Record<string, tasksApi.TaskRoster>>({})
  const [rosterBusy, setRosterBusy] = useState<string>('')
  const [remindingTaskId, setRemindingTaskId] = useState<string | null>(null)
  // 对话作业的「通知成绩」进行中
  const [notifyingGrades, setNotifyingGrades] = useState(false)
  // 批改结果与全班总结必须自带"我属于哪份作业"。详情弹窗复用同一个组件实例，
  // 以前两个 state 是页面级裸值，配上"有数据才覆盖"的写法，换一份没有批改记录的作业
  // 打开，屏幕上仍是上一份的成绩与总结 —— 出现「已提交 0 / 已批改 2 / 总结人数 2」
  // 这种三个数字互相打架的画面（线上实测）。归属写进 state，不匹配的回包一律丢掉。
  const [grading, setGrading] = useState<{
    taskId: string
    map: Record<string, tasksApi.AIGradeResult>
    summary: tasksApi.AIClassSummary | null
  }>({ taskId: '', map: {}, summary: null })
  const gradesMap = grading.map
  const classSummary = grading.summary

  /** 认领某份作业的批改数据：先清空再写；回包只允许落在仍然归属它的窗口里 */
  const claimGrading = (taskId: string) => setGrading({ taskId, map: {}, summary: null })
  const applyGrading = (taskId: string, map: Record<string, tasksApi.AIGradeResult>,
    summary: tasksApi.AIClassSummary | null) =>
    setGrading((cur) => (cur.taskId === taskId ? { taskId, map, summary } : cur))
  const [gradesLoading, setGradesLoading] = useState(false)


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
      if (copySourceId) {
        // 复制：范围由教师在这里重选，提交与成绩一律不带过来
        const res = await tasksApi.duplicateTask({
          task_id: copySourceId, name: taskName.trim(),
          ...taskScope,
        })
        message.success(res.message)
        setCreateModal(false)
        setCopySourceId(null)
        setTaskName(''); setTaskDesc('')
        setTaskScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
        loadTasks()
        return
      }
      if (editingTaskId) {
        const res = await tasksApi.updateTask(editingTaskId, {
          name: taskName.trim(), description: taskDesc.trim(), subject: taskSubject,
          // 截止/限额/维度随时可改；提交方式与目标范围由后端在"已有提交"时锁死
          ...(editModeLocked ? {} : taskScope),
          ...hw,
        })
        message.success(res.message)
        setCreateModal(false)
        setEditingTaskId(null)
        setTaskName(''); setTaskDesc('')
        loadTasks()
        return
      }
      // 对话作业同样下发截止/总分/迟交等字段（P1-3）。以前 conversation 一律传 undefined，
      // 后端拿到的永远是默认值 —— 表单开放了也白搭，截止填了也不落库
      const res = await tasksApi.createTask(taskName.trim(), taskDesc.trim(), taskScope, taskSubject, hw)
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

  /** 复制作业：把源作业的要求与批改参数灌进新建表单，范围由教师重选 */
  const openCopy = (record: TaskInfo) => {
    setCopySourceId(record.id)
    setEditingTaskId(null)
    setTaskName((record.name + '-副本').slice(0, 60))
    setTaskDesc(record.description || '')
    setTaskSubject(record.subject || '')
    setHw(homeworkFromTask(record))
    setTaskScope({
      target_scope: (record.target_scope || 'teacher_classes') as ActivityScopeValue['target_scope'],
      target_grade: record.target_grade || '',
      target_class: record.target_class || '',
      target_users: record.target_users || '',
    })
    setCreateModal(true)
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

  // ── 编辑作业 ──
  const openEdit = (record: TaskInfo) => {
    setEditingTaskId(record.id)
    setTaskName(record.name || '')
    setTaskDesc(record.description || '')
    setTaskSubject(record.subject || '')
    setHw(homeworkFromTask(record))
    // 范围现在可能在编辑态出现，必须先把当前范围灌进去：
    // 否则显示的是默认"我任教班级"，教师点保存就等于偷偷改了可见范围
    setTaskScope({
      target_scope: (record.target_scope || 'teacher_classes') as ActivityScopeValue['target_scope'],
      target_grade: record.target_grade || '',
      target_class: record.target_class || '',
      target_users: record.target_users || '',
    })
    // 提交方式与目标范围都只在已有提交后锁死（P0-4，与后端同一条判据）
    setEditModeLocked(!!(record.submissions?.length ?? 0))
    setCreateModal(true)
  }

  /**
   * 「更多」菜单里的动作。结束与删除用确认弹窗 —— 下拉一收，Popconfirm 就跟着没了，
   * 原来那种"图标 + Popconfirm"的写法在菜单里根本弹不出来。
   */
  const handleRowAction = (key: string, record: TaskInfo) => {
    if (key === 'edit') { openEdit(record); return }
    if (key === 'copy') { openCopy(record); return }
    if (key === 'export') {
      // 复用既有导出端点（/api/export/tasks 支持 task_id，且校验归属）
      window.open('/api/export/tasks?task_id=' + encodeURIComponent(record.id), '_blank')
      return
    }
    if (key === 'end') {
      modalApi.confirm({
        title: t('confirmEndTitle', { name: record.name }),
        content: t('confirmEndDesc'),
        okText: t('confirmEndOk'), cancelText: t('cancel'),
        onOk: () => handleEnd(record.id),
      })
      return
    }
    if (key === 'delete') {
      modalApi.confirm({
        title: t('confirmDeleteTitle', { name: record.name }),
        content: t('taskDeleteConfirmDesc'),
        okText: t('confirmDeleteOk'), cancelText: t('cancel'),
        okButtonProps: { danger: true },
        onOk: () => handleDelete(record.id),
      })
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
    setContentModal(true)
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

  /**
   * AI 批改：两种形态一律走后台批改任务（P0-1 + P1-3）。
   *
   * 以前这里分三条路：列表按钮不分形态一律打 /ai-grade（文件作业必然「汇总文件未找到」404）、
   * 抽屉里对话作业走同步长请求（一个班几十段对话很容易超过请求等待上限，中途断连还得
   * 整个重烧一遍 token）、批改台才是后台任务。现在统一一条：起任务 → 轮询进度 → 重取成绩与名单。
   */
  const runGradeJob = async (task: TaskInfo, student?: string, label?: string) => {
    setGradingJobKey(student ? `${task.id}:${student}` : task.id)
    // 同一条 toast 反复更新（antd 的 key 语义），批完全班不会刷出一屏提示
    const key = 'task-grading-job'
    message.loading({ content: t('hwJobStarted'), key, duration: 0 })
    try {
      const res = await startAndPollFileGrading(task.id, student,
        (phase) => message.loading({ content: phase, key, duration: 0 }))
      message.destroy(key)
      message.success(res.message || (student
        ? t('aiGradeStudentSuccess', { name: label || student })
        : t('hwJobDone')))
      if (res.similarity_pairs?.length) message.warning(t('hwSimFound', { n: res.similarity_pairs.length }))
      if (res.needs_review_students?.length)
        message.warning(t('hwAiMissed', { n: res.needs_review_students.length }))
      // 抽屉开着就重新拉一次成绩与全班总结：两种形态的批改回包形状不同，
      // 统一"重取"比在前端拼三种回包更不容易出错
      if (viewTask?.id === task.id) void loadGrades(task.id)
      loadTasks()
    } catch (err: any) {
      message.destroy(key)
      if (err?.aiTaskTimeout) message.warning(t('hwJobTimeout'))
      else message.error(err?.response?.data?.detail || err?.message || t('hwJobFailed'))
    } finally {
      setGradingJobKey(null)
    }
  }

  /**
   * 对话作业的「通知成绩」：发通知 + 补发等级奖。
   *
   * 拍板③把发奖时机统一放进这个动作，可按钮此前只存在于文件作业的批改台里 ——
   * 对话作业批完既没人收到通知，`award_grade` 也永远轮不到它发。
   * 分数本身批完就能看（可见性已统一），这里补的是"告诉学生去查"那一步。
   */
  const notifyConversationGrades = async () => {
    if (!viewTask) return
    setNotifyingGrades(true)
    try {
      const res = await tasksApi.publishGrades(viewTask.id)
      message[res.notified ? 'success' : 'warning']({
        content: res.message, key: 'task-notify-grades', duration: 5,
      })
      loadTasks()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('hwPublishFailed'))
    } finally {
      setNotifyingGrades(false)
    }
  }

  /** 应交名单：点开气泡才取，同一作业缓存一份 */
  const loadRoster = async (taskId: string) => {
    if (rosterMap[taskId]) return
    setRosterBusy(taskId)
    try {
      const r0 = await tasksApi.getTaskRoster(taskId)
      setRosterMap((prev) => ({ ...prev, [taskId]: r0 }))
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('loadDetailFailed'))
    } finally {
      setRosterBusy('')
    }
  }

  /** 一键催交（照搬练习侧的「提醒未提交」）：提醒完把名单缓存清掉，下次点开重新算 */
  const handleRemind = async (taskId: string) => {
    setRemindingTaskId(taskId)
    try {
      const res = await tasksApi.notifyUnsubmitted(taskId)
      message.success(res.message)
      setRosterMap((prev) => {
        const next = { ...prev }
        delete next[taskId]
        return next
      })
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('loadDetailFailed'))
    } finally {
      setRemindingTaskId(null)
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

  /**
   * 加载某份作业的批改结果与全班总结。
   *
   * 原来两个赋值都写成"有数据才覆盖"（成绩那份甚至写在 grades.length > 0 里面），于是换一份
   * 还没有批改记录的作业打开，屏幕上仍是上一份的成绩与总结 —— 教师看到的是
   * 「已提交 0 / 已批改 2 / 总结人数 2」这种自相矛盾的画面，只会以为系统算错了。
   * 现在：先清空 → 再无条件覆盖 → 并且只接受当前作业的响应（点得快时旧请求可能后到）。
   */
  const loadGrades = async (taskId: string) => {
    setGradesLoading(true)
    claimGrading(taskId)
    try {
      const res = await tasksApi.getTaskGrades(taskId)
      const map: Record<string, tasksApi.AIGradeResult> = {}
      ;(res.grades || []).forEach(g => { map[g.student] = g })
      // 空结果也照样覆盖：不覆盖的就是上一份作业的残留
      applyGrading(taskId, map, res.summary || null)
    } catch {
      // 没有批改结果是正常状态：保持清空后的样子，不把上一份的残留留给这一份
      applyGrading(taskId, {}, null)
    } finally {
      setGradesLoading(false)
    }
  }

  /**
   * 关闭详情：连带把这份作业的批改残留清掉。
   *
   * 批改结果与全班总结是页面级 state，不清的话下一份作业打开时会先闪出上一份的数字。
   */
  const closeDetail = () => {
    setViewTask(null)
    setSubmissionsModal(false)
    setContentModal(false)
    setGrading({ taskId: '', map: {}, summary: null })
  }

  // ── 查看提交详情（同时加载批改结果） ──
  const handleViewSubmissions = async (task: TaskInfo) => {
    // 「绑定即授权」只读预览：他人作业绑在课程知识点里，提交/批改数据仍归创建者，
    // 不去拉 403 的提交列表，直接展示作业信息
    if ((task as any).is_owner === false) {
      modalApi.info({
        title: task.name,
        width: 520,
        content: (
          <div style={{ marginTop: 8 }}>
            <Tag color="orange" style={{ marginBottom: 8 }}>{t('boundTaskReadonly')}</Tag>
            <Typography.Paragraph type="secondary" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
              {task.description || t('boundTaskNoDesc')}
            </Typography.Paragraph>
          </div>
        ),
      })
      return
    }
    setViewTask(task)
    setSubmissionsModal(true)
    setSubmissionsLoading(true)
    // 打开新作业先认领它：上一份的批改残留到此为止（列表数据同一份口径）
    claimGrading(task.id)
    // 提交名单/应交人数也要清：弹窗是先打开再填的，不清的话加载那段时间里
    // 名单仍是上一份作业的，标题却已经换成这一份了
    setSubmissionsData({ task_name: task.name, task_status: task.status, submissions: [], count: 0, expected_count: 0 })
    try {
      const data = await tasksApi.getTaskSubmissions(task.id)
      setSubmissionsData({
        task_name: data.task_name,
        task_status: data.task_status,
        submissions: data.submissions,
        count: data.submission_count,
        expected_count: data.expected_count ?? data.submission_count,
      })
      // 同时加载批改结果
      loadGrades(task.id)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('loadDetailFailed'))
      setSubmissionsData({ task_name: '', task_status: '', submissions: [], count: 0, expected_count: 0 })
    } finally {
      setSubmissionsLoading(false)
    }
  }

  // 从课程导学「绑定资源」卡片跳进来：/tasks?open=<作业id> 直接展开这份作业。
  // 以前后端给的深链参数（?highlight=）全站没人消费，绑完点开只是跳到列表第一屏。
  useEffect(() => {
    const target = searchParams.get('open')
    if (!target || deepLinkOpened.current || !tasks.length) return
    deepLinkOpened.current = true
    const next = new URLSearchParams(searchParams)
    next.delete('open')
    setSearchParams(next, { replace: true })
    const task = tasks.find((x) => String(x.id) === target)
    if (!task) { message.warning(t('openTaskGone')); return }
    if (isStudent) {
      setSelectedTask(task)
      if (task.submit_mode && task.submit_mode !== 'conversation') setFileSubmitOpen(true)
      else setSubmitModal(true)
    } else {
      void handleViewSubmissions(task)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, tasks])

  // ── 学生查看自己的批改结果 ──
  const handleViewMyGrade = async (task: TaskInfo) => {
    setMyGradeTaskName(task.name)
    setMyGradeModal(true)
    setMyGradeLoading(true)
    // 先清掉上一份作业的分数：标题已经换成这一份，分数还是上一份的比不显示更糟
    setMyGrade(null)
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
    title: t('myStatus'), key: 'myStatus', width: 150,
    render: (_: any, record: TaskInfo) => {
      const submitted = record.submissions?.includes(username)
      // 截止与否用后端算好的 expired（P1-4）：学生本机时钟不可信
      const expired = !!record.expired
      return (
        <Space size={4} wrap>
          <Tag color={submitted ? 'success' : expired ? 'red' : 'default'}>
            {submitted ? t('hwSubmittedShort') : t('notSubmitted')}
          </Tag>
          {!submitted && expired && <Tag color="orange">{t('hwStatusExpired')}</Tag>}
          {/* 拍板口径③：两种形态一律"批完即可见"，所以这里看的是"我有没有有效分"，
              不再是教师点没点通知 —— 以前文件作业批完了学生还看不到，只能显示"批改中" */}
          {submitted && (record.my_graded
            ? <Tag color="blue">{t('hwGradeViewable')}</Tag>
            : <Tag color="processing">{t('hwGradingSoon')}</Tag>)}
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
    // 学科：创建作业时选的（tasks.subject），列表以前没展示
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
      title: t('status'), dataIndex: 'status', key: 'status', width: 90,
      render: (_s: string, r: TaskInfo) => {
        // 以前只看 status，过了截止时间仍显示"进行中"，而旁边的截止时间列自己算出
        // 一个红色"已截止" —— 同一行两列口径打架。现在统一由后端算、这里只渲染。
        const st = taskStatusOf(r)
        const color = st === 'active' ? 'green' : st === 'expired' ? 'orange' : 'default'
        const label = st === 'active' ? t('inProgress')
          : st === 'expired' ? t('hwStatusExpired') : t('ended')
        return <Tag color={color}>{label}</Tag>
      },
    },
    // 三列可排序：教师最常问的是"哪份快截止了"和"哪份交的人最少"
    { title: t('createdTime'), dataIndex: 'created_time', key: 'created_time', width: 160,
      sorter: (a: TaskInfo, b: TaskInfo) => String(a.created_time || '').localeCompare(String(b.created_time || '')),
      defaultSortOrder: 'descend' as const },
    {
      title: t('hwDeadline'), key: 'deadline', width: 150,
      // 没填截止的排最后（升序时"快截止的"就顶在最前面，不限期的不会插进来）
      sorter: (a: TaskInfo, b: TaskInfo) => {
        const x = String(a.deadline_at || ''), y = String(b.deadline_at || '')
        if (!x && !y) return 0
        if (!x) return 1
        if (!y) return -1
        return x.localeCompare(y)
      },
      render: (_: any, r: TaskInfo) => {
        if (!r.deadline_at) return <Typography.Text type="secondary">-</Typography.Text>
        // 与"状态"列共用同一个后端判据。以前这一列自己拿 Date.now() 比，
        // 于是同一行里状态列说"进行中"、截止列说"已截止" —— 两个时钟各算一遍，
        // 学生改本机时间还能让这里显示得和后端不一致。
        const passed = taskStatusOf(r) === 'expired'
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
          title: t('submittedCount'), key: 'submissions', width: 210,
          sorter: (a: TaskInfo, b: TaskInfo) => (a.submissions?.length || 0) - (b.submissions?.length || 0),
          render: (_: any, record: TaskInfo) => {
            const count = record.submissions?.length || 0
            const pending = record.pending_grade_count ?? 0
            // 批过之后学生又重交的（P0-3）：旧分不动，单独一枚标签说清"这批要重批"
            const stale = record.stale_grade_count ?? 0
            const r0 = rosterMap[record.id]
            const busy = rosterBusy === record.id
            return (
              <Space size={4}>
                <Popover
                  // 应交名单点开才取：在 /active 里逐作业算范围会把列表接口拖成新的 N+1
                  trigger="click"
                  onOpenChange={(open) => { if (open) loadRoster(record.id) }}
                  title={(
                    <Space size={6}>
                      <span>{t('rosterTitle')}</span>
                      {!!r0?.expected_count && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {t('hwExpectedShort', { n: r0.expected_count })}
                        </Typography.Text>
                      )}
                    </Space>
                  )}
                  content={(
                    <div style={{ maxWidth: 360, maxHeight: 300, overflow: 'auto' }}>
                      {!r0 ? (
                        <Typography.Text type="secondary">
                          {busy ? t('loading') : t('hwClickRosterHint')}
                        </Typography.Text>
                      ) : (
                        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                          <div>
                            <Typography.Text style={{ fontSize: 12 }} strong>
                              {t('submittedStudents')}（{r0.submitted.length}）
                            </Typography.Text>
                            {r0.submitted.length === 0 && (
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}> - </Typography.Text>
                            )}
                            {r0.submitted.map((x) => (
                              <div key={x.username} style={{ padding: '2px 0', fontSize: 12 }}>
                                {x.name || x.username}
                                {x.class_name ? `（${x.class_name}）` : ''}
                                {x.submitted_at ? ` · ${x.submitted_at.slice(5, 16)}` : ''}
                                {x.late_submitted && <Tag color="volcano" style={{ marginInlineStart: 4 }}>{t('hwLate')}</Tag>}
                                {x.stale && <Tag color="orange" style={{ marginInlineStart: 4 }}>{t('hwStaleTag')}</Tag>}
                                {!x.in_scope && <Tag style={{ marginInlineStart: 4 }}>{t('hwOutOfScope')}</Tag>}
                              </div>
                            ))}
                          </div>
                          <div>
                            <Typography.Text style={{ fontSize: 12 }} strong type="danger">
                              {t('missingStudents')}（{r0.missing.length}）
                            </Typography.Text>
                            {r0.missing.length === 0 ? (
                              <Typography.Text type="success" style={{ fontSize: 12, marginInlineStart: 6 }}>
                                {t('hwAllSubmitted')}
                              </Typography.Text>
                            ) : (
                              <div style={{ marginTop: 2 }}>
                                {r0.missing.map((x) => (
                                  <div key={x.username} style={{ padding: '2px 0', fontSize: 12 }}>
                                    {x.name || x.username}
                                    {x.class_name ? `（${x.class_name}）` : ''}
                                  </div>
                                ))}
                                <Button
                                  size="small" type="primary" ghost icon={<SendOutlined />}
                                  style={{ marginTop: 6 }}
                                  loading={remindingTaskId === record.id}
                                  onClick={() => handleRemind(record.id)}
                                >{t('hwRemindUnsubmitted')}</Button>
                              </div>
                            )}
                          </div>
                        </Space>
                      )}
                    </div>
                  )}
                >
                  <Button type="link" size="small">{t('peopleCount', { count })} 👤</Button>
                </Popover>
                {!!r0?.expected_count && r0.expected_count > count && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    / {t('hwExpectedShort', { n: r0.expected_count })}
                  </Typography.Text>
                )}
                {pending > 0 && (
                  <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t('pendingGradeTag', { n: pending })}</Tag>
                )}
                {stale > 0 && (
                  <Tooltip title={t('hwStaleHint')}>
                    <Tag color="gold" style={{ marginInlineEnd: 0 }}>{t('hwStaleTagN', { n: stale })}</Tag>
                  </Tooltip>
                )}
              </Space>
            )
          },
        }]
    ),
    {
      title: t('actions'), key: 'action', width: 190,
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
          {/* 编辑：名称/要求/学科（老作业的学科也在这里补） */}

          {/* 批改入口一律在场。以前按"有没有人交"决定显不显示，同一列里图标忽有忽无，
              教师只会以为功能坏了（实测反馈正是"少了一个批改图标"）；没人可批时置灰并
              说清原因，而不是把按钮藏起来。两种形态一律走后台批改任务（P0-1 + P1-3），
              不再按形态挑端点 —— 以前文件作业打只读 summary 的 /ai-grade，点一下必然 404。
              注意 disabled 的按钮不响应 hover，所以 Tooltip 外面要再包一层 span。 */}
          {isAdminOrTeacher && (
            <Tooltip title={(record.submissions?.length ?? 0) > 0
              ? t(isFileTask(record.submit_mode) ? 'aiGradeFileTooltip' : 'aiGradeTooltip')
              : t('aiGradeNothingTooltip')}>
              <span>
                <Button size="small" icon={<RobotOutlined />}
                  loading={gradingJobKey === record.id}
                  disabled={(record.submissions?.length ?? 0) === 0
                    || (!!gradingJobKey && gradingJobKey !== record.id)}
                  onClick={() => runGradeJob(record)}
                />
              </span>
            </Tooltip>
          )}

          {isAdminOrTeacher && (
            <ResetActivityButton activityType="task" activityId={record.id}
              iconOnly stopPropagation onSuccess={loadTasks} />
          )}
          {/* 低频与高危动作收进「更多」：原来一行 6 个纯图标，删除还会被挤到换行，
              每个都要 hover 才知道是什么，误点一次就是删掉整份作业。
              详情 / 批改 / 重置 留在外面（前两个天天点，重置自带三段式确认）。
              菜单项一律带文字；结束与删除改走确认弹窗（下拉一关 Popconfirm 就没了）。 */}
          {isAdminOrTeacher && (
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  { key: 'edit', icon: <EditOutlined />, label: t('edit') },
                  { key: 'export', icon: <DownloadOutlined />, label: t('hwExportReport') },
                  { key: 'copy', icon: <CopyOutlined />, label: t('hwDuplicate') },
                  ...(record.status === 'active'
                    ? [{ type: 'divider' as const },
                       { key: 'end', icon: <CheckCircleOutlined />, label: t('endAction') }] : []),
                  { type: 'divider' as const },
                  { key: 'delete', icon: <DeleteOutlined />, label: t('deleteAction'), danger: true },
                ],
                onClick: ({ key }) => handleRowAction(key, record),
              }}
            >
              <Button size="small" icon={<MoreOutlined />} />
            </Dropdown>
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

  /**
   * 教师窄屏卡片：只留「查看详情」一个轻操作。
   * 编辑 / AI 批改 / 结束 / 重置 / 删除 都要横向比对多个班与批改进度，手机上误点一次的代价
   * 比省下的时间大 —— 与手机白名单同一条口径：手机看，重操作回电脑。
   */
  const teacherCardColumns = cardColumns.map((col: any) => (col.key !== 'action' ? col : {
    title: t('actions'), key: 'action',
    render: (_: any, record: TaskInfo) => (
      <Button size="small" icon={<EyeOutlined />} onClick={() => handleViewSubmissions(record)}>
        {t('details')}
      </Button>
    ),
  }))

  return (
    <div>
      <PageHeader
        icon={<CheckCircleOutlined />}
        title={t('taskManagement')}
        subtitle={t('taskPageSubtitle')}
        extra={(
          <>
            <Button icon={<QuestionCircleOutlined />} onClick={() => setGuideOpen(true)}>
              {t('guide.showTip')}
            </Button>
            <Tooltip title={t('refresh')}>
              <Button icon={<ReloadOutlined />} onClick={loadTasks} />
            </Tooltip>
            {isAdminOrTeacher && (
              <Button icon={<BulbOutlined />} onClick={openAiDraft}>{t('aiCreateTask')}</Button>
            )}
            {isAdminOrTeacher && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModal(true)}>
                {t('createTask')}
              </Button>
            )}
          </>
        )}
      >
        <ListFilterBar
          keyword={taskKw}
          onKeyword={(v) => { setTaskKw(v); setMPage(1) }}
          searchPlaceholder={t('listSearchPh')}
          status={taskFilter}
          onStatus={(v) => { setTaskFilter(v); setMPage(1) }}
          statusOptions={[
            { value: 'all', label: `${t('all')} (${taskMatched.length})` },
            { value: 'active', label: `${t('inProgress')} (${taskStatusCount.active})` },
            { value: 'expired', label: `${t('hwStatusExpired')} (${taskStatusCount.expired})` },
            { value: 'ended', label: `${t('ended')} (${taskStatusCount.ended})` },
          ]}
          subject={taskSubjectFilter}
          onSubject={(v) => { setTaskSubjectFilter(v); setMPage(1) }}
          subjectOptions={subjectOptions.map((s) => ({ value: s, label: s }))}
          subjectPlaceholder={t('subject')}
          dirty={!!taskKw || taskFilter !== 'all' || !!taskSubjectFilter}
          onReset={() => { setTaskKw(''); setTaskFilter('all'); setTaskSubjectFilter(''); setMPage(1) }}
          resetLabel={t('clearFilter')}
          style={{ marginBottom: 0 }}
          extra={isAdminOrTeacher && (
            <Checkbox checked={pendingOnly} onChange={(e) => setPendingFilter(e.target.checked)}>
              {t('pendingGradeFilter')}
            </Checkbox>
          )}
        />
      </PageHeader>

      <Card>
        <Spin spinning={loading}>
          {isMobile ? (
            /* 窄屏：师生一律改卡片。教师端原来保持表格，实测「作业要求」长文把表撑到
               6794px 宽（10 列），首屏只剩「作业名称 + 半个学科」，横滑也读不出来。 */
            <>
              <MobileCardTable
                dataSource={visibleTasks.slice((mPage - 1) * MOBILE_CARD_PAGE, mPage * MOBILE_CARD_PAGE)}
                columns={isStudent ? cardColumns : teacherCardColumns}
                rowKey="id"
                pagination={{ current: mPage, pageSize: MOBILE_CARD_PAGE, total: visibleTasks.length, onChange: setMPage }}
                emptyText={<Empty description={t('noActiveTasks')} />}
              />
              {!isStudent && (
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                  {t('taskMobileReadonlyHint')}
                </Typography.Text>
              )}
            </>
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
      <Modal mask={{ closable: false }}
        title={copySourceId ? t('hwDuplicateTitle') : editingTaskId ? t('edit') : t('createNewTask')}
        open={createModal}
        onOk={handleCreate}
        onCancel={() => {
          setCreateModal(false); setEditingTaskId(null)
          setTaskName(''); setTaskDesc('')
          setTaskSubject(subjectOptions[0] || '')
          setTaskScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
          setHw(emptyHomework())
          setEditModeLocked(false)
          setCopySourceId(null)
        }}
        okText={copySourceId ? t('hwDuplicateConfirm') : editingTaskId ? t('save') : t('createTask')}
        cancelText={t('cancel')}
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
          modeLocked={!!editingTaskId && editModeLocked}
        />
        {/* 学科：落库后作业列表与活动监控的"学科"列才显示得出来 */}
        <div style={{ marginTop: 12 }}>
          <Select
            value={taskSubject || undefined}
            onChange={setTaskSubject}
            style={{ width: 160 }}
            placeholder={t('subject')}
            options={subjectOptions.map(s => ({ value: s, label: s }))}
          />
        </div>
        {/* 目标范围：新建与复制一定可选；编辑时只在"零提交"下开放（与后端同一条判据）。
            以前编辑态整体隐藏，建错班级只能删了重建 —— 而删除会连带清掉文件与批改记录。 */}
        {(!editingTaskId || !editModeLocked) && (
          <div style={{ marginTop: 16 }}>
            <ActivityScopeSelector value={taskScope} onChange={setTaskScope} />
          </div>
        )}
        {!!editingTaskId && editModeLocked && (
          <Typography.Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
            {t('hwScopeLockedHint')}
          </Typography.Text>
        )}
      </Modal>

      {/* 提交任务确认弹窗 */}
      <Modal
        title={t('submitToTask', { name: selectedTask?.name || '' })}
        open={submitModal}
        onOk={handleSubmit}
        onCancel={() => { setSubmitModal(false); setSelectedTask(null) }}
        okText={t('confirmSubmit')} cancelText={t('cancel')}
        // 过期且教师关闭了迟交：按钮直接按不住，后端同样会拒（双保险）
        okButtonProps={{ disabled: !!selectedTask?.expired && !selectedTask?.allow_late }}
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
          {/* 对话作业现在也有截止时间了（P1-3）：过期就如实提示，allow_late=0 时后端会拒收 */}
          {selectedTask?.expired && (
            <Alert type={selectedTask.allow_late ? "warning" : "error"} showIcon
              message={selectedTask.allow_late ? t("hwLate") : t("hwClosedNoSubmit")}
              description={t("hwExpiredNote")}
            />
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

      {/* 提交详情：改成弹窗。原来是 760px 的右侧抽屉 —— 批改台一行要放
          姓名/班级/提交标签/分数/三个操作按钮，抽屉宽度不够就整行换行，
          而且抽屉盖在列表上半遮半露，看完一条还得先关再点下一条。 */}
      <Modal
        mask={{ closable: false }}
        open={submissionsModal}
        onCancel={closeDetail}
        footer={(<Button onClick={closeDetail}>
          {t('close')}
        </Button>)}
        width="min(1120px, 94vw)"
        styles={{ body: { maxHeight: '76vh', overflowY: 'auto', paddingTop: 8 } }}
        title={(<Space wrap size={6}>
          <span>📋 {submissionsData.task_name || t('loading')}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('submittedCount')} {submissionsData.count}
            {!!submissionsData.expected_count && ` / ${t('hwExpectedShort', { n: submissionsData.expected_count })}`}
          </Typography.Text>
        </Space>)}
      >
        <Spin spinning={submissionsLoading || gradesLoading}>
          <Space style={{ marginBottom: 16 }} wrap>
            <Tag color={submissionsData.task_status === 'active' ? 'green' : 'default'}>
              {submissionsData.task_status === 'active' ? t('inProgress') : t('ended')}
            </Tag>
            {/* 分母用"已提交"，且没有提交时不显示：以前这里能显示成「已批改 2/0 人」，
                等于把上一份作业的 2 份成绩挂在这份 0 提交的作业上，看着像系统算错 */}
            {submissionsData.count > 0 && Object.keys(gradesMap).length > 0 && (
              <Tag color="blue" icon={<RobotOutlined />}>
                {t('gradedCount', { graded: Object.keys(gradesMap).length, total: submissionsData.count })}
              </Tag>
            )}
            {/* 同上：详情里这个按钮也不因为"还没人交"就消失，置灰 + 说明 */}
            {viewTask && (
              <Button size="small" icon={<RobotOutlined />}
                loading={gradingJobKey === viewTask.id}
                disabled={submissionsData.submissions.length === 0}
                onClick={() => runGradeJob(viewTask)}
              >{Object.keys(gradesMap).length > 0 ? t('regrade') : t('aiGradeAction')}</Button>
            )}
            {/* 拍板③把"发通知 + 发等级奖"统一成「通知成绩」，可这个动作以前只在文件作业的
                批改台里有入口 —— 对话作业批完既没人收到通知，等级奖也永远轮不到它发。
                分数本身批完就能看（可见性已统一），这里补的是"告诉学生去查"那一步。 */}
            {viewTask && !isFileTask(viewTask.submit_mode) && Object.keys(gradesMap).length > 0 && (
              <Button size="small" icon={<NotificationOutlined />}
                loading={notifyingGrades}
                onClick={notifyConversationGrades}
              >{t('hwPublish')}</Button>
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
                              loading={gradingJobKey === viewTask.id + ':' + r.username}
                              onClick={() => runGradeJob(viewTask, r.username, studentLabel(r))}
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

      </Modal>

      {/* 学生提交正文：同样改弹窗。弹窗里再套一个从右边抽出来的抽屉，
          两层都盖住上一层，看到一半就不知道自己点的是谁了 */}
      <Modal
        title={t('contentTitle')}
        open={contentModal}
        onCancel={() => setContentModal(false)}
        footer={<Button onClick={() => setContentModal(false)}>{t('close')}</Button>}
        width={680}
        styles={{ body: { maxHeight: '64vh', overflowY: 'auto' } }}
      >
        <Spin spinning={contentLoading}>
          <div className="markdown-content">
            <FormulaRenderer content={studentContent || t('noContent')} />
          </div>
        </Spin>
      </Modal>

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
        mask={{ closable: false }}
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
