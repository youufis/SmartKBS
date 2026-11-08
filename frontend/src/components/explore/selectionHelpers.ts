/**
 * 探索画布 · 圈选内容抽取助手
 * 两种"圈住"都支持：① 选择工具框选/套索；② 用画笔在内容周围画个圈（90 秒内有效）
 */
import { b64Vecs, type Editor } from 'tldraw'

/** TLDraw v5 的 geo/text 用 ProseMirror richText 存字，只读 label 会拿到空 */
export function richTextToText(rt: unknown): string {
  const out: string[] = []
  const walk = (n: any) => {
    if (!n) return
    if (typeof n.text === 'string') out.push(n.text)
    if (Array.isArray(n.content)) n.content.forEach(walk)
  }
  walk(rt)
  return out.join(' ').trim()
}

export function shapePlainText(s: { type: string; props: Record<string, unknown> }): string {
  const props = s.props || {}
  if (s.type === 'ask-card') {
    const q = String(props.question || '')
    const a = String(props.answer || '').slice(0, 1200)
    return (q ? 'Q：' + q + '\n' : '') + (a ? 'A：' + a : '')
  }
  return richTextToText(props.richText) || String(props.text || props.label || '')
}

/** 一批形状的文字面（卡片、便签、文字），上限 1200 字 */
export function collectText(shapes: { type: string; props: Record<string, unknown> }[]): string {
  const parts: string[] = []
  for (const s of shapes) {
    const txt = shapePlainText(s)
    if (txt) parts.push(txt)
    if (parts.join('\n').length > 1600) break
  }
  return parts.join('\n').slice(0, 1600)
}

/** Box2d.contains 不吃普通对象，手动比坐标最稳 */
function centerInside(
  b: { x: number; y: number; w: number; h: number },
  p: { x: number; y: number },
): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
}

/**
 * 笔迹圈选：最近 90 秒内画过的圈（可多个）里，取第一个"圈住了东西"的；
 * 都没圈到东西时，用最新那个圈本身当内容（用户画的是草图/抄的题）。
 */
export function detectPenCircles(
  editor: Editor,
  recent: { id: string; ts: number }[],
): { draw: any; inside: any[] } | null {
  if (!editor || !recent.length) return null
  const fresh = recent.filter((r) => Date.now() - r.ts <= 90000).reverse()
  let fallback: { draw: any; inside: any[] } | null = null
  for (const r of fresh) {
    const draw = editor.getShape(r.id as never)
    if (!draw || String(draw.type) !== 'draw') continue
    const db = editor.getShapePageBounds(draw.id as never)
    if (!db || db.w < 20 || db.h < 20) continue
    const box = { x: db.x, y: db.y, w: db.w, h: db.h }
    const inside = editor.getCurrentPageShapes().filter((s) => {
      if (s.id === draw.id || String(s.type) === 'draw') return false
      const b = editor.getShapePageBounds(s.id as never)
      if (!b) return false
      if (centerInside(box, { x: b.x + b.w / 2, y: b.y + b.h / 2 })) return true
      // 圈住卡片内部一小段文字时，卡片中心在圈外——按重叠面积判定
      const x1 = Math.max(box.x, b.x), y1 = Math.max(box.y, b.y)
      const x2 = Math.min(box.x + box.w, b.x + b.w), y2 = Math.min(box.y + box.h, b.y + b.h)
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
      const circleArea = box.w * box.h || 1
      const shapeArea = b.w * b.h || 1
      return inter / circleArea >= 0.2 || inter / shapeArea >= 0.35
    })
    if (inside.length) return { draw, inside }
    if (!fallback) fallback = { draw, inside: [] }
  }
  return fallback
}

/** Blob 图 → 限边长 dataURL（进视觉链路前压一遍） */
export async function blobToDataUrl(blob: Blob, maxEdge = 1200): Promise<string> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) { bitmap.close?.(); return '' }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  return canvas.toDataURL('image/jpeg', 0.82)
}


/**
 * 智能提取：只取「实际落在笔圈内」的文字。
 * 卡片是 HTML 渲染的，可以直接量屏幕坐标：把笔圈换算到屏幕矩形，
 * 收集中心落在其中的文本元素；长段落再用 Range 的行矩形细分到行级。
 * 圈住整卡/落点取不到时返回空串，由调用方退回保守策略。
 */
