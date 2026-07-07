/**
 * 语言偏好状态管理 (Zustand)
 * - 与 i18next 保持同步
 * - 语言切换时同时更新 Ant Design locale
 */
import { create } from 'zustand'
import i18n from '../i18n'

/** 支持的语言列表 */
export const SUPPORTED_LOCALES = [
  { key: 'zh-CN', label: '中文', antdLocale: 'zhCN' },
  { key: 'en', label: 'English', antdLocale: 'enUS' },
] as const

export type LocaleKey = (typeof SUPPORTED_LOCALES)[number]['key']

interface LocaleState {
  /** 当前语言代码 */
  current: LocaleKey
  /** 初始化状态 */
  ready: boolean
  /** 切换语言 */
  setLocale: (locale: LocaleKey) => void
}

export const useLocaleStore = create<LocaleState>()((set) => ({
  current: 'zh-CN' as LocaleKey,
  ready: i18n.isInitialized,

  setLocale: (locale: LocaleKey) => {
    i18n.changeLanguage(locale)
    set({ current: locale })
  },
}))

// i18n 初始化完成后更新 ready 状态
i18n.on('initialized', () => {
  useLocaleStore.setState({ ready: true })
})
