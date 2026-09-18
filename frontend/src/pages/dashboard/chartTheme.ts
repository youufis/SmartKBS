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
}

const LIGHT: ChartTheme = {
  isDark: false,
  grid: '#f0f0f0',
  tick: '#8c8c8c',
  tooltipBg: '#fff',
  tooltipBorder: '#f0f0f0',
  empty: '#bfbfbf',
  placeholder: '#e8e8e8',
}

const DARK: ChartTheme = {
  isDark: true,
  grid: '#2e3038',
  tick: '#a6a8b0',
  tooltipBg: '#262830',
  tooltipBorder: '#3a3c44',
  empty: '#6a6c78',
  placeholder: '#2e3038',
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
