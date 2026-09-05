import React, { useState, useEffect, useCallback } from 'react'
import {
  Modal, Select, Input, Button, Table, message, Tag, Space, Typography, Empty,
} from 'antd'
import {
  FileOutlined, DownloadOutlined, FormOutlined,
  TeamOutlined, CheckCircleOutlined, PlusOutlined, DeleteOutlined, SearchOutlined,
} from '@ant-design/icons'
import * as curriculumApi from '../api/curriculum'
import { useTranslation } from 'react-i18next'

const { Search } = Input
const { Option } = Select

// 类型标签走 i18n(键在 curriculum 命名空间: 该组件只在课程/知识点页使用)
const RESOURCE_TYPE_OPTIONS = [
  { value: 'html', labelKey: 'rbTypeHtml', icon: <FileOutlined /> },
  { value: 'download', labelKey: 'rbTypeDownload', icon: <DownloadOutlined /> },
  { value: 'exam', labelKey: 'rbTypeExam', icon: <FormOutlined /> },
  { value: 'discussion', labelKey: 'rbTypeDiscussion', icon: <TeamOutlined /> },
  { value: 'interaction_quiz', labelKey: 'rbTypeQuiz', icon: <FormOutlined /> },
  { value: 'task', labelKey: 'rbTypeTask', icon: <CheckCircleOutlined /> },
]

const RESOURCE_TYPE_KEYS: Record<string, string> = Object.fromEntries(
  RESOURCE_TYPE_OPTIONS.map((o) => [o.value, o.labelKey]),
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
  const { t } = useTranslation('curriculum')
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
      message.warning(t('rbSelectResources'))
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
      message.success(t('rbBindSuccess', { count: successCount }))
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
      message.success(t('rbUnbindSuccess'))
      loadBoundResources()
      loadAvailableResources()
      onRefresh?.()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || t('rbUnbindFailed'))
    }
  }

  // ── 已绑定资源表格列 ──
  const boundColumns = [
    {
      title: t('rbColType'),
      dataIndex: 'resource_type',
      key: 'type',
      width: 100,
      render: (type: string) => (
        <Tag>{RESOURCE_TYPE_KEYS[type] ? t(RESOURCE_TYPE_KEYS[type]) : type}</Tag>
      ),
    },
    {
      title: t('rbColName'),
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
      title: t('rbColActions'),
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
          {t('rbUnbind')}
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
      title: t('rbColName'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string) => (
        <Typography.Text>{name || t('rbNoName')}</Typography.Text>
      ),
    },
  ]

  return (
    <Modal
      title={
        <Space>
          <PlusOutlined />
          <span>{t('rbModalTitle')}</span>
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
        {t('rbBoundTitle', { count: boundResources.length })}
      </Typography.Title>
      <Table
        dataSource={boundResources}
        columns={boundColumns}
        rowKey="binding_id"
        loading={boundLoading}
        size="small"
        pagination={false}
        locale={{ emptyText: <Empty description={t('rbNoBound')} /> }}
        style={{ marginBottom: 24 }}
      />

      {/* ── 绑定新资源 ── */}
      <Typography.Title level={5}>{t('rbBindNewTitle')}</Typography.Title>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          value={resourceType}
          onChange={(val) => {
            setResourceType(val)
            setSelectedResourceIds([])
          }}
          style={{ width: 140 }}
        >
          {RESOURCE_TYPE_OPTIONS.map((opt) => (
            <Option key={opt.value} value={opt.value}>
              <Space size={4}>
                {opt.icon}
                {opt.labelKey ? t(opt.labelKey) : opt.value}
              </Space>
            </Option>
          ))}
        </Select>
        <Search
          placeholder={t('rbSearchPlaceholder')}
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
          {t('rbBindSelected', { count: selectedResourceIds.length })}
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
        locale={{ emptyText: <Empty description={t('rbNoAvailable')} /> }}
        style={{ marginBottom: 16 }}
      />
    </Modal>
  )
}

export default ResourceBinder
