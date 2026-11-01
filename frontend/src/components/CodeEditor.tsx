import React, { useRef, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import MonacoEditor from '@monaco-editor/react'
import { Select, Space, Typography, Button, theme, Spin } from 'antd'
import { CodeOutlined, ExpandOutlined, CompressOutlined, UndoOutlined } from '@ant-design/icons'
import { useThemeStore } from '../stores/themeStore'

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
  /** Ctrl+Enter / 工具栏「运行」都会触发；不传则不显示运行提示 */
  onRun?: () => void
  /** 传了才显示「重置为初始代码」 */
  onReset?: () => void
  runDisabled?: boolean
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
  onRun,
  onReset,
  runDisabled = false,
}) => {
  const { t } = useTranslation('practice')
  const { token } = theme.useToken()
  const themeName = useThemeStore((s) => s.current)
  const isDark = themeName === 'midnight'

  const [internalCode, setInternalCode] = useState(defaultValue)
  const [currentLang, setCurrentLang] = useState(language)
  const [isFullscreen, setIsFullscreen] = useState(false)
  // Monaco 体积较大：等真正用到编辑器时再异步加载，避免拖慢应用首屏
  const [monacoReady, setMonacoReady] = useState(false)
  const editorRef = useRef<any>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const onRunRef = useRef(onRun)
  const onResetRef = useRef(onReset)
  const runDisabledRef = useRef(runDisabled)

  useEffect(() => { onRunRef.current = onRun }, [onRun])
  useEffect(() => { onResetRef.current = onReset }, [onReset])
  useEffect(() => { runDisabledRef.current = runDisabled }, [runDisabled])
  useEffect(() => {
    let cancelled = false
    import('../utils/monacoSetup')
      .then(() => { if (!cancelled) setMonacoReady(true) })
      .catch(() => { if (!cancelled) setMonacoReady(true) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => { setCurrentLang(language) }, [language])

  // 受控/非受控模式
  const isControlled = value !== undefined
  const displayCode = isControlled ? value : internalCode

  const handleEditorMount = (editor: any, monaco: any) => {
    editorRef.current = editor
    // 提示过的快捷键要真的能用：Ctrl/Cmd+Enter 运行
    editor.addAction({
      id: 'smartkb-run-code',
      label: t('runCode'),
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 0,
      run: () => {
        if (!runDisabledRef.current) onRunRef.current?.()
      },
    })
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

  const handleReset = () => {
    if (!onResetRef.current) return
    onResetRef.current()
    if (!isControlled) setInternalCode(defaultValue)
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

  const editorHeight = isFullscreen ? 'calc(100vh - 44px)' : height

  return (
    <div
      ref={containerRef}
      style={{
        border: isFullscreen ? 'none' : `1px solid ${token.colorBorderSecondary}`,
        borderRadius: isFullscreen ? 0 : 8,
        overflow: 'hidden',
        background: token.colorBgContainer,
        ...(isFullscreen
          ? { position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', flexDirection: 'column' }
          : null),
      }}
    >
      {showToolbar && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 12px',
            background: token.colorFillQuaternary,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0,
          }}
        >
          <Space>
            <CodeOutlined style={{ color: token.colorPrimary }} />
            <Typography.Text strong style={{ fontSize: 13 }}>
              {t('editorTitle')}
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
            {onRun && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {t('editorRunHint')}
              </Typography.Text>
            )}
            {onReset && !readOnly && (
              <Button
                type="text"
                size="small"
                icon={<UndoOutlined />}
                onClick={handleReset}
                title={t('editorReset')}
              />
            )}
            <Button
              type="text"
              size="small"
              icon={isFullscreen ? <CompressOutlined /> : <ExpandOutlined />}
              onClick={toggleFullscreen}
              title={isFullscreen ? t('editorExitFullscreen') : t('editorFullscreen')}
            />
          </Space>
        </div>
      )}
      <div style={{ flex: 1, minHeight: isFullscreen ? 0 : height }}>
        {!monacoReady ? (
          <div style={{ height: editorHeight, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: token.colorTextSecondary }}>
            <Spin size="small" /> {t('editorLoading')}
          </div>
        ) : (
        <MonacoEditor
          height={editorHeight}
          language={LANG_TO_MONACO[currentLang] || 'python'}
          value={displayCode}
          onChange={handleChange}
          onMount={handleEditorMount}
          theme={isDark ? 'vs-dark' : 'vs'}
          loading={<div style={{ padding: 16, color: token.colorTextSecondary }}>…</div>}
          options={{
            minimap: { enabled: !isFullscreen },
            fontSize: 14,
            lineHeight: 21,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            insertSpaces: true,
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
            renderLineHighlight: 'all',
            bracketPairColorization: { enabled: true },
            autoClosingBrackets: 'always',
            autoClosingQuotes: 'always',
            suggestOnTriggerCharacters: true,
            quickSuggestions: true,
            smoothScrolling: true,
          }}
        />
        )}
      </div>
    </div>
  )
}

export default CodeEditor
