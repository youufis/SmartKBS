/**
 * 文件提交类作业的前端面板（学生提交 + 教师批改）。
 *
 * 后端：backend/api/tasks_router.py（文件作业段）+ backend/homework.py
 * 口径：一次提交=一个批次(seq)，批改只看最后一次；AI 分默认待复核，教师点发布学生才可见。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert, Button, Card, Col, Empty, Image, Input, InputNumber, Modal, Progress, Radio, Row,
  DatePicker, Select, Space, Switch, Tag, Tooltip, Typography, Upload, message,
} from 'antd'
import {
  CameraOutlined, CheckCircleOutlined, CloudUploadOutlined, DeleteOutlined, DownloadOutlined,
  FileTextOutlined, ReloadOutlined, RobotOutlined, SafetyCertificateOutlined, SendOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useTranslation } from 'react-i18next'
import * as tasksApi from '../../api/tasks'
import type { HomeworkFileItem } from '../../api/tasks'
import CameraCapture from '../../components/CameraCapture'
import { useIsMobile } from '../../hooks/useIsMobile'
import { pollAiTaskWithProgress } from '../../api/aiTask'
import type { TaskInfo } from '../../types'
import {
  DEFAULT_DIMS, statusMeta, fmtSize,
  parseDeadline, type HomeworkValue,
} from './homeworkModel'

const { Text, Paragraph } = Typography

/** 常用截止时间预设。基准时间从调用方传入，组件渲染期不取时钟。 */
function deadlinePresets(t: (k: string, o?: any) => string, base: Dayjs) {
  const at = (d: Dayjs, h = 20) => d.hour(h).minute(0).second(0).millisecond(0)
  const tonight = at(base)
  return [
    { label: t('hwPresetTonight'), value: tonight.isBefore(base) ? at(base.add(1, 'day')) : tonight },
    { label: t('hwPresetTomorrow'), value: at(base.add(1, 'day')) },
    { label: t('hwPresetThisSunday'), value: at(base.day(0).isBefore(base) ? base.add(7, 'day') : base.day(0)) },
    { label: t('hwPresetNextWeek'), value: at(base.add(7, 'day')) },
  ]
}

// ════════════════════════════════════════════════════════════
// 1) 教师创建/编辑作业时的「提交方式」表单块
// ════════════════════════════════════════════════════════════

interface FormProps {
  value: HomeworkValue
  onChange: (v: HomeworkValue) => void
  /** 已有学生提交时锁定提交方式（后端同样会拒，提前禁掉避免教师白点） */
  modeLocked?: boolean
  maxFileMbCap?: number
}

