/**
 * 活动目标范围标签（年级/班级）。
 *
 * 考试、随堂测验、课堂投票、抢答竞赛、分组讨论、代码练习、对话作业、同步练习
 * 八类活动的列表都用同一个口径展示"这次活动发给谁了"：
 *   任教班级 / 全体学生 / 指定年级班级（高一 1班）/ 指定 N 人
 * 文案与颜色集中在这里，避免各页面各写一份、口径漂移。
 */
import React from 'react'
import { Tag, Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import { classText } from '../utils/studentLabel'

export interface ScopeTagProps {
  /** 目标范围: teacher_classes(默认) / all / grade / class / individual */
  scope?: string
  /** 目标年级, 多个用逗号分隔 */
  grade?: string
  /** 目标班级, 多个用逗号分隔(可能是纯数字, 交给 classText 补"班") */
  classes?: string
  /** 指定学生(individual 时用来数人数), 逗号分隔的用户名 */
  users?: string
  /** 无范围信息时是否显示占位 "-"(默认 true) */
  placeholder?: boolean
  /** 文本最大宽度(px), 超出截断并悬停看全文; 默认 150 */
  maxWidth?: number
  /** 'scope'=按学生范围语义渲染(默认); 'text'=只渲染年级班级文本(公告等另有角色维度的场景) */
  variant?: 'scope' | 'text'
}

/** 拆分逗号/顿号/斜杠分隔的多值并去重（"高一,高二" → ["高一","高二"]） */
function splitMulti(v: unknown): string[] {
  const out: string[] = []
  for (const part of String(v ?? '').split(/[,，、/]/)) {
    const s = part.trim()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

/**
 * 把目标范围拼成一行可读文本。
 *
 * 关键点：班级名常自带年级前缀（"高一6班"），此时再拼 target_grade 就成了
 * "高一,高二 高一6班,高一7班" 这种又长又啰嗦的串；只要每个班级都自带年级，
 * 就只显示班级本身。此外多值统一用「、」连接，比英文逗号紧凑也好读。
 */
export function formatScopeText(grade?: string, classes?: string): string {
  const grades = splitMulti(grade)
  const classList = splitMulti(classes).map((c) => classText(c)).filter(Boolean)

  const classesCarryGrade = classList.length > 0
    && classList.every((c) => grades.some((g) => c.startsWith(g)))

  if (classesCarryGrade) return classList.join('、')
  return [grades.join('、'), classList.join('、')].filter(Boolean).join(' ')
}

const ScopeTag: React.FC<ScopeTagProps> = ({
  scope = 'teacher_classes', grade, classes, users, placeholder = true, maxWidth = 150, variant = 'scope',
}) => {
  const { t } = useTranslation('common')

  if (variant === 'text') {
    const onlyText = formatScopeText(grade, classes)
    if (!onlyText) return placeholder ? <Tag color="geekblue">-</Tag> : null
    return (
      <Tooltip title={onlyText} placement="topLeft">
        <Tag color="geekblue" style={{
          maxWidth, marginInlineEnd: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle',
        }}>{onlyText}</Tag>
      </Tooltip>
    )
  }

  if (scope === 'individual') {
    const n = String(users || '').split(',').map((s) => s.trim()).filter(Boolean).length
    return <Tag color="green">{t('scopeTargetedN', { n })}</Tag>
  }
  if (scope === 'teacher_classes') return <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>{t('scopeTeacherClasses')}</Tag>
  if (scope === 'all') return <Tag color="purple">{t('scopeAll')}</Tag>

  // grade / class（含历史脏数据的其它取值）: 展示年级+班级文本
  const txt = formatScopeText(grade, classes)
  if (!txt) return placeholder ? <Tag color="geekblue">-</Tag> : null

  // 多班级时文本会很长, 一律限宽截断, 悬停看全文
  return (
    <Tooltip title={txt} placement="topLeft">
      <Tag
        color="geekblue"
        style={{
          maxWidth, marginInlineEnd: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle',
        }}
      >
        {txt}
      </Tag>
    </Tooltip>
  )
}

export default ScopeTag
