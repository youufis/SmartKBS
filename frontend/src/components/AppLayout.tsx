import React, { useState, useEffect } from 'react'
import { Layout, Menu, Dropdown, Avatar, Space, Typography } from 'antd'
import {
  MessageOutlined,
  TrophyOutlined,
  InfoCircleOutlined,
  UserOutlined,
  LogoutOutlined,
  TeamOutlined,
  FileOutlined,
  FolderOutlined,
  DownloadOutlined,
  SettingOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  FileAddOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import apiClient from '../api/client'

const { Header, Sider, Content } = Layout

const AppLayout: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, onlineCount, logout, fetchOnlineCount } = useAuthStore()
  const [collapsed, setCollapsed] = React.useState(false)
  const [orgName, setOrgName] = useState('')

  // 获取单位名称
  useEffect(() => {
    apiClient.get('/api/config/public').then(({ data }) => {
      if (data.ORG_NAME) setOrgName(data.ORG_NAME)
    }).catch(() => {})
  }, [])

  // 根据角色构建菜单项
  const isStudent = user?.role === 'student'
  const allMenuItems: {
    key: string; icon: React.ReactNode; label: string;
    adminOnly?: boolean; adminOrTeacherOnly?: boolean;
  }[] = isStudent
    ? // ── 学生端菜单：AI对话 → 课堂积分 → 任务管理 → 在线考试 → 修改密码 → 系统说明 ──
      [
        { key: '/chat', icon: <MessageOutlined />, label: 'AI 对话' },
        { key: '/score', icon: <TrophyOutlined />, label: '课堂积分' },
        { key: '/tasks', icon: <CheckCircleOutlined />, label: '任务管理' },
        { key: '/exam', icon: <FileAddOutlined />, label: '在线考试' },
        { key: '/user-mgmt', icon: <TeamOutlined />, label: '修改密码' },
        { key: '/about', icon: <InfoCircleOutlined />, label: '系统说明' },
      ]
    : // ── 教师/管理员菜单 ──
      [
        { key: '/chat', icon: <MessageOutlined />, label: 'AI 对话' },
        { key: '/html-files', icon: <FileOutlined />, label: '教学资源', adminOrTeacherOnly: true },
        { key: '/resource-mgmt', icon: <FolderOutlined />, label: '资源管理', adminOrTeacherOnly: true },
        { key: '/question-bank', icon: <DatabaseOutlined />, label: '试题管理', adminOrTeacherOnly: true },
        { key: '/exam', icon: <FileAddOutlined />, label: '考试发布' },
        { key: '/tasks', icon: <CheckCircleOutlined />, label: '任务管理' },
        { key: '/score', icon: <TrophyOutlined />, label: '积分管理' },
        { key: '/user-mgmt', icon: <TeamOutlined />, label: '用户管理' },
        { key: '/downloads', icon: <DownloadOutlined />, label: '下载中心', adminOrTeacherOnly: true },
        { key: '/system-config', icon: <SettingOutlined />, label: '系统配置', adminOnly: true },
        { key: '/about', icon: <InfoCircleOutlined />, label: '系统说明' },
      ]

  // 自动展开当前路由所在的子菜单
  const currentPath = location.pathname
  const parentKey = '/' + currentPath.split('/')[1]
  const [openKeys, setOpenKeys] = React.useState<string[]>([parentKey])

  React.useEffect(() => {
    setOpenKeys([parentKey])
  }, [parentKey])

  React.useEffect(() => {
    fetchOnlineCount()
    const timer = setInterval(fetchOnlineCount, 30000)
    return () => clearInterval(timer)
  }, [fetchOnlineCount])

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const userMenu = {
    items: [
      { key: 'info', label: `${user?.name || user?.username} (${user?.role})`, disabled: true },
      { type: 'divider' as const },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'logout') handleLogout()
    },
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          background: '#fff',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid #f0f0f0',
          boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        <Space>
          <Typography.Title level={4} style={{ margin: 0, color: '#1677ff' }}>
            🤖 SmartKB
          </Typography.Title>
          {orgName && (
            <Typography.Text style={{ fontSize: 13, color: '#888' }}>
              {orgName}
            </Typography.Text>
          )}
          <Typography.Text style={{ fontSize: 13, color: onlineCount > 0 ? '#52c41a' : '#999' }}>
            🟢 在线人数: {onlineCount}
          </Typography.Text>
        </Space>

        <Dropdown menu={userMenu} placement="bottomRight">
          <Space style={{ cursor: 'pointer' }}>
            <Avatar icon={<UserOutlined />} style={{ backgroundColor: '#1677ff' }} />
            <span>{user?.name || user?.username}</span>
          </Space>
        </Dropdown>
      </Header>

      <Layout>
        <Sider
          width={200}
          collapsedWidth={64}
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
          style={{
            background: '#fff',
            borderRight: '1px solid #f0f0f0',
            overflow: 'auto',
          }}
        >
          {/* 折叠/展开切换按钮 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 48,
              borderBottom: collapsed ? 'none' : '1px solid #f0f0f0',
              cursor: 'pointer',
              color: '#666',
              fontSize: 16,
            }}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </div>
          <Menu
            mode="inline"
            inlineCollapsed={collapsed}
            selectedKeys={[location.pathname]}
            items={allMenuItems.filter((item) => {
              if (item.adminOnly) return user?.role === 'admin'
              if (item.adminOrTeacherOnly) return user?.role === 'admin' || user?.role === 'teacher'
              return true
            })}
            openKeys={collapsed ? [] : openKeys}
            onOpenChange={collapsed ? () => {} : setOpenKeys}
            onClick={({ key }) => navigate(key)}
            style={{ height: '100%', borderRight: 0 }}
          />
        </Sider>

        <Content style={{ padding: 24, background: '#f5f5f5', overflow: 'auto' }}>
          <Outlet />
          <div style={{ textAlign: 'center', padding: '16px 0 0', color: '#bbb', fontSize: 12 }}>
            Copyright © 2025 By UNET All rights reserved.
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}

export default AppLayout
