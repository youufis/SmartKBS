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
  BookOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import apiClient from '../api/client'
import NotificationBell from './NotificationBell'

const { Header, Sider, Content } = Layout

// 学生菜单分组（注意：标签中不要使用 emoji，折叠后会显示为 ?）
const studentMenuGroups: { icon: React.ReactNode; label: string; key: string; children: { key: string; icon: React.ReactNode; label: string }[] }[] = [
  { icon: <HomeOutlined />, label: '概览', key: 'overview', children: [
    { key: '/dashboard', icon: <HomeOutlined />, label: '首页' },
  ]},
  { icon: <BookOutlined />, label: '学习', key: 'learn', children: [
    { key: '/curriculum', icon: <BookOutlined />, label: '课程大纲' },
    { key: '/chat', icon: <MessageOutlined />, label: '智能问答' },
    { key: '/shared-center', icon: <FileOutlined />, label: '共享中心' },
  ]},
  { icon: <FileAddOutlined />, label: '学业', key: 'study', children: [
    { key: '/exam', icon: <FileAddOutlined />, label: '在线考试' },
    { key: '/tasks', icon: <CheckCircleOutlined />, label: '任务管理' },
    { key: '/interaction', icon: <ThunderboltOutlined />, label: '课堂互动' },
    { key: '/discussion', icon: <TeamOutlined />, label: '分组讨论' },
    { key: '/portfolio', icon: <UserOutlined />, label: '成长档案' },
  ]},
  { icon: <SettingOutlined />, label: '系统', key: 'sys', children: [
    { key: '/user-mgmt', icon: <TeamOutlined />, label: '修改密码' },
    { key: '/announcements', icon: <BellOutlined />, label: '系统公告' },
    { key: '/about', icon: <InfoCircleOutlined />, label: '系统说明' },
  ]},
]

// 教师/管理员菜单项类型：分组（有子项）或平级条目
type TeacherMenuItem = {
  type: 'group';
  icon: React.ReactNode; label: string; key: string;
  children: { key: string; icon: React.ReactNode; label: string; adminOnly?: boolean; adminOrTeacherOnly?: boolean }[];
} | {
  type: 'item';
  key: string; icon: React.ReactNode; label: string;
}

const teacherMenuItems: TeacherMenuItem[] = [
    { type: 'group', icon: <HomeOutlined />, label: '概览', key: 'overview', children: [
      { key: '/dashboard', icon: <HomeOutlined />, label: '首页' },
    ]},
    { type: 'group', icon: <BookOutlined />, label: '教学', key: 'teach', children: [
      { key: '/curriculum', icon: <BookOutlined />, label: '课程大纲' },
      { key: '/chat', icon: <MessageOutlined />, label: '智能问答' },
      { key: '/shared-center', icon: <FolderOutlined />, label: '资源中心', adminOrTeacherOnly: true },
      { key: '/question-exam', icon: <DatabaseOutlined />, label: '考试管理' },
    ]},
    { type: 'group', icon: <ThunderboltOutlined />, label: '课堂', key: 'classroom', children: [
      { key: '/interaction', icon: <ThunderboltOutlined />, label: '课堂互动' },
      { key: '/discussion', icon: <TeamOutlined />, label: '分组讨论' },
      { key: '/tasks', icon: <CheckCircleOutlined />, label: '任务管理' },
      { key: '/score', icon: <TrophyOutlined />, label: '积分管理' },
      { key: '/rollcall', icon: <AuditOutlined />, label: '点名管理' },
      { key: '/analytics', icon: <BarChartOutlined />, label: '学情分析', adminOrTeacherOnly: true },
    ]},
    { type: 'group', icon: <SettingOutlined />, label: '管理', key: 'admin', children: [
      { key: '/user-mgmt', icon: <TeamOutlined />, label: '用户管理' },
      { key: '/announcements', icon: <BellOutlined />, label: '公告管理' },
      { key: '/system-config', icon: <SettingOutlined />, label: '系统配置', adminOnly: true },
    ]},
    { type: 'group', icon: <InfoCircleOutlined />, label: '系统', key: 'system', children: [
      { key: '/about', icon: <InfoCircleOutlined />, label: '系统说明' },
    ]},
  ]

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

  // 根据用户角色过滤菜单项并转为 Ant Design Menu 格式
  const buildMenuItems = () => {
    const raw: (TeacherMenuItem | typeof studentMenuGroups[number])[] = isStudent ? studentMenuGroups : teacherMenuItems
    return raw.map((item) => {
      // 平级条目（TeacherMenuItem type='item'）
      if ('type' in item && item.type === 'item') {
        return { key: item.key, icon: item.icon, label: item.label }
      }
      // 分组条目
      const group = item as { key: string; label: string; icon: React.ReactNode; children: Array<Record<string, unknown>> }
      const children = (group.children as Array<{ key: string; icon: React.ReactNode; label: string; adminOnly?: boolean; adminOrTeacherOnly?: boolean }>)
        .filter((child) => {
          if (child.adminOnly) return isAdmin
          if (child.adminOrTeacherOnly) return isAdmin || isTeacher
          return true
        })
        .map((child) => ({
          key: child.key,
          icon: child.icon,
          label: child.label,
        }))
      return { key: group.key, label: group.label, icon: group.icon, children }
    })
  }

  // 记住展开状态到 localStorage
  useEffect(() => {
    localStorage.setItem('smartkb_menu_openkeys', JSON.stringify(openKeys))
  }, [openKeys])

  // 当前路径变化时，自动展开所在的分组
  useEffect(() => {
    const items: (TeacherMenuItem | typeof studentMenuGroups[number])[] = isStudent ? studentMenuGroups : teacherMenuItems
    for (const item of items) {
      if ('children' in item && item.children) {
        const group = item as { key: string; children: { key: string }[] }
        if (group.children.some(c => c.key === location.pathname)) {
          const timer = setTimeout(() => {
            setOpenKeys(prev => prev.includes(group.key) ? prev : [...prev, group.key])
          }, 0)
          return () => clearTimeout(timer)
        }
      }
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
            Copyright © 2026 By UNET All rights reserved.
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}

export default AppLayout
