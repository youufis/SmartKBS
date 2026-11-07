/**
 * 活动列表通用筛选条（搜索 + 分类 + 学科 + 清除）
 *
 * 同步练习 / 考试中心 / 随堂测验 / 课堂投票 / 抢答竞赛 / 分组讨论 的列表都要
 * "能搜、能分类、能筛学科"，各写一份必然在交互和文案上漂移，所以收在这里。
 * 只负责渲染控件，过滤逻辑由调用方决定（服务端分页的页面自己带参数请求）。
 */
import React from 'react'
import { Button, Input, Segmented, Select } from 'antd'
import { SearchOutlined } from '@ant-design/icons'

export interface FilterOption {
  value: string
  label: React.ReactNode
}

interface Props {
  keyword: string
  onKeyword: (v: string) => void
  searchPlaceholder?: string
  searchWidth?: number
  status?: string
  statusOptions?: FilterOption[]
  onStatus?: (v: string) => void
  subject?: string
  subjectOptions?: FilterOption[]
  onSubject?: (v: string) => void
  /** 学科下拉的空值提示（不传则保持原样：无提示） */
  subjectPlaceholder?: string
  /** 有任一筛选生效时显示「清除筛选」 */
  dirty?: boolean
  onReset?: () => void
  resetLabel?: string
  extra?: React.ReactNode
}

const ListFilterBar: React.FC<Props> = ({
  keyword, onKeyword, searchPlaceholder = '', searchWidth = 220,
  status, statusOptions, onStatus,
  subject, subjectOptions, onSubject, subjectPlaceholder = '',
  dirty = false, onReset, resetLabel = '清除筛选',
  extra,
}) => {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 12 }}>
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder={searchPlaceholder}
        value={keyword}
        style={{ width: searchWidth }}
        onChange={(e) => onKeyword(e.target.value)}
      />
      {!!statusOptions?.length && onStatus && (
        <Segmented
          size="small"
          value={status ?? statusOptions[0]?.value}
          options={statusOptions as { value: string; label: React.ReactNode }[]}
          onChange={(v) => onStatus(String(v))}
        />
      )}
      {!!subjectOptions?.length && onSubject && (
        <Select
          size="small"
          allowClear
          value={subject || undefined}
          placeholder={subjectPlaceholder}
          style={{ width: 130 }}
          options={subjectOptions as { value: string; label: string }[]}
          onChange={(v) => onSubject(v || '')}
        />
      )}
      {dirty && onReset && (
        <Button size="small" onClick={onReset}>{resetLabel}</Button>
      )}
      {extra}
    </div>
  )
}

export default ListFilterBar
