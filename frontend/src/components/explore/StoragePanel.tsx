/**
 * 探索画布 · 素材存储（管理员，只读）
 *
 * 只有一行概览：清理全自动（每日定时任务），管理员需要知道的就四个数——
 * 在用多少、回收站多少、待清理多少、容量水位。回收站/清单等明细按需再开，
 * 不占版面（接口仍保留：/storage/trash、/storage/manifest、/storage/restore）。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Tooltip } from 'antd'
import { message } from '../../utils/feedback'
import { ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { storageStats, type StorageStats } from '../../api/explore'

const fmtBytes = (n: number): string => {
  if (!n) return '0 B'
  const mb = n / 1024 / 1024
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB'
  if (mb >= 1) return mb.toFixed(1) + ' MB'
  return Math.max(1, Math.round(n / 1024)) + ' KB'
}

const StoragePanel: React.FC = () => {
  const { t } = useTranslation('explore')
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [denied, setDenied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setStats(await storageStats())
      setDenied(false)
    } catch (e: any) {
      if (e?.response?.status === 403) setDenied(true)
      else message.error(e?.response?.data?.detail || t('storageLoadFail'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  if (denied) return <Alert type="info" showIcon message={t('storageAdminOnly')} />

  const s = stats
  const num = { fontWeight: 600, color: 'var(--text-primary, #222)' } as const

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 18, fontSize: 12, color: 'var(--text-secondary)' }}>
      <span>{t('storageActive')} <b style={num}>{s?.active_count ?? 0}</b> {fmtBytes(s?.active_bytes ?? 0)}</span>
      <span>{t('storageTrashFiles')} <b style={num}>{s?.trash_files ?? 0}</b> {fmtBytes(s?.trash_bytes ?? 0)}</span>
      <span>{t('storageOrphan')} <b style={{ ...num, color: (s?.orphan_candidates ?? 0) > 0 ? '#d46b08' : num.color }}>{s?.orphan_candidates ?? 0}</b></span>
      <span>{t('storageWatermark')} <b style={{ ...num, color: s?.over_watermark ? '#cf1322' : num.color }}>{s?.watermark_mb ?? 0} MB</b></span>
      <Tooltip title={t('statsRefresh')}>
        <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
      </Tooltip>
    </div>
  )
}

export default StoragePanel
