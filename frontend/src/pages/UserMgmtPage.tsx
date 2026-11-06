/**
 * 用户管理（台账式）
 *
 * 旧实现把 8 个后端接口做成了 8 个页签：查看一个学生要在「搜索 → 编辑 → 改密 → 删除」
 * 之间反复跳，且编辑必须先输账号再失焦触发加载、删除没有二次确认。
 * 现在是一张台账：统计条 → 筛选工具条 → 列表 → 点行进详情抽屉，
 * 批量导入/批量删除/升年级收进工具条，班级维护留在独立页签。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert, Button, Card, Col, Divider, Dropdown, Form, Input, Modal, Row, Select, Space, Table,
  Tag, Typography, message,
} from 'antd'
import {
  CloudUploadOutlined, DownloadOutlined, MoreOutlined, PlusOutlined, ReloadOutlined,
  UserOutlined,
} from '@ant-design/icons'
import * as usersApi from '../api/users'
import type { UserItem } from '../types'
import { useAuthStore } from '../stores/authStore'
import { useSubjectOptions } from '../hooks/useSubjectOptions'
import { useIsMobile } from '../hooks/useIsMobile'
import ListFilterBar from '../components/ListFilterBar'
import MobileCardTable from '../components/MobileCardTable'
import type { MobileCardColumn } from '../components/MobileCardTable'
import { ROLE_ADMIN, ROLE_LABEL, ROLE_STUDENT, ROLE_TEACHER, roleColor, roleToNumber } from './user-mgmt/roles'
import { ScopeTags } from './user-mgmt/ScopeFields'
import UserDetailDrawer from './user-mgmt/UserDetailDrawer'
import CreateUserModal from './user-mgmt/CreateUserModal'
import { BulkDeleteModal, ClassMgmtPanel, ImportUsersModal, PromoteGradesModal } from './user-mgmt/BulkOps'

interface ApiError {
  response?: { data?: { detail?: string } }
}

const PAGE_SIZE_DEFAULT = 20

type StatusFilter = 'active' | 'graduated' | 'all'

interface Filters {
  keyword: string
  status: StatusFilter
  grade: string
  classId?: number
  role?: number
}

// 默认视图 = 在校学生：台账最常见的用途是找人，教师只有几个人，顶部卡片一点就切过去。
// 这样初始高亮的统计卡与列表内容、条数三者一致（旧实现默认"在校生"却把教师也算进去）。
const EMPTY_FILTERS: Filters = {
  keyword: '', status: 'active', grade: '', classId: undefined, role: ROLE_STUDENT,
}

/** 学生/普通用户：这一页只剩自助改密，不再伪装成「用户管理」 */
const SelfPasswordCard: React.FC = () => {
  const { t } = useTranslation('system')
  const user = useAuthStore((s: { user: { username: string; role: string } | null }) => s.user)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      const msg = await usersApi.changePassword(user?.username || '', v.new_password)
      message.success(msg || t('passwordChanged'))
      form.resetFields()
    } catch (err) {
      message.error((err as ApiError)?.response?.data?.detail || t('changePasswordFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card style={{ maxWidth: 460 }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>{t('changePassword')}</Typography.Title>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('selfPasswordOnly')}
      </Typography.Text>
      <Form form={form} layout="vertical" style={{ marginTop: 16 }} onFinish={submit}>
        <Form.Item label={t('usernameLabel')}>
          <Input value={user?.username} disabled />
        </Form.Item>
        <Form.Item name="new_password" label={t('newPassword')} rules={[{ required: true, message: t('passwordRequired') }]}>
          <Input.Password placeholder={t('newPassword')} autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="confirm_password" label={t('confirmPassword')} dependencies={['new_password']}
          rules={[
            { required: true, message: t('passwordRequired') },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                return Promise.reject(new Error(t('passwordMismatch')))
              },
            }),
          ]}>
          <Input.Password placeholder={t('confirmPassword')} autoComplete="new-password" />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>{t('changePassword')}</Button>
      </Form>
    </Card>
  )
}

