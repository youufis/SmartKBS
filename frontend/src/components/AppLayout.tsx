import React, { useState, useEffect, useMemo } from 'react'
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
  StarOutlined,
  RobotOutlined,
  EditOutlined,
  SafetyCertificateOutlined,
  PictureOutlined,
  GlobalOutlined,
  CrownOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import apiClient from '../api/client'
import NotificationBell from './NotificationBell'
import TitleCelebration from './TitleCelebration'
import ThemeSwitcher from './ThemeSwitcher'
import LanguageSwitcher from './LanguageSwitcher'
import SecuritySetupModal from './SecuritySetupModal'

const { Header, Sider, Content } = Layout

// 教师/管理员菜单项类型：分组（有子项）或平级条目
type TeacherMenuItem = {
  type: 'group';
  icon: React.ReactNode; label: string; key: string;
  children: { key: string; icon: React.ReactNode; label: string; adminOnly?: boolean; adminOrTeacherOnly?: boolean }[];
} | {
  type: 'item';
  key: string; icon: React.ReactNode; label: string;
}

/** 构建学生菜单（基于当前翻译） */
function buildStudentMenu(t: (k: string) => string) {
  const g = (key: string) => t(key)
  const m: { icon: React.ReactNode; label: string; key: string; children: { key: string; icon: React.ReactNode; label: string }[] }[] = [
    { icon: <HomeOutlined />, label: g('overview'), key: 'overview', children: [
      { key: '/dashboard', icon: <HomeOutlined />, label: g('dashboard') },
      { key: '/task-todo', icon: <CheckCircleOutlined />, label: g('taskTodo') },
    ]},
    { icon: <BookOutlined />, label: g('learnCenter'), key: 'learn', children: [
      { key: '/curriculum', icon: <BookOutlined />, label: g('curriculum') },
      { key: '/chat', icon: <MessageOutlined />, label: g('knowledgeQA') },
      { key: '/wrong-book', icon: <BookOutlined />, label: g('wrongBook') },
      { key: '/shared-center', icon: <FileOutlined />, label: g('sharedCenter') },
    ]},
    { icon: <StarOutlined />, label: g('explore'), key: 'explore', children: [
      { key: '/daily-discovery', icon: <StarOutlined />, label: g('dailyDiscovery') },
      { key: '/news-hub', icon: <GlobalOutlined />, label: g('newsHub') },
    ]},
    { icon: <FileAddOutlined />, label: g('examPractice'), key: 'exam-practice', children: [
      { key: '/exam', icon: <FileAddOutlined />, label: g('examCenter') },
      { key: '/tasks', icon: <CheckCircleOutlined />, label: g('taskCenter') },
      { key: '/quest', icon: <ThunderboltOutlined />, label: g('questChallenge') },
      { key: '/practice', icon: <ThunderboltOutlined />, label: g('syncPractice') },
    ]},
    { icon: <FileAddOutlined />, label: g('coding'), key: 'coding', children: [
      { key: '/code-practice', icon: <FileAddOutlined />, label: g('codePractice') },
    ]},
    { icon: <ThunderboltOutlined />, label: g('interactive'), key: 'interactive', children: [
      { key: '/interaction', icon: <ThunderboltOutlined />, label: g('classQuiz') },
      { key: '/quick-poll', icon: <BarChartOutlined />, label: g('classPoll') },
      { key: '/quick-quiz', icon: <ThunderboltOutlined />, label: g('quickQuiz') },
      { key: '/discussion', icon: <TeamOutlined />, label: g('discussion') },
      { key: '/whiteboard', icon: <EditOutlined />, label: g('whiteboard') },
      { key: '/student-questions', icon: <MessageOutlined />, label: g('studentQuestions') },
    ]},
    { icon: <TrophyOutlined />, label: g('growth'), key: 'growth', children: [
      { key: '/score', icon: <StarOutlined />, label: g('score') },
      { key: '/showcase', icon: <CrownOutlined />, label: g('showcase') },
      { key: '/portfolio', icon: <UserOutlined />, label: g('portfolio') },
      { key: '/portrait', icon: <PictureOutlined />, label: g('weeklyPortrait') },
    ]},
    { icon: <SettingOutlined />, label: g('system'), key: 'sys', children: [
      { key: '/user-mgmt', icon: <TeamOutlined />, label: g('changePassword') },
      { key: '/announcements', icon: <BellOutlined />, label: g('announcements') },
      { key: '/notifications', icon: <BellOutlined />, label: g('notifications') },
      { key: '/about', icon: <InfoCircleOutlined />, label: g('about') },
    ]},
  ]
  return m
}

