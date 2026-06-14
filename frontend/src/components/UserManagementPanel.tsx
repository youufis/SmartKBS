import React, { useState } from 'react'
import { Tabs, Form, Input, Button, message, Modal, Progress, Table, Upload, Space, Radio, Typography } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import * as usersApi from '../api/users'
import type { ImportProgressEvent } from '../api/users'

const UserManagementPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState('register')
  const [users, setUsers] = useState<any[]>([])
  const [usersLoading, setUsersLoading] = useState(false)

  // ── 注册 ──
  const [registerForm] = Form.useForm()
  const handleRegister = async (values: any) => {
    try {
      const msg = await usersApi.registerUser({
        username: values.username,
        password: values.password,
        class_val: values.class_val?.toString() || '',
        name: values.name || '',
        gender: values.gender === '男' ? 1 : 0,
        role: values.role === '管理员' ? 0 : values.role === '教师' ? 1 : 2,
        grade: values.grade || '',
      })
      message.success(msg)
      registerForm.resetFields()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '注册失败')
    }
  }

  // ── 更新 ──
  const [updateForm] = Form.useForm()
  const handleUpdate = async (values: any) => {
    try {
      const msg = await usersApi.updateUserInfo(
        values.username,
        values.class_val?.toString() || '',
        values.name || '',
        values.gender === '男' ? 1 : 0,
        values.grade || '',
      )
      message.success(msg)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '更新失败')
    }
  }

  // ── 改密 ──
  const [pwdForm] = Form.useForm()
  const handleChangePwd = async (values: any) => {
    try {
      const msg = await usersApi.changePassword(values.username, values.new_password)
      message.success(msg)
      pwdForm.resetFields()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '修改密码失败')
    }
  }

  // ── 删除（支持模糊模式） ──
  const [deleteForm] = Form.useForm()
  const handleDelete = async (values: any) => {
    const pattern = values.pattern?.trim()
    if (!pattern) {
      message.warning('请输入用户名模式')
      return
    }
    try {
      const msg = await usersApi.bulkDeleteUsers(pattern)
      message.success(msg)
      deleteForm.resetFields()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '删除失败')
    }
  }

  // ── 查询（支持用户名/姓名模糊搜索） ──
  const [searchForm] = Form.useForm()
  const [searchResult, setSearchResult] = useState<any[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const handleSearch = async (values: any) => {
    const keyword = values.keyword?.trim()
    if (!keyword) {
      message.warning('请输入关键词')
      return
    }
    setSearchLoading(true)
    try {
      const { users } = await usersApi.getAllUsers(keyword)
      setSearchResult(users)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '查询失败')
      setSearchResult([])
    } finally {
      setSearchLoading(false)
    }
  }

  // ── 查看所有用户 ──
  const handleListUsers = async () => {
    setUsersLoading(true)
    try {
      const { users: userList } = await usersApi.getAllUsers()
      setUsers(userList)
      setActiveTab('list')
    } catch {
      message.error('获取用户列表失败')
    } finally {
      setUsersLoading(false)
    }
  }

  // ── 导入用户（含进度提示） ──
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
    } catch (err: any) {
      setImportProgress(prev => ({
        ...prev,
        message: err.message || '导入失败',
        done: true,
      }))
    }
    return false // 阻止默认上传
  }

  const handleImportDone = () => {
    setImportProgress(prev => ({ ...prev, visible: false }))
  }

  const genderOptions = [
    { label: '男', value: '男' },
    { label: '女', value: '女' },
  ]
  const roleOptions = [
    { label: '普通用户', value: '普通用户' },
    { label: '教师', value: '教师' },
    { label: '管理员', value: '管理员' },
  ]

  const userColumns = [
    { title: '用户名', dataIndex: 'username', key: 'username' },
    { title: '姓名', dataIndex: 'name', key: 'name' },
    { title: '年级', dataIndex: 'grade', key: 'grade' },
    { title: '班级', dataIndex: 'class', key: 'class' },
    { title: '性别', dataIndex: 'gender', key: 'gender' },
    { title: '角色', dataIndex: 'role', key: 'role' },
  ]

  return (
    <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
      {
        key: 'register',
        label: '注册',
        children: (
          <Form form={registerForm} layout="vertical" onFinish={handleRegister}>
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
              <Input placeholder="用户名/学号" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true }]}>
              <Input.Password placeholder="密码" />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(p, c) => p.role !== c.role}>
              {({ getFieldValue }) => {
                const isTeacher = getFieldValue('role') === '教师'
                return isTeacher ? (
                  <span>
                    <Form.Item name="grade" label="年级（教师）" extra={<span>多个年级用 <code>|</code> 分隔，如 <code>高一|高二</code></span>}>
                      <Input placeholder="如：高一|高二" />
                    </Form.Item>
                    <Form.Item name="class_val" label="班级（教师）" extra={<span>每个年级的班级用 <code>,</code> 分隔，跨年级用 <code>|</code> 对齐，如 <code>1,2,3,4,5|6,5,4,38,9</code></span>}>
                      <Input placeholder="如：1,2,3|4,5" />
                    </Form.Item>
                  </span>
                ) : (
                  <span>
                    <Form.Item name="grade" label="年级">
                      <Input placeholder="如：高一" />
                    </Form.Item>
                    <Form.Item name="class_val" label="班级">
                      <Input placeholder="如：1" />
                    </Form.Item>
                  </span>
                )
              }}
            </Form.Item>
            <Form.Item name="name" label="姓名"><Input placeholder="姓名" /></Form.Item>
            <Form.Item name="gender" label="性别" initialValue="男"><Radio.Group options={genderOptions} /></Form.Item>
            <Form.Item name="role" label="角色" initialValue="普通用户"><Radio.Group options={roleOptions} /></Form.Item>
            <Button type="primary" htmlType="submit">注册</Button>
          </Form>
        ),
      },
      {
        key: 'update',
        label: '更新',
        children: (
          <Form form={updateForm} layout="vertical" onFinish={handleUpdate}>
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item noStyle shouldUpdate={(p, c) => p.role !== c.role}>
              {({ getFieldValue }) => {
                const isTeacher = getFieldValue('role') === '教师'
                return isTeacher ? (
                  <span>
                    <Form.Item name="grade" label="年级（教师）" extra={<span>多个年级用 <code>|</code> 分隔，如 <code>高一|高二</code></span>}>
                      <Input placeholder="如：高一|高二" />
                    </Form.Item>
                    <Form.Item name="class_val" label="班级（教师）" extra={<span>每个年级的班级用 <code>,</code> 分隔，跨年级用 <code>|</code> 对齐，如 <code>1,2,3,4,5|6,5,4,38,9</code></span>}>
                      <Input placeholder="如：1,2,3|4,5" />
                    </Form.Item>
                  </span>
                ) : (
                  <span>
                    <Form.Item name="grade" label="年级">
                      <Input placeholder="如：高一" />
                    </Form.Item>
                    <Form.Item name="class_val" label="班级">
                      <Input placeholder="如：1" />
                    </Form.Item>
                  </span>
                )
              }}
            </Form.Item>
            <Form.Item name="name" label="姓名"><Input /></Form.Item>
            <Form.Item name="gender" label="性别" initialValue="男"><Radio.Group options={genderOptions} /></Form.Item>
            <Form.Item name="role" label="角色" initialValue="普通用户"><Radio.Group options={roleOptions} /></Form.Item>
            <Button type="primary" htmlType="submit">更新</Button>
          </Form>
        ),
      },
      {
        key: 'password',
        label: '改密',
        children: (
          <Form form={pwdForm} layout="vertical" onFinish={handleChangePwd}>
            <Form.Item name="username" label="用户名" rules={[{ required: true }]}><Input /></Form.Item>
            <Form.Item name="new_password" label="新密码" rules={[{ required: true }]}><Input.Password /></Form.Item>
            <Button type="primary" htmlType="submit">修改密码</Button>
          </Form>
        ),
      },
      {
        key: 'delete',
        label: '删除',
        children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Form form={deleteForm} layout="vertical" onFinish={handleDelete} style={{ maxWidth: 400 }}>
              <Form.Item name="pattern" label="用户名模式" extra={<>支持 <code>%</code> 模糊匹配，如 <code>s110%</code> 匹配所有 s110 开头用户</>}
                rules={[{ required: true, message: '请输入用户名模式' }]}>
                <Input placeholder="如：s110%  或  student_2026" />
              </Form.Item>
              <Button type="primary" danger htmlType="submit">批量删除匹配用户</Button>
            </Form>
            <Typography.Text type="warning">⚠️ 删除操作不可恢复，会同时清除该用户的所有数据</Typography.Text>
          </Space>
        ),
      },
      {
        key: 'search',
        label: '查询',
        children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Form form={searchForm} layout="inline" onFinish={handleSearch}>
              <Form.Item name="keyword" rules={[{ required: true }]}>
                <Input placeholder="用户名/姓名" style={{ width: 240 }} />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={searchLoading}>查询</Button>
            </Form>
            {searchResult.length > 0 && (
              <span>
                <p>共找到 {searchResult.length} 个匹配用户</p>
                <Table dataSource={searchResult} columns={userColumns} rowKey="username"
                  size="small" pagination={{ pageSize: 20 }} scroll={{ y: 300 }} />
              </span>
            )}
            {searchResult.length === 0 && !searchLoading && (
              <p>请输入关键词查询用户（支持用户名和姓名模糊匹配）</p>
            )}
          </Space>
        ),
      },
      {
        key: 'list',
        label: '列表',
        children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Button onClick={handleListUsers} loading={usersLoading}>刷新列表</Button>
            <Table dataSource={users} columns={userColumns} rowKey="username" size="small" pagination={{ pageSize: 20 }} scroll={{ y: 300 }} />
          </Space>
        ),
      },
      {
        key: 'import',
        label: '导入',
        children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Upload beforeUpload={handleImport} showUploadList={false} accept=".csv" disabled={importProgress.visible}>
              <Button icon={<UploadOutlined />} disabled={importProgress.visible}>
                {importProgress.visible ? '导入中…' : '选择 CSV 文件导入'}
              </Button>
            </Upload>
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
          </Space>
        ),
      },
    ]} />
  )
}

export default UserManagementPanel
