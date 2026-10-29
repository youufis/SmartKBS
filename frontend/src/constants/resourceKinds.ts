/**
 * 网页资源「内容类型」（小类）清单 —— 以后端为唯一来源。
 *
 * 为什么要这个文件：小类的值一度散在后端映射表、前端键表、两份语言包和两处界面判定里，
 * 加一类就漏一处 —— 界面上先把 AI 课件显示成「其它网页」，后来又露出裸键 kind.courseware。
 * 现在唯一清单由 GET /api/resources/kinds 下发；前端语言包只负责「更好的文案」，
 * 没命中就用后端给的标签，再没有就显示原始值 —— 键路径不可能再漏到界面上。
 *
 * 写法与 constants/questionTypes.ts 一致：模块级可变对象 + 启动时 load + 失败回落默认。
 */
import apiClient from '../api/client'

export interface ResourceKind { key: string; label: string }

/** 兜底清单（与 backend/resource_registry.py 的 SUBKIND_LABELS 同口径） */
const DEFAULT_KINDS: ResourceKind[] = [
  { key: 'courseware', label: '课件' },
  { key: 'animation', label: '动画讲解' },
  { key: 'quiz', label: '互动答题' },
  { key: 'practice', label: '章节练习' },
  { key: 'podcast', label: '播客' },
  { key: 'interactive', label: '实验交互' },
  { key: 'custom', label: '自定义页面' },
  { key: 'activity', label: '互动活动' },
  { key: 'handout', label: '讲义纲要' },
  { key: 'other', label: '未归类网页' },
]

/** key -> 标签（后端下发；语言包命中时优先用语言包） */
export const KIND_LABELS: Record<string, string> = {}

function _buildFrom(raw: ResourceKind[]) {
  Object.keys(KIND_LABELS).forEach((k) => delete KIND_LABELS[k])
  raw.forEach((k) => { if (k?.key) KIND_LABELS[k.key] = k.label || k.key })
}

/** 这个值是不是「内容类型」——界面据此决定查 subKind.* 还是 kind.*，不再各自硬列名单 */
export function isResourceKind(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(KIND_LABELS, key)
}

/** 后端标签；未知值原样返回，绝不返回键路径 */
export function resourceKindLabel(key: string): string {
  return KIND_LABELS[key] || key
}

/** 拉取唯一清单（失败就用兜底）。建议在 App 启动时调用。 */
export async function loadResourceKinds(): Promise<void> {
  try {
    const { data } = await apiClient.get<{ kinds: ResourceKind[] }>('/api/resources/kinds')
    if (data?.kinds?.length) {
      _buildFrom(data.kinds)
      return
    }
  } catch {
    // 网络/权限异常：用兜底清单，界面照常能显示
  }
}

// 模块初始化：先用兜底值，避免首次 import 时为空
_buildFrom(DEFAULT_KINDS)