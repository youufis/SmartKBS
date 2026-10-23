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
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { Components } from 'react-markdown'

/**
 * 把 AI 常写的「行内 $$...$$」与 \(\)、\[\] 定界符整理成 remark-math 认得的形式。
 * 代码块内部原样保留，避免把示例代码里的 $$ 也改了。
 */
/**
 * 屏蔽成对的 $$ 定界符后，把**明显是钱/散文**的 $…$ 转义成字面量，别让 remark-math 当公式。
 *
 * ⚠️ 判据只保留"包裹内容里含中文"这一条（2026-10-12 修）：
 *   旧实现还额外按"含数字"转义，结果把**纯数值公式**一起误伤 ——
 *   老师实测：题干 `$1011000$`、选项 `$88$`（进制/数值题）在页面上原样显示成了 `$88$`。
 *   这类"数字在 $ 里"在教学材料里绝大多数就是公式，必须渲染。
 *   而真正的货币/散文写法（价格$5和$6、$1.2 万亿）包裹内容里一定有中文，那条判据已经兜住了。
 *   $x$、$f(x)$、$88$、$1011000$  -> 保留（是公式）
 *   $5和$6、$1.2 万亿             -> 转义（是钱，不是公式）
 */
function maskDollars(text: string): string {
  const MASK = '\u0000'
  const masked = text.replace(/\$\$/g, MASK + MASK)
  const fixed = masked.replace(/\$([^$\n]+)\$/g, (whole, body) => {
    if (/[\\^_{}=]/.test(body)) return whole
    if (/[\u4e00-\u9fff]/.test(body)) return '\\$' + body + '\\$'
    return whole
  })
  return fixed.split(MASK + MASK).join('$$')
}

