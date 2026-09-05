import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  Layout, Card, Tree, Button, message, Modal, Form, Input, Select, InputNumber,
  Tag, Space, Typography, Tooltip, Popconfirm, Row, Col, Spin, Empty, Progress,
} from 'antd'

const { Sider, Content } = Layout
import type { DataNode } from 'antd/es/tree'
import {
  BookOutlined, PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  FileOutlined, FileTextOutlined, DownloadOutlined, QuestionCircleOutlined, FormOutlined,
  TeamOutlined, CheckCircleOutlined, ClockCircleOutlined,
  MenuOutlined, NodeIndexOutlined, RobotOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined,
  RightOutlined, DownOutlined, SettingOutlined,
  EyeOutlined, BulbOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import * as curriculumApi from '../api/curriculum'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import ResourceBinder from '../components/ResourceBinder'
import AICurriculumGenerator from '../components/AICurriculumGenerator'
import type { Course, ChapterTreeNode, KnowledgePoint, CurriculumResource } from '../types'

const { TextArea } = Input
const { Option } = Select

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'green',
  medium: 'gold',
  hard: 'red',
}

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'difficultyEasy',
  medium: 'difficultyMedium',
  hard: 'difficultyHard',
}

const STATUS_LABELS: Record<string, string> = {
  not_started: 'statusNotStarted',
  in_progress: 'statusInProgress',
  completed: 'statusCompleted',
}

const STATUS_COLORS: Record<string, string> = {
  not_started: 'default',
  in_progress: 'processing',
  completed: 'success',
}

const RESOURCE_ICONS: Record<string, React.ReactNode> = {
  html: <FileOutlined />,
  download: <DownloadOutlined />,
  question: <QuestionCircleOutlined />,
  exam: <FormOutlined />,
  discussion: <TeamOutlined />,
  interaction_quiz: <FormOutlined />,
  task: <CheckCircleOutlined />,
}

const RESOURCE_LABELS: Record<string, string> = {
  html: 'resourceHtml',
  download: 'resourceDownload',
  question: 'resourceQuestion',
  exam: 'resourceExam',
  discussion: 'resourceDiscussion',
  interaction_quiz: 'resourceInteractionQuiz',
  task: 'resourceTask',
}

