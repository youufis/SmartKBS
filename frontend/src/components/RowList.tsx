/**
 * 轻量行式列表：替代 antd v6 已弃用的 List / List.Item / List.Item.Meta。
 *
 * 尺寸与颜色按 antd 6.4.3 的 list/style 原值对齐，保证从 <List> 换过来视觉不走形：
 *   .ant-list-item            display:flex; align-items:center; justify-content:space-between
 *   .ant-list-item-meta       display:flex; flex:1; align-items:flex-start; max-width:100%
 *   .ant-list-item-meta-avatar  margin-inline-end: token.padding (16)
 *   .ant-list-item-meta-title   margin: 0 0 token.marginXXS (4)
 *   .ant-list-item-meta-description  color: token.colorTextDescription; font-size: token.fontSize
 *   .ant-list-item-action     flex:0 0 auto; margin-inline-start: token.marginXXL (48)
 *   .ant-list-item-action > li  padding: 0 token.paddingXS (8)，首项左内边距 0
 *   .ant-list-item-action-split 1px 宽、colorSplit 的竖分隔线，垂直居中
 *   .ant-list-split .ant-list-item  border-block-end: 1px solid token.colorSplit
 */
import React, { Fragment, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Empty, theme } from 'antd'

interface RowListProps<T> {
  items: T[]
  renderItem: (item: T, index: number) => ReactNode
  /** 行间分隔线，对应 antd List 的 split，默认开启 */
  split?: boolean
  /** 空数据占位；不传则用 antd 简洁空态 */
  empty?: ReactNode
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
  /** 右侧操作区，元素自己带 onClick（行本身可点时记得 stopPropagation） */
  actions?: ReactNode[]
  onClick?: () => void
  onMouseEnter?: (e: MouseEvent<HTMLDivElement>) => void
  onMouseLeave?: (e: MouseEvent<HTMLDivElement>) => void
  /** 对应 antd List 的 size="small"（行内边距 4px 16px） */
  dense?: boolean
  style?: CSSProperties
}

export function RowItem({ avatar, title, description, actions, onClick, onMouseEnter, onMouseLeave, dense, style }: RowItemProps) {
  const { token } = theme.useToken()
  const actionCount = actions?.length ?? 0
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: dense ? '4px 16px' : '8px 0', color: token.colorText, ...style,
      }}
      onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', flex: 1, maxWidth: '100%', minWidth: 0 }}>
        {avatar && (
          <span style={{ flexShrink: 0, marginInlineEnd: token.padding }}>{avatar}</span>
        )}
        <div style={{ flex: '1 0', width: 0, color: token.colorText }}>
          {title && <div style={{ marginBlockEnd: description ? token.marginXXS : 0 }}>{title}</div>}
          {description && (
            <div style={{ color: token.colorTextDescription, fontSize: token.fontSize }}>
              {description}
            </div>
          )}
        </div>
      </div>
      {actionCount > 0 && (
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', flex: '0 0 auto',
            marginInlineStart: token.marginXXL,
          }}
        >
          {actions!.map((a, i) => (
            <Fragment key={i}>
              <span style={{ display: 'inline-flex', alignItems: 'center', paddingInline: i === 0 ? 0 : token.paddingXS }}>
                {a}
              </span>
              {/* antd 的 action 竖分隔线：1px 宽、colorSplit、垂直居中 */}
              {i < actionCount - 1 && (
                <span
                  style={{
                    width: 1, alignSelf: 'center', height: 14,   // antd: lineWidth=1，高度 = fontHeight(22) - 2×marginXXS(4)
                    marginInlineStart: token.paddingXS, background: token.colorSplit,
                  }}
                />
              )}
            </Fragment>
          ))}
        </span>
      )}
    </div>
  )
}
