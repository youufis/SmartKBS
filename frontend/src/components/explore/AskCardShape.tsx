/**
 * 探索画布 · 提问卡（ask-card）自定义形状（M1）
 * 答案不再是一闪而过的聊天气泡——落到画布成为卡片：带问题、回答、教材来源，
 * 卡上可 追问 / 朗读 / 复制；按钮通过 window 事件（explore:card-action）与 AI 面板通信。
 */
import React from 'react'
import {
  Rectangle2d, ShapeUtil, T,
  type Editor, type Geometry2d, type TLBaseShape,
} from 'tldraw'

export interface AskCardProps {
  w: number
  h: number
  question: string
  answer: string
  refs: string       // JSON 字符串：[{doc_name,title}]，保持 schema 简单
  createdAt: string
}
export type AskCardShape = TLBaseShape<'ask-card', AskCardProps>

export type CardAction = 'followup' | 'speak' | 'copy'

export function dispatchCardAction(action: CardAction, shape: AskCardShape) {
  window.dispatchEvent(new CustomEvent('explore:card-action', {
    detail: { action, question: shape.props.question, answer: shape.props.answer },
  }))
}

const btnStyle: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--border-color, #d9d9d9)', background: 'transparent',
  color: 'var(--text-secondary, #666)',
}

/** 卡片是纯文本渲染：把回答里的 markdown 记号轻清洗一遍，别露出星号井号 */
function plainMarkdown(src: string): string {
  let s = src || ''
  s = s.replace(/^#{1,6}\s*/gm, '')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/^\s*[-*]\s+/gm, '· ')
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1$2')
  s = s.replace(/`{1,3}/g, '')
  return s
}

/** 导出/打印时 tldraw 走 SVG 通道，自定义 HTML 形状默认画不出来——这里按字宽手动折行 */
function wrapForExport(text: string, widthPx: number, maxLines: number): string[] {
  const perLine = Math.max(8, Math.floor((widthPx - 24) / 13))
  const out: string[] = []
  for (const para of String(text || '').split('\n')) {
    const p = para.trim()
    if (!p) { out.push(''); continue }
    for (let i = 0; i < p.length; i += perLine) {
      out.push(p.slice(i, i + perLine))
      if (out.length >= maxLines) return out
    }
  }
  return out.slice(0, maxLines)
}

function AskCardView({ editor, shape }: { editor: Editor; shape: AskCardShape }) {
  const { question, answer, refs, w, h, createdAt } = shape.props
  let refList: { doc_name?: string; title?: string }[] = []
  try { refList = JSON.parse(refs || '[]') } catch { refList = [] }
  const stop = (fn: () => void) => (e: React.SyntheticEvent) => {
    e.stopPropagation()
    e.preventDefault()
    fn()
  }
  const uniq = refList.filter((r, i) => refList.findIndex((x) => (x.doc_name || '') === (r.doc_name || '') && (x.title || '') === (r.title || '')) === i)
  let refLine = uniq.slice(0, 3).map((r) => r.doc_name || '').filter(Boolean).join(' · ')
  if (refLine.length > 90) refLine = refLine.slice(0, 89) + '…'
  const selected = editor.getSelectedShapeIds().includes(shape.id)
  return (
    <div
      data-explore-card={shape.id}
      style={{
        width: w, height: h, display: 'flex', flexDirection: 'column',
      borderRadius: 12, padding: '10px 12px', boxSizing: 'border-box',
      background: 'var(--bg-container, #fff)',
      border: selected ? '2px solid var(--color-brand, #1677ff)' : '1.5px solid #d9e3f2',
      boxShadow: '0 2px 8px rgba(15, 35, 75, 0.08)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{
        fontSize: 12, color: '#8a94a6', lineHeight: 1.5, marginBottom: 6,
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>
        Q｜{question || '（无标题）'}
      </div>
      <div style={{
        flex: 1, overflowY: 'auto', fontSize: 13, lineHeight: 1.65, color: '#2b3242',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {plainMarkdown(answer)}
      </div>
      {!!refList.length && (
        <div style={{ fontSize: 10, color: '#98a2b3', margin: '6px 0 2px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} title={uniq.map((r) => r.doc_name || '').join(' · ')}>
          来源：{refLine}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
        <button style={btnStyle} onPointerDown={stop(() => dispatchCardAction('followup', shape))}>追问</button>
        <button style={btnStyle} onPointerDown={stop(() => dispatchCardAction('speak', shape))}>朗读</button>
        <button style={btnStyle} onPointerDown={stop(() => dispatchCardAction('copy', shape))}>复制</button>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: '#c2c9d4' }}>{(createdAt || '').slice(5, 16)}</span>
      </div>
    </div>
  )
}

// v5 的 TLShape 是闭合联合类型，自定义形状在类泛型上放宽为 any，
// 形状本体仍用 AskCardShape 精确标注（component/getGeometry 参数）。
export class AskCardUtil extends ShapeUtil<any> {
  static override type = 'ask-card' as const
  static override props = {
    w: T.number,
    h: T.number,
    question: T.string,
    answer: T.string,
    refs: T.string,
    createdAt: T.string,
  }

  override getDefaultProps(): AskCardShape['props'] {
    return { w: 360, h: 240, question: '', answer: '', refs: '[]', createdAt: '' }
  }

  override getGeometry(shape: AskCardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override component(shape: AskCardShape) {
    return <AskCardView editor={this.editor} shape={shape} />
  }

  override getIndicatorPath(shape: AskCardShape): Path2D {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }

  /**
   * SVG 导出：tldraw 的整页导出/选区截图/打印都走这条通道。
   * 不实现的话提问卡在「存入档案」的缩略图里会整张消失（HTML 形状不参与 SVG 渲染）。
   */
  override toSvg(shape: AskCardShape) {
    const { w, h, question, answer } = shape.props
    const lines = wrapForExport('Q｜' + (question || '') + '\n\n' + plainMarkdown(answer || ''), w, Math.max(2, Math.floor((h - 24) / 18)))
    return (
      <g>
        <rect x={0} y={0} width={w} height={h} rx={12} fill="#ffffff" stroke="#d9e3f2" strokeWidth={1.5} />
        {lines.map((line, i) => (
          <text key={i} x={12} y={26 + i * 18} fontSize={13} fontFamily="system-ui, sans-serif"
            fill={i === 0 ? '#8a94a6' : '#2b3242'}>{line}</text>
        ))}
      </g>
    )
  }
}