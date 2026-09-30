import React from 'react'
import {
  AppstoreOutlined,
  BellOutlined,
  BookOutlined,
  HomeOutlined,
  MessageOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

/**
 * 移动端底部 TabBar（地基 B3）。仅在 useIsMobile() 为 true 时由 AppLayout 渲染。
 * 前 4 项 = 角色首批高频页，第 5 项"菜单"打开完整白名单抽屉。
 */

interface TabDef {
  key: string
  labelKey: string
  fallback: string
  icon: React.ReactNode
}

const STUDENT_TABS: TabDef[] = [
  { key: '/dashboard', labelKey: 'dashboard', fallback: '首页', icon: <HomeOutlined /> },
  { key: '/chat', labelKey: 'knowledgeQA', fallback: '学伴', icon: <MessageOutlined /> },
  { key: '/wrong-book', labelKey: 'wrongBook', fallback: '错题', icon: <BookOutlined /> },
  { key: '/notifications', labelKey: 'notifications', fallback: '通知', icon: <BellOutlined /> },
]

const STAFF_TABS: TabDef[] = [
  { key: '/dashboard', labelKey: 'dashboard', fallback: '首页', icon: <HomeOutlined /> },
  { key: '/chat', labelKey: 'knowledgeQA', fallback: '助手', icon: <MessageOutlined /> },
  { key: '/student-questions', labelKey: 'studentQuestions', fallback: '答疑', icon: <QuestionCircleOutlined /> },
  { key: '/notifications', labelKey: 'notifications', fallback: '通知', icon: <BellOutlined /> },
]

interface Props {
  role: string
  activePath: string
  onOpenMenu: () => void
}

const MobileTabBar: React.FC<Props> = ({ role, activePath, onOpenMenu }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('menu')
  const tabs = role === 'student' ? STUDENT_TABS : STAFF_TABS

  const isActive = (key: string) =>
    activePath === key ||
    activePath.startsWith(key + '/') ||
    (key === '/dashboard' && activePath === '/')

  const itemStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    cursor: 'pointer',
    color: active ? 'var(--primary-color)' : 'var(--text-tertiary)',
    fontSize: 11,
    userSelect: 'none',
  })

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        height: 'calc(56px + env(safe-area-inset-bottom))',
        paddingBottom: 'env(safe-area-inset-bottom)',
        display: 'flex',
        background: 'var(--bg-container)',
        borderTop: '1px solid var(--border-color)',
        zIndex: 1000,
      }}
    >
      {tabs.map((tab) => (
        <div key={tab.key} style={itemStyle(isActive(tab.key))} onClick={() => navigate(tab.key)}>
          <span style={{ fontSize: 18 }}>{tab.icon}</span>
          <span>{t(tab.labelKey, { defaultValue: tab.fallback })}</span>
        </div>
      ))}
      <div style={itemStyle(false)} onClick={onOpenMenu}>
        <span style={{ fontSize: 18 }}><AppstoreOutlined /></span>
        <span>{t('mobileMore', { defaultValue: '菜单' })}</span>
      </div>
    </div>
  )
}

export default MobileTabBar
