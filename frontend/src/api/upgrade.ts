/**
 * 在线升级 API
 */
import apiClient from './client'

export interface VersionInfo {
  current_version: string
  latest_version: string
  has_update: boolean
  changelog: string[]
  breaking_changes: string[]  // 接口仍返回, 升级页面不再展示(避免对使用者造成困扰)
  release_date: string
  behind_commits: number
  last_checked: string
  git_available: boolean
  git_download_url: string
  git_issues: string[]
  prefetched: boolean
}

export interface UpgradeProgress {
  running: boolean
  task_id: string | null
  step: string
  progress: number
  message: string
  error: string | null
  started_at: string | null
}

export interface UpgradeHistoryItem {
  task_id: string
  from_version?: string
  to_version?: string
  timestamp: string
  admin: string
  client_ip?: string
  status: string
  error?: string
  commits?: number
  changed_files?: string[]
  changelog?: string[]
  /** 被重启打断后由系统对账收口的记录才会带这几个字段 */
  note?: string
  reconciled_from?: string
  reconciled_by?: string
  reconciled_at?: string
  /** 流水线最后走到的阶段（preparing/synced/migrated/deps_ok/unknown） */
  stage_reached?: string
  /** 代码已到位，但数据库迁移/依赖安装未能确认完成 */
  migrations_unverified?: boolean
  /** 管理员是否已人工核对该记录的迁移 */
  migrations_ack?: boolean
}

/** 检测最新版本 */
export async function checkVersion(): Promise<VersionInfo> {
  const { data } = await apiClient.get('/api/system/upgrade/version-check')
  return data
}

/** 创建升级备份 */
export async function createBackup(): Promise<{ status: string; backup_path: string; version: string }> {
  const { data } = await apiClient.post('/api/system/upgrade/backup')
  return data
}

/** 启动增量升级 */
export async function startUpgrade(): Promise<{ status: string; task_id: string }> {
  const { data } = await apiClient.post('/api/system/upgrade/run')
  return data
}

/** 轮询升级进度 */
export async function getUpgradeStatus(): Promise<UpgradeProgress> {
  const { data } = await apiClient.get('/api/system/upgrade/status')
  return data
}

/** 执行回滚 */
export async function rollback(): Promise<{ status: string; message: string }> {
  const { data } = await apiClient.post('/api/system/upgrade/rollback')
  return data
}

/** 取消/重置升级状态（当升级卡死时使用） */
export async function cancelUpgrade(): Promise<{ status: string; message: string }> {
  const { data } = await apiClient.post('/api/system/upgrade/cancel')
  return data
}

/** 获取升级历史（分页） */
export async function getHistory(page = 1, pageSize = 10): Promise<{
  history: UpgradeHistoryItem[]
  total: number
  page: number
  page_size: number
}> {
  const { data } = await apiClient.get('/api/system/upgrade/history', {
    params: { page, page_size: pageSize },
  })
  return data
}

/** 删除单条升级历史 */
export async function deleteHistory(task_id: string): Promise<void> {
  await apiClient.delete(`/api/system/upgrade/history/${task_id}`)
}

/** 确认「对账收口的成功记录」已人工核对过数据库迁移 */
export async function ackMigrations(task_id: string): Promise<{ status: string; message: string }> {
  const { data } = await apiClient.post(`/api/system/upgrade/history/${task_id}/ack-migrations`)
  return data
}
