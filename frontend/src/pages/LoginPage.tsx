import React, { useState, useEffect } from 'react'
import { Dropdown, Form, Input, Button, Typography, message, Row, Col, Tooltip } from 'antd'
import {
  UserOutlined, LockOutlined, SkinOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import { useThemeStore } from '../stores/themeStore'
import { getVisitStats, type VisitStats } from '../api/auth'
import apiClient from '../api/client'
import ThemeSwitcher from '../components/ThemeSwitcher'
import LanguageSwitcher from '../components/LanguageSwitcher'
import ForgotPasswordModal from '../components/ForgotPasswordModal'
import { getRandomQuote } from '../constants/loginQuotes'
import {
  LOGIN_SKINS,
  LOGIN_SKIN_STORAGE_KEY,
  dailySkinIndex,
  randomSkinIndex,
  readStoredSkinIndex,
  isLightSkin,
  hexToRgba,
} from '../constants/loginSkins'
import { startPoller, stopPoller } from '../utils/poller'
import { useLocaleStore } from '../stores/localeStore'

const { Text, Title, Paragraph } = Typography

/** 装饰浮动圆：位置尺寸固定，颜色跟随皮肤（tint=取渐变末色的半透明，否则白色） */
const BUBBLES = [
  { size: 320, top: '8%', left: '-4%', delay: 0, duration: 20, tint: true },
  { size: 220, top: '55%', left: '12%', delay: 3, duration: 25, tint: false },
  { size: 260, top: '3%', right: '28%', delay: 6, duration: 22, tint: true },
  { size: 160, bottom: '15%', right: '8%', delay: 2, duration: 18, tint: false },
  { size: 190, top: '35%', right: '38%', delay: 8, duration: 28, tint: true },
]

const LoginPage: React.FC = () => {
  const { t } = useTranslation('login')
  const lang = useLocaleStore((s) => s.current)
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const themeName = useThemeStore((s) => s.current)
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<VisitStats>({ online: 0, today_times: 0, today_users: 0, total_times: 0 })
  const [agentName, setAgentName] = useState(t('defaultAgentName'))
  const [orgName, setOrgName] = useState('')
  const [forgotModalOpen, setForgotModalOpen] = useState(false)

  // 把大数缩写成固定量级的文本：中文 万/亿，其它语言 k/M。
  // 登录页这一行是 nowrap + 省略号兜底，但真正让它不被"累计"撑破的是这里 ——
  // 数字位数会随使用不断增长，不缩写迟早从一行变成两行。精确值放在悬停提示里。
  const formatBigCount = (n: number): string => {
    const v = Number(n) || 0
    if (lang === 'zh-CN') {
      if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')}亿`
      if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')}万`
      return String(v)
    }
    if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`
    if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}k`
    return String(v)
  }

  // 随机选一条名言（仅在组件挂载时确定）
  const [quote] = useState(() => getRandomQuote())

  // ── 登录皮肤：默认"每日一色"（全校当天稳定），🎲 可临时随机（仅本次会话记住）──
  const [skinIndex, setSkinIndex] = useState<number>(() => readStoredSkinIndex() ?? dailySkinIndex())
  const skin = LOGIN_SKINS[skinIndex] || LOGIN_SKINS[0]
  const isDarkTheme = themeName === 'midnight'
  const lightSkin = isLightSkin(skin)

  const shuffleSkin = () => {
    const next = randomSkinIndex(skinIndex)
    sessionStorage.setItem(LOGIN_SKIN_STORAGE_KEY, String(next))
    setSkinIndex(next)
  }
  const restoreDailySkin = () => {
    sessionStorage.removeItem(LOGIN_SKIN_STORAGE_KEY)
    setSkinIndex(dailySkinIndex())
  }

  // 获取公开配置（品牌信息）
  useEffect(() => {
    apiClient.get('/api/config/public').then(({ data }) => {
      if (data.AGENT_NAME) setAgentName(data.AGENT_NAME)
      if (data.ORG_NAME) setOrgName(data.ORG_NAME)
    }).catch(() => {})
    // 检查是否有异地登录被踢出的提示
    const kickoutMsg = localStorage.getItem('smartkb_kickout_msg')
    if (kickoutMsg) {
      message.warning(kickoutMsg)
      localStorage.removeItem('smartkb_kickout_msg')
    }
  }, [])

  // A7: 浏览器标签标题跟随登录页语言
  useEffect(() => {
    document.title = t('pageTitle')
  }, [lang, t])

  useEffect(() => {
    // 一个接口拿全四个数：登录页对未登录访客也在轮询，不该拆成多个请求
    const poll = () => { getVisitStats().then(setStats).catch(() => {}) }
    // 登录页本身没有登录态，requireAuth=false；标签页切到后台时自动停轮询
    startPoller('login-online-count', poll, 15000, { requireAuth: false })
    return () => stopPoller('login-online-count')
  }, [])

  const handleLogin = async (values: { username: string; password: string }) => {
    setLoading(true)
    try {
      await login(values.username, values.password)
      message.success(t('loginSuccess'))
      navigate('/dashboard')
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err.message || t('loginFailed')
      message.error(detail)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', position: 'relative', overflow: 'hidden' }}>
      {/* ── 全屏渐变背景（每日一色 / 🎲 随机皮肤）── */}
      <div style={{
        position: 'fixed', inset: 0,
        background: `linear-gradient(135deg, ${skin.from} 0%, ${skin.to} 100%)`,
        zIndex: 0,
      }} />

      {/* ── 浮动装饰圆（颜色跟随皮肤）── */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {BUBBLES.map((b, i) => (
          <div key={i} style={{
            position: 'absolute',
            width: b.size, height: b.size,
            borderRadius: '50%',
            background: b.tint
              ? hexToRgba(skin.to, isDarkTheme ? 0.20 : 0.26)
              : 'rgba(255,255,255,0.10)',
            top: b.top, left: b.left, right: b.right, bottom: b.bottom,
            animation: `loginFloat ${b.duration}s ease-in-out ${b.delay}s infinite alternate`,
          }} />
        ))}
      </div>
      <style>{`
        @keyframes loginFloat {
          0% { transform: translate(0, 0) scale(1); }
          100% { transform: translate(30px, -40px) scale(1.1); }
        }
        @keyframes loginFadeIn {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .login-card-wrap { animation: loginFadeIn 0.7s ease-out; }
        /* B1: 矮屏紧凑模式：先收名言，再收在线人数，最后压缩内边距，保证登录表单始终完整可见 */
        @media (max-height: 720px) { .login-quote { display: none !important; } }
        @media (max-height: 680px) {
          .login-brand { margin-bottom: 12px !important; }
          .login-online { margin-bottom: 10px !important; }
          .login-panel { padding-top: 18px !important; padding-bottom: 20px !important; }
        }
        @media (max-height: 560px) { .login-online { display: none !important; } }
        /* 玻璃卡片在不支持背景模糊的老浏览器上退回实心卡片，可读性优先 */
        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
          .login-card-glass { background: var(--bg-container) !important; }
        }
      `}</style>

      {/* ── 右上角皮肤切换 & 主题切换 & 语言切换 ── */}
      <div style={{
        position: 'fixed', top: 16, right: 20, zIndex: 200,
        display: 'flex', gap: 6, alignItems: 'center',
        background: 'rgba(255,255,255,0.15)',
        backdropFilter: 'blur(8px)',
        borderRadius: 8,
        padding: '2px 4px',
      }}>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'shuffle', label: t('shuffleSkin'), onClick: shuffleSkin },
              { key: 'daily', label: t('dailySkin'), onClick: restoreDailySkin },
            ],
          }}
        >
          <Tooltip title={t('skinSwitch')}>
            <Button
              type="text"
              size="small"
              icon={<SkinOutlined />}
              style={{ color: lightSkin ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.85)' }}
            />
          </Tooltip>
        </Dropdown>
        <LanguageSwitcher />
        <ThemeSwitcher />
      </div>

      {/* ── 主内容 ── */}
      <Row
        justify="center"
        align="middle"
        style={{ minHeight: '100vh', position: 'relative', zIndex: 1, padding: 20 }}
      >
        <Col xs={24} sm={22} md={14} lg={10} xl={9} xxl={8} className="login-card-wrap">
          {/* 玻璃卡片容器：半透明磨砂，让当天皮肤的颜色透进登录区 */}
          <div
            className="login-card-glass"
            style={{
              borderRadius: 20,
              overflow: 'hidden',
              boxShadow: '0 20px 60px rgba(0,0,0,0.18), 0 0 0 1px rgba(255,255,255,0.22)',
              background: isDarkTheme ? 'rgba(13, 16, 38, 0.68)' : 'rgba(255, 255, 255, 0.74)',
              backdropFilter: 'blur(24px) saturate(150%)',
              WebkitBackdropFilter: 'blur(24px) saturate(150%)',
            }}
          >

            {/* ── 登录面板 ── */}
            <div className="login-panel" style={{ padding: '32px 36px 36px' }}>
              {/* 品牌标识 */}
              <div className="login-brand" style={{ textAlign: 'center', marginBottom: 28 }}>
                <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 4 }}>🤖</div>
                <Title level={3} style={{ margin: 0, color: 'var(--primary-color)', fontWeight: 700 }}>
                  SmartKB
                </Title>
                <Text style={{ color: 'var(--text-secondary)', fontSize: 13, display: 'block', marginTop: 2 }}>
                  {agentName}
                </Text>
                {orgName && (
                  <Text style={{ color: 'var(--text-tertiary)', fontSize: 12, display: 'block', marginTop: 2 }}>
                    {orgName}
                  </Text>
                )}
              </div>

              {/* 在线 + 访问统计。这一行必须永远只占一行：正文只留数字
                  （今日只给访问次数一个数），累计按量级缩写，样式上 nowrap + 省略号兜底 */}
              <div
                className="login-online"
                style={{
                  textAlign: 'center',
                  marginBottom: 20,
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  color: stats.online > 0 ? 'var(--success-color)' : 'var(--text-tertiary)',
                }}
              >
                🟢 {t('onlineCountText', { count: stats.online })}
                <span> · </span>
                {t('visitTodayText', { times: stats.today_times })}
                <span> · </span>
                {t('visitTotalText', { times: formatBigCount(stats.total_times) })}
              </div>

              {/* 名言 */}
              <div className="login-quote" style={{
                marginBottom: 20,
                padding: '14px 18px',
                background: isDarkTheme ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.5)',
                borderRadius: 10,
                textAlign: 'center',
              }}>
                <Paragraph style={{
                  color: 'var(--text-secondary)', fontSize: 13, fontWeight: 400,
                  fontStyle: 'italic', lineHeight: 1.7, margin: 0,
                }}>
                  「{quote.text}」
                </Paragraph>
                {quote.author && (
                  <Text style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 2, display: 'block' }}>
                    {t('quotePrefix')}{quote.author}
                  </Text>
                )}
              </div>

              {/* 登录表单 */}
              <Form onFinish={handleLogin} layout="vertical" size="large">
                <Form.Item
                  name="username"
                  rules={[{ required: true, message: t('usernameRequired') }]}
                  style={{ marginBottom: 20 }}
                >
                  <Input
                    autoFocus
                    autoComplete="username"
                    prefix={<UserOutlined style={{ color: 'var(--text-tertiary)' }} />}
                    placeholder={t('usernameOrName')}
                    style={{ borderRadius: 10 }}
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  rules={[{ required: true, message: t('passwordRequired') }]}
                  style={{ marginBottom: 8 }}
                >
                  <Input.Password
                    autoComplete="current-password"
                    prefix={<LockOutlined style={{ color: 'var(--text-tertiary)' }} />}
                    placeholder={t('password')}
                    style={{ borderRadius: 10 }}
                  />
                </Form.Item>
                <div style={{ textAlign: 'right', marginBottom: 20 }}>
                  <Button
                    type="link"
                    style={{ padding: 0, fontSize: 13 }}
                    onClick={() => setForgotModalOpen(true)}
                  >
                    {t('forgotPassword')}
                  </Button>
                </div>
                <Form.Item style={{ marginBottom: 0 }}>
                  <Button
                    type="primary"
                    htmlType="submit"
                    block
                    loading={loading}
                    size="large"
                    style={{ borderRadius: 10, height: 48, fontSize: 16 }}
                  >
                    {t('loginBtn')}
                  </Button>
                </Form.Item>
              </Form>

              {/* 版权 */}
              <div style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: 'var(--footer-text)' }}>
                © 2026 UNET. All rights reserved.
              </div>
            </div>
          </div>
        </Col>
      </Row>

      {/* 忘记密码弹窗 */}
      <ForgotPasswordModal
        open={forgotModalOpen}
        onClose={() => setForgotModalOpen(false)}
      />
    </div>
  )
}

export default LoginPage