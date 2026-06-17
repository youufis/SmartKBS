import React, { useState, useEffect } from 'react'
import { Typography, Alert, Button, message } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const AboutPage: React.FC = () => {
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
      message.success('🔓 已解锁')
      return
    }
    clearTimeout((window as any).__aboutTimer)
    ;(window as any).__aboutTimer = setTimeout(() => setClickCount(0), 3000)
  }

  useEffect(() => {
    fetch('/api/files/USER_MANUAL.md')
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent('# 关于与帮助\n\n系统帮助文档加载失败。'))
  }, [])

  return (
    <div onClick={handlePageClick} style={{
      width: '100%', padding: 24,
      background: '#fff', borderRadius: 8, minHeight: 'calc(100vh - 160px)',
    }}>
      <Typography.Title level={3} style={{ userSelect: 'none' }}>
        ℹ️ 关于与帮助
        <Typography.Text
          type="secondary"
          style={{ fontSize: 14, marginLeft: 12 }}
        >
          v5.6.0
        </Typography.Text>
      </Typography.Title>

      {showEntry && (
        <Alert
          type="success"
          icon={<LockOutlined />}
          showIcon
          style={{ marginBottom: 16 }}
          message={
            <span>
              已解锁！
              <Button
                type="link"
                size="small"
                onClick={() => navigate('/console')}
                style={{ marginLeft: 8 }}
              >
                进入 →
              </Button>
            </span>
          }
        />
      )}

      <div className="markdown-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
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
