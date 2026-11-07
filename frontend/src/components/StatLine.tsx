/**
 * StatLine — 一行统计文字
 *
 * 用来替掉「四张孤立的小卡片」那种排法：一行内 label + 数值，可点筛选，
 * 当前项用品牌色标出。宽度自适应，窄屏自动换行。
 */
import React from 'react'

export interface StatItem {
  key: string
  label: string
  value: React.ReactNode
  active?: boolean
  onClick?: () => void
}

interface Props {
  items: StatItem[]
  style?: React.CSSProperties
}

const StatLine: React.FC<Props> = ({ items, style }) => (
  <div
    style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'baseline',
      gap: '4px 20px', marginBottom: 12, fontSize: 13, ...style,
    }}
  >
    {items.map(it => (
      <button
        key={it.key}
        type="button"
        onClick={it.onClick}
        style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 6,
          border: 'none', background: 'none', padding: 0,
          cursor: it.onClick ? 'pointer' : 'default',
        }}
      >
        <span style={{ color: it.active ? 'var(--primary-color)' : 'var(--text-secondary)' }}>
          {it.label}
        </span>
        <b style={{
          fontSize: 15, fontWeight: 600,
          color: it.active ? 'var(--primary-color)' : 'var(--text-primary)',
        }}>{it.value}</b>
      </button>
    ))}
  </div>
)

export default StatLine
