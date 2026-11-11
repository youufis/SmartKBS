/**
 * 批量操作与班级维护：从旧页面原样搬出逻辑，只把容器从「页签里的三张卡片」
 * 换成工具栏弹出的对话框，避免危险操作和日常操作挤在同一个页面里。
 */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert, Button, Card, Checkbox, Input, Modal, Popconfirm, Popover, Progress, Select,
  Space, Table, Tag, Tooltip, Typography, Upload, message,
} from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined, DownloadOutlined, QuestionCircleOutlined,
  ReloadOutlined, RiseOutlined, RollbackOutlined, UploadOutlined, WarningOutlined,
} from '@ant-design/icons'
import * as usersApi from '../../api/users'
import type {
  BulkDeleteProgressEvent, BulkMatchMode, GradePromotionPreview, GradePromotionResult,
  ImportErrorCode, ImportErrorItem, ImportProgressEvent,
} from '../../api/users'

interface ApiError {
  response?: { data?: { detail?: string } }
}

const detailOf = (err: unknown, fallback: string): string =>
  (err as ApiError)?.response?.data?.detail || fallback

// ── CSV 导入 ──────────────────────────────────────────────

interface ImportProps { open: boolean; onClose: () => void; onImported: () => void }

export const ImportUsersModal: React.FC<ImportProps> = ({ open, onClose, onImported }) => {
  const { t } = useTranslation('system')
  const [progress, setProgress] = useState<{
    visible: boolean; percent: number; current: number; total: number; imported: number
    errorCount: number; errors: string[]; errorItems: ImportErrorItem[]; errorCodes: ImportErrorCode[]
    truncated: boolean; aborted: boolean; warnings: string[]; message: string; done: boolean
  }>({
    visible: false, percent: 0, current: 0, total: 0, imported: 0, errorCount: 0,
    errors: [], errorItems: [], errorCodes: [], truncated: false, aborted: false,
    warnings: [], message: '', done: false,
  })

  useEffect(() => {
    if (!open) {
      setProgress(p => ({ ...p, visible: false, done: false, percent: 0, message: '' }))
    }
  }, [open])

  const handleImport = async (file: File) => {
    setProgress({
      visible: true, percent: 0, current: 0, total: 0, imported: 0, errorCount: 0,
      errors: [], errorItems: [], errorCodes: [], truncated: false, aborted: false,
      warnings: [], message: t('parsingFile'), done: false,
    })
    try {
      await usersApi.importUsersStream(file, (event: ImportProgressEvent) => {
        if (event.type === 'start') {
          setProgress(prev => ({ ...prev, total: event.total || 0, message: t('prepareImportCount', { count: event.total }) }))
        } else if (event.type === 'progress') {
          setProgress(prev => ({
            ...prev, percent: event.percent || 0, current: event.current || 0,
            total: event.total || 0, imported: event.imported || 0,
            errorCount: event.error_count || 0,
            message: t('importingProgress', { current: event.current, total: event.total }),
          }))
        } else if (event.type === 'done') {
          setProgress(prev => ({
            ...prev, percent: 100, current: event.total ?? prev.total,
            imported: event.imported || 0, errorCount: event.error_count || 0,
            errors: event.errors || [], errorItems: event.error_items || [],
            errorCodes: event.error_codes || [], truncated: !!event.truncated,
            aborted: !!event.aborted, warnings: event.warnings || [],
            message: event.message || t('importDone'), done: true,
          }))
          if ((event.imported || 0) > 0) onImported()
        }
      })
    } catch (err) {
      setProgress(prev => ({ ...prev, message: err instanceof Error ? err.message : t('importFailed'), done: true }))
    }
    return false
  }

  return (
    <Modal
      title={t('bulkImport')}
      open={open}
      onCancel={progress.visible && !progress.done ? undefined : onClose}
      footer={progress.visible
        ? (progress.done ? <Button type="primary" onClick={onClose}>{t('confirm')}</Button> : null)
        : <Button onClick={onClose}>{t('cancel')}</Button>}
      closable={!progress.visible || progress.done}
      mask={{ closable: !progress.visible || progress.done }}
      width={560}
    >
      {!progress.visible
        ? (
          <Space orientation="vertical" style={{ width: '100%' }} size="middle">
            <Typography.Text type="secondary">{t('importCsvHint')}</Typography.Text>
            <Space wrap>
              <Upload beforeUpload={handleImport} showUploadList={false} accept=".csv">
                <Button type="primary" icon={<UploadOutlined />}>{t('selectCsv')}</Button>
              </Upload>
              <Button icon={<DownloadOutlined />} onClick={() => window.open('/api/users/import/template', '_blank')}>
                {t('downloadTemplate')}
              </Button>
            </Space>
          </Space>
        )
        : (
          <Space orientation="vertical" style={{ width: '100%' }} size="middle">
            <Progress percent={progress.percent}
              status={progress.done ? (progress.errorCount > 0 ? 'exception' : 'success') : 'active'} />
            <Typography.Text>{progress.message}</Typography.Text>
            {progress.total > 0 && (
              <Typography.Text type="secondary">
                {t('processed')} {progress.current} / {progress.total}
                ｜ {t('success')} {progress.imported}
                ｜ {t('failed')} {progress.errorCount}
              </Typography.Text>
            )}
            {progress.errorCodes.length > 0 && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('importErrSummary')}：</Typography.Text>
                <Space wrap size={4} style={{ marginTop: 4 }}>
                  {progress.errorCodes.map(c => (
                    <Tag key={c.code} color="red" title={c.label}>{c.label} × {c.count}</Tag>
                  ))}
                </Space>
              </div>
            )}
            {progress.errors.length > 0 && (
              <div style={{
                maxHeight: 200, overflow: 'auto', background: 'var(--bg-error-soft, rgba(255,77,79,.08))',
                border: '1px solid var(--error-color, #ff4d4f)', borderRadius: 6, padding: '8px 12px',
              }}>
                <Typography.Text type="danger" strong>{t('errorDetails')}:</Typography.Text>
                {progress.errors.map((err, i) => (
                  <Typography.Text key={i} type="danger" style={{ display: 'block', fontSize: 12, lineHeight: 1.8 }}>{err}</Typography.Text>
                ))}
                {progress.truncated && (
                  <Typography.Text type="warning" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    {t('importTruncated', { count: progress.errorCount, shown: progress.errors.length })}
                  </Typography.Text>
                )}
              </div>
            )}
            {progress.aborted && (
              <Typography.Text type="danger" strong style={{ display: 'block' }}>
                <CloseCircleOutlined /> {t('importFailed')}
              </Typography.Text>
            )}
            {progress.warnings.length > 0 && (
              <div style={{
                background: 'var(--bg-warning-soft, rgba(250,173,20,.12))',
                border: '1px solid var(--warning-color, #faad14)', borderRadius: 6, padding: '8px 12px',
              }}>
                <Typography.Text type="warning" strong>{t('importWarnings')}:</Typography.Text>
                {progress.warnings.map((w, i) => (
                  <Typography.Text key={i} type="warning" style={{ display: 'block', fontSize: 12, lineHeight: 1.8 }}>{w}</Typography.Text>
                ))}
              </div>
            )}
          </Space>
        )}
    </Modal>
  )
}

