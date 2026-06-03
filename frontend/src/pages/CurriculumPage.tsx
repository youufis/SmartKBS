import React, { useState, useEffect, useCallback } from 'react'
import {
  Layout, Card, Tree, Tabs, Button, message, Modal, Form, Input, Select, InputNumber,
  Tag, Space, Typography, Tooltip, Popconfirm, Row, Col, Spin, Empty, Progress,
} from 'antd'
import type { DataNode } from 'antd/es/tree'
import {
  BookOutlined, PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  FileOutlined, DownloadOutlined, QuestionCircleOutlined, FormOutlined,
  TeamOutlined, CheckCircleOutlined, ClockCircleOutlined,
  MenuOutlined, NodeIndexOutlined, RobotOutlined,
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
  easy: '简单',
  medium: '中等',
  hard: '困难',
}

const STATUS_LABELS: Record<string, string> = {
  not_started: '未开始',
  in_progress: '学习中',
  completed: '已完成',
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
  html: 'HTML 资源',
  download: '下载文件',
  question: '试题',
  exam: '考试',
  discussion: '讨论',
  interaction_quiz: '随堂测验',
  task: '任务',
}

const CurriculumPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  // ── 从系统配置加载课程名称列表 ──
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjectOptions(data.subjects)
    }).catch(() => {})
  }, [])

  // ── 课程树数据 ──
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(false)
  const [activeCourseId, setActiveCourseId] = useState<number | null>(null)

  // ── 课程创建/编辑 ──
  const [courseModal, setCourseModal] = useState(false)
  const [editingCourse, setEditingCourse] = useState<Course | null>(null)
  const [courseForm] = Form.useForm()
  const [savingCourse, setSavingCourse] = useState(false)

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
          message.error(result?.error || 'AI 备课失败')
          setLessonPlanModal(false)
        }
      } else {
        setLessonPlanData(data)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || 'AI 备课失败')
      setLessonPlanModal(false)
    } finally {
      setLessonPlanLoading(false)
    }
  }

  // ── 资源绑定弹窗 ──
  const [binderOpen, setBinderOpen] = useState(false)
  const [binderKpId, setBinderKpId] = useState(0)
  const [binderKpName, setBinderKpName] = useState('')

  // ── AI 生成课程弹窗 ──
  const [aiGeneratorOpen, setAiGeneratorOpen] = useState(false)

  // ── 教师操作图标显隐 ──
  const [showActions, setShowActions] = useState(false)

  // ── 加载课程树 ──
  const loadTree = useCallback(async () => {
    setLoading(true)
    try {
      const data = await curriculumApi.getCurriculumTree()
      setCourses(data)
      if (data.length > 0 && !activeCourseId) {
        setActiveCourseId(data[0].id)
      }
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || '加载课程数据失败')
    } finally {
      setLoading(false)
    }
  }, [activeCourseId])

  useEffect(() => {
    const fetchData = async () => {
      await loadTree()
    }
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        message.success('课程更新成功')
      } else {
        await curriculumApi.createCourse(values)
        message.success('课程创建成功')
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
      message.success('课程已删除')
      loadTree()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || '删除失败')
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
        message.success('章节更新成功')
      } else {
        await curriculumApi.createChapter(values)
        message.success('章节创建成功')
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
      message.success('章节已删除')
      loadTree()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || '删除失败')
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
        message.success('排序已更新')
        loadTree()
      } catch (err: unknown) {
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        message.error(detail || '操作失败')
        loadTree()
      }
    }

    // ─────────────────────────────────────────────
    // CASE 1: dropToGap = true — 同级间隙拖动（重排）
    // ─────────────────────────────────────────────
    if (dropToGap) {
      if (dragPrefix !== dropPrefix) {
        message.warning('不能在不同类型节点间拖动排序')
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
      message.warning('只能拖入章节节点')
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
        message.warning('不能将章节拖入自身或子章节')
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
        message.info('知识点已在目标章节中')
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
        message.success('知识点更新成功')
      } else {
        await curriculumApi.createKnowledgePoint(values)
        message.success('知识点创建成功')
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
      message.success('知识点已删除')
      loadTree()
      if (selectedKp?.id === kpId) {
        setSelectedKp(null)
        setKpResources([])
      }
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || '删除失败')
    }
  }

  // ── 学习进度 ──
  const handleUpdateProgress = async (kpId: number, status: string) => {
    try {
      await curriculumApi.updateProgress(kpId, status)
      message.success(status === 'completed' ? '标记为已完成' : '状态已更新')
      loadTree()
      // 刷新当前知识点详情
      if (selectedKp?.id === kpId) {
        const kp = await curriculumApi.getKnowledgePoint(kpId)
        setSelectedKp(kp)
      }
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || '更新失败')
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
          <Tooltip title="添加子章节">
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={(e) => { e.stopPropagation(); handleCreateChapter(ch.course_id, ch.id) }}
            />
          </Tooltip>
          <Tooltip title="添加知识点">
            <Button
              type="text"
              size="small"
              icon={<NodeIndexOutlined />}
              onClick={(e) => { e.stopPropagation(); handleCreateKp(ch.id) }}
            />
          </Tooltip>
          <Tooltip title="编辑">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => { e.stopPropagation(); handleEditChapter(ch) }}
            />
          </Tooltip>
          <Popconfirm title="确认删除此章节？" onConfirm={(e) => { e?.stopPropagation(); handleDeleteChapter(ch.id) }} okText="确认" cancelText="取消">
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
        {DIFFICULTY_LABELS[kp.difficulty] || kp.difficulty}
      </Tag>
      {(kp.resource_count ?? 0) > 0 && (
        <Tooltip title={`${kp.resource_count} 个绑定资源`}>
          <Tag color="blue" style={{ fontSize: 11, lineHeight: '18px', cursor: 'default' }}>
            {kp.resource_count}
          </Tag>
        </Tooltip>
      )}
      {kp.estimated_minutes > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {kp.estimated_minutes}分钟
        </Typography.Text>
      )}
      {isStudent && kp.progress_status && (
        <Tag color={STATUS_COLORS[kp.progress_status]} style={{ fontSize: 11, lineHeight: '18px' }}>
          {STATUS_LABELS[kp.progress_status]}
        </Tag>
      )}
      {isTeacherOrAdmin && showActions && (
        <Space size="small" style={{ marginLeft: 4 }}>
          <Tooltip title="编辑知识点">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={(e) => { e.stopPropagation(); handleEditKp(kp) }}
            />
          </Tooltip>
          <Popconfirm title="确认删除此知识点？" onConfirm={() => handleDeleteKp(kp.id)} okText="确认" cancelText="取消">
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

  return (
    <Layout style={{ padding: 24, minHeight: 'calc(100vh - 64px)', background: '#f5f5f5' }}>
      {/* ── 加载中 ── */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin size="large" tip="加载中..." />
        </div>
      )}

      {!loading && courses.length === 0 && (
        <Card>
          <Empty description="暂无课程">
            {isTeacherOrAdmin && (
              <Space>
                <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateCourse}>
                  创建课程
                </Button>
                <Button icon={<RobotOutlined />} onClick={() => setAiGeneratorOpen(true)}>
                  AI 导入
                </Button>
              </Space>
            )}
          </Empty>
        </Card>
      )}

      {!loading && courses.length > 0 && (
        <Row gutter={16} style={{ height: '100%' }}>
          {/* ── 左侧：课程 Tab + 树 ── */}
          <Col span={selectedKp ? 14 : 24}>
            <Card
              title={
                <Space>
                  <BookOutlined />
                  <span>{isStudent ? '课程导学' : '课程管理'}</span>
                  {isTeacherOrAdmin && (
                    <>
                      <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreateCourse}>
                        新建课程
                      </Button>
                      <Button size="small" icon={<RobotOutlined />} onClick={() => setAiGeneratorOpen(true)}>
                        AI 导入
                      </Button>
                    </>
                  )}
                  <Button size="small" icon={<ReloadOutlined />} onClick={loadTree} />
                </Space>
              }
              style={{ marginBottom: 16 }}
            >
              {/* 课程 Tab */}
              <Tabs
                activeKey={String(activeCourseId)}
                onChange={(key) => setActiveCourseId(Number(key))}
                items={courses.map((course) => ({
                  key: String(course.id),
                  label: (
                    <Space size={4}>
                      <BookOutlined />
                      {course.name}
                      {isStudent && course.progress && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          ({course.progress.completed}/{course.progress.total})
                        </Typography.Text>
                      )}
                    </Space>
                  ),
                  children: (
                    <div>
                      {/* 课程进度条（学生视图） */}
                      {isStudent && course.progress && course.progress.total > 0 && (
                        <Progress
                          percent={Math.round(course.progress.completed / course.progress.total * 100)}
                          size="small"
                          format={() => course.progress ? `${course.progress.completed}/${course.progress.total}` : ''}
                          style={{ marginBottom: 12 }}
                        />
                      )}
                      {/* 课程描述 */}
                      {course.description && (
                        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                          {course.description}
                        </Typography.Paragraph>
                      )}
                      {/* 课程操作（教师） */}
                      {isTeacherOrAdmin && (
                        <Space style={{ marginBottom: 12 }}>
                          <Button size="small" icon={<EditOutlined />} onClick={() => handleEditCourse(course)}>
                            编辑课程
                          </Button>
                          <Popconfirm title="确认删除此课程？" onConfirm={() => handleDeleteCourse(course.id)} okText="确认" cancelText="取消">
                            <Button size="small" danger icon={<DeleteOutlined />}>
                              删除课程
                            </Button>
                          </Popconfirm>
                          <Button size="small" icon={<PlusOutlined />} onClick={() => handleCreateChapter(course.id)}>
                            添加章/节
                          </Button>
                          <Tooltip title={showActions ? '隐藏节点操作按钮' : '显示节点操作按钮'}>
                            <Button
                              size="small"
                              icon={showActions ? <EditOutlined /> : <EditOutlined />}
                              type={showActions ? 'primary' : 'default'}
                              onClick={() => setShowActions(!showActions)}
                            >
                              {showActions ? '隐藏操作' : '节点操作'}
                            </Button>
                          </Tooltip>
                        </Space>
                      )}
                      {/* 课程树 */}
                      <Tree
                        treeData={buildTreeData(course)}
                        defaultExpandAll
                        showLine={{ showLeafIcon: false }}
                        onSelect={handleTreeSelect}
                        draggable={isTeacherOrAdmin}
                        onDrop={handleTreeDrop}
                        style={{ background: 'transparent' }}
                      />
                    </div>
                  ),
                }))}
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
                      <Tooltip title="AI 生成教案">
                        <Button type="link" size="small" icon={<RobotOutlined />}
                          loading={lessonPlanLoading}
                          onClick={() => handleAiLessonPlan(selectedKp.id)}>
                          AI 备课
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
                            标记已完成
                          </Button>
                        )}
                        {selectedKp.progress_status === 'not_started' && (
                          <Button
                            size="small"
                            icon={<ClockCircleOutlined />}
                            onClick={() => handleUpdateProgress(selectedKp.id, 'in_progress')}
                          >
                            开始学习
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
                    <Typography.Text strong>学习目标：</Typography.Text>
                    <Typography.Paragraph>{selectedKp.learning_objectives}</Typography.Paragraph>
                  </div>
                )}
                <Space style={{ marginBottom: 12 }}>
                  <Tag color={DIFFICULTY_COLORS[selectedKp.difficulty]}>
                    {DIFFICULTY_LABELS[selectedKp.difficulty] || selectedKp.difficulty}
                  </Tag>
                  {selectedKp.estimated_minutes > 0 && (
                    <Tag icon={<ClockCircleOutlined />}>{selectedKp.estimated_minutes} 分钟</Tag>
                  )}
                  {isStudent && selectedKp.progress_status && (
                    <Tag color={STATUS_COLORS[selectedKp.progress_status]}>
                      {STATUS_LABELS[selectedKp.progress_status]}
                    </Tag>
                  )}
                </Space>

                {/* 绑定的资源列表 */}
                <Typography.Title level={5} style={{ marginTop: 16 }}>
                  关联资源
                </Typography.Title>
                {kpResources.length === 0 ? (
                  <Typography.Text type="secondary">暂无关联资源</Typography.Text>
                ) : (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {kpResources.map((r) => {
                      const isFileType = r.resource_type === 'html' || r.resource_type === 'download'
                      const cardProps = r.resource_url
                        ? isFileType
                          ? { onClick: () => window.open(r.resource_url, '_blank') }
                          : { onClick: () => window.location.href = r.resource_url }
                        : {}
                      return (
                        <Card
                          key={r.binding_id}
                          size="small"
                          hoverable
                          style={{ cursor: r.resource_url ? 'pointer' : 'default' }}
                          {...cardProps}
                        >
                          <Space>
                            {RESOURCE_ICONS[r.resource_type] || <FileOutlined />}
                            <Typography.Text style={{ color: r.resource_url ? '#1677ff' : undefined }}>
                              {r.resource_name || `[${r.resource_type}:${r.resource_id}]`}
                            </Typography.Text>
                            <Tag>{RESOURCE_LABELS[r.resource_type] || r.resource_type}</Tag>
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
                    管理绑定资源
                  </Button>
                )}
              </Card>
            </Col>
          )}
        </Row>
      )}

      {/* ── 课程编辑弹窗 ── */}
      <Modal
        title={editingCourse ? '编辑课程' : '新建课程'}
        open={courseModal}
        onOk={handleSaveCourse}
        onCancel={() => setCourseModal(false)}
        confirmLoading={savingCourse}
      >
        <Form form={courseForm} layout="vertical">
          <Form.Item name="subject" label="所属科目" rules={[{ required: true, message: '请选择科目' }]}>
            <Select placeholder="从系统配置中选择科目">
              {subjectOptions.length > 0 ? subjectOptions.map(s => <Option key={s} value={s}>{s}</Option>) : (
                <Option value="" disabled>⚠️ 请先在系统配置中设置课程名称</Option>
              )}
            </Select>
          </Form.Item>
          <Form.Item name="name" label="课程名称" rules={[{ required: true, message: '请输入课程名称' }]}>
            <Input placeholder="例如：信息科技基础 / 人工智能入门" />
          </Form.Item>
          <Form.Item name="code" label="课程代码">
            <Input placeholder="例如：IT / AI" />
          </Form.Item>
          <Form.Item name="description" label="课程简介">
            <TextArea rows={3} placeholder="简要描述课程内容" />
          </Form.Item>
          <Form.Item name="grade" label="适用年级">
            <Select
              mode="tags"
              placeholder="选择或输入年级（如 高一、高二）"
              tokenSeparators={[',', '|']}
              onChange={(vals: string[]) => {
                courseForm.setFieldValue('grade', vals.join('|'))
              }}
            >
              <Option value="高一">高一</Option>
              <Option value="高二">高二</Option>
            </Select>
          </Form.Item>
          <Form.Item name="sort_order" label="排序号">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 章节编辑弹窗 ── */}
      <Modal
        title={editingChapter ? '编辑章节' : '添加章节'}
        open={chapterModal}
        onOk={handleSaveChapter}
        onCancel={() => setChapterModal(false)}
        confirmLoading={savingChapter}
      >
        <Form form={chapterForm} layout="vertical">
          <Form.Item name="course_id" label="所属课程" rules={[{ required: true }]}>
            <Select placeholder="选择课程">
              {courses.map((c) => (
                <Option key={c.id} value={c.id}>{c.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="parent_id" label="父章节（留空为顶层章）">
            <Select
              allowClear
              placeholder="留空为顶层章"
            >
              {activeCourse?.chapters?.map((ch) => (
                <Option key={ch.id} value={ch.id}>{ch.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入章节名称' }]}>
            <Input placeholder="例如：第一章 走进技术世界" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <TextArea rows={2} />
          </Form.Item>
          <Form.Item name="sort_order" label="排序号">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 知识点编辑弹窗 ── */}
      <Modal
        title={editingKp ? '编辑知识点' : '添加知识点'}
        open={kpModal}
        onOk={handleSaveKp}
        onCancel={() => setKpModal(false)}
        confirmLoading={savingKp}
      >
        <Form form={kpForm} layout="vertical">
          <Form.Item name="chapter_id" label="所属章节" rules={[{ required: true }]}>
            <Select placeholder="选择章节">
              {activeCourse?.chapters?.map((ch) => (
                <Option key={ch.id} value={ch.id}>{ch.name}</Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="name" label="知识点名称" rules={[{ required: true, message: '请输入知识点名称' }]}>
            <Input placeholder="例如：技术的性质" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <TextArea rows={2} placeholder="简要描述该知识点" />
          </Form.Item>
          <Form.Item name="learning_objectives" label="学习目标">
            <TextArea rows={2} placeholder="学习目标（可多行文本或 Markdown）" />
          </Form.Item>
          <Form.Item name="difficulty" label="难度">
            <Select>
              <Option value="easy">简单</Option>
              <Option value="medium">中等</Option>
              <Option value="hard">困难</Option>
            </Select>
          </Form.Item>
          <Form.Item name="estimated_minutes" label="预计学习时长（分钟）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="sort_order" label="排序号">
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
        title={<><RobotOutlined style={{ color: '#1677ff' }} /> AI 备课 - {lessonPlanData?.knowledge_point || ''}</>}
        open={lessonPlanModal}
        onCancel={() => setLessonPlanModal(false)}
        width={800}
        footer={
          <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
            <Button icon={<DownloadOutlined />} onClick={() => {
              if (!lessonPlanData) { message.warning('请先生成教案'); return }
              // 先获取知识点 ID — 从当前选中的知识点获取
              if (!selectedKp) { message.warning('未选中知识点'); return }
              const token = localStorage.getItem('smartkb_token')
              const url = `/api/curriculum/ai-lesson-plan/${selectedKp.id}/export${token ? `?token=${token}` : ''}`
              window.open(url, '_blank')
            }}>导出 Word</Button>
            <Button onClick={() => setLessonPlanModal(false)}>关闭</Button>
          </Space>
        }
      >
        {lessonPlanData && (
          <div style={{ maxHeight: '70vh', overflow: 'auto', fontSize: 14, lineHeight: 1.8, padding: '0 4px' }}>
            <div className="markdown-content">
              <ReactMarkdown>{lessonPlanData.lesson_plan}</ReactMarkdown>
            </div>
          </div>
        )}
      </Modal>
    </Layout>
  )
}

export default CurriculumPage
