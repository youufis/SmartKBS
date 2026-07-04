/**
 * 年级/班级 API 服务
 * 统一管理年级/班级数据加载，替代各组件中分散的 apiClient.get('/api/rollcall/grades') 调用
 */
import apiClient from '../api/client'

let _gradesCache: string[] | null = null
let _classesCache: Record<string, string[]> = {}
let _cachedAt = 0
const _CACHE_TTL = 30000  // 30 秒

async function _fetchGrades(): Promise<string[]> {
  const { data } = await apiClient.get('/api/rollcall/grades')
  return Array.isArray(data) ? data : []
}

async function _fetchClasses(grade: string): Promise<string[]> {
  const { data } = await apiClient.get('/api/rollcall/classes', { params: { grade } })
  return Array.isArray(data) ? data : []
}

/** 获取年级列表（带缓存） */
export async function fetchGrades(force = false): Promise<string[]> {
  const now = Date.now()
  if (!force && _gradesCache && now - _cachedAt < _CACHE_TTL) {
    return _gradesCache
  }
  _gradesCache = await _fetchGrades()
  _cachedAt = now
  return _gradesCache
}

/** 获取指定年级的班级列表（带缓存） */
export async function fetchClasses(grade: string, force = false): Promise<string[]> {
  if (!force && _classesCache[grade]) {
    return _classesCache[grade]
  }
  _classesCache[grade] = await _fetchClasses(grade)
  return _classesCache[grade]
}

/** 获取全部年级的班级映射（供 ActivityScopeSelector 和 ShareDialog 复用） */
export async function fetchAllGradeClasses(force = false): Promise<{ grade: string; classes: string[] }[]> {
  const grades = await fetchGrades(force)
  const results = await Promise.all(
    grades.map((g) =>
      fetchClasses(g, force).then((classes) => ({ grade: g, classes })),
    ),
  )
  return results
}

/** 清空缓存 */
export function clearGradeClassCache() {
  _gradesCache = null
  _classesCache = {}
  _cachedAt = 0
}
