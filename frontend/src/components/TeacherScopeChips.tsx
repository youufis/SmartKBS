/**
 * 教师任教范围一行显示器：放得下就全量，放不下折成计数摘要 + 悬停明细。
 *
 * 2026-10 首页横幅改造：教师带的班一多，"高一1,2,3,4,5,6,7班 · 高二1,...,8班"
 * 能把整行吃掉（3 年级 13 班实测约 766px，而 1440 宽去掉侧栏只剩约 1180px）。
 * 这里按三层降级收敛：
 *   1) 连续班号压缩：高一1–7班，多数教师到这一步就够了；
 *   2) 按学科分组：多学科教师不再把"年级班级"和"学科"各摊成一条清单，班级与学科对得上；
 *   3) 仍然超预算就折成"2 个学科 · 3 个年级 · 28 个班"，明细进 Popover。
 * 折叠用计数阈值判断而不是量像素：行为确定、不受字体影响、不会来回抖动。
 * 数据优先用后端 teacher_scope（与越权校验同源）；旧服务端/桌面端 dist 没有这个字段时，
 * 退回解析 users 那两条竖线字符串，至少横幅不空白。
 */
import React, { useMemo } from 'react'
import { Popover } from 'antd'
import { useTranslation } from 'react-i18next'
import { ExperimentOutlined, TeamOutlined } from '@ant-design/icons'
import type { TeacherScopeGroup } from '../api/dashboard'
import {
  classListText, displayUnits, parseLegacyTeacherScope, scopeGroupText,
  teacherScopePlain, teacherScopeStats,
} from '../utils/studentLabel'

export interface TeacherScopeChipsProps {
  /** 后端 teacher_scope：按学科分组的任教范围（首选数据源） */
  scope?: TeacherScopeGroup[] | null
  /** 兜底：legacy 年级竖线字符串 "高一|高二" */
  legacyGrades?: string | null
  /** 兜底：legacy 班级竖线字符串 "1,2|3,4"，空段 = 整年级 */
  legacyClasses?: string | null
  /** 兜底路径下学科与班级没有对应关系，只能单独挂一条"任教：X、Y" */
  legacySubjects?: string[] | null
  /** 内联预算（显示单元，CJK 记 1、其余记 0.55），超出折叠成计数摘要 */
  maxUnits?: number
  className?: string
  style?: React.CSSProperties
}

const TeacherScopeChips: React.FC<TeacherScopeChipsProps> = ({
  scope, legacyGrades, legacyClasses, legacySubjects, maxUnits = 30, className, style,
}) => {
  const { t } = useTranslation()

  const groups = useMemo<TeacherScopeGroup[]>(() => {
    const s = (scope ?? []).filter(g => (g?.grades ?? []).length > 0)
    return s.length ? s : parseLegacyTeacherScope(legacyGrades, legacyClasses)
  }, [scope, legacyGrades, legacyClasses])

  const inlineText = useMemo(
    () => groups.map(scopeGroupText).filter(Boolean).join(' · '),
    [groups],
  )

  // 结构化数据里学科已经并进每一段，只有兜底路径才需要单独补一条学科清单
  const subjectsText = useMemo(() => {
    if (groups.some(g => String(g.subject ?? '').trim())) return ''
    return (legacySubjects ?? []).map(s => String(s ?? '').trim()).filter(Boolean).join('、')
  }, [groups, legacySubjects])

  const plain = useMemo(() => [
    teacherScopePlain(groups),
    subjectsText ? `${t('teachingLabel')}${subjectsText}` : '',
  ].filter(Boolean).join(' · '), [groups, subjectsText, t])

  if (!inlineText && !subjectsText) return null

  const stats = teacherScopeStats(groups)
  const collapsed = displayUnits(inlineText) > maxUnits
  const summaryParts: string[] = []
  if (collapsed) {
    if (stats.subjects > 1) summaryParts.push(t('scopeStatSubjects', { n: stats.subjects, count: stats.subjects }))
    summaryParts.push(t('scopeStatGrades', { n: stats.grades, count: stats.grades }))
    if (stats.classes) summaryParts.push(t('scopeStatClasses', { n: stats.classes, count: stats.classes }))
    // 整年级没有班号，不单独列一项就会在摘要里凭空消失
    if (stats.wholeGrades) summaryParts.push(t('scopeStatWholeGrades', { n: stats.wholeGrades, count: stats.wholeGrades }))
  }

  const detail = (
    <div className="teacher-scope-detail">
      {groups.map((g, gi) => (
        <div className="teacher-scope-detail-group" key={`s${gi}`}>
          {String(g.subject ?? '').trim()
            ? <div className="teacher-scope-detail-subject">{String(g.subject)}</div>
            : null}
          {(g.grades ?? []).map((gr, idx) => {
            const n = (gr.classes ?? []).length
            return (
              <div className="teacher-scope-detail-row" key={`g${gi}-${idx}`}>
                <span className="teacher-scope-detail-grade">{String(gr.grade_name ?? '')}</span>
                <span className="teacher-scope-detail-classes">
                  {gr.all_classes ? t('allClassesShort') : classListText(gr.classes ?? [])}
                </span>
                {!gr.all_classes && n > 1 && (
                  <span className="teacher-scope-detail-count">{t('scopeStatClasses', { n, count: n })}</span>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )

  const label = (
    <span
      className={className}
      aria-label={plain}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}
    >
      <TeamOutlined />
      <span>{collapsed ? `${t('teacherScopeLabel')} ${summaryParts.join(' · ')}` : inlineText}</span>
      {subjectsText ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <ExperimentOutlined />
          {`${t('teachingLabel')}${subjectsText}`}
        </span>
      ) : null}
    </span>
  )

  if (!collapsed) return label
  return (
    <Popover
      trigger={['hover', 'click']}
      placement="bottomRight"
      title={t('teacherScopeDetailTitle')}
      content={detail}
    >
      {label}
    </Popover>
  )
}

export default TeacherScopeChips
