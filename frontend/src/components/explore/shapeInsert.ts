/** 把「形状清单」（模型产出 / 内置模板）落到 tldraw 画布：修正不合规的 geo 属性 */
import { Box, type Editor } from 'tldraw'
import type { ShapeSpec } from '../../api/explore'

const TL_COLOR_SET = new Set([
  'black', 'grey', 'light-grey', 'brown', 'yellow', 'orange', 'red', 'light-red',
  'purple', 'violet', 'light-violet', 'blue', 'light-blue', 'green', 'light-green', 'white',
])
const TL_FILL_SET = new Set(['none', 'solid', 'semi', 'pattern'])
const GEO_SET = new Set(['cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon',
  'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'heart'])

export function toRichText(text: string) {
  if (!text) return { type: 'doc', content: [] }
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

/** 模型/模板产出的形状按 TLDraw 规范修正（与白板 AIPanel 同款处理） */
export function fixShape(s: ShapeSpec, id: string, originX: number, originY: number, minX: number, minY: number) {
  const props: Record<string, any> = { ...(s.props || {}) }
  if (!GEO_SET.has(String(props.geo))) props.geo = 'rectangle'
  props.w = Math.min(900, Math.max(90, Number(props.w) || 240))
  props.h = Math.min(400, Math.max(40, Number(props.h) || 56))
  if (!TL_COLOR_SET.has(String(props.color))) props.color = 'black'
  if (!TL_FILL_SET.has(String(props.fill))) props.fill = 'none'
  if (!['xs', 's', 'm', 'l', 'xl', 'xxl'].includes(String(props.size))) props.size = 'm'
  if (props.text) { props.richText = toRichText(String(props.text)); delete props.text }
  if (!props.richText) props.richText = toRichText('')
  delete props.fontSize; delete props.fontWeight; delete props.textAlign; delete props.lineHeight
  return {
    id,
    type: 'geo',
    x: originX + (Number(s.x) || 0) - minX,
    y: originY + (Number(s.y) || 0) - minY,
    props,
  }
}

/** 插到当前视野中心、选中、并缩放到位；返回插入的 shape id 列表 */
export function insertShapesIntoEditor(ed: Editor, shapes: ShapeSpec[]): string[] {
  if (!ed || !shapes.length) return []
  const xs = shapes.map((s) => Number(s.x) || 0)
  const ys = shapes.map((s) => Number(s.y) || 0)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const bounds = ed.getViewportPageBounds()
  const originX = bounds.center.x - 460
  const originY = Math.max(bounds.y + 40, bounds.center.y - 240)
  const stamp = Date.now()
  const built = shapes.map((s, i) => fixShape(s, 'shape:ex' + stamp + '-' + i, originX, originY, minX, minY))
  ed.createShapes(built as never)
  const ids = built.map((b) => b.id)
  try { ed.setSelectedShapes(ids as never) } catch { /* 选中失败不影响插入 */ }
  try {
    const boxes = ids
      .map((id) => {
        const b = ed.getShapePageBounds(id as never)
        return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null
      })
      .filter((b): b is { x: number; y: number; w: number; h: number } => b !== null)
    if (!boxes.length) return ids
    const bx = Math.min(...boxes.map((b) => b.x))
    const by = Math.min(...boxes.map((b) => b.y))
    const mx = Math.max(...boxes.map((b) => b.x + b.w))
    const my = Math.max(...boxes.map((b) => b.y + b.h))
    ed.zoomToBounds(new Box(bx, by, mx - bx, my - by), { inset: 64, animation: { duration: 220 } })
  } catch { /* 视口缩放失败也不该让「已插入」变成报错 */ }
  return ids
}
