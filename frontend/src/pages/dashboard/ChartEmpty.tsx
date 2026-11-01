/**
 * 图表卡统一空态。
 *
 * 之前五张卡各写一份空态：有的 padding 56px、有的 34px、有的 flex 居中，
 * 结果同一行里卡片高度一变，空态文字就贴在上半部分或者沉到底部。
 * 这里统一成「撑满剩余空间 + 垂直居中」，卡片被同行更高的卡撑高时也居中。
 *
 * `action` 是可选的下一步出口：只写「暂无数据」等于把「怎么才会有数据」甩给用户自己猜。
 */
import React from 'react'
import { Button } from 'antd'
import { useChartTheme } from './chartTheme'

interface Props {
  text: string
  hint?: string
  action?: { label: string; onClick: () => void }
}

const ChartEmpty: React.FC<Props> = ({ text, hint, action }) => {
  const ct = useChartTheme()
  return (
    <div
      style={{
        flex: 1,
        minHeight: 120,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        padding: '16px 12px',
        textAlign: 'center',
        color: ct.empty,
        fontSize: 12,
      }}
    >
      <div>{text}</div>
      {hint && <div>{hint}</div>}
      {action && (
        <Button size="small" type="link" style={{ fontSize: 12, marginTop: 4 }} onClick={action.onClick}>
          {action.label} →
        </Button>
      )}
    </div>
  )
}

export default ChartEmpty