export function normalizeMath(src: string): string {
  if (!src) return src
  let text = src.replace(/\r\n/g, '\n')
  text = text.replace(/\\\(\s*([^)]+?)\s*\\\)/g, (_m, g) => '$' + g + '$')
  text = text.replace(/\\\[\s*([\s\S]+?)\s*\\\]/g, (_m, g) => '\n\n$$\n' + g.trim() + '\n$$\n\n')
  // 「价格$5和$6」这类没有 LaTeX 特征的 $…$ 先转义，避免被误判成公式
  text = maskDollars(text)

  const out: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    // 纯 $$ 分隔行、行内代码、没有 $$、或还在代码块里的，一律不动
    if (inFence || t === '$$' || line.includes('`') || !line.includes('$$')) {
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

/**
 * 把单个换行补成 Markdown 硬换行（行尾两个空格），让原本按 pre-wrap 显示的
 * 纯文本换到 Markdown 渲染后仍保持同样的断行；列表、标题、表格、引用、代码块等
 * 结构化行不动，避免把语法行拆成两段。
 */
export function preserveBreaks(text: string): string {
  if (!text) return text
  const structural = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```|~~~|\*\*\*|---|===)/
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) { out.push(line); continue }
    const nextT = (lines[i + 1] ?? '').trim()
    const keepAsIs = !t || t.endsWith('  ') || !nextT || structural.test(t) || structural.test(nextT)
    out.push(keepAsIs ? line : line + '  ')
  }
  return out.join('\n')
}

/**
 * 按行扫描切出 ``` / ~~~ 围栏代码块。
 *
 * 为什么自己切而不交给 react-markdown：行内场景（列表行、选项、表格单元格）不能出现
 * 块级 <pre> —— 它会把 nowrap + ellipsis 的单元格整个撑破，正好毁掉刚做完的行高收紧。
 * 切出来之后，文字段照常行内渲染，代码段单独压成一枚徽标。
 */
export type Segment = { code: boolean; text: string; lines: number }

export function splitFences(src: string): Segment[] {
  if (!src || (!src.includes('```') && !src.includes('~~~'))) {
    return [{ code: false, text: src || '', lines: 0 }]
  }
  const out: Segment[] = []
  let buf: string[] = []
  let fence: string[] | null = null
  const flushText = () => {
    const text = buf.join('\n')
    buf = []
    if (text.trim()) out.push({ code: false, text, lines: 0 })
  }
  for (const line of src.replace(/\r\n/g, '\n').split('\n')) {
    const t = line.trim()
    const isFence = t.startsWith('```') || t.startsWith('~~~')
    if (fence) {
      if (isFence && t.slice(0, 3) === fence[0]) {
        // 收尾：丢掉 ```python 那行的语言名，只留代码本体
        const body = fence.slice(1).join('\n')
        out.push({ code: true, text: body, lines: body.split('\n').filter(l => l.trim()).length })
        fence = null
      } else {
        // 保留原始行：Python 的缩进就是语义，只去掉行尾空白
        fence.push(line.replace(/\s+$/, ''))
      }
      continue
    }
    if (isFence) {
      flushText()
      fence = [t.slice(0, 3)]
      continue
    }
    buf.push(line)
  }
  if (fence) {
    // 模型只写了开头没闭合：按代码处理，别把 ``` 原样甩在题干里
    const body = fence.slice(1).join('\n')
    out.push({ code: true, text: body, lines: body.split('\n').filter(l => l.trim()).length })
  }
  flushText()
  return out.length ? out : [{ code: false, text: src, lines: 0 }]
}

/** 行内场景的代码徽标：只报行数，完整内容在 Tooltip 里看（等宽、保留缩进、可滚） */
const CodeChip: React.FC<{ text: string; lines: number }> = ({ text, lines }) => {
  const { t } = useTranslation('common')
  return (
    <Tooltip title={<pre className="formula-code-tip">{text}</pre>} overlayStyle={{ maxWidth: 560 }}>
      <span className="formula-code-chip">
        {'{'}…{'}'} {t('codeChip', { count: Math.max(1, lines) })}
      </span>
    </Tooltip>
  )
}

/**
 * 块级代码与行内代码的渲染。类名自带样式，不再要求调用方额外包一层 .markdown-content
 * —— 之前代码块样式只挂在 .markdown-content pre/code 上，聊天/任务页包了就有底色，
 * 题目那一片没包，于是围栏代码渲染成光秃秃的浏览器默认 <pre>，看着仍像正文。
 */
const codeComponents: Components = {
  // node 是 hast 节点对象，不能跟着 spread 进 DOM
  pre: ({ node, children, ...rest }) => <pre className="formula-code" {...rest}>{children}</pre>,
  code: ({ node, children, ...rest }) => (
    <code className="formula-code-inline" {...rest}>{children}</code>
  ),
}

interface FormulaRendererProps {
  /** Markdown / LaTeX 混合内容 */
  content: string
  /** 行内模式：用于选项等短文本，不渲染 GFM */
  inline?: boolean
  /** 追加或覆盖 react-markdown 的组件渲染（如自定义 code 高亮） */
  components?: Components
  /** 是否启用 GFM（表格、删除线等），默认 true。
   *  原本没挂 remarkGfm 的长文本页传 false：只加公式渲染，不改现有排版 */
  gfm?: boolean
  /** 是否把单个换行保留成硬换行（原 pre-wrap 纯文本改渲染时用） */
  breaks?: boolean
}

const FormulaRenderer: React.FC<FormulaRendererProps> = ({ content, inline = false, components, gfm = true, breaks = false }) => {
  const normalized = normalizeMath(content || '')
  const source = breaks ? preserveBreaks(normalized) : normalized
  if (!source) return null

  if (inline) {
    // 选项等简短内容：公式 + 图片 + 基本 Markdown
    const inlineComponents: Components = {
      // 使图片在行内模式也能正常显示
      img: ({ src, alt }) => (
        <img src={src} alt={alt || ''} style={{ maxWidth: 120, maxHeight: 80, verticalAlign: 'middle', margin: '0 4px', borderRadius: 4 }} />
      ),
      ...components,
    }
    const segments = splitFences(source)
    if (!segments.some(seg => seg.code)) {
      return (
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={inlineComponents}>
          {source}
        </ReactMarkdown>
      )
    }
    // 题干里带代码块时：文字照常行内渲染，代码压成徽标，块级 <pre> 不进单元格
    return (
      <>
        {segments.map((seg, i) => (seg.code
          ? <CodeChip key={`code-${i}`} text={seg.text} lines={seg.lines} />
          : (
            <ReactMarkdown
              key={`text-${i}`}
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
              components={inlineComponents}
            >
              {seg.text}
            </ReactMarkdown>
          )))}
      </>
    )
  }

  // 完整模式：GFM（表格、列表、代码块）+ 公式；调用方自带的 components 优先级更高
  return (
    <ReactMarkdown
      remarkPlugins={gfm ? [remarkGfm, remarkMath] : [remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{ ...codeComponents, ...components }}
    >
      {source}
    </ReactMarkdown>
  )
}

export default FormulaRenderer
