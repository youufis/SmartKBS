import { create } from 'zustand'
import {
  defaultTheme, defaultCssVars,
  forestTheme, forestCssVars,
  sunsetTheme, sunsetCssVars,
  midnightTheme, midnightCssVars,
  lavenderTheme, lavenderCssVars,
} from '../styles/themes'
import type { ThemeConfig } from 'antd'

export type ThemeName = 'default' | 'forest' | 'sunset' | 'midnight' | 'lavender'

export interface ThemeDefinition {
  name: ThemeName
  label: string
  description: string
  icon: string
  antdConfig: ThemeConfig
  cssVars: Record<string, string>
}

export const themeMap: Record<ThemeName, ThemeDefinition> = {
  default: {
    name: 'default',
    label: '默认蓝白',
    description: '清爽专业，经典风格',
    icon: '',
    antdConfig: defaultTheme,
    cssVars: defaultCssVars,
  },
  forest: {
    name: 'forest',
    label: '森林绿意',
    description: '自然护眼，清新舒适',
    icon: '',
    antdConfig: forestTheme,
    cssVars: forestCssVars,
  },
  sunset: {
    name: 'sunset',
    label: '日落暖橙',
    description: '温暖活力，热情洋溢',
    icon: '',
    antdConfig: sunsetTheme,
    cssVars: sunsetCssVars,
  },
  midnight: {
    name: 'midnight',
    label: '暗夜星空',
    description: '深沉专注，保护视力',
    icon: '',
    antdConfig: midnightTheme,
    cssVars: midnightCssVars,
  },
  lavender: {
    name: 'lavender',
    label: '薰衣草紫',
    description: '柔和优雅，浪漫梦幻',
    icon: '',
    antdConfig: lavenderTheme,
    cssVars: lavenderCssVars,
  },
}

/** 将 CSS 变量应用到 document.documentElement */
function applyCssVars(vars: Record<string, string>) {
  const root = document.documentElement
  Object.entries(vars).forEach(([key, value]) => {
    root.style.setProperty(key, value)
  })
}

interface ThemeState {
  /** 当前主题名称 */
  current: ThemeName
  /** 设置主题 */
  setTheme: (name: ThemeName) => void
  /** 获取当前主题的 antd 配置 */
  getThemeConfig: () => ThemeConfig
  /** 获取当前主题定义 */
  getCurrentTheme: () => ThemeDefinition
}

const STORAGE_KEY = 'smartkb_theme'

export const useThemeStore = create<ThemeState>((set, get) => ({
  current: (localStorage.getItem(STORAGE_KEY) as ThemeName) || 'default',

  setTheme: (name: ThemeName) => {
    const theme = themeMap[name]
    if (!theme) return

    localStorage.setItem(STORAGE_KEY, name)
    set({ current: name })
    applyCssVars(theme.cssVars)
  },

  getThemeConfig: () => themeMap[get().current].antdConfig,

  getCurrentTheme: () => themeMap[get().current],
}))

/** 初始化主题（在 main.tsx 中调用） */
export function initTheme() {
  const stored = localStorage.getItem(STORAGE_KEY) as ThemeName | null
  const name = stored && themeMap[stored] ? stored : 'default'
  applyCssVars(themeMap[name].cssVars)
  // 同步 store 状态
  useThemeStore.setState({ current: name })
}