const StatCell: React.FC<{
  label: string; value: number; active?: boolean; onClick?: () => void
}> = ({ label, value, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      textAlign: 'left', cursor: onClick ? 'pointer' : 'default', padding: '10px 14px',
      borderRadius: 10, minWidth: 130,
      border: `1px solid ${active ? 'var(--primary-color)' : 'var(--border-color)'}`,
      background: active ? 'var(--primary-color-soft, rgba(22,119,255,.08))' : 'var(--bg-container)',
      transition: 'border-color .2s, background .2s',
    }}
  >
    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.4, color: 'var(--text-primary)' }}>{value}</div>
  </button>
)

const UserLedger: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const { t } = useTranslation('system')
  const isMobile = useIsMobile()
  const { subjects } = useSubjectOptions()

  const [stats, setStats] = useState<usersApi.UserStats | null>(null)
  const [rows, setRows] = useState<UserItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [keywordInput, setKeywordInput] = useState('')

  const [detailUser, setDetailUser] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [promoteOpen, setPromoteOpen] = useState(false)
  const [classCleanupOpen, setClassCleanupOpen] = useState(false)

  const loadStats = useCallback(async () => {
    try {
      setStats(await usersApi.getUserStats())
    } catch {
      /* 统计失败不该挡住列表，静默降级 */
    }
  }, [])

  const loadRows = useCallback(async () => {
    setLoading(true)
    try {
      const { users, total: n } = await usersApi.queryUsers({
        keyword: filters.keyword,
        status: filters.status,
        grade: filters.grade || undefined,
        class_id: filters.classId,
        role: filters.role,
        page,
        page_size: pageSize,
      })
      setRows(users)
      setTotal(n)
    } catch (err) {
      message.error((err as ApiError)?.response?.data?.detail || t('loadUserListFailed'))
      setRows([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [filters, page, pageSize, t])

  useEffect(() => { void loadStats() }, [loadStats])
  useEffect(() => { void loadRows() }, [loadRows])

  // 关键词防抖：每敲一个字都打后端会把 1400 人的表拖成幻灯片
  useEffect(() => {
    const id = setTimeout(() => {
      setFilters(f => (f.keyword === keywordInput.trim() ? f : { ...f, keyword: keywordInput.trim() }))
      setPage(1)
    }, 300)
    return () => clearTimeout(id)
  }, [keywordInput])

  const patch = (next: Partial<Filters>) => {
    setFilters(f => ({ ...f, ...next }))
    setPage(1)
  }

  const resetFilters = () => {
    setFilters(EMPTY_FILTERS)
    setKeywordInput('')
    setPage(1)
  }

  const dirty = filters.keyword !== '' || filters.status !== EMPTY_FILTERS.status
    || !!filters.grade || filters.classId !== undefined || filters.role !== EMPTY_FILTERS.role

  const gradeOptions = useMemo(
    () => (stats?.grades || []).map(g => ({ value: g.grade, label: `${g.grade}（${g.count}）` })),
    [stats],
  )
  const classOptions = useMemo(() => {
    const list = (stats?.classes || []).filter(c => !filters.grade || c.grade === filters.grade)
    return list.map(c => ({ value: c.class_id, label: `${c.display_name}（${c.students}）` }))
  }, [stats, filters.grade])

  // 新建/详情里的年级班级下拉：学生班级是纯数字字符串，与筛选用的 class_id 不是一回事
  const gradeNames = useMemo(() => (stats?.grades || []).map(g => g.grade), [stats])
  const classOptionsForForm = useMemo(
    () => (stats?.classes || []).map(c => {
      const m = c.display_name.match(/(\d+)\s*班?\s*$/)
      return { value: m ? m[1] : c.display_name, label: c.display_name }
    }),
    [stats],
  )

  const refreshAll = useCallback(() => {
    void loadRows()
    void loadStats()
  }, [loadRows, loadStats])

  const handleRestore = async (username: string) => {
    try {
      const res = await usersApi.restoreGraduatedUser(username)
      message.success(res.message || t('restoreSuccess'))
      refreshAll()
    } catch (err) {
      message.error((err as ApiError)?.response?.data?.detail || t('restoreFailed'))
    }
  }

  const handleExport = async () => {
    const hide = message.loading(t('exporting'), 0)
    try {
      await usersApi.exportUsersCsv(filters.keyword || undefined)
      hide()
      message.success(t('exportSuccess'))
    } catch (err) {
      hide()
      const ae = err as ApiError & { response?: { data?: ArrayBuffer } }
      let detail = (ae?.response?.data as unknown as { detail?: string })?.detail
      if (!detail && ae?.response?.data instanceof ArrayBuffer) {
        try { detail = JSON.parse(new TextDecoder().decode(ae.response.data)).detail } catch { /* ignore */ }
      }
      message.error(detail || t('exportFailed'))
    }
  }

  const columns = useMemo(() => [
    {
      title: t('name'), dataIndex: 'name', key: 'name', width: 130,
      render: (v: string) => <Typography.Text strong>{v || '—'}</Typography.Text>,
    },
    {
      title: t('username'), dataIndex: 'username', key: 'username', width: 150,
      render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text>,
    },
    {
      title: t('colGradeClass'), key: 'scope', width: 260,
      render: (_: unknown, r: UserItem) => <ScopeTags grade={r.grade} cls={r.class} />,
    },
    {
      title: t('gender'), dataIndex: 'gender', key: 'gender', width: 70,
      render: (v: string) => v || '—',
    },
    {
      title: t('role'), dataIndex: 'role', key: 'role', width: 100,
      render: (v: string) => <Tag color={roleColor(v)}>{v}</Tag>,
    },
    {
      title: t('statusCol'), key: 'status', width: 100,
      render: (_: unknown, r: UserItem) => {
        if (roleToNumber(r.role) !== ROLE_STUDENT) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        return r.status === 'graduated'
          ? <Tag color="orange">{t('graduateTag')}{r.graduated_year ? `·${r.graduated_year}` : ''}</Tag>
          : <Tag color="green">{t('enrolledTag')}</Tag>
      },
    },
    {
      title: t('teachingSubjects'), dataIndex: 'subjects', key: 'subjects', width: 160,
      render: (_: unknown, r: UserItem) => {
        if (roleToNumber(r.role) === ROLE_ADMIN) return <Typography.Text type="secondary">{t('allSubjects')}</Typography.Text>
        if (roleToNumber(r.role) !== ROLE_TEACHER || !r.subjects?.length) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
        return <Typography.Text type="secondary">{r.subjects.join('、')}</Typography.Text>
      },
    },
    {
      title: t('actionsCol'), key: 'act', width: 140, fixed: 'right' as const,
      render: (_: unknown, r: UserItem) => (
        <Space size={4}>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setDetailUser(r.username)}>
            {t('viewDetail')}
          </Button>
          {r.status === 'graduated' && (
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => void handleRestore(r.username)}>
              {t('restoreBtn')}
            </Button>
          )}
        </Space>
      ),
    },
  ], [t])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        {[
          {
            key: 'all', label: t('statsAll'), value: stats?.total ?? 0,
            onClick: () => { setFilters({ ...EMPTY_FILTERS, status: 'all' }); setKeywordInput(''); setPage(1) },
            active: filters.status === 'all' && filters.role === undefined && !filters.grade && filters.classId === undefined,
          },
          {
            key: 'students', label: t('statsStudents'), value: stats?.active_students ?? 0,
            onClick: () => { setFilters({ ...EMPTY_FILTERS, status: 'active', role: ROLE_STUDENT }); setKeywordInput(''); setPage(1) },
            active: filters.status === 'active' && filters.role === ROLE_STUDENT,
          },
          {
            key: 'teachers', label: t('statsTeachers'), value: stats?.teachers ?? 0,
            onClick: () => { setFilters({ ...EMPTY_FILTERS, status: 'all', role: ROLE_TEACHER }); setKeywordInput(''); setPage(1) },
            active: filters.role === ROLE_TEACHER,
          },
          {
            key: 'graduated', label: t('statsGraduated'), value: stats?.graduated ?? 0,
            onClick: () => { setFilters({ ...EMPTY_FILTERS, status: 'graduated', role: ROLE_STUDENT }); setKeywordInput(''); setPage(1) },
            active: filters.status === 'graduated',
          },
        ].map(c => (
          <Col key={c.key} xs={12} sm={12} md={6}>
            <StatCell label={c.label} value={c.value} active={c.active} onClick={c.onClick} />
          </Col>
        ))}
      </Row>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <ListFilterBar
          keyword={keywordInput}
          onKeyword={setKeywordInput}
          searchPlaceholder={t('searchPlaceholder')}
          searchWidth={220}
          status={filters.status}
          statusOptions={[
            { value: 'active', label: t('filterActive') },
            { value: 'graduated', label: t('filterGraduated') },
            { value: 'all', label: t('filterAll') },
          ]}
          onStatus={(v) => patch({ status: v as StatusFilter })}
          dirty={dirty}
          onReset={resetFilters}
          extra={(
            <Space wrap size={8}>
              <Select
                size="small" allowClear style={{ width: 130 }} placeholder={t('filterGrade')}
                value={filters.grade || undefined}
                onChange={(v) => patch({ grade: v || '', classId: undefined })}
                options={gradeOptions}
              />
              <Select
                size="small" allowClear style={{ width: 150 }} placeholder={t('filterClass')}
                value={filters.classId}
                onChange={(v) => patch({ classId: v })}
                options={classOptions}
              />
              <Select
                size="small" allowClear style={{ width: 130 }} placeholder={t('filterRole')}
                value={filters.role}
                onChange={(v) => patch({ role: v })}
                options={[
                  { value: ROLE_STUDENT, label: ROLE_LABEL[ROLE_STUDENT] },
                  { value: ROLE_TEACHER, label: ROLE_LABEL[ROLE_TEACHER] },
                  { value: ROLE_ADMIN, label: ROLE_LABEL[ROLE_ADMIN] },
                ]}
              />
            </Space>
          )}
        />

        <Space wrap style={{ marginBottom: 12, marginLeft: 'auto' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>{t('createUser')}</Button>
          <Button icon={<CloudUploadOutlined />} onClick={() => setImportOpen(true)}>{t('batchImport')}</Button>
          <Button icon={<DownloadOutlined />} onClick={handleExport}>{t('exportUsers')}</Button>
          <Button icon={<ReloadOutlined />} onClick={refreshAll} loading={loading} aria-label={t('refresh')} />
          {isAdmin && (
            <Dropdown
              menu={{
                items: [
                  { key: 'bulk-delete', label: t('bulkDelete'), danger: true },
                  { key: 'promote', label: t('batchUpgradeTitle') },
                  { key: 'class-cleanup', label: t('cleanEmptyClasses') },
                ],
                onClick: ({ key }) => {
                  if (key === 'bulk-delete') setBulkDeleteOpen(true)
                  else if (key === 'promote') setPromoteOpen(true)
                  else setClassCleanupOpen(true)
                },
              }}
            >
              <Button icon={<MoreOutlined />}>{t('moreActions')}</Button>
            </Dropdown>
          )}
        </Space>
      </div>

      {total > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('totalAccounts', { count: total })}
        </Typography.Text>
      )}

      {isMobile ? (
        <MobileCardTable
          dataSource={rows as unknown as never[]}
          columns={columns as unknown as MobileCardColumn[]}
          rowKey="username"
          loading={loading}
          titleKey="name"
          pagination={{ current: page, pageSize, total, onChange: setPage }}
          emptyText={<Alert type="info" showIcon style={{ marginTop: 8 }} title={t('emptyUsers')} description={t('emptyUsersHint')} />}
        />
      ) : (
        <Table
          dataSource={rows}
          columns={columns}
          rowKey="username"
          loading={loading}
          size="middle"
          scroll={{ x: 1120 }}
          locale={{
            emptyText: (
              <div style={{ padding: '32px 0' }}>
                <Typography.Text type="secondary">{t('emptyUsers')}</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  <Button size="small" onClick={resetFilters}>{t('emptyUsersHint')}</Button>
                </div>
              </div>
            ),
          }}
          onRow={(r: UserItem) => ({
            onClick: () => setDetailUser(r.username),
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100],
            showTotal: (n: number) => t('totalAccounts', { count: n }),
            onChange: (p: number, ps: number) => { setPage(p); setPageSize(ps) },
          }}
        />
      )}

      <UserDetailDrawer
        username={detailUser}
        open={!!detailUser}
        onClose={() => setDetailUser(null)}
        onChanged={refreshAll}
        isAdmin={isAdmin}
        gradeOptions={gradeNames}
        classOptions={classOptionsForForm}
        subjectOptions={subjects}
      />
      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={refreshAll}
        isAdmin={isAdmin}
        gradeOptions={gradeNames}
        classOptions={classOptionsForForm}
        subjectOptions={subjects}
      />
      <ImportUsersModal open={importOpen} onClose={() => setImportOpen(false)} onImported={refreshAll} />
      <BulkDeleteModal open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} onDeleted={refreshAll} />
      <PromoteGradesModal open={promoteOpen} onClose={() => setPromoteOpen(false)} isAdmin={isAdmin} onDone={refreshAll} />
      {/* 空壳班级清理：不是日常页面，做成一次性动作，只在「更多」里出现 */}
      <Modal
        title={t('cleanEmptyClasses')}
        open={classCleanupOpen}
        onCancel={() => setClassCleanupOpen(false)}
        footer={<Button onClick={() => setClassCleanupOpen(false)}>{t('cancel')}</Button>}
        width={760}
        styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
      >
        <ClassMgmtPanel />
      </Modal>
    </div>
  )
}