export function smartExcerptInCircle(
  editor: Editor,
  circ: { draw: any; inside: any[] },
): string {
  try {
    const db = editor.getShapePageBounds(circ.draw.id as never)
    if (!db) return ''
    // 笔迹点云 → 屏幕坐标：路径点的真实范围才是圈到的区域
    const cloud: { x: number; y: number }[] = []
    const dprops = (circ.draw as any).props || {}
    const dx0 = (circ.draw as any).x || db.x, dy0 = (circ.draw as any).y || db.y
    for (const seg of (dprops.segments || []) as any[]) {
      if (Array.isArray(seg?.points)) {
        // 旧格式：点数组 [x, y, pressure]
        for (const pt of seg.points as number[][]) {
          if (Array.isArray(pt) && pt.length >= 2) {
            const sc = editor.pageToScreen({ x: dx0 + pt[0], y: dy0 + pt[1] } as never)
            cloud.push({ x: sc.x, y: sc.y })
          }
        }
      } else if (typeof seg?.path === 'string' && seg.path) {
        // v5 格式：path 是点集的 base64 编码
        let decoded: { x: number; y: number }[] = []
        try {
          decoded = b64Vecs.decodePoints(seg.path) as { x: number; y: number }[]
        } catch {
          const nums = seg.path.match(/-?\d+(?:\.\d+)?/g)
          if (nums) {
            for (let i = 0; i + 1 < nums.length; i += 2) {
              decoded.push({ x: parseFloat(nums[i]), y: parseFloat(nums[i + 1]) })
            }
          }
        }
        for (const pt of decoded) {
          const sc = editor.pageToScreen({ x: dx0 + pt.x, y: dy0 + pt.y } as never)
          cloud.push({ x: sc.x, y: sc.y })
        }
      }
    }
    let x1: number, x2: number, y1: number, y2: number
    if (cloud.length >= 8) {
      x1 = Math.min(...cloud.map((c) => c.x)); x2 = Math.max(...cloud.map((c) => c.x))
      y1 = Math.min(...cloud.map((c) => c.y)); y2 = Math.max(...cloud.map((c) => c.y))
    } else {
      const a = editor.pageToScreen({ x: db.x, y: db.y } as never)
      const b = editor.pageToScreen({ x: db.x + db.w, y: db.y + db.h } as never)
      x1 = Math.min(a.x, b.x); x2 = Math.max(a.x, b.x)
      y1 = Math.min(a.y, b.y); y2 = Math.max(a.y, b.y)
    }
    const ecx = (x1 + x2) / 2, ecy = (y1 + y2) / 2
    const erx = Math.max(12, (x2 - x1) / 2), ery = Math.max(10, (y2 - y1) / 2)
    // 椭圆内判定：线矩形中心落在圈内（留 30% 宽容度，画得潦算也算）
    const inBox = (r: { x: number; y: number; width?: number; height?: number; w?: number; h?: number }) => {
      const cx = r.x + (r.width ?? r.w ?? 0) / 2, cy = r.y + (r.height ?? r.h ?? 0) / 2
      const nd = ((cx - ecx) / erx) ** 2 + ((cy - ecy) / ery) ** 2
      return nd <= 1.3
    }
    const found: string[] = []
    const DOM_TYPES = new Set(['ask-card', 'geo', 'note', 'text'])
    for (const s of circ.inside) {
      const stype = String(s.type)
      if (!DOM_TYPES.has(stype)) continue
      // tldraw v5 给每个 HTML 形状挂 data-shape-id：提问卡/导图卡/便签/文字都能量到真实行
      const root = document.querySelector('[data-shape-id="' + String(s.id) + '"]')
        || document.querySelector('[data-explore-card="' + String(s.id) + '"]')
      if (!root) {
        // 形状在视口外没渲染 DOM：退回按属性取整段文字（圈住整卡场景足够用）
        const fallback = shapePlainText({ type: stype, props: (s.props || {}) as Record<string, unknown> })
        if (fallback) found.push(fallback)
        continue
      }
      const leaves = root.querySelectorAll('div, p, li, span, h1, h2, h3, h4')
      leaves.forEach((el) => {
        if (el.childElementCount > 0) return
        const node = Array.from(el.childNodes).find((n) => n.nodeType === 3 && (n.textContent || '').trim())
        if (!node) {
          const t0 = (el.textContent || '').trim()
          if (t0.length > 1 && inBox(el.getBoundingClientRect())) found.push(t0)
          return
        }
        const text = (node.textContent || '').trim()
        if (text.length < 2) return
        const range = document.createRange()
        range.selectNodeContents(node)
        const rects = Array.from(range.getClientRects())
        if (!rects.length) return
        if (rects.length === 1) { if (inBox(rects[0])) found.push(text); return }
        // 多行段落：短标签整句拿走（切半截很难看）；长文才按命中行比例切片
        const hits = rects.map((r, i) => (inBox(r) ? i : -1)).filter((i) => i >= 0)
        if (!hits.length) return
        if (text.length <= 48) { found.push(text); return }
        const first = hits[0], last = hits[hits.length - 1]
        const per = Math.ceil(text.length / rects.length)
        const seg = text.slice(Math.max(0, first * per - 4), Math.min(text.length, (last + 1) * per + per))
        if (seg.trim()) found.push(seg.trim())
      })
    }
    const joined = Array.from(new Set(found)).join(' ')
      .replace(/^Q[｜|]/, '')
      .replace(/[#*·]/g, '')
      .trim()
    return joined.slice(0, 160)
  } catch {
    return ''
  }
}