/**
 * ResourceViewStatsPage — 教师端资源浏览统计页面
 * 展示 HTML 资源和下载文件被学生查看的统计数据
 */
import React, { useState, useEffect } from 'react'
import {
  Card, Table, Select, Space, Typography, message, Row, Col,
  Statistic, Tag, Spin, Empty, Button,
} from 'antd'
import {
  EyeOutlined, ReloadOutlined, TeamOutlined,
  FileOutlined, DownloadOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import * as trackingApi from '../api/tracking'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

interface ResourceViewItem {
  id: number
  resource_name: string
  resource_type: string
  owner: string
  total_views: number
  unique_viewers: number
  last_view_time: string
  last_view_student: string
}

const ResourceViewStatsPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  const [loading, setLoading] = useState(false)

  // 课程列表（用于按知识点筛选）
  const [courses, setCourses] = useState<any[]>([])
  const [selectedCourseId, setSelectedCourseId] = useState<number | undefined>()
  const [selectedKpId, setSelectedKpId] = useState<number | undefined>()

  // 统计概览
  const [overview, setOverview] = useState({ active_students: 0, total_views: 0, viewed_resources: 0 })

  // 资源浏览明细
  const [resources, setResources] = useState<ResourceViewItem[]>([])
  const [viewDetail, setViewDetail] = useState<trackingApi.ResourceViewStudent[]>([])
  const [detailModalOpen, setDetailModalOpen] = useState(false)
  const [detailTitle, setDetailTitle] = useState('')

  // 知识点浏览明细
  const [kpViewData, setKpViewData] = useState<trackingApi.KpResourceView[]>([])
  const [selectedKpName, setSelectedKpName] = useState('')

  if (!isTeacherOrAdmin) {
    return (
      <Card>
        <Empty description="仅教师和管理员可访问" />
      </Card>
    )
  }

  // 加载概览数据
  const loadOverview = async () => {
    try {
      const data = await trackingApi.getResourceViewDashboard({
        days: 30,
      })
      setOverview(data)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    loadOverview()
  }, [])

  // 加载课程列表
  useEffect(() => {
    apiClient.get('/api/curriculum/courses')
      .then(({ data }) => {
        if (data.courses) setCourses(data.courses)
      })
      .catch(() => {})
  }, [])

  // 加载所有共享资源的浏览统计
  const loadResourceStats = async () => {
    setLoading(true)
    try {
      // 获取当前教师的所有共享资源
      const { data: myShares } = await apiClient.get('/api/sharing/my-shares')
      const shares = Array.isArray(myShares?.shares) ? myShares.shares : []

      const items: ResourceViewItem[] = []
      for (const share of shares) {
        try {
          const stats = await trackingApi.getResourceViewStats(share.resource_type, share.id)
          const students = await trackingApi.getResourceViewStudents(share.resource_type, share.id)
          const lastStudent = students.students?.[0]
          items.push({
            id: share.id,
            resource_name: share.file_name,
            resource_type: share.resource_type,
            owner: share.owner_username,
            total_views: stats.total_views,
            unique_viewers: stats.unique_viewers,
            last_view_time: lastStudent?.last_viewed || '',
            last_view_student: lastStudent?.student_name || '',
          })
        } catch { /* ignore */ }
      }

      setResources(items.sort((a, b) => b.total_views - a.total_views))
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      message.error(err?.response?.data?.detail || err?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadResourceStats()
  }, [])

  // 查看某个资源的学生明细
  const handleViewDetail = async (resourceType: string, resourceId: number, name: string) => {
    setDetailTitle(name)
    setDetailModalOpen(true)
    try {
      const data = await trackingApi.getResourceViewStudents(resourceType, resourceId)
      setViewDetail(data.students)
    } catch {
      setViewDetail([])
    }
  }

  // 查看知识点的浏览统计
  const handleKpSelect = async (kpId: number, kpName: string) => {
    setSelectedKpId(kpId)
    setSelectedKpName(kpName)
    if (!kpId) {
      setKpViewData([])
      return
    }
    try {
      const data = await trackingApi.getKpViewStats(kpId)
      setKpViewData(data.resources)
    } catch {
      setKpViewData([])
    }
  }

  const columns = [
    {
      title: '资源名称',
      dataIndex: 'resource_name',
      key: 'resource_name',
      ellipsis: true,
    },
    {
      title: '类型',
      dataIndex: 'resource_type',
      key: 'resource_type',
      width: 80,
      render: (t: string) => t === 'html' ? <Tag icon={<FileOutlined />} color="blue">HTML</Tag> : <Tag icon={<DownloadOutlined />} color="green">文件</Tag>,
    },
    {
      title: '浏览次数',
      dataIndex: 'total_views',
      key: 'total_views',
      width: 100,
      sorter: (a: ResourceViewItem, b: ResourceViewItem) => a.total_views - b.total_views,
    },
    {
      title: '查看人数',
      dataIndex: 'unique_viewers',
      key: 'unique_viewers',
      width: 100,
      sorter: (a: ResourceViewItem, b: ResourceViewItem) => a.unique_viewers - b.unique_viewers,
    },
    {
      title: '最近查看',
      dataIndex: 'last_view_time',
      key: 'last_view_time',
      width: 180,
      render: (t: string, r: ResourceViewItem) => t ? (
        <Space size={2} direction="vertical" style={{ gap: 0 }}>
          <Text style={{ fontSize: 12 }}>{t}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.last_view_student}</Text>
        </Space>
      ) : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_: any, r: ResourceViewItem) => (
        <a onClick={() => handleViewDetail(r.resource_type, r.id, r.resource_name)}>查看学生</a>
      ),
    },
  ]

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>
        <EyeOutlined /> 浏览统计
      </Title>

      {/* 概览卡片 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card size="small">
            <Statistic title="活跃学生（30天）" value={overview.active_students} prefix={<TeamOutlined />} suffix="人" />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic title="总浏览次" value={overview.total_views} prefix={<EyeOutlined />} suffix="次" />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic title="被浏览资源数" value={overview.viewed_resources} prefix={<FileOutlined />} suffix="个" />
          </Card>
        </Col>
      </Row>

      {/* 按知识点查看 */}
      <Card size="small" title="📖 按知识点查看浏览统计" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Space>
            <Select
              value={selectedCourseId}
              onChange={v => { setSelectedCourseId(v); setSelectedKpId(undefined); setKpViewData([]) }}
              style={{ width: 250 }}
              placeholder="① 选择课程"
              allowClear
              showSearch
              optionFilterProp="label"
            >
              {courses.map(c => (
                <Select.Option key={c.id} value={c.id} label={c.name}>{c.name}</Select.Option>
              ))}
            </Select>
            <KpSelect
              courseId={selectedCourseId}
              value={selectedKpId}
              onChange={handleKpSelect}
            />
            {selectedKpId && (
              <Button icon={<ReloadOutlined />} size="small" onClick={() => handleKpSelect(selectedKpId, selectedKpName)}>
                刷新
              </Button>
            )}
          </Space>
          {!selectedCourseId ? (
            <Text type="secondary">请先选择课程，然后选择知识点查看该知识点下绑定资源的浏览统计</Text>
          ) : !selectedKpId ? (
            <Text type="secondary">请选择一个知识点查看浏览统计</Text>
          ) : (
            <div>
              <Text strong>{selectedKpName}</Text>
              {kpViewData.length === 0 ? (
                <Text type="secondary" style={{ marginLeft: 12 }}>该知识点暂无 HTML/文件资源绑定</Text>
              ) : (
                <Table
                  dataSource={kpViewData}
                  rowKey="binding_id"
                  size="small"
                  pagination={false}
                  columns={[
                    { title: '资源名称', dataIndex: 'resource_name', ellipsis: true },
                    {
                      title: '类型', dataIndex: 'resource_type', width: 80,
                      render: (t: string) => t === 'html' ? <Tag color="blue">HTML</Tag> : <Tag color="green">文件</Tag>,
                    },
                    { title: '浏览次数', dataIndex: 'total_views', width: 90 },
                    { title: '查看人数', dataIndex: 'unique_viewers', width: 90 },
                    {
                      title: '最近查看', dataIndex: 'last_view', width: 160,
                      render: (v: any) => v ? `${v.viewed_at} ${v.student_username}` : '-',
                    },
                  ]}
                />
              )}
            </div>
          )}
        </Space>
      </Card>

      {/* 资源浏览明细 */}
      <Card
        size="small"
        title="📄 共享资源浏览统计"
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={loadResourceStats} loading={loading}>刷新</Button>}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}><Spin /></div>
        ) : resources.length === 0 ? (
          <Empty description="暂无共享资源或暂无浏览数据" />
        ) : (
          <Table
            dataSource={resources}
            rowKey="id"
            size="small"
            columns={columns}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 个资源` }}
          />
        )}
      </Card>

      {/* 学生明细弹窗 */}
      <Card
        title={`👁️ 查看「${detailTitle}」的学生`}
        style={{ marginTop: 16, display: detailModalOpen ? 'block' : 'none' }}
        extra={<a onClick={() => setDetailModalOpen(false)}>关闭</a>}
      >
        {viewDetail.length === 0 ? (
          <Text type="secondary">暂无学生查看记录</Text>
        ) : (
          <Table
            dataSource={viewDetail}
            rowKey="student_username"
            size="small"
            pagination={{ pageSize: 10 }}
            columns={[
              { title: '学生', dataIndex: 'student_name', width: 120 },
              { title: '用户名', dataIndex: 'student_username', width: 120 },
              { title: '查看次数', dataIndex: 'view_count', width: 90 },
              { title: '最近查看', dataIndex: 'last_viewed', width: 180 },
            ]}
          />
        )}
      </Card>
    </div>
  )
}

/** 知识点下拉选择器（按课程过滤） */
const KpSelect: React.FC<{
  courseId?: number
  value?: number
  onChange: (kpId: number, kpName: string) => void
}> = ({ courseId, value, onChange }) => {
  const [kpList, setKpList] = useState<{ id: number; name: string; chapter_path: string }[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!courseId) { setKpList([]); return }
    setLoading(true)
    apiClient.get(`/api/curriculum/courses/${courseId}`)
      .then(({ data }) => {
        const items: { id: number; name: string; chapter_path: string }[] = []
        const extractKp = (chapters: any[], parentPath = '') => {
          for (const ch of chapters) {
            const path = parentPath ? `${parentPath} > ${ch.name}` : ch.name
            if (ch.knowledge_points) {
              for (const kp of ch.knowledge_points) {
                items.push({ id: kp.id, name: kp.name, chapter_path: path })
              }
            }
            if (ch.children) extractKp(ch.children, path)
          }
        }
        extractKp(data.chapters || [])
        setKpList(items)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [courseId])

  return (
    <Select
      value={value}
      onChange={v => {
        const kp = kpList.find(k => k.id === v)
        onChange(v, kp ? `${kp.chapter_path} > ${kp.name}` : '')
      }}
      style={{ width: 300 }}
      placeholder="选择知识点"
      allowClear
      showSearch
      optionFilterProp="label"
      loading={loading}
      notFoundContent={loading ? <Spin size="small" /> : courseId ? '暂无知识点' : '请先选择课程'}
    >
      {kpList.map(kp => (
        <Select.Option key={kp.id} value={kp.id} label={`${kp.chapter_path} > ${kp.name}`}>
          <span style={{ fontSize: 12 }}>{kp.chapter_path} &gt; </span>
          <span>{kp.name}</span>
        </Select.Option>
      ))}
    </Select>
  )
}

export default ResourceViewStatsPage
