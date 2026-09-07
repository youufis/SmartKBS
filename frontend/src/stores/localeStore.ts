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

const normalize = (lng?: string): LocaleKey =>
  (lng && lng.toLowerCase().startsWith('en') ? 'en' : 'zh-CN')

export const useLocaleStore = create<LocaleState>()((set) => ({
  // 必须与 i18n 已检测到的语言一致：写死 'zh-CN' 会让英文用户一刷新，
  // 所有 antd 内置文案（Modal 取消/确认、表格空态、分页、日期选择…）退回中文
  current: normalize(i18n.language),
  ready: i18n.isInitialized,

  setLocale: (locale: LocaleKey) => {
    i18n.changeLanguage(locale)
    set({ current: locale })
  },
}))

// i18n 是语言的唯一事实源：持久化恢复或外部 changeLanguage 时同步回 store
i18n.on('languageChanged', (lng) => {
  useLocaleStore.setState({ current: normalize(lng) })
})

// i18n 初始化完成后更新 ready 与语言
i18n.on('initialized', () => {
  useLocaleStore.setState({ ready: true, current: normalize(i18n.language) })
})
