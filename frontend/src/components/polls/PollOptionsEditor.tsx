/**
 * 投票选项编辑器：可逐行增删、去重、带上下限提示。
 *
 * 取代原来的「一个 TextArea 每行一条」：那种写法既不能删单行，也不会告诉你
 * 第 3 行和第 5 行重复了，选项数量上限更是完全看不出来。
 */
import React from 'react'
import { Button, Input, Space, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'

export const POLL_OPTION_MIN = 2
export const POLL_OPTION_MAX = 10

interface Props {
  value?: string[]
  onChange?: (next: string[]) => void
  min?: number
  max?: number
  /** 第 index 行占位提示 */
  placeholder?: (index: number) => string
  disabled?: boolean
}

const PollOptionsEditor: React.FC<Props> = ({
  value = [], onChange, min = POLL_OPTION_MIN, max = POLL_OPTION_MAX, placeholder, disabled,
}) => {
  const list = value.length ? value : ['', '']
  const commit = (next: string[]) => onChange?.(next)

  const update = (index: number, text: string) => {
    const next = [...list]
    next[index] = text
    commit(next)
  }

  const remove = (index: number) => {
    if (list.length <= min) return
    commit(list.filter((_, i) => i !== index))
  }

  const add = () => {
    if (list.length >= max) return
    commit([...list, ''])
  }

  const trimmed = list.map(t => t.trim())
  const duplicated = trimmed.some((t, i) => t && trimmed.indexOf(t) !== i)
  const filled = trimmed.filter(Boolean).length

  return (
    <div>
      <Space orientation="vertical" style={{ width: '100%' }} size={8}>
        {list.map((text, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{
              width: 22, height: 22, flex: '0 0 22px', borderRadius: 11, textAlign: 'center',
              lineHeight: '22px', fontSize: 12, color: 'var(--text-secondary)',
              background: 'var(--bg-layout)',
            }}>{i + 1}</span>
            <Input
              value={text}
              disabled={disabled}
              maxLength={200}
              placeholder={placeholder ? placeholder(i) : `选项 ${i + 1}`}
              onChange={e => update(i, e.target.value)}
            />
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              disabled={disabled || list.length <= min}
              onClick={() => remove(i)}
              aria-label="删除该选项"
            />
          </div>
        ))}
      </Space>
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button size="small" icon={<PlusOutlined />} onClick={add} disabled={disabled || list.length >= max}>
          添加选项
        </Button>
        <Typography.Text type={duplicated ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
          {duplicated ? '有重复选项，保存前请改掉' : `${filled} / ${max}（至少 ${min} 个）`}
        </Typography.Text>
      </div>
    </div>
  )
}

export default PollOptionsEditor
