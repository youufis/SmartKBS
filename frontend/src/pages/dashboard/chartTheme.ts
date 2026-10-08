/** 图表主题令牌：跟随 5 套主题（midnight 为深色），替代写死的浅色值 */
import type { CSSProperties } from 'react'
import { useThemeStore } from '../../stores/themeStore'

export interface ChartTheme {
  isDark: boolean
  grid: string
  tick: string
  tooltipBg: string
  tooltipBorder: string
  empty: string
  placeholder: string
  // 批次4：卡片与图表共用一套语义色，深色主题自动提亮
  primary: string
  success: string
  warning: string
  danger: string
  gold: string
  purple: string
  cyan: string
  track: string
}

const LIGHT: ChartTheme = {
  isDark: false,
  grid: '#f0f0f0',
  tick: '#8c8c8c',
  tooltipBg: '#fff',
  tooltipBorder: '#f0f0f0',
  empty: '#bfbfbf',
  placeholder: '#e8e8e8',
  primary: '#1677ff', success: '#52c41a', warning: '#fa8c16', danger: '#ff4d4f',
  gold: '#faad14', purple: '#722ed1', cyan: '#13c2c2', track: '#f0f0f0',
}

const DARK: ChartTheme = {
  isDark: true,
  grid: '#2e3038',
  tick: '#a6a8b0',
  tooltipBg: '#262830',
  tooltipBorder: '#3a3c44',
  empty: '#6a6c78',
  placeholder: '#2e3038',
  primary: '#4096ff', success: '#73d13d', warning: '#ffa940', danger: '#ff7875',
  gold: '#ffc53d', purple: '#9254de', cyan: '#36cfc9', track: 'rgba(255,255,255,0.10)',
}

export function tooltipStyle(ct: ChartTheme): CSSProperties {
  return {
    backgroundColor: ct.tooltipBg,
    border: `1px solid ${ct.tooltipBorder}`,
    borderRadius: 6,
    fontSize: 12,
  }
}

export function useChartTheme(): ChartTheme {
  const current = useThemeStore((s) => s.current)
  return current === 'midnight' ? DARK : LIGHT
}
