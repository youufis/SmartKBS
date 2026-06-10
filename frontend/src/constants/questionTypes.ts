/**
 * 题型配置 — 从后端系统配置加载（管理员可在页面管理）
 * 网络不可用时使用下方硬编码默认值作为 fallback
 *
 * 用法：
 *   import { TYPE_LABELS, TYPE_OPTIONS, loadQuestionTypes } from '../constants/questionTypes'
 *   // 在 App 启动时调用：await loadQuestionTypes()
 *   // 之后 TYPE_LABELS / TYPE_COLORS / TYPE_OPTIONS 自动反映后端最新配置
 */
import apiClient from '../api/client'

/** 颜色轮盘（按顺序分配，超过循环） */
const COLOR_PALETTE = [
  'blue', 'purple', 'orange', 'green', 'cyan', 'magenta', 'volcano',
  'geekblue', 'gold', 'lime',
]

/** 默认值 fallback（后端不可用或未配置时） */
const DEFAULT_TYPES = [
  { key: 'single', label: '单选题' },
  { key: 'multiple', label: '多选题' },
  { key: 'true_false', label: '判断题' },
  { key: 'short', label: '简答题' },
  { key: 'fill', label: '填空题' },
  { key: 'essay', label: '作文' },
  { key: 'subjective', label: '主观题' },
  { key: 'code', label: '编程题' },
]

// ── 导出的可变对象（外部 import 后能实时反映更新） ──
export const TYPE_LABELS: Record<string, string> = {}
export const TYPE_COLORS: Record<string, string> = {}
export const TYPE_OPTIONS: { value: string; label: string }[] = []

function _buildFrom(raw: { key: string; label: string }[]) {
  // 清空并重建
  Object.keys(TYPE_LABELS).forEach((k) => delete TYPE_LABELS[k])
  Object.keys(TYPE_COLORS).forEach((k) => delete TYPE_COLORS[k])
  TYPE_OPTIONS.length = 0
  raw.forEach((t, i) => {
    TYPE_LABELS[t.key] = t.label
    TYPE_COLORS[t.key] = COLOR_PALETTE[i % COLOR_PALETTE.length]
    TYPE_OPTIONS.push({ value: t.key, label: t.label })
  })
}

/** 初始化/刷新题型数据（从后端加载，失败则 fallback）。建议在 App 启动时调用。 */
export async function loadQuestionTypes(): Promise<void> {
  try {
    const { data } = await apiClient.get<{ types: { key: string; label: string }[] }>(
      '/api/config/question-types',
    )
    if (data?.types?.length) {
      _buildFrom(data.types)
      return
    }
  } catch {
    // 忽略错误，使用 fallback
  }
  // 未加载过才用默认值
  if (TYPE_OPTIONS.length === 0) _buildFrom(DEFAULT_TYPES)
}

// ── 模块初始化：使用默认值（避免首次 import 时为空） ──
_buildFrom(DEFAULT_TYPES)
