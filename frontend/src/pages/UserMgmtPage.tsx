import React, { useState } from 'react'
// 用户管理
import {
  Layout, Card, Tabs, Form, Input, Button, message,
  Modal, Progress, Table, Upload, Space, Radio, Typography, Popconfirm,
} from 'antd'
import { UploadOutlined, DownloadOutlined, SearchOutlined, ReloadOutlined } from '@ant-design/icons'
import * as usersApi from '../api/users'
import type { UserItem } from '../types'
import type { ImportProgressEvent } from '../api/users'
import { useAuthStore } from '../stores/authStore'

interface ApiError {
  response?: { data?: { detail?: string } }
}

const UserMgmtPage: React.FC = () => {
  const user = useAuthStore((s: { user: { username: string; role: string } | null }) => s.user)
  const isAdmin = user?.role === 'admin'
  const isTeacher = user?.role === 'teacher'
  const isRoot = user?.username === 'root'
  const canImport = isAdmin || isTeacher

  // ── 注册 ──
  const [regForm] = Form.useForm()
  const handleRegister = async (values: Record<string, unknown>) => {
    const v = values as Record<string, string>
    try {
      const msg = await usersApi.registerUser({
        username: v.username,
        password: v.password,
        class_val: v.class_val || '',
        name: v.name || '',
        gender: v.gender === '男' ? 1 : 0,
        role: v.role === '管理员' ? 0 : v.role === '教师' ? 1 : 2,
        grade: v.grade || '',
      })
      message.success(msg)
      regForm.resetFields()
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || '注册失败')
    }
  }

  // ── 更新信息 ──
  const [updForm] = Form.useForm()
  const handleUpdate = async (values: Record<string, unknown>) => {
    const v = values as Record<string, string>
    try {
      const msg = await usersApi.updateUserInfo(
        v.username, v.class_val || '',
        v.name || '', v.gender === '男' ? 1 : 0,
        v.grade || '',
      )
      message.success(msg)
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || '更新失败')
    }
  }

  // ── 修改密码 ──
  const [pwdForm] = Form.useForm()
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
    if (!isRoot) { message.error('权限不足'); return }
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
    if (!isAdmin) { message.warning('仅管理员可查看'); return }
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

  // ── 批量删除 ──
  const [bulkPattern, setBulkPattern] = useState('')
  const handleBulkDelete = async () => {
    if (!isRoot) { message.error('权限不足'); return }
    if (!bulkPattern.trim()) { message.warning('请输入模式'); return }
    try {
      const msg = await usersApi.bulkDeleteUsers(bulkPattern)
      message.success(msg)
    } catch (err: unknown) {
      message.error((err as ApiError)?.response?.data?.detail || '批量删除失败')
    }
  }

  // ── CSV 导入（含进度提示） ──
  const [importProgress, setImportProgress] = useState<{
    visible: boolean
    percent: number
    current: number
    total: number
    imported: number
    errorCount: number
    message: string
    done: boolean
  }>({
    visible: false,
    percent: 0,
    current: 0,
    total: 0,
    imported: 0,
    errorCount: 0,
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
          setImportProgress(prev => ({
            ...prev,
            percent: 100,
            imported: event.imported || 0,
            errorCount: event.error_count || 0,
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
  ]

  // 学生只能看到修改密码
  const isStudent = user?.role === 'student'

  const tabItems = [
    {
      key: 'register',
      label: '注册用户',
      children: isAdmin ? (
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
          <Button type="primary" htmlType="submit">注册</Button>
        </Form>
      ) : <Typography.Text type="secondary">仅管理员可注册用户</Typography.Text>,
    },
    {
      key: 'update',
      label: '更新信息',
      children: (
        <Form form={updForm} layout="vertical" onFinish={handleUpdate} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input placeholder="要更新的用户名" /></Form.Item>
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
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input placeholder="用户名" /></Form.Item>
          <Form.Item name="new_password" label="新密码" rules={[{ required: true }]}><Input.Password placeholder="新密码" /></Form.Item>
          <Button type="primary" htmlType="submit">修改密码</Button>
        </Form>
      ),
    },
    {
      key: 'delete',
      label: '删除用户',
      children: isRoot ? (
        <Form form={delForm} layout="vertical" onFinish={handleDelete} style={{ maxWidth: 400 }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input placeholder="要删除的用户名" /></Form.Item>
          <Button type="primary" danger htmlType="submit">删除用户</Button>
        </Form>
      ) : <Typography.Text type="secondary">仅管理员可删除用户</Typography.Text>,
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
          <Button onClick={handleListUsers} loading={usersLoading} icon={<ReloadOutlined />}>
            {isAdmin ? '刷新列表' : '仅管理员可查看'}
          </Button>
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
      children: canImport ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Card size="small" title="导入用户">
            <Space>
              <Upload beforeUpload={handleImport} showUploadList={false} accept=".csv" disabled={importProgress.visible}>
                <Button icon={<UploadOutlined />} disabled={importProgress.visible}>
                  {importProgress.visible ? '导入中…' : '选择 CSV 文件'}
                </Button>
              </Upload>
              <Button icon={<DownloadOutlined />} onClick={handleDownloadTemplate}>下载模板</Button>
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
                <Progress percent={importProgress.percent} status={importProgress.done ? 'success' : 'active'} />
                <Typography.Text>{importProgress.message}</Typography.Text>
                {importProgress.total > 0 && (
                  <Typography.Text type="secondary">
                    已处理 {importProgress.current} / {importProgress.total} 条
                    ｜ 成功 {importProgress.imported} 条
                    ｜ 失败 {importProgress.errorCount} 条
                  </Typography.Text>
                )}
              </Space>
            </Modal>
          </Card>
          <Card size="small" title="批量删除">
            <Space>
              <Input placeholder="用户名关键词，如 s11" value={bulkPattern}
                onChange={(e) => setBulkPattern(e.target.value)} style={{ width: 240 }} />
              <Popconfirm title="确认批量删除？" onConfirm={handleBulkDelete}>
                <Button danger>批量删除</Button>
              </Popconfirm>
            </Space>
          </Card>
        </Space>
      ) : <Typography.Text type="secondary">仅管理员或教师可批量操作</Typography.Text>,
    },
  ]

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>👥 用户管理</Typography.Title>
      <Tabs items={isStudent ? tabItems.filter(t => t.key === 'password') : tabItems} />
    </Layout>
  )
}

export default UserMgmtPage
