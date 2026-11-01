import React from 'react'
import { Spin } from 'antd'
import {
  ClockCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons'

/** 提交状态 → 文案 key / 颜色 / 图标（列表、结果页、教师统计共用） */
export const STATUS_MAP: Record<string, { labelKey: string; color: string; icon: React.ReactNode }> = {
  pending:       { labelKey: 'statusPending', color: 'default', icon: <ClockCircleOutlined /> },
  running:       { labelKey: 'statusRunning', color: 'processing', icon: <Spin size="small" /> },
  accepted:      { labelKey: 'statusAccepted', color: 'success', icon: <CheckCircleOutlined /> },
  wrong_answer:  { labelKey: 'statusWrongAnswer', color: 'error', icon: <CloseCircleOutlined /> },
  runtime_error: { labelKey: 'statusRuntimeError', color: 'error', icon: <CloseCircleOutlined /> },
  time_limit:    { labelKey: 'statusTimeLimit', color: 'warning', icon: <ClockCircleOutlined /> },
  compile_error: { labelKey: 'statusCompileError', color: 'error', icon: <CloseCircleOutlined /> },
  failed:        { labelKey: 'statusFailed', color: 'default', icon: <CloseCircleOutlined /> },
}

export const TERMINAL_STATUSES = [
  'accepted', 'wrong_answer', 'runtime_error', 'time_limit', 'compile_error', 'failed',
]

export const isTerminalStatus = (status: string) => TERMINAL_STATUSES.includes(status)

/** 状态颜色是否是「成功」语义（暗色主题下用 token 会更好，但这里只要一个布尔） */
export const isSuccessStatus = (status?: string) => status === 'accepted'


export interface EditableTestCase {
  input: string
  expected: string
  description: string
  score: number
  is_sample: boolean
}

export const emptyTestCase = (isSample = false): EditableTestCase => ({
  input: '',
  expected: '',
  description: '',
  score: 1,
  is_sample: isSample,
})
