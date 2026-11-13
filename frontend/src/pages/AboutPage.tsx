import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Collapse } from 'antd'
import { message } from '../utils/feedback'
import { InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import PageHeader from '../components/PageHeader'
import { LockOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useIsMobile } from '../hooks/useIsMobile'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'

/**
 * 按「## 二级标题」把 README 切成段（跳过代码围栏里的 ##，那类行是 shell 注释）。
 * 窄屏用它做折叠面板：内容一条不少，但不再是一整屏 3.7 万字的墙。
 */
function splitSections(md: string): { title: string; body: string }[] {
  const lines = String(md || '').split('\n')
  const out: { title: string; body: string }[] = []
  let cur: { title: string; buf: string[] } | null = null
  let inFence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const isH2 = !inFence && /^##\s+/.test(line)
    if (isH2) {
      if (cur) out.push({ title: cur.title, body: cur.buf.join('\n') })
      // 标题保留原文（前面的 emoji 图标在窄屏正好是扫读锚点，不再做剥离）
      cur = { title: line.replace(/^##\s+/, '').trim(), buf: [] }
      continue
    }
    if (!cur) cur = { title: '', buf: [] }
    cur.buf.push(line)
  }
  if (cur) out.push({ title: cur.title, body: cur.buf.join('\n') })
  // 第一段（第一个 ## 之前）没有二级标题，拿它自己的 # 一级标题当面板标题，
  // 实在没有就退回「概览」，避免出现「#1」这种没信息量的标签。
  return out.map((s, i) => ({
    title: s.title || /^#\s+(.+)$/m.exec(s.body)?.[1]?.trim() || `#${i + 1}`,
    body: s.body,
  }))
}

const AboutPage: React.FC = () => {
  const { t, i18n } = useTranslation('system')
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [content, setContent] = useState('')
  const [clickCount, setClickCount] = useState(0)
  const [showEntry, setShowEntry] = useState(false)
  const [openKeys, setOpenKeys] = useState<string[]>(['0', '1'])

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

  const sections = useMemo(() => splitSections(content), [content])
  const allKeys = useMemo(() => sections.map((_, i) => String(i)), [sections])

  /**
   * 目录锚点：README 里两种写法都有 —— 显式 `<a id="intro">` + `[项目简介](#intro)`，
   * 以及 GitHub 给表情标题自动生成的 `#-学习与练习`。两种都要能跳。
   * 窄屏还多一步：目标在折叠着的段里时先全部展开，否则那个元素没有布局、跳了也看不见。
   */
  const navClickRef = useCallback((e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest('a')
    if (!link) return
    const href = link.getAttribute('href') || ''
    if (href.length < 2 || href[0] !== '#') return
    e.preventDefault()
    const raw = href.slice(1)
    const jump = () => {
      const byId = document.getElementById(raw)
      if (byId) { byId.scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
      const name = raw.replace(/^-/, '').replace(/-/g, ' ')
      const host = document.querySelector('.about-body') || document
      const headings = host.querySelectorAll('h1, h2, h3, h4, h5, h6, strong')
      for (const el of headings) {
        if (el.textContent && el.textContent.includes(name)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          break
        }
      }
    }
    if (isMobile) {
      setOpenKeys(allKeys)
      setTimeout(jump, 100)
    } else {
      jump()
    }
  }, [isMobile, allKeys])

  useEffect(() => {
    if (!content) return
    // 窄屏用折叠面板后，一份 markdown 被切成多个 .markdown-content，
    // 只给第一个挂事件会让「目录」里的锚点在其它面板里失效 —— 事件挂到整页容器上。
    const container = document.querySelector('.about-body') || document.querySelector('.markdown-content')
    if (!container) return
    const handler = navClickRef as EventListener
    container.addEventListener('click', handler)
    return () => container.removeEventListener('click', handler)
  }, [content, navClickRef, openKeys])

  const md = (src: string) => (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
        {src}
      </ReactMarkdown>
    </div>
  )

  return (
    <div onClick={handlePageClick} style={{ width: '100%', minHeight: 'calc(100dvh - 160px)' }}>
      <PageHeader
        icon={<InfoCircleOutlined />}
        title={t('about')}
        subtitle={t('aboutSubtitle')}
        extra={(
          <Button icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
            {t('refresh')}
          </Button>
        )}
      />

      {showEntry && (
        <Alert
          type="success"
          icon={<LockOutlined />}
          showIcon
          style={{ marginBottom: 16 }}
          title={
            <span>
              {t('updateAvailable')}
              {/* 作者面板保持桌面专属：窄屏不给入口，避免点了进"请用电脑端"引导页 */}
              {!isMobile && (
                <Button
                  type="link"
                  size="small"
                  onClick={() => navigate('/console')}
                  style={{ marginLeft: 8 }}
                >
                  {t('enter')} →
                </Button>
              )}
            </span>
          }
        />
      )}

      <div className="about-body">
      {isMobile && sections.length > 1 ? (
        /* 窄屏：整份 README（正文 3.7 万字符）平铺成一屏墙，squeeze=10 处表格列塌陷、
           首屏全是散文。这里按「##」分段收进折叠面板，内容一条不减，默认只展开前两段。 */
        <Collapse
          activeKey={openKeys}
          onChange={(k) => setOpenKeys(Array.isArray(k) ? k.map(String) : [String(k)])}
          items={sections.map((s, i) => ({ key: String(i), label: s.title, children: md(s.body) }))}
        />
      ) : (
        md(content)
      )}
      </div>

      <style>{`
        .markdown-content h1 { font-size: 1.5em; margin-top: 1em; }
        .markdown-content h2 { font-size: 1.3em; margin-top: 1em; }
        .markdown-content h3 { font-size: 1.1em; }
        .markdown-content code { background: var(--bg-layout); padding: 2px 4px; border-radius: 3px; }
        .markdown-content pre { background: var(--bg-layout); padding: 12px; border-radius: 6px; overflow-x: auto; }
        .markdown-content table { width: 100%; border-collapse: collapse; margin: 1em 0; }
        .markdown-content th, .markdown-content td { border: 1px solid var(--border-color); padding: 8px 12px; text-align: left; }
        .markdown-content th { background: var(--bg-layout); font-weight: 600; }
        .markdown-content blockquote { border-left: 4px solid var(--primary-color); padding: 8px 16px; margin: 1em 0; background: var(--bg-layout); border-radius: 0 6px 6px 0; }
        /* 暗色主题下不能再出现写死的浅色块（原来 #f5f5f5/#fafafa/#e0e0e0 在深色卡里就是一块白斑） */
      `}</style>
    </div>
  )
}

export default AboutPage
