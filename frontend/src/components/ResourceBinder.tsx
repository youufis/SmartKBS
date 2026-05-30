import React, { useState, useEffect, useCallback } from 'react'
import {
  Modal, Select, Input, Button, Table, message, Tag, Space, Typography, Empty,
} from 'antd'
import {
  FileOutlined, DownloadOutlined, QuestionCircleOutlined, FormOutlined,
  TeamOutlined, CheckCircleOutlined, PlusOutlined, DeleteOutlined, SearchOutlined,
} from '@ant-design/icons'
import * as curriculumApi from '../api/curriculum'

const { Search } = Input
const { Option } = Select

const RESOURCE_TYPE_OPTIONS = [
  { value: 'html', label: 'HTML 资源', icon: <FileOutlined /> },
  { value: 'download', label: '下载文件', icon: <DownloadOutlined /> },
  { value: 'question', label: '试题', icon: <QuestionCircleOutlined /> },
  { value: 'exam', label: '考试', icon: <FormOutlined /> },
  { value: 'discussion', label: '讨论', icon: <TeamOutlined /> },
  { value: 'interaction_quiz', label: '随堂测验', icon: <FormOutlined /> },
  { value: 'task', label: '任务', icon: <CheckCircleOutlined /> },
]

const RESOURCE_TYPE_MAP = Object.fromEntries(
  RESOURCE_TYPE_OPTIONS.map((t) => [t.value, t.label]),
)

interface ResourceBinderProps {
  /** 知识点 ID */
  kpId: number;
  /** 知识点名称 */
  kpName: string;
  /** 弹窗是否可见 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 绑定成功后刷新回调 */
  onRefresh?: () => void;
}

