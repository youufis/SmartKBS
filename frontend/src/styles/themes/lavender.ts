import type { ThemeConfig } from 'antd'
import type { LooseToken } from './index'

/** 薰衣草紫主题 — 柔和优雅 */
export const lavenderTheme: ThemeConfig = {
  token: {
    colorPrimary: '#722ed1',
    colorSuccess: '#52c41a',
    colorWarning: '#faad14',
    colorError: '#ff4d4f',
    colorInfo: '#722ed1',
    borderRadius: 8,
    colorBgLayout: '#f9f0ff',
    colorBgContainer: '#ffffff',
    colorText: '#1f1f1f',
    colorTextSecondary: '#6b4f8c',
    colorBorder: '#e8d9f5',
    colorBorderSecondary: '#f0e6fa',
  } as LooseToken,
  components: {
    Layout: {
      headerBg: '#ffffff',
      siderBg: '#faf5ff',
      bodyBg: '#f9f0ff',
    },
    Menu: {
      itemBg: '#faf5ff',
      itemSelectedBg: '#efe0ff',
      itemSelectedColor: '#722ed1',
    },
    Card: {
      headerBg: '#ffffff',
    },
  },
}

export const lavenderCssVars: Record<string, string> = {
  '--bg-layout': '#f9f0ff',
  '--bg-container': '#ffffff',
  '--text-primary': '#1f1f1f',
  '--text-secondary': '#6b4f8c',
  '--text-tertiary': '#9a7fb8',
  '--border-color': '#e8d9f5',
  '--border-color-secondary': '#f0e6fa',
  '--primary-color': '#722ed1',
  '--primary-color-hover': '#9254de',
  '--header-shadow': '0 1px 4px rgba(114,46,209,0.08)',
  '--scrollbar-thumb': '#d4bfe8',
  '--scrollbar-thumb-hover': '#c4a8de',
  '--login-gradient-start': '#a18cd1',
  '--login-gradient-end': '#fbc2eb',
  '--footer-text': '#b8a0cc',
  '--success-color': '#52c41a',
  '--warning-color': '#faad14',
  '--error-color': '#ff4d4f',
}
