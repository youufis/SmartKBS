/**
 * ResourceViewStatsPage — 教师端资源浏览统计页面
 * 展示 HTML 资源和下载文件被学生查看的统计数据
 */
import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('dashboard')
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
        <Empty description={t('activityMonitor.restricted')} />
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

  // 加载所有共享资源的浏览统计（服务端一次聚合查询；共享给自己的资源不参与统计）
  const loadResourceStats = async () => {
    setLoading(true)
    try {
      const data = await trackingApi.getAllResourceViewStats()
      setResources(Array.isArray(data?.resources) ? data.resources : [])
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      message.error(err?.response?.data?.detail || err?.message || t('activityMonitor.resourceViews.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadResourceStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      title: t('activityMonitor.resourceViews.columns.resourceName'),
      dataIndex: 'resource_name',
      key: 'resource_name',
      ellipsis: true,
    },
    {
      title: t('activityMonitor.resourceViews.columns.type'),
      dataIndex: 'resource_type',
      key: 'resource_type',
      width: 80,
      render: (type: string) => type === 'html' ? <Tag icon={<FileOutlined />} color="blue">HTML</Tag> : <Tag icon={<DownloadOutlined />} color="green">{t('activityMonitor.resourceViews.fileType')}</Tag>,
    },
    {
      title: t('activityMonitor.resourceViews.columns.owner'),
      dataIndex: 'owner',
      key: 'owner',
      width: 100,
      ellipsis: true,
      render: (v: string) => v ? <Tag color="default">{v}</Tag> : '-',
    },
    {
      title: t('activityMonitor.resourceViews.columns.views'),
      dataIndex: 'total_views',
      key: 'total_views',
      width: 100,
      sorter: (a: ResourceViewItem, b: ResourceViewItem) => a.total_views - b.total_views,
    },
    {
      title: t('activityMonitor.resourceViews.columns.viewers'),
      dataIndex: 'unique_viewers',
      key: 'unique_viewers',
      width: 100,
      sorter: (a: ResourceViewItem, b: ResourceViewItem) => a.unique_viewers - b.unique_viewers,
    },
    {
      title: t('activityMonitor.resourceViews.columns.lastView'),
      dataIndex: 'last_view_time',
      key: 'last_view_time',
      width: 180,
      render: (t: string, r: ResourceViewItem) => t ? (
        <Space size={2} orientation="vertical" style={{ gap: 0 }}>
          <Text style={{ fontSize: 12 }}>{t}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>{r.last_view_student}</Text>
        </Space>
      ) : '-',
    },
    {
      title: t('activityMonitor.resourceViews.columns.action'),
      key: 'action',
      width: 100,
      render: (_: any, r: ResourceViewItem) => (
        <a onClick={() => handleViewDetail(r.resource_type, r.id, r.resource_name)}>{t('activityMonitor.resourceViews.viewStudents')}</a>
      ),
    },
  ]

  return (
    <div>
      <Title level={4} style={{ marginBottom: 16 }}>
        <EyeOutlined /> {t('activityMonitor.resourceViews.title')}
      </Title>

      {/* 概览卡片 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={8}>
          <Card size="small">
            <Statistic title={t('activityMonitor.resourceViews.activeStudents')} value={overview.active_students} prefix={<TeamOutlined />} suffix={t('activityMonitor.stats.personSuffix')} />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic title={t('activityMonitor.resourceViews.totalViews')} value={overview.total_views} prefix={<EyeOutlined />} suffix={t('activityMonitor.resourceViews.viewSuffix')} />
          </Card>
        </Col>
        <Col span={8}>
          <Card size="small">
            <Statistic title={t('activityMonitor.resourceViews.viewedResources')} value={overview.viewed_resources} prefix={<FileOutlined />} suffix={t('activityMonitor.resourceViews.resourceSuffix')} />
          </Card>
        </Col>
      </Row>

      {/* 按知识点查看 */}
      <Card size="small" title={t('activityMonitor.resourceViews.byKnowledgePoint')} style={{ marginBottom: 16 }}>
        <Space orientation="vertical" style={{ width: '100%' }} size={12}>
          <Space>
            <Select
              value={selectedCourseId}
              onChange={v => { setSelectedCourseId(v); setSelectedKpId(undefined); setKpViewData([]) }}
              style={{ width: 250 }}
              placeholder={t('activityMonitor.resourceViews.selectCourse')}
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
                {t('activityMonitor.refresh')}
              </Button>
            )}
          </Space>
          {!selectedCourseId ? (
            <Text type="secondary">{t('activityMonitor.resourceViews.selectCourseFirst')}</Text>
          ) : !selectedKpId ? (
            <Text type="secondary">{t('activityMonitor.resourceViews.selectKpHint')}</Text>
          ) : (
            <div>
              <Text strong>{selectedKpName}</Text>
              {kpViewData.length === 0 ? (
                <Text type="secondary" style={{ marginLeft: 12 }}>{t('activityMonitor.resourceViews.noKpResources')}</Text>
              ) : (
                <Table
                  dataSource={kpViewData}
                  rowKey="binding_id"
                  size="small"
                  pagination={false}
                  columns={[
                    { title: t('activityMonitor.resourceViews.columns.resourceName'), dataIndex: 'resource_name', ellipsis: true },
                    {
                      title: t('activityMonitor.resourceViews.columns.type'), dataIndex: 'resource_type', width: 80,
                      render: (type: string) => type === 'html' ? <Tag color="blue">HTML</Tag> : <Tag color="green">{t('activityMonitor.resourceViews.fileType')}</Tag>,
                    },
                    { title: t('activityMonitor.resourceViews.columns.views'), dataIndex: 'total_views', width: 90 },
                    { title: t('activityMonitor.resourceViews.columns.viewers'), dataIndex: 'unique_viewers', width: 90 },
                    {
                      title: t('activityMonitor.resourceViews.columns.lastView'), dataIndex: 'last_view', width: 160,
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
        title={t('activityMonitor.resourceViews.sharedResources')}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={loadResourceStats} loading={loading}>{t('activityMonitor.refresh')}</Button>}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}><Spin /></div>
        ) : resources.length === 0 ? (
          <Empty description={t('activityMonitor.resourceViews.empty')} />
        ) : (
          <Table
            dataSource={resources}
            rowKey="id"
            size="small"
            columns={columns}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => t('activityMonitor.resourceViews.pagination', { count: total }) }}
          />
        )}
      </Card>

      {/* 学生明细弹窗 */}
      <Card
        title={t('activityMonitor.resourceViews.detailTitle', { name: detailTitle })}
        style={{ marginTop: 16, display: detailModalOpen ? 'block' : 'none' }}
        extra={<a onClick={() => setDetailModalOpen(false)}>{t('activityMonitor.close')}</a>}
      >
        {viewDetail.length === 0 ? (
          <Text type="secondary">{t('activityMonitor.resourceViews.noRecords')}</Text>
        ) : (
          <Table
            dataSource={viewDetail}
            rowKey="student_username"
            size="small"
            pagination={{ pageSize: 10 }}
            columns={[
              { title: t('activityMonitor.resourceViews.columns.student'), dataIndex: 'student_name', width: 120 },
              { title: t('activityMonitor.resourceViews.columns.username'), dataIndex: 'student_username', width: 120 },
              { title: t('activityMonitor.resourceViews.columns.viewCount'), dataIndex: 'view_count', width: 90 },
              { title: t('activityMonitor.resourceViews.columns.lastView'), dataIndex: 'last_viewed', width: 180 },
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
  const { t } = useTranslation('dashboard')
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
      placeholder={t('activityMonitor.resourceViews.selectKp')}
      allowClear
      showSearch
      optionFilterProp="label"
      loading={loading}
      notFoundContent={loading ? <Spin size="small" /> : courseId ? t('activityMonitor.resourceViews.noKpForCourse') : t('activityMonitor.resourceViews.selectCourseFirstHint')}
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