const ResourceBinder: React.FC<ResourceBinderProps> = ({ kpId, kpName, open, onClose, onRefresh }) => {
  // ── 已绑定的资源列表 ──
  const [boundResources, setBoundResources] = useState<any[]>([])
  const [boundLoading, setBoundLoading] = useState(false)

  // ── 候选资源（可绑定的） ──
  const [resourceType, setResourceType] = useState<string>('html')
  const [keyword, setKeyword] = useState('')
  const [availableResources, setAvailableResources] = useState<any[]>([])
  const [availableLoading, setAvailableLoading] = useState(false)
  const [selectedResourceIds, setSelectedResourceIds] = useState<number[]>([])

  // ── 绑定操作 ──
  const [binding, setBinding] = useState(false)

  // ── 加载已绑定的资源 ──
  const loadBoundResources = useCallback(async () => {
    setBoundLoading(true)
    try {
      const res = await curriculumApi.getKpResources(kpId)
      setBoundResources(res.resources)
    } catch {
      setBoundResources([])
    } finally {
      setBoundLoading(false)
    }
  }, [kpId])

  // ── 加载候选资源 ──
  const loadAvailableResources = useCallback(async () => {
    setAvailableLoading(true)
    try {
      const res = await curriculumApi.getAvailableResources({
        resource_type: resourceType,
        keyword,
        kp_id: kpId,
      })
      setAvailableResources(res.resources)
    } catch {
      setAvailableResources([])
    } finally {
      setAvailableLoading(false)
    }
  }, [resourceType, keyword, kpId])

  useEffect(() => {
    if (open) {
      loadBoundResources()
    }
  }, [open, loadBoundResources])

  useEffect(() => {
    if (open) {
      loadAvailableResources()
    }
  }, [open, resourceType, loadAvailableResources])

  // ── 绑定资源 ──
  const handleBind = async () => {
    if (selectedResourceIds.length === 0) {
      message.warning('请选择要绑定的资源')
      return
    }
    setBinding(true)
    let successCount = 0
    for (const rid of selectedResourceIds) {
      try {
        await curriculumApi.bindResource({
          knowledge_point_id: kpId,
          resource_type: resourceType,
          resource_id: rid,
        })
        successCount++
      } catch (err: unknown) {
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        if (detail && !detail.includes('已绑定')) {
          message.error(`${detail}`)
        }
      }
    }
    if (successCount > 0) {
      message.success(`成功绑定 ${successCount} 个资源`)
      setSelectedResourceIds([])
      loadBoundResources()
      loadAvailableResources()
      onRefresh?.()
    }
    setBinding(false)
  }

  // ── 解绑资源 ──
  const handleUnbind = async (bindingId: number) => {
    try {
      await curriculumApi.unbindResource(bindingId)
      message.success('资源已解绑')
      loadBoundResources()
      loadAvailableResources()
      onRefresh?.()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || '解绑失败')
    }
  }

  // ── 已绑定资源表格列 ──
  const boundColumns = [
    {
      title: '类型',
      dataIndex: 'resource_type',
      key: 'type',
      width: 100,
      render: (type: string) => (
        <Tag>{RESOURCE_TYPE_MAP[type] || type}</Tag>
      ),
    },
    {
      title: '名称',
      dataIndex: 'resource_name',
      key: 'name',
      ellipsis: true,
      render: (name: string, record: any) => (
        <Space>
          {RESOURCE_TYPE_OPTIONS.find((t) => t.value === record.resource_type)?.icon || <FileOutlined />}
          <Typography.Text>{name || `[ID:${record.resource_id}]`}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 80,
      render: (_: any, record: any) => (
        <Button
          type="link"
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => handleUnbind(record.binding_id)}
        >
          解绑
        </Button>
      ),
    },
  ]

  // ── 候选资源表格列 ──
  const availableColumns = [
    {
      title: 'ID',
      dataIndex: 'id',
      key: 'id',
      width: 60,
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string) => (
        <Typography.Text>{name || '(无名称)'}</Typography.Text>
      ),
    },
  ]

  return (
    <Modal
      title={
        <Space>
          <PlusOutlined />
          <span>管理绑定资源</span>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            — {kpName}
          </Typography.Text>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={800}
      footer={null}
    >
      {/* ── 已绑定资源列表 ── */}
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        已绑定的资源 ({boundResources.length})
      </Typography.Title>
      <Table
        dataSource={boundResources}
        columns={boundColumns}
        rowKey="binding_id"
        loading={boundLoading}
        size="small"
        pagination={false}
        locale={{ emptyText: <Empty description="暂未绑定资源" /> }}
        style={{ marginBottom: 24 }}
      />

      {/* ── 绑定新资源 ── */}
      <Typography.Title level={5}>绑定新资源</Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          value={resourceType}
          onChange={(val) => {
            setResourceType(val)
            setSelectedResourceIds([])
          }}
          style={{ width: 140 }}
        >
          {RESOURCE_TYPE_OPTIONS.map((t) => (
            <Option key={t.value} value={t.value}>
              <Space size={4}>
                {t.icon}
                {t.label}
              </Space>
            </Option>
          ))}
        </Select>
        <Search
          placeholder="搜索资源名称..."
          allowClear
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onSearch={(val) => setKeyword(val)}
          style={{ width: 240 }}
          prefix={<SearchOutlined />}
        />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleBind}
          loading={binding}
          disabled={selectedResourceIds.length === 0}
        >
          绑定选中 ({selectedResourceIds.length})
        </Button>
      </Space>

      <Table
        dataSource={availableResources}
        columns={availableColumns}
        rowKey="id"
        loading={availableLoading}
        size="small"
        pagination={{ pageSize: 8, showSizeChanger: false }}
        rowSelection={{
          type: 'checkbox',
          selectedRowKeys: selectedResourceIds,
          onChange: (keys) => setSelectedResourceIds(keys as number[]),
        }}
        locale={{ emptyText: <Empty description="没有可绑定的资源" /> }}
        style={{ marginBottom: 16 }}
      />
    </Modal>
  )
}

export default ResourceBinder
