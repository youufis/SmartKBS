import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Typography, Alert, Button, message } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
const AboutPage: React.FC = () => {
  const { t, i18n } = useTranslation('system')
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [clickCount, setClickCount] = useState(0)
  const [showEntry, setShowEntry] = useState(false)

  const handlePageClick = () => {
    const newCount = clickCount + 1
    setClickCount(newCount)
    if (newCount >= 10) {
      setClickCount(0)
      setShowEntry(true)
      message.success(t('unlocked'))
      return
    }
    clearTimeout((window as any).__aboutTimer)
    ;(window as any).__aboutTimer = setTimeout(() => setClickCount(0), 3000)
  }

  // 根据当前语言加载对应版本的 README
  const loadReadme = useCallback(async () => {
    const isEn = i18n.language?.startsWith('en')
    const file = isEn ? '/api/files/README.en.md' : '/api/files/README.md'
    try {
      const res = await fetch(file)
      const text = await res.text()
      setContent(text)
    } catch {
      setContent('# About & Help\n\nFailed to load help documentation.')
    }
  }, [i18n.language])

  useEffect(() => {
    loadReadme()
  }, [loadReadme])

  // 导航锚点点击处理：提取中文名称，滚动到对应标题
  const navClickRef = useCallback((e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    const href = link.getAttribute('href')
    if (!href || !href.startsWith('#-')) return
    e.preventDefault()
    const name = href.replace('#-', '')
    const container = document.querySelector('.markdown-content')
    if (!container) return
    const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6, strong')
    for (const el of headings) {
      if (el.textContent?.includes(name)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        break
      }
    }
  }, [])

  useEffect(() => {
    if (!content) return
    const container = document.querySelector('.markdown-content')
    if (!container) return
    const handler = navClickRef as EventListener
    container.addEventListener('click', handler)
    return () => container.removeEventListener('click', handler)
  }, [content, navClickRef])

  return (
    <div onClick={handlePageClick} style={{
      width: '100%', padding: 24,
      background: '#fff', borderRadius: 8, minHeight: 'calc(100vh - 160px)',
    }}>
      <Typography.Title level={3} style={{ userSelect: 'none' }}>
        ℹ️ {t('about')}
      </Typography.Title>

      {showEntry && (
        <Alert
          type="success"
          icon={<LockOutlined />}
          showIcon
          style={{ marginBottom: 16 }}
          message={
            <span>
              {t('updateAvailable')}
              <Button
                type="link"
                size="small"
                onClick={() => navigate('/console')}
                style={{ marginLeft: 8 }}
              >
                {t('enter')} →
              </Button>
            </span>
          }
        />
      )}

      <div className="markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
          {content}
        </ReactMarkdown>
      </div>
      <style>{`
        .markdown-content h1 { font-size: 1.5em; margin-top: 1em; }
        .markdown-content h2 { font-size: 1.3em; margin-top: 1em; }
        .markdown-content h3 { font-size: 1.1em; }
        .markdown-content code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; }
        .markdown-content pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
        .markdown-content table { width: 100%; border-collapse: collapse; margin: 1em 0; }
        .markdown-content th, .markdown-content td { border: 1px solid #e0e0e0; padding: 8px 12px; text-align: left; }
        .markdown-content th { background: #fafafa; font-weight: 600; }
        .markdown-content tr:nth-child(even) { background: #fafafa; }
        .markdown-content blockquote { border-left: 4px solid #1677ff; padding: 8px 16px; margin: 1em 0; background: #f0f5ff; border-radius: 0 6px 6px 0; }
      `}</style>
    </div>
  )
}

export default AboutPage