// ── 批量删除 ──────────────────────────────────────────────

interface BulkDeleteProps { open: boolean; onClose: () => void; onDeleted: () => void }

export const BulkDeleteModal: React.FC<BulkDeleteProps> = ({ open, onClose, onDeleted }) => {
  const { t } = useTranslation('system')
  const [pattern, setPattern] = useState('')
  const [matchMode, setMatchMode] = useState<BulkMatchMode>('prefix')
  const [preview, setPreview] = useState<usersApi.BulkDeletePreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({
    visible: false, percent: 0, current: 0, total: 0, deleted: 0, errorCount: 0,
    errors: [] as string[], message: '', done: false,
  })

  useEffect(() => {
    if (open) {
      setPreview(null); setConfirmed(false); setPattern('')
      setProgress({ visible: false, percent: 0, current: 0, total: 0, deleted: 0, errorCount: 0, errors: [], message: '', done: false })
    }
  }, [open])

  const openPreview = async () => {
    if (!pattern.trim()) { message.warning(t('enterPattern')); return }
    setLoading(true)
    try {
      const p = await usersApi.previewBulkDelete(pattern.trim(), matchMode)
      if (p.matched_count === 0) { message.warning(t('noDeletableMatched')); return }
      setPreview(p)
      setConfirmed(false)
    } catch (err) {
      message.error(usersApi.extractApiErrorDetail((err as ApiError)?.response?.data) || t('queryMatchFailed'))
    } finally {
      setLoading(false)
    }
  }

  const runDelete = async () => {
    if (!preview) return
    if (!confirmed) { message.warning(t('tickConfirmFirst')); return }
    setRunning(true)
    setProgress({
      visible: true, percent: 0, current: 0, total: preview.matched_count, deleted: 0,
      errorCount: 0, errors: [], message: t('startDeleteCount', { count: preview.matched_count }), done: false,
    })
    try {
      await usersApi.bulkDeleteUsersStream(preview.pattern, (event: BulkDeleteProgressEvent) => {
        if (event.type === 'start') {
          setProgress(prev => ({ ...prev, total: event.total || 0, message: t('prepareDeleteCount', { count: event.total }) }))
        } else if (event.type === 'progress') {
          setProgress(prev => ({
            ...prev, percent: event.percent || 0, current: event.current || 0, total: event.total || 0,
            deleted: event.deleted || 0, errorCount: event.error_count || 0,
            message: t('deletingProgress', { current: event.current, total: event.total }),
          }))
        } else if (event.type === 'done') {
          setProgress(prev => ({
            ...prev, percent: 100, current: prev.total, deleted: event.deleted || 0,
            errorCount: event.error_count || 0, errors: event.errors || [],
            message: event.message || t('batchDeleteDone'), done: true,
          }))
          if ((event.deleted || 0) > 0) onDeleted()
        }
      }, preview.match_mode, true)
    } catch (err) {
      setProgress(prev => ({ ...prev, message: err instanceof Error ? err.message : t('batchDeleteFailed'), done: true }))
    } finally {
      setRunning(false)
    }
  }

  const finish = () => { setProgress(p => ({ ...p, visible: false })); setPreview(null); onClose() }

  return (
    <>
      <Modal
        title={t('bulkDelete')}
        open={open && !progress.visible}
        onCancel={onClose}
        width={600}
        mask={{ closable: false }}
        footer={preview
          ? [
            <Button key="back" onClick={() => { setPreview(null); setConfirmed(false) }}>{t('cancel')}</Button>,
            <Button key="ok" danger disabled={!confirmed} loading={running} onClick={runDelete}>
              {t('confirmDeleteBtn')}
            </Button>,
          ]
          : [
            <Button key="cancel" onClick={onClose}>{t('cancel')}</Button>,
            <Button key="preview" danger icon={<WarningOutlined />} loading={loading} onClick={openPreview}>
              {t('bulkDelete')}
            </Button>,
          ]}
      >
        {!preview
          ? (
            <Space orientation="vertical" style={{ width: '100%' }} size="middle">
              <Space wrap>
                <Select value={matchMode} onChange={(v: BulkMatchMode) => setMatchMode(v)} style={{ width: 120 }}
                  options={[
                    { value: 'prefix', label: t('matchPrefix') },
                    { value: 'contains', label: t('matchContains') },
                    { value: 'exact', label: t('matchExact') },
                  ]} />
                <Input placeholder={t('enterPattern')} value={pattern} style={{ width: 240 }}
                  onChange={e => setPattern(e.target.value)} onPressEnter={openPreview} allowClear />
              </Space>
              <Typography.Text type="secondary">{t('batchDeleteHint')}</Typography.Text>
            </Space>
          )
          : (
            <Space orientation="vertical" style={{ width: '100%' }} size="middle">
              <Alert type="error" showIcon
                title={t('deleteWarnCount', { count: preview.matched_count })}
                description={preview.message} />
              {preview.preview.length > 0 && (
                <div>
                  <Typography.Text strong>{t('matchPreviewHead', { count: preview.preview.length })}</Typography.Text>
                  <div style={{ marginTop: 6 }}>
                    {preview.preview.map(u => <Tag key={u} color="red">{u}</Tag>)}
                  </div>
                  {preview.matched_count > preview.preview.length && (
                    <Typography.Text type="secondary">
                      {t('moreMatched', { count: preview.matched_count - preview.preview.length })}
                    </Typography.Text>
                  )}
                </div>
              )}
              {preview.skipped_admin_count > 0 && (
                <Typography.Text type="warning">{t('skippedAdmins', { count: preview.skipped_admin_count })}</Typography.Text>
              )}
              <Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)}>
                {t('iConfirmDelete', { count: preview.matched_count })}
              </Checkbox>
            </Space>
          )}
      </Modal>

      <Modal
        title={t('bulkDelete')}
        open={progress.visible}
        footer={progress.done ? <Button type="primary" onClick={finish}>{t('confirm')}</Button> : null}
        closable={progress.done}
        mask={{ closable: progress.done }}
        onCancel={finish}
      >
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <Progress percent={progress.percent}
            status={progress.done ? (progress.errorCount > 0 ? 'exception' : 'success') : 'active'} />
          <Typography.Text>{progress.message}</Typography.Text>
          {progress.total > 0 && (
            <Typography.Text type="secondary">
              {t('processed')} {progress.current} / {progress.total}
              ｜ {t('success')} {progress.deleted}
              ｜ {t('failed')} {progress.errorCount}
            </Typography.Text>
          )}
          {progress.errors.length > 0 && (
            <div style={{
              maxHeight: 200, overflow: 'auto', background: 'var(--bg-error-soft, rgba(255,77,79,.08))',
              border: '1px solid var(--error-color, #ff4d4f)', borderRadius: 6, padding: '8px 12px',
            }}>
              <Typography.Text type="danger" strong>{t('errorDetails')}:</Typography.Text>
              {progress.errors.map((err, i) => (
                <Typography.Text key={i} type="danger" style={{ display: 'block', fontSize: 12, lineHeight: 1.8 }}>{err}</Typography.Text>
              ))}
            </div>
          )}
        </Space>
      </Modal>
    </>
  )
}

