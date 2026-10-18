/** 每日精选管理（教师/管理员） */
import React, { useEffect, useState } from 'react'
import {
  Alert, Button, Card, Col, Form, Input, InputNumber, Modal, Popconfirm,
  Row, Select, Space, Statistic, Table, Tag, Typography, message,
} from 'antd'
import {
  EditOutlined, DeleteOutlined, ReloadOutlined, StopOutlined, CheckCircleOutlined,
  EyeOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import {
  bulkAdminCards, getAdminCards, getAdminHealth, updateAdminCard,
  type DiscoveryAdminCard, type DiscoveryAdminHealth,
} from '../api/dailyDiscovery'

const { Title, Text } = Typography
const { TextArea } = Input

const DailyDiscoveryAdminPage: React.FC = () => {
  const { t } = useTranslation('contentAdmin')
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'
  const [rows, setRows] = useState<DiscoveryAdminCard[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<React.Key[]>([])
  const [health, setHealth] = useState<DiscoveryAdminHealth | null>(null)
  const [filters, setFilters] = useState({ keyword: '', status: '', category: '', grade_level: '' })
  const [editing, setEditing] = useState<DiscoveryAdminCard | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()

  const load = async (pageNo = page) => {
    setLoading(true)
    try {
      const res = await getAdminCards({ ...filters, page: pageNo, page_size: pageSize })
      setRows(res.cards)
      setTotal(res.total)
      setPage(res.page)
    } catch {
      message.error(t('operationFail'))
    } finally {
      setLoading(false)
    }
  }

  const loadHealth = async () => {
    try {
      setHealth(await getAdminHealth())
    } catch {
      // 健康度失败不阻塞列表
    }
  }

  useEffect(() => {
    setSelected([])
    setPage(1)
    void load(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters])

  useEffect(() => {
    void loadHealth()
  }, [])

  const bulk = async (action: 'disable' | 'enable' | 'delete') => {
    if (!selected.length) return
    try {
      const res = await bulkAdminCards(selected.map(Number), action)
      message.success(
        (action === 'delete' ? t('deleteSuccess') : t('updateSuccess')) + ` (${res.affected})`,
      )
      setSelected([])
      await load()
      await loadHealth()
    } catch {
      message.error(t('operationFail'))
    }
  }

  const openEdit = (card: DiscoveryAdminCard) => {
    setEditing(card)
    form.setFieldsValue({
      ...card,
      tags: Array.isArray(card.tags) ? card.tags : [],
    })
  }

  const save = async () => {
    if (!editing) return
    try {
      const values = await form.validateFields()
      setSaving(true)
      await updateAdminCard(editing.id, values)
      message.success(t('updateSuccess'))
      setEditing(null)
      await load()
      await loadHealth()
    } catch (err: any) {
      if (err?.errorFields) return
      message.error(err?.response?.data?.detail || t('operationFail'))
    } finally {
      setSaving(false)
    }
  }

  const categoryOptions = Object.keys(health?.categories || {}).map(x => ({ label: x, value: x }))
  const gradeOptions = Object.keys(health?.grades || {})
    .filter(x => x && x !== 'all')
    .map(x => ({ label: x, value: x }))

  const columns: any[] = [
    {
      title: t('title'), dataIndex: 'title', key: 'title',
      render: (_: any, r: DiscoveryAdminCard) => (
        <div>
          <Text strong>{r.title}</Text>
          <div style={{ marginTop: 4 }}>
            <Tag>{r.category}</Tag>
            <Tag color={r.pool_status === 'active' ? 'green' : 'default'}>
              {r.pool_status === 'active' ? t('active') : t('disabled')}
            </Tag>
            <Tag>{!r.grade_level || r.grade_level === 'all' ? t('allGrades') : r.grade_level}</Tag>
            {r.tags?.slice(0, 3).map(tag => <Tag key={tag}>{tag}</Tag>)}
          </div>
          <Text type="secondary" style={{ fontSize: 12 }} ellipsis>{r.summary}</Text>
        </div>
      ),
    },
    { title: t('viewCount'), dataIndex: 'view_count', key: 'view_count', width: 80 },
    { title: t('favoriteCount'), dataIndex: 'favorite_count', key: 'favorite_count', width: 80 },
    { title: t('createdAt'), dataIndex: 'created_at', key: 'created_at', width: 150,
      render: (v: string) => v?.slice(0, 16) },
    {
      title: t('actions'), key: 'actions', width: 190,
      render: (_: any, r: DiscoveryAdminCard) => (
        <Space size={4}>
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)}>
            {t('edit')}
          </Button>
          {r.pool_status === 'active' ? (
            <Button size="small" type="text" icon={<StopOutlined />}
              onClick={async () => { await bulkAdminCards([r.id], 'disable'); await load(); await loadHealth() }}>
              {t('disable')}
            </Button>
          ) : (
            <Button size="small" type="text" icon={<CheckCircleOutlined />}
              onClick={async () => { await bulkAdminCards([r.id], 'enable'); await load(); await loadHealth() }}>
              {t('enable')}
            </Button>
          )}
          {isAdmin && (
            <Popconfirm title={t('deleteConfirm')} onConfirm={async () => {
              await bulkAdminCards([r.id], 'delete')
              await load()
              await loadHealth()
            }}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ]

  return (
    <Card style={{ borderRadius: 8 }}>
      <Space style={{ width: '100%', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>{t('pageTitle')}</Title>
          <Text type="secondary">{t('subtitle')}</Text>
        </div>
        <Space>
          <Button icon={<EyeOutlined />} onClick={() => window.open('/daily-discovery', '_blank')}>
            {t('previewStudent')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => { void load(); void loadHealth() }}>
            {t('refresh')}
          </Button>
        </Space>
      </Space>

      <Row gutter={12} style={{ marginTop: 16 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('poolActive')} value={health?.total_active ?? 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('poolDisabled')} value={health?.total_disabled ?? 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('refillThreshold')} value={health?.refill_threshold ?? 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('lastRefill')} value={health?.last_refill_at || '—'} /></Card></Col>
      </Row>

      <Card size="small" style={{ marginTop: 12 }}>
        <Space wrap>
          <Text type="secondary">{t('categoryDistribution')}:</Text>
          {Object.entries(health?.categories || {}).map(([k, v]) => <Tag key={k}>{k} {v}</Tag>)}
          <Text type="secondary" style={{ marginLeft: 12 }}>{t('gradeDistribution')}:</Text>
          {Object.entries(health?.grades || {}).map(([k, v]) => (
            <Tag key={k}>{!k || k === 'all' ? t('allGrades') : k} {v}</Tag>
          ))}
        </Space>
      </Card>

      <Card size="small" style={{ marginTop: 12 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search allowClear placeholder={t('searchPlaceholder')} style={{ width: 240 }}
            onSearch={(v) => setFilters(f => ({ ...f, keyword: v.trim() }))} />
          <Select value={filters.status} style={{ width: 130 }}
            onChange={(v) => setFilters(f => ({ ...f, status: v }))}
            options={[
              { label: t('allStatus'), value: '' },
              { label: t('active'), value: 'active' },
              { label: t('disabled'), value: 'disabled' },
            ]} />
          <Select value={filters.category} style={{ width: 150 }} allowClear
            placeholder={t('allCategories')}
            onChange={(v) => setFilters(f => ({ ...f, category: v || '' }))}
            options={categoryOptions} />
          <Select value={filters.grade_level} style={{ width: 130 }} allowClear
            placeholder={t('allGrades')}
            onChange={(v) => setFilters(f => ({ ...f, grade_level: v || '' }))}
            options={gradeOptions} />
          <Button onClick={() => setFilters({ keyword: '', status: '', category: '', grade_level: '' })}>
            {t('reset')}
          </Button>
        </Space>

        {selected.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('selected', { count: selected.length })}
            action={
              <Space wrap>
                <Button size="small" onClick={() => bulk('disable')}>{t('bulkDisable')}</Button>
                <Button size="small" onClick={() => bulk('enable')}>{t('bulkEnable')}</Button>
                {isAdmin ? (
                  <Popconfirm title={t('bulkDeleteConfirm', { count: selected.length })} onConfirm={() => bulk('delete')}>
                    <Button size="small" danger>{t('bulkDelete')}</Button>
                  </Popconfirm>
                ) : <Text type="secondary" style={{ fontSize: 12 }}>{t('onlyAdminDelete')}</Text>}
              </Space>
            }
          />
        )}

        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          columns={columns}
          rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys) }}
          pagination={{
            current: page, pageSize, total, showSizeChanger: false,
            showTotal: (n) => t('total', { count: n }),
            onChange: (p) => { setPage(p); void load(p) },
          }}
        />
      </Card>

      <Modal
        title={t('edit')}
        open={!!editing}
        maskClosable={false}
        onCancel={() => setEditing(null)}
        onOk={save}
        okText={t('save')}
        cancelText={t('cancel')}
        confirmLoading={saving}
        width={720}
      >
        <Form form={form} layout="vertical">
          <Space style={{ width: '100%' }} align="start" wrap>
            <Form.Item name="emoji" label={t('emoji')} style={{ width: 100 }}>
              <Input maxLength={8} />
            </Form.Item>
            <Form.Item name="title" label={t('title')} style={{ flex: 1, minWidth: 260 }} rules={[{ required: true }]}>
              <Input maxLength={200} />
            </Form.Item>
          </Space>
          <Space style={{ width: '100%' }} align="start" wrap>
            <Form.Item name="category" label={t('category')} style={{ width: 180 }} rules={[{ required: true }]}>
              <Input maxLength={40} />
            </Form.Item>
            <Form.Item name="grade_level" label={t('gradeLevel')} style={{ width: 180 }}>
              <Select options={[{ label: t('allGrades'), value: 'all' }, ...gradeOptions]} />
            </Form.Item>
            <Form.Item name="fun_level" label={t('funLevel')} style={{ width: 120 }}>
              <InputNumber min={1} max={5} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="pool_status" label={t('status')} style={{ width: 140 }}>
              <Select options={[{ label: t('active'), value: 'active' }, { label: t('disabled'), value: 'disabled' }]} />
            </Form.Item>
          </Space>
          <Form.Item name="summary" label={t('summary')} rules={[{ required: true }]}>
            <TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
          <Form.Item name="detail" label={t('detail')} rules={[{ required: true }]}>
            <TextArea rows={8} maxLength={5000} showCount />
          </Form.Item>
          <Space style={{ width: '100%' }} align="start" wrap>
            <Form.Item name="source" label={t('source')} style={{ flex: 1, minWidth: 200 }}>
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item name="related_subject" label={t('relatedSubject')} style={{ flex: 1, minWidth: 200 }}>
              <Input maxLength={100} />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label={t('tags')}>
            <Select mode="tags" tokenSeparators={[',', '，', '、']} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

export default DailyDiscoveryAdminPage
