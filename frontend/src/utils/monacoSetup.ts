/**
 * Monaco 本地化 + 精简配置
 *
 * 原来的 @monaco-editor/react 默认从 jsdelivr CDN 拉 monaco，校内离线 / 桌面版
 * 会直接白屏。这里改为随构建产物打包，并显式注册语言 worker。
 *
 * 只打包代码练习真正用到的 Python / JavaScript，避免把 50 多种基础语言
 * 和 JSON/CSS/HTML 语言服务全部塞进首屏（体积约从 10MB 降到 3MB 级别）。
 */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { loader } from '@monaco-editor/react'

let configured = false

export function setupMonaco(): void {
  if (configured) return
  configured = true

  ;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === 'typescript' || label === 'javascript') return new tsWorker()
      return new editorWorker()
    },
  }

  loader.config({ monaco: monaco as any })
}

setupMonaco()