const UserMgmtPage: React.FC = () => {
  const { t } = useTranslation('system')
  const user = useAuthStore((s: { user: { username: string; role: string } | null }) => s.user)
  const isAdmin = user?.role === 'admin'
  const isTeacher = user?.role === 'teacher'

  if (!isAdmin && !isTeacher) {
    return (
      <div style={{ padding: 24, background: 'var(--bg-container)', borderRadius: 8, minHeight: 'calc(100vh - 112px)' }}>
        <Space align="center" style={{ marginBottom: 12 }}>
          <UserOutlined style={{ color: 'var(--primary-color)', fontSize: 18 }} />
          <Typography.Title level={4} style={{ margin: 0 }}>{t('changePassword')}</Typography.Title>
        </Space>
        <SelfPasswordCard />
      </div>
    )
  }

  return (
    <div style={{ padding: 24, background: 'var(--bg-container)', borderRadius: 8, minHeight: 'calc(100vh - 112px)' }}>
      <Space align="center" style={{ marginBottom: 4 }}>
        <UserOutlined style={{ color: 'var(--primary-color)', fontSize: 18 }} />
        <Typography.Title level={4} style={{ margin: 0 }}>{t('userManagement')}</Typography.Title>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        {t('userMgmtIntro')}
      </Typography.Paragraph>
      <Divider style={{ margin: '8px 0 12px' }} />
      <UserLedger isAdmin={isAdmin} />
    </div>
  )
}

export default UserMgmtPage
