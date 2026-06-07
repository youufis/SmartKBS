/**
 * FormulaRenderer — LaTeX 公式渲染组件
 *
 * 基于 react-markdown + remark-math + rehype-katex
 * 支持：
 * - $...$ 行内公式，如 $E=mc^2$
 * - $$...$$ 独立公式块，如 $$\sum_{i=1}^n i$$
 * - \ce{...} 化学式（mhchem），如 $\ce{H2O}$
 * - 与现有 Markdown (GFM) 渲染完全兼容
 */
import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'

interface FormulaRendererProps {
  /** Markdown / LaTeX 混合内容 */
  content: string
  /** 行内模式：用于选项等短文本，不渲染 GFM */
  inline?: boolean
}

const FormulaRenderer: React.FC<FormulaRendererProps> = ({ content, inline = false }) => {
  if (!content) return null

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
        }}
      >
        {content}
      </ReactMarkdown>
    )
  }

  // 完整模式：支持 GFM（表格、列表等）+ 公式
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
    >
      {content}
    </ReactMarkdown>
  )
}

export default FormulaRenderer
