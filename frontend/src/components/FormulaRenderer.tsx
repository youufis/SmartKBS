/**
 * FormulaRenderer — LaTeX 公式渲染组件
 *
 * 基于 react-markdown + remark-math + rehype-katex
 * 支持：
 * - $...$ 行内公式，如 $E=mc^2$
 * - $$...$$ 独立公式块，如 $$\sum_{i=1}^n i$$
 * - \ce{...} 化学式（mhchem），如 $\ce{H2O}$
 * - 与现有 Markdown (GFM) 渲染完全兼容
 *
 * 另外做了两件对 AI 输出很关键的事（见 normalizeMath）：
 * - 把同一行里写的 $$公式$$ 拆成独立公式块（remark-math 只认成行的 $$，
 *   不拆的话「递推关系： $$n! = n\\times(n-1)!$$」会原样显示成文本）；
 * - 把 \\(\\) / \\[\\] 这种 LaTeX 定界符换成 $ / $$。
 */
import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Components } from 'react-markdown'

/**
 * 把 AI 常写的「行内 $$...$$」与 \(\)、\[\] 定界符整理成 remark-math 认得的形式。
 * 代码块内部原样保留，避免把示例代码里的 $$ 也改了。
 */
export function normalizeMath(src: string): string {
  if (!src) return src
  let text = src.replace(/\r\n/g, '\n')
  text = text.replace(/\\\(\s*([^)]+?)\s*\\\)/g, (_m, g) => '$' + g + '$')
  text = text.replace(/\\\[\s*([\s\S]+?)\s*\\\]/g, (_m, g) => '\n\n$$\n' + g.trim() + '\n$$\n\n')

  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    // 纯 $$ 分隔行、没有 $$、或还在代码块里的，一律不动
    if (inFence || t === '$$' || !line.includes('$$')) {
      out.push(line)
      continue
    }
    const parts = line.split('$$')
    if (parts.length < 3) {
      out.push(line)
      continue
    }
    const rebuilt: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i].trim()
      if (!seg) continue
      if (i % 2 === 0) rebuilt.push(seg)
      else rebuilt.push('$$', seg, '$$')
    }
    out.push(rebuilt.join('\n'))
    if (rebuilt.length) out.push('')
  }
  return out.join('\n')
}

interface FormulaRendererProps {
  /** Markdown / LaTeX 混合内容 */
  content: string
  /** 行内模式：用于选项等短文本，不渲染 GFM */
  inline?: boolean
  /** 追加或覆盖 react-markdown 的组件渲染（如自定义 code 高亮） */
  components?: Components
}

const FormulaRenderer: React.FC<FormulaRendererProps> = ({ content, inline = false, components }) => {
  const source = normalizeMath(content || '')
  if (!source) return null

  if (inline) {
    // 选项等简短内容：公式 + 图片 + 基本 Markdown
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // 使图片在行内模式也能正常显示
          img: ({ src, alt }) => (
            <img src={src} alt={alt || ''} style={{ maxWidth: 120, maxHeight: 80, verticalAlign: 'middle', margin: '0 4px', borderRadius: 4 }} />
          ),
          ...components,
        }}
      >
        {source}
      </ReactMarkdown>
    )
  }

  // 完整模式：支持 GFM（表格、列表等）+ 公式
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={components}
    >
      {source}
    </ReactMarkdown>
  )
}

export default FormulaRenderer
