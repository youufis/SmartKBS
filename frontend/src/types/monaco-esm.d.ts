// monaco-editor 的 exports map 没有为 ESM 子路径提供类型，
// 但 Vite 能正常解析这些文件；这里补上类型声明。
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/editor/editor.all.js'
declare module 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
declare module 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
declare module 'monaco-editor/esm/vs/language/typescript/monaco.contribution'