export const HomeworkForm: React.FC<FormProps> = ({ value, onChange, modeLocked, maxFileMbCap = 10 }) => {
  const { t } = useTranslation('system')
  // 基准时间放在 state 里（渲染期调 dayjs() 属于副作用，会让预设每次重渲染都漂移）
  const [clockBase] = useState<Dayjs>(() => dayjs())
  const set = <K extends keyof HomeworkValue>(k: K, v: HomeworkValue[K]) => onChange({ ...value, [k]: v })
  const isFile = value.submit_mode !== 'conversation'
  const dims = useMemo(() => {
    try {
      const d = JSON.parse(value.rubric || '[]')
      return Array.isArray(d) && d.length ? d : DEFAULT_DIMS
    } catch { return DEFAULT_DIMS }
  }, [value.rubric])
  const dimSum = dims.reduce((a, d) => a + (Number(d.max) || 0), 0)

  return (
    <div style={{ marginTop: 14 }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={10}>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('hwSubmitMode')}</Text>
          <Radio.Group
            style={{ display: 'block', marginTop: 4 }}
            value={value.submit_mode}
            disabled={modeLocked}
            onChange={(e) => set('submit_mode', e.target.value)}
            optionType="button"
            options={[
              { value: 'conversation', label: t('hwModeConversation') },
              { value: 'file', label: t('hwModeFile') },
              { value: 'mixed', label: t('hwModeMixed') },
            ]}
          />
          {modeLocked && <Text type="warning" style={{ fontSize: 12, marginLeft: 8 }}>{t('hwModeLockedHint')}</Text>}
        </div>

        {isFile && (
          <>
            <Row gutter={10}>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwDeadline')}</Text>
                <DatePicker
                  style={{ width: '100%', marginTop: 4 }}
                  showTime={{ format: 'HH:mm' }}
                  format="YYYY-MM-DD HH:mm"
                  minuteStep={5}
                  allowClear
                  placeholder={t('hwNoDeadline')}
                  value={value.deadline_at ? dayjs(value.deadline_at) : null}
                  onChange={(d: Dayjs | null) => set('deadline_at', d ? d.format('YYYY-MM-DD HH:mm:ss') : '')}
                  presets={deadlinePresets(t, clockBase)}
                />
              </Col>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwTotalScore')}</Text>
                <InputNumber
                  min={1} max={1000} style={{ width: '100%', marginTop: 4 }}
                  value={value.total_score} onChange={(v) => set('total_score', Number(v) || 100)}
                />
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwMaxFiles')}</Text>
                <InputNumber
                  min={1} max={10} style={{ width: '100%', marginTop: 4 }}
                  value={value.max_files} onChange={(v) => set('max_files', Number(v) || 3)}
                />
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwMaxFileMb')}</Text>
                <InputNumber
                  min={1} max={maxFileMbCap} style={{ width: '100%', marginTop: 4 }}
                  value={Math.min(value.max_file_mb, maxFileMbCap)}
                  onChange={(v) => set('max_file_mb', Number(v) || 10)}
                />
              </Col>
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwResubmitLimit')}</Text>
                <InputNumber
                  min={0} max={20} style={{ width: '100%', marginTop: 4 }}
                  value={value.resubmit_limit} onChange={(v) => set('resubmit_limit', Number(v) || 0)}
                />
              </Col>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwAllowLate')}</Text>
                <div style={{ marginTop: 6 }}>
                  <Switch
                    checked={!!value.allow_late}
                    onChange={(c) => set('allow_late', c ? 1 : 0)}
                    checkedChildren={t('hwYes')} unCheckedChildren={t('hwNo')}
                  />
                </div>
              </Col>
              <Col span={12}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwPolicy')}</Text>
                <Select
                  style={{ width: '100%', marginTop: 4 }}
                  value={value.grading_policy}
                  onChange={(v) => set('grading_policy', v)}
                  options={[
                    { value: 'ai_then_review', label: t('hwPolicyReview') },
                    { value: 'manual_only', label: t('hwPolicyManual') },
                    { value: 'ai_auto_publish', label: t('hwPolicyAuto') },
                  ]}
                />
              </Col>
            </Row>

            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('hwDims')}</Text>
              {dims.map((d: { name: string; max: number }, i: number) => (
                <Space key={i} style={{ display: 'flex', marginTop: 4 }}>
                  <Input
                    style={{ width: 140 }} value={d.name}
                    onChange={(e) => {
                      const next = dims.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x))
                      set('rubric', JSON.stringify(next))
                    }}
                  />
                  <InputNumber
                    min={0} style={{ width: 90 }} value={d.max}
                    onChange={(v) => {
                      const next = dims.map((x: any, j: number) => (j === i ? { ...x, max: Number(v) || 0 } : x))
                      set('rubric', JSON.stringify(next))
                    }}
                  />
                  {dims.length > 2 && (
                    <Button size="small" type="text" danger icon={<DeleteOutlined />}
                      onClick={() => set('rubric', JSON.stringify(dims.filter((_: any, j: number) => j !== i)))}
                    />
                  )}
                </Space>
              ))}
              <Space style={{ marginTop: 6 }}>
                <Button size="small" onClick={() => set('rubric', JSON.stringify(
                  [...dims, { name: t('hwDimNewName'), max: 0 }]))}
                >{t('hwAddDim')}</Button>
                <Text type={Math.abs(dimSum - value.total_score) < 0.5 ? 'secondary' : 'warning'} style={{ fontSize: 12 }}>
                  {t('hwDimSum', { sum: dimSum, total: value.total_score })}
                </Text>
              </Space>
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('hwDeadlineNote')}</Text>
          </>
        )}
      </Space>
    </div>
  )
}

