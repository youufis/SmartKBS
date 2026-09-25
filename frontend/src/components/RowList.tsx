/**
 * 轻量行式列表：替代 antd v6 已弃用的 List / List.Item / List.Item.Meta。
 *
 * 只做三件事：行间分隔线、左中右三段布局（图标 · 主内容 · 操作区）、空态。
 * 不再引入 antd List 那层 DOM 与样式继承，颜色一律走主题令牌，暗夜星空可用。
 */
import React, { Fragment, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Empty, theme } from 'antd'

interface RowListProps<T> {
  items: T[]
  renderItem: (item: T, index: number) => ReactNode
  /** 行与行之间的分隔线，默认开启 */
  split?: boolean
  /** 空数据时的占位；不传则用 antd 简洁空态 */
  empty?: ReactNode
  /** 整块容器的样式（例如外层限高滚动） */
  style?: CSSProperties
}

export function RowList<T>({ items, renderItem, split = true, empty, style }: RowListProps<T>) {
  const { token } = theme.useToken()
  if (!items.length) {
    return <>{empty ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}</>
  }
  return (
    <div style={style}>
      {items.map((item, i) => (
        <Fragment key={i}>
          {renderItem(item, i)}
          {split && i < items.length - 1 && (
            <div style={{ height: 1, background: token.colorSplit }} />
          )}
        </Fragment>
      ))}
    </div>
  )
}

interface RowItemProps {
  avatar?: ReactNode
  title?: ReactNode
  description?: ReactNode
  /** 右侧操作区，元素自己带 onClick（记得 stopPropagation，行本身可能可点） */
  actions?: ReactNode[]
  onClick?: () => void
  onMouseEnter?: (e: MouseEvent<HTMLDivElement>) => void
  onMouseLeave?: (e: MouseEvent<HTMLDivElement>) => void
  style?: CSSProperties
}

export function RowItem({ avatar, title, description, actions, onClick, onMouseEnter, onMouseLeave, style }: RowItemProps) {
  const { token } = theme.useToken()
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '8px 12px', ...style,
      }}
      onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flex: 1, minWidth: 0 }}>
        {avatar && <span style={{ flexShrink: 0, lineHeight: '22px' }}>{avatar}</span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          {title && <div style={{ marginBottom: description ? 2 : 0 }}>{title}</div>}
          {description && <div style={{ color: token.colorTextDescription }}>{description}</div>}
        </div>
      </div>
      {actions && actions.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {actions.map((a, i) => <Fragment key={i}>{a}</Fragment>)}
        </span>
      )}
    </div>
  )
}
