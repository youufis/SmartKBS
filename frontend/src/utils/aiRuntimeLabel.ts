/**
 * AI 运行状态胶囊的文案规则（与 AiRuntimeChips 分文件：组件模块只导出组件，
 * Fast Refresh 才不会被 react-refresh/only-export-components 判死）。
 */
import { displayUnits } from './studentLabel'

/**
 * 模型名要不要上胶囊：太长就只留档名，名字进明细（悬停/回车都能看全）。
 *
 * 量"占位"而不是量像素 —— 复用 TeacherScopeChips 那把 displayUnits 尺子（CJK 记 1、
 * 其余记 0.55）：行为确定、不受字体影响，不会在某个临界宽度上来回抖动。
 *   · qwen3.7-flash = 7.15  → 显示
 *   · qwen3.5:0.8b  = 6.60  → 显示
 *   · deepseek-v3.2-exp = 9.35 → 宽屏显示、窄窗收起
 *   · qwen3-next-122b-a10b-instruct = 15.95 / qwen2.5-coder:32b-instruct-q4_K_M = 18.15 → 一律收起
 * 窄窗口（992~1200）页头还要和 4~6 个按钮抢位置，预算再收一档。
 */
export const NAME_UNITS_WIDE = 12      // ≥1200px：约 22 个拉丁字符
export const NAME_UNITS_NARROW = 9     // 992~1200px

export function modelFitsChip(active: unknown, wide: boolean): boolean {
  const name = String(active ?? '').trim()
  if (!name) return false
  return displayUnits(name) <= (wide ? NAME_UNITS_WIDE : NAME_UNITS_NARROW)
}