const CurriculumPage: React.FC = () => {
  const { t } = useTranslation('curriculum')
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  // ── 从系统配置加载课程名称列表 ──
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])
  const [gradeOptions, setGradeOptions] = useState<string[]>([])
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjectOptions(data.subjects)
    }).catch(() => {})
    apiClient.get('/api/config/grades').then(({ data }) => {
      const list = data?.grades
      if (list?.length > 0) setGradeOptions(list.map((g: any) => g.name || g))
    }).catch(() => {})
  }, [])

  // ── 课程树数据 ──
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(false)
  const [activeCourseId, setActiveCourseId] = useState<number | null>(() => {
    try {
      const saved = localStorage.getItem('curriculum_active_course_id')
      return saved ? JSON.parse(saved) : null
    } catch { return null }
  })

  // ── 课程创建/编辑 ──
  const [courseModal, setCourseModal] = useState(false)
  const [editingCourse, setEditingCourse] = useState<Course | null>(null)
  const [courseForm] = Form.useForm()
  const [savingCourse, setSavingCourse] = useState(false)

  // ── AI 资源推荐 ──
  const [recModal, setRecModal] = useState(false)
  const [recLoading, setRecLoading] = useState(false)
  const [recResults, setRecResults] = useState<any[]>([])
  const [recBindLoading, setRecBindLoading] = useState<Record<number, boolean>>({})

  // ── AI 课件生成 ──
  const [cwModal, setCwModal] = useState(false)
  const [cwLoading, setCwLoading] = useState(false)
  const [cwUrl, setCwUrl] = useState('')

  // ── AI 练习生成 ──
  const [practiceModal, setPracticeModal] = useState(false)
  const [practiceLoading, setPracticeLoading] = useState(false)
  const [practiceHtmlUrl, setPracticeHtmlUrl] = useState('')
  const [practiceDone, setPracticeDone] = useState<{ fileUrl: string; fileName: string } | null>(null)
  const [practiceMode, setPracticeMode] = useState<'ai' | 'bank' | 'mixed'>('ai')
  // 题库选取模式
  const [bankKeyword, setBankKeyword] = useState('')
  const [bankQuestions, setBankQuestions] = useState<any[]>([])
  const [bankLoading, setBankLoading] = useState(false)
  const [selectedBankIds, setSelectedBankIds] = useState<number[]>([])
  // 混合模式
  const [mixedAiQuestions, setMixedAiQuestions] = useState<any[]>([])
  const [mixedBankIds, setMixedBankIds] = useState<number[]>([])
  const [mixedAiCount, setMixedAiCount] = useState(5)
  const [mixedGenLoading, setMixedGenLoading] = useState(false)
  const [mixedBankSearch, setMixedBankSearch] = useState('')
  const [mixedBankResults, setMixedBankResults] = useState<any[]>([])
  const [mixedBankLoading, setMixedBankLoading] = useState(false)
  // 主题选择
  const [practiceThemes, setPracticeThemes] = useState<curriculumApi.AiPracticeTheme[]>([])
  const [practiceTheme, setPracticeTheme] = useState('')
  // 学科/年级
  const [practiceSubjectOptions, setPracticeSubjectOptions] = useState<string[]>([])
  const [practiceGradeOptions, setPracticeGradeOptions] = useState<string[]>([])
  const [practiceSubject, setPracticeSubject] = useState('')
  const [practiceGrade, setPracticeGrade] = useState('')
  // 可编辑的知识点名称
  const [practiceTopic, setPracticeTopic] = useState('')

  // ── 章节/知识点管理 ──
  const [chapterModal, setChapterModal] = useState(false)
  const [kpModal, setKpModal] = useState(false)
  const [editingChapter, setEditingChapter] = useState<ChapterTreeNode | null>(null)
  const [editingKp, setEditingKp] = useState<KnowledgePoint | null>(null)
  const [chapterForm] = Form.useForm()
  const [kpForm] = Form.useForm()
  const [savingChapter, setSavingChapter] = useState(false)
  const [savingKp, setSavingKp] = useState(false)

  // ── 知识点详情（右侧面板） ──
  const [selectedKp, setSelectedKp] = useState<KnowledgePoint | null>(null)
  const [kpResources, setKpResources] = useState<CurriculumResource[]>([])
  const [kpLoading, setKpLoading] = useState(false)

  // ── AI 备课 ──
  const [lessonPlanLoading, setLessonPlanLoading] = useState(false)
  const [lessonPlanModal, setLessonPlanModal] = useState(false)
  const [lessonPlanData, setLessonPlanData] = useState<{ knowledge_point: string; lesson_plan: string } | null>(null)
  const handleAiLessonPlan = async (kpId: number) => {
    setLessonPlanLoading(true)
    setLessonPlanData(null)
    setLessonPlanModal(true)  // 立即打开弹窗，显示加载状态
    try {
      const { data } = await apiClient.get('/api/curriculum/ai-lesson-plan', { params: { knowledge_point_id: kpId } })
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result && result.lesson_plan) {
          setLessonPlanData(result)
        } else {
          message.error(result?.error || t('aiLessonPlanFailed'))
          setLessonPlanModal(false)
        }
      } else {
        setLessonPlanData(data)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiLessonPlanFailed'))
      setLessonPlanModal(false)
    } finally {
      setLessonPlanLoading(false)
    }
  }

  // ── AI 资源推荐 ──
  const handleAiRecommend = async (kpId: number) => {
    setRecLoading(true)
    setRecResults([])
    setRecModal(true)
    try {
      const { data } = await apiClient.post(`/api/recommend/knowledge-point/${kpId}`)
      setRecResults(data.recommendations || [])
      if (!data.recommendations?.length) {
        message.info(data.message || t('noRecommendations'))
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiRecommendFailed'))
      setRecModal(false)
    } finally {
      setRecLoading(false)
    }
  }

  const handleBindRecommended = async (resourceType: string, resourceId: number) => {
    if (!selectedKp) return
    setRecBindLoading(prev => ({ ...prev, [resourceId]: true }))
    try {
      await curriculumApi.bindResource({
        knowledge_point_id: selectedKp.id,
        resource_type: resourceType,
        resource_id: resourceId,
      })
      message.success(t('resourceBound'))
      // 刷新资源列表
      try {
        const res = await curriculumApi.getKpResources(selectedKp.id)
        setKpResources(res.resources)
      } catch { /* ignore */ }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('bindFailed'))
    } finally {
      setRecBindLoading(prev => ({ ...prev, [resourceId]: false }))
    }
  }

  // ── AI 课件生成 ──
  const handleAiCourseware = async (kpId: number) => {
    setCwLoading(true)
    setCwUrl('')
    setCwModal(true)
    try {
      const { data } = await apiClient.post(`/api/curriculum/ai-courseware/${kpId}`)
      const result = await pollAiTask(data.task_id, 120000)
      if (result && result.file_url) {
        setCwUrl(result.file_url)
      } else if (result && result.error) {
        message.error(result.error)
        setCwModal(false)
      } else {
        message.error(t('aiCoursewareFailedTimeout'))
        setCwModal(false)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiCoursewareFailed'))
      setCwModal(false)
    } finally {
      setCwLoading(false)
    }
  }

  // ── AI 练习生成 ──
  // 打开弹窗时加载主题、学科、年级选项
  useEffect(() => {
    if (!practiceModal) return
    setPracticeDone(null)
    setPracticeHtmlUrl('')
    setPracticeTheme('')
    setPracticeTopic(selectedKp?.name || '')
    // 加载主题
    curriculumApi.getAiPracticeThemes().then(themes => {
      setPracticeThemes(themes)
      if (themes.length > 0) setPracticeTheme(themes[0].id)
    }).catch(() => {})
    // 加载学科
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setPracticeSubjectOptions(data.subjects)
    }).catch(() => {})
    // 加载年级
    apiClient.get('/api/scores/my-grades').then(({ data }) => {
      if (Array.isArray(data) && data.length > 0) setPracticeGradeOptions(data)
    }).catch(() => {})
    if (activeCourse?.subject) setPracticeSubject(activeCourse.subject)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practiceModal])

  // 点击 AI 练习按钮：打开配置弹窗
  const handleAiPractice = async (_kpId: number) => {
    void _kpId;
    setPracticeLoading(false)
    setPracticeHtmlUrl('')
    setPracticeDone(null)
    setPracticeModal(true)
  }

  // 执行 AI 练习生成
  const handleAiPracticeGenerate = async () => {
    if (!selectedKp) return
    setPracticeLoading(true)
    setPracticeDone(null)
    setPracticeHtmlUrl('')
    try {
      const { data } = await apiClient.post(`/api/curriculum/ai-practice/${selectedKp.id}`, {
        theme: practiceTheme || undefined,
      })
      message.info(t('aiGeneratingPractice'))
      const result = await pollAiTask(data.task_id, 180000)
      if (result && result.file_url) {
        const fileUrl = result.file_url
        setPracticeHtmlUrl(fileUrl)
        setPracticeDone({ fileUrl, fileName: result.filename || '' })
        message.success(t('practiceGenerated', { count: result.total || 10 }))
      } else if (result && result.error) {
        message.error(result.error)
      } else {
        message.error(t('aiPracticeFailedTimeout'))
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiPracticeFailed'))
    } finally {
      setPracticeLoading(false)
    }
  }

  // 从题库选取模式
  const searchBankQuestions = async () => {
    if (!selectedKp) return
    setBankLoading(true)
    try {
      const { data } = await apiClient.get('/api/questions', {
        params: { type: 'single', keyword: bankKeyword || selectedKp.name, page_size: 50 }
      })
      setBankQuestions(data.questions || [])
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('searchBankFailed'))
    } finally {
      setBankLoading(false)
    }
  }

  const toggleBankQuestion = (qid: number) => {
    setSelectedBankIds(prev =>
      prev.includes(qid) ? prev.filter(id => id !== qid) : prev.length < 10 ? [...prev, qid] : prev
    )
  }

  const generateFromBank = async () => {
    if (!selectedKp || selectedBankIds.length === 0) return
    setPracticeLoading(true)
    try {
      const { data } = await apiClient.post(`/api/curriculum/ai-practice/${selectedKp.id}/from-bank`, {
        question_ids: selectedBankIds,
      })
      if (data.file_url) {
        setPracticeHtmlUrl(data.file_url)
        setPracticeMode('ai')
        message.success(data.message)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('generatePracticeFailed'))
    } finally {
      setPracticeLoading(false)
    }
  }

  // ── 混合模式 ──
  const generateMixedAi = async () => {
    if (!selectedKp || mixedAiCount < 1) return
    setMixedGenLoading(true)
    try {
      const { data } = await apiClient.post('/api/practice/generate', {
        knowledge_points: selectedKp.name,
        subject: activeCourse?.subject || '',
        question_type: 'single',
        count: mixedAiCount,
        difficulty: selectedKp.difficulty || 'medium',
      })
      if (data.questions?.length > 0) {
        setMixedAiQuestions(data.questions)
        message.success(t('aiGeneratedCount', { count: data.questions.length }))
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiGenerateFailed'))
    } finally {
      setMixedGenLoading(false)
    }
  }

  const searchMixedBank = async () => {
    if (!selectedKp) return
    setMixedBankLoading(true)
    try {
      const { data } = await apiClient.get('/api/questions', {
        params: { type: 'single', keyword: mixedBankSearch || selectedKp.name, page_size: 50 }
      })
      setMixedBankResults(data.questions || [])
    } catch { /* ignore */ }
    finally { setMixedBankLoading(false) }
  }

  const toggleMixedBank = (qid: number) => {
    const totalSelected = mixedAiQuestions.length + mixedBankIds.length
    const already = mixedBankIds.includes(qid)
    if (already) {
      setMixedBankIds(prev => prev.filter(id => id !== qid))
    } else if (totalSelected < 10) {
      setMixedBankIds(prev => [...prev, qid])
    } else {
      message.warning(t('maxSelect10'))
    }
  }

  const removeMixedQuestion = (source: 'ai' | 'bank', id: number) => {
    if (source === 'ai') {
      setMixedAiQuestions(prev => prev.filter(q => q.id !== id))
    } else {
      setMixedBankIds(prev => prev.filter(qid => qid !== id))
    }
  }

  const generateMixedPractice = async () => {
    if (!selectedKp) return
    const allIds = [...mixedAiQuestions.map(q => q.id), ...mixedBankIds]
    if (allIds.length === 0) { message.warning(t('selectAtLeastOne')); return }
    setPracticeLoading(true)
    try {
      const { data } = await apiClient.post(`/api/curriculum/ai-practice/${selectedKp.id}/from-bank`, {
        question_ids: allIds,
      })
      if (data.file_url) {
        setPracticeHtmlUrl(data.file_url)
        message.success(data.message)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('generatePracticeFailed'))
    } finally {
      setPracticeLoading(false)
    }
  }

  // ── 智能练习（增强混合模式，自动组合AI+题库，无需用户干预） ──
  const handleSmartPractice = async (kpId: number) => {
    setPracticeLoading(true)
    setPracticeHtmlUrl('')
    setPracticeMode('mixed')
    setPracticeModal(true)
    const kp = selectedKp
    if (!kp) { setPracticeModal(false); return }

    try {
      // 调用后端增强智能生成端点，由服务端完成：
      // 1. 多渠道搜索题库（knowledge_points + question_text 双重匹配）
      // 2. AI 补全差额（最多10题）
      // 3. 去重合并、创建练习、生成HTML
      const { data } = await apiClient.post(`/api/curriculum/ai-practice/${kpId}/smart-generate`)
      if (data.file_url) {
        setPracticeHtmlUrl(data.file_url)
        setMixedAiQuestions([])
        setMixedBankIds([])
        message.success(data.message || t('smartPracticeGenerated', { total: data.total }))
      }
    } catch (err: any) {
      // 如果后端返回了详细错误，直接显示
      const detail = err?.response?.data?.detail
      if (detail) {
        message.error(detail)
      } else {
        message.error(t('smartPracticeFailed'))
      }
      setPracticeModal(false)
    } finally {
      setPracticeLoading(false)
    }
  }
  const [binderOpen, setBinderOpen] = useState(false)
  const [binderKpId, setBinderKpId] = useState(0)
  const [binderKpName, setBinderKpName] = useState('')

  // ── AI 生成课程弹窗 ──
  const [aiGeneratorOpen, setAiGeneratorOpen] = useState(false)

  // ── 教师操作图标显隐 ──
  const [showActions, setShowActions] = useState(false)

  // ── 侧栏折叠 & 分类展开状态（localStorage 持久化） ──
  const [siderCollapsed, setSiderCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('curriculum_sider_collapsed') || 'false') } catch { return false }
  })
  const [expandedSubjects, setExpandedSubjects] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('curriculum_expanded_subjects')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })

  // 持久化侧栏折叠状态
  useEffect(() => {
    localStorage.setItem('curriculum_sider_collapsed', JSON.stringify(siderCollapsed))
  }, [siderCollapsed])

  // 持久化分类展开状态
  useEffect(() => {
    localStorage.setItem('curriculum_expanded_subjects', JSON.stringify(expandedSubjects))
  }, [expandedSubjects])

  // 用户手动点击课程时保存到 localStorage
  const handleSelectCourse = (courseId: number) => {
    setActiveCourseId(courseId)
    localStorage.setItem('curriculum_active_course_id', JSON.stringify(courseId))
  }

  // 切换分类展开/收起
  const toggleSubject = (subject: string) => {
    setExpandedSubjects((prev) =>
      prev.includes(subject) ? prev.filter((s) => s !== subject) : [...prev, subject]
    )
  }

  // 客户端推断课程所属大类（兼容旧数据）
  const getCourseSubject = useCallback((course: Course): string => {
    if (course.subject) return course.subject
    const nameMap: [string, string][] = [
      ['技术与设计', '通用技术'],
      ['数据与计算', '信息科技'],
      ['信息系统与社会', '信息科技'],
      ['人工智能', '人工智能'],
    ]
    for (const [kw, subj] of nameMap) {
      if (course.name.includes(kw)) return subj
    }
    return ''
  }, [])

  // 当选中的课程变化时，自动展开其所属分类
  useEffect(() => {
    if (!activeCourseId) return
    const course = courses.find((c) => c.id === activeCourseId)
    if (!course) return
    const subj = course.subject || getCourseSubject(course) || t('uncategorized')
    if (!expandedSubjects.includes(subj)) {
      setTimeout(() => setExpandedSubjects((prev) => [...prev, subj]), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCourseId])

  // ── 加载课程树 ──
  const loadTree = useCallback(async () => {
    setLoading(true)
    try {
      const data = await curriculumApi.getCurriculumTree()
      setCourses(data)
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || t('loadCourseDataFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    const fetchData = async () => {
      await loadTree()
    }
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 当课程列表变化时，确保有选中课程
  useEffect(() => {
    if (courses.length === 0) return
    if (!activeCourseId || !courses.find((c) => c.id === activeCourseId)) {
      setTimeout(() => setActiveCourseId(courses[0].id), 0)
    }
  }, [courses, activeCourseId])

  // ── 树节点选择 ──
  const handleTreeSelect = (_selectedKeys: React.Key[], info: Record<string, unknown>) => {
    const node = info.node as Record<string, unknown> | undefined
    if (node?.isKp) {
      const kpData = node.data as KnowledgePoint
      // 加载知识点详情
      setKpLoading(true)
      setSelectedKp(kpData)
      ;(async () => {
        try {
          const res = await curriculumApi.getKpResources(kpData.id)
          setKpResources(res.resources)
        } catch {
          setKpResources([])
        } finally {
          setKpLoading(false)
        }
      })()
    }
  }

  // ── 课程 CRUD ──
  const handleCreateCourse = () => {
    setEditingCourse(null)
    courseForm.resetFields()
    setCourseModal(true)
  }

  const handleEditCourse = (course: Course) => {
    setEditingCourse(course)
    courseForm.setFieldsValue(course)
    setCourseModal(true)
  }

  const handleSaveCourse = async () => {
    try {
      const values = await courseForm.validateFields()
      setSavingCourse(true)
      if (editingCourse) {
        await curriculumApi.updateCourse(editingCourse.id, values)
        message.success(t('courseUpdated'))
      } else {
        await curriculumApi.createCourse(values)
        message.success(t('courseCreated'))
      }
      setCourseModal(false)
      loadTree()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (detail) {
        message.error(detail)
      }
    } finally {
      setSavingCourse(false)
    }
  }

  const handleDeleteCourse = async (courseId: number) => {
    try {
      await curriculumApi.deleteCourse(courseId)
      message.success(t('courseDeleted'))
      loadTree()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || t('deleteFailed'))
    }
  }

  // ── 章节 CRUD ──
  const handleCreateChapter = (courseId: number, parentId?: number | null) => {
    setEditingChapter(null)
    chapterForm.resetFields()
    chapterForm.setFieldsValue({ course_id: courseId, parent_id: parentId ?? null })
    setChapterModal(true)
  }

  const handleEditChapter = (chapter: ChapterTreeNode) => {
    setEditingChapter(chapter)
    chapterForm.setFieldsValue(chapter)
    setChapterModal(true)
  }

  const handleSaveChapter = async () => {
    try {
      const values = await chapterForm.validateFields()
      setSavingChapter(true)
      if (editingChapter) {
        await curriculumApi.updateChapter(editingChapter.id, values)
        message.success(t('chapterUpdated'))
      } else {
        await curriculumApi.createChapter(values)
        message.success(t('chapterCreated'))
      }
      setChapterModal(false)
      loadTree()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (detail) {
        message.error(detail)
      }
    } finally {
      setSavingChapter(false)
    }
  }

  const handleDeleteChapter = async (chapterId: number) => {
    try {
      await curriculumApi.deleteChapter(chapterId)
      message.success(t('chapterDeleted'))
      loadTree()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || t('deleteFailed'))
    }
  }

  // ── 拖动排序（支持同级重排和跨层级拖动）──
  const handleTreeDrop = async (info: { dragNode: DataNode; node: DataNode; dropPosition: number; dropToGap: boolean }) => {
    if (!isTeacherOrAdmin) return

    const { dragNode, node, dropPosition, dropToGap } = info
    const dragKey = dragNode.key as string
    const dropKey = node.key as string
    const [dragPrefix, dragIdStr] = dragKey.split('_')
    const [dropPrefix] = dropKey.split('_')
    const dragId = parseInt(dragIdStr, 10)

    const course = courses.find((c) => c.id === activeCourseId)
    if (!course) return

    // ─────────────────────────────────────────────
    // 辅助：在树中查找某个 key 所在的同级数组
    // ─────────────────────────────────────────────
    const findContainerByKey = (items: any[], searchKey: string): { list: any[]; parentChapterId: number | null } | null => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (`ch_${item.id}` === searchKey) {
          return { list: items, parentChapterId: null }
        }
        if (item.children?.length) {
          const found = findContainerByKey(item.children, searchKey)
          if (found) return found
        }
        if (item.knowledge_points?.length) {
          for (const kp of item.knowledge_points) {
            if (`kp_${kp.id}` === searchKey) {
              return { list: item.knowledge_points, parentChapterId: item.id }
            }
          }
        }
      }
      return null
    }

    // ─────────────────────────────────────────────
    // 辅助：在树中查找某个 ID 的章节节点（递归）
    // ─────────────────────────────────────────────
    const findChapterById = (items: any[], id: number): any | null => {
      for (const ch of items) {
        if (ch.id === id) return ch
        if (ch.children) {
          const found = findChapterById(ch.children, id)
          if (found) return found
        }
      }
      return null
    }

    // ─────────────────────────────────────────────
    // 辅助：构建排序请求并提交
    // ─────────────────────────────────────────────
    const submitReorder = async (orderedList: curriculumApi.ReorderItem[]) => {
      try {
        await curriculumApi.reorderNodes(orderedList)
        message.success(t('sortUpdated'))
        loadTree()
      } catch (err: unknown) {
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        message.error(detail || t('operationFailed'))
        loadTree()
      }
    }

    // ─────────────────────────────────────────────
    // CASE 1: dropToGap = true — 同级间隙拖动（重排）
    // ─────────────────────────────────────────────
    if (dropToGap) {
      if (dragPrefix !== dropPrefix) {
        message.warning(t('cannotDragDifferentType'))
        return
      }

      const container = findContainerByKey(course.chapters || [], dragKey)
      if (!container) return
      const siblings = container.list

      const fromIdx = siblings.findIndex((s: any) => {
        const key = dragPrefix === 'ch' ? `ch_${s.id}` : `kp_${s.id}`
        return key === dragKey
      })
      const toIdx = siblings.findIndex((s: any) => {
        const key = dragPrefix === 'ch' ? `ch_${s.id}` : `kp_${s.id}`
        return key === dropKey
      })
      if (fromIdx === -1 || toIdx === -1) return

      const newIndex = dropPosition === -1 ? toIdx : toIdx + 1
      const reordered = [...siblings]
      const [moved] = reordered.splice(fromIdx, 1)
      const adjusted = fromIdx < newIndex ? newIndex - 1 : newIndex
      reordered.splice(adjusted, 0, moved)

      const nodeType = dragPrefix === 'ch' ? 'chapter' as const : 'knowledge_point' as const
      return submitReorder(reordered.map((s: any, i: number) => ({
        type: nodeType,
        id: s.id,
        sort_order: i,
      })))
    }

    // ─────────────────────────────────────────────
    // CASE 2: dropToGap = false — 拖入节点内部（改变层级）
    // ─────────────────────────────────────────────
    // 目标必须是章节节点
    if (dropPrefix !== 'ch') {
      message.warning(t('canOnlyDragToChapter'))
      return
    }

    const targetChapterId = parseInt(dropKey.split('_')[1], 10)
    const dragContainer = findContainerByKey(course.chapters || [], dragKey)
    if (!dragContainer) return
    const dragSiblings = dragContainer.list

    if (dragPrefix === 'ch') {
      // ── 章节拖入章节 → 改变 parent_id ──
      // 循环引用检查
      const wouldCycle = (parentId: number, searchId: number): boolean => {
        if (parentId === searchId) return true
        const parent = findChapterById(course.chapters || [], parentId)
        if (!parent?.children) return false
        return parent.children.some((c: any) => c.id === searchId || wouldCycle(c.id, searchId))
      }
      if (wouldCycle(targetChapterId, dragId)) {
        message.warning(t('cannotDragToSelf'))
        return
      }

      // 从原位置移除
      const fromIdx = dragSiblings.findIndex((s: any) => `ch_${s.id}` === dragKey)
      if (fromIdx === -1) return
      const newSiblings = [...dragSiblings]
      newSiblings.splice(fromIdx, 1)

      const items: curriculumApi.ReorderItem[] = []
      // 原同级重排
      newSiblings.forEach((s: any, i: number) => {
        items.push({ type: 'chapter', id: s.id, sort_order: i })
      })
      // 目标章节的子章节重排（保持原顺序，追加拖入节点）
      const targetChapter = findChapterById(course.chapters || [], targetChapterId)
      const targetChildren = targetChapter?.children || []
      targetChildren.forEach((child: any, i: number) => {
        items.push({ type: 'chapter', id: child.id, sort_order: i, parent_id: targetChapterId })
      })
      items.push({ type: 'chapter', id: dragId, sort_order: targetChildren.length, parent_id: targetChapterId })

      return submitReorder(items)
    }

    if (dragPrefix === 'kp') {
      // ── 知识点拖入章节 → 改变 chapter_id ──
      // 知识点不能拖入自身所在章节（无意义）
      if (dragContainer.parentChapterId === targetChapterId) {
        message.info(t('kpAlreadyInChapter'))
        return
      }

      const fromIdx = dragSiblings.findIndex((s: any) => `kp_${s.id}` === dragKey)
      if (fromIdx === -1) return
      const newDragSiblings = [...dragSiblings]
      newDragSiblings.splice(fromIdx, 1)

      const items: curriculumApi.ReorderItem[] = []
      // 原同级重排（移除后的）
      newDragSiblings.forEach((s: any, i: number) => {
        items.push({ type: 'knowledge_point', id: s.id, sort_order: i })
      })
      // 目标章节知识点重排（追加拖入节点到最后）
      const targetChapter = findChapterById(course.chapters || [], targetChapterId)
      const targetKps = targetChapter?.knowledge_points || []
      targetKps.forEach((kp: any, i: number) => {
        items.push({ type: 'knowledge_point', id: kp.id, sort_order: i, chapter_id: targetChapterId })
      })
      items.push({ type: 'knowledge_point', id: dragId, sort_order: targetKps.length, chapter_id: targetChapterId })

      return submitReorder(items)
    }
  }

  // ── 知识点 CRUD ──
  const handleCreateKp = (chapterId: number) => {
    setEditingKp(null)
    kpForm.resetFields()
    kpForm.setFieldsValue({ chapter_id: chapterId })
    setKpModal(true)
  }

  const handleEditKp = (kp: KnowledgePoint) => {
    setEditingKp(kp)
    kpForm.setFieldsValue(kp)
    setKpModal(true)
  }

  const handleSaveKp = async () => {
    try {
      const values = await kpForm.validateFields()
      setSavingKp(true)
      if (editingKp) {
        await curriculumApi.updateKnowledgePoint(editingKp.id, values)
        message.success(t('kpUpdated'))
      } else {
        await curriculumApi.createKnowledgePoint(values)
        message.success(t('kpCreated'))
      }
      setKpModal(false)
      loadTree()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      if (detail) {
        message.error(detail)
      }
    } finally {
      setSavingKp(false)
    }
  }

  const handleDeleteKp = async (kpId: number) => {
    try {
      await curriculumApi.deleteKnowledgePoint(kpId)
      message.success(t('kpDeleted'))
      loadTree()
      if (selectedKp?.id === kpId) {
        setSelectedKp(null)
        setKpResources([])
      }
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || t('deleteFailed'))
    }
  }

  // ── 学习进度 ──
  const handleUpdateProgress = async (kpId: number, status: string) => {
    try {
      await curriculumApi.updateProgress(kpId, status)
      message.success(status === 'completed' ? t('markedCompleted') : t('statusUpdated'))
      loadTree()
      // 刷新当前知识点详情
      if (selectedKp?.id === kpId) {
        const kp = await curriculumApi.getKnowledgePoint(kpId)
        setSelectedKp(kp)
      }
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || t('updateFailed'))
    }
  }

  // ── 构建 Ant Design Tree 数据 ──
  const buildTreeData = (course: Course) => {
    const chapters = course.chapters || []
    return chapters.map((ch) => buildChapterNode(ch))
  }

  const buildChapterNode = (ch: ChapterTreeNode): Record<string, unknown> => {
    const isLeaf = !ch.children?.length && !ch.knowledge_points?.length
    const node: Record<string, unknown> = {
      title: renderChapterTitle(ch),
      key: `ch_${ch.id}`,
      isLeaf,
      data: ch,
    }
    const children: Record<string, unknown>[] = []

    // 子章节
    if (ch.children?.length) {
      children.push(...ch.children.map((c) => buildChapterNode(c)))
    }
    // 知识点
    if (ch.knowledge_points?.length) {
      children.push(...ch.knowledge_points.map((kp) => ({
        title: renderKpTitle(kp),
        key: `kp_${kp.id}`,
        isLeaf: true,
        isKp: true,
        data: kp,
      })))
    }
    if (children.length) {
      node.children = children
    }
    return node
  }

  const renderChapterTitle = (ch: ChapterTreeNode) => (
    <Space size="small">
      <MenuOutlined style={{ fontSize: 12, opacity: 0.5 }} />
      <Typography.Text strong>{ch.name}</Typography.Text>
      {isTeacherOrAdmin && showActions && (
        <Space size="small" style={{ marginLeft: 8 }}>
          <Tooltip title={t('addSubChapter')}>
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={(e) => { e.stopPropagation(); handleCreateChapter(ch.course_id, ch.id) }}
            />
          </Tooltip>
          <Tooltip title={t('addKnowledgePoint')}>
            <Button
              type="text"
              size="small"
              icon={<NodeIndexOutlined />}
              onClick={(e) => { e.stopPropagation(); handleCreateKp(ch.id) }}
            />
          </Tooltip>
          <Tooltip title={t('editTitle')}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => { e.stopPropagation(); handleEditChapter(ch) }}
            />
          </Tooltip>
          <Popconfirm title={t('confirmDeleteChapter')} onConfirm={(e) => { e?.stopPropagation(); handleDeleteChapter(ch.id) }} okText={t('confirm')} cancelText={t('cancel')}>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
        </Space>
      )}
    </Space>
  )

  const renderKpTitle = (kp: KnowledgePoint) => (
    <Space size="small" style={{ width: '100%' }}>
      <span style={{ fontSize: 12 }}>•</span>
      <Typography.Text>{kp.name}</Typography.Text>
      <Tag color={DIFFICULTY_COLORS[kp.difficulty]} style={{ fontSize: 11, lineHeight: '18px' }}>
        {t(DIFFICULTY_LABELS[kp.difficulty]) || kp.difficulty}
      </Tag>
      {(kp.resource_count ?? 0) > 0 && (
        <Tooltip title={t('boundResources', { count: kp.resource_count })}>
          <Tag color="blue" style={{ fontSize: 11, lineHeight: '18px', cursor: 'default' }}>
            {kp.resource_count}
          </Tag>
        </Tooltip>
      )}
      {kp.estimated_minutes > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('minutes', { minutes: kp.estimated_minutes })}
        </Typography.Text>
      )}
      {isStudent && kp.progress_status && (
        <Tag color={STATUS_COLORS[kp.progress_status]} style={{ fontSize: 11, lineHeight: '18px' }}>
          {t(STATUS_LABELS[kp.progress_status])}
        </Tag>
      )}
      {isTeacherOrAdmin && showActions && (
        <Space size="small" style={{ marginLeft: 4 }}>
          <Tooltip title={t('cyEditKp')}>
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => { e.stopPropagation(); handleEditKp(kp) }}
            />
          </Tooltip>
          <Popconfirm title={t('confirmDeleteKp')} onConfirm={() => handleDeleteKp(kp.id)} okText={t('confirm')} cancelText={t('cancel')}>
            <Button
              type="text"
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={(e) => e.stopPropagation()}
            />
          </Popconfirm>
        </Space>
      )}
    </Space>
  )

  // ── 当前课程 ──
  const activeCourse = courses.find((c) => c.id === activeCourseId)

  // Suppress unused warnings for bank/mixed practice mode (reserved for future use)
  void [practiceHtmlUrl, practiceMode, bankKeyword, bankQuestions, bankLoading, selectedBankIds, mixedAiQuestions, mixedBankIds, mixedAiCount, mixedGenLoading, mixedBankSearch, mixedBankResults, mixedBankLoading, setBankKeyword, setBankQuestions, setBankLoading, setSelectedBankIds, setMixedAiQuestions, setMixedBankIds, setMixedAiCount, setMixedGenLoading, setMixedBankSearch, setMixedBankResults, setMixedBankLoading, searchBankQuestions, toggleBankQuestion, generateFromBank, generateMixedAi, searchMixedBank, toggleMixedBank, removeMixedQuestion, generateMixedPractice, handleSmartPractice];

  // ── 按大类分组 ──
  const groupedCourses: { subject: string; courses: Course[] }[] = subjectOptions
    .map((subject) => ({
      subject,
      courses: courses.filter((c) => {
        const cs = getCourseSubject(c)
        return cs === subject
      }),
    }))
    .filter((g) => g.courses.length > 0)
  // 未匹配到任何大类的课程归入「未分类」
  const unmatchedCourses = courses.filter((c) => {
    const cs = getCourseSubject(c)
    return !cs || !subjectOptions.includes(cs)
  })
  if (unmatchedCourses.length > 0) {
    groupedCourses.push({ subject: t('uncategorized'), courses: unmatchedCourses })
  }


  return (
    <Layout style={{ minHeight: 'calc(100vh - 64px)', background: '#f5f5f5' }}>
      {/* ── 加载中 ── */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin size="large" description={t('loadingData')} />
        </div>
      )}

      {!loading && courses.length === 0 && (
        <Card>
          <Empty
            description={
              subjectOptions.length === 0
                ? t('noSubjectsConfigured')
                : t('noCourses')
            }
          >
            {isTeacherOrAdmin && (
              <Space orientation="vertical" style={{ width: '100%' }}>
                {subjectOptions.length === 0 && user?.role === 'admin' && (
                  <Button
                    icon={<SettingOutlined />}
                    onClick={() => navigate('/system-config')}
                  >
                    {t('goToSystemConfig')}
                  </Button>
                )}
                <Space>
                  <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateCourse}>
                    {t('createCourse')}
                  </Button>
                  <Button icon={<RobotOutlined />} onClick={() => setAiGeneratorOpen(true)}>
                    {t('aiImport')}
                  </Button>
                </Space>
              </Space>
            )}
          </Empty>
        </Card>
      )}

      {!loading && courses.length > 0 && (
        <Layout style={{ height: 'calc(100vh - 64px)', background: '#f5f5f5', overflow: 'hidden' }}>
          {/* ── 左侧：课程分类导航（可折叠） ── */}
          <Sider
            width={260}
            collapsedWidth={64}
            collapsible
            collapsed={siderCollapsed}
            onCollapse={setSiderCollapsed}
            trigger={null}
            style={{
              background: '#fff',
              borderRight: '1px solid #f0f0f0',
              overflow: 'auto',
              height: '100%',
            }}
          >
            {/* 折叠/展开切换按钮 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: 48,
                borderBottom: '1px solid #f0f0f0',
                cursor: 'pointer',
                color: '#666',
                fontSize: 16,
              }}
              onClick={() => setSiderCollapsed(!siderCollapsed)}
            >
              {siderCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </div>

            {/* 未折叠时显示完整导航 */}
            {!siderCollapsed && (
              <>
                {/* 侧栏头部 */}
                <div style={{ padding: '16px 16px 12px', borderBottom: '1px solid #f0f0f0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <Typography.Title level={5} style={{ margin: 0 }}>
                      {isStudent ? t('studentGuide') : t('courseTitle')}
                    </Typography.Title>
                    <Button size="small" icon={<ReloadOutlined />} onClick={loadTree} />
                  </div>
                  {isTeacherOrAdmin && (
                    <Space wrap style={{ marginBottom: 8 }}>
                      <Button size="small" type="primary" icon={<PlusOutlined />} onClick={handleCreateCourse}>
                        {t('newCourse')}
                      </Button>
                      <Button size="small" icon={<RobotOutlined />} onClick={() => setAiGeneratorOpen(true)}>
                        {t('aiImport')}
                      </Button>
                    </Space>
                  )}
                </div>

                {/* 课程分类列表 */}
                <div style={{ padding: '8px 0' }}>
                  {groupedCourses.map(({ subject, courses: subjectCourses }) => {
                    const isExpanded = expandedSubjects.includes(subject)
                    // 为每个大类选择一个图标
                    const subjectIcons: Record<string, string> = {
                      '通用技术': '🔧',
                      '信息科技': '💻',
                      '人工智能': '🤖',
                    }
                    const subjectIcon = subjectIcons[subject] || '📂'

                    return (
                      <div key={subject} style={{ marginBottom: 2 }}>
                        {/* 大类标题 — 可点击展开/收起 */}
                        <div
                          onClick={() => toggleSubject(subject)}
                          style={{
                            padding: '11px 16px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 15,
                            fontWeight: 700,
                            color: '#333',
                            userSelect: 'none',
                            borderRadius: 0,
                            transition: 'all 0.2s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = '#f5f5f5' }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                        >
                          <span style={{ fontSize: 13, width: 20, textAlign: 'center', color: '#999' }}>
                            {isExpanded ? <DownOutlined /> : <RightOutlined />}
                          </span>
                          <span style={{ fontSize: 18 }}>{subjectIcon}</span>
                          <span style={{ flex: 1, letterSpacing: 1 }}>{subject}</span>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {subjectCourses.length}
                          </Typography.Text>
                        </div>

                        {/* 课程列表（展开时显示） */}
                        {isExpanded && subjectCourses.map((course) => (
                          <div
                            key={course.id}
                            onClick={(e) => { e.stopPropagation(); handleSelectCourse(course.id) }}
                            style={{
                              padding: '9px 16px 9px 48px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              fontSize: 14,
                              color: activeCourseId === course.id ? '#1677ff' : '#333',
                              background: activeCourseId === course.id ? '#e6f4ff' : 'transparent',
                              borderRight: activeCourseId === course.id ? '3px solid #1677ff' : '3px solid transparent',
                              transition: 'all 0.2s',
                            }}
                            onMouseEnter={(e) => {
                              if (activeCourseId !== course.id) {
                                e.currentTarget.style.background = '#f5f5f5'
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (activeCourseId !== course.id) {
                                e.currentTarget.style.background = 'transparent'
                              }
                            }}
                          >
                            <BookOutlined style={{ fontSize: 14 }} />
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {course.name}
                            </span>
                            {isStudent && course.progress && (
                              <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                                {course.progress.completed}/{course.progress.total}
                              </Typography.Text>
                            )}
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              </>
            )}

            {/* 折叠时只显示分类图标 */}
            {siderCollapsed && (
              <div style={{ padding: '8px 0' }}>
                {groupedCourses.map(({ subject, courses: subjectCourses }) => {
                  const subjectIcons: Record<string, string> = {
                    '通用技术': '🔧',
                    '信息科技': '💻',
                    '人工智能': '🤖',
                  }
                  const subjectIcon = subjectIcons[subject] || '📂'
                  const isActive = subjectCourses.some((c) => c.id === activeCourseId)

                  return (
                    <Tooltip key={subject} title={subject} placement="right">
                      <div
                        onClick={() => {
                          // 折叠时点击图标展开该分类
                          setExpandedSubjects((prev) =>
                            prev.includes(subject) ? prev : [...prev, subject]
                          )
                          setSiderCollapsed(false)
                        }}
                        style={{
                          padding: '12px 0',
                          textAlign: 'center',
                          cursor: 'pointer',
                          fontSize: 20,
                          color: isActive ? '#1677ff' : '#999',
                          background: isActive ? '#e6f4ff' : 'transparent',
                          borderLeft: isActive ? '3px solid #1677ff' : '3px solid transparent',
                          transition: 'all 0.2s',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = '#f5f5f5' }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = isActive ? '#e6f4ff' : 'transparent'
                        }}
                      >
                        {subjectIcon}
                      </div>
                    </Tooltip>
                  )
                })}
              </div>
            )}
          </Sider>

          {/* ── 右侧：课程内容区域 ── */}
          <Content style={{ padding: '0 12px', overflow: 'auto', height: '100%' }}>
            {!activeCourse ? (
              <div style={{ textAlign: 'center', padding: '120px 40px' }}>
                <BookOutlined style={{ fontSize: 64, color: '#d9d9d9', marginBottom: 24 }} />
                <Typography.Title level={4} type="secondary" style={{ margin: '0 0 8px' }}>
                  {t('selectCourseFromLeft')}
                </Typography.Title>
                <Typography.Text type="secondary">
                  {t('clickCourseToView')}
                </Typography.Text>
              </div>
            ) : (
              <Row gutter={16}>
                {/* ── 课程树区域 ── */}
                <Col span={selectedKp ? 14 : 24}>
                  <Card
                    title={
                      <Space>
                        <BookOutlined />
                        <span>{activeCourse.name}</span>
                        {isStudent && activeCourse.progress && activeCourse.progress.total > 0 && (
                          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                            ({activeCourse.progress.completed}/{activeCourse.progress.total})
                          </Typography.Text>
                        )}
                      </Space>
                    }
                    extra={
                      <Space>
                        {isTeacherOrAdmin && (
                          <>
                            <Button size="small" icon={<EditOutlined />} onClick={() => handleEditCourse(activeCourse)}>
                              {t('edit')}
                            </Button>
                            <Popconfirm title={t('confirmDeleteCourse')} onConfirm={() => handleDeleteCourse(activeCourse.id)} okText={t('confirm')} cancelText={t('cancel')}>
                              <Button size="small" danger icon={<DeleteOutlined />}>
                                {t('delete')}
                              </Button>
                            </Popconfirm>
                            <Button size="small" icon={<PlusOutlined />} onClick={() => handleCreateChapter(activeCourse.id)}>
                              {t('addChapterSection')}
                            </Button>
                            <Tooltip title={showActions ? t('hideActionTooltip') : t('showActionTooltip')}>
                              <Button
                                size="small"
                                icon={<EditOutlined />}
                                type={showActions ? 'primary' : 'default'}
                                onClick={() => setShowActions(!showActions)}
                              >
                                {showActions ? t('hideActions') : t('nodeActions')}
                              </Button>
                            </Tooltip>
                          </>
                        )}
                      </Space>
                    }
                    style={{ marginBottom: 16 }}
                  >
                    {/* 进度条（学生视图） */}
                    {isStudent && activeCourse.progress && activeCourse.progress.total > 0 && (
                      <Progress
                        percent={Math.round(activeCourse.progress.completed / activeCourse.progress.total * 100)}
                        size="small"
                        format={() => activeCourse.progress ? `${activeCourse.progress.completed}/${activeCourse.progress.total}` : ''}
                        style={{ marginBottom: 12 }}
                      />
                    )}
                    {/* 课程描述 */}
                    {activeCourse.description && (
                      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                        {activeCourse.description}
                      </Typography.Paragraph>
                    )}
                    {/* 课程树 */}
                    <Tree
                      treeData={buildTreeData(activeCourse)}
                      defaultExpandAll
                      showLine={{ showLeafIcon: false }}
                      onSelect={handleTreeSelect}
                      draggable={isTeacherOrAdmin}
                      onDrop={handleTreeDrop}
                      style={{ background: 'transparent' }}
                    />
                  </Card>
                </Col>

                {/* ── 右侧：知识点详情面板 ── */}
                {selectedKp && (
                  <Col span={10}>
                    <Card
                      title={
                        <Space>
                          <NodeIndexOutlined />
                          <span>{selectedKp.name}</span>
                        </Space>
                      }
                      loading={kpLoading}
                      extra={
                        <Space>
                          {isTeacherOrAdmin && (
                            <Tooltip title={t('aiGenerateLessonPlan')}>
                              <Button type="link" size="small" icon={<RobotOutlined />}
                                loading={lessonPlanLoading}
                                onClick={() => handleAiLessonPlan(selectedKp.id)}>
                                {t('aiLessonPlan')}
                              </Button>
                            </Tooltip>
                          )}
                          {isTeacherOrAdmin && (
                            <Tooltip title={t('aiRecommendResource')}>
                              <Button type="link" size="small" icon={<RobotOutlined />}
                                onClick={() => handleAiRecommend(selectedKp.id)}>
                                {t('aiRecommend')}
                              </Button>
                            </Tooltip>
                          )}
                          {isTeacherOrAdmin && (
                            <Tooltip title={t('aiGenerateCourseware')}>
                              <Button type="link" size="small" icon={<FileOutlined />}
                                onClick={() => handleAiCourseware(selectedKp.id)}>
                                {t('aiCourseware')}
                              </Button>
                            </Tooltip>
                          )}
                          {isTeacherOrAdmin && (
                            <Tooltip title={t('aiGeneratePractice')}>
                              <Button type="link" size="small" icon={<FormOutlined />}
                                onClick={() => handleAiPractice(selectedKp.id)}>
                                {t('aiPractice')}
                              </Button>
                            </Tooltip>
                          )}
                          {isStudent && (
                            <>
                              {selectedKp.progress_status !== 'completed' && (
                                <Button
                                  type="primary"
                                  size="small"
                                  icon={<CheckCircleOutlined />}
                                  onClick={() => handleUpdateProgress(selectedKp.id, 'completed')}
                                >
                                  {t('cyMarkDone')}
                                </Button>
                              )}
                              {selectedKp.progress_status === 'not_started' && (
                                <Button
                                  size="small"
                                  icon={<ClockCircleOutlined />}
                                  onClick={() => handleUpdateProgress(selectedKp.id, 'in_progress')}
                                >
                                  {t('cyStartLearn')}
                                </Button>
                              )}
                            </>
                          )}
                        </Space>
                      }
                    >
                      {/* 知识点信息 */}
                      {selectedKp.description && (
                        <Typography.Paragraph>{selectedKp.description}</Typography.Paragraph>
                      )}
                      {selectedKp.learning_objectives && (
                        <div style={{ marginBottom: 12 }}>
                          <Typography.Text strong>{t('learningObjectives')}：</Typography.Text>
                          <Typography.Paragraph>{selectedKp.learning_objectives}</Typography.Paragraph>
                        </div>
                      )}
                      <Space style={{ marginBottom: 12 }}>
                        <Tag color={DIFFICULTY_COLORS[selectedKp.difficulty]}>
                          {t(DIFFICULTY_LABELS[selectedKp.difficulty]) || selectedKp.difficulty}
                        </Tag>
                        {selectedKp.estimated_minutes > 0 && (
                          <Tag icon={<ClockCircleOutlined />}>{t('kpMinutes', { minutes: selectedKp.estimated_minutes })}</Tag>
                        )}
                        {isStudent && selectedKp.progress_status && (
                          <Tag color={STATUS_COLORS[selectedKp.progress_status]}>
                            {t(STATUS_LABELS[selectedKp.progress_status])}
                          </Tag>
                        )}
                      </Space>

                      {/* 绑定的资源列表 */}
                      <Typography.Title level={5} style={{ marginTop: 16 }}>
                        {t('relatedResources')}
                      </Typography.Title>
                      {kpResources.length === 0 ? (
                        <Typography.Text type="secondary">{t('noRelatedResources')}</Typography.Text>
                      ) : (
                        <Space orientation="vertical" style={{ width: '100%' }}>
                          {kpResources.map((r) => {
                            const isFileType = r.resource_type === 'html' || r.resource_type === 'download'
                            const handleClick = () => {
                              // 如果是学生点击文件资源，记录查看事件
                              if (isStudent && isFileType && r.resource_url) {
                                import('../api/tracking').then(mod => {
                                  mod.logResourceView({
                                    resource_type: r.resource_type,
                                    resource_id: r.resource_id,
                                    knowledge_point_id: selectedKp?.id,
                                    binding_id: r.binding_id,
                                    source: 'curriculum',
                                    file_path: r.resource_url.replace('/api/files/', ''),
                                  });
                                });
                              }
                              if (r.resource_url) {
                                if (isFileType) {
                                  window.open(r.resource_url, '_blank');
                                } else {
                                  window.location.href = r.resource_url;
                                }
                              }
                            };
                            return (
                              <Card
                                key={r.binding_id}
                                size="small"
                                hoverable
                                style={{ cursor: r.resource_url ? 'pointer' : 'default' }}
                                onClick={handleClick}
                              >
                                <Space>
                                  {RESOURCE_ICONS[r.resource_type] || <FileOutlined />}
                                  <Typography.Text style={{ color: r.resource_url ? '#1677ff' : undefined }}>
                                    {r.resource_name || `[${r.resource_type}:${r.resource_id}]`}
                                  </Typography.Text>
                                  <Tag>{t(RESOURCE_LABELS[r.resource_type]) || r.resource_type}</Tag>
                                  {/* 教师端显示浏览统计 */}
                                  {isTeacherOrAdmin && r.view_stats && (
                                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                      {t('views')}{r.view_stats.unique_viewers}/{r.view_stats.total_views}
                                    </Typography.Text>
                                  )}
                                  {/* 学生端显示是否已查看 */}
                                  {isStudent && r.viewed !== undefined && (
                                    <Tag color={r.viewed ? 'success' : 'default'} style={{ fontSize: 11 }}>
                                      {r.viewed ? t('viewed') : t('notViewed')}
                                    </Tag>
                                  )}
                                </Space>
                              </Card>
                            )
                          })}
                        </Space>
                      )}

                      {/* 绑定资源按钮（教师） */}
                      {isTeacherOrAdmin && (
                        <Button
                          type="dashed"
                          block
                          icon={<PlusOutlined />}
                          style={{ marginTop: 12 }}
                          onClick={() => {
                            setBinderKpId(selectedKp.id)
                            setBinderKpName(selectedKp.name)
                            setBinderOpen(true)
                          }}
                        >
                          {t('manageBindResources')}
                        </Button>
                      )}
                    </Card>
                  </Col>
                )}
              </Row>
            )}
          </Content>
        </Layout>
      )}

      {/* ── 课程编辑弹窗 ── */}
      <Modal
        title={editingCourse ? t('editCourse') : t('newCourse')}
        open={courseModal}
        onOk={handleSaveCourse}
        onCancel={() => setCourseModal(false)}
        confirmLoading={savingCourse}
      >
        <Form form={courseForm} layout="vertical">
          <Form.Item name="subject" label={t('subject')} rules={[{ required: true, message: t('selectSubjectRequired') }]}>
            <Select placeholder={t('selectSubjectPlaceholder')}>
              {subjectOptions.length > 0 ? subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>) : (
                <Option value="" disabled>{t('noSubjectConfig')}</Option>
              )}
            </Select>
          </Form.Item>
          <Form.Item name="name" label={t('courseName')} rules={[{ required: true, message: t('courseNameRequired') }]}>
            <Input placeholder={t('courseNamePlaceholder')} />
          </Form.Item>
          <Form.Item name="code" label={t('courseCode')}>
            <Input placeholder={t('codePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('courseDescription')}>
            <TextArea rows={3} placeholder={t('descriptionPlaceholder')} />
          </Form.Item>
          <Form.Item name="grade" label={t('gradeApplicable')}>
            <Select
              mode="tags"
              placeholder={t('gradePlaceholder')}
              tokenSeparators={[',', '|']}
              onChange={(vals: string[]) => {
                courseForm.setFieldValue('grade', vals.join('|'))
              }}
            >
              {gradeOptions.map(g => <Option key={g} value={g}>{g}</Option>)}
            </Select>
          </Form.Item>
          <Form.Item name="sort_order" label={t('sortOrder')}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 章节编辑弹窗 ── */}
      <Modal
        title={editingChapter ? t('editChapter') : t('addChapter')}
        open={chapterModal}
        onOk={handleSaveChapter}
        onCancel={() => setChapterModal(false)}
        confirmLoading={savingChapter}
      >
        <Form form={chapterForm} layout="vertical">
          <Form.Item name="course_id" label={t('belongingCourse')} rules={[{ required: true }]}>
            <Select placeholder={t('selectCourse')}>
              {courses.map((c) => (
                <Option key={c.id} value={c.id}>{c.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="parent_id" label={t('parentChapter')}>
            <Select
              allowClear
              placeholder={t('parentChapterPlaceholder')}
            >
              {activeCourse?.chapters?.map((ch) => (
                <Option key={ch.id} value={ch.id}>{ch.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="name" label={t('name')} rules={[{ required: true, message: t('nameRequired') }]}>
            <Input placeholder={t('chapterNamePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('description')}>
            <TextArea rows={2} />
          </Form.Item>
          <Form.Item name="sort_order" label={t('cySortOrder')}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 知识点编辑弹窗 ── */}
      <Modal
        title={editingKp ? t('editKnowledgePoint') : t('addKnowledgePoint')}
        open={kpModal}
        onOk={handleSaveKp}
        onCancel={() => setKpModal(false)}
        confirmLoading={savingKp}
      >
        <Form form={kpForm} layout="vertical">
          <Form.Item name="chapter_id" label={t('belongingChapter')} rules={[{ required: true }]}>
            <Select placeholder={t('selectChapter')}>
              {activeCourse?.chapters?.map((ch) => (
                <Option key={ch.id} value={ch.id}>{ch.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="name" label={t('kpName')} rules={[{ required: true, message: t('kpNameRequired') }]}>
            <Input placeholder={t('kpNamePlaceholder')} />
          </Form.Item>
          <Form.Item name="description" label={t('description')}>
            <TextArea rows={2} placeholder={t('kpDescriptionPlaceholder')} />
          </Form.Item>
          <Form.Item name="learning_objectives" label={t('learningObjectives')}>
            <TextArea rows={2} placeholder={t('learningObjectivesPlaceholder')} />
          </Form.Item>
          <Form.Item name="difficulty" label={t('difficulty')}>
            <Select>
              <Option value="easy">{t('difficultyEasy')}</Option>
              <Option value="medium">{t('difficultyMedium')}</Option>
              <Option value="hard">{t('difficultyHard')}</Option>
            </Select>
          </Form.Item>
          <Form.Item name="estimated_minutes" label={t('estimatedMinutes')}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="sort_order" label={t('sortOrder')}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      {/* ── AI 生成课程弹窗 ── */}
      <AICurriculumGenerator
        open={aiGeneratorOpen}
        onClose={() => setAiGeneratorOpen(false)}
        onSuccess={() => {
          setAiGeneratorOpen(false)
          loadTree()
        }}
      />

      {/* ── 资源绑定弹窗 ── */}
      <ResourceBinder
        kpId={binderKpId}
        kpName={binderKpName}
        open={binderOpen}
        onClose={() => setBinderOpen(false)}
        onRefresh={() => {
          // 刷新课程树和当前知识点的资源列表
          loadTree()
          if (selectedKp) {
            curriculumApi.getKpResources(selectedKp.id).then((res) => {
              setKpResources(res.resources)
            }).catch(() => {})
          }
        }}
      />

      {/* ── AI 备课结果弹窗 ── */}
      <Modal
        title={<><RobotOutlined style={{ color: '#1677ff' }} /> {t('aiLessonPlanTitle')} - {lessonPlanData?.knowledge_point || t('generating')}</>}
        open={lessonPlanModal}
        onCancel={() => { if (lessonPlanLoading) return; setLessonPlanModal(false) }}
        width={800}
        footer={
          lessonPlanLoading ? null : (
            <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <Button icon={<DownloadOutlined />} onClick={() => {
                if (!lessonPlanData) { message.warning(t('generateLessonPlanFirst')); return }
                if (!selectedKp) { message.warning(t('noKpSelected')); return }
                window.open(`/api/curriculum/ai-lesson-plan/${selectedKp.id}/export`, '_blank')
              }}>{t('exportWord')}</Button>
              <Button onClick={() => setLessonPlanModal(false)}>{t('close')}</Button>
            </Space>
          )
        }
      >
        {lessonPlanLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#666' }}>{t('aiGeneratingLessonPlan')}</div>
          </div>
        ) : lessonPlanData ? (
          <div style={{ maxHeight: '70vh', overflow: 'auto', fontSize: 14, lineHeight: 1.8, padding: '0 4px' }}>
            <div className="markdown-content">
              <ReactMarkdown>{lessonPlanData.lesson_plan}</ReactMarkdown>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ── AI 资源推荐弹窗 ── */}
      <Modal
        title={<><RobotOutlined style={{ color: '#1677ff' }} /> {t('aiRecommendTitle')}</>}
        open={recModal}
        onCancel={() => { if (recLoading) return; setRecModal(false) }}
        width={700}
        footer={recLoading ? null : <Button onClick={() => setRecModal(false)}>{t('close')}</Button>}
      >
        {recLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#666' }}>{t('aiAnalyzing')}</div>
          </div>
        ) : recResults.length === 0 ? (
          <Empty description={t('noRecommendations')} />
        ) : (
          <div style={{ maxHeight: '70vh', overflow: 'auto', padding: '0 4px' }}>
            <Space style={{ marginBottom: 16 }} wrap>
              <Tag icon={<RobotOutlined />} color="blue">{t('totalRecommendations', { count: recResults.length })}</Tag>
              {recResults.filter(r => r.relevance === 'high').length > 0 && (
                <Tag color="green">{t('highRelevanceCount', { count: recResults.filter(r => r.relevance === 'high').length })}</Tag>
              )}
            </Space>
            {recResults.map((r, i) => {
              const relevanceColor = r.relevance === 'high' ? '#52c41a' : r.relevance === 'medium' ? '#faad14' : '#d9d9d9'
              const relevanceLabel = r.relevance === 'high' ? t('highRelevance') : r.relevance === 'medium' ? t('mediumRelevance') : t('lowRelevance')
              return (
                <Card key={i} size="small" style={{ marginBottom: 8 }}>
                  <Space orientation="vertical" style={{ width: '100%' }}>
                    <Space>
                      <span style={{ fontSize: 18 }}>{r.resource_icon}</span>
                      <Typography.Text strong>{r.title}</Typography.Text>
                      <Tag>{r.resource_type_label}</Tag>
                      <Tag color={relevanceColor}>{relevanceLabel}</Tag>
                    </Space>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>{r.reason}</Typography.Text>
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<PlusOutlined />}
                      loading={recBindLoading[r.resource_id]}
                      onClick={() => handleBindRecommended(r.resource_type, r.resource_id)}
                    >
                      {t('cyBindToKp')}
                    </Button>
                  </Space>
                </Card>
              )
            })}
          </div>
        )}
      </Modal>

      {/* ── AI 课件生成弹窗 ── */}
      <Modal
        title={<><FileOutlined style={{ color: '#1677ff' }} /> {t('aiCoursewareTitle')}</>}
        open={cwModal}
        onCancel={() => { if (cwLoading) return; setCwModal(false) }}
        width={900}
        footer={
          cwLoading ? null : (
            <Space>
              <a href={cwUrl} download style={{ textDecoration: 'none' }}>
                <Button type="primary" icon={<DownloadOutlined />} disabled={!cwUrl}>
                  {t('cyDownloadCourseware')}
                </Button>
              </a>
              <Button icon={<FileTextOutlined />} disabled={!cwUrl}
                onClick={() => { if (cwUrl) window.open(cwUrl, '_blank') }}>
                {t('cyOpenNewTab')}
              </Button>
              <Button onClick={() => setCwModal(false)}>{t('cyClose')}</Button>
            </Space>
          )
        }
      >
        {cwLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#666' }}>{t('aiGeneratingCourseware')}</div>
          </div>
        ) : cwUrl ? (
          <div style={{ height: '70vh', border: '1px solid #d9d9d9', borderRadius: 4, overflow: 'hidden' }}>
            <iframe src={cwUrl} style={{ width: '100%', height: '100%', border: 'none' }} title={t('cyCoursewarePreview')} />
          </div>
        ) : null}
      </Modal>

      {/* ── AI 练习弹窗（参考资源中心 AI 生成样式） ── */}
      <Modal
        title={<><FormOutlined style={{ color: '#1677ff' }} /> 🤖 {t('aiPracticeTitle')} - {selectedKp?.name || ''}</>}
        open={practiceModal}
        onCancel={() => { if (practiceLoading) return; setPracticeModal(false); setPracticeDone(null); setPracticeHtmlUrl(''); }}
        width={620}
        footer={null}
        destroyOnHidden
      >
        {practiceLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#666' }}>
              {t('cyGenPracticeWait')}
              <br /><span style={{ fontSize: 13 }}>{t('autoGenerateHtml')}</span>
            </div>
          </div>
        ) : practiceDone ? (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <Typography.Text type="success" style={{ fontSize: 16, display: 'block', marginBottom: 16 }}>
              ✅ {t('cyPracticeReady')}
            </Typography.Text>
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Button type="primary" size="large" icon={<EyeOutlined />}
                href={practiceDone.fileUrl} target="_blank" rel="noopener noreferrer"
                block>
                {t('cyOpenPreview')}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {t('cyPracticeHint')}
              </Typography.Text>
              <Button onClick={() => { setPracticeModal(false); setPracticeDone(null); setPracticeHtmlUrl(''); }} block>
                {t('cyDone')}
              </Button>
            </Space>
          </div>
        ) : (
          <Space orientation="vertical" style={{ width: '100%' }} size={16}>
            {/* 知识点 */}
            <div>
              <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>{t('kpLabel')} <span style={{ color: '#ff4d4f' }}>*</span></Typography.Text>
              <Input value={practiceTopic} onChange={(e) => setPracticeTopic(e.target.value)} placeholder={t('enterKpName')} />
            </div>

            {/* 学科 & 年级 */}
            <Space>
              <div>
                <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>{t('practiceSubject')}</Typography.Text>
                <Select
                  value={practiceSubject || undefined}
                  onChange={(v) => setPracticeSubject(v || '')}
                  allowClear
                  placeholder={t('selectSubjectOptional')}
                  style={{ width: 180 }}
                  options={practiceSubjectOptions.map(s => ({ value: s, label: s }))}
                />
              </div>
              <div>
                <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>{t('practiceGrade')}</Typography.Text>
                <Select
                  value={practiceGrade || undefined}
                  onChange={(v) => setPracticeGrade(v || '')}
                  allowClear
                  placeholder={t('selectGradeOptional')}
                  style={{ width: 140 }}
                  options={practiceGradeOptions.map(g => ({ value: g, label: g }))}
                />
              </div>
            </Space>

            {/* 视觉主题选择 */}
            {practiceThemes.length > 0 && (
              <div>
                <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>{t('visualTheme')}</Typography.Text>
                <Select
                  value={practiceTheme || undefined}
                  onChange={(v) => setPracticeTheme(v || '')}
                  style={{ width: '100%' }}
                  placeholder={t('selectTheme')}
                  options={practiceThemes.map(t => ({
                    value: t.id,
                    label: `${t.icon} ${t.name} — ${t.desc}`,
                  }))}
                />
              </div>
            )}

            {/* 生成按钮 */}
            <Button type="primary" block size="large"
              icon={<BulbOutlined />}
              onClick={handleAiPracticeGenerate}
            >
              🚀 {t('cyGenPractice')}
            </Button>
          </Space>
        )}
      </Modal>
    </Layout>
  )
}

export default CurriculumPage
