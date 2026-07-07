import React, { useEffect, useState, useMemo } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, Spin } from 'antd'
import zhCN, { Locale } from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './i18n'
import './index.css'
import './styles/theme.css'
import { loadQuestionTypes } from './constants/questionTypes'
import { useThemeStore, initTheme, themeMap } from './stores/themeStore'
import { useLocaleStore } from './stores/localeStore'

// 启动时从后端加载题型配置（使用默认值 fallback，不阻塞渲染）
loadQuestionTypes()

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
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // 每次主题或语言切换时重新渲染 ConfigProvider
    setReady(false)
    const timer = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(timer)
  }, [currentTheme, currentLocale])

  const themeConfig = useMemo(() => themeMap[currentTheme].antdConfig, [currentTheme])
  const locale = useMemo(() => antdLocaleMap[currentLocale] || zhCN, [currentLocale])

  return (
    <ConfigProvider
      locale={locale}
      theme={themeConfig}
    >
      <BrowserRouter>
        {ready ? <App /> : <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}><Spin size="large" /></div>}
      </BrowserRouter>
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
