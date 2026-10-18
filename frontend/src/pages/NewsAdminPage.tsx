/** 新闻管理（教师/管理员） */
import React, { useEffect, useState } from 'react'
import {
  Alert, Button, Card, Col, DatePicker, Form, Input, Modal, Popconfirm,
  Row, Select, Space, Statistic, Table, Tag, Typography, message,
} from 'antd'
import {
  DeleteOutlined, EditOutlined, ReloadOutlined, StopOutlined, CheckCircleOutlined,
  SafetyCertificateOutlined, SyncOutlined, EyeOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import {
  bulkAdminNews, diagnoseNewsFeeds, getAdminNews, getAdminNewsHealth,
  resummarizeAdminNews, updateAdminNews,
  type NewsAdminArticle, type NewsAdminHealth,
} from '../api/news'

const { Title, Text } = Typography
const { TextArea } = Input
const { RangePicker } = DatePicker

const NewsAdminPage: React.FC = () => {
  const { t } = useTranslation('contentAdmin')
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'
  const [rows, setRows] = useState<NewsAdminArticle[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(20)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<React.Key[]>([])
  const [health, setHealth] = useState<NewsAdminHealth | null>(null)
  const [filters, setFilters] = useState({
    keyword: '', status: '', category: '', source_name: '', ai_status: '',
    dateFrom: '', dateTo: '',
  })
  const [editing, setEditing] = useState<NewsAdminArticle | null>(null)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()
  const [diagnosing, setDiagnosing] = useState(false)
  const [diagnoseResult, setDiagnoseResult] = useState<any>(null)

  const load = async (pageNo = page) => {
    setLoading(true)
    try {
      const res = await getAdminNews({
        keyword: filters.keyword,
        status: filters.status,
        category: filters.category,
        source_name: filters.source_name,
        ai_status: filters.ai_status,
        date_from: filters.dateFrom,
        date_to: filters.dateTo,
        page: pageNo,
        page_size: pageSize,
      })
      setRows(res.articles)
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
      setHealth(await getAdminNewsHealth())
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

  const bulk = async (action: 'hide' | 'restore' | 'delete') => {
    if (!selected.length) return
    try {
      const res = await bulkAdminNews(selected.map(Number), action)
      message.success(
        (action === 'delete' ? t('deleteSuccess') : t('updateSuccess')) + ` (${res.affected})`,
      )
      setSelected([])
      await load()
      await loadHealth()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('operationFail'))
    }
  }

  const openEdit = (article: NewsAdminArticle) => {
    setEditing(article)
    form.setFieldsValue({
      title: article.title,
      category: article.category,
      status: article.status,
      tags: article.tags || [],
      related_subjects: article.related_subjects || [],
      admin_note: article.admin_note || '',
    })
  }

  const save = async () => {
    if (!editing) return
    try {
      const values = await form.validateFields()
      setSaving(true)
      await updateAdminNews(editing.id, values)
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

  const diagnose = async () => {
    setDiagnosing(true)
    try {
      setDiagnoseResult(await diagnoseNewsFeeds())
    } catch {
      message.error(t('operationFail'))
    } finally {
      setDiagnosing(false)
    }
  }

  const categoryOptions = Object.keys(health?.categories || {}).map(x => ({ label: x, value: x }))
  const sourceOptions = Object.keys(health?.sources || {}).map(x => ({ label: x, value: x }))

  const columns: any[] = [
    {
      title: t('title'), dataIndex: 'title', key: 'title',
      render: (_: any, r: NewsAdminArticle) => (
        <div>
          <a href={r.url} target="_blank" rel="noreferrer"><Text strong>{r.title}</Text></a>
          <div style={{ marginTop: 4 }}>
            <Tag>{r.category}</Tag>
            <Tag>{r.source_name}</Tag>
            <Tag color={r.status === 'active' ? 'green' : 'default'}>
              {r.status === 'active' ? t('active') : t('hidden')}
            </Tag>
            <Tag color={r.is_ai_summarized ? 'blue' : 'orange'}>
              {r.is_ai_summarized ? t('aiDone') : t('aiPending')}
            </Tag>
          </div>
        </div>
      ),
    },
    { title: t('publishedAt'), dataIndex: 'published_at', key: 'published_at', width: 150,
      render: (v: string) => v?.slice(0, 16) },
    { title: t('fetchedAt'), dataIndex: 'fetched_at', key: 'fetched_at', width: 150,
      render: (v: string) => v?.slice(0, 16) },
    { title: t('viewCount'), dataIndex: 'view_count', key: 'view_count', width: 70 },
    { title: t('favoriteCount'), dataIndex: 'favorite_count', key: 'favorite_count', width: 70 },
    {
      title: t('actions'), key: 'actions', width: 240,
      render: (_: any, r: NewsAdminArticle) => (
        <Space size={4}>
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(r)}>
            {t('edit')}
          </Button>
          {r.status === 'active' ? (
            <Button size="small" type="text" icon={<StopOutlined />}
              onClick={async () => { await bulkAdminNews([r.id], 'hide'); await load(); await loadHealth() }}>
              {t('hide')}
            </Button>
          ) : (
            <Button size="small" type="text" icon={<CheckCircleOutlined />}
              onClick={async () => { await bulkAdminNews([r.id], 'restore'); await load(); await loadHealth() }}>
              {t('restore')}
            </Button>
          )}
          <Button size="small" type="text" icon={<SyncOutlined />}
            onClick={async () => {
              try {
                await resummarizeAdminNews(r.id)
                message.success(t('resummarizeQueued'))
                await load()
              } catch { message.error(t('operationFail')) }
            }} title={t('resummarize')} />
          {isAdmin && (
            <Popconfirm title={t('deleteConfirm')} onConfirm={async () => {
              await bulkAdminNews([r.id], 'delete')
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
          <Title level={3} style={{ margin: 0 }}>{t('newsTitle')}</Title>
          <Text type="secondary">{t('newsSubtitle')}</Text>
        </div>
        <Space wrap>
          <Button icon={<EyeOutlined />} onClick={() => window.open('/news-hub', '_blank')}>
            {t('previewStudent')}
          </Button>
          <Button icon={<SafetyCertificateOutlined />} loading={diagnosing} onClick={diagnose}>
            {t('sourceHealth')}
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => { void load(); void loadHealth() }}>
            {t('refresh')}
          </Button>
        </Space>
      </Space>

      <Row gutter={12} style={{ marginTop: 16 }}>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('newsActive')} value={health?.active ?? 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('newsHidden')} value={health?.hidden ?? 0} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('sourceName')} value={Object.keys(health?.sources || {}).length} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title={t('fetchedAt')} value={health?.last_fetch?.fetched_at?.slice(0, 16) || '—'} /></Card></Col>
      </Row>

      <Card size="small" style={{ marginTop: 12 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input.Search allowClear placeholder={t('searchPlaceholder')} style={{ width: 240 }}
            onSearch={(v) => setFilters(f => ({ ...f, keyword: v.trim() }))} />
          <Select value={filters.status} style={{ width: 130 }}
            onChange={(v) => setFilters(f => ({ ...f, status: v }))}
            options={[
              { label: t('allStatus'), value: '' },
              { label: t('active'), value: 'active' },
              { label: t('hidden'), value: 'hidden' },
            ]} />
          <Select value={filters.category} style={{ width: 140 }} allowClear
            placeholder={t('allCategories')}
            onChange={(v) => setFilters(f => ({ ...f, category: v || '' }))}
            options={categoryOptions} />
          <Select value={filters.source_name} style={{ width: 160 }} allowClear
            placeholder={t('allSources')}
            onChange={(v) => setFilters(f => ({ ...f, source_name: v || '' }))}
            options={sourceOptions} />
          <Select value={filters.ai_status} style={{ width: 140 }}
            onChange={(v) => setFilters(f => ({ ...f, ai_status: v }))}
            options={[
              { label: t('allAi'), value: '' },
              { label: t('aiDone'), value: 'yes' },
              { label: t('aiPending'), value: 'no' },
            ]} />
          <RangePicker onChange={(v: any) => setFilters(f => ({
            ...f,
            dateFrom: v?.[0]?.format('YYYY-MM-DD') || '',
            dateTo: v?.[1]?.format('YYYY-MM-DD') || '',
          }))} />
          <Button onClick={() => setFilters({
            keyword: '', status: '', category: '', source_name: '', ai_status: '',
            dateFrom: '', dateTo: '',
          })}>{t('reset')}</Button>
        </Space>

        {selected.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('selected', { count: selected.length })}
            action={
              <Space wrap>
                <Button size="small" onClick={() => bulk('hide')}>{t('bulkDisable')}</Button>
                <Button size="small" onClick={() => bulk('restore')}>{t('bulkEnable')}</Button>
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
          scroll={{ x: 1000 }}
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
        width={680}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="title" label={t('title')} rules={[{ required: true }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Space style={{ width: '100%' }} align="start" wrap>
            <Form.Item name="category" label={t('category')} style={{ width: 220 }} rules={[{ required: true }]}>
              <Input maxLength={40} />
            </Form.Item>
            <Form.Item name="status" label={t('status')} style={{ width: 180 }}>
              <Select options={[{ label: t('active'), value: 'active' }, { label: t('hidden'), value: 'hidden' }]} />
            </Form.Item>
          </Space>
          <Form.Item name="tags" label={t('tags')}>
            <Select mode="tags" tokenSeparators={[',', '，', '、']} />
          </Form.Item>
          <Form.Item name="related_subjects" label={t('relatedSubject')}>
            <Select mode="tags" tokenSeparators={[',', '，', '、']} />
          </Form.Item>
          <Form.Item name="admin_note" label={t('adminNote')}>
            <TextArea rows={3} maxLength={500} showCount />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('diagnoseResult')}
        open={!!diagnoseResult}
        onCancel={() => setDiagnoseResult(null)}
        footer={<Button onClick={() => setDiagnoseResult(null)}>{t('cancel')}</Button>}
        width={760}
      >
        {diagnoseResult?.suggestion && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={diagnoseResult.suggestion} />
        )}
        <Table
          size="small"
          rowKey={(r: any) => r.source}
          dataSource={diagnoseResult?.sources || []}
          pagination={false}
          columns={[
            { title: t('sourceName'), dataIndex: 'source' },
            { title: t('sourceOk'), dataIndex: 'ok', width: 80,
              render: (v: boolean) => <Tag color={v ? 'green' : 'red'}>{v ? 'OK' : '×'}</Tag> },
            { title: t('httpStatus'), dataIndex: 'http', width: 80 },
            { title: t('entries'), dataIndex: 'entries', width: 80 },
            { title: t('kept'), dataIndex: 'kept', width: 80 },
            { title: t('error'), dataIndex: 'error', ellipsis: true },
          ]}
        />
      </Modal>
    </Card>
  )
}

export default NewsAdminPage
