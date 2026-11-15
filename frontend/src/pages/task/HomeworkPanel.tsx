/**
 * 文件提交类作业的前端面板（学生提交 + 教师批改）。
 *
 * 后端：backend/api/tasks_router.py（文件作业段）+ backend/homework.py
 * 口径：一次提交=一个批次(seq)，批改只看最后一次；AI 分默认待复核，教师点发布学生才可见。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Collapse, Empty, Image, Input, InputNumber, Modal, Pagination, Popconfirm, Progress, Radio, Row, DatePicker, Select, Space, Switch, Tag, Tooltip, Typography, Upload } from 'antd'
import { message, modalApi } from '../../utils/feedback'
import {
  CameraOutlined, CheckCircleOutlined, CloudUploadOutlined, DeleteOutlined, DownloadOutlined,
  FileTextOutlined, ReloadOutlined, RobotOutlined, SafetyCertificateOutlined, SendOutlined, UndoOutlined,
} from '@ant-design/icons'
import dayjs, { type Dayjs } from 'dayjs'
import { useTranslation } from 'react-i18next'
import * as tasksApi from '../../api/tasks'
import type { HomeworkFileItem } from '../../api/tasks'
import CameraCapture from '../../components/CameraCapture'
import type { TaskInfo } from '../../types'
import {
  DEFAULT_DIMS, statusMeta, fmtSize,
  startAndPollFileGrading, type HomeworkValue,
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

        {/* 截止/总分/重交次数/允许迟交/批改策略 三种形态一律开放（P1-3）：后端列早就有，
            以前被 isFile 整个挡在表单外，于是对话作业永远"无截止、随时能交、没有迟交"，
            待办里也永远排到最后。收文件的字段仍按形态单独控制。 */}
        {(
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
              {isFile && (
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwMaxFiles')}</Text>
                <InputNumber
                  min={1} max={10} style={{ width: '100%', marginTop: 4 }}
                  value={value.max_files} onChange={(v) => set('max_files', Number(v) || 3)}
                />
              </Col>
              )}
              {isFile && (
              <Col span={8}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwMaxFileMb')}</Text>
                <InputNumber
                  min={1} max={maxFileMbCap} style={{ width: '100%', marginTop: 4 }}
                  value={Math.min(value.max_file_mb, maxFileMbCap)}
                  onChange={(v) => set('max_file_mb', Number(v) || 10)}
                />
              </Col>
              )}
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
              <Col span={24}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwVisibleNote')}</Text>
              </Col>
            </Row>

            {isFile && (<>
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
            </>)}
            {!isFile && <Text type="secondary" style={{ fontSize: 12 }}>{t('hwConvNoDims')}</Text>}
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
  const [ov, setOv] = useState<tasksApi.HomeworkOverview | null>(null)
  const [picked, setPicked] = useState<File[]>([])
  const [note, setNote] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
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

  useEffect(() => { if (open) reload() }, [open, reload])

  const maxFiles = ov?.max_files ?? task.max_files ?? 3
  const maxMb = ov?.max_file_mb ?? task.max_file_mb ?? 10
  const allowed = ov?.allowed_exts ?? []
  const mine = useMemo(() => (ov?.files || []).filter((f) => f.is_latest), [ov])
  // 历次提交：后端没给 history 时退回"只看最新一批"，至少不空
  const history = useMemo(() => {
    if (ov?.history?.length) return ov.history
    return mine.length
      ? [{ seq: mine[0].seq, is_latest: true, submitted_at: '', late_submitted: false,
           files: mine.map((f) => ({ id: f.id, filename: f.filename, kind: f.kind,
             size: f.size, extract_status: f.extract_status, url: f.url })) }]
      : []
  }, [ov, mine])
  // 学生视角只看自己：后端每次提交把 seq 递增（首次=1），所以最新 seq 就是「已经交过的次数」
  const usedTimes = mine.length ? mine[0].seq : 0
  const limit = ov?.resubmit_limit ?? task.resubmit_limit ?? 3
  // 教师「允许再交一次」的次数要算进上限（P0-5），否则学生会看到"次数用完"却又真能交进去
  const extra = ov?.extra_times ?? 0
  const ceiling = limit > 0 ? limit + extra : 0
  const left = ceiling > 0 ? Math.max(0, ceiling - usedTimes) : Infinity
  const deadline = ov?.deadline_at || task.deadline_at || ''
  // 是否已截止一律用后端算好的值（P1-4）：以前在这里拿浏览器时钟比 deadline，
  // 学生把本机时间往回调就能绕过截止；名单接口还没回来时退回列表里同一份后端值
  const closed = ov ? !!ov.expired : !!task.expired
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
    <Modal mask={{ closable: false }}
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
              <span>{ceiling > 0
                ? t('hwTimesUsed', { used: usedTimes, left, limit: ceiling })
                : t('hwUnlimitedTimes')}</span>
              {!!extra && (
                <Tag color="purple">{t('hwExtraTimes', { n: extra })}</Tag>
              )}
            </Space>
          }
        />
        {/* 截止 ≠ 结束（拍板④）：允许迟交时仍可交，只是记迟交；关闭了迟交就明确说不能交 */}
        {closed && (
          <Alert type={ov?.closed_for_submit ? "error" : "warning"} showIcon
            message={t(ov?.closed_for_submit ? 'hwClosedNoSubmit' : 'hwClosedWarn')}
            description={t('hwExpiredNote')}
          />
        )}
        {ceiling > 0 && left <= 0 && (
          <Alert type="error" showIcon message={t('hwNoTimesLeft', { limit: ceiling })}
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
          <Text type="secondary" style={{ fontSize: 12 }}>{t('hwMyHistory')}</Text>
          {loading ? <Text style={{ marginLeft: 8 }}>{t('loading')}</Text> : (
            history.length ? (
              <Space orientation="vertical" size={8} style={{ width: '100%', marginTop: 6 }}>
                {history.map((h) => {
                  // 学生要能确认"老师收到的是哪一版"：以前只显示最新一批，
                  // 重交过的学生自己都不知道现在生效的是第几版，只能去问老师
                  return (
                    <div key={h.seq}>
                      <Space wrap size={4}>
                        <Tag color={h.is_latest ? 'cyan' : 'default'}>{t('hwSeq', { n: h.seq })}</Tag>
                        {h.is_latest && <Tag color="success">{t('hwEffectiveVersion')}</Tag>}
                        {!!h.submitted_at && (
                          <Text type="secondary" style={{ fontSize: 12 }}>{h.submitted_at}</Text>
                        )}
                        {h.late_submitted && <Tag color="volcano">{t('hwLate')}</Tag>}
                      </Space>
                      <div style={{ marginTop: 2 }}>
                        <Space wrap size={4}>
                          {h.files.map((f) => {
                            const meta = statusMeta(f.extract_status)
                            return (
                              <Tag key={f.id} color={meta.color}
                                closable={h.is_latest}
                                onClose={(ev) => { ev.preventDefault(); removeMine(f as any) }}
                              >
                                <a href={f.url} download>{f.filename}</a>
                                {' · '}{fmtSize(f.size)}（{t(meta.key)}）
                              </Tag>
                            )
                          })}
                        </Space>
                      </div>
                    </div>
                  )
                })}
              </Space>
            ) : <Text type="secondary" style={{ marginLeft: 8 }}>{t('hwNotSubmitted')}</Text>
          )}
        </div>

        {/* 拍照上传不再只在手机出现：桌面接了摄像头/高拍台的学生同样要用。
            CameraCapture 自己会处理"没有设备"，所以这里一律给入口，比按视口藏起来诚实。 */}
        <Button icon={<CameraOutlined />} onClick={() => setCameraOpen(true)}>{t('hwTakePhoto')}</Button>
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
  /** 兜底名单（应交名单取不到时才用，只含已提交的人） */
  roster: { username: string; name: string }[]
  onChanged?: () => void
}

/** 批改台里的一行：应交名单打底，未交的学生也要成行（P1-1） */
interface BoardPerson {
  username: string
  name: string
  grade?: string
  class_name?: string
  submitted: boolean
  submitted_at?: string
  /** 批改过后又重交（P0-3） */
  stale?: boolean
  late?: boolean
  /** 教师额外允许再交的次数（P0-5） */
  extra_times?: number
}

type BoardFilter = 'submitted' | 'all' | 'missing' | 'ungraded' | 'review' | 'unpublished'

/** 档位顺序：已交排第一，默认就停在这一档（见 activeFilter） */
const FILTER_KEYS: BoardFilter[] = ['submitted', 'all', 'missing', 'ungraded', 'review', 'unpublished']

/** 筛选档的词条键（平铺键，与其余 hw* 一致，不用点号嵌套） */
const FILTER_LABELS: Record<BoardFilter, string[]> = {
  submitted: ['hwFilterSubmitted'],
  all: ['hwFilterAll'],
  missing: ['hwFilterMissing'],
  ungraded: ['hwFilterUngraded'],
  review: ['hwFilterReview'],
  unpublished: ['hwFilterUnpublished'],
}

/** 一行一条、默认收起，一屏 20 人够横向比对；再多人靠分页，而不是把教师埋在长页里 */
const BOARD_PAGE = 20

/** 空年级/空班级归成一档（这些人不能因为字段为空就从筛选里消失）。
    线上传的是哨兵值、显示交给 i18n —— 拿中文当协议值的话，英文界面既显示中文、
    又往后端发一个中文串，翻译一改就断。 */
const NO_SCOPE_VALUE = '__none__'

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
  const [roster0, setRoster0] = useState<tasksApi.TaskRoster | null>(null)
  // 档位默认不写死：交给"有没有人交"决定（见 activeFilter）。
  // 发向全体的作业应交上千人，默认停在"全部"就等于第一屏全是未交的人，
  // 教师进来什么也干不了 —— 他要看的永远是"已经交上来的这几份"。
  const [filter, setFilter] = useState<BoardFilter | null>(null)
  const [page, setPage] = useState(1)
  // 人头列表默认全部收起（教师第一眼要扫的是"谁交了、几分、要不要人工"，
  // 不是几十屏评语）；点开某一行才展开维度分与要求点
  const [openKeys, setOpenKeys] = useState<string[]>([])
  const [pageSize, setPageSize] = useState(BOARD_PAGE)
  // 批改台内的班级筛选：发给全体的作业应交上千人，只看状态档仍然翻不动。
  // 选项来自名单本身（people 的 class_name），与列表页那个下拉同源同理。
  const [classFilter, setClassFilter] = useState('')
  // 年级在前、班级在后：发给全体的作业横跨几个年级，直接列几十个班不好选
  const [gradeFilter, setGradeFilter] = useState('')

  const load = useCallback(async () => {
    try {
      // 应交名单与文件清单一起取：批改台的分母从此是"该谁交"，不再是"谁交了"（P0-2 / P1-1）
      const [o, g, rs] = await Promise.all([
        tasksApi.getTaskFiles(task.id),
        tasksApi.getTaskGrades(task.id),
        tasksApi.getTaskRoster(task.id).catch(() => null),
      ])
      setOv(o)
      setRoster0(rs)
      const map: Record<string, tasksApi.AIGradeResult> = {}
      ;(g.grades || []).forEach((x) => { map[x.student] = x })
      setGrades(map)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('loadDetailFailed'))
    }
  }, [task.id, t])

  // 换一份作业先把上一份的批改数据清掉：批改台是同一个组件实例复用，
  // 不清的话 fetch 回来之前那几秒显示的是别的作业的成绩与名单
  useEffect(() => {
    setOv(null)
    setGrades({})
    setRoster0(null)
    setMissing([])
    setOpenKeys([])
    setPage(1)
  }, [task.id])

  useEffect(() => { load() }, [load])

  // ov 每次重新赋值都是新对象，这里过一层 useMemo，免得下游 people/filtered 的依赖每轮都变
  const submitted = useMemo(() => ov?.submissions || {}, [ov])
  const filesOf = useCallback((stu: string) =>
    (ov?.files || []).filter((f) => f.student === stu && f.is_latest), [ov])

  /**
   * 批改台的人头表：应交名单（含一个都没交的）打底，交过的补上提交时间/迟交/待重批。
   *
   * 名单取不到时（只读预览等）退回"提交名单"，功能不受影响，
   * 但分母会退化成已交人数 —— 这一点由顶部的 hwRosterUnknown 标签如实告诉教师。
   */
  const people = useMemo<BoardPerson[]>(() => {
    const map = new Map<string, BoardPerson>()
    ;(roster0?.missing || []).forEach((x) => map.set(x.username, {
      username: x.username, name: x.name || x.username,
      grade: x.grade, class_name: x.class_name, submitted: false,
    }))
    ;(roster0?.submitted || []).forEach((x) => map.set(x.username, {
      username: x.username, name: x.name || x.username,
      grade: x.grade, class_name: x.class_name, submitted: true,
      submitted_at: x.submitted_at, stale: x.stale, late: x.late_submitted, extra_times: x.extra_times,
    }))
    if (!roster0) {
      roster.forEach((x) => map.set(x.username, {
        username: x.username, name: x.name || x.username, submitted: true,
        stale: (ov?.stale_students || []).includes(x.username),
        extra_times: (submitted[x.username] as any)?.extra_times,
      }))
    }
    // String() 是必需的，不是洁癖：users.class 在遗留数据里是数字（"3"），
    // 后端已经统一走 attach_student_info 规范化，但前端这里再兜一层 ——
    // 一个 localeCompare is not a function 会把整块批改台白屏掉
    return [...map.values()].sort((a, b) =>
      String(a.class_name || '').localeCompare(String(b.class_name || '')) ||
      String(a.name || '').localeCompare(String(b.name || '')))
  }, [roster0, roster, ov, submitted])

  const expectedCount = roster0 ? roster0.expected_count : 0
  const submittedCount = people.filter((p) => p.submitted).length
  const missingCount = people.filter((p) => !p.submitted).length
  const staleCount = people.filter((p) => p.stale).length

  const activeFilter: BoardFilter = filter ?? (submittedCount > 0 ? 'submitted' : 'all')

  /** 自然序：高一2班 要排在 高一10班 前面，纯字符串比较会反过来 */
  const naturalSort = (a: string, b: string) => {
    const na = +(a.match(/\d+/) || [0])[0], nb = +(b.match(/\d+/) || [0])[0]
    return a.replace(/\d+/g, '').localeCompare(b.replace(/\d+/g, ''), 'zh') || na - nb || a.localeCompare(b, 'zh')
  }
  const gradeOf = (p: BoardPerson) => String(p.grade || '').trim() || NO_SCOPE_VALUE
  const classOf = (p: BoardPerson) => String(p.class_name || '').trim() || NO_SCOPE_VALUE
  /** 哨兵值只活在筛选逻辑与网络里，界面上永远显示译文 */
  const scopeLabel = (v: string) => (v === NO_SCOPE_VALUE ? t('hwNoScope') : v)

  /** 年级选项来自名单本身，不另找一处年级清单：两处不同源就会出现选了年级、下面空一片 */
  const boardGradeOptions = useMemo(
    () => [...new Set(people.map(gradeOf))].sort(naturalSort), [people])

  /** 班级选项跟着已选年级收窄；没选年级时列全部 */
  const boardClassOptions = useMemo(() => {
    const src = gradeFilter ? people.filter((p) => gradeOf(p) === gradeFilter) : people
    return [...new Set(src.map(classOf))].sort(naturalSort)
  }, [people, gradeFilter])

  /** 年级/班级先于状态生效：档位上的数字必须跟着一起变，
      否则"已交 (3)"配下面只剩 1 行，教师不敢信这些数 */
  const byClass = useMemo(() => {
    let list = people
    if (gradeFilter) list = list.filter((p) => gradeOf(p) === gradeFilter)
    if (classFilter) list = list.filter((p) => classOf(p) === classFilter)
    return list
  }, [people, gradeFilter, classFilter])

  /** 判定只写一处：档位计数与列表过滤共用，避免「标签写 3 人、点进去 2 人」 */
  const matchesFilter = useCallback((p: BoardPerson, k: BoardFilter): boolean => {
    const g = grades[p.username]
    const score = g ? (g.teacher_score ?? g.ai_score) : null
    if (k === 'submitted') return p.submitted
    if (k === 'missing') return !p.submitted
    if (k === 'ungraded') return p.submitted && score == null
    if (k === 'review') return !!g?.needs_review
    if (k === 'unpublished') return !!g && g.published === false && score != null
    return true
  }, [grades])

  const filtered = useMemo(() => byClass.filter((p) => matchesFilter(p, activeFilter)),
    [byClass, matchesFilter, activeFilter])

  // 每一档都带人数：上千人的名单里，教师得先知道「未批改到底有几个人」才知道点哪档
  const filterCounts = useMemo(() => {
    const m = {} as Record<BoardFilter, number>
    FILTER_KEYS.forEach((k) => { m[k] = byClass.filter((p) => matchesFilter(p, k)).length })
    return m
  }, [byClass, matchesFilter])

  const shown = filtered.slice((page - 1) * BOARD_PAGE, page * BOARD_PAGE)
  // 展开/收起合成一个开关（与聊天历史同一交互），全展开时再点就是收起
  const allOpen = shown.length > 0 && shown.every((p) => openKeys.includes(p.username))

  /** 允许某个学生再交一次（P0-5）：只放宽限额，不动已交的文件与成绩 */
  const grant = async (stu: string) => {
    setBusy('grant:' + stu)
    try {
      const res = await tasksApi.grantResubmit(task.id, stu)
      message.success(res.message)
      await load()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('saveFailed'))
    } finally { setBusy(null) }
  }

  /** 一键催交（P1-2）：走通知中心，与练习侧「提醒未提交」同一口径 */
  const remind = async () => {
    setBusy('remind')
    try {
      const res = await tasksApi.notifyUnsubmitted(task.id, { grade: gradeFilter, className: classFilter })
      message.success(res.message)
      await load()
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('hwRemindFailed'))
    } finally { setBusy(null) }
  }

  /** 全班批改：提交后台任务并轮询进度（文件多时这一步会跑几分钟） */
  const runJob = async (student?: string) => {
    setBusy(student ? `grade:${student}` : 'grade')
    setJob(t('hwJobStarted'))
    try {
      // 轮询逻辑与列表上的「AI 批改」按钮共用一份（startAndPollFileGrading），不再各写一遍
      const r = await startAndPollFileGrading(task.id, student, (phase) => setJob(phase))
      message.success(r.message || t('hwJobDone'))
      // 单人重批完自动展开那一行：教师点的就是"看这个人批得怎么样"，
      // 还要他自己再拉一下折叠面板就多余了
      if (student) setOpenKeys((prev) => (prev.includes(student) ? prev : [...prev, student]))
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
        title: t('hwPublished'), content: res.message, mask: { closable: false },
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
      modalApi.info({ title: t('hwSimilarity'), content: res.message, description: res.pairs.map(
        (p) => `${p.a} ↔ ${p.b}（${Math.round(p.ratio * 100)}%）`).join('；') || t('hwSimNone'),
      mask: { closable: false } })
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

  /** 分数分布：按这份作业的满分折算成百分位再分档，教师一眼看出"是不是普遍偏低" */
  const dist = useMemo(() => {
    const buckets = [0, 0, 0, 0, 0]
    let scored = 0
    byClass.forEach((p) => {
      if (!p.submitted) return
      const g = grades[p.username]
      const s = g ? (g.teacher_score ?? g.ai_score) : null
      if (s == null) return
      scored += 1
      const rate = total > 0 ? (Number(s) / total) * 100 : 0
      buckets[rate >= 90 ? 4 : rate >= 80 ? 3 : rate >= 70 ? 2 : rate >= 60 ? 1 : 0] += 1
    })
    return { buckets, scored }
  }, [byClass, grades, total])
  const dims = useMemo(() => {
    try {
      const d = JSON.parse(task.rubric || '[]')
      return Array.isArray(d) && d.length ? d : DEFAULT_DIMS
    } catch { return DEFAULT_DIMS }
  }, [task.rubric])

  return (
    <div>
      {/* 顶部：口径与批量动作。批改数必须说清"应交/已交/待人工/未发布"，否则教师以为批完了 */}
      <Card size="small" style={{ marginBottom: 12 }}>
        <Space wrap size={6} style={{ marginBottom: job ? 8 : 0 }}>
          <Tag color="blue">{t('hwModeFile')}</Tag>
          {/* 分母是应交人数（P0-2）；名单取不到时如实说明，不再拿已交人数冒充总数 */}
          <Tag>{expectedCount
            ? t('hwSubmitted', { n: submittedCount, m: expectedCount })
            : t('hwSubmittedNoRoster', { n: submittedCount })}</Tag>
          {missingCount > 0 && <Tag color="red">{t('hwMissingN', { n: missingCount })}</Tag>}
          {staleCount > 0 && <Tooltip title={t('hwStaleHint')}><Tag color="gold">{t('hwStaleTagN', { n: staleCount })}</Tag></Tooltip>}
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
          {/* 催交（P1-2）：应交名单里还有没交的人才给这个入口 */}
          {/* 按班级筛之后，"有没有未交"要按筛后的集合判断，催交也只催这个班 */}
          {filterCounts.missing > 0 && (
            <Button icon={<SendOutlined />} loading={busy === 'remind'} onClick={remind}>
              {t('hwRemindUnsubmitted')}
              {(gradeFilter || classFilter) ? `（${[gradeFilter, classFilter].filter(Boolean).map(scopeLabel).join(' ')}）` : ''}
            </Button>
          )}
          <Button icon={<SafetyCertificateOutlined />} loading={busy === 'publish'}
            disabled={!unpublished && !Object.keys(grades).length} onClick={publish}
          >{t('hwPublish')}</Button>
          <Button icon={<ReloadOutlined />} loading={busy === 'sim'} onClick={checkSim}>{t('hwSimilarity')}</Button>
          <Button icon={<ReloadOutlined />} loading={busy === 'extract'} onClick={reextract}>{t('hwReextract')}</Button>
          <Button icon={<DownloadOutlined />}
            href={tasksApi.homeworkArchiveUrl(task.id)} target="_blank">{t('hwArchive')}</Button>
          {/* 成绩表走既有导出端点（/api/export/tasks?task_id= 校验归属）。
              作业中心以前没有入口，教师得自己去导出中心找 */}
          <Button icon={<FileTextOutlined />}
            href={'/api/export/tasks?task_id=' + encodeURIComponent(task.id)}
            target="_blank">{t('hwExportReport')}</Button>
          <Button icon={<ReloadOutlined />} onClick={load}>{t('refresh')}</Button>
        </Space>
        <div style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('hwDimsHint')}：{dims.map((d: any) => `${d.name} ${d.max}`).join(' / ')}</Text>
        </div>
        {/* 统计条：批到哪儿了、分数长什么样，不用逐个翻卡片 */}
        {dist.scored > 0 && (
          <Space wrap size={4} style={{ marginTop: 8 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>{t('hwDistTitle')}</Text>
            {[
              { key: 'hwDistBandFail', n: dist.buckets[0], color: '#ff4d4f' },
              { key: 'hwDistBandPass', n: dist.buckets[1], color: '#faad14' },
              { key: 'hwDistBandGood', n: dist.buckets[2], color: '#1677ff' },
              { key: 'hwDistBandHigh', n: dist.buckets[3], color: '#52c41a' },
              { key: 'hwDistBandTop', n: dist.buckets[4], color: '#13c2c2' },
            ].map((b) => (
              <Tag key={b.key} color={b.n ? b.color : 'default'}>{t(b.key)} {b.n}</Tag>
            ))}
            <Text type="secondary" style={{ fontSize: 12 }}>{t('hwDistScored', { n: dist.scored })}</Text>
          </Space>
        )}
        {/* 人头一多就翻不动：先按状态筛，再分页（P2-4 的最小可用版） */}
        {/* 班级筛选：发给全体的作业应交上千人，只看状态档还是翻不动。
            选了班级后，下面这些档位计数、分数分布、人头列表都只算这个班 ——
            数字必须跟着筛一起变，否则"已交 (3)"配一行列表，教师不敢信。 */}
        <Space wrap size={6} style={{ marginTop: 8 }}>
          {boardGradeOptions.length > 1 && (
            <Select
              size="small"
              style={{ width: 110 }}
              allowClear
              showSearch
              value={gradeFilter || undefined}
              placeholder={t('hwGradeFilterPh')}
              onChange={(v) => {
                const g = v || ''
                setGradeFilter(g)
                // 换年级要把班级重置：否则"高一 + 高二3班"这种组合筛出一片空白，
                // 而班级下拉里还留着上一个个年级的选项，看起来像坏了
                setClassFilter((prev) => (prev && g && !people.some((p) => gradeOf(p) === g && classOf(p) === prev) ? '' : prev))
                setPage(1)
              }}
              options={boardGradeOptions.map((g) => ({ value: g, label: scopeLabel(g) }))}
            />
          )}
          {boardClassOptions.length > 1 && (
            <Select
              size="small"
              style={{ width: 130 }}
              allowClear
              showSearch
              value={classFilter || undefined}
              placeholder={t('hwClassFilterPh')}
              onChange={(v) => { setClassFilter(v || ''); setPage(1) }}
              options={boardClassOptions.map((c) => ({ value: c, label: scopeLabel(c) }))}
            />
          )}
          {FILTER_KEYS.map((k) => (
            <Button key={k} size="small"
              type={activeFilter === k ? 'primary' : 'default'}
              ghost={activeFilter === k}
              onClick={() => { setFilter(k); setPage(1) }}
            >{FILTER_LABELS[k].map((m) => t(m))}
              {` (${filterCounts[k] ?? 0})`}</Button>
          ))}
          {/* 展开/收起合成一个开关：全展开时再点就是收起，不占两个按钮位 */}
          {shown.length > 0 && (
            <Button size="small" type="text" onClick={() => setOpenKeys(allOpen ? [] : shown.map((p) => p.username))}>
              {t(allOpen ? 'hwCollapseAll' : 'hwExpandAll')}
            </Button>
          )}
          {/* 顶部那行标签（应交/已交/未交/已通知）始终是整份作业的口径；
              只有档位计数、分数分布和下面的人头列表跟着年级/班级走 ——
              不说清就会被读成"数字对不上" */}
          {(!!gradeFilter || !!classFilter) && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('hwClassScopedNote', {
                name: [gradeFilter, classFilter].filter(Boolean).map(scopeLabel).join(' '),
              })}
            </Text>
          )}
        </Space>
      </Card>

      {people.length === 0 && <Empty description={t('hwNoStudent')} />}
      {people.length > 0 && filtered.length === 0 && (
        <Empty description={t('hwFilterEmpty')} />
      )}

      {/* 默认全部收起：一屏能扫完"谁交了 / 几分 / 要不要人工"，点开某一行才出维度分与要求点 */}
      {shown.length > 0 && (
        <Collapse
          size="small"
          activeKey={openKeys}
          onChange={(k) => setOpenKeys(Array.isArray(k) ? (k as string[]) : [k as string])}
          items={shown.map((stu) => {
            const files = filesOf(stu.username)
        const sub = submitted[stu.username]
        const g = grades[stu.username]
        const score = g ? (g.teacher_score ?? g.ai_score) : null
        const level = score == null ? null
          : score >= total * 0.9 ? 'green' : score >= total * 0.75 ? 'blue'
          : score >= total * 0.6 ? 'orange' : 'red'
            return {
              key: stu.username,
              label: (
              <Space wrap size={6}>
                <Text strong>{stu.name || stu.username}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {/* 数字班级也要能显示：这里只做展示，不参与排序，兜 String 足够 */}
                  {stu.class_name ? String(stu.class_name) + ' · ' : ''}{stu.username}</Text>
                {sub ? (
                  <>
                    <Tag color="cyan">{t('hwSeq', { n: files[0]?.seq || 1 })}</Tag>
                    {sub.late_submitted && <Tag color="volcano">{t('hwLate')}</Tag>}
                    {/* 批过之后又重交：旧分还在，但要提醒这一版没批（P0-3） */}
                    {(stu.stale || sub.stale) && (
                      <Tooltip title={t('hwStaleHint')}>
                        <Tag color="gold">{t('hwStaleTag')}</Tag>
                      </Tooltip>
                    )}
                  </>
                ) : <Tag color="red">{t('hwNotSubmitted')}</Tag>}
                {!!stu.extra_times && <Tag color="purple">{t('hwExtraTimes', { n: stu.extra_times })}</Tag>}
                {g?.needs_review && <Tag color="orange">{t('hwNeedReviewTag')}</Tag>}
                {g && g.published === false && <Tag color="gold">{t('hwNotPublished')}</Tag>}
                {score != null && <Tag color={level as string}>{score} / {total}</Tag>}
              </Space>
              ),
              extra: (
              // 操作区自己吃掉点击，否则点「改分 / 复核」会连带把这一行收起
              <Space size={4} onClick={(e) => e.stopPropagation()}>
                {/* 未交的人没有可批的东西，按钮直接不给（以前点了只会拿到"无提交"的错误） */}
                {stu.submitted && (
                  <Button size="small" icon={<RobotOutlined />} loading={busy === `grade:${stu.username}`}
                    onClick={() => runJob(stu.username)}>{t('hwAiGradeOne')}</Button>
                )}
                {/* 允许再交一次（P0-5）：交过就把限额用满、还想给机会的学生，不必再走"回退提交"这种删数据的重手 */}
                {stu.submitted && (
                  <Popconfirm title={t('hwGrantConfirm', { name: stu.name || stu.username })}
                    description={t('hwGrantDesc')} okText={t('confirmOk')} cancelText={t('cancel')}
                    onConfirm={() => grant(stu.username)}
                  >
                    <Button size="small" icon={<UndoOutlined />}>{t('hwGrantResubmit')}</Button>
                  </Popconfirm>
                )}
                <Button size="small" onClick={() => setReview({
                  student: stu.username, score: Number(score ?? 0), comment: g?.comment || '',
                })} disabled={!sub}>{t('hwReview')}</Button>
              </Space>
              ),
              children: (
            <>
            {/* 没交的人也要有地方说清"该做什么"，否则展开是一片空白 */}
            {!stu.submitted && (
              <Space wrap size={6}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('hwNotSubmittedHint')}</Text>
                <Button size="small" icon={<SendOutlined />} loading={busy === 'remind'} onClick={remind}>
                  {t('hwRemindUnsubmitted')}
                </Button>
              </Space>
            )}
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
            </>
              ),
            }
          })}
        />
      )}

      {/* 应交名单可能几十上百人：筛完再分页，别把教师埋在长页里 */}
      {filtered.length > pageSize && (
        <div style={{ textAlign: 'right', marginTop: 4 }}>
          <Pagination size="small" current={page} pageSize={pageSize} total={filtered.length}
            showSizeChanger pageSizeOptions={[10, 20, 50]}
            onChange={(p, ps) => { setPage(ps !== pageSize ? 1 : p); setPageSize(ps) }}
            showTotal={(tt) => t('hwPageTotal', { n: tt })} />
        </div>
      )}

      <Modal mask={{ closable: false }} open={!!review} title={t('hwReview')} onCancel={() => setReview(null)}
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
