import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ConfigProvider, Spin } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './index.css'
import './styles/theme.css'
import { loadQuestionTypes } from './constants/questionTypes'
import { useThemeStore, initTheme, themeMap } from './stores/themeStore'

// 启动时从后端加载题型配置（使用默认值 fallback，不阻塞渲染）
loadQuestionTypes()

// 初始化主题（从 localStorage 恢复 CSS 变量）
initTheme()

/** 带主题的根组件 */
function ThemedApp() {
  const current = useThemeStore((s) => s.current)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // 每次主题切换时重新渲染 ConfigProvider
    setReady(false)
    const timer = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(timer)
  }, [current])

  const themeConfig = themeMap[current].antdConfig

  return (
    <ConfigProvider
      locale={zhCN}
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
    <ThemedApp />
  </React.StrictMode>,
)
