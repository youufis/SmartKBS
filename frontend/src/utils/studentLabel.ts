import i18n from 'i18next'

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
  if (/^\d+(?:\s*[,，、\/]\s*\d+)*$/.test(s)) return String(i18n.t('common:classUnit', { class: s }))
  return s
}

/** 教师任教范围: grades="高一|高二" + classes="1,2|3,4" -> "高一1,2班 · 高二3,4班" */
export function teacherScopeText(grades: unknown, classes: unknown): string {
  const gs = String(grades ?? '').split('|').map(x => x.trim()).filter(Boolean)
  const cs = String(classes ?? '').split('|').map(x => x.trim()).filter(Boolean)
  if (!gs.length) return cs.map(classText).filter(Boolean).join(' · ')
  return gs
    .map((g, i) => {
      const unit = classText(cs[i] ?? '')
      if (!unit) return g
      return /^[A-Za-z]/.test(unit) ? `${g} ${unit}` : `${g}${unit}`
    })
    .filter(Boolean)
    .join(' · ')
}

export default studentLabel
