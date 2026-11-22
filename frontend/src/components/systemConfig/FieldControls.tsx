/**
 * 系统配置页的专用输入控件。
 *
 * 约定：控件的 value / onChange 只交换「结构化值」（string[] / number[] / string），
 * 与后端存储形态（list / 逗号串）之间的换算统一由页面里的 storage 适配层负责 ——
 * 换控件不改提交类型，这是"改界面不弄坏配置"的前提。
 */
import React, { useMemo, useState } from 'react'
import { AutoComplete, Select } from 'antd'
import { message } from '../../utils/feedback'

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
  /**
   * 「名字即数据主键」的清单用（学科）：值 → 被引用的条数。
   * 大于 0 的项被删掉时按原位置补回去，界面看着像没动，只弹一句为什么 ——
   * 后端同样会整批拒绝，这里只是把报错提前到人能听懂的地方。
   */
  lockedCounts?: Record<string, number>
  /** 单个被拦项的提示模板，填充 {name} 与 {n} */
  lockedHint?: string
  /** 控件下方的只读清单说明，填充 {list} */
  lockedSummary?: string
}> = ({ value, onChange, presets, placeholder, max, normalize, hintInvalid, hintMax,
       lockedCounts, lockedHint, lockedSummary }) => {
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
    // 被移除的"还在被引用"的项：按原位置补回，并说明原因
    if (lockedCounts) {
      const blocked: string[] = []
      list.forEach((name, i) => {
        if ((lockedCounts[name] ?? 0) > 0 && !out.includes(name)) {
          blocked.push(name)
          out.splice(Math.min(i, out.length), 0, name)
        }
      })
      if (blocked.length && lockedHint) {
        message.warning(blocked.map((n) => lockedHint
          .replace('{name}', n)
          .replace('{n}', String(lockedCounts[n] ?? 0))).join('；'))
      }
    }
    if (max && out.length > max) {
      if (hintMax) message.warning(hintMax)
      onChange?.(out.slice(0, max))
      return
    }
    onChange?.(out)
  }

  // 按清单自身的顺序列（学科顺序就是它），而不是后端 GROUP BY 的随机序
  const locked = list
    .filter((name) => (lockedCounts?.[name] ?? 0) > 0)
    .map((name) => `${name}(${lockedCounts?.[name]})`)

  return (
    <>
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
      {locked.length > 0 && lockedSummary && (
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-tertiary, #8c8c8c)' }}>
          {lockedSummary.replace('{list}', locked.join(' · '))}
        </div>
      )}
    </>
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
