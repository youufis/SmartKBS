/**
 * 密保设置/查看弹窗（双问题）
 * 首次登录 → 空白表单强制设置
 * 安全设置 → 先展示当前密保问题，点击"修改"进入编辑模式
 */
import React, { useState, useEffect } from 'react'
import { Modal, Form, Select, Input, Button, message, Typography, Divider, Tag, Space } from 'antd'
import {
  QuestionCircleOutlined, SafetyCertificateOutlined, EditOutlined, CheckCircleOutlined,
} from '@ant-design/icons'
import * as authApi from '../api/auth'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  onSkip?: () => void
}

const SecuritySetupModal: React.FC<Props> = ({ open, onClose, onSkip }) => {
  const [loading, setLoading] = useState(false)
  const [questions, setQuestions] = useState<string[]>([])
  const [configured, setConfigured] = useState(false)
  const [currentQ1, setCurrentQ1] = useState('')
  const [currentQ2, setCurrentQ2] = useState('')
  const [editing, setEditing] = useState(false)
  const [form] = Form.useForm()

  // 打开时加载数据
  useEffect(() => {
    if (open) {
      setEditing(false)
      authApi.getSecurityQuestions().then(setQuestions).catch(() => {})
      authApi.getSecurityStatus().then((status) => {
        setCurrentQ1(status.question1 || '')
        setCurrentQ2(status.question2 || '')
        // configured=true 仅当两道题都完整
        setConfigured(status.configured)
        // 旧版用户只有1道题 → 自动进入编辑模式并预填问题1
        if (status.question1 && !status.question2) {
          setEditing(true)
          form.setFieldsValue({ question1: status.question1 })
        }
      }).catch(() => {})
      form.resetFields()
    }
  }, [open, form])

  // 获取已选的问题1，用于过滤问题2的选项（不能相同）
  const selectedQ1 = Form.useWatch('question1', form)

  const getQuestion2Options = () =>
    questions
      .filter((q) => q !== selectedQ1)
      .map((q) => ({ label: q, value: q }))

  const handleSubmit = async (values: {
    question1: string; answer1: string
    question2: string; answer2: string
  }) => {
    setLoading(true)
    try {
      const msg = await authApi.setSecurityQuestions(
        values.question1, values.answer1,
        values.question2, values.answer2,
      )
      message.success(msg)
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '设置失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={
        <span>
          <SafetyCertificateOutlined style={{ marginRight: 8, color: 'var(--primary-color)' }} />
          {configured && !editing ? '密保问题' : '设置密保问题'}
        </span>
      }
      open={open}
      onCancel={() => {
        // 编辑模式：完全配置的用户回到查看模式，旧版用户直接关闭
        if (editing) {
          if (configured) { setEditing(false); return }
          else { onClose(); return }
        }
        if (onSkip) {
          Modal.confirm({
            title: '确定跳过吗？',
            content: '设置密保问题后，你可以在忘记密码时通过它找回账号。建议立即设置。',
            okText: '暂不设置',
            cancelText: '继续设置',
            onOk: () => onSkip(),
          })
        } else {
          onClose()
        }
      }}
      footer={null}
      width={520}
      destroyOnClose
      maskClosable={false}
      closable={true}
    >
      {/* ═══ 已设置 → 查看模式 ═══ */}
      {configured && !editing && (
        <>
          <div style={{
            marginBottom: 20, padding: '14px 18px',
            background: 'var(--bg-layout)', borderRadius: 10,
          }}>
            <CheckCircleOutlined style={{ color: 'var(--success-color)', marginRight: 8 }} />
            <Text style={{ color: 'var(--text-secondary)' }}>
              你已设置密保问题。忘记密码时可通过回答这些问题重置密码。
            </Text>
          </div>

          <div style={{
            marginBottom: 12, padding: '14px 18px',
            border: '1px solid var(--border-color)', borderRadius: 10,
          }}>
            <Text style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'block', marginBottom: 4 }}>
              密保问题 ①
            </Text>
            <Text strong>
              <QuestionCircleOutlined style={{ marginRight: 8, color: 'var(--primary-color)' }} />
              {currentQ1}
            </Text>
          </div>
          <div style={{
            marginBottom: 20, padding: '14px 18px',
            border: '1px solid var(--border-color)', borderRadius: 10,
          }}>
            <Text style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'block', marginBottom: 4 }}>
              密保问题 ②
            </Text>
            <Text strong>
              <QuestionCircleOutlined style={{ marginRight: 8, color: 'var(--primary-color)' }} />
              {currentQ2}
            </Text>
          </div>

          <div style={{ textAlign: 'right' }}>
            <Button style={{ marginRight: 8 }} onClick={onClose}>关闭</Button>
            <Button
              type="primary"
              icon={<EditOutlined />}
              onClick={() => setEditing(true)}
            >
              修改密保
            </Button>
          </div>
        </>
      )}

      {/* ═══ 未设置 / 编辑模式 ═══ */}
      {(!configured || editing) && (
        <>
          <div style={{ marginBottom: 20 }}>
            <Text style={{ color: 'var(--text-secondary)' }}>
              {configured && editing
                ? '修改密保问题后，旧的问题将失效。请设置两个不同的密保问题。'
                : currentQ1 && !currentQ2
                  ? <>你之前设置了1个密保问题，请再<Text strong>添加第二个</Text>密保问题以完善安全设置。</>
                  : <>请设置<Text strong>两个不同的</Text>密保问题并牢记答案。
                     忘记密码时，需要<Text strong>同时答对两个问题</Text>才能重置密码。</>
              }
            </Text>
          </div>

          <Form form={form} onFinish={handleSubmit} layout="vertical">
            <Text strong style={{ display: 'block', marginBottom: 8 }}>密保问题 ①</Text>
            <Form.Item
              name="question1"
              rules={[{ required: true, message: '请选择第一个密保问题' }]}
            >
              <Select
                placeholder="请选择第一个密保问题"
                options={questions.map((q) => ({ label: q, value: q }))}
              />
            </Form.Item>
            <Form.Item
              name="answer1"
              rules={[
                { required: true, message: '请输入答案' },
                { min: 2, message: '答案至少需要2个字符' },
              ]}
            >
              <Input.Password
                prefix={<QuestionCircleOutlined />}
                placeholder="请输入答案（请牢记！）"
              />
            </Form.Item>

            <Divider style={{ margin: '12px 0' }} />

            <Text strong style={{ display: 'block', marginBottom: 8 }}>密保问题 ②</Text>
            <Form.Item
              name="question2"
              rules={[{ required: true, message: '请选择第二个密保问题' }]}
            >
              <Select
                placeholder="请选择第二个密保问题（不能与第一个相同）"
                options={getQuestion2Options()}
              />
            </Form.Item>
            <Form.Item
              name="answer2"
              rules={[
                { required: true, message: '请输入答案' },
                { min: 2, message: '答案至少需要2个字符' },
              ]}
            >
              <Input.Password
                prefix={<QuestionCircleOutlined />}
                placeholder="请输入答案（请牢记！）"
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
              {onSkip && !configured && (
                <Button style={{ marginRight: 8 }} onClick={onSkip}>
                  暂不设置
                </Button>
              )}
              {editing && configured && (
                <Button style={{ marginRight: 8 }} onClick={() => setEditing(false)}>
                  取消
                </Button>
              )}
              {editing && !configured && onSkip && (
                <Button style={{ marginRight: 8 }} onClick={onSkip}>
                  暂不设置
                </Button>
              )}
              <Button type="primary" htmlType="submit" loading={loading}>
                确认{configured ? '修改' : '设置'}
              </Button>
            </Form.Item>
          </Form>
        </>
      )}
    </Modal>
  )
}

export default SecuritySetupModal
