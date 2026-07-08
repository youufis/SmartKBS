/**
 * 技能系统 API 客户端
 * 
 * 提供技能文档的查询、启用/禁用管理接口
 */
import apiClient from './client'

export interface SkillInfo {
  name: string
  version: string
  display_name: string
  description: string
  type: string        // core / domain / adapter
  tags: string[]
  compatible_with: string[]
  enabled: boolean
  priority: number
  requires: string[]
  conflicts_with: string[]
  sections: string[]
  file_path: string
  parse_error: string | null
}

export interface SkillDetail extends SkillInfo {
  raw_content: string
}

export interface SkillListResponse {
  skills: SkillInfo[]
  total: number
  errors: string[]
}

export interface EnabledSkillsResponse {
  enabled_skills: string[]
  skill_details: SkillInfo[]
}

export interface ValidateResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

/**
 * 获取所有可用技能列表
 */
export async function fetchSkills(): Promise<SkillListResponse> {
  const res = await apiClient.get('/api/skills')
  return res.data
}

/**
 * 获取单个技能详情
 */
export async function fetchSkillDetail(name: string): Promise<SkillDetail> {
  const res = await apiClient.get(`/api/skills/${encodeURIComponent(name)}`)
  return res.data
}

/**
 * 获取已启用的技能列表
 */
export async function fetchEnabledSkills(): Promise<EnabledSkillsResponse> {
  const res = await apiClient.get('/api/skills/enabled')
  return res.data
}

/**
 * 更新已启用的技能列表
 */
export async function updateEnabledSkills(skillNames: string[]): Promise<{ enabled_skills: string[]; message: string }> {
  const res = await apiClient.put('/api/skills/enabled', { enabled_skills: skillNames })
  return res.data
}

/**
 * 重新加载技能文档
 */
export async function reloadSkills(): Promise<{ loaded: number; errors: string[]; message: string }> {
  const res = await apiClient.post('/api/skills/reload')
  return res.data
}

/**
 * 验证技能组合
 */
export async function validateSkills(skillNames: string[]): Promise<ValidateResult> {
  const res = await apiClient.post('/api/skills/validate', { enabled_skills: skillNames })
  return res.data
}
