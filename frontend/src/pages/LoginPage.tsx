import React, { useState, useEffect } from 'react'
import { Form, Input, Button, Typography, message, Row, Col } from 'antd'
import {
  UserOutlined, LockOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import { getOnlineCount } from '../api/auth'
import apiClient from '../api/client'
import ThemeSwitcher from '../components/ThemeSwitcher'
import LanguageSwitcher from '../components/LanguageSwitcher'
import ForgotPasswordModal from '../components/ForgotPasswordModal'
import { getRandomQuote } from '../constants/loginQuotes'

const { Text, Title, Paragraph } = Typography

const LoginPage: React.FC = () => {
  const { t } = useTranslation('login')
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const [loading, setLoading] = useState(false)
  const [onlineCount, setOnlineCount] = useState(0)
  const [agentName, setAgentName] = useState(t('defaultAgentName'))
  const [orgName, setOrgName] = useState('')
  const [forgotModalOpen, setForgotModalOpen] = useState(false)

  // 随机选一条名言（仅在组件挂载时确定）
  const [quote] = useState(() => getRandomQuote())

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

  useEffect(() => {
    getOnlineCount().then(setOnlineCount).catch(() => {})
    const timer = setInterval(() => getOnlineCount().then(setOnlineCount).catch(() => {}), 15000)
    return () => clearInterval(timer)
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
      {/* ── 全屏渐变背景 ── */}
      <div style={{
        position: 'fixed', inset: 0,
        background: `linear-gradient(135deg, var(--login-gradient-start) 0%, var(--login-gradient-end) 100%)`,
        zIndex: 0,
      }} />

      {/* ── 浮动装饰圆 ── */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {[
          { size: 320, top: '8%', left: '-4%', delay: 0, duration: 20 },
          { size: 220, top: '55%', left: '12%', delay: 3, duration: 25 },
          { size: 260, top: '3%', right: '28%', delay: 6, duration: 22 },
          { size: 160, bottom: '15%', right: '8%', delay: 2, duration: 18 },
          { size: 190, top: '35%', right: '38%', delay: 8, duration: 28 },
        ].map((c, i) => (
          <div key={i} style={{
            position: 'absolute',
            width: c.size, height: c.size,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.06)',
            top: c.top, left: c.left, right: c.right, bottom: c.bottom,
            animation: `loginFloat ${c.duration}s ease-in-out ${c.delay}s infinite alternate`,
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
      `}</style>

      {/* ── 右上角主题切换 & 语言切换 ── */}
      <div style={{
        position: 'fixed', top: 16, right: 20, zIndex: 200,
        display: 'flex', gap: 6,
        background: 'rgba(255,255,255,0.15)',
        backdropFilter: 'blur(8px)',
        borderRadius: 8,
        padding: '2px 4px',
      }}>
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
          {/* 玻璃卡片容器 */}
          <div style={{
            borderRadius: 20,
            overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.08)',
            background: 'var(--bg-container)',
          }}>

            {/* ── 登录面板 ── */}
            <div style={{
              padding: '32px 36px 36px',
              background: 'var(--bg-container)',
            }}>
              {/* 品牌标识 */}
              <div style={{ textAlign: 'center', marginBottom: 28 }}>
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

              {/* 在线人数 */}
              <div style={{
                textAlign: 'center',
                marginBottom: 20,
                fontSize: 12,
                color: onlineCount > 0 ? 'var(--success-color)' : 'var(--text-tertiary)',
              }}>
                🟢 {t('onlineCountText', { count: onlineCount })}
              </div>

              {/* 名言 */}
              <div style={{
                marginBottom: 20,
                padding: '14px 18px',
                background: 'var(--bg-layout)',
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
