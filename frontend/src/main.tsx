import React, { useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App as AntdApp, ConfigProvider } from 'antd'
import zhCN, { Locale } from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import AntdFeedbackHolder from './components/AntdFeedbackHolder'
import './i18n'
import './index.css'
import './styles/theme.css'
import './styles/mobile.css'
import { useThemeStore, initTheme, themeMap } from './stores/themeStore'
import { useLocaleStore } from './stores/localeStore'

// tldraw 5.1 的 FontManager 用对象当 AtomMap 的键，React StrictMode 双挂载时，
// 前一个已销毁的编辑器实例会在字体加载回调里抛 "AtomMap: key [object Object] not found"。
// 只脏开发控制台（生产不双挂载，功能也不受影响），这里精确屏蔽这一条，其它报错原样保留，
// 免得真错误被这几十行噪音埋掉。升级 tldraw 后如果不再出现，就把这段删掉。
if (import.meta.env.DEV) {
  const rawError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    if (args.some((a) => typeof a === 'string' && a.includes('AtomMap: key'))) return
    rawError(...args)
  }
  // tldraw 的 zh-cn 语言包缺 page-menu 两个键。翻译是在 fetchTranslation() 里拉取后就告警的，
  // 我们的 overrides（constants/tldrawUiZh.ts）在那之后才合并，补了也压不住这条——
  // 它只在 development 打印，生产构建里根本没有。这里同样只屏蔽这一句，别的一律放行。
  const rawWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    if (args.some((a) => typeof a === 'string' && a.startsWith('Language zh-cn: missing messages for keys'))) return
    rawWarn(...args)
  }
}

// 初始化主题（从 localStorage 恢复 CSS 变量）
initTheme()

/** Ant Design locale 映射 */
const antdLocaleMap: Record<string, Locale> = {
  'zh-CN': zhCN,
  'en': enUS,
}

/** 带主题和语言设置的根组件 */
function ThemedApp() {
  const currentTheme = useThemeStore((s) => s.current)
  const currentLocale = useLocaleStore((s) => s.current)

  const themeConfig = useMemo(() => themeMap[currentTheme].antdConfig, [currentTheme])
  const locale = useMemo(() => antdLocaleMap[currentLocale] || zhCN, [currentLocale])

  return (
    <ConfigProvider
      locale={locale}
      theme={themeConfig}
    >
      <AntdApp>
        <AntdFeedbackHolder />
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemedApp />
    </ErrorBoundary>
  </React.StrictMode>,
)
