/** 用户角色的常量与纯函数（与组件分开，避免 fast-refresh 规则报错） */

export const ROLE_ADMIN = 0
export const ROLE_TEACHER = 1
export const ROLE_STUDENT = 2

export const ROLE_LABEL: Record<number, string> = {
  0: '管理员',
  1: '教师',
  2: '普通用户',
}

/** 后端返回的是中文角色名，前端筛选/改角色用数值，这里统一转换 */
export const roleToNumber = (roleName?: string): number => {
  if (roleName === '管理员') return ROLE_ADMIN
  if (roleName === '教师') return ROLE_TEACHER
  return ROLE_STUDENT
}

export const roleColor = (roleName?: string): string => {
  if (roleName === '管理员') return 'red'
  if (roleName === '教师') return 'blue'
  return 'default'
}

export interface ScopeGroup {
  grade: string
  classes: string[]
}

/**
 * 把遗留复合字符串拆成 {年级: [班级]}。
 * 学生是单值（"高一" + "3"），教师可能是 "高一|高二" + "1,2|3,4"，两段按 | 对齐。
 */
export function splitScope(grade?: string, cls?: string): ScopeGroup[] {
  const grades = String(grade || '').split('|').map(s => s.trim()).filter(Boolean)
  const clsGroups = String(cls || '').split('|')
  return grades.map((g, i) => ({
    grade: g,
    classes: (clsGroups[i] || '')
      .split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean),
  }))
}
