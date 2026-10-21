import i18n from 'i18next'
import type { TeacherScopeGrade, TeacherScopeGroup } from '../api/dashboard'

/**
 * 学生身份统一展示: "学号 姓名（年级·班级）"
 * 后端各管理面已统一补齐 name/grade/class_name(或 student_ 前缀版本), 这里容错取用,
 * 缺字段时自动降级, 不会出现空括号; 数字班级("1")补成"1班"。
 */
export type Studentish = {
  username?: string | null; student_username?: string | null; student?: string | null
  name?: string | null; student_name?: string | null
  grade?: string | null; student_grade?: string | null
  class_name?: string | null; student_class_name?: string | null; cls?: string | null
}

const pick = (...vs: Array<string | null | undefined>) => {
  for (const v of vs) { const s = String(v ?? '').trim(); if (s) return s }
  return ''
}

export function studentLabel(
  s?: Studentish | null,
  opts?: { withNo?: boolean; withClass?: boolean },
): string {
  if (!s) return ''
  const no = pick(s.student_username, s.username, s.student)
  const name = pick(s.student_name, s.name) || no
  const grade = pick(s.student_grade, s.grade)
  let cls = pick(s.student_class_name, s.class_name, s.cls)
  if (/^\d+$/.test(cls)) cls = `${cls}班`
  const withNo = opts?.withNo !== false
  const head = withNo && no && name !== no ? `${no} ${name}` : (withNo ? (no || name) : name)
  let where = cls || grade
  if (grade && cls && !cls.startsWith(grade)) where = `${grade}·${cls}`
  if (opts?.withClass === false) where = ''
  return where && head ? `${head}（${where}）` : (head || where)
}

/** 班级显示: 纯数字(如 "1")补全为 "1班"/"Class 1"; 已含"班"或年级前缀则原样返回 */
export function classText(v: unknown): string {
  const s = String(v ?? '').trim()
  if (!s) return ''
  // 支持单个或逗号/顿号分隔的数字班级: "1" / "1,2,3" / "1、2"
  // 字符类里的 "/" 不用转义（eslint no-useless-escape）
  if (/^\d+(?:\s*[,，、/]\s*\d+)*$/.test(s)) return String(i18n.t('common:classUnit', { class: s }))
  return s
}

/**
 * 教师任教范围显示（2026-10 改造）。
 *
 * 数据口径：后端 teacher_scope（按学科分组，班级与学科的对应关系不丢，整年级用 all_classes 表达）；
 * legacy 竖线字符串只作为旧服务端/桌面端 dist 的兜底，解析成同一种结构后共用一套渲染。
 * 显示三层降级：连续班号压缩 -> 按学科分组 -> 超预算折叠（折叠判定在 TeacherScopeChips）。
 */

/** 显示宽度估算：CJK/全角记 1、其余记 0.55。用它判预算而不是量像素，避免布局来回抖动 */
export function displayUnits(s: unknown): number {
  let n = 0
  for (const ch of String(s ?? '')) {
    n += /[\u2e80-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 1 : 0.55
  }
  return Math.round(n * 100) / 100
}

/** 连续班号压缩：["1","2","3","7"] -> "1–3、7"；非数字班名去重后接在数字段之后 */
export function compressClassRuns(classes: Array<string | number | null | undefined>): string {
  const nums: number[] = []
  const rest: string[] = []
  for (const raw of classes ?? []) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    if (/^\d+$/.test(s)) {
      const n = Number(s)
      if (!nums.includes(n)) nums.push(n)
    } else if (!rest.includes(s)) {
      rest.push(s)
    }
  }
  nums.sort((a, b) => a - b)
  const parts: string[] = []
  let i = 0
  while (i < nums.length) {
    let j = i
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j += 1
    parts.push(j > i ? String(i18n.t('common:classRange', { from: nums[i], to: nums[j] })) : String(nums[i]))
    i = j + 1
  }
  return [...parts, ...rest].join('、')
}

