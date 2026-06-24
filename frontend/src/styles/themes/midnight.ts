import type { ThemeConfig } from 'antd'
import type { LooseToken } from './index'

/** 暗夜星空主题 — 深沉专注 */
export const midnightTheme: ThemeConfig = {
  token: {
    colorPrimary: '#4f8cff',
    colorSuccess: '#49aa19',
    colorWarning: '#d89614',
    colorError: '#dc4446',
    colorInfo: '#4f8cff',
    borderRadius: 6,
    colorBgLayout: '#0f1217',
    colorBgContainer: '#1c1e26',
    colorBgElevated: '#262830',
    colorText: '#e8e8e8',
    colorTextSecondary: '#a6a8b0',
    colorBorder: '#2e3038',
    colorBorderSecondary: '#3a3c44',
  } as LooseToken,
  components: {
    Layout: {
      headerBg: '#1c1e26',
      siderBg: '#16181f',
      bodyBg: '#0f1217',
    },
    Menu: {
      itemBg: '#16181f',
      itemSelectedBg: '#1e2540',
      itemSelectedColor: '#4f8cff',
      itemColor: '#a6a8b0',
      itemHoverBg: '#1e1f28',
      itemHoverColor: '#e8e8e8',
    },
    Card: {
      headerBg: '#1c1e26',
      colorBgContainer: '#1c1e26',
    },
    Table: {
      headerBg: '#1c1e26',
      borderColor: '#2e3038',
      colorBgContainer: '#1c1e26',
    },
    Modal: {
      contentBg: '#1c1e26',
      headerBg: '#1c1e26',
    },
    Notification: {
      colorBgElevated: '#262830',
    },
  },
}

export const midnightCssVars: Record<string, string> = {
  '--bg-layout': '#0f1217',
  '--bg-container': '#1c1e26',
  '--text-primary': '#e8e8e8',
  '--text-secondary': '#a6a8b0',
  '--text-tertiary': '#6a6c78',
  '--border-color': '#2e3038',
  '--border-color-secondary': '#3a3c44',
  '--primary-color': '#4f8cff',
  '--primary-color-hover': '#7aa5ff',
  '--header-shadow': '0 1px 4px rgba(0,0,0,0.2)',
  '--scrollbar-thumb': '#3a3c44',
  '--scrollbar-thumb-hover': '#4a4c56',
  '--login-gradient-start': '#0f0c29',
  '--login-gradient-end': '#302b63',
  '--footer-text': '#4a4c56',
  '--success-color': '#49aa19',
  '--warning-color': '#d89614',
  '--error-color': '#dc4446',
}
