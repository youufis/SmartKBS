import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
// 用户管理
import {
  Layout, Card, Tabs, Form, Input, Button, message,
  Modal, Progress, Table, Upload, Space, Radio, Select, Typography,
  Tag, Checkbox, Alert,
} from 'antd'
import { UploadOutlined, DownloadOutlined, SearchOutlined, ReloadOutlined, RiseOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, RollbackOutlined } from '@ant-design/icons'
import * as usersApi from '../api/users'
import type { UserItem } from '../types'
import type {
  ImportProgressEvent, BulkDeleteProgressEvent, BulkMatchMode,
  GradePromotionPreview, GradePromotionResult,
} from '../api/users'
import { useAuthStore } from '../stores/authStore'
import { useSubjectOptions } from '../hooks/useSubjectOptions'

interface ApiError {
  response?: { data?: { detail?: string } }
}

const UserMgmtPage: React.FC = () => {
  const { t } = useTranslation('system')
  const user = useAuthStore((s: { user: { username: string; role: string } | null }) => s.user)
  const isAdmin = user?.role === 'admin'
  const isTeacher = user?.role === 'teacher'

  const { subjects } = useSubjectOptions()

  // ── 注册 ──
  const [regForm] = Form.useForm()
  const handleRegister = async (values: Record<string, unknown>) => {
    const v = values as Record<string, string> & { subjects?: string[] }
    try {
      const msg = await usersApi.registerUser({
        username: v.username,
        password: v.password,
        class_val: v.class_val || '',
        name: v.name || '',
        gender: v.gender === '男' ? 1 : 0,
        role: v.role === '管理员' ? 0 : v.role === '教师' ? 1 : 2,
        grade: v.grade || '',
        subjects: v.subjects || [],
      })
      message.success(msg)
      regForm.resetFields()
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || t('registerFailed'))
    }
  }

  // ── 更新信息 ──
  const [updForm] = Form.useForm()
  const handleUpdateUsernameBlur = async (e: React.FocusEvent<HTMLInputElement>) => {
    const username = e.target.value?.trim()
    if (!username) return
    try {
      const data = await usersApi.getUserInfo(username)
      updForm.setFieldsValue({
        name: data.name || '',
        grade: data.grade || '',
        class_val: data.class || '',
        gender: data.gender === '男' ? '男' : '女',
        role: data.role_name || '普通用户',
        subjects: data.subjects || [],
      })
      // 管理员默认全部学科
      if (data.role_name === '管理员') {
        updForm.setFieldsValue({ subjects })
      }
    } catch { /* 用户不存在 */ }
  }
  const handleUpdate = async (values: Record<string, unknown>) => {
    const v = values as Record<string, string> & { subjects?: string[] }
    try {
      const msg = await usersApi.updateUserInfo(
        v.username, v.class_val || '',
        v.name || '', v.gender === '男' ? 1 : 0,
        v.grade || '', v.subjects || [],
      )
      message.success(msg)
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || t('updateFailed'))
    }
  }

  // ── 修改密码 ──
  const [pwdForm] = Form.useForm()
  // 非管理员自动填入当前用户名
  React.useEffect(() => {
    if (!isAdmin && user?.username) {
      pwdForm.setFieldsValue({ username: user.username })
    }
  }, [isAdmin, user?.username, pwdForm])
  const handleChangePwd = async (values: Record<string, unknown>) => {
    const v = values as Record<string, string>
    if (!v.username || !v.new_password) {
      message.warning(t('usernamePasswordRequired'))
      return
    }
    // 普通用户只能改自己的
    if (!isAdmin && v.username !== user?.username) {
      message.error(t('permissionDenied') + '：' + t('selfPasswordOnly'))
      return
    }
    try {
      const msg = await usersApi.changePassword(v.username, v.new_password)
      message.success(msg)
      pwdForm.resetFields()
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || t('changePasswordFailed'))
    }
  }

  // ── 删除用户 ──
  const [delForm] = Form.useForm()
  const handleDelete = async (values: Record<string, unknown>) => {
    const v = values as Record<string, string>
    try {
      const msg = await usersApi.deleteUser(v.username)
      message.success(msg)
      delForm.resetFields()
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || t('deleteFailed'))
    }
  }

  // ── 查询用户（支持用户名/姓名模糊搜索） ──
  const [searchForm] = Form.useForm()
  const [searchResult, setSearchResult] = useState<UserItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const handleSearch = async (values: Record<string, unknown>) => {
    const v = values as Record<string, string>
    const keyword = v.keyword?.trim()
    if (!keyword) {
      message.warning(t('searchKeywordRequired'))
      return
    }
    setSearchLoading(true)
    try {
      const { users } = await usersApi.getAllUsers(keyword)
      setSearchResult(users)
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || t('searchFailed'))
      setSearchResult([])
    } finally {
      setSearchLoading(false)
    }
  }

  // ── 用户列表 ──
  const [allUsers, setAllUsers] = useState<UserItem[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const handleListUsers = async () => {
    setUsersLoading(true)
    try {
      const { users } = await usersApi.getAllUsers()
      setAllUsers(users)
    } catch {
      message.error(t('loadUserListFailed'))
    } finally {
      setUsersLoading(false)
    }
  }

  // ── 批量删除：先预览匹配结果 -> 二次确认 -> 流式删除（带进度） ──
  const [bulkPattern, setBulkPattern] = useState('')
  const [bulkMatchMode, setBulkMatchMode] = useState<BulkMatchMode>('prefix')
  const [bulkPreview, setBulkPreview] = useState<usersApi.BulkDeletePreview | null>(null)
  const [bulkPreviewOpen, setBulkPreviewOpen] = useState(false)
  const [bulkPreviewLoading, setBulkPreviewLoading] = useState(false)
  const [bulkConfirmed, setBulkConfirmed] = useState(false)
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<{
    visible: boolean
    percent: number
    current: number
    total: number
    deleted: number
    errorCount: number
    errors: string[]
    message: string
    done: boolean
  }>({
    visible: false,
    percent: 0,
    current: 0,
    total: 0,
    deleted: 0,
    errorCount: 0,
    errors: [],
    message: '',
    done: false,
  })

  /** 第一步：查询匹配到的用户（只读，不会删除任何数据） */
  const openBulkDeletePreview = async () => {
    const pattern = bulkPattern.trim()
    if (!pattern) { message.warning(t('enterPattern')); return }
    setBulkPreviewLoading(true)
    try {
      const preview = await usersApi.previewBulkDelete(pattern, bulkMatchMode)
      setBulkPreview(preview)
      setBulkConfirmed(false)
      if (preview.matched_count === 0) {
        setBulkPreviewOpen(false)
        message.warning(t('noDeletableMatched'))
        return
      }
      setBulkPreviewOpen(true)
    } catch (err: unknown) {
      message.error(usersApi.extractApiErrorDetail((err as ApiError)?.response?.data) || t('queryMatchFailed'))
    } finally {
      setBulkPreviewLoading(false)
    }
  }

  const closeBulkDeletePreview = () => {
    setBulkPreviewOpen(false)
    setBulkConfirmed(false)
  }

  /** 第二步：用户确认后才真正删除（必须带 confirm=true） */
  const handleBulkDelete = async () => {
    if (!bulkPreview || bulkPreview.matched_count === 0) { closeBulkDeletePreview(); return }
    if (!bulkConfirmed) { message.warning(t('tickConfirmFirst')); return }
    setBulkPreviewOpen(false)
    setBulkConfirmed(false)
    setBulkDeleteProgress({
      visible: true,
      percent: 0,
      current: 0,
      total: bulkPreview.matched_count,
      deleted: 0,
      errorCount: 0,
      errors: [],
      message: t('startDeleteCount', { count: bulkPreview.matched_count }),
      done: false,
    })
    try {
      await usersApi.bulkDeleteUsersStream(
        bulkPreview.pattern,
        (event: BulkDeleteProgressEvent) => {
          if (event.type === 'start') {
            setBulkDeleteProgress(prev => ({
              ...prev,
              total: event.total || 0,
              message: t('prepareDeleteCount', { count: event.total }),
            }))
          } else if (event.type === 'progress') {
            setBulkDeleteProgress(prev => ({
              ...prev,
              percent: event.percent || 0,
              current: event.current || 0,
              total: event.total || 0,
              deleted: event.deleted || 0,
              errorCount: event.error_count || 0,
              message: t('deletingProgress', { current: event.current, total: event.total }),
            }))
          } else if (event.type === 'done') {
            const errList = event.errors || []
            setBulkDeleteProgress(prev => ({
              ...prev,
              percent: 100,
              current: prev.total,
              deleted: event.deleted || 0,
              errorCount: event.error_count || 0,
              errors: errList,
              message: event.message || t('batchDeleteDone'),
              done: true,
            }))
            // 删除完成后刷新用户列表，界面立即反映结果
            if ((event.deleted || 0) > 0) void handleListUsers()
          }
        },
        bulkPreview.match_mode,
        true,
      )
    } catch (err: unknown) {
      setBulkDeleteProgress(prev => ({
        ...prev,
        message: err instanceof Error ? err.message : t('batchDeleteFailed'),
        done: true,
      }))
    }
  }

  const handleBulkDeleteDone = () => {
    setBulkDeleteProgress(prev => ({ ...prev, visible: false }))
    setBulkPreview(null)
    setBulkPattern('')
  }

  // ── 批量升年级 ──
  const [promotePreview, setPromotePreview] = useState<GradePromotionPreview | null>(null)
  const [promoteLoading, setPromoteLoading] = useState(false)
  const [promoteExecuting, setPromoteExecuting] = useState(false)
  const [promoteResult, setPromoteResult] = useState<GradePromotionResult | null>(null)
  const [promoteOptions, setPromoteOptions] = useState({
    sync_scores: true,
    sync_rollcall: true,
    match_class: true,
  })
  const [promoteReversing, setPromoteReversing] = useState(false)

  const handlePreviewPromote = async () => {
    setPromoteLoading(true)
    setPromoteResult(null)
    try {
      const preview = await usersApi.previewPromoteGrades()
      setPromotePreview(preview)
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || t('promotePreviewFailed'))
    } finally {
      setPromoteLoading(false)
    }
  }

  const handleExecutePromote = async () => {
    // 动态构建升级描述
    const promoteDesc = promotePreview?.grade_details
      ?.filter(d => d.next_grade)
      .map(d => `${d.grade}→${d.next_grade}`)
      ?.join('，') || t('autoUpgradeByStage')
    const graduateDesc = promotePreview?.grade_details
      ?.filter(d => !d.next_grade && d.count > 0)
      .map(d => t('gradeCountItem', { grade: d.grade, count: d.count }))
      ?.join('、')

    Modal.confirm({
      title: t('confirmBatchUpgradeTitle'),
      icon: <WarningOutlined />,
      width: 520,
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>此操作将执行以下变更：</p>
          <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
            <li>更新所有学生的年级（{promoteDesc}）</li>
            {graduateDesc && <li>毕业年级学生保持现状：{graduateDesc}</li>}
            {promoteOptions.sync_scores && <li>同步更新课堂积分的年级归属</li>}
            {promoteOptions.sync_rollcall && <li>同步更新点名数据的年级归属</li>}
            {promoteOptions.match_class && <li>按同名班级自动匹配新年级班级</li>}
          </ul>
          <p style={{ color: '#fa8c16', marginTop: 8 }}>此操作不可撤销，请确认已备份数据。</p>
        </div>
      ),
      okText: t('confirmExecute'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        setPromoteExecuting(true)
        try {
          const result = await usersApi.executePromoteGrades({
            ...promoteOptions,
            confirm: true,
          })
          setPromoteResult(result)
          if (result.success) {
            message.success(t('promoteExecSuccess'))
            // 刷新预览
            handlePreviewPromote()
          }
        } catch (err: unknown) {
          message.error((err as ApiError)?.response?.data?.detail || t('promoteExecFailed'))
        } finally {
          setPromoteExecuting(false)
        }
      },
    })
  }

  const handleReversePromote = async () => {
    // 构建降级描述
    const reverseDesc = promotePreview?.grade_details
      ?.filter(d => d.next_grade)
      .map(d => `${d.next_grade}→${d.grade}`)
      ?.join('，') || ''

    Modal.confirm({
      title: t('confirmBatchDemoteTitle'),
      icon: <WarningOutlined />,
      width: 520,
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>降级是升年级的逆操作，将执行以下变更：</p>
          <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
            <li>{reverseDesc || t('demoteByUpgradeMap')}</li>
            {promoteOptions.sync_scores && <li>同步降级课堂积分的年级归属</li>}
            {promoteOptions.sync_rollcall && <li>同步降级点名数据的年级归属</li>}
            {promoteOptions.match_class && <li>按同名班级自动匹配</li>}
          </ul>
          <p style={{ color: '#fa8c16', marginTop: 8 }}>毕业年级学生不受影响。降级可多次执行，每次都是升年级的逆操作。</p>
        </div>
      ),
      okText: t('confirmDemote'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        setPromoteReversing(true)
        try {
          const result = await usersApi.reversePromoteGrades({
            ...promoteOptions,
            confirm: true,
          })
          if (result.success) {
            message.success(t('demoteSuccess'))
            setPromotePreview(null)
            setPromoteResult(result)
            // 刷新预览
            handlePreviewPromote()
          }
        } catch (err: unknown) {
          message.error((err as ApiError)?.response?.data?.detail || t('demoteFailed'))
        } finally {
          setPromoteReversing(false)
        }
      },
    })
  }

  // ── CSV 导入（含进度提示） ──
  const [importProgress, setImportProgress] = useState<{
    visible: boolean
    percent: number
    current: number
    total: number
    imported: number
    errorCount: number
    errors: string[]
    message: string
    done: boolean
  }>({
    visible: false,
    percent: 0,
    current: 0,
    total: 0,
    imported: 0,
    errorCount: 0,
    errors: [],
    message: '',
    done: false,
  })

  const handleImport = async (file: File) => {
    setImportProgress({
      visible: true,
      percent: 0,
      current: 0,
      total: 0,
      imported: 0,
      errorCount: 0,
      errors: [],
      message: t('parsingFile'),
      done: false,
    })

    try {
      await usersApi.importUsersStream(file, (event: ImportProgressEvent) => {
        if (event.type === 'start') {
          setImportProgress(prev => ({
            ...prev,
            total: event.total || 0,
            message: t('prepareImportCount', { count: event.total }),
          }))
        } else if (event.type === 'progress') {
          setImportProgress(prev => ({
            ...prev,
            percent: event.percent || 0,
            current: event.current || 0,
            total: event.total || 0,
            imported: event.imported || 0,
            errorCount: event.error_count || 0,
            message: t('importingProgress', { current: event.current, total: event.total }),
          }))
        } else if (event.type === 'done') {
          const errList = event.errors || []
          setImportProgress(prev => ({
            ...prev,
            percent: 100,
            imported: event.imported || 0,
            errorCount: event.error_count || 0,
            errors: errList,
            message: event.message || t('importDone'),
            done: true,
          }))
        }
      })
    } catch (err: unknown) {
      setImportProgress(prev => ({
        ...prev,
        message: err instanceof Error ? err.message : t('importFailed'),
        done: true,
      }))
    }
    return false
  }

  const handleImportDone = () => {
    setImportProgress(prev => ({ ...prev, visible: false }))
  }

  // ── 下载模板 ──
  const handleDownloadTemplate = async () => {
    window.open('/api/users/import/template', '_blank')
  }

  const genderRadios = [
    { label: t('male'), value: '男' },
    { label: t('female'), value: '女' },
  ]
  const roleRadios = [
    { label: t('student'), value: '普通用户' },
    { label: t('teacher'), value: '教师' },
    { label: t('admin'), value: '管理员' },
  ]

  const userColumns = [
    { title: t('username'), dataIndex: 'username', key: 'username', width: 120 },
    { title: t('name'), dataIndex: 'name', key: 'name', width: 100 },
    { title: t('grade'), dataIndex: 'grade', key: 'grade', width: 60 },
    { title: t('class_'), dataIndex: 'class', key: 'class', width: 80 },
    { title: t('gender'), dataIndex: 'gender', key: 'gender', width: 60 },
    { title: t('role'), dataIndex: 'role', key: 'role', width: 80 },
    {
      title: t('teachingSubjects'),
      dataIndex: 'subjects',
      key: 'subjects',
      width: 180,
      render: (_: any, record: any) => {
        if (record.role === '管理员') return t('allSubjects')
        if (record.role !== '教师' || !record.subjects?.length) return '-'
        return record.subjects.join('、')
      },
    },
  ]

  // 定义各标签页的可见权限
  // 教师和管理员拥有相同的用户管理权限
  const tabPermissions: Record<string, boolean> = {
    register: isAdmin || isTeacher,
    update: isAdmin || isTeacher,
    password: true,            // 所有人可用
    delete: isAdmin || isTeacher,
    search: isAdmin || isTeacher,
    list: isAdmin || isTeacher,
    import: isAdmin || isTeacher,
  }

  const tabItems = [
    {
      key: 'register',
      label: t('addUser'),
      children: (
        <Form form={regForm} layout="vertical" onFinish={handleRegister} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label={t('usernameLabel')} rules={[{ required: true }]}>
            <Input placeholder={t('usernamePlaceholder')} />
          </Form.Item>
          <Form.Item name="password" label={t('passwordLabel')} rules={[{ required: true }]}>
            <Input.Password placeholder={t('passwordPlaceholder')} />
          </Form.Item>
          <Form.Item name="grade" label={t('gradeLabel')} extra={<>{t('multiGradeHelp')}</>}>
            <Input placeholder={t('gradePlaceholder')} />
          </Form.Item>
          <Form.Item name="class_val" label={t('classLabel')} extra={<>{t('multiClassHelp')}</>}>
            <Input placeholder={t('classPlaceholder')} />
          </Form.Item>
          <Form.Item name="name" label={t('nameLabel')}><Input placeholder={t('namePlaceholder')} /></Form.Item>
          <Form.Item name="gender" label={t('genderLabel')} initialValue="男"><Radio.Group options={genderRadios} /></Form.Item>
          <Form.Item name="role" label={t('roleLabel')} initialValue="普通用户"><Radio.Group options={roleRadios} /></Form.Item>
          <Form.Item shouldUpdate={(prev, cur) => prev.role !== cur.role} noStyle>
            {({ getFieldValue }) => {
              const role = getFieldValue('role')
              const isTeacherOrAdmin = role === '教师' || role === '管理员'
              return (
                <Form.Item name="subjects" label={t('teachingSubjectsLabel')} hidden={!isTeacherOrAdmin}
                  initialValue={role === '管理员' ? [...subjects] : undefined}
                  extra={<>{t('configSubjectsFirst')}<Button type="link" size="small" onClick={() => window.open('/system-config', '_blank')} style={{ padding: 0 }}>{t('configSubjectsLink')}</Button></>}>
                  <Select mode="multiple" placeholder={t('selectSubjectsPlaceholder')} allowClear
                    options={subjects.map(s => ({ label: s, value: s }))} />
                </Form.Item>
              )
            }}
          </Form.Item>
          <Button type="primary" htmlType="submit">{t('register')}</Button>
        </Form>
      ),
    },
    {
      key: 'update',
      label: t('editUser'),
      children: (
        <Form form={updForm} layout="vertical" onFinish={handleUpdate} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label={t('usernameLabel')} rules={[{ required: true }]}>
            <Input placeholder={t('usernameSearchPlaceholder')} onBlur={handleUpdateUsernameBlur} />
          </Form.Item>
          <Form.Item name="role" label={t('roleLabel')}>
            <Radio.Group options={roleRadios} />
          </Form.Item>
          <Form.Item shouldUpdate={(prev, cur) => prev.role !== cur.role} noStyle>
            {({ getFieldValue }) => {
              const role = getFieldValue('role')
              const isTeacherOrAdmin = role === '教师' || role === '管理员'
              return (
                <Form.Item name="subjects" label={t('teachingSubjectsLabel')} hidden={!isTeacherOrAdmin}
                  initialValue={role === '管理员' ? [...subjects] : undefined}
                  extra={<>{t('configSubjectsFirst')}<Button type="link" size="small" onClick={() => window.open('/system-config', '_blank')} style={{ padding: 0 }}>{t('configSubjectsLink')}</Button></>}>
                  <Select mode="multiple" placeholder={t('selectSubjectsPlaceholder')} allowClear
                    options={subjects.map(s => ({ label: s, value: s }))} />
                </Form.Item>
              )
            }}
          </Form.Item>
          <Form.Item name="grade" label={t('gradeLabel')} extra={<>{t('multiGradeHelp')}</>}>
            <Input placeholder={t('gradePlaceholder')} />
          </Form.Item>
          <Form.Item name="class_val" label={t('classLabel')} extra={<>{t('multiClassHelp')}</>}>
            <Input placeholder={t('classPlaceholder')} />
          </Form.Item>
          <Form.Item name="name" label={t('nameLabel')}><Input /></Form.Item>
          <Form.Item name="gender" label={t('genderLabel')} initialValue="男"><Radio.Group options={genderRadios} /></Form.Item>
          <Button type="primary" htmlType="submit">{t('edit')}</Button>
        </Form>
      ),
    },
    {
      key: 'password',
      label: t('changePassword'),
      children: (
        <Form form={pwdForm} layout="vertical" onFinish={handleChangePwd} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label={t('usernameLabel')} rules={[{ required: true }]}>
            <Input placeholder={t('usernameLabel')} disabled={!isAdmin} />
          </Form.Item>
          <Form.Item name="new_password" label={t('newPassword')} rules={[{ required: true }]}>
            <Input.Password placeholder={t('newPassword')} />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label={t('confirmPassword')}
            dependencies={['new_password']}
            rules={[
              { required: true, message: t('passwordRequired') },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error(t('passwordMismatch')))
                },
              }),
            ]}
          >
            <Input.Password placeholder={t('confirmPassword')} />
          </Form.Item>
          <Button type="primary" htmlType="submit">{t('changePassword')}</Button>
        </Form>
      ),
    },
    {
      key: 'delete',
      label: t('deleteUser'),
      children: (
        <Form form={delForm} layout="vertical" onFinish={handleDelete} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label={t('usernameLabel')} rules={[{ required: true }]}><Input placeholder={t('usernameLabel')} /></Form.Item>
          <Button type="primary" danger htmlType="submit">{t('deleteUser')}</Button>
        </Form>
      ),
    },
    {
      key: 'search',
      label: t('searchUser'),
      children: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Form form={searchForm} layout="inline" onFinish={handleSearch}>
            <Form.Item name="keyword" rules={[{ required: true }]}>
              <Input placeholder={t('searchPlaceholder')} style={{ width: 240 }} />
            </Form.Item>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={searchLoading}>{t('search')}</Button>
          </Form>
          {searchResult.length > 0 && (
            <>
              <Typography.Text type="secondary">{t('searchResults')} ({searchResult.length})</Typography.Text>
              <Table dataSource={searchResult} columns={userColumns} rowKey="username"
                size="small" pagination={{ pageSize: 30 }} scroll={{ y: 400 }} />
            </>
          )}
          {searchResult.length === 0 && !searchLoading && (
            <Typography.Text type="secondary">{t('searchPlaceholder')}</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      key: 'list',
      label: t('userManagement'),
      children: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Button onClick={handleListUsers} loading={usersLoading} icon={<ReloadOutlined />}>{t('refresh')}</Button>
          {allUsers.length > 0 && (
            <Table dataSource={allUsers} columns={userColumns} rowKey="username"
              size="small" pagination={{ pageSize: 30 }} scroll={{ y: 400 }} />
          )}
        </Space>
      ),
    },
    {
      key: 'import',
      label: t('batchImport'),
      children: (
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Card size="small" title={t('bulkImport')}>
            <Space>
              <Upload beforeUpload={handleImport} showUploadList={false} accept=".csv" disabled={importProgress.visible}>
                <Button icon={<UploadOutlined />} disabled={importProgress.visible}>
                  {importProgress.visible ? t('importing') : t('selectCsv')}
                </Button>
              </Upload>
              <Button icon={<DownloadOutlined />} onClick={handleDownloadTemplate}>{t('downloadTemplate')}</Button>
              <Button icon={<DownloadOutlined />} onClick={async () => {
                const hide = message.loading(t('exporting'), 0)
                try {
                  await usersApi.exportUsersCsv()
                  hide()
                  message.success(t('exportSuccess'))
                } catch (err: unknown) {
                  hide()
                  const ae = err as ApiError
                  // responseType=arraybuffer 时错误 data 也是 ArrayBuffer，需转文本
                  let detail = ae?.response?.data?.detail
                  if (!detail && ae?.response?.data instanceof ArrayBuffer) {
                    try {
                      const text = new TextDecoder().decode(ae.response.data)
                      detail = JSON.parse(text).detail
                    } catch { /* ignore */ }
                  }
                  message.error(detail || t('exportFailed'))
                }
              }}>{t('exportUsers')}</Button>
            </Space>
            {/* 导入进度弹窗 */}
            <Modal
              title={t('bulkImport')}
              open={importProgress.visible}
              footer={
                importProgress.done
                  ? <Button type="primary" onClick={handleImportDone}>{t('confirm')}</Button>
                  : null
              }
              closable={importProgress.done}
              mask={{ closable: importProgress.done }}
              onCancel={handleImportDone}
            >
              <Space orientation="vertical" style={{ width: '100%' }} size="middle">
                <Progress percent={importProgress.percent} status={importProgress.done ? (importProgress.errorCount > 0 ? 'exception' : 'success') : 'active'} />
                <Typography.Text>{importProgress.message}</Typography.Text>
                {importProgress.total > 0 && (
                  <Typography.Text type="secondary">
                    {t('processed')} {importProgress.current} / {importProgress.total}
                    ｜ {t('success')} {importProgress.imported}
                    ｜ {t('failed')} {importProgress.errorCount}
                  </Typography.Text>
                )}
                {importProgress.errors.length > 0 && (
                  <div style={{ maxHeight: 200, overflow: 'auto', background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 4, padding: '8px 12px' }}>
                    <Typography.Text type="danger" strong>{t('errorDetails')}:</Typography.Text>
                    {importProgress.errors.map((err, i) => (
                      <Typography.Text key={i} type="danger" style={{ display: 'block', fontSize: 12, lineHeight: 1.8 }}>{err}</Typography.Text>
                    ))}
                  </div>
                )}
              </Space>
            </Modal>
          </Card>
          <Card size="small" title={t('bulkDelete')}>
            <Space wrap>
              <Select
                value={bulkMatchMode}
                onChange={(v: BulkMatchMode) => setBulkMatchMode(v)}
                style={{ width: 120 }}
                options={[
                  { value: 'prefix', label: t('matchPrefix') },
                  { value: 'contains', label: t('matchContains') },
                  { value: 'exact', label: t('matchExact') },
                ]}
              />
              <Input placeholder={t('enterPattern')} value={bulkPattern}
                onChange={(e) => setBulkPattern(e.target.value)}
                onPressEnter={openBulkDeletePreview}
                style={{ width: 240 }} allowClear />
              <Button danger icon={<WarningOutlined />} loading={bulkPreviewLoading}
                disabled={bulkDeleteProgress.visible} onClick={openBulkDeletePreview}>
                {t('bulkDelete')}
              </Button>
            </Space>
            <div style={{ marginTop: 8 }}>
              <Typography.Text type="secondary">
                {t('batchDeleteHint')}
              </Typography.Text>
            </div>
          </Card>

          {/* 批量删除：匹配结果二次确认弹窗 */}
          <Modal
            title={t('confirmBatchDeleteTitle')}
            open={bulkPreviewOpen}
            okText={t('confirmDeleteBtn')}
            cancelText={t('cancel')}
            okButtonProps={{ danger: true, disabled: !bulkConfirmed }}
            onOk={handleBulkDelete}
            onCancel={closeBulkDeletePreview}
            maskClosable={false}
            closable={!bulkDeleteProgress.visible}
          >
            {bulkPreview && (
              <Space orientation="vertical" style={{ width: '100%' }} size="middle">
                <Alert
                  type="error"
                  showIcon
                  message={t('deleteWarnCount', { count: bulkPreview.matched_count })}
                  description={bulkPreview.message}
                />
                {bulkPreview.preview.length > 0 && (
                  <div>
                    <Typography.Text strong>
                      {t('matchPreviewHead', { count: bulkPreview.preview.length })}
                    </Typography.Text>
                    <div style={{ marginTop: 6 }}>
                      {bulkPreview.preview.map((u) => <Tag key={u} color="red">{u}</Tag>)}
                    </div>
                    {bulkPreview.matched_count > bulkPreview.preview.length && (
                      <Typography.Text type="secondary">
                        {t('moreMatched', { count: bulkPreview.matched_count - bulkPreview.preview.length })}
                      </Typography.Text>
                    )}
                  </div>
                )}
                {bulkPreview.skipped_admin_count > 0 && (
                  <Typography.Text type="warning">
                    {t('skippedAdmins', { count: bulkPreview.skipped_admin_count })}
                  </Typography.Text>
                )}
                <Checkbox
                  checked={bulkConfirmed}
                  onChange={(e) => setBulkConfirmed(e.target.checked)}
                >
                  {t('iConfirmDelete', { count: bulkPreview.matched_count })}
                </Checkbox>
              </Space>
            )}
          </Modal>

            {/* 批量删除进度弹窗 */}
            <Modal
              title={t('bulkDelete')}
              open={bulkDeleteProgress.visible}
              footer={
                bulkDeleteProgress.done
                  ? <Button type="primary" onClick={handleBulkDeleteDone}>{t('confirm')}</Button>
                  : null
              }
              closable={bulkDeleteProgress.done}
              mask={{ closable: bulkDeleteProgress.done }}
              onCancel={handleBulkDeleteDone}
            >
              <Space orientation="vertical" style={{ width: '100%' }} size="middle">
                <Progress percent={bulkDeleteProgress.percent} status={bulkDeleteProgress.done ? (bulkDeleteProgress.errorCount > 0 ? 'exception' : 'success') : 'active'} />
                <Typography.Text>{bulkDeleteProgress.message}</Typography.Text>
                {bulkDeleteProgress.total > 0 && (
                  <Typography.Text type="secondary">
                    {t('processed')} {bulkDeleteProgress.current} / {bulkDeleteProgress.total}
                    ｜ {t('success')} {bulkDeleteProgress.deleted}
                    ｜ {t('failed')} {bulkDeleteProgress.errorCount}
                  </Typography.Text>
                )}
                {bulkDeleteProgress.errors.length > 0 && (
                  <div style={{ maxHeight: 200, overflow: 'auto', background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 4, padding: '8px 12px' }}>
                    <Typography.Text type="danger" strong>{t('errorDetails')}:</Typography.Text>
                    {bulkDeleteProgress.errors.map((err, i) => (
                      <Typography.Text key={i} type="danger" style={{ display: 'block', fontSize: 12, lineHeight: 1.8 }}>{err}</Typography.Text>
                    ))}
                  </div>
                )}
              </Space>
            </Modal>

          {/* ── 批量升年级 ── */}
          <Card size="small" title={<span><RiseOutlined /> {t('batchUpgradeTitle')}</span>}
            extra={isAdmin ? null : <Typography.Text type="warning">仅管理员可用</Typography.Text>}>
            {isAdmin ? (
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  {t('upgradePathHint')}
                  {t('gradRetainHint')}
                </Typography.Text>

                {/* 预览区域 */}
                <Space>
                  <Button icon={<RiseOutlined />} onClick={handlePreviewPromote} loading={promoteLoading}>
                    {t('previewUpgrade')}
                  </Button>
                  {promotePreview && (
                    <span style={{ color: '#888', fontSize: 13 }}>
                      {t('totalStudentsN', { count: promotePreview.total_students })}
                    </span>
                  )}
                </Space>

                {promotePreview && (
                  <>
                    <Table
                      dataSource={promotePreview.grade_details}
                      columns={[
                        { title: t('curGrade'), dataIndex: 'grade', key: 'grade', width: 100 },
                        { title: t('headcount'), dataIndex: 'count', key: 'count', width: 60 },
                        {
                          title: t('nextGrade'), dataIndex: 'next_grade', key: 'next_grade', width: 120,
                          render: (val: string | null) => val
                            ? <Tag color="blue">{val}</Tag>
                            : <Tag color="orange">{t("graduateTag")}</Tag>,
                        },
                        {
                          title: t('classCol'), dataIndex: 'classes', key: 'classes',
                          render: (val: string[]) => val?.length ? val.join('、') : '-',
                        },
                      ]}
                      rowKey="grade"
                      size="small"
                      pagination={false}
                      style={{ marginBottom: 12 }}
                    />

                    {/* 选项 */}
                    <Card size="small" type="inner" title={t('upgradeOptions')} style={{ marginBottom: 12 }}>
                      <Space orientation="vertical">
                        <Checkbox
                          checked={promoteOptions.sync_scores}
                          onChange={(e) => setPromoteOptions(prev => ({ ...prev, sync_scores: e.target.checked }))}
                        >
                          {t('syncScoresHint')}
                        </Checkbox>
                        <Checkbox
                          checked={promoteOptions.sync_rollcall}
                          onChange={(e) => setPromoteOptions(prev => ({ ...prev, sync_rollcall: e.target.checked }))}
                        >
                          {t('syncRollcallHint')}
                        </Checkbox>
                        <Checkbox
                          checked={promoteOptions.match_class}
                          onChange={(e) => setPromoteOptions(prev => ({ ...prev, match_class: e.target.checked }))}
                        >
                          {t('matchClassHint')}
                        </Checkbox>
                      </Space>
                    </Card>

                    {/* 执行按钮 */}
                    <Space>
                      <Button type="primary" icon={<RiseOutlined />}
                        loading={promoteExecuting} onClick={handleExecutePromote}>
                        {t('executeUpgrade')}
                      </Button>
                      <Button icon={<RollbackOutlined />}
                        loading={promoteReversing} onClick={handleReversePromote}>
                        {t('reverseDemote')}
                      </Button>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('upgradeReversibleHint')}
                      </Typography.Text>
                    </Space>
                  </>
                )}

                {/* 执行结果 */}
                {promoteResult && (
                  <Card size="small" type="inner"
                    title={
                      <span>
                        {promoteResult.success
                          ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                          : <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                        }
                        {' '}执行结果
                      </span>
                    }
                    style={{ marginTop: 12, background: promoteResult.success ? '#f6ffed' : '#fff2f0' }}>
                    <Space orientation="vertical">
                      {!promoteResult.success && (
                        <Typography.Text type="danger">❌ 升年级失败，数据已全部回滚</Typography.Text>
                      )}
                      {promoteResult.errors?.map((e, i) => (
                        <Typography.Text key={i} type="danger" style={{ fontSize: 12 }}>{e}</Typography.Text>
                      ))}
                      {promoteResult.success && (
                        <>
                          <Typography.Text>✅ {promoteResult.direction === 'up' ? t('upgradedLabel') : t('demotedLabel')}{t('studentsColon')}{Object.entries(promoteResult.promoted).map(([g, c]) => t('gradeMoveSummary', { from: g, to: c })).join('、')}</Typography.Text>
                          {Object.keys(promoteResult.not_moved).length > 0 && (
                            <Typography.Text>
                              {promoteResult.direction === 'up' ? t('graduatedLabel') : t('lowestGradeLabel')}
                              {Object.entries(promoteResult.not_moved).map(([g, c]) => t('gradeCountPlain', { grade: g, count: c })).join('、')}
                            </Typography.Text>
                          )}
                          {promoteResult.skipped && promoteResult.skipped.length > 0 && (
                            <Typography.Text type="warning">⚠️ 跳过 {promoteResult.skipped.length} 个无年级信息的学生</Typography.Text>
                          )}
                          <Typography.Text type="secondary">
                            更新 users 表 {promoteResult.updated_users} 条
                            ｜ 更新 scores 表 {promoteResult.updated_scores} 条
                            ｜ 更新 rollcall 表 {promoteResult.updated_rollcall} 条
                          </Typography.Text>
                        </>
                      )}
                    </Space>
                  </Card>
                )}
              </Space>
            ) : (
              <Typography.Text type="secondary">升年级操作仅限管理员使用</Typography.Text>
            )}
          </Card>
        </Space>
      ),
    },
  ]

  // 按权限过滤可见的标签页
  const visibleTabs = tabItems.filter(t => tabPermissions[t.key])

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>👥 {t('title')}</Typography.Title>
      <Tabs items={visibleTabs} />
    </Layout>
  )
}

export default UserMgmtPage
