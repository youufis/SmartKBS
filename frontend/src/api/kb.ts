/** 本地知识库 API（独立命名空间 /api/kb） */
import apiClient from './client'

export interface KbDoc {
  id: number
  name: string
  size: number
  pages: number
  chunks: number
  status: 'pending' | 'indexing' | 'ready' | 'failed' | 'empty' | 'deleted'
  progress: number
  vec_state: 'pending' | 'done' | 'failed' | 'off'
  error?: string
  owner?: string
  folder_id?: number | null
  created_at?: string
  updated_at?: string
  remaining_days?: number
  deleted_by?: string
}

export interface KbStats {
  enabled: boolean
  docs: number
  size_mb: number
  used_mb?: number
  chunks: number
  ready: number
  failed: number
  empty: number
  trash_docs: number
  trash_mb: number
  vec_docs: number
  vec_channels?: { provider: string; model: string; docs: number }[]
  dual_index?: boolean
  local_ready?: { alive: boolean; model_present: boolean; model: string }
  vec_coverage: number
  quota_docs: number
  quota_mb: number
  caps?: {
    extensions: string[]
    max_file_mb: number
    max_total_mb: number
    max_docs: number
    max_pages: number
    trash_days: number
    max_chars: number
  }
  embed?: { provider: string; model: string; dim: number; sig: string }
}

export interface KbAiMode {
  mode: 'kb_direct' | 'kb_local' | 'direct'
  cloud_enabled: boolean
  cloud_ready: boolean
  local_enabled: boolean
  local_ready: boolean
}

export const kbApi = {
  stats: () => apiClient.get<KbStats>('/api/kb/stats').then(r => r.data),
  aiMode: () => apiClient.get<KbAiMode>('/api/kb/ai-mode').then(r => r.data),
  docs: (params: Record<string, unknown>) =>
    apiClient.get('/api/kb/docs', { params }).then(r => r.data),
  status: (ids: number[]) =>
    apiClient.get('/api/kb/docs/status', { params: { ids: ids.join(',') } }).then(r => r.data),
  detail: (id: number) => apiClient.get(`/api/kb/docs/${id}`).then(r => r.data),
  upload: (file: File, onProgress?: (p: number) => void, folderId?: string, forceNew?: boolean) => {
    const fd = new FormData()
    fd.append('file', file, file.name)
    if (folderId && folderId !== 'all' && folderId !== 'none') fd.append('folder_id', folderId)
    else if (folderId === 'none') fd.append('folder_id', '')
    if (forceNew) fd.append('force_new', '1')
    return apiClient.post('/api/kb/upload', fd, {
      timeout: 300000,
      onUploadProgress: (e) => {
        if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100))
      },
    }).then(r => r.data)
  },
  replace: (id: number, file: File, onProgress?: (p: number) => void) => {
    const fd = new FormData()
    fd.append('file', file, file.name)
    return apiClient.post(`/api/kb/docs/${id}/replace`, fd, {
      timeout: 300000,
      onUploadProgress: (e) => {
        if (e.total) onProgress?.(Math.round((e.loaded / e.total) * 100))
      },
    }).then(r => r.data)
  },
  remove: (id: number) => apiClient.delete(`/api/kb/docs/${id}`).then(r => r.data),
  reindex: (id: number) => apiClient.post(`/api/kb/docs/${id}/reindex`).then(r => r.data),
  trash: () => apiClient.get('/api/kb/trash').then(r => r.data),
  restore: (id: number) => apiClient.post(`/api/kb/trash/${id}/restore`).then(r => r.data),
  purge: (id: number, confirmName: string) =>
    apiClient.delete(`/api/kb/trash/${id}`, { params: { confirm_name: confirmName } }).then(r => r.data),
  rebuild: () => apiClient.post('/api/kb/rebuild').then(r => r.data),
  refillVectors: () => apiClient.post('/api/kb/refill-vectors', {}, { timeout: 180000 }).then(r => r.data),
  searchTest: (q: string) => apiClient.post('/api/kb/search-test', { q }, { timeout: 60000 }).then(r => r.data),
  folders: () => apiClient.get('/api/kb/folders').then(r => r.data),
  createFolder: (name: string) => apiClient.post('/api/kb/folders', { name }).then(r => r.data),
  renameFolder: (id: number, name: string) => apiClient.put(`/api/kb/folders/${id}`, { name }).then(r => r.data),
  deleteFolder: (id: number) => apiClient.delete(`/api/kb/folders/${id}`).then(r => r.data),
  moveDoc: (id: number, folderId: number | null) => apiClient.post(`/api/kb/docs/${id}/move`, { folder_id: folderId }).then(r => r.data),
  download: (id: number) =>
    apiClient.get(`/api/kb/docs/${id}/file`, { responseType: 'blob' }).then(r => r.data as Blob),
}
