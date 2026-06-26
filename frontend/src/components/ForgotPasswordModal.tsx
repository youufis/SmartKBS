/**
 * 忘记密码弹窗（双问题验证 + 频率限制）
 * 流程：输入用户名 → 回答问题① → 回答问题② → 设置新密码 → 完成
 */
import React, { useState, useRef } from 'react'
import { Modal, Steps, Form, Input, Button, message, Typography, Alert } from 'antd'
import {
  UserOutlined, QuestionCircleOutlined, LockOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import * as authApi from '../api/auth'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
}

const STEP_LABELS = ['验证身份', '问题①', '问题②', '重置密码', '完成']
const STEP_ICONS = [
  <UserOutlined />,
  <QuestionCircleOutlined />,
  <QuestionCircleOutlined />,
  <LockOutlined />,
  <CheckCircleOutlined />,
]

const ForgotPasswordModal: React.FC<Props> = ({ open, onClose }) => {
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [username, setUsername] = useState('')
  const [question1, setQuestion1] = useState('')
  const [question2, setQuestion2] = useState('')
  // 临时存储已回答的答案（传给最后一步）
  const answer1Ref = useRef('')
  const answer2Ref = useRef('')
  const [lockedMsg, setLockedMsg] = useState('')

  // 表单实例
  const [usernameForm] = Form.useForm()
  const [answer1Form] = Form.useForm()
  const [answer2Form] = Form.useForm()
  const [passwordForm] = Form.useForm()

  // 状态和 ref 由 Modal destroyOnClose 自动重置，无需 effect

  // ── 第1步：验证用户名 ──
  const handleCheckUsername = async (values: { username: string }) => {
    setLoading(true)
    setLockedMsg('')
    try {
      const usernameVal = values.username.trim()
      setUsername(usernameVal)
      const result = await authApi.securityCheck(usernameVal)
      setQuestion1(result.question1)
      setQuestion2(result.question2)
      setStep(1)
    } catch (err: any) {
      const status = err?.response?.status
      const detail = err?.response?.data?.detail || ''
      if (status === 404) {
        message.error('该用户不存在')
      } else if (status === 400) {
        message.error('该用户未设置密保问题，请联系管理员重置密码')
      } else {
        message.error(detail || '验证失败')
      }
    } finally {
      setLoading(false)
    }
  }

  // ── 第2步：验证问题① ──
  const handleVerifyQ1 = async (values: { answer: string }) => {
    setLoading(true)
    setLockedMsg('')
    try {
      await authApi.verifySecurity(username, values.answer, 0)
      answer1Ref.current = values.answer
      message.success('第一题答案正确')
      setStep(2)
    } catch (err: any) {
      const status = err?.response?.status
      const detail = err?.response?.data?.detail || ''
      if (status === 429) {
        setLockedMsg(detail)
        message.error(detail)
      } else {
        message.error(detail || '答案错误')
      }
    } finally {
      setLoading(false)
    }
  }

  // ── 第3步：验证问题② ──
  const handleVerifyQ2 = async (values: { answer: string }) => {
    setLoading(true)
    setLockedMsg('')
    try {
      await authApi.verifySecurity(username, values.answer, 1)
      answer2Ref.current = values.answer
      message.success('第二题答案正确')
      setStep(3)
    } catch (err: any) {
      const status = err?.response?.status
      const detail = err?.response?.data?.detail || ''
      if (status === 429) {
        setLockedMsg(detail)
        message.error(detail)
      } else {
        message.error(detail || '答案错误')
      }
    } finally {
      setLoading(false)
    }
  }

  // ── 第4步：重置密码 ──
  const handleResetPassword = async (values: { new_password: string }) => {
    setLoading(true)
    try {
      const msg = await authApi.resetPasswordBySecurity(
        username, answer1Ref.current, answer2Ref.current, values.new_password,
      )
      message.success(msg)
      setStep(4)
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '重置失败')
    } finally {
      setLoading(false)
    }
  }

  const handleDone = () => onClose()

  return (
    <Modal
      title="找回密码"
      open={open}
      onCancel={onClose}
      footer={null}
      width={480}
      destroyOnClose
      maskClosable={false}
    >
      <Steps
        current={step}
        size="small"
        style={{ marginBottom: 28, marginTop: 8 }}
        items={STEP_LABELS.map((title, i) => ({
          title,
          icon: STEP_ICONS[i],
        }))}
      />

      {lockedMsg && (
        <Alert
          type="warning"
          message={lockedMsg}
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      {/* ═══ 第1步：输入用户名 ═══ */}
      {step === 0 && (
        <Form form={usernameForm} onFinish={handleCheckUsername} layout="vertical">
          <Text style={{ display: 'block', marginBottom: 16, color: 'var(--text-secondary)' }}>
            请输入你的用户名，系统将验证你是否已设置密保问题。
          </Text>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Button style={{ marginRight: 8 }} onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={loading}>下一步</Button>
          </Form.Item>
        </Form>
      )}

      {/* ═══ 第2步：回答问题① ═══ */}
      {step === 1 && (
        <Form form={answer1Form} onFinish={handleVerifyQ1} layout="vertical">
          <div style={{
            marginBottom: 20, padding: '14px 18px',
            background: 'var(--bg-layout)', borderRadius: 10,
            border: '1px solid var(--border-color)',
          }}>
            <Text style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'block', marginBottom: 4 }}>
              密保问题 ①
            </Text>
            <Text strong style={{ fontSize: 15 }}>
              <QuestionCircleOutlined style={{ marginRight: 8, color: 'var(--primary-color)' }} />
              {question1}
            </Text>
          </div>
          <Form.Item
            name="answer"
            label="答案"
            rules={[{ required: true, message: '请输入答案' }]}
          >
            <Input.Password placeholder="请输入你的答案" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Button style={{ marginRight: 8 }} onClick={() => setStep(0)}>上一步</Button>
            <Button type="primary" htmlType="submit" loading={loading}>验证</Button>
          </Form.Item>
        </Form>
      )}

      {/* ═══ 第3步：回答问题② ═══ */}
      {step === 2 && (
        <Form form={answer2Form} onFinish={handleVerifyQ2} layout="vertical">
          <div style={{
            marginBottom: 20, padding: '14px 18px',
            background: 'var(--bg-layout)', borderRadius: 10,
            border: '1px solid var(--border-color)',
          }}>
            <Text style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'block', marginBottom: 4 }}>
              密保问题 ②
            </Text>
            <Text strong style={{ fontSize: 15 }}>
              <QuestionCircleOutlined style={{ marginRight: 8, color: 'var(--primary-color)' }} />
              {question2}
            </Text>
          </div>
          <Form.Item
            name="answer"
            label="答案"
            rules={[{ required: true, message: '请输入答案' }]}
          >
            <Input.Password placeholder="请输入你的答案" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Button style={{ marginRight: 8 }} onClick={() => setStep(1)}>上一步</Button>
            <Button type="primary" htmlType="submit" loading={loading}>验证</Button>
          </Form.Item>
        </Form>
      )}

      {/* ═══ 第4步：设置新密码 ═══ */}
      {step === 3 && (
        <Form form={passwordForm} onFinish={handleResetPassword} layout="vertical">
          <Alert
            type="success"
            message="两道密保验证均已通过！"
            style={{ marginBottom: 16 }}
            showIcon
          />
          <Form.Item
            name="new_password"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 4, message: '密码至少4个字符' },
            ]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="请输入新密码" />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label="确认新密码"
            dependencies={['new_password']}
            rules={[
              { required: true, message: '请确认新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                  return Promise.reject(new Error('两次输入的密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="请再次输入新密码" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Button style={{ marginRight: 8 }} onClick={() => setStep(2)}>上一步</Button>
            <Button type="primary" htmlType="submit" loading={loading}>重置密码</Button>
          </Form.Item>
        </Form>
      )}

      {/* ═══ 第5步：完成 ═══ */}
      {step === 4 && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <CheckCircleOutlined style={{ fontSize: 48, color: 'var(--success-color)' }} />
          <br /><br />
          <Text strong style={{ fontSize: 16 }}>密码已成功重置！</Text>
          <br />
          <Text style={{ color: 'var(--text-secondary)' }}>
            请使用新密码登录你的账号。
          </Text>
          <br /><br />
          <Button type="primary" onClick={handleDone}>返回登录</Button>
        </div>
      )}
    </Modal>
  )
}

export default ForgotPasswordModal
