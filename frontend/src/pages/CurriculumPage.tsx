import React, { useState, useEffect, useCallback } from 'react'
import {
  Layout, Card, Tree, Tabs, Button, message, Modal, Form, Input, Select, InputNumber,
  Tag, Space, Typography, Tooltip, Popconfirm, Row, Col, Spin, Empty, Progress,
} from 'antd'
import {
  BookOutlined, PlusOutlined, EditOutlined, DeleteOutlined, ReloadOutlined,
  FileOutlined, DownloadOutlined, QuestionCircleOutlined, FormOutlined,
  TeamOutlined, CheckCircleOutlined, ClockCircleOutlined,
  MenuOutlined, NodeIndexOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import * as curriculumApi from '../api/curriculum'
import { useAuthStore } from '../stores/authStore'
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
  const navigate = useNavigate()
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

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
      message.error(detail || '加载课程大纲失败')
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
      {isTeacherOrAdmin && (
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
      {isTeacherOrAdmin && (
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
          <Spin size="large" tip="加载课程大纲..." />
        </div>
      )}

      {!loading && courses.length === 0 && (
        <Card>
          <Empty description="暂无课程">
            {isTeacherOrAdmin && (
              <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateCourse}>
                创建第一个课程
              </Button>
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
                  <span>课程大纲</span>
                  {isTeacherOrAdmin && (
                    <Button type="primary" size="small" icon={<PlusOutlined />} onClick={handleCreateCourse}>
                      新建课程
                    </Button>
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
                        </Space>
                      )}
                      {/* 课程树 */}
                      <Tree
                        treeData={buildTreeData(course)}
                        defaultExpandAll
                        showLine={{ showLeafIcon: false }}
                        onSelect={handleTreeSelect}
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
                  isStudent && (
                    <Space>
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
                    </Space>
                  )
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
                    {kpResources.map((r) => (
                      <Card key={r.binding_id} size="small" hoverable>
                        <Space>
                          {RESOURCE_ICONS[r.resource_type] || <FileOutlined />}
                          <Typography.Text>{r.resource_name || `[${r.resource_type}:${r.resource_id}]`}</Typography.Text>
                          <Tag>{RESOURCE_LABELS[r.resource_type] || r.resource_type}</Tag>
                        </Space>
                      </Card>
                    ))}
                  </Space>
                )}

                {/* 绑定资源按钮（教师） */}
                {isTeacherOrAdmin && (
                  <Button
                    type="dashed"
                    block
                    icon={<PlusOutlined />}
                    style={{ marginTop: 12 }}
                    onClick={() => navigate(`/curriculum/knowledge-point/${selectedKp.id}`)}
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
          <Form.Item name="name" label="课程名称" rules={[{ required: true, message: '请输入课程名称' }]}>
            <Input placeholder="例如：信息技术 / 通用技术" />
          </Form.Item>
          <Form.Item name="code" label="课程代码">
            <Input placeholder="例如：IT / GT" />
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
    </Layout>
  )
}

export default CurriculumPage
