/**
 * 探索画布 · 系统内置范例（模板库里常驻的"起步页"）
 *
 * 只存形状清单，不存 tldraw 快照：tldraw 升级不会让范例打开成空白页。
 * 使用时：新建一张空画布 → 把 shapes 落进去 → 之后就是学生自己的画布。
 */
import type { ShapeSpec } from '../api/explore'

export interface BuiltinTemplate {
  id: string
  emoji: string
  titleKey: string
  descKey: string
  /** 新建画布的默认名（中文，标题可再改） */
  defaultTitle: string
  shapes: ShapeSpec[]
}

const card = (x: number, y: number, w: number, h: number, text: string,
              color = 'black', fill = 'none', size = 'm'): ShapeSpec => ({
  type: 'geo',
  x, y,
  props: { geo: 'rectangle', w, h, color, fill, size, text },
})

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'problem-wall',
    emoji: '❓',
    titleKey: 'builtinProblemTitle',
    descKey: 'builtinProblemDesc',
    defaultTitle: '问题收集墙',
    shapes: [
      card(0, 0, 520, 80, '今天我想弄明白什么？', 'blue', 'semi', 'xl'),
      card(0, 120, 240, 160, '问题 1：', 'grey', 'none'),
      card(280, 120, 240, 160, '问题 2：', 'grey', 'none'),
      card(0, 310, 240, 160, '问题 3：', 'grey', 'none'),
      card(280, 310, 240, 160, '（把新问题往下堆）', 'light-blue', 'none'),
    ],
  },
  {
    id: 'inquiry-note',
    emoji: '🧭',
    titleKey: 'builtinInquiryTitle',
    descKey: 'builtinInquiryDesc',
    defaultTitle: '探究笔记',
    shapes: [
      card(0, 0, 560, 72, '探究主题：', 'green', 'semi', 'xl'),
      card(0, 110, 180, 240, '我已知\n\n• \n• ', 'light-green', 'none'),
      card(195, 110, 180, 240, '我想问\n\n• \n• ', 'light-blue', 'none'),
      card(390, 110, 180, 240, '我查到\n\n• \n• ', 'light-violet', 'none'),
      card(0, 380, 560, 90, '一句话结论：', 'yellow', 'none', 'l'),
    ],
  },
  {
    id: 'lesson-board',
    emoji: '📚',
    titleKey: 'builtinLessonTitle',
    descKey: 'builtinLessonDesc',
    defaultTitle: '课堂板书起步页',
    shapes: [
      card(0, 0, 640, 76, '课题：', 'blue', 'semi', 'xl'),
      card(0, 100, 310, 96, '学习目标\n1. \n2. ', 'light-blue', 'none'),
      card(330, 100, 310, 96, '关键概念\n• \n• ', 'light-green', 'none'),
      card(0, 215, 310, 130, '例题 / 图示\n（把 AI 生成的图示贴到这里）', 'grey', 'none'),
      card(330, 215, 310, 130, '课堂练习\n1. \n2. ', 'orange', 'none'),
      card(0, 365, 640, 80, '课后任务：', 'yellow', 'none', 'l'),
    ],
  },
]
