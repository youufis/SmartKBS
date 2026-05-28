import React, { useState, useEffect } from 'react'
import { Card, Form, Input, Button, Typography, Space, message } from 'antd'
import { UserOutlined, LockOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { getOnlineCount } from '../api/auth'
import apiClient from '../api/client'

const LoginPage: React.FC = () => {
  const navigate = useNavigate()
  const login = useAuthStore((s: { login: (u: string, p: string) => Promise<void> }) => s.login)
  const [loading, setLoading] = useState(false)
  const [onlineCount, setOnlineCount] = useState(0)
  const [agentName, setAgentName] = useState('高中信通版')
  const [orgName, setOrgName] = useState('')

  // 获取公开配置（品牌信息）
  useEffect(() => {
    apiClient.get('/api/config/public').then(({ data }) => {
      if (data.AGENT_NAME) setAgentName(data.AGENT_NAME)
      if (data.ORG_NAME) setOrgName(data.ORG_NAME)
    }).catch(() => {})
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
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        padding: 20,
      }}
    >
      <Card
        style={{ width: 420, borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.15)' }}
        styles={{ body: { padding: 32 } }}
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            {orgName && (
              <Typography.Text style={{ display: 'block', fontSize: 13, color: '#888', marginBottom: 4 }}>
                {orgName}
              </Typography.Text>
            )}
            <Typography.Title level={3} style={{ margin: 0, color: '#1677ff' }}>
              🤖 SmartKB
            </Typography.Title>
            <Typography.Text type="secondary">教育智能体·{agentName}</Typography.Text>
            <div style={{ marginTop: 8, fontSize: 13, color: onlineCount > 0 ? '#52c41a' : '#999' }}>
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
            <div style={{ textAlign: 'center', fontSize: 12, color: '#bbb' }}>
              {orgName}
            </div>
          )}
        </Space>
      </Card>
      <div style={{ position: 'fixed', bottom: 16, textAlign: 'center', width: '100%', color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
        Copyright © 2025 By UNET All rights reserved.
      </div>
    </div>
  )
}

export default LoginPage
