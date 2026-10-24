import React from 'react'
import { Typography } from 'antd'

const { Text } = Typography

/**
 * 积分单元格：正数显示 +N（绿/蓝），负数显示 -N（红）。
 *
 * 各明细表以前各自写 `+{p}`，遇到扣分/积分消费这类负数就渲染成 "+-100"，
 * 家长读成"被罚 100 分还倒贴"。统一到这一个组件，颜色与符号只有一份定义。
 */
export const PointsCell: React.FC<{ points: number; fontSize?: number }> = ({ points, fontSize = 15 }) => {
  const n = Number(points) || 0
  if (n < 0) {
    return <Text strong style={{ color: '#ff4d4f', fontSize }}>{'-'}{Math.abs(n)}</Text>
  }
  return (
    <Text strong style={{ color: n > 2 ? '#52c41a' : '#1677ff', fontSize }}>
      {'+'}{n}
    </Text>
  )
}

export default PointsCell
