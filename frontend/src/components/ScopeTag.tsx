/**
 * 活动目标范围标签（年级/班级）。
 *
 * 考试、随堂测验、课堂投票、抢答竞赛、分组讨论、代码练习、对话作业、同步练习
 * 八类活动的列表都用同一个口径展示"这次活动发给谁了"：
 *   任教班级 / 全体学生 / 指定年级班级（高一 1班）/ 指定 N 人
 * 文案与颜色集中在这里，避免各页面各写一份、口径漂移。
 */
import React from 'react'
import { Tag } from 'antd'
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
}

const ScopeTag: React.FC<ScopeTagProps> = ({
  scope = 'teacher_classes', grade, classes, users, placeholder = true,
}) => {
  const { t } = useTranslation('common')

  if (scope === 'individual') {
    const n = String(users || '').split(',').map((s) => s.trim()).filter(Boolean).length
    return <Tag color="green">{t('scopeTargetedN', { n })}</Tag>
  }
  if (scope === 'teacher_classes') return <Tag color="geekblue">{t('scopeTeacherClasses')}</Tag>
  if (scope === 'all') return <Tag color="purple">{t('scopeAll')}</Tag>

  // grade / class（含历史脏数据的其它取值）: 直接展示年级+班级文本
  const txt = [String(grade || '').trim(), classText(String(classes || '').trim())]
    .filter(Boolean).join(' ')
  if (!txt) return placeholder ? <Tag color="geekblue">-</Tag> : null
  return <Tag color="geekblue">{txt}</Tag>
}

export default ScopeTag