// ════════════════════════════════════════════════════════════
// 2) 学生：上传提交
// ════════════════════════════════════════════════════════════

interface SubmitProps {
  task: TaskInfo
  open: boolean
  onClose: () => void
  onSubmitted: () => void
}

export const HomeworkSubmitModal: React.FC<SubmitProps> = ({ task, open, onClose, onSubmitted }) => {
  const { t } = useTranslation('system')
  const isMobile = useIsMobile()
  const [ov, setOv] = useState<tasksApi.HomeworkOverview | null>(null)
  const [picked, setPicked] = useState<File[]>([])
  const [note, setNote] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  // 时间基准放在 state：渲染期调 Date.now() 属于副作用，会让倒计时在重渲染时跳变
  const [nowMs, setNowMs] = useState(() => Date.parse(new Date().toISOString()))
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setOv(await tasksApi.getTaskFiles(task.id))
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('loadDetailFailed'))
    } finally {
      setLoading(false)
    }
  }, [task.id, t])

  useEffect(() => { if (open) { setNowMs(Date.parse(new Date().toISOString())); reload() } }, [open, reload])

  const maxFiles = ov?.max_files ?? task.max_files ?? 3
  const maxMb = ov?.max_file_mb ?? task.max_file_mb ?? 10
  const allowed = ov?.allowed_exts ?? []
  const mine = useMemo(() => (ov?.files || []).filter((f) => f.is_latest), [ov])
  // 学生视角只看自己：后端每次提交把 seq 递增（首次=1），所以最新 seq 就是「已经交过的次数」
  const usedTimes = mine.length ? mine[0].seq : 0
  const limit = ov?.resubmit_limit ?? task.resubmit_limit ?? 3
  const left = limit > 0 ? Math.max(0, limit - usedTimes) : Infinity
  const deadline = ov?.deadline_at || task.deadline_at || ''
  const closed = !!deadline && parseDeadline(deadline) < nowMs
  const canSubmit = left > 0 && (!closed || !!task.allow_late) && task.status === 'active'

  const pick = (files: File[]): boolean => {
    const next: File[] = []
    for (const f of files) {
      const ext = `.${(f.name.split('.').pop() || '').toLowerCase()}`
      if (allowed.length && !allowed.includes(ext)) {
        message.error(`${f.name}: ${t('hwErrExt')}（${allowed.join('、')}）`)
        return false
      }
      if (f.size > maxMb * 1024 * 1024) {
        message.error(`${f.name}: ${t('hwErrSize', { mb: maxMb })}`)
        return false
      }
      next.push(f)
    }
    if (picked.length + next.length > maxFiles) {
      message.error(t('hwErrCount', { n: maxFiles }))
      return false
    }
    setPicked((prev) => [...prev, ...next])
    return true
  }

  const doSubmit = async () => {
    // 已经交过的学生空点提交时，提示要说清「这次没选文件」，而不是像第一次那样引导
    if (!picked.length) { message.warning(usedTimes > 0 ? t('hwPickFirstAgain') : t('hwPickFirst')); return }
    setProgress(0)
    try {
      const res = await tasksApi.submitTaskFiles(task.id, picked, note, setProgress)
      message.success(res.message)
      setPicked([]); setNote('')
      // 交完就退出：留在弹窗里再点「提交作业」只会得到「请先选择文件」，
      // 学生以为没交上，教师那边其实已经收到文件了。列表刷新由 onSubmitted 负责。
      onSubmitted()
      onClose()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('submitFailed'))
    } finally {
      setProgress(null)
    }
  }

  const removeMine = async (f: HomeworkFileItem) => {
    try {
      await tasksApi.deleteTaskFile(task.id, f.id)
      message.success(t('hwRevoked'))
      reload()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('deleteFailed'))
    }
  }

  const extAccept = (allowed.length ? allowed : ['.docx', '.pdf', '.txt', '.md', '.xlsx', '.pptx']).join(',')

  return (
    <Modal maskClosable={false}
      open={open}
      title={`📎 ${task.name}`}
      onCancel={onClose}
      width={640}
      footer={[
        <Button key="c" onClick={onClose}>{t('cancel')}</Button>,
        <Button key="s" type="primary" icon={<SendOutlined />} disabled={!canSubmit || progress !== null}
          loading={progress !== null} onClick={doSubmit}
        >{t('hwSubmitNow')}</Button>,
      ]}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size={10}>
        <Alert type="info" showIcon
          message={t('hwRuleSummary', {
            files: maxFiles, mb: maxMb,
            types: allowed.length ? allowed.join('、') : t('hwTypesDefault'),
          })}
          description={
            <Space size={6} wrap>
              <span>{deadline ? `${t('hwDeadline')}: ${deadline}` : t('hwNoDeadline')}</span>
              <span>{limit > 0
                ? t('hwTimesUsed', { used: usedTimes, left, limit })
                : t('hwUnlimitedTimes')}</span>
            </Space>
          }
        />
        {closed && <Alert type="warning" showIcon message={t('hwClosedWarn')} />}
        {limit > 0 && left <= 0 && (
          <Alert type="error" showIcon message={t('hwNoTimesLeft', { limit })}
            description={t('hwNoTimesLeftHint')} />
        )}

        {task.submit_mode === 'mixed' && (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('hwNote')}</Text>
            <Input.TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={t('hwNoteHint')} maxLength={5000} style={{ marginTop: 4 }} />
          </div>
        )}

        <Upload.Dragger
          multiple accept={extAccept} showUploadList={false}
          beforeUpload={(f) => { pick([f as unknown as File]); return false }}
        >
          <p style={{ margin: 0 }}><CloudUploadOutlined style={{ fontSize: 22 }} /> {t('hwDropHere')}</p>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('hwUploadHint')}</Text>
        </Upload.Dragger>

        {picked.length > 0 && (
          <Card size="small" title={t('hwPicked')}>
            {picked.map((f, i) => (
              <Space key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text ellipsis style={{ maxWidth: 380 }}>{f.name}</Text>
                <Space>
                  <Text type="secondary">{fmtSize(f.size)}</Text>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}
                    onClick={() => setPicked(picked.filter((_, j) => j !== i))}
                  />
                </Space>
              </Space>
            ))}
          </Card>
        )}

        {progress !== null && <Progress percent={progress} size="small" />}

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('hwMyLatest')}</Text>
          {loading ? <Text style={{ marginLeft: 8 }}>{t('loading')}</Text> : (
            mine.length ? (
              <Space wrap style={{ marginTop: 6 }}>
                {mine.map((f) => {
                  const meta = statusMeta(f.extract_status)
                  return (
                    <Tag key={f.id} color={meta.color}
                      icon={f.kind === 'image' ? undefined : <FileTextOutlined />}
                      closable onClose={(e) => { e.preventDefault(); removeMine(f) }}
                    >
                      <a href={tasksApi.homeworkFileUrl(f.id)} download>{f.filename}</a>
                      {' · '}{fmtSize(f.size)}{f.chars ? ` · ${f.chars}字` : ''}（{t(meta.key)}）
                    </Tag>
                  )
                })}
              </Space>
            ) : <Text type="secondary" style={{ marginLeft: 8 }}>{t('hwNotSubmitted')}</Text>
          )}
        </div>

        {isMobile && (
          <Button icon={<CameraOutlined />} onClick={() => setCameraOpen(true)}>{t('hwTakePhoto')}</Button>
        )}
        <CameraCapture
          open={cameraOpen}
          onClose={() => setCameraOpen(false)}
          onCapture={(file) => { pick([file]); setCameraOpen(false) }}
        />
      </Space>
    </Modal>
  )
}

