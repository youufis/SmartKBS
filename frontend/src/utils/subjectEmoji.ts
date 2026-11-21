/**
 * 学科 → emoji：全站唯一一份映射。
 *
 * 以前 RewardPage、ShowcaseCard、CurriculumPage（两处）各抄了一份，
 * 新增学科只改一处、其余页面继续吃默认图标；现在都从这里取。
 * 表里没有的学科按名称 hash 稳定分配，无需改代码即可有图标。
 */

const SUBJECT_EMOJI_MAP: Record<string, string> = {
  信息科技: '💻',
  通用技术: '🔧',
  人工智能: '🤖',
  // 信息技术 = 信息科技的历史写法（与后端 _SUBJECT_FAMILY 同族），保留别名映射
  信息技术: '💻',
  通用: '🔧',
  数学: '📐',
  语文: '📖',
  英语: '🌍',
  物理: '⚛️',
  化学: '🧪',
  生物: '🧬',
  历史: '📜',
  地理: '🌏',
  政治: '⚖️',
  // 校本/选修里最常新开的几门：写死比 hash 靠谱（hash 曾把「书法」配成 🎵、「机器人」和
  // 「科技创新」撞成同一个 🧠）。字形均为 Emoji ≤ 2020，Win10 的 Segoe UI Emoji 可渲染。
  机器人: '🦾',
  编程: '⌨️',
  书法: '✍️',
  心理健康: '🌈',
  音乐: '🎶',
  美术: '🖼️',
}

// 兜底池 24 个：只用 Emoji ≤ 2020 早期就稳定、Win10/Win11 都能渲染的字形
// （🪐🫧🩺 这类 2021+ 的在老 Segoe UI Emoji 上会开天窗，别往这里加）
// 池子越大，名称 hash 撞车的概率越低：10 个时「机器人」和「人工智能初步」同为 📚
const FALLBACK_EMOJIS = [
  '📚', '🔬', '🎨', '🎵', '🏛️', '🧮', '🗺️', '🔭', '⚗️', '🖥️', '🧭', '🎭',
  '🧠', '🛰️', '🚀', '🌱', '⚙️', '🧩', '🖌️', '🥁', '🏹', '⚽', '🎬', '🧵',
]

/** 名称为空时给一个中性图标，避免 hash 到 📚 显得像"有内容" */
export function getSubjectEmoji(subject: string): string {
  const name = (subject || '').trim()
  if (!name) return '📂'
  if (SUBJECT_EMOJI_MAP[name]) return SUBJECT_EMOJI_MAP[name]
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return FALLBACK_EMOJIS[hash % FALLBACK_EMOJIS.length]
}
