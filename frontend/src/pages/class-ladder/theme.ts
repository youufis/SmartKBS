import { theme as antdTheme } from 'antd'
import type { ThemeConfig } from 'antd'
import { SKIN_ACCENT } from './constants'
import type { LooseToken } from '../../styles/themes'

/**
 * 局部 antd 主题：跟随皮肤明暗，而不是全局主题。
 * 修复「深色皮肤 + 浅色全局主题（或反之）时，页面里 antd 按钮/文字/空状态不可见」。
 */
export function buildLadderTheme(mode: 'light' | 'dark', activeSkin: string): ThemeConfig {
  const accent = SKIN_ACCENT[activeSkin] || '#4f8cff'
  if (mode === 'dark') {
    return {
      // v6 嵌套主题默认继承父级 token，必须关掉，否则全局深色主题的
      // colorBgContainer 等会漏进浅色皮肤（反之亦然）
      inherit: false,
      algorithm: antdTheme.darkAlgorithm,
      token: {
        colorPrimary: accent,
        colorBgContainer: '#141b3a',
        colorBgElevated: '#101731',
        colorText: '#eaf2ff',
        colorTextSecondary: '#9fb3d9',
        colorBorder: 'rgba(255,255,255,0.30)',
        colorBorderSecondary: 'rgba(255,255,255,0.16)',
        borderRadius: 8,
      } as LooseToken,
      components: {
        Button: {
          defaultBg: 'rgba(255,255,255,0.07)',
          defaultBorderColor: 'rgba(255,255,255,0.30)',
          defaultHoverBg: 'rgba(255,255,255,0.12)',
          defaultHoverColor: '#ffffff',
          defaultHoverBorderColor: accent,
        },
      },
    }
  }
  return {
    inherit: false,
    algorithm: antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: accent,
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorText: '#1b2440',
      colorTextSecondary: '#5c6b8a',
      colorBorder: '#c9d4e4',
      colorBorderSecondary: '#e6ecf4',
      borderRadius: 8,
    } as LooseToken,
  }
}
