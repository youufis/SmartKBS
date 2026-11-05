/**
 * 系统配置页的专用输入控件。
 *
 * 约定：控件的 value / onChange 只交换「结构化值」（string[] / number[] / string），
 * 与后端存储形态（list / 逗号串）之间的换算统一由页面里的 storage 适配层负责 ——
 * 换控件不改提交类型，这是"改界面不弄坏配置"的前提。
 */
import React, { useMemo, useState } from 'react'
import { AutoComplete, Select, message } from 'antd'

export interface SuggestionOption {
  value: string
  label: string
}

/**
 * 标签式多选：候选可点、可自填、可整段粘贴（逗号/顿号/分号自动切开）。
 * 用于学科、扩展名、IP 名单这类「列表型」配置。
 */
export const TagListInput: React.FC<{
  value?: string[]
  onChange?: (v: string[]) => void
  presets?: string[]
  placeholder?: string
  max?: number
  /** 每项入库前的规范化；返回空串表示丢弃该项（如非法扩展名） */
  normalize?: (raw: string) => string
  hintInvalid?: string
  hintMax?: string
}> = ({ value, onChange, presets, placeholder, max, normalize, hintInvalid, hintMax }) => {
  const list = Array.isArray(value) ? value : []

  const commit = (next: string[]) => {
    const out: string[] = []
    let invalid = false
    for (const raw of next) {
      const one = (normalize ? normalize(String(raw)) : String(raw)).trim()
      if (!one) {
        invalid = true
        continue
      }
      if (!out.includes(one)) out.push(one)
    }
    if (invalid && hintInvalid) message.warning(hintInvalid)
    if (max && out.length > max) {
      if (hintMax) message.warning(hintMax)
      onChange?.(out.slice(0, max))
      return
    }
    onChange?.(out)
  }

  return (
    <Select
      mode="tags"
      value={list}
      onChange={(v) => commit(v as string[])}
      options={(presets || []).map((p) => ({ value: p, label: p }))}
      placeholder={placeholder}
      // 与后端 _validate_config_updates 的分隔符口径一致：支持整段粘贴旧格式
      tokenSeparators={[',', '，', '、', ';', '；']}
      allowClear
    />
  )
}

/**
 * 时长档位多选（分钟）。存的是 "3,4,5" 这种逗号串，这里只处理 number[]。
 */
export const DurationPicker: React.FC<{
  value?: number[]
  onChange?: (v: number[]) => void
  presets?: number[]
  min?: number
  max?: number
  placeholder?: string
  hintInvalid?: string
}> = ({ value, onChange, presets = [3, 4, 5, 10, 15, 20, 30], min = 1, max = 30, placeholder, hintInvalid }) => {
  const list = Array.isArray(value) ? value : []

  const commit = (next: Array<string | number>) => {
    const out: number[] = []
    let invalid = false
    for (const raw of next) {
      const n = Number(String(raw).trim())
      if (!Number.isInteger(n) || n < min || n > max) {
        invalid = true
        continue
      }
      if (!out.includes(n)) out.push(n)
    }
    if (invalid && hintInvalid) message.warning(hintInvalid)
    onChange?.(out.sort((a, b) => a - b))
  }

  return (
    <Select
      mode="tags"
      value={list.map(String)}
      onChange={commit}
      options={presets.map((n) => ({ value: String(n), label: String(n) }))}
      placeholder={placeholder}
      tokenSeparators={[',', '，', ' ', '、']}
      allowClear
    />
  )
}

/**
 * 可手填的下拉（下拉只是候选，清单外的值照样能用）。
 * 自带搜索词状态：同一页面多个实例互不干扰 —— 早先共用一份 state，
 * 在模型框输入关键词会把另一处（生图尺寸）的候选过滤成空。
 */
export const SuggestionInput: React.FC<{
  value?: string
  onChange?: (v: string) => void
  options: SuggestionOption[]
  placeholder?: string
}> = ({ value, onChange, options, placeholder }) => {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(q))
  }, [options, search])

  return (
    <AutoComplete
      value={value}
      onChange={onChange}
      options={filtered}
      placeholder={placeholder}
      // 过滤已在上面的 filtered 里做过，关掉内置过滤（它拿输入框当前值去筛，会把已存值筛成只剩自己）
      filterOption={false}
      onSearch={setSearch}
      onOpenChange={(open) => {
        if (!open) setSearch('')
      }}
    />
  )
}
