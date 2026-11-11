/**
 * 探索画布 · 时间线存档 / 页面回收站的线框缩略图
 *
 * 后端（backend/explore_preview.py）把快照压成 {b:[宽,高], s:[图元]}，
 * 图元两种：["r",x,y,w,h,类别,颜色] 包围盒、["d",[x0,y0,x1,y1...],颜色] 笔迹折线。
 * 128px 下能看出那一份是几块卡片、笔迹往哪儿走——比"7 KB"有用得多。
 */
import React from 'react'

// 与 backend/explore_preview.py 的 _COLORS 下标一一对应（tldraw 默认色卡）
const PALETTE = ['#373a47', '#373a47', '#a1a5b0', '#99e0fd', '#4aaee6', '#8fd39a', '#3ec375',
  '#f9a8a8', '#f2555a', '#ff9c3f', '#f5c64c', '#d0a6f2', '#9d54e0', '#e05fa4', '#ffffff']

interface Props {
  preview?: string
  width?: number
  height?: number
}

type Item = (string | number | number[])[]

function strokePoints(nums: number[]): string {
  const out: string[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) out.push(nums[i] + ',' + nums[i + 1])
  return out.join(' ')
}

function renderBox(it: Item, key: number, unit: number) {
  const [, x, y, w, h, kindRaw, colorRaw] = it as unknown as [string, number, number, number, number, number, number]
  const c = PALETTE[colorRaw] || PALETTE[0]
  const stroke = { fill: 'none', stroke: c, strokeWidth: Math.max(1, unit * 1.6) } as const
  const kind = kindRaw || 0
  if (kind === 1) return <ellipse key={key} cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...stroke} />
  if (kind === 2) return <rect key={key} x={x} y={y} width={w} height={h} rx={unit * 2} fill={c} opacity={0.55} />
  if (kind === 3) {
    // 纯文本：画三行横线就够认出“这里有一段字”，最后一行短一些
    const lines = [0.25, 0.6, 0.9]
    return <g key={key}>
      {lines.map((f, i) => (
        <line key={i} x1={x} y1={y + h * f} x2={x + w * (i === lines.length - 1 ? 0.6 : 0.95)} y2={y + h * f}
          stroke={c} strokeWidth={Math.max(1, unit * 1.4)} strokeLinecap="round" />))}
    </g>
  }
  if (kind === 4) {
    return <g key={key}>
      <rect x={x} y={y} width={w} height={h} rx={unit} {...stroke} />
      <line x1={x} y1={y} x2={x + w} y2={y + h} stroke={c} strokeWidth={Math.max(1, unit)} opacity={0.6} />
      <line x1={x + w} y1={y} x2={x} y2={y + h} stroke={c} strokeWidth={Math.max(1, unit)} opacity={0.6} />
    </g>
  }
  if (kind === 5) {
    // 提问卡：顶上一条实心题头
    return <g key={key}>
      <rect x={x} y={y} width={w} height={h} rx={unit * 2} {...stroke} />
      <rect x={x} y={y} width={w} height={Math.min(h * 0.3, unit * 10)} rx={unit * 2} fill={c} opacity={0.7} />
    </g>
  }
  if (kind === 6) return <line key={key} x1={x} y1={y} x2={x + w} y2={y + h} {...stroke} />
  return <rect key={key} x={x} y={y} width={w} height={h} rx={unit * 2} {...stroke} />
}

const PageThumb: React.FC<Props> = ({ preview, width = 128, height = 96 }) => {
  // 解析失败（老存档没有预览、或格式变了）就走占位框，不报错
  let data: { b?: number[]; s?: Item[] } | null
  try { data = preview ? JSON.parse(preview) : null } catch { data = null }
  const bw = data?.b?.[0] || 0
  const bh = data?.b?.[1] || 0
  const items = Array.isArray(data?.s) ? data!.s! : []
  if (!items.length || bw <= 0 || bh <= 0) {
    return (
      <div style={{
        width, height, flexShrink: 0, borderRadius: 6, display: 'flex', alignItems: 'center',
        justifyContent: 'center', fontSize: 12, color: 'var(--text-secondary, #c3cbd8)',
        border: '1px dashed var(--border-color, #d9e3f2)', background: 'var(--bg-secondary, #fafbfd)',
      }}>—</div>
    )
  }
  const pad = Math.max(bw, bh) * 0.06
  const unit = Math.max(bw, bh) / 100
  return (
    <svg width={width} height={height} viewBox={[-pad, -pad, bw + pad * 2, bh + pad * 2].join(' ')}
      preserveAspectRatio="xMidYMid meet" aria-hidden="true"
      style={{
        flexShrink: 0, display: 'block', borderRadius: 6, background: '#fff',
        border: '1px solid var(--border-color, #e6ecf5)',
      }}>
      {items.map((it, i) => (it[0] === 'd'
        ? <polyline key={i} fill="none" stroke={PALETTE[(it as any)[2] as number] || PALETTE[0]}
            strokeWidth={Math.max(2, unit * 2)} strokeLinecap="round" strokeLinejoin="round"
            points={strokePoints((it as any)[1] as number[])} />
        : renderBox(it, i, unit)))}
    </svg>
  )
}

export default PageThumb
