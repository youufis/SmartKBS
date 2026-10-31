/**
 * 带滚动动画的统计数字
 *
 * 首屏数字原来是"瞬间跳变"，看不出变化来自哪里。这里给 antd Statistic 接上补间：
 * 数值从 0 滚到目标值，系统开启"减弱动态效果"时直接显示终值。
 * 补间逻辑本身在 useCountUp.ts（单独成文件，避免组件模块导出非组件触发 react-refresh 规则）。
 */
import React from 'react'
import { Statistic } from 'antd'
import { useCountUp } from './useCountUp'

const CountValue: React.FC<{ value: number }> = ({ value }) => {
  const shown = useCountUp(value)
  return <>{Math.round(shown).toLocaleString()}</>
}

/** 与 antd Statistic 同 props，只是数字带补间 */
export const DashStat: React.FC<React.ComponentProps<typeof Statistic>> = ({ value, ...rest }) => {
  const n = Number(value ?? 0)
  return <Statistic {...rest} value={n} formatter={() => <CountValue value={n} />} />
}

export default DashStat
