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
  StarOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import apiClient from '../api/client'
import NotificationBell from './NotificationBell'
import TitleCelebration from './TitleCelebration'

const { Header, Sider, Content } = Layout

// 学生菜单分组（注意：标签中不要使用 emoji，折叠后会显示为 ?）
const studentMenuGroups: { icon: React.ReactNode; label: string; key: string; children: { key: string; icon: React.ReactNode; label: string }[] }[] = [
  { icon: <HomeOutlined />, label: '概览', key: 'overview', children: [
    { key: '/dashboard', icon: <HomeOutlined />, label: '首页' },
  ]},
  { icon: <BookOutlined />, label: '学习中心', key: 'learn', children: [
    { key: '/curriculum', icon: <BookOutlined />, label: '课程导学' },
    { key: '/chat', icon: <MessageOutlined />, label: '智能问答' },
    { key: '/wrong-book', icon: <BookOutlined />, label: '错题巩固' },
    { key: '/shared-center', icon: <FileOutlined />, label: '共享中心' },
  ]},
  { icon: <FileAddOutlined />, label: '考试练习', key: 'exam-practice', children: [
    { key: '/exam', icon: <FileAddOutlined />, label: '在线考试' },
    { key: '/tasks', icon: <CheckCircleOutlined />, label: '在线任务' },
    { key: '/code-practice', icon: <FileAddOutlined />, label: '代码练习' },
    { key: '/quest', icon: <ThunderboltOutlined />, label: '知识闯关' },
    { key: '/practice', icon: <ThunderboltOutlined />, label: '智能练习' },
  ]},
  { icon: <ThunderboltOutlined />, label: '互动课堂', key: 'interactive', children: [
    { key: '/interaction', icon: <ThunderboltOutlined />, label: '随堂测验' },
    { key: '/quick-poll', icon: <BarChartOutlined />, label: '快速投票' },
    { key: '/quick-quiz', icon: <ThunderboltOutlined />, label: '知识抢答' },
    { key: '/discussion', icon: <TeamOutlined />, label: '分组讨论' },
  ]},
  { icon: <MessageOutlined />, label: '师生问答', key: 'qa', children: [
    { key: '/student-questions', icon: <MessageOutlined />, label: '课堂提问' },
  ]},
  { icon: <TrophyOutlined />, label: '成长档案', key: 'growth', children: [
    { key: '/score', icon: <StarOutlined />, label: '积分奖励' },
    { key: '/portfolio', icon: <UserOutlined />, label: '我的档案' },
  ]},
  { icon: <SettingOutlined />, label: '系统', key: 'sys', children: [
    { key: '/user-mgmt', icon: <TeamOutlined />, label: '修改密码' },
    { key: '/announcements', icon: <BellOutlined />, label: '系统公告' },
    { key: '/notifications', icon: <BellOutlined />, label: '通知中心' },
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
    { type: 'group', icon: <BookOutlined />, label: '教学管理', key: 'teach', children: [
      { key: '/curriculum', icon: <BookOutlined />, label: '课程管理' },
      { key: '/chat', icon: <MessageOutlined />, label: '智能问答' },
      { key: '/practice', icon: <ThunderboltOutlined />, label: '智能练习' },
      { key: '/question-bank', icon: <DatabaseOutlined />, label: '试题管理' },
      { key: '/exam', icon: <FileAddOutlined />, label: '考试发布' },
      { key: '/shared-center', icon: <FolderOutlined />, label: '资源中心', adminOrTeacherOnly: true },
    ]},
    { type: 'group', icon: <FileAddOutlined />, label: '编程练习', key: 'coding', children: [
      { key: '/code-practice', icon: <FileAddOutlined />, label: '代码练习' },
    ]},
    { type: 'group', icon: <ThunderboltOutlined />, label: '课堂活动', key: 'classroom', children: [
      { key: '/interaction', icon: <ThunderboltOutlined />, label: '随堂测验' },
      { key: '/quick-poll', icon: <BarChartOutlined />, label: '快速投票' },
      { key: '/quick-quiz', icon: <ThunderboltOutlined />, label: '知识抢答' },
      { key: '/discussion', icon: <TeamOutlined />, label: '分组讨论' },
      { key: '/rollcall', icon: <AuditOutlined />, label: '点名管理' },
    ]},
    { type: 'group', icon: <MessageOutlined />, label: '课堂提问', key: 'qa', children: [
      { key: '/student-questions', icon: <MessageOutlined />, label: '提问管理' },
    ]},
    { type: 'group', icon: <CheckCircleOutlined />, label: '班级事务', key: 'affairs', children: [
      { key: '/tasks', icon: <CheckCircleOutlined />, label: '任务管理' },
      { key: '/score', icon: <TrophyOutlined />, label: '积分管理' },
      { key: '/quest', icon: <TrophyOutlined />, label: '闯关记录', adminOrTeacherOnly: true },
      { key: '/wrong-book', icon: <BookOutlined />, label: '错题巩固' },
    ]},
    { type: 'group', icon: <BarChartOutlined />, label: '学情分析', key: 'analytics', children: [
      { key: '/analytics', icon: <BarChartOutlined />, label: '学情分析' },
      { key: '/class-summary', icon: <RobotOutlined />, label: '课堂总结' },
      { key: '/curriculum/progress', icon: <BarChartOutlined />, label: '课程进度' },
      { key: '/notifications', icon: <BellOutlined />, label: '通知中心' },
    ]},
    { type: 'group', icon: <SettingOutlined />, label: '系统管理', key: 'admin', children: [
      { key: '/user-mgmt', icon: <TeamOutlined />, label: '用户管理' },
      { key: '/announcements', icon: <BellOutlined />, label: '公告管理' },
      { key: '/system-config', icon: <SettingOutlined />, label: '系统配置', adminOnly: true },
      { key: '/about', icon: <InfoCircleOutlined />, label: '系统说明' },
    ]},
  ]

const AppLayout: React.FC = () => {
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
  const getTitleEmoji = (level: number, role: string, gender: string): string => {
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
  const avatarEmoji = getTitleEmoji(userTitleLevel, user?.role || 'student', user?.gender || '')
  const avatarBg = isAdmin ? '#f5222d' : isTeacher ? '#722ed1' : userTitleColor

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
      {/* 称号升级/徽章解锁庆祝弹窗 */}
      <TitleCelebration />
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
              <Avatar style={{ backgroundColor: avatarBg, verticalAlign: 'middle', fontSize: 18, lineHeight: '40px' }}>
                {avatarEmoji}
              </Avatar>
              <span>{user?.name || user?.username}</span>
            </Space>
          </Dropdown>
        </Space>
      </Header>

      <Layout style={{ height: 'calc(100vh - 64px)' }}>
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
            height: '100%',
            position: 'sticky',
            top: 0,
            left: 0,
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

        <Content style={{ padding: '8px 0', background: '#f5f5f5', overflow: 'auto', height: '100%' }}>
          {location.pathname === '/code-practice' && (
            <div style={{
              padding: '12px 24px',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              marginBottom: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <div style={{ color: '#fff' }}>
                <span style={{ fontSize: 15, fontWeight: 500, opacity: 0.95 }}>
                  {[
                    'Talk is cheap. Show me the code.',
                    '代码如诗，简洁为美',
                    '写好每一行代码，解决每一个问题',
                    '编程是思考的艺术',
                    'Debug 是一种修行',
                    '用代码改变世界',
                    '每一次提交，都是进步',
                    'Clear code, clear mind',
                    'Code. Eat. Sleep. Repeat.',
                    '键盘敲烂，月入过万 💪',
                    '编译器不会骗你，但 debug 会 🐛',
                    '先跑起来，再优化',
                    'Programming is the art of logic',
                    '简单的代码最优雅',
                  ][Math.floor(Math.random() * 14)]}
                </span>
              </div>
              <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
                {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
              </div>
            </div>
          )}
          <Outlet />
          <div style={{ textAlign: 'center', padding: '16px 0 0', color: '#bbb', fontSize: 12 }}>
            © 2026 UNET. All rights reserved.
          </div>
        </Content>
      </Layout>
    </Layout>
  )
}

export default AppLayout
