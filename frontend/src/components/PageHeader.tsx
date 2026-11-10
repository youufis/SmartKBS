/**
 * PageHeader — 全站统一页面头（P0）
 *
 * 之前每个页面各写一套：紫渐变横幅、纯标题、标题与按钮挤一行、甚至没有头部。
 * 这里定死一份规格：左「图标块 + 标题 + 副标题」，右「1 主 + N 次 + 更多」，
 * 下面可接一条工具条（带分隔线），整块只占一层容器、白底细边、不用色块。
 */
import React from 'react'
import { Space } from 'antd'

interface PageHeaderProps {
  icon?: React.ReactNode
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** 右侧操作区：建议 1 颗主按钮 + 最多 2 颗次按钮，其余收进「更多」 */
  extra?: React.ReactNode
  /** 头部下方的工具条（搜索 / 筛选 / 刷新） */
  children?: React.ReactNode
  style?: React.CSSProperties
}

const PageHeader: React.FC<PageHeaderProps> = ({ icon, title, subtitle, extra, children, style }) => (
  <div
    className="page-header"
    style={{
      border: '1px solid var(--border-color)',
      borderRadius: 10,
      background: 'var(--bg-container)',
      marginBottom: 16,
      ...style,
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: '1 1 auto' }}>
        {icon && (
          <span
            style={{
              width: 34, height: 34, flex: '0 0 34px', borderRadius: 9,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: 'var(--primary-color-soft, rgba(22,119,255,0.10))',
              color: 'var(--primary-color)', fontSize: 17,
            }}
          >
            {icon}
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.35, color: 'var(--text-primary)' }}>
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{subtitle}</div>
          )}
        </div>
      </div>
      {extra && (
        <Space wrap size={8} style={{ marginLeft: 'auto' }}>
          {extra}
        </Space>
      )}
    </div>

    {children && (
      <>
        <div style={{ height: 1, background: 'var(--border-color)' }} />
        <div style={{ padding: '10px 16px' }}>{children}</div>
      </>
    )}
  </div>
)

export default PageHeader
