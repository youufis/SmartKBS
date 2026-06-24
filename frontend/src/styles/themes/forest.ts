import type { ThemeConfig } from 'antd'
import type { LooseToken } from './index'

/** 森林绿意主题 — 自然护眼 */
export const forestTheme: ThemeConfig = {
  token: {
    colorPrimary: '#389e0d',
    colorSuccess: '#52c41a',
    colorWarning: '#d4b106',
    colorError: '#cf1322',
    colorInfo: '#389e0d',
    borderRadius: 8,
    colorBgLayout: '#f0f7eb',
    colorBgContainer: '#ffffff',
    colorText: '#1f1f1f',
    colorTextSecondary: '#5c6b4d',
    colorBorder: '#d9e6cf',
    colorBorderSecondary: '#e6efde',
  } as LooseToken,
  components: {
    Layout: {
      headerBg: '#ffffff',
      siderBg: '#f8fbf5',
      bodyBg: '#f0f7eb',
    },
    Menu: {
      itemBg: '#f8fbf5',
      itemSelectedBg: '#e6f0db',
      itemSelectedColor: '#389e0d',
    },
    Card: {
      headerBg: '#ffffff',
    },
  },
}

export const forestCssVars: Record<string, string> = {
  '--bg-layout': '#f0f7eb',
  '--bg-container': '#ffffff',
  '--text-primary': '#1f1f1f',
  '--text-secondary': '#5c6b4d',
  '--text-tertiary': '#7a9a6c',
  '--border-color': '#d9e6cf',
  '--border-color-secondary': '#e6efde',
  '--primary-color': '#389e0d',
  '--primary-color-hover': '#52c41a',
  '--header-shadow': '0 1px 4px rgba(56,158,13,0.08)',
  '--scrollbar-thumb': '#b8d9a3',
  '--scrollbar-thumb-hover': '#9cc48a',
  '--login-gradient-start': '#43b97f',
  '--login-gradient-end': '#2d8a4e',
  '--footer-text': '#9ab88e',
  '--success-color': '#52c41a',
  '--warning-color': '#d4b106',
  '--error-color': '#cf1322',
}