/** 构建教师/管理员菜单（基于当前翻译） */
function buildTeacherMenu(t: (k: string) => string) {
  const g = (key: string) => t(key)
  const m: TeacherMenuItem[] = [
    { type: 'group', icon: <HomeOutlined />, label: g('overview'), key: 'overview', children: [
      { key: '/dashboard', icon: <HomeOutlined />, label: g('dashboard') },
    ]},
    { type: 'group', icon: <BookOutlined />, label: g('teacherMenu.teachingManagement'), key: 'teach', children: [
      { key: '/curriculum', icon: <BookOutlined />, label: g('curriculumManage') },
      { key: '/chat', icon: <MessageOutlined />, label: g('knowledgeQA') },
      { key: '/practice', icon: <ThunderboltOutlined />, label: g('syncPractice') },
      { key: '/question-bank', icon: <DatabaseOutlined />, label: g('questionBank') },
      { key: '/exam', icon: <FileAddOutlined />, label: g('examPublish') },
      { key: '/wrong-book', icon: <BookOutlined />, label: g('wrongBookManage') },
      { key: '/shared-center', icon: <FolderOutlined />, label: g('resourceCenter'), adminOrTeacherOnly: true },
    ]},
    { type: 'group', icon: <StarOutlined />, label: g('explore'), key: 'explore', children: [
      { key: '/daily-discovery', icon: <StarOutlined />, label: g('dailyDiscovery') },
      { key: '/news-hub', icon: <GlobalOutlined />, label: g('newsHub') },
    ]},
    { type: 'group', icon: <FileAddOutlined />, label: g('coding'), key: 'coding', children: [
      { key: '/code-practice', icon: <FileAddOutlined />, label: g('codePractice') },
    ]},
    { type: 'group', icon: <ThunderboltOutlined />, label: g('classroomActivities'), key: 'classroom', children: [
      { key: '/interaction', icon: <ThunderboltOutlined />, label: g('classQuiz') },
      { key: '/quick-poll', icon: <BarChartOutlined />, label: g('classPoll') },
      { key: '/quick-quiz', icon: <ThunderboltOutlined />, label: g('quickQuiz') },
      { key: '/discussion', icon: <TeamOutlined />, label: g('discussion') },
      { key: '/whiteboard', icon: <EditOutlined />, label: g('whiteboard') },
      { key: '/rollcall', icon: <AuditOutlined />, label: g('rollcallManage') },
      { key: '/student-questions', icon: <MessageOutlined />, label: g('questionManage') },
      { key: '/tasks', icon: <CheckCircleOutlined />, label: g('taskManage') },
      { key: '/quest-records', icon: <TrophyOutlined />, label: g('questManage'), adminOrTeacherOnly: true },
    ]},
    { type: 'group', icon: <BarChartOutlined />, label: g('learningAnalytics'), key: 'analytics', children: [
      { key: '/analytics', icon: <BarChartOutlined />, label: g('analytics') },
      { key: '/class-summary', icon: <RobotOutlined />, label: g('classSummary') },
      { key: '/activity-monitor', icon: <BarChartOutlined />, label: g('activityMonitor') },
      { key: '/score', icon: <TrophyOutlined />, label: g('scoreManage') },
      { key: '/showcase', icon: <CrownOutlined />, label: g('showcase') },
      { key: '/portrait', icon: <PictureOutlined />, label: g('weeklyPortrait') },
    ]},
    { type: 'group', icon: <SettingOutlined />, label: g('systemManagement'), key: 'admin', children: [
      { key: '/user-mgmt', icon: <TeamOutlined />, label: g('userManagement') },
      { key: '/announcements', icon: <BellOutlined />, label: g('announcementsManage') },
      { key: '/system-config', icon: <SettingOutlined />, label: g('systemConfig'), adminOnly: true },
      { key: '/notifications', icon: <BellOutlined />, label: g('notifications') },
      { key: '/about', icon: <InfoCircleOutlined />, label: g('about') },
    ]},
  ]
  return m
}

