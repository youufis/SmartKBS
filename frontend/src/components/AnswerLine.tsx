import React from 'react'
import { Tag } from 'antd'

/**
 * 答案行：客观题短答案仍用彩色 Tag，简答/主观题的长答案改为可换行的整段文本。
 * 之前统一塞进 Tag，而 Tag 是 inline-block + white-space:nowrap，
 * 一段几百字的简答题答案会把卡片横向撑破、文字被裁掉看不见。
 */
const LONG = 28

const AnswerLine: React.FC<{
  label?: React.ReactNode
  value?: string | number | null
  color?: string
  style?: React.CSSProperties
}> = ({ label, value, color = 'blue', style }) => {
  const raw = String(value ?? '').trim()
  const text = raw || '-'
  const chipLabel = typeof label === 'string' ? label.replace(/[：:]\s*$/, '') : label
  const isShort = raw.length <= LONG && !raw.includes('\n')

  if (isShort) {
    return (
      <div style={{ marginTop: 4, ...style }}>
        <Tag color={color} style={{ marginInlineEnd: 0, whiteSpace: 'normal', wordBreak: 'break-word' }}>
          {chipLabel ? `${chipLabel}：` : ''}{text}
        </Tag>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', alignItems: 'flex-start', gap: 8, ...style }}>
      {chipLabel ? (
        <Tag color={color} style={{ marginInlineEnd: 0, flexShrink: 0 }}>{chipLabel}</Tag>
      ) : null}
      <div style={{
        flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.7,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere',
      }}>
        {text}
      </div>
    </div>
  )
}

export default AnswerLine