/** 班级清单显示文本：先压缩连续号段再套班；只有一个班时退回单数写法 */
export function classListText(classes: Array<string | number | null | undefined>): string {
  const list = (classes ?? []).map(x => String(x ?? '').trim()).filter(Boolean)
  if (!list.length) return ''
  if (list.length === 1) return classText(list[0])
  return String(i18n.t('common:classUnitMany', { classes: compressClassRuns(list) }))
}

/** 一个年级段："高一1–7班"；整年级任教："高一全年级"（不再显示成光秃秃的年级名） */
export function gradeScopeText(g?: TeacherScopeGrade | null): string {
  if (!g) return ''
  const name = String(g.grade_name ?? '').trim()
  if (g.all_classes) return name ? String(i18n.t('common:allGradeClasses', { grade: name })) : ''
  const list = classListText(g.classes ?? [])
  if (!list) return name
  return /^[A-Za-z]/.test(list) ? `${name} ${list}` : `${name}${list}`
}

/**
 * 一个学科组："通用技术：高一1–7班，高二1–8班"；未登记学科时就只剩年级串。
 *
 * 年级之间用"，"而不是"、"：班号之间已经是"、"（离散班号如"高一1、3、5班"），
 * 再拿"、"连年级就会读成"…13班、高二2…"，看不出年级在哪里换行。
 */
export function scopeGroupText(g?: TeacherScopeGroup | null): string {
  if (!g) return ''
  const grades = (g.grades ?? []).map(gradeScopeText).filter(Boolean).join(String(i18n.t('common:scopeGradeSep')))
  const subject = String(g.subject ?? '').trim()
  if (!subject) return grades
  return grades ? String(i18n.t('common:scopeSubjectLabel', { subject, grades })) : subject
}

/** 结构化任教范围 -> 一行纯文本（折叠态的无障碍标签、纯文本导出、日志共用这一个口径） */
export function teacherScopePlain(scope?: TeacherScopeGroup[] | null): string {
  return (scope ?? []).map(scopeGroupText).filter(Boolean).join(' · ')
}

/** 折叠态计数：整年级单独计一项 —— 它没有具体班号，算进班级数会凭空少一截 */
export function teacherScopeStats(scope?: TeacherScopeGroup[] | null) {
  const subjects = new Set<string>()
  const grades = new Set<string>()
  const classes = new Set<string>()
  let wholeGrades = 0
  for (const grp of scope ?? []) {
    const subject = String(grp.subject ?? '').trim()
    if (subject) subjects.add(subject)
    for (const g of grp.grades ?? []) {
      const name = String(g.grade_name ?? '').trim()
      if (name) grades.add(name)
      if (g.all_classes) { wholeGrades += 1; continue }
      for (const c of g.classes ?? []) {
        const s = String(c ?? '').trim()
        if (s) classes.add(`${name}|${s}`)
      }
    }
  }
  return { subjects: subjects.size, grades: grades.size, classes: classes.size, wholeGrades }
}

/**
 * legacy 竖线字符串 -> 结构化范围：grades="高一|高二" + classes="1,2|3,4"。
 *
 * 班级段不能先 filter(Boolean)："高一|高二" + "|1,2" 是高一整年级、高二 1-2 班，
 * 丢掉空段会让后面每个年级都错位一格（原 teacherScopeText 的下标 bug，一并修掉）。
 */
export function parseLegacyTeacherScope(grades: unknown, classes: unknown): TeacherScopeGroup[] {
  const gs = String(grades ?? '').split('|').map(x => x.trim()).filter(Boolean)
  const cs = String(classes ?? '').split('|')
  if (!gs.length) return []
  return [{
    subject: '',
    grades: gs.map((g, i) => {
      const tokens = (cs[i] ?? '').split(/[,，、]/).map(x => x.trim()).filter(Boolean)
      return { grade_name: g, all_classes: tokens.length === 0, classes: tokens }
    }),
  }]
}

export default studentLabel
