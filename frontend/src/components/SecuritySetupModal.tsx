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
import { useTranslation, Trans } from 'react-i18next'

const { Text } = Typography

interface Props {
  open: boolean
  onClose: () => void
  onSkip?: () => void
}

const SecuritySetupModal: React.FC<Props> = ({ open, onClose, onSkip }) => {
  const { t } = useTranslation('login')
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
      message.error(err?.response?.data?.detail || t('ssSetupFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={
        <span>
          <SafetyCertificateOutlined style={{ marginRight: 8, color: 'var(--primary-color)' }} />
          {configured && !editing ? t('ssTitleView') : t('ssTitleSet')}
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
            title: t('ssSkipTitle'),
            content: t('ssSkipContent'),
            okText: t('ssNotNow'),
            cancelText: t('ssContinueSetup'),
            onOk: () => onSkip(),
          })
        } else {
          onClose()
        }
      }}
      footer={null}
      width={520}
      destroyOnHidden
      mask={{ closable: false }}
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
              {t('ssViewedHint')}
            </Text>
          </div>

          <div style={{
            marginBottom: 12, padding: '14px 18px',
            border: '1px solid var(--border-color)', borderRadius: 10,
          }}>
            <Text style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'block', marginBottom: 4 }}>
              {t('ssQ1')}
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
              {t('ssQ2')}
            </Text>
            <Text strong>
              <QuestionCircleOutlined style={{ marginRight: 8, color: 'var(--primary-color)' }} />
              {currentQ2}
            </Text>
          </div>

          <div style={{ textAlign: 'right' }}>
            <Button style={{ marginRight: 8 }} onClick={onClose}>{t('ssClose')}</Button>
            <Button
              type="primary"
              icon={<EditOutlined />}
              onClick={() => setEditing(true)}
            >
              {t('ssEditBtn')}
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
                ? t('ssEditHint')
                : currentQ1 && !currentQ2
                  ? <Trans i18nKey="ssLegacy1" components={{ 1: <Text strong /> }} />
                  : <Trans i18nKey="ssIntro" components={{ 1: <Text strong /> }} />
              }
            </Text>
          </div>

          <Form form={form} onFinish={handleSubmit} layout="vertical">
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('ssQ1')}</Text>
            <Form.Item
              name="question1"
              rules={[{ required: true, message: t('ssPickQ1') }]}
            >
              <Select
                placeholder={t('ssPickQ1')}
                options={questions.map((q) => ({ label: q, value: q }))}
              />
            </Form.Item>
            <Form.Item
              name="answer1"
              rules={[
                { required: true, message: t('ssAnswerRequired') },
                { min: 2, message: t('ssAnswerMin') },
              ]}
            >
              <Input.Password
                prefix={<QuestionCircleOutlined />}
                placeholder={t('ssAnswerPlaceholder')}
              />
            </Form.Item>

            <Divider style={{ margin: '12px 0' }} />

            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('ssQ2')}</Text>
            <Form.Item
              name="question2"
              rules={[{ required: true, message: t('ssPickQ2') }]}
            >
              <Select
                placeholder={t('ssPickQ2Ph')}
                options={getQuestion2Options()}
              />
            </Form.Item>
            <Form.Item
              name="answer2"
              rules={[
                { required: true, message: t('ssAnswerRequired') },
                { min: 2, message: t('ssAnswerMin') },
              ]}
            >
              <Input.Password
                prefix={<QuestionCircleOutlined />}
                placeholder={t('ssAnswerPlaceholder')}
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
              {onSkip && !configured && (
                <Button style={{ marginRight: 8 }} onClick={onSkip}>
                  {t('ssNotNow')}
                </Button>
              )}
              {editing && configured && (
                <Button style={{ marginRight: 8 }} onClick={() => setEditing(false)}>
                  {t('fpCancel')}
                </Button>
              )}
              {editing && !configured && onSkip && (
                <Button style={{ marginRight: 8 }} onClick={onSkip}>
                  {t('ssNotNow')}
                </Button>
              )}
              <Button type="primary" htmlType="submit" loading={loading}>
                {configured ? t('ssConfirmChange') : t('ssConfirmSet')}
              </Button>
            </Form.Item>
          </Form>
        </>
      )}
    </Modal>
  )
}

export default SecuritySetupModal
