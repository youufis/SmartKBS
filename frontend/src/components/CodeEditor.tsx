import React, { useRef, useState, useEffect } from 'react'
import MonacoEditor from '@monaco-editor/react'
import { Select, Space, Typography, Button } from 'antd'
import { CodeOutlined, ExpandOutlined, CompressOutlined } from '@ant-design/icons'

interface CodeEditorProps {
  language?: string
  defaultValue?: string
  value?: string
  readOnly?: boolean
  onChange?: (value: string) => void
  height?: string | number
  showToolbar?: boolean
  showLanguageSelector?: boolean
  onLanguageChange?: (lang: string) => void
  supportedLanguages?: { value: string; label: string; available: boolean }[]
}

// 语言映射：后端语言名 → Monaco Editor 语言标识
const LANG_TO_MONACO: Record<string, string> = {
  python: 'python',
  javascript: 'javascript',
  html: 'html',
  css: 'css',
  typescript: 'typescript',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  sql: 'sql',
}

const CodeEditor: React.FC<CodeEditorProps> = ({
  language = 'python',
  defaultValue = '# 在此编写你的代码\n\ndef solution():\n    # 请在此处实现你的代码\n    pass\n\n\nif __name__ == "__main__":\n    solution()\n',
  value,
  readOnly = false,
  onChange,
  height = '420px',
  showToolbar = true,
  showLanguageSelector = true,
  onLanguageChange,
  supportedLanguages,
}) => {
  const [internalCode, setInternalCode] = useState(defaultValue)
  const [currentLang, setCurrentLang] = useState(language)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const editorRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 受控/非受控模式
  const isControlled = value !== undefined
  const displayCode = isControlled ? value : internalCode

  const handleEditorMount = (editor: any, monaco: any) => {
    editorRef.current = editor
    // Ctrl+Enter 快捷键提示在 UI 中展示
  }

  const handleChange = (newValue: string | undefined) => {
    const code = newValue || ''
    if (!isControlled) {
      setInternalCode(code)
    }
    onChange?.(code)
  }

  const handleLanguageChange = (lang: string) => {
    setCurrentLang(lang)
    onLanguageChange?.(lang)
  }

  const toggleFullscreen = () => {
    if (!containerRef.current) return
    if (!isFullscreen) {
      containerRef.current.requestFullscreen?.()
    } else {
      document.exitFullscreen?.()
    }
    setIsFullscreen(!isFullscreen)
  }

  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement) {
        setIsFullscreen(false)
      }
    }
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  // 语言选择器选项
  const langOptions = supportedLanguages
    ? supportedLanguages.map(l => ({
        value: l.value,
        label: l.label,
        disabled: !l.available,
      }))
    : [
        { value: 'python', label: 'Python' },
        { value: 'javascript', label: 'JavaScript' },
      ]

  return (
    <div
      ref={containerRef}
      style={{
        border: '1px solid #d9d9d9',
        borderRadius: 8,
        overflow: 'hidden',
        background: '#fff',
      }}
    >
      {showToolbar && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 12px',
            background: '#fafafa',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <Space>
            <CodeOutlined style={{ color: '#1677ff' }} />
            <Typography.Text strong style={{ fontSize: 13 }}>
              代码编辑器
            </Typography.Text>
            {showLanguageSelector && (
              <Select
                size="small"
                value={currentLang}
                onChange={handleLanguageChange}
                style={{ width: 130 }}
                options={langOptions}
              />
            )}
          </Space>
          <Space size="small">
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              Ctrl+Enter 运行
            </Typography.Text>
            <Button
              type="text"
              size="small"
              icon={isFullscreen ? <CompressOutlined /> : <ExpandOutlined />}
              onClick={toggleFullscreen}
              title={isFullscreen ? '退出全屏' : '全屏编辑'}
            />
          </Space>
        </div>
      )}
      <div style={{ minHeight: height }}>
        <MonacoEditor
          height={isFullscreen ? 'calc(100vh - 120px)' : height}
          language={LANG_TO_MONACO[currentLang] || 'python'}
          value={displayCode}
          onChange={handleChange}
          onMount={handleEditorMount}
          theme="vs"
          options={{
            minimap: { enabled: !isFullscreen },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            readOnly,
            wordWrap: 'on',
            padding: { top: 8 },
            scrollbar: {
              verticalScrollbarSize: 10,
              horizontalScrollbarSize: 10,
            },
            folding: true,
            foldingHighlight: true,
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
          }}
        />
      </div>
    </div>
  )
}

export default CodeEditor