const AppLayout: React.FC = () => {
  const { t } = useTranslation('menu')
  const navigate = useNavigate()
  const location = useLocation()
  const { user, onlineCount, logout, fetchOnlineCount, isLoggedIn } = useAuthStore()
  const [collapsed, setCollapsed] = React.useState(false)
  const [openKeys, setOpenKeys] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('smartkb_menu_openkeys')
      return saved ? JSON.parse(saved) : []
    } catch { return [] }
  })
  const [orgName, setOrgName] = useState('')

  // 基于翻译构建菜单
  const studentMenuGroups = useMemo(() => buildStudentMenu(t), [t])
  const teacherMenuItems = useMemo(() => buildTeacherMenu(t), [t])

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
  }, [location.pathname, isStudent, studentMenuGroups, teacherMenuItems])

  // ── 代码练习页随机名言（仅在挂载时计算一次） ──
  // codeQuote 供 CodePracticePage 通过 context 或 props 获取
  // 当前暂未使用，保留以备后续扩展

  // ── 加载当前用户称号等级（用于顶栏头像） ──
  const [userTitleLevel, setUserTitleLevel] = useState(1)
  const [userTitleColor, setUserTitleColor] = useState('#1677ff')
  useEffect(() => {
    if (isLoggedIn) {
      apiClient.get('/api/rewards/my-title').then(({ data }) => {
        if (data?.main_title) {
          setUserTitleLevel(data.main_title.level || 1)
          const cMap: Record<string, string> = {
            lime: '#a0d911', green: '#52c41a', cyan: '#13c2c2',
            blue: '#1677ff', geekblue: '#2f54eb', purple: '#722ed1',
            magenta: '#eb2f96', gold: '#faad14', orange: '#fa8c16',
            volcano: '#fa541c', red: '#f5222d',
          }
          setUserTitleColor(cMap[data.main_title.color] || '#1677ff')
        }
      }).catch(() => {})
    }
  }, [isLoggedIn])

  // ── 等级头像 emoji 映射（与 PortfolioPage 保持一致） ──
  const getTitleEmoji = (level: number, role: string): string => {
    if (role === 'admin') return '⚜️'
    if (role === 'teacher') return '🎓'
    if (level <= 1) return '🪴'
    if (level <= 2) return '🌱'
    if (level <= 3) return '🌿'
    if (level <= 4) return '🌳'
    if (level <= 5) return '🎯'
    if (level <= 6) return '🔮'
    if (level <= 7) return '🚀'
    if (level <= 8) return '🌟'
    if (level <= 9) return '🌙'
    if (level <= 10) return '☀️'
    if (level <= 11) return '👑'
    return '💎'
  }
  const avatarEmoji = getTitleEmoji(userTitleLevel, user?.role || 'student')
  const avatarBg = isAdmin ? '#f5222d' : isTeacher ? '#722ed1' : userTitleColor

  React.useEffect(() => {
    fetchOnlineCount()
    const timer = setInterval(fetchOnlineCount, 30000)
    return () => clearInterval(timer)
  }, [fetchOnlineCount])

  const [securitySetupOpen, setSecuritySetupOpen] = useState(false)

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  const userMenu = {
    items: [
      { key: 'info', label: `${user?.name || user?.username} (${user?.role})`, disabled: true },
      { type: 'divider' as const },
      { key: 'security', icon: <SafetyCertificateOutlined />, label: t('securitySettings') },
      { type: 'divider' as const },
      { key: 'logout', icon: <LogoutOutlined />, label: t('logout'), danger: true },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'logout') handleLogout()
      else if (key === 'security') setSecuritySetupOpen(true)
    },
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {/* 称号升级/徽章解锁庆祝弹窗 */}
      <TitleCelebration />
      <Header
        style={{
          background: 'var(--bg-container)',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border-color)',
          boxShadow: 'var(--header-shadow)',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        <Space>
          <Typography.Title level={4} style={{ margin: 0, color: 'var(--primary-color)' }}>
            🤖 SmartKB
          </Typography.Title>
          {orgName && (
            <Typography.Text style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
              {orgName}
            </Typography.Text>
          )}
          <Typography.Text style={{ fontSize: 13, color: onlineCount > 0 ? 'var(--success-color)' : 'var(--text-tertiary)' }}>
            🟢 {t('onlineCount', { count: onlineCount })}
          </Typography.Text>
        </Space>

        <Space size={16}>
          <LanguageSwitcher />
          <ThemeSwitcher />
          <NotificationBell />
          <Dropdown menu={userMenu} placement="bottomRight">
            <Space style={{ cursor: 'pointer' }}>
              <Avatar style={{ backgroundColor: avatarBg, verticalAlign: 'middle', fontSize: 18, lineHeight: '40px' }}>
                {avatarEmoji}
              </Avatar>
              <span>{user?.name || user?.username}</span>
            </Space>
          </Dropdown>
        </Space>
      </Header>

      <Layout style={{ height: 'calc(100vh - 64px)', padding: 12, gap: 12, background: 'var(--bg-layout)' }}>
        <Sider
          width={200}
          collapsedWidth={64}
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
          style={{
            background: 'var(--bg-container)',
            borderRight: '1px solid var(--border-color)',
            overflow: 'auto',
            height: '100%',
            position: 'sticky',
            top: 0,
            left: 0,
            borderRadius: 8,
          }}
        >
          {/* 折叠/展开切换按钮 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 48,
              borderBottom: collapsed ? 'none' : '1px solid var(--border-color)',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
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
            style={{ height: '100%', borderRight: 0, padding: '4px 0' }}
          />
        </Sider>

        <Content style={{ padding: 24, background: 'var(--bg-layout)', overflow: 'auto', height: '100%', borderRadius: 8, flex: 1 }}>
          <Outlet />
          <div style={{ textAlign: 'center', padding: '16px 0 0', color: 'var(--footer-text)', fontSize: 12 }}>
            © 2026 UNET. All rights reserved.
          </div>
        </Content>
      </Layout>

      {/* 密保设置弹窗 */}
      <SecuritySetupModal
        open={securitySetupOpen}
        onClose={() => setSecuritySetupOpen(false)}
        onSkip={() => setSecuritySetupOpen(false)}
      />
    </Layout>
  )
}

export default AppLayout
