import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Layout, Card, Table, Select, Button, message, Tag, Space, Typography,
  Row, Col, Statistic, Tooltip, Spin,
} from 'antd'
import {
  ReloadOutlined, TeamOutlined, BookOutlined, CheckCircleOutlined,
  ClockCircleOutlined, StopOutlined,
} from '@ant-design/icons'
import * as curriculumApi from '../api/curriculum'
import { useAuthStore } from '../stores/authStore'
import apiClient from '../api/client'

const { Option } = Select

const CurriculumProgressPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  // ── 筛选条件 ──
  const [courses, setCourses] = useState<any[]>([])
  const [courseId, setCourseId] = useState<number | undefined>()
  const [grade, setGrade] = useState<string | undefined>()
  const [className, setClassName] = useState<string | undefined>()

  // ── 班级列表 ──
  const [classOptions, setClassOptions] = useState<string[]>([])
  const [gradeOptions, setGradeOptions] = useState<string[]>([])

  // ── 进度数据 ──
  const [students, setStudents] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [initLoading, setInitLoading] = useState(true)
  const [expandedRowKeys, setExpandedRowKeys] = useState<React.Key[]>([])

  // ── 统计 ──
  const [stats, setStats] = useState({ totalStudents: 0, avgRate: 0, bestCourse: '', bestRate: 0 })

  // ── 标记首次加载完成 ──
  const coursesLoaded = useRef(false)

  // ── 加载课程列表（不默认选中） ──
  useEffect(() => {
    curriculumApi.listCourses().then((res) => {
      setCourses(res.courses)
      coursesLoaded.current = true
      setInitLoading(false)
    }).catch(() => {
      coursesLoaded.current = true
      setInitLoading(false)
    })
  }, [])

  // ── 加载年级/班级选项（教师只能看到自己的年级和班级） ──
  useEffect(() => {
    apiClient.get('/api/scores/my-grades', { params: { teacher: user?.username } })
      .then(({ data }: any) => {
        const grades = Array.isArray(data) ? data : []
        setGradeOptions(grades)
      })
      .catch(() => {})
  }, [user?.username])

  useEffect(() => {
    if (grade) {
      apiClient.get('/api/scores/classes', { params: { grade, teacher: user?.username } })
        .then(({ data }: any) => {
          setClassOptions(Array.isArray(data) ? data : [])
        })
        .catch(() => setClassOptions([]))
    } else {
      setClassOptions([])
    }
  }, [grade, user?.username])

  // ── 加载进度数据（仅在筛选条件就绪时） ──
  const loadData = useCallback(async () => {
    if (!courseId) return
    setLoading(true)
    try {
      const params: Record<string, unknown> = { course_id: courseId }
      if (grade) params.grade = grade
      if (className) {
        const match = String(className).match(/(\d+)/)
        params.class_name = match ? match[1] : className
      }
      const res = await curriculumApi.getClassProgressOverview(params)
      setStudents(res.students || [])
      // 默认展开第一个学生
      if (res.students?.length > 0) {
        setExpandedRowKeys([res.students[0].username])
      }

      // 计算统计
      const total = res.students?.length || 0
      let totalRate = 0
      let bestRate = 0
      let bestCourse = ''
      if (total > 0) {
        for (const stu of res.students) {
          for (const c of stu.courses || []) {
            totalRate += c.rate
            if (c.rate > bestRate) {
              bestRate = c.rate
              bestCourse = c.course_name || ''
            }
          }
        }
        totalRate = totalRate / total
      }
      setStats({ totalStudents: total, avgRate: totalRate, bestCourse, bestRate })
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || '加载学情数据失败')
    } finally {
      setLoading(false)
    }
  }, [courseId, grade, className])

  // ── 筛选条件变化时重新加载（仅当用户主动选择过课程） ──
  useEffect(() => {
    if (!isTeacherOrAdmin || !courseId) return
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, grade, className])

  // ── 展开行渲染：知识点明细 ──
  const renderExpandedRow = (record: Record<string, unknown>) => {
    const stuCourses = (record.courses as Record<string, unknown>[] | undefined) || []
    if (stuCourses.length === 0) {
      return <Typography.Text type="secondary">暂无可选课程</Typography.Text>
    }

    // 找当前选中课程的详情
    const courses = stuCourses
    const courseDetail = courses.find((c: any) => c.course_id === courseId) || courses[0]
    const details = (courseDetail?.details as any[]) || []

    return (
      <div style={{ padding: '8px 0' }}>
        <Space wrap>
          {details.map((d: any) => (
            <Tooltip key={d.kp_id} title={d.kp_name}>
              <Tag
                color={
                  d.status === 'completed' ? 'success' :
                  d.status === 'in_progress' ? 'processing' : 'default'
                }
                style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer', maxWidth: 160 }}
              >
                <Typography.Text ellipsis style={{ maxWidth: 120, display: 'inline-block' }}>
                  {d.kp_name}
                </Typography.Text>
              </Tag>
            </Tooltip>
          ))}
        </Space>
        {details.length === 0 && (
          <Typography.Text type="secondary">该课程暂无知识点</Typography.Text>
        )}
      </div>
    )
  }

  // ── 表格列定义 ──
  const columns = [
    {
      title: '姓名',
      dataIndex: 'name',
      key: 'name',
      width: 100,
      fixed: 'left' as const,
      render: (name: string) => (
        <Space>
          <TeamOutlined />
          <Typography.Text strong>{name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '年级',
      dataIndex: 'grade',
      key: 'grade',
      width: 80,
    },
    {
      title: '班级',
      dataIndex: 'class',
      key: 'class',
      width: 80,
    },
    {
      title: '课程完成率',
      key: 'courses',
      render: (_: any, record: any) => {
        if (!record.courses || record.courses.length === 0) {
          return <Typography.Text type="secondary">—</Typography.Text>
        }
        const courseDetail = record.courses.find((c: any) => c.course_id === courseId) || record.courses[0]
        if (!courseDetail) return <Typography.Text type="secondary">—</Typography.Text>
        const { completed_kps, total_kps, rate } = courseDetail
        return (
          <Tooltip title={`${completed_kps}/${total_kps} (${rate}%)`}>
            <Space>
              <div
                style={{
                  width: 120,
                  height: 20,
                  background: '#f0f0f0',
                  borderRadius: 10,
                  overflow: 'hidden',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    width: `${rate}%`,
                    height: '100%',
                    background: rate >= 80 ? '#52c41a' : rate >= 40 ? '#faad14' : '#ff4d4f',
                    borderRadius: 10,
                    transition: 'width 0.3s',
                  }}
                />
              </div>
              <Typography.Text style={{ fontSize: 12, minWidth: 40 }}>
                {rate}%
              </Typography.Text>
            </Space>
          </Tooltip>
        )
      },
    },
  ]

  if (!isTeacherOrAdmin) {
    return (
      <Layout style={{ padding: 24, background: '#f5f5f5', minHeight: 'calc(100vh - 64px)' }}>
        <Card>
          <Typography.Text type="secondary">权限不足，仅教师和管理员可查看学情进度</Typography.Text>
        </Card>
      </Layout>
    )
  }

  if (initLoading) {
    return (
      <Layout style={{ padding: 24, background: '#f5f5f5', minHeight: 'calc(100vh - 64px)' }}>
        <Card><div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" tip="正在加载数据..." /></div></Card>
      </Layout>
    )
  }

  if (!courseId) {
    // 只显示筛选条件栏，不加载数据
    return (
      <Layout style={{ padding: 24, background: '#f5f5f5', minHeight: 'calc(100vh - 64px)' }}>
        <Card style={{ marginBottom: 16 }}>
          <Space wrap>
            <Select value={courseId} placeholder="选择课程" style={{ width: 240 }}
              onChange={v => setCourseId(v)}
              options={courses.map(c => ({ value: c.id, label: c.name }))} />
            <Select value={grade} placeholder="选择年级" style={{ width: 140 }}
              onChange={v => setGrade(v)} allowClear
              options={gradeOptions.map(g => ({ value: g, label: g }))} />
            <Select value={className} placeholder="选择班级" style={{ width: 140 }}
              onChange={v => setClassName(v)} allowClear disabled={!grade || classOptions.length === 0}
              options={classOptions.map(c => ({ value: c, label: c }))} />
          </Space>
        </Card>
        <Card>
          <div style={{ textAlign: 'center', padding: 80 }}>
            <Typography.Text type="secondary" style={{ fontSize: 16 }}>请选择课程查看学生进度数据</Typography.Text>
          </div>
        </Card>
      </Layout>
    )
  }

  return (
    <Layout style={{ padding: 24, background: '#f5f5f5', minHeight: 'calc(100vh - 64px)' }}>
      {/* ── 统计卡片 ── */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="学生总数"
              value={stats.totalStudents}
              prefix={<TeamOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="平均完成率"
              value={stats.avgRate}
              suffix="%"
              precision={1}
              valueStyle={{ color: stats.avgRate >= 60 ? '#52c41a' : '#faad14' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="最高课程"
              value={stats.bestCourse || '—'}
              valueStyle={{ fontSize: 18 }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="最高完成率"
              value={stats.bestRate}
              suffix="%"
              precision={1}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
      </Row>

      {/* ── 筛选条件 + 刷新 ── */}
      <Card
        title={
          <Space>
            <BookOutlined />
            <span>学情进度总览</span>
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>
            刷新
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <span>课程：</span>
          <Select
            value={courseId}
            onChange={setCourseId}
            style={{ width: 160 }}
            placeholder="选择课程"
            allowClear
          >
            {courses.map((c) => (
              <Option key={c.id} value={c.id}>{c.name}</Option>
            ))}
          </Select>

          <span>年级：</span>
          <Select
            value={grade}
            onChange={setGrade}
            style={{ width: 120 }}
            placeholder="全部年级"
            allowClear
          >
            {gradeOptions.map((g) => (
              <Option key={g} value={g}>{g}</Option>
            ))}
          </Select>

          <span>班级：</span>
          <Select
            value={className}
            onChange={setClassName}
            style={{ width: 120 }}
            placeholder="全部班级"
            allowClear
          >
            {classOptions.map((c) => (
              <Option key={c} value={c}>{c}</Option>
            ))}
          </Select>
        </Space>

        {/* ── 状态图例 ── */}
        <Space style={{ marginBottom: 12 }}>
          <Tag icon={<CheckCircleOutlined />} color="success">已完成</Tag>
          <Tag icon={<ClockCircleOutlined />} color="processing">学习中</Tag>
          <Tag icon={<StopOutlined />} color="default">未开始</Tag>
        </Space>

        {/* ── 进度表格 ── */}
        <Table
          dataSource={students}
          columns={columns}
          rowKey="username"
          loading={loading}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 名学生` }}
          expandable={{
            expandedRowRender: renderExpandedRow,
            expandedRowKeys,
            onExpandedRowsChange: (keys: readonly React.Key[]) => setExpandedRowKeys([...keys]),
            rowExpandable: () => true,
          }}
          scroll={{ x: 600 }}
          size="middle"
        />
      </Card>
    </Layout>
  )
}

export default CurriculumProgressPage
