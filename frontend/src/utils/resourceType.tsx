/**
 * 资源类型元数据（前端侧）—— 与 backend/resource_registry.py 一一对应。
 *
 * 以前类型清单在前端下拉、资源卡片、后端白名单里各写一份（连 i18n 键都是两套），
 * 改一处漏五处：全站把「任务」改成「作业」了，绑定框里还叫「任务」；
 * 同步练习早就有正式练习任务（带判分/成绩/AI 分析），绑定框却只能绑它的 HTML 壳。
 * 现在清单由 GET /api/curriculum/resource-types 下发，本文件只做三件事：
 *   1) icon 名 → 图标组件的映射；2) 接口没回来时的兜底清单；3) 展示名清洗。
 */
import React from 'react'
import {
  CheckCircleOutlined, DownloadOutlined, FileTextOutlined, FormOutlined,
  PlayCircleOutlined, QuestionCircleOutlined, ScheduleOutlined, TeamOutlined,
} from '@ant-design/icons'

/** 后端下发的类型描述 */
export interface ResourceTypeMeta {
  key: string
  label_key: string
  group: string
  icon: string
  order?: number
  count?: number
}

/** 图标名（后端不引组件，只给名字） */
export const RESOURCE_ICON_MAP: Record<string, React.ReactNode> = {
  file: <FileTextOutlined />,
  download: <DownloadOutlined />,
  check: <CheckCircleOutlined />,
  practice: <ScheduleOutlined />,
  quiz: <FormOutlined />,
  form: <FormOutlined />,
  team: <TeamOutlined />,
  question: <QuestionCircleOutlined />,
  play: <PlayCircleOutlined />,
}

export function resourceIcon(key: string): React.ReactNode {
  return RESOURCE_ICON_MAP[key] || <FileTextOutlined />
}

/** 服务端不可用（老版本后端）时的兜底清单，顺序与注册表一致 */
export const FALLBACK_RESOURCE_TYPES: ResourceTypeMeta[] = [
  { key: 'html', label_key: 'resourceType.html', group: 'courseware', icon: 'file', order: 10 },
  { key: 'download', label_key: 'resourceType.download', group: 'courseware', icon: 'download', order: 20 },
  { key: 'task', label_key: 'resourceType.task', group: 'practice', icon: 'check', order: 30 },
  { key: 'practice', label_key: 'resourceType.practice', group: 'practice', icon: 'practice', order: 40 },
  { key: 'interaction_quiz', label_key: 'resourceType.interaction_quiz', group: 'practice', icon: 'quiz', order: 50 },
  { key: 'exam', label_key: 'resourceType.exam', group: 'assessment', icon: 'form', order: 60 },
  { key: 'discussion', label_key: 'resourceType.discussion', group: 'interaction', icon: 'team', order: 70 },
  // 历史绑定行里可能出现「试题」，虽不在候选清单上架，标签与图标仍要能显示
  { key: 'question', label_key: 'resourceType.question', group: 'practice', icon: 'question', order: 900 },
]

/** 类型标签：优先 resourceType.<key>，兼容后端给了别的键，最后退回原始 key */
export function resourceTypeLabel(
  t: (key: string) => string,
  key: string,
  labelKey?: string,
): string {
  const candidates = [labelKey, `resourceType.${key}`].filter(Boolean) as string[]
  for (const k of candidates) {
    const v = t(k)
    if (v && v !== k) return v
  }
  return key
}

/** 生成时间戳片段：AI 产物文件名里会带 _20260616_102943 */
const TIMESTAMP_RE = /(_\d{8}_\d{6})(?=_|\.|$)/

/**
 * 展示名清洗：去掉 AI 产物的时间戳与 .html 后缀。
 * `1_技术的历史与时代变革_20260627_063054_练习` → `1_技术的历史与时代变革_练习`
 * （知识点前缀留着有用：它同时是「这份资源就是给本知识点做的」的依据）
 */
export function prettyResourceName(name: string): string {
  if (!name) return ''
  const cleaned = name
    .replace(TIMESTAMP_RE, '')
    .replace(/\.html?$/i, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || name
}

/** 网页课件的内容小类（后端从 AI 产物文件名后缀判断，与 resource_registry 同口径） */
export const SUB_KIND_KEYS: Record<string, string> = {
  courseware: 'subKind.courseware',
  animation: 'subKind.animation',
  quiz: 'subKind.quiz',
  practice: 'subKind.practice',
  podcast: 'subKind.podcast',
  interactive: 'subKind.interactive',
  custom: 'subKind.custom',
  activity: 'subKind.activity',
  handout: 'subKind.handout',
  other: 'subKind.other',
}

export function subKindLabel(t: (key: string) => string, kind: string): string {
  const k = SUB_KIND_KEYS[kind]
  return k ? t(k) : kind
}

/**
 * 来源标签（同步练习 / 试题有这一维，别的类型没有 source 字段）。
 * 卡片上只标"不普通"的那几种：教师自己在同步练习页建的（teacher/manual）是默认情况，
 * 挂个「手动创建」标签既占位又让人看不懂（老师会问"手动创建是什么意思"），所以只在
 * 分类栏里当筛选项用，卡片上不出现。
 */
const SOURCE_KEYS: Record<string, string> = {
  smart: 'source.smart',
  ai: 'source.smart',
  bank: 'source.bank',
  wrong_book: 'source.wrongBook',
  system: 'source.system',
  teacher: 'source.teacher',
  manual: 'source.teacher',
}

/** 筛选项用：每个取值都要有名字 */
export function sourceLabel(t: (key: string) => string, source: string): string {
  const k = SOURCE_KEYS[source]
  return k ? t(k) : source
}

/** 卡片用：默认来源（教师自己创建）返回空串，不打标签 */
export function sourceBadgeLabel(t: (key: string) => string, source: string): string {
  if (!source || source === 'teacher' || source === 'manual') return ''
  return sourceLabel(t, source)
}
