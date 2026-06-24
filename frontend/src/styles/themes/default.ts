import type { ThemeConfig } from 'antd'
import type { LooseToken } from './index'

/** 默认蓝白主题 — 清爽专业 */
export const defaultTheme: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    colorSuccess: '#52c41a',
    colorWarning: '#faad14',
    colorError: '#ff4d4f',
    colorInfo: '#1677ff',
    borderRadius: 6,
    colorBgLayout: '#f5f5f5',
    colorBgContainer: '#ffffff',
    colorText: '#1f1f1f',
    colorTextSecondary: '#666666',
    colorBorder: '#f0f0f0',
    colorBorderSecondary: '#e8e8e8',
  } as LooseToken,
  components: {
    Layout: {
      headerBg: '#ffffff',
      siderBg: '#ffffff',
      bodyBg: '#f5f5f5',
    },
    Menu: {
      itemBg: '#ffffff',
      itemSelectedBg: '#e6f4ff',
      itemSelectedColor: '#1677ff',
    },
    Card: {
      headerBg: '#ffffff',
    },
  },
}

/** 默认主题 CSS 变量映射（用于非 antd 元素） */
export const defaultCssVars: Record<string, string> = {
  '--bg-layout': '#f5f5f5',
  '--bg-container': '#ffffff',
  '--text-primary': '#1f1f1f',
  '--text-secondary': '#666666',
  '--text-tertiary': '#888888',
  '--border-color': '#f0f0f0',
  '--border-color-secondary': '#e8e8e8',
  '--primary-color': '#1677ff',
  '--primary-color-hover': '#4096ff',
  '--header-shadow': '0 1px 4px rgba(0,0,0,0.05)',
  '--scrollbar-thumb': '#d9d9d9',
  '--scrollbar-thumb-hover': '#bfbfbf',
  '--login-gradient-start': '#667eea',
  '--login-gradient-end': '#764ba2',
  '--footer-text': '#bbb',
  '--success-color': '#52c41a',
  '--warning-color': '#faad14',
  '--error-color': '#ff4d4f',
}
