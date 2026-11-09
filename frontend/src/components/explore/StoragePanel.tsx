/**
 * 探索画布 · 素材存储面板（管理员）
 *
 * 口径：清理只有"自动"一条路——后端每日 EXPLORE_SWEEP_HOUR 跑一轮
 * （孤儿素材移入回收站，满 trash_days 天物理删除）。本面板只做查看与还原，
 * 不提供手动清理按钮，避免误触把学生正在用的作品清掉。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Descriptions, Row, Statistic, Table, Tag, Tooltip, message } from 'antd'
import { CloudDownloadOutlined, DeleteOutlined, ReloadOutlined, UndoOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import {
  restoreTrash, storageManifest, storageStats, storageTrash,
  type StorageStats, type TrashData, type TrashItem,
} from '../../api/explore'

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
  const [trash, setTrash] = useState<TrashData | null>(null)
  const [loading, setLoading] = useState(false)
  const [manifestDay, setManifestDay] = useState('')
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [denied, setDenied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, tr] = await Promise.all([storageStats(), storageTrash()])
      setStats(s)
      setTrash(tr)
      setDenied(false)
    } catch (e: any) {
      if (e?.response?.status === 403) setDenied(true)
      else message.error(e?.response?.data?.detail || t('storageLoadFail'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { void load() }, [load])

  const onRestore = async (filename: string) => {
    try {
      await restoreTrash(filename)
      message.success(t('storageRestored'))
      void load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('storageRestoreFail'))
    }
  }

  const onManifest = async (day: string) => {
    if (!day) return
    setManifestLoading(true)
    try {
      setManifest(await storageManifest(day))
    } catch (e: any) {
      setManifest(null)
      message.warning(e?.response?.data?.detail || t('storageManifestEmpty'))
    } finally {
      setManifestLoading(false)
    }
  }

  if (denied) {
    return <Alert type="info" showIcon message={t('storageAdminOnly')} />
  }

  const s = stats
  const entries = (manifest?.entries as { rule?: string; filename?: string; title?: string; dry?: boolean }[] | undefined) || []

  return (
    <div style={{ paddingTop: 4 }}>
      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 14 }}
        message={t('storageAutoNote', { hour: s?.sweep_hour ?? 3 })}
        description={t('storageAutoDesc', {
          orphan: s?.orphan_days ?? 30,
          trash: s?.trash_days ?? 14,
          dry: s?.dry_run ? t('storageDryOn') : t('storageDryOff'),
        })}
      />

      <Row gutter={12} style={{ marginBottom: 14 }}>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title={t('storageActive')} value={s?.active_count ?? 0}
            suffix={<span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{fmtBytes(s?.active_bytes ?? 0)}</span>} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title={t('storageTrashFiles')} value={s?.trash_files ?? 0}
            suffix={<span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{fmtBytes(s?.trash_bytes ?? 0)}</span>} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title={t('storageOrphan')} value={s?.orphan_candidates ?? 0}
            valueStyle={{ color: (s?.orphan_candidates ?? 0) > 0 ? '#d46b08' : undefined }} /></Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small"><Statistic title={t('storageWatermark')} value={s?.watermark_mb ?? 0} suffix="MB"
            valueStyle={{ color: s?.over_watermark ? '#cf1322' : undefined }} /></Card>
        </Col>
      </Row>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>{t('storageTrashTitle')}</b>
        <Tag color="default">{t('storageKeepDays', { n: trash?.keep_days ?? s?.trash_days ?? 14 })}</Tag>
        <div style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('statsRefresh')}</Button>
      </div>
      <Table
        rowKey="filename"
        size="small"
        loading={loading}
        dataSource={trash?.items || []}
        locale={{ emptyText: t('storageTrashEmpty') }}
        pagination={(trash?.items?.length || 0) > 10 ? { pageSize: 10, showSizeChanger: false } : false}
        columns={[
          { title: t('storageColFile'), dataIndex: 'filename', key: 'f',
            render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span> },
          { title: t('storageColSize'), dataIndex: 'bytes', key: 'b', width: 90, render: (v: number) => fmtBytes(v) },
          { title: t('storageColBatch'), dataIndex: 'batch', key: 'g', width: 110,
            render: (v: string) => <Tag>{v.slice(0, 4)}-{v.slice(4, 6)}-{v.slice(6, 8)}</Tag> },
          { title: t('storageColTime'), dataIndex: 'trashed_at', key: 't', width: 160 },
          { title: '', key: 'op', width: 90,
            render: (_: unknown, r: TrashItem) => (
              <Tooltip title={t('storageRestoreTip')}>
                <Button size="small" type="link" icon={<UndoOutlined />} onClick={() => void onRestore(r.filename)}>
                  {t('storageRestore')}
                </Button>
              </Tooltip>
            ) },
        ]}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '18px 0 8px', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>{t('storageManifestTitle')}</b>
        <DatePicker size="small" onChange={(d) => { const day = d ? d.format('YYYYMMDD') : ''; setManifestDay(day); void onManifest(day) }} />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{t('storageManifestHint')}</span>
      </div>
      {manifest ? (
        entries.length ? (
          <Table
            rowKey={(r, i) => `${r.filename || r.title || 'e'}-${i}`}
            size="small"
            dataSource={entries}
            pagination={entries.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
            columns={[
              { title: t('storageColRule'), dataIndex: 'rule', key: 'r', width: 200,
                render: (v: string) => <Tag color="blue">{v || '—'}</Tag> },
              { title: t('storageColFile'), key: 'f',
                render: (_: unknown, r: any) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.filename || r.title || ('#' + (r.canvas_id ?? r.share_id ?? ''))}</span> },
              { title: t('storageColDry'), dataIndex: 'dry', key: 'd', width: 110,
                render: (v: boolean) => v ? <Tag color="orange">{t('storageDryTag')}</Tag> : <Tag color="green">{t('storageRealTag')}</Tag> },
            ]}
          />
        ) : <Alert type="info" showIcon message={t('storageManifestNoEntry')} />
      ) : (
        <Descriptions size="small" column={1} items={[
          { key: 'tip', label: <DeleteOutlined />, children: manifestLoading ? '…' : t('storageManifestPick') },
        ]} />
      )}
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-tertiary)' }}>
        <CloudDownloadOutlined /> {t('storageFooterNote')}
      </div>
    </div>
  )
}

export default StoragePanel
