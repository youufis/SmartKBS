/**
 * 在线升级 API
 */
import apiClient from './client'

export interface VersionInfo {
  current_version: string
  latest_version: string
  has_update: boolean
  changelog: string[]
  breaking_changes: string[]
  release_date: string
  behind_commits: number
  last_checked: string
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
  status: string
  error?: string
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

/** 获取升级历史 */
export async function getHistory(): Promise<{ history: UpgradeHistoryItem[] }> {
  const { data } = await apiClient.get('/api/system/upgrade/history')
  return data
}
