/**
 * 年级/班级/角色的输入与展示小件。
 *
 * 教师账号的年级班级是遗留复合字符串，学生是单值；旧列表直接把原始串打进表格，
 * 教师那行显示 "1,2,3|1,2,7,8"，读不出带哪几个班。这里统一解析成 Tag。
 */
import React from 'react'
import { AutoComplete, Select, Tag, Tooltip } from 'antd'
import { ROLE_ADMIN, ROLE_STUDENT, ROLE_TEACHER, splitScope } from './roles'

/** 年级/班级范围标签（教师多年级多班级展平，超量折叠） */
export const ScopeTags: React.FC<{ grade?: string; cls?: string; max?: number }> = ({
  grade, cls, max = 4,
}) => {
  const groups = splitScope(grade, cls)
  if (!groups.length) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
  const items: string[] = []
  groups.forEach(({ grade: g, classes }) => {
    if (!classes.length) items.push(g)
    else classes.forEach(c => items.push(`${g}${c}班`))
  })
  const shown = items.slice(0, max)
  const rest = items.slice(max)
  return (
    <span>
      {shown.map(label => (
        <Tag key={label} style={{ marginInlineEnd: 4, marginBottom: 2 }}>{label}</Tag>
      ))}
      {rest.length > 0 && (
        <Tooltip title={rest.join('、')}>
          <Tag style={{ marginBottom: 2 }}>+{rest.length}</Tag>
        </Tooltip>
      )}
    </span>
  )
}

/** 年级选择：可选已有年级，也允许直接敲新年级（后端会自动建年级） */
export const GradeInput: React.FC<{
  value?: string
  onChange?: (v: string) => void
  options: string[]
  disabled?: boolean
  placeholder?: string
}> = ({ value, onChange, options, disabled, placeholder }) => (
  <AutoComplete
    value={value}
    disabled={disabled}
    onChange={(v) => onChange?.(v)}
    placeholder={placeholder}
    options={options.map(g => ({ value: g, label: g }))}
    filterOption={(input, option) => String(option?.value || '').includes(input)}
    allowClear
  />
)

/** 班级选择：同样支持敲新值；当前值不在选项里时补一条「（当前）」 */
export const ClassInput: React.FC<{
  value?: string
  onChange?: (v: string) => void
  options: Array<{ value: string; label: string }>
  disabled?: boolean
  placeholder?: string
}> = ({ value, onChange, options, disabled, placeholder }) => {
  // 后端 users.class 是 INTEGER 亲和列，学生班级可能回数字 11 而不是 "11"；
  // 不统一成字符串会判定成"当前值不在选项里"，下拉里就会多出一条 "11（当前）" 重复项。
  const current = value === undefined || value === null ? '' : String(value)
  const merged = !current || options.some(o => String(o.value) === current)
    ? options
    : [...options, { value: current, label: `${current}（当前）` }]
  return (
    <AutoComplete
      value={current}
      disabled={disabled}
      onChange={(v) => onChange?.(v)}
      placeholder={placeholder}
      options={merged}
      filterOption={(input, option) => String(option?.value || '').includes(input)}
      allowClear
    />
  )
}

/** 角色下拉：数值进出，避免中文角色名在前后端来回翻译 */
export const RoleSelect: React.FC<{
  value?: number
  onChange?: (v: number) => void
  disabled?: boolean
  style?: React.CSSProperties
}> = ({ value, onChange, disabled, style }) => (
  <Select
    value={value}
    disabled={disabled}
    style={style ?? { width: 140 }}
    onChange={(v) => onChange?.(Number(v))}
    options={[
      { value: ROLE_STUDENT, label: '普通用户' },
      { value: ROLE_TEACHER, label: '教师' },
      { value: ROLE_ADMIN, label: '管理员' },
    ]}
  />
)
