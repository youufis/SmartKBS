/**
 * AI 白板助手进度模态框
 * 在 AI 生成内容时显示实时进度、耗时和取消功能，替代静默的 message.loading()
 */
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Modal, Button, Typography, Space, Progress, Spin } from 'antd'
import { CloseOutlined, StopOutlined, LoadingOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'

const { Text } = Typography

export type ProgressStatus = 'running' | 'success' | 'error'

export interface ProgressStep {
  key: string
  label: string
  status: 'pending' | 'active' | 'done' | 'error'
}

interface Props {
  open: boolean
  title: string
  steps: ProgressStep[]
  currentMessage?: string
  status: ProgressStatus
  errorMessage?: string
  elapsed: number  // seconds
  onCancel: () => void
  onClose: () => void
}

const ProgressModal: React.FC<Props> = ({
  open,
  title,
  steps,
  currentMessage,
  status,
  errorMessage,
  elapsed,
  onCancel,
  onClose,
}) => {
  const doneSteps = steps.filter(s => s.status === 'done').length
  const totalSteps = steps.length
  const percent = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0

  // 格式化时间
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  }

  return (
    <Modal
      open={open}
      title={
        <Space>
          {status === 'running' ? <LoadingOutlined style={{ color: '#1890ff' }} /> : null}
          {status === 'success' ? <CheckCircleOutlined style={{ color: '#52c41a' }} /> : null}
          {status === 'error' ? <WarningOutlined style={{ color: '#ff4d4f' }} /> : null}
          <Text strong>{title}</Text>
        </Space>
      }
      footer={
        status === 'running' ? (
          <Button danger icon={<StopOutlined />} onClick={onCancel}>
            取消生成
          </Button>
        ) : (
          <Button type="primary" onClick={onClose}>
            {status === 'success' ? '完成' : '关闭'}
          </Button>
        )
      }
      closable={status !== 'running'}
      onCancel={status === 'running' ? undefined : onClose}
      maskClosable={false}
      width={440}
      destroyOnClose
    >
      <div style={{ padding: '8px 0' }}>
        {/* 总进度条 */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>总体进度</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {formatTime(elapsed)}
              {status === 'running' && <Spin size="small" style={{ marginLeft: 8 }} />}
            </Text>
          </div>
          <Progress
            percent={percent}
            status={status === 'error' ? 'exception' : status === 'success' ? 'success' : 'active'}
            strokeColor={status === 'running' ? '#1890ff' : undefined}
            size="small"
          />
        </div>

        {/* 当前状态消息 */}
        {status === 'running' && currentMessage && (
          <div
            style={{
              padding: '8px 12px',
              background: '#e6f7ff',
              borderRadius: 6,
              marginBottom: 12,
              fontSize: 13,
              color: '#1890ff',
              lineHeight: 1.5,
              border: '1px solid #91d5ff',
            }}
          >
            <LoadingOutlined style={{ marginRight: 6 }} />
            {currentMessage}
          </div>
        )}

        {/* 错误消息 */}
        {status === 'error' && errorMessage && (
          <div
            style={{
              padding: '8px 12px',
              background: '#fff2f0',
              borderRadius: 6,
              marginBottom: 12,
              fontSize: 13,
              color: '#ff4d4f',
              lineHeight: 1.5,
              border: '1px solid #ffccc7',
            }}
          >
            <WarningOutlined style={{ marginRight: 6 }} />
            {errorMessage}
          </div>
        )}

        {/* 步骤列表 */}
        <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, overflow: 'hidden' }}>
          {steps.map((step, i) => (
            <div
              key={step.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                borderBottom: i < steps.length - 1 ? '1px solid #f5f5f5' : 'none',
                background: step.status === 'active' ? '#f0f5ff' : 'transparent',
              }}
            >
              {/* 状态图标 */}
              <div style={{ width: 20, marginRight: 10, textAlign: 'center' }}>
                {step.status === 'pending' && (
                  <span style={{ width: 16, height: 16, display: 'inline-block', borderRadius: '50%', border: '2px solid #d9d9d9' }} />
                )}
                {step.status === 'active' && (
                  <Spin size="small" />
                )}
                {step.status === 'done' && (
                  <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 16 }} />
                )}
                {step.status === 'error' && (
                  <CloseOutlined style={{ color: '#ff4d4f', fontSize: 16 }} />
                )}
              </div>
              {/* 步骤名 */}
              <Text
                style={{
                  fontSize: 13,
                  color: step.status === 'pending' ? '#bbb' : step.status === 'active' ? '#1890ff' : '#333',
                  fontWeight: step.status === 'active' ? 500 : 400,
                }}
              >
                {step.label}
              </Text>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/**
 * 使用进度模态框的 Hook
 */
export function useProgressModal() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [steps, setSteps] = useState<ProgressStep[]>([])
  const [currentMessage, setCurrentMessage] = useState<string | undefined>()
  const [status, setStatus] = useState<ProgressStatus>('running')
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)

  // 启动模态框
  const startProgress = useCallback((opts: {
    title: string
    steps: ProgressStep[]
    onCancel: () => void
  }) => {
    setTitle(opts.title)
    setSteps(opts.steps)
    setCurrentMessage(undefined)
    setStatus('running')
    setErrorMessage(undefined)
    setElapsed(0)
    setOpen(true)
    cancelRef.current = opts.onCancel

    // 启动计时器
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setElapsed(prev => prev + 1)
    }, 1000)
  }, [])

  // 更新步骤状态
  const updateStep = useCallback((key: string, stepStatus: ProgressStep['status']) => {
    setSteps(prev => prev.map(s => s.key === key ? { ...s, status: stepStatus } : s))
  }, [])

  // 设置当前消息
  const updateMessage = useCallback((message: string) => {
    setCurrentMessage(message)
  }, [])

  // 标记成功
  const markSuccess = useCallback(() => {
    setStatus('success')
    setCurrentMessage(undefined)
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 标记失败
  const markError = useCallback((msg: string) => {
    setStatus('error')
    setErrorMessage(msg)
    setCurrentMessage(undefined)
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 关闭
  const close = useCallback(() => {
    setOpen(false)
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    cancelRef.current = null
  }, [])

  // 取消（调用外部取消逻辑）
  const handleCancel = useCallback(() => {
    cancelRef.current?.()
    setStatus('error')
    setErrorMessage('用户已取消操作')
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 清理
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const modal = (
    <ProgressModal
      open={open}
      title={title}
      steps={steps}
      currentMessage={currentMessage}
      status={status}
      errorMessage={errorMessage}
      elapsed={elapsed}
      onCancel={handleCancel}
      onClose={close}
    />
  )

  return {
    modal,
    startProgress,
    updateStep,
    updateMessage,
    markSuccess,
    markError,
    close,
    isRunning: status === 'running',
  }
}

export default ProgressModal