// ── 批量升/降年级 ──────────────────────────────────────────

interface PromoteProps { open: boolean; onClose: () => void; isAdmin: boolean; onDone: () => void }

export const PromoteGradesModal: React.FC<PromoteProps> = ({ open, onClose, isAdmin, onDone }) => {
  const { t } = useTranslation('system')
  const [preview, setPreview] = useState<GradePromotionPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [result, setResult] = useState<GradePromotionResult | null>(null)
  const [reversing, setReversing] = useState(false)

  const loadPreview = async () => {
    setLoading(true)
    setResult(null)
    try {
      setPreview(await usersApi.previewPromoteGrades())
    } catch (err) {
      message.error(detailOf(err, t('promotePreviewFailed')))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open && isAdmin) void loadPreview()
  }, [open, isAdmin])  // eslint-disable-line react-hooks/exhaustive-deps

  const execute = () => {
    const promoteDesc = preview?.grade_details?.filter(d => d.next_grade)
      .map(d => `${d.grade}→${d.next_grade}`).join('，') || t('autoUpgradeByStage')
    const graduateDesc = preview?.grade_details?.filter(d => !d.next_grade && d.count > 0)
      .map(d => t('gradeCountItem', { grade: d.grade, count: d.count })).join('、')
    Modal.confirm({
      title: t('confirmBatchUpgradeTitle'),
      icon: <WarningOutlined />,
      width: 520,
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>{t('promoteIntro')}</p>
          <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
            <li>{t('promoteStudentsLine', { desc: promoteDesc })}</li>
            {graduateDesc && <li>{t('promoteGraduateLine', { desc: graduateDesc })}</li>}
            <li>{t('promotePointsLine')}</li>
            <li>{t('promoteClassLine')}</li>
            <li>{t('promoteArchiveLine')}</li>
          </ul>
          <p style={{ color: 'var(--warning-color, #faad14)', marginTop: 8 }}>{t('promoteIrreversible')}</p>
        </div>
      ),
      okText: t('confirmExecute'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        setExecuting(true)
        try {
          const res = await usersApi.executePromoteGrades({ confirm: true })
          setResult(res)
          if (res.success) { message.success(t('promoteExecSuccess')); onDone() }
          void loadPreview()
        } catch (err) {
          message.error(detailOf(err, t('promoteExecFailed')))
        } finally {
          setExecuting(false)
        }
      },
    })
  }

  const reverse = () => {
    const reverseDesc = preview?.grade_details?.filter(d => d.next_grade)
      .map(d => `${d.next_grade}→${d.grade}`).join('，') || ''
    Modal.confirm({
      title: t('confirmBatchDemoteTitle'),
      icon: <WarningOutlined />,
      width: 520,
      content: (
        <div>
          <p style={{ marginBottom: 12 }}>{t('demoteIntro')}</p>
          <ul style={{ paddingLeft: 20, lineHeight: 2 }}>
            <li>{reverseDesc || t('demoteByUpgradeMap')}</li>
            <li>{t('demotePointsLine')}</li>
            <li>{t('demoteClassLine')}</li>
            <li>{t('demoteRestoreLine')}</li>
          </ul>
          <p style={{ color: 'var(--warning-color, #faad14)', marginTop: 8 }}>{t('demoteNote')}</p>
        </div>
      ),
      okText: t('confirmDemote'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        setReversing(true)
        try {
          const res = await usersApi.reversePromoteGrades({ confirm: true })
          if (res.success) {
            message.success(t('demoteSuccess'))
            setResult(res)
            onDone()
            void loadPreview()
          }
        } catch (err) {
          message.error(detailOf(err, t('demoteFailed')))
        } finally {
          setReversing(false)
        }
      },
    })
  }

  return (
    <Modal
      title={<span><RiseOutlined /> {t('batchUpgradeTitle')}</span>}
      open={open}
      onCancel={onClose}
      width={720}
      styles={{ body: { maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' } }}
      footer={<Button onClick={onClose}>{t('cancel')}</Button>}
    >
      {!isAdmin
        ? <Typography.Text type="secondary">{t('promoteAdminOnly')}</Typography.Text>
        : (
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {t('upgradePathHint')}{t('gradRetainHint')}
            </Typography.Text>
            <Space>
              <Button icon={<RiseOutlined />} onClick={loadPreview} loading={loading}>{t('previewUpgrade')}</Button>
              {preview && (
                <span style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>
                  {t('totalStudentsN', { count: preview.total_students })}
                </span>
              )}
            </Space>

            {preview && (
              <>
                <Table
                  dataSource={preview.grade_details}
                  columns={[
                    { title: t('curGrade'), dataIndex: 'grade', key: 'grade', width: 100 },
                    { title: t('headcount'), dataIndex: 'count', key: 'count', width: 60 },
                    {
                      title: t('nextGrade'), dataIndex: 'next_grade', key: 'next_grade', width: 120,
                      render: (val: string | null) => val ? <Tag color="blue">{val}</Tag> : <Tag color="orange">{t('graduateTag')}</Tag>,
                    },
                    {
                      title: t('classCol'), dataIndex: 'classes', key: 'classes',
                      render: (val: string[]) => val?.length ? val.join('、') : '-',
                    },
                  ]}
                  rowKey="grade" size="small" pagination={false} style={{ marginBottom: 12 }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                  {t('upgradeFixedEffects')}
                </Typography.Text>
                <Space wrap>
                  <Button type="primary" icon={<RiseOutlined />} loading={executing} onClick={execute}>
                    {t('executeUpgrade')}
                  </Button>
                  <Button icon={<RollbackOutlined />} loading={reversing} onClick={reverse}>
                    {t('reverseDemote')}
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('upgradeReversibleHint')}</Typography.Text>
                </Space>
              </>
            )}

            {result && (
              <Card size="small" type="inner" style={{ marginTop: 12 }}
                title={(
                  <span>
                    {result.success
                      ? <CheckCircleOutlined style={{ color: 'var(--success-color)' }} />
                      : <CloseCircleOutlined style={{ color: 'var(--error-color)' }} />}
                    {' '}{t('execResult')}
                  </span>
                )}>
                <Space orientation="vertical">
                  {!result.success && <Typography.Text type="danger">{t('promoteFailedRollback')}</Typography.Text>}
                  {result.errors?.map((e, i) => (
                    <Typography.Text key={i} type="danger" style={{ fontSize: 12 }}>{e}</Typography.Text>
                  ))}
                  {result.success && (
                    <>
                      <Typography.Text>
                        {result.direction === 'up' ? t('upgradedLabel') : t('demotedLabel')}{t('studentsColon')}
                        {Object.entries(result.promoted).map(([g, c]) => t('gradeMoveSummary', { from: g, to: c })).join('、')}
                      </Typography.Text>
                      {Object.keys(result.not_moved).length > 0 && (
                        <Typography.Text>
                          {result.direction === 'up' ? t('graduatedLabel') : t('lowestGradeLabel')}
                          {Object.entries(result.not_moved).map(([g, c]) => t('gradeCountPlain', { grade: g, count: c })).join('、')}
                        </Typography.Text>
                      )}
                      {result.skipped && result.skipped.length > 0 && (
                        <Typography.Text type="warning">{t('promoteSkippedNoGrade', { count: result.skipped.length })}</Typography.Text>
                      )}
                      {result.graduated && Object.keys(result.graduated).length > 0 && (
                        <Typography.Text>
                          {t('graduatedArchiveLabel')}
                          {Object.entries(result.graduated).map(([g, c]) => t('gradeCountPlain', { grade: g, count: c })).join('、')}
                        </Typography.Text>
                      )}
                      {!!result.restored && <Typography.Text>{t('restoredLabel', { n: result.restored })}</Typography.Text>}
                      {!!result.unmatched_class && (
                        <Typography.Text type="warning">{t('unmatchedClassHint', { n: result.unmatched_class })}</Typography.Text>
                      )}
                      <Typography.Text type="secondary">
                        users {result.updated_users} ｜ scores {result.updated_scores} ｜ rollcall {result.updated_rollcall}
                      </Typography.Text>
                    </>
                  )}
                </Space>
              </Card>
            )}
          </Space>
        )}
    </Modal>
  )
}

// ── 班级维护（保持原页签，仅管理员） ─────────────────────────

export const ClassMgmtPanel: React.FC = () => {
  const { t } = useTranslation('system')
  const [rows, setRows] = useState<usersApi.ClassMgmtRow[]>([])
  const [loading, setLoading] = useState(false)
  const [onlyEmpty, setOnlyEmpty] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      setRows(await usersApi.listClassMgmt())
    } catch (err) {
      message.error(detailOf(err, String(err)))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const handleDelete = async (row: usersApi.ClassMgmtRow) => {
    setBusyId(row.class_id)
    try {
      message.success(await usersApi.deleteClassMgmt(row.class_id))
      await load()
    } catch (err) {
      message.error(detailOf(err, String(err)))
    } finally {
      setBusyId(null)
    }
  }

  const shown = onlyEmpty ? rows.filter(r => r.students === 0) : rows
  const deleteReason = (r: usersApi.ClassMgmtRow): string =>
    r.students > 0 ? t('cmReasonStudents', { count: r.students })
      : r.teachers > 0 ? t('cmReasonTeachers', { count: r.teachers })
        : ''
  const columns = [
    { title: t('cmGrade'), dataIndex: 'grade_name', key: 'grade', width: 100 },
    { title: t('cmClass'), dataIndex: 'display_name', key: 'class', width: 180 },
    { title: t('cmStudents'), dataIndex: 'students', key: 'students', width: 100 },
    { title: t('cmTeachers'), dataIndex: 'teachers', key: 'teachers', width: 90 },
    {
      title: t('cmStatusCol'), key: 'state', width: 150,
      render: (_: unknown, r: usersApi.ClassMgmtRow) =>
        r.deletable
          ? <Tag color="warning">{t('cmEmpty')}</Tag>
          : r.students === 0
            ? <Tag color="processing">{t('cmNoStudentHasTeacher')}</Tag>
            : <Tag>{t('cmInUse')}</Tag>,
    },
    {
      title: t('actionsCol'), key: 'act', width: 90,
      render: (_: unknown, r: usersApi.ClassMgmtRow) => {
        const reason = deleteReason(r)
        const btn = (
          <Popconfirm
            title={t('cmDeleteConfirm', { name: r.display_name })}
            okText={t('confirm')} cancelText={t('cancel')}
            onConfirm={() => void handleDelete(r)}
          >
            <Button danger size="small" type="link" disabled={!r.deletable} loading={busyId === r.class_id}
              style={{ padding: 0 }}>{t('cmDelete')}</Button>
          </Popconfirm>
        )
        return reason ? <Tooltip title={reason}><span>{btn}</span></Tooltip> : btn
      },
    },
  ]

  return (
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>{t('cmRefresh')}</Button>
        <Checkbox checked={onlyEmpty} onChange={e => setOnlyEmpty(e.target.checked)}>{t('cmOnlyEmpty')}</Checkbox>
        <Popover
          trigger="click" placement="rightTop"
          title={t('cmHelpTitle')}
          content={(
            <div style={{ maxWidth: 380 }}>
              <Typography.Paragraph style={{ marginBottom: 8 }}>{t('cmHint')}</Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 0 }}>{t('cmHintDetail')}</Typography.Paragraph>
            </div>
          )}
        >
          <Button type="link" size="small" icon={<QuestionCircleOutlined />}>{t('cmHelp')}</Button>
        </Popover>
      </Space>
      <Table dataSource={shown} columns={columns} rowKey="class_id" size="small"
        loading={loading} pagination={{ pageSize: 30 }} />
    </Space>
  )
}
