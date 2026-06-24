import type { ThemeConfig } from 'antd'
import type { LooseToken } from './index'

/** 日落暖橙主题 — 温暖活力 */
export const sunsetTheme: ThemeConfig = {
  token: {
    colorPrimary: '#fa8c16',
    colorSuccess: '#52c41a',
    colorWarning: '#fadb14',
    colorError: '#f5222d',
    colorInfo: '#fa8c16',
    borderRadius: 6,
    colorBgLayout: '#fff7f0',
    colorBgContainer: '#ffffff',
    colorText: '#1f1f1f',
    colorTextSecondary: '#8c6b4a',
    colorBorder: '#ffe0b8',
    colorBorderSecondary: '#ffedd5',
  } as LooseToken,
  components: {
    Layout: {
      headerBg: '#ffffff',
      siderBg: '#fffaf5',
      bodyBg: '#fff7f0',
    },
    Menu: {
      itemBg: '#fffaf5',
      itemSelectedBg: '#fff0e0',
      itemSelectedColor: '#fa8c16',
    },
    Card: {
      headerBg: '#ffffff',
    },
  },
}

export const sunsetCssVars: Record<string, string> = {
  '--bg-layout': '#fff7f0',
  '--bg-container': '#ffffff',
  '--text-primary': '#1f1f1f',
  '--text-secondary': '#8c6b4a',
  '--text-tertiary': '#b8956e',
  '--border-color': '#ffe0b8',
  '--border-color-secondary': '#ffedd5',
  '--primary-color': '#fa8c16',
  '--primary-color-hover': '#ffa940',
  '--header-shadow': '0 1px 4px rgba(250,140,22,0.08)',
  '--scrollbar-thumb': '#f5cba0',
  '--scrollbar-thumb-hover': '#eeb580',
  '--login-gradient-start': '#f093fb',
  '--login-gradient-end': '#f5576c',
  '--footer-text': '#d4a87a',
  '--success-color': '#52c41a',
  '--warning-color': '#fadb14',
  '--error-color': '#f5222d',
}
