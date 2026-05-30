import React, { useState, useEffect } from 'react'
import { Layout, Menu, Dropdown, Avatar, Space, Typography } from 'antd'
import {
  HomeOutlined,
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
  AuditOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  FileAddOutlined,
  BellOutlined,
  BarChartOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import apiClient from '../api/client'
import NotificationBell from './NotificationBell'

const { Header, Sider, Content } = Layout

const AppLayout: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, onlineCount, logout, fetchOnlineCount } = useAuthStore()
  const [collapsed, setCollapsed] = React.useState(false)
  const [openKeys, setOpenKeys] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('smartkb_menu_openkeys')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const [orgName, setOrgName] = useState('')

  // 根据角色构建菜单项（分组分类）
  const isStudent = user?.role === 'student'
  const isTeacher = user?.role === 'teacher'
  const isAdmin = user?.role === 'admin'

  // 获取单位名称
  useEffect(() => {
    apiClient.get('/api/config/public').then(({ data }) => {
      if (data.ORG_NAME) setOrgName(data.ORG_NAME)
    }).catch(() => {})
  }, [])

  // 学生菜单分组
  const studentMenuGroups: { label: string; key: string; children: { key: string; icon: React.ReactNode; label: string }[] }[] = [
    { label: '📊 概览', key: 'overview', children: [
      { key: '/dashboard', icon: <HomeOutlined />, label: '首页' },
    ]},
    { label: '💡 学习', key: 'learn', children: [
      { key: '/chat', icon: <MessageOutlined />, label: 'AI 对话' },
      { key: '/html-files', icon: <FileOutlined />, label: '共享资源' },
      { key: '/downloads', icon: <DownloadOutlined />, label: '共享文件' },
    ]},
    { label: '📚 学业', key: 'study', children: [
      { key: '/score', icon: <TrophyOutlined />, label: '课堂积分' },
      { key: '/exam', icon: <FileAddOutlined />, label: '在线考试' },
      { key: '/tasks', icon: <CheckCircleOutlined />, label: '任务管理' },
      { key: '/interaction', icon: <ThunderboltOutlined />, label: '课堂互动' },
      { key: '/discussion', icon: <TeamOutlined />, label: '分组讨论' },
      { key: '/portfolio', icon: <UserOutlined />, label: '成长档案' },
    ]},
    { label: '⚙️ 系统', key: 'sys', children: [
      { key: '/user-mgmt', icon: <TeamOutlined />, label: '修改密码' },
      { key: '/announcements', icon: <BellOutlined />, label: '系统公告' },
      { key: '/about', icon: <InfoCircleOutlined />, label: '系统说明' },
    ]},
  ]

  // 教师/管理员菜单分组
  const teacherMenuGroups: { label: string; key: string; children: { key: string; icon: React.ReactNode; label: string; adminOnly?: boolean; adminOrTeacherOnly?: boolean }[] }[] = [
    { label: '📊 概览', key: 'overview', children: [
      { key: '/dashboard', icon: <HomeOutlined />, label: '首页' },
    ]},
    { label: '💡 教学', key: 'teach', children: [
      { key: '/chat', icon: <MessageOutlined />, label: 'AI 对话' },
      { key: '/html-files', icon: <FileOutlined />, label: '资源中心' },
      { key: '/resource-mgmt', icon: <FolderOutlined />, label: '资源管理', adminOrTeacherOnly: true },
      { key: '/question-bank', icon: <DatabaseOutlined />, label: '试题管理', adminOrTeacherOnly: true },
      { key: '/exam', icon: <FileAddOutlined />, label: '考试发布' },
    ]},
    { label: '🏫 课堂', key: 'classroom', children: [
      { key: '/interaction', icon: <ThunderboltOutlined />, label: '课堂互动' },
      { key: '/discussion', icon: <TeamOutlined />, label: '分组讨论' },
      { key: '/tasks', icon: <CheckCircleOutlined />, label: '任务管理' },
      { key: '/score', icon: <TrophyOutlined />, label: '积分管理' },
      { key: '/rollcall', icon: <AuditOutlined />, label: '点名管理' },
      { key: '/analytics', icon: <BarChartOutlined />, label: '学情分析', adminOrTeacherOnly: true },
    ]},
    { label: '📋 档案', key: 'profile', children: [
      { key: '/portfolio', icon: <UserOutlined />, label: '成长档案' },
    ]},
    { label: '⚙️ 管理', key: 'admin', children: [
      { key: '/user-mgmt', icon: <TeamOutlined />, label: '用户管理' },
      { key: '/downloads', icon: <DownloadOutlined />, label: '文件中心' },
      { key: '/system-config', icon: <SettingOutlined />, label: '系统配置', adminOnly: true },
    ]},
    { label: '🔧 系统', key: 'system', children: [
      { key: '/announcements', icon: <BellOutlined />, label: '系统公告' },
      { key: '/about', icon: <InfoCircleOutlined />, label: '系统说明' },
    ]},
  ]

  // 根据用户角色过滤菜单项并转为 Ant Design Menu 格式
  const buildMenuItems = () => {
    const groups = isStudent ? studentMenuGroups : teacherMenuGroups
    return groups.map(group => ({
      key: group.key,
      label: group.label,
      children: group.children
        .filter((item: { key: string; icon: React.ReactNode; label: string; adminOnly?: boolean; adminOrTeacherOnly?: boolean }) => {
          if (item.adminOnly) return isAdmin
          if (item.adminOrTeacherOnly) return isAdmin || isTeacher
          return true
        })
        .map(item => ({
          key: item.key,
          icon: item.icon,
          label: item.label,
        })),
    }))
  }

  // 记住展开状态到 localStorage
  useEffect(() => {
    localStorage.setItem('smartkb_menu_openkeys', JSON.stringify(openKeys))
  }, [openKeys])

  // 当前路径变化时，自动展开所在的分组
  useEffect(() => {
    const groups = isStudent ? studentMenuGroups : teacherMenuGroups
    const parentKey = groups.find(g =>
      g.children.some(c => c.key === location.pathname)
    )?.key
    if (parentKey) {
      setOpenKeys(prev => prev.includes(parentKey) ? prev : [...prev, parentKey])
    }
  }, [location.pathname, isStudent])

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

        <Space size={20}>
          <NotificationBell />
          <Dropdown menu={userMenu} placement="bottomRight">
            <Space style={{ cursor: 'pointer' }}>
              <Avatar icon={<UserOutlined />} style={{ backgroundColor: '#1677ff' }} />
              <span>{user?.name || user?.username}</span>
            </Space>
          </Dropdown>
        </Space>
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
            items={buildMenuItems()}
            onClick={({ key }) => navigate(key)}
            openKeys={collapsed ? [] : openKeys}
            onOpenChange={setOpenKeys}
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