// ════════════════════════════════════════════════════════════
// 3) 教师：批改台（提交清单 + AI 批改 + 复核 + 发布）
// ════════════════════════════════════════════════════════════

interface BoardProps {
  task: TaskInfo
  roster: { username: string; name: string }[]
  onChanged?: () => void
}

const criterionIcon = (s?: string) => (s === 'met' ? '✅' : s === 'missing' ? '❌' : '🟡')

export const HomeworkBoard: React.FC<BoardProps> = ({ task, roster, onChanged }) => {
  const { t } = useTranslation('system')
  const [ov, setOv] = useState<tasksApi.HomeworkOverview | null>(null)
  const [grades, setGrades] = useState<Record<string, tasksApi.AIGradeResult>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [job, setJob] = useState<string>('')
  const [missing, setMissing] = useState<string[]>([])
  const [review, setReview] = useState<{ student: string; score: number; comment: string } | null>(null)
  const [preview, setPreview] = useState<HomeworkFileItem | null>(null)

  const load = useCallback(async () => {
    try {
      const [o, g] = await Promise.all([tasksApi.getTaskFiles(task.id), tasksApi.getTaskGrades(task.id)])
      setOv(o)
      const map: Record<string, tasksApi.AIGradeResult> = {}
      ;(g.grades || []).forEach((x) => { map[x.student] = x })
      setGrades(map)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('loadDetailFailed'))
    }
  }, [task.id, t])

  useEffect(() => { load() }, [load])

  const submitted = ov?.submissions || {}
  const filesOf = useCallback((stu: string) =>
    (ov?.files || []).filter((f) => f.student === stu && f.is_latest), [ov])

  /** 全班批改：提交后台任务并轮询进度（文件多时这一步会跑几分钟） */
  const runJob = async (student?: string) => {
    setBusy(student ? `grade:${student}` : 'grade')
    setJob(t('hwJobStarted'))
    try {
      const res = await tasksApi.startFileGradingJob(task.id, student)
      const state = await pollAiTaskWithProgress(res.task_id, (p) => {
        if (p?.phase) setJob(`${p.phase}${p.total ? ` ${p.done ?? 0}/${p.total}` : ''}`)
      }, 900000)
      const r: any = state.result || {}
      message.success(r.message || t('hwJobDone'))
      setMissing(Array.isArray(r.needs_review_students) ? r.needs_review_students : [])
      if (r.similarity_pairs?.length) message.warning(t('hwSimFound', { n: r.similarity_pairs.length }))
      await load()
      onChanged?.()
    } catch (e: any) {
      if (e?.aiTaskTimeout) message.warning(t('hwJobTimeout'))
      else message.error(e?.response?.data?.detail || e?.message || t('hwJobFailed'))
    } finally {
      setBusy(null); setJob('')
    }
  }

  const publish = async () => {
    setBusy('publish')
    try {
      const res = await tasksApi.publishGrades(task.id)
      Modal[res.notified ? 'success' : 'warning']({
        title: t('hwPublished'), content: res.message, maskClosable: false,
      })
      await load(); onChanged?.()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('hwPublishFailed'))
    } finally { setBusy(null) }
  }

  const checkSim = async () => {
    setBusy('sim')
    try {
      const res = await tasksApi.getTaskSimilarity(task.id)
      Modal.info({ title: t('hwSimilarity'), content: res.message, description: res.pairs.map(
        (p) => `${p.a} ↔ ${p.b}（${Math.round(p.ratio * 100)}%）`).join('；') || t('hwSimNone'),
      maskClosable: false })
      await load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('loadDetailFailed'))
    } finally { setBusy(null) }
  }

  const reextract = async () => {
    setBusy('extract')
    try {
      const res = await tasksApi.reextractTaskFiles(task.id)
      message.success(res.message)
      await load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('loadDetailFailed'))
    } finally { setBusy(null) }
  }

  const saveReview = async () => {
    if (!review) return
    setBusy('review')
    try {
      const res = await tasksApi.reviewGrade(task.id, {
        student: review.student, score: review.score, comment: review.comment,
        needs_review: false,
      })
      if (res.grade) setGrades((prev) => ({ ...prev, [review.student]: res.grade }))
      message.success(res.message)
      setReview(null); onChanged?.()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('saveFailed'))
    } finally { setBusy(null) }
  }

  const total = task.total_score || ov?.total_score || 100
  const gradedOk = Object.values(grades).filter((g) => (g.teacher_score ?? g.ai_score) != null).length
  const unpublished = Object.values(grades).filter((g) => g.published === false && (g.teacher_score ?? g.ai_score) != null).length
  const needReview = Object.values(grades).filter((g) => g.needs_review).length
  const dims = useMemo(() => {
    try {
      const d = JSON.parse(task.rubric || '[]')
      return Array.isArray(d) && d.length ? d : DEFAULT_DIMS
    } catch { return DEFAULT_DIMS }
  }, [task.rubric])

  return (
    <div>
      {/* 顶部：口径与批量动作。批改数必须说清"有效/待人工/未发布"，否则教师以为批完了 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={6} style={{ marginBottom: job ? 8 : 0 }}>
          <Tag color="blue">{t('hwModeFile')}</Tag>
          <Tag>{t('hwSubmitted', { n: Object.keys(submitted).length, m: roster.length })}</Tag>
          <Tag color={gradedOk ? 'green' : 'default'}>{t('hwGraded', { n: gradedOk })}</Tag>
          {needReview > 0 && <Tag color="orange">{t('hwNeedReview', { n: needReview })}</Tag>}
          {unpublished > 0 && <Tag color="gold">{t('hwUnpublished', { n: unpublished })}</Tag>}
          {missing.length > 0 && <Tag color="red">{t('hwAiMissed', { n: missing.length })}</Tag>}
          {task.publish_status === 'published' && <Tag color="green" icon={<CheckCircleOutlined />}>{t('hwPublishedTag')}</Tag>}
        </Space>
        {job && <Tag color="processing">{job}</Tag>}
        <Space wrap style={{ marginTop: 8 }}>
          <Button type="primary" icon={<RobotOutlined />} loading={busy === 'grade'}
            disabled={!!job} onClick={() => runJob()}
          >{t('hwAiGradeAll')}</Button>
          <Button icon={<SafetyCertificateOutlined />} loading={busy === 'publish'}
            disabled={!unpublished && !Object.keys(grades).length} onClick={publish}
          >{t('hwPublish')}</Button>
          <Button icon={<ReloadOutlined />} loading={busy === 'sim'} onClick={checkSim}>{t('hwSimilarity')}</Button>
          <Button icon={<ReloadOutlined />} loading={busy === 'extract'} onClick={reextract}>{t('hwReextract')}</Button>
          <Button icon={<DownloadOutlined />}
            href={tasksApi.homeworkArchiveUrl(task.id)} target="_blank">{t('hwArchive')}</Button>
          <Button icon={<ReloadOutlined />} onClick={load}>{t('refresh')}</Button>
        </Space>
        <div style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('hwDimsHint')}：{dims.map((d: any) => `${d.name} ${d.max}`).join(' / ')}</Text>
        </div>
      </Card>

      {roster.length === 0 && <Empty description={t('hwNoStudent')} />}

      {roster.map((stu) => {
        const files = filesOf(stu.username)
        const sub = submitted[stu.username]
        const g = grades[stu.username]
        const score = g ? (g.teacher_score ?? g.ai_score) : null
        const level = score == null ? null
          : score >= total * 0.9 ? 'green' : score >= total * 0.75 ? 'blue'
          : score >= total * 0.6 ? 'orange' : 'red'
        return (
          <Card key={stu.username} size="small" style={{ marginBottom: 10 }}
            title={
              <Space wrap size={6}>
                <Text strong>{stu.name || stu.username}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{stu.username}</Text>
                {sub ? (
                  <>
                    <Tag color="cyan">{t('hwSeq', { n: files[0]?.seq || 1 })}</Tag>
                    {sub.late_submitted && <Tag color="volcano">{t('hwLate')}</Tag>}
                  </>
                ) : <Tag>{t('hwNotSubmitted')}</Tag>}
                {g?.needs_review && <Tag color="orange">{t('hwNeedReviewTag')}</Tag>}
                {g && g.published === false && <Tag color="gold">{t('hwNotPublished')}</Tag>}
                {score != null && <Tag color={level as string}>{score} / {total}</Tag>}
              </Space>
            }
            extra={
              <Space size={4}>
                <Button size="small" icon={<RobotOutlined />} loading={busy === `grade:${stu.username}`}
                  onClick={() => runJob(stu.username)}>{t('hwAiGradeOne')}</Button>
                <Button size="small" onClick={() => setReview({
                  student: stu.username, score: Number(score ?? 0), comment: g?.comment || '',
                })} disabled={!sub}>{t('hwReview')}</Button>
              </Space>
            }
          >
            {files.length > 0 ? (
              <Space wrap size={6} style={{ marginBottom: 8 }}>
                {files.map((f) => {
                  const meta = statusMeta(f.extract_status)
                  return (
                    <Tooltip key={f.id} title={f.error || t('hwClickPreview')}>
                      <Tag color={meta.color}>
                        <a href={tasksApi.homeworkFileUrl(f.id)} download>{f.filename}</a>
                        {' · '}{fmtSize(f.size)}{f.chars ? ` · ${f.chars}字` : ''}（{t(meta.key)}）
                        <a style={{ marginLeft: 6 }} onClick={(e) => { e.preventDefault(); setPreview(f) }}>
                          {t('hwPreview')}
                        </a>
                      </Tag>
                    </Tooltip>
                  )
                })}
              </Space>
            ) : null}
            {sub?.note && (
              <Paragraph style={{ fontSize: 12 }} ellipsis={{ rows: 2 }}>
                {t('hwNote')}: {sub.note}
              </Paragraph>
            )}

            {g ? (
              <div>
                {g.dim_scores && Object.keys(g.dim_scores).length > 0 && (
                  <Space wrap size={4} style={{ marginBottom: 6 }}>
                    {Object.entries(g.dim_scores).map(([k, v]) => (
                      <Tag key={k}>{k} {Number(v)}</Tag>
                    ))}
                  </Space>
                )}
                {g.criteria?.length ? (
                  <div style={{ marginBottom: 6 }}>
                    {g.criteria.map((c, i) => (
                      <div key={i} style={{ fontSize: 12 }}>
                        {criterionIcon(c.status)} {c.item}
                        {c.evidence && <Text type="secondary"> — {c.evidence}</Text>}
                      </div>
                    ))}
                  </div>
                ) : null}
                {g.comment && <Paragraph style={{ fontSize: 13, marginBottom: 4 }}>{g.comment}</Paragraph>}
                {g.feedback && (
                  <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
                    {t('hwFeedback')}: {g.feedback}
                  </Paragraph>
                )}
                {g.similarity?.length ? (
                  <Alert type="warning" showIcon style={{ marginTop: 6 }}
                    message={t('hwSimWarn')}
                    description={g.similarity.map((s: any) => `${s.with}（${Math.round(s.ratio * 100)}%）`).join('、')}
                  />
                ) : null}
                {g.ai_score != null && g.teacher_score != null && g.teacher_score !== g.ai_score && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('hwAiScoreWas')}: {g.ai_score}
                  </Text>
                )}
              </div>
            ) : (sub ? <Text type="secondary" style={{ fontSize: 12 }}>{t('hwNotGraded')}</Text> : null)}
          </Card>
        )
      })}

      <Modal maskClosable={false} open={!!review} title={t('hwReview')} onCancel={() => setReview(null)}
        onOk={saveReview} okText={t('save')} cancelText={t('cancel')} confirmLoading={busy === 'review'}
      >
        {review && (
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Text type="secondary">{review.student}</Text>
            <Space>
              <Text>{t('hwScoreLabel')}</Text>
              <InputNumber min={0} max={total} value={review.score}
                onChange={(v) => setReview({ ...review, score: Number(v) || 0 })} />
              <Text type="secondary">/ {total}</Text>
            </Space>
            <Input.TextArea rows={3} value={review.comment}
              onChange={(e) => setReview({ ...review, comment: e.target.value })}
              placeholder={t('hwCommentHint')} />
          </Space>
        )}
      </Modal>

      <Modal open={!!preview} title={preview?.filename} footer={null} width={720}
        onCancel={() => setPreview(null)}
      >
        {preview && (
          preview.kind === 'image' ? (
            <Image src={tasksApi.homeworkFileUrl(preview.id, true)} />
          ) : (
            <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto', fontSize: 13 }}>
              {preview.text_preview || t('hwNoText')}
              {preview.text_truncated ? `\n\n…${t('hwTruncated')}` : ''}
            </pre>
          )
        )}
      </Modal>
    </div>
  )
}
