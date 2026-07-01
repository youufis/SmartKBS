import React, { useState } from 'react'
// 用户管理
import {
  Layout, Card, Tabs, Form, Input, Button, message,
  Modal, Progress, Table, Upload, Space, Radio, Select, Typography, Popconfirm,
  Tag, Checkbox,
} from 'antd'
import { UploadOutlined, DownloadOutlined, SearchOutlined, ReloadOutlined, RiseOutlined, CheckCircleOutlined, CloseCircleOutlined, WarningOutlined, RollbackOutlined } from '@ant-design/icons'
import * as usersApi from '../api/users'
import type { UserItem } from '../types'
import type { ImportProgressEvent, BulkDeleteProgressEvent, GradePromotionPreview, GradePromotionResult } from '../api/users'
import { useAuthStore } from '../stores/authStore'
import { useSubjectOptions } from '../hooks/useSubjectOptions'

interface ApiError {
  response?: { data?: { detail?: string } }
}

const UserMgmtPage: React.FC = () => {
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
      message.error((err as ApiError)?.response?.data?.detail || '注册失败')
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
      message.error((err as ApiError)?.response?.data?.detail || '更新失败')
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
      message.warning('用户名和新密码不能为空')
      return
    }
    // 普通用户只能改自己的
    if (!isAdmin && v.username !== user?.username) {
      message.error('权限不足：只能修改自己的密码')
      return
    }
    try {
      const msg = await usersApi.changePassword(v.username, v.new_password)
      message.success(msg)
      pwdForm.resetFields()
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || '修改密码失败')
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
      message.error((err as ApiError)?.response?.data?.detail || '删除失败')
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
      message.warning('请输入关键词')
      return
    }
    setSearchLoading(true)
    try {
      const { users } = await usersApi.getAllUsers(keyword)
      setSearchResult(users)
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || '查询失败')
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
      message.error('获取用户列表失败')
    } finally {
      setUsersLoading(false)
    }
  }

  // ── 批量删除（含进度提示） ──
  const [bulkPattern, setBulkPattern] = useState('')
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

  const handleBulkDelete = async () => {
    if (!bulkPattern.trim()) { message.warning('请输入模式'); return }
    setBulkDeleteProgress({
      visible: true,
      percent: 0,
      current: 0,
      total: 0,
      deleted: 0,
      errorCount: 0,
      errors: [],
      message: '正在查询匹配的用户…',
      done: false,
    })
    try {
      await usersApi.bulkDeleteUsersStream(bulkPattern, (event: BulkDeleteProgressEvent) => {
        if (event.type === 'start') {
          setBulkDeleteProgress(prev => ({
            ...prev,
            total: event.total || 0,
            message: `准备删除 ${event.total} 个用户…`,
          }))
        } else if (event.type === 'progress') {
          setBulkDeleteProgress(prev => ({
            ...prev,
            percent: event.percent || 0,
            current: event.current || 0,
            total: event.total || 0,
            deleted: event.deleted || 0,
            errorCount: event.error_count || 0,
            message: `正在删除 ${event.current}/${event.total}…`,
          }))
        } else if (event.type === 'done') {
          const errList = event.errors || []
          setBulkDeleteProgress(prev => ({
            ...prev,
            percent: 100,
            deleted: event.deleted || 0,
            errorCount: event.error_count || 0,
            errors: errList,
            message: event.message || '批量删除完成',
            done: true,
          }))
        }
      })
    } catch (err: unknown) {
      setBulkDeleteProgress(prev => ({
        ...prev,
        message: err instanceof Error ? err.message : '批量删除失败',
        done: true,
      }))
    }
  }

  const handleBulkDeleteDone = () => {
    setBulkDeleteProgress(prev => ({ ...prev, visible: false }))
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
      message.error((err as ApiError)?.response?.data?.detail || '获取预览失败')
    } finally {
      setPromoteLoading(false)
    }
  }

  const handleExecutePromote = async () => {
    // 动态构建升级描述
    const promoteDesc = promotePreview?.grade_details
      ?.filter(d => d.next_grade)
      .map(d => `${d.grade}→${d.next_grade}`)
      ?.join('，') || '按学段自动升级'
    const graduateDesc = promotePreview?.grade_details
      ?.filter(d => !d.next_grade && d.count > 0)
      .map(d => `${d.grade}（${d.count}人）`)
      ?.join('、')

    Modal.confirm({
      title: '⚠️ 确认执行批量升年级？',
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
      okText: '确认执行',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setPromoteExecuting(true)
        try {
          const result = await usersApi.executePromoteGrades({
            ...promoteOptions,
            confirm: true,
          })
          setPromoteResult(result)
          if (result.success) {
            message.success('批量升年级执行完成')
            // 刷新预览
            handlePreviewPromote()
          }
        } catch (err: unknown) {
          message.error((err as ApiError)?.response?.data?.detail || '执行升年级失败')
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
      title: '⚠️ 确认执行批量降级？',
      icon: <WarningOutlined />,
      width: 520,
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>降级是升年级的逆操作，将执行以下变更：</p>
          <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
            <li>{reverseDesc || '按升年级映射反向降级'}</li>
            {promoteOptions.sync_scores && <li>同步降级课堂积分的年级归属</li>}
            {promoteOptions.sync_rollcall && <li>同步降级点名数据的年级归属</li>}
            {promoteOptions.match_class && <li>按同名班级自动匹配</li>}
          </ul>
          <p style={{ color: '#fa8c16', marginTop: 8 }}>毕业年级学生不受影响。降级可多次执行，每次都是升年级的逆操作。</p>
        </div>
      ),
      okText: '确认降级',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setPromoteReversing(true)
        try {
          const result = await usersApi.reversePromoteGrades({
            ...promoteOptions,
            confirm: true,
          })
          if (result.success) {
            message.success('🎉 批量降级完成！')
            setPromotePreview(null)
            setPromoteResult(result)
            // 刷新预览
            handlePreviewPromote()
          }
        } catch (err: unknown) {
          message.error((err as ApiError)?.response?.data?.detail || '降级失败')
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
      message: '正在解析文件…',
      done: false,
    })

    try {
      await usersApi.importUsersStream(file, (event: ImportProgressEvent) => {
        if (event.type === 'start') {
          setImportProgress(prev => ({
            ...prev,
            total: event.total || 0,
            message: `准备导入 ${event.total} 个用户…`,
          }))
        } else if (event.type === 'progress') {
          setImportProgress(prev => ({
            ...prev,
            percent: event.percent || 0,
            current: event.current || 0,
            total: event.total || 0,
            imported: event.imported || 0,
            errorCount: event.error_count || 0,
            message: `正在导入 ${event.current}/${event.total}…`,
          }))
        } else if (event.type === 'done') {
          const errList = event.errors || []
          setImportProgress(prev => ({
            ...prev,
            percent: 100,
            imported: event.imported || 0,
            errorCount: event.error_count || 0,
            errors: errList,
            message: event.message || '导入完成',
            done: true,
          }))
        }
      })
    } catch (err: unknown) {
      setImportProgress(prev => ({
        ...prev,
        message: err instanceof Error ? err.message : '导入失败',
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
    { label: '男', value: '男' },
    { label: '女', value: '女' },
  ]
  const roleRadios = [
    { label: '普通用户', value: '普通用户' },
    { label: '教师', value: '教师' },
    { label: '管理员', value: '管理员' },
  ]

  const userColumns = [
    { title: '用户名', dataIndex: 'username', key: 'username', width: 120 },
    { title: '姓名', dataIndex: 'name', key: 'name', width: 100 },
    { title: '年级', dataIndex: 'grade', key: 'grade', width: 60 },
    { title: '班级', dataIndex: 'class', key: 'class', width: 80 },
    { title: '性别', dataIndex: 'gender', key: 'gender', width: 60 },
    { title: '角色', dataIndex: 'role', key: 'role', width: 80 },
    {
      title: '任教科目',
      dataIndex: 'subjects',
      key: 'subjects',
      width: 180,
      render: (_: any, record: any) => {
        if (record.role === '管理员') return '全部学科'
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
      label: '注册用户',
      children: (
        <Form form={regForm} layout="vertical" onFinish={handleRegister} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input placeholder="用户名/学号" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password placeholder="密码" />
          </Form.Item>
          <Form.Item name="grade" label="年级" extra={<>多个年级用 <code>|</code> 分隔，如 <code>高一|高二</code></>}>
            <Input placeholder="如：高一 或 高一|高二" />
          </Form.Item>
          <Form.Item name="class_val" label="班级" extra={<>多个班级用 <code>,</code> 分隔，多个年级用 <code>|</code> 分隔，如 <code>1,2,3,4,5|6,5,4,38,9</code></>}>
            <Input placeholder="如：1 或 1,2,3 或 1,2,3|4,5" />
          </Form.Item>
          <Form.Item name="name" label="姓名"><Input placeholder="姓名" /></Form.Item>
          <Form.Item name="gender" label="性别" initialValue="男"><Radio.Group options={genderRadios} /></Form.Item>
          <Form.Item name="role" label="角色" initialValue="普通用户"><Radio.Group options={roleRadios} /></Form.Item>
          <Form.Item shouldUpdate={(prev, cur) => prev.role !== cur.role} noStyle>
            {({ getFieldValue }) => {
              const role = getFieldValue('role')
              const isTeacherOrAdmin = role === '教师' || role === '管理员'
              return (
                <Form.Item name="subjects" label="任教科目" hidden={!isTeacherOrAdmin}
                  initialValue={role === '管理员' ? [...subjects] : undefined}
                  extra={<>请在「系统配置」中先设置课程名称列表，此处才会显示可选学科。如列表为空，<Button type="link" size="small" onClick={() => window.open('/system-config', '_blank')} style={{ padding: 0 }}>前往配置</Button></>}>
                  <Select mode="multiple" placeholder="选择任教学科（可多选）" allowClear
                    options={subjects.map(s => ({ label: s, value: s }))} />
                </Form.Item>
              )
            }}
          </Form.Item>
          <Button type="primary" htmlType="submit">注册</Button>
        </Form>
      ),
    },
    {
      key: 'update',
      label: '更新信息',
      children: (
        <Form form={updForm} layout="vertical" onFinish={handleUpdate} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input placeholder="输入用户名后移出焦点自动加载" onBlur={handleUpdateUsernameBlur} />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Radio.Group options={roleRadios} />
          </Form.Item>
          <Form.Item shouldUpdate={(prev, cur) => prev.role !== cur.role} noStyle>
            {({ getFieldValue }) => {
              const role = getFieldValue('role')
              const isTeacherOrAdmin = role === '教师' || role === '管理员'
              return (
                <Form.Item name="subjects" label="任教科目" hidden={!isTeacherOrAdmin}
                  initialValue={role === '管理员' ? [...subjects] : undefined}
                  extra={<>请在「系统配置」中先设置课程名称列表，此处才会显示可选学科。<Button type="link" size="small" onClick={() => window.open('/system-config', '_blank')} style={{ padding: 0 }}>前往配置</Button></>}>
                  <Select mode="multiple" placeholder="选择任教学科（可多选）" allowClear
                    options={subjects.map(s => ({ label: s, value: s }))} />
                </Form.Item>
              )
            }}
          </Form.Item>
          <Form.Item name="grade" label="年级" extra={<>多个年级用 <code>|</code> 分隔，如 <code>高一|高二</code></>}>
            <Input placeholder="如：高一 或 高一|高二" />
          </Form.Item>
          <Form.Item name="class_val" label="班级" extra={<>多个班级用 <code>,</code> 分隔，多个年级用 <code>|</code> 分隔，如 <code>1,2,3,4,5|6,5,4,38,9</code></>}>
            <Input placeholder="如：1 或 1,2,3 或 1,2,3|4,5" />
          </Form.Item>
          <Form.Item name="name" label="姓名"><Input /></Form.Item>
          <Form.Item name="gender" label="性别" initialValue="男"><Radio.Group options={genderRadios} /></Form.Item>
          <Button type="primary" htmlType="submit">更新</Button>
        </Form>
      ),
    },
    {
      key: 'password',
      label: '修改密码',
      children: (
        <Form form={pwdForm} layout="vertical" onFinish={handleChangePwd} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input placeholder="用户名" disabled={!isAdmin} />
          </Form.Item>
          <Form.Item name="new_password" label="新密码" rules={[{ required: true }]}>
            <Input.Password placeholder="新密码" />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label="确认新密码"
            dependencies={['new_password']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit">修改密码</Button>
        </Form>
      ),
    },
    {
      key: 'delete',
      label: '删除用户',
      children: (
        <Form form={delForm} layout="vertical" onFinish={handleDelete} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input placeholder="要删除的用户名" /></Form.Item>
          <Button type="primary" danger htmlType="submit">删除用户</Button>
        </Form>
      ),
    },
    {
      key: 'search',
      label: '查询用户',
      children: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Form form={searchForm} layout="inline" onFinish={handleSearch}>
            <Form.Item name="keyword" rules={[{ required: true }]}>
              <Input placeholder="用户名/姓名" style={{ width: 240 }} />
            </Form.Item>
            <Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={searchLoading}>查询</Button>
          </Form>
          {searchResult.length > 0 && (
            <>
              <Typography.Text type="secondary">共找到 {searchResult.length} 个匹配用户</Typography.Text>
              <Table dataSource={searchResult} columns={userColumns} rowKey="username"
                size="small" pagination={{ pageSize: 30 }} scroll={{ y: 400 }} />
            </>
          )}
          {searchResult.length === 0 && !searchLoading && (
            <Typography.Text type="secondary">请输入关键词查询用户（支持用户名和姓名模糊匹配）</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      key: 'list',
      label: '用户列表',
      children: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button onClick={handleListUsers} loading={usersLoading} icon={<ReloadOutlined />}>刷新列表</Button>
          {allUsers.length > 0 && (
            <Table dataSource={allUsers} columns={userColumns} rowKey="username"
              size="small" pagination={{ pageSize: 30 }} scroll={{ y: 400 }} />
          )}
        </Space>
      ),
    },
    {
      key: 'import',
      label: '批量操作',
      children: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Card size="small" title="导入用户">
            <Space>
              <Upload beforeUpload={handleImport} showUploadList={false} accept=".csv" disabled={importProgress.visible}>
                <Button icon={<UploadOutlined />} disabled={importProgress.visible}>
                  {importProgress.visible ? '导入中…' : '选择 CSV 文件'}
                </Button>
              </Upload>
              <Button icon={<DownloadOutlined />} onClick={handleDownloadTemplate}>下载模板</Button>
              <Button icon={<DownloadOutlined />} onClick={async () => {
                const hide = message.loading('正在导出用户…', 0)
                try {
                  await usersApi.exportUsersCsv()
                  hide()
                  message.success('用户导出成功')
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
                  message.error(detail || '导出失败，请检查后端服务是否正常')
                }
              }}>导出用户</Button>
            </Space>
            {/* 导入进度弹窗 */}
            <Modal
              title="导入用户进度"
              open={importProgress.visible}
              footer={
                importProgress.done
                  ? <Button type="primary" onClick={handleImportDone}>确定</Button>
                  : null
              }
              closable={importProgress.done}
              maskClosable={importProgress.done}
              onCancel={handleImportDone}
            >
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <Progress percent={importProgress.percent} status={importProgress.done ? (importProgress.errorCount > 0 ? 'exception' : 'success') : 'active'} />
                <Typography.Text>{importProgress.message}</Typography.Text>
                {importProgress.total > 0 && (
                  <Typography.Text type="secondary">
                    已处理 {importProgress.current} / {importProgress.total} 条
                    ｜ 成功 {importProgress.imported} 条
                    ｜ 失败 {importProgress.errorCount} 条
                  </Typography.Text>
                )}
                {importProgress.errors.length > 0 && (
                  <div style={{ maxHeight: 200, overflow: 'auto', background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 4, padding: '8px 12px' }}>
                    <Typography.Text type="danger" strong>错误详情：</Typography.Text>
                    {importProgress.errors.map((err, i) => (
                      <Typography.Text key={i} type="danger" style={{ display: 'block', fontSize: 12, lineHeight: 1.8 }}>{err}</Typography.Text>
                    ))}
                  </div>
                )}
              </Space>
            </Modal>
          </Card>
          <Card size="small" title="批量删除">
            <Space>
                <Input placeholder="用户名关键词，如 s11" value={bulkPattern}
                  onChange={(e) => setBulkPattern(e.target.value)} style={{ width: 240 }} />
                <Popconfirm title="确认批量删除？" onConfirm={handleBulkDelete}>
                  <Button danger disabled={bulkDeleteProgress.visible}>批量删除</Button>
                </Popconfirm>
              </Space>
            </Card>
            {/* 批量删除进度弹窗 */}
            <Modal
              title="批量删除进度"
              open={bulkDeleteProgress.visible}
              footer={
                bulkDeleteProgress.done
                  ? <Button type="primary" onClick={handleBulkDeleteDone}>确定</Button>
                  : null
              }
              closable={bulkDeleteProgress.done}
              maskClosable={bulkDeleteProgress.done}
              onCancel={handleBulkDeleteDone}
            >
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <Progress percent={bulkDeleteProgress.percent} status={bulkDeleteProgress.done ? (bulkDeleteProgress.errorCount > 0 ? 'exception' : 'success') : 'active'} />
                <Typography.Text>{bulkDeleteProgress.message}</Typography.Text>
                {bulkDeleteProgress.total > 0 && (
                  <Typography.Text type="secondary">
                    已处理 {bulkDeleteProgress.current} / {bulkDeleteProgress.total} 个
                    ｜ 成功 {bulkDeleteProgress.deleted} 个
                    ｜ 失败 {bulkDeleteProgress.errorCount} 个
                  </Typography.Text>
                )}
                {bulkDeleteProgress.errors.length > 0 && (
                  <div style={{ maxHeight: 200, overflow: 'auto', background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 4, padding: '8px 12px' }}>
                    <Typography.Text type="danger" strong>错误详情：</Typography.Text>
                    {bulkDeleteProgress.errors.map((err, i) => (
                      <Typography.Text key={i} type="danger" style={{ display: 'block', fontSize: 12, lineHeight: 1.8 }}>{err}</Typography.Text>
                    ))}
                  </div>
                )}
              </Space>
            </Modal>

          {/* ── 批量升年级 ── */}
          <Card size="small" title={<span><RiseOutlined /> 批量升年级</span>}
            extra={isAdmin ? null : <Typography.Text type="warning">仅管理员可用</Typography.Text>}>
            {isAdmin ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  按学段自动升级：一年级→二年级→…→六年级→（毕业），初一→初二→初三→（毕业），高一→高二→高三→（毕业）。
                  毕业年级学生保留账号但不再升级。
                </Typography.Text>

                {/* 预览区域 */}
                <Space>
                  <Button icon={<RiseOutlined />} onClick={handlePreviewPromote} loading={promoteLoading}>
                    预览升年级
                  </Button>
                  {promotePreview && (
                    <span style={{ color: '#888', fontSize: 13 }}>
                      共 {promotePreview.total_students} 名学生
                    </span>
                  )}
                </Space>

                {promotePreview && (
                  <>
                    <Table
                      dataSource={promotePreview.grade_details}
                      columns={[
                        { title: '当前年级', dataIndex: 'grade', key: 'grade', width: 100 },
                        { title: '人数', dataIndex: 'count', key: 'count', width: 60 },
                        {
                          title: '升入年级', dataIndex: 'next_grade', key: 'next_grade', width: 120,
                          render: (val: string | null) => val
                            ? <Tag color="blue">{val}</Tag>
                            : <Tag color="orange">🎓 毕业</Tag>,
                        },
                        {
                          title: '班级', dataIndex: 'classes', key: 'classes',
                          render: (val: string[]) => val?.length ? val.join('、') : '-',
                        },
                      ]}
                      rowKey="grade"
                      size="small"
                      pagination={false}
                      style={{ marginBottom: 12 }}
                    />

                    {/* 选项 */}
                    <Card size="small" type="inner" title="升级选项" style={{ marginBottom: 12 }}>
                      <Space direction="vertical">
                        <Checkbox
                          checked={promoteOptions.sync_scores}
                          onChange={(e) => setPromoteOptions(prev => ({ ...prev, sync_scores: e.target.checked }))}
                        >
                          同步更新课堂积分（scores）的年级归属
                        </Checkbox>
                        <Checkbox
                          checked={promoteOptions.sync_rollcall}
                          onChange={(e) => setPromoteOptions(prev => ({ ...prev, sync_rollcall: e.target.checked }))}
                        >
                          同步更新点名数据（rollcall）的年级归属
                        </Checkbox>
                        <Checkbox
                          checked={promoteOptions.match_class}
                          onChange={(e) => setPromoteOptions(prev => ({ ...prev, match_class: e.target.checked }))}
                        >
                          按同名班级自动匹配新年级班级（如 1班 → 1班）
                        </Checkbox>
                      </Space>
                    </Card>

                    {/* 执行按钮 */}
                    <Space>
                      <Button type="primary" icon={<RiseOutlined />}
                        loading={promoteExecuting} onClick={handleExecutePromote}>
                        执行升年级
                      </Button>
                      <Button icon={<RollbackOutlined />}
                        loading={promoteReversing} onClick={handleReversePromote}>
                        反向降级
                      </Button>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        升/降级可反复执行，互逆操作
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
                    <Space direction="vertical">
                      {!promoteResult.success && (
                        <Typography.Text type="danger">❌ 升年级失败，数据已全部回滚</Typography.Text>
                      )}
                      {promoteResult.errors?.map((e, i) => (
                        <Typography.Text key={i} type="danger" style={{ fontSize: 12 }}>{e}</Typography.Text>
                      ))}
                      {promoteResult.success && (
                        <>
                          <Typography.Text>✅ {promoteResult.direction === 'up' ? '已升级' : '已降级'}学生：{Object.entries(promoteResult.promoted).map(([g, c]) => `${g}→${c}人`).join('、')}</Typography.Text>
                          {Object.keys(promoteResult.not_moved).length > 0 && (
                            <Typography.Text>
                              {promoteResult.direction === 'up' ? '🎓 毕业学生：' : '⏸ 已是最低年级：'}
                              {Object.entries(promoteResult.not_moved).map(([g, c]) => `${g} ${c}人`).join('、')}
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
      <Typography.Title level={4} style={{ marginTop: 0 }}>👥 用户管理</Typography.Title>
      <Tabs items={visibleTabs} />
    </Layout>
  )
}

export default UserMgmtPage
