import React, { useState, useEffect } from 'react'
import { Card, Form, Input, Button, Typography, Space, message } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { getOnlineCount } from '../api/auth'
import apiClient from '../api/client'
import ThemeSwitcher from '../components/ThemeSwitcher'

const LoginPage: React.FC = () => {
  const navigate = useNavigate()
  const login = useAuthStore((s: { login: (u: string, p: string) => Promise<void> }) => s.login)
  const [loading, setLoading] = useState(false)
  const [onlineCount, setOnlineCount] = useState(0)
  const [agentName, setAgentName] = useState('智慧教学平台-高中信通版')
  const [orgName, setOrgName] = useState('')

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
      message.success('登录成功')
      navigate('/dashboard')
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err.message || '登录失败'
      message.error(detail)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        background: `linear-gradient(135deg, var(--login-gradient-start) 0%, var(--login-gradient-end) 100%)`,
        padding: 20,
        position: 'relative',
      }}
    >
      {/* 右上角主题切换 */}
      <div style={{
        position: 'fixed', top: 16, right: 20, zIndex: 200,
        background: 'rgba(255,255,255,0.15)',
        backdropFilter: 'blur(8px)',
        borderRadius: 8,
        padding: '2px 4px',
      }}>
        <ThemeSwitcher />
      </div>

      <Card
        style={{ width: 420, borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}
        styles={{ body: { padding: 32 } }}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            {orgName && (
              <Typography.Text style={{ display: 'block', fontSize: 13, color: 'var(--text-tertiary)', marginBottom: 4 }}>
                {orgName}
              </Typography.Text>
            )}
            <Typography.Title level={3} style={{ margin: 0, color: 'var(--primary-color)' }}>
              🤖 SmartKB
            </Typography.Title>
            <Typography.Text type="secondary">{agentName}</Typography.Text>
            <div style={{ marginTop: 8, fontSize: 13, color: onlineCount > 0 ? 'var(--success-color)' : 'var(--text-tertiary)' }}>
              🟢 在线人数: {onlineCount}
            </div>
          </div>

          <Form onFinish={handleLogin} layout="vertical" size="large">
            <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
              <Input prefix={<UserOutlined />} placeholder="用户名或姓名" />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" block loading={loading}>
                登录
              </Button>
            </Form.Item>
          </Form>

          {orgName && (
            <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--footer-text)' }}>
              {orgName}
            </div>
          )}
        </Space>
      </Card>
      <div style={{ position: 'fixed', bottom: 16, textAlign: 'center', width: '100%', color: 'var(--footer-text)', opacity: 0.8, fontSize: 12 }}>
        © 2026 UNET. All rights reserved.
      </div>
    </div>
  )
}

export default LoginPage
