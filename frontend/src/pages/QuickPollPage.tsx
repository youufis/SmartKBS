/**
 * QuickPollPage — 课堂投票
 *
 * 本轮重做：选项数量 2-10（滑杆 + 3/4/5 快捷 + 自动）、投票可结束/重开、投完可改、
 * 多选可限项、结果排序与自动刷新、投屏大屏、匿名与截止时间。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Card, Checkbox, Divider, Empty, Form, Input, Modal, Pagination, Segmented, Select, Slider, Space, Spin, Switch, Tag, Tooltip, Typography } from 'antd'
import { message, modalApi } from '../utils/feedback'
import {
  BarChartOutlined, CheckCircleOutlined, DeleteOutlined, DownloadOutlined, EditOutlined,
  FullscreenOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, RobotOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import ActivityScopeSelector from '../components/ActivityScopeSelector'
import type { ActivityScopeValue } from '../components/ActivityScopeSelector'
import ResetActivityButton from '../components/ResetActivityButton'
import FormulaRenderer from '../components/FormulaRenderer'
import { RowList } from '../components/RowList'
import ScopeTag from '../components/ScopeTag'
import ListFilterBar from '../components/ListFilterBar'
import PageHeader from '../components/PageHeader'
import useSubjectOptions from '../hooks/useSubjectOptions'
import { reportLoadError } from '../utils/loadError'
import PollOptionsEditor, { POLL_OPTION_MAX, POLL_OPTION_MIN } from '../components/polls/PollOptionsEditor'
import PollResultsView from '../components/polls/PollResultsView'
import type { PollResultsData } from '../components/polls/PollResultsView'
import '../styles/poll.css'

const { Text } = Typography

interface PollItem {
  id: number
  creator_username: string
  creator_name: string
  question: string
  poll_type: string
  options: Array<{ index: number; text: string; votes: number }>
  option_count: number
  total_votes: number
  unique_voters: number
  voted: boolean
  my_indices: number[]
  created_at: string
  status: 'active' | 'ended'
  ended: boolean
  anonymous: boolean
  ends_at: string
  max_choices: number
  target_scope: string
  target_grade: string
  target_class: string
  target_users: string
  subject: string
}

const EMPTY_SCOPE: ActivityScopeValue = {
  target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '',
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmtDateTime = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
  + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`

/** 剩余时间的人话表述（走 i18n）；已截止返回空串 */
const remaining = (endsAt: string, t: (k: string, o?: Record<string, unknown>) => string): string => {
  if (!endsAt) return ''
  const end = new Date(endsAt.replace(' ', 'T'))
  const diff = end.getTime() - Date.now()
  if (Number.isNaN(diff) || diff <= 0) return ''
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return t('pollMinRemain', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('pollHourMinRemain', { h: hours, m: mins % 60 })
  return t('pollDayRemain', { d: Math.floor(hours / 24) })
}

/** 删除按钮：需要翻译与确认框，抽成组件避免在 renderItem 里堆 UI */
const DeletePollButton: React.FC<{ onConfirm: () => void }> = ({ onConfirm }) => {
  const { t } = useTranslation('interaction')
  return (
    <Tooltip title={t('delete')}>
      <Button
        size="small"
        type="text"
        danger
        icon={<DeleteOutlined />}
        onClick={(e) => {
          e.stopPropagation()
          modalApi.confirm({
            title: t('confirmDeletePoll'),
            okText: t('confirm'),
            okType: 'danger',
            cancelText: t('cancel'),
            onOk: onConfirm,
          })
        }}
      />
    </Tooltip>
  )
}

const QuickPollPage: React.FC = () => {
  const { t } = useTranslation('interaction')
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'
  const { subjects: subjectOptions } = useSubjectOptions()

  const [polls, setPolls] = useState<PollItem[]>([])
  const [loading, setLoading] = useState(false)
  const [kw, setKw] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'ended'>('all')
  const [subjectFilter, setSubjectFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [pollScope, setPollScope] = useState<ActivityScopeValue>(EMPTY_SCOPE)
  const pollType = Form.useWatch('poll_type', createForm) || 'single'

  const [editPoll, setEditPoll] = useState<PollItem | null>(null)
  const [editForm] = Form.useForm()

  const [votePoll, setVotePoll] = useState<PollItem | null>(null)
  const [picked, setPicked] = useState<number[]>([])

  const [resultPollId, setResultPollId] = useState<number | null>(null)
  const [resultData, setResultData] = useState<PollResultsData | null>(null)
  const [bigScreen, setBigScreen] = useState(false)

  const [aiOpen, setAiOpen] = useState(false)
  const [aiForm] = Form.useForm()
  const [aiLoading, setAiLoading] = useState(false)
  const [aiPreview, setAiPreview] = useState<{ question: string; options: string[] } | null>(null)
  const aiAuto = Form.useWatch('auto_count', aiForm)
  const aiCount = Form.useWatch('option_count', aiForm) ?? 4

  const loadPolls = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/polls', { params: { status: 'all' } })
      setPolls(data.polls || [])
    } catch (err) {
      reportLoadError(err, { key: 'quickPoll.list' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadPolls() }, [loadPolls])

  // ── 结果拉取 + 自动刷新（结果弹窗或投屏打开时每 3 秒） ──
  const fetchResults = useCallback(async (pollId: number, silent = false) => {
    try {
      const { data } = await apiClient.get<PollResultsData>(`/api/interaction/polls/${pollId}/results`)
      setResultData(data)
    } catch (err: any) {
      if (!silent) message.error(err?.response?.data?.detail || t('loadResultsFailed'))
    }
  }, [t])

  useEffect(() => {
    if (resultPollId == null) { setResultData(null); return }
    void fetchResults(resultPollId)
    const timer = setInterval(() => { void fetchResults(resultPollId, true) }, 3000)
    return () => clearInterval(timer)
  }, [resultPollId, fetchResults])

  const openResults = (poll: PollItem) => { setResultPollId(poll.id); setBigScreen(false) }
  const openBigScreen = (poll: PollItem) => { setResultPollId(poll.id); setBigScreen(true) }

  // ── 创建 ──
  const submitCreate = async () => {
    const v = await createForm.validateFields()
    const options: string[] = (v.options || []).map((o: string) => String(o).trim()).filter(Boolean)
    const unique = Array.from(new Set(options))
    if (unique.length < POLL_OPTION_MIN) { message.warning(t('minOptions')); return }
    if (unique.length !== options.length) { message.warning(t('pollDuplicateOptions')); return }
    const minutes = Number(v.duration || 0)
    try {
      await apiClient.post('/api/interaction/polls', {
        question: v.question,
        options: unique,
        poll_type: v.poll_type || 'single',
        subject: v.subject || '',
        anonymous: !!v.anonymous,
        ends_at: minutes > 0 ? fmtDateTime(new Date(Date.now() + minutes * 60000)) : '',
        max_choices: v.poll_type === 'multiple' ? Number(v.max_choices || 0) : 0,
        ...pollScope,
      })
      message.success(t('pollCreated'))
      setCreateOpen(false)
      createForm.resetFields()
      setPollScope(EMPTY_SCOPE)
      await loadPolls()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('createFailed'))
    }
  }

  // ── 投票 / 改投 ──
  const startVote = (poll: PollItem) => {
    setVotePoll(poll)
    setPicked(poll.my_indices || [])
  }

  const submitVote = async () => {
    if (!votePoll) return
    if (!picked.length) { message.warning(t('selectOptionFirst')); return }
    try {
      await apiClient.post(`/api/interaction/polls/${votePoll.id}/vote`, null, {
        params: votePoll.poll_type === 'multiple'
          ? { option_indices: [...picked].sort((a, b) => a - b).join(',') }
          : { option_index: picked[0] },
      })
      message.success(t('voteSuccess'))
      setVotePoll(null)
      await loadPolls()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('voteFailed'))
    }
  }

  const togglePick = (index: number) => {
    if (!votePoll) return
    if (votePoll.poll_type !== 'multiple') { setPicked([index]); return }
    const max = votePoll.max_choices || 0
    if (picked.includes(index)) { setPicked(picked.filter(i => i !== index)); return }
    if (max && picked.length >= max) { message.warning(t('pollMaxChoices', { count: max })); return }
    setPicked([...picked, index])
  }

  // ── 结束 / 重开 / 删除 / 编辑 ──
  const setPollStatus = async (poll: PollItem, next: 'active' | 'ended') => {
    try {
      const { data } = await apiClient.patch(`/api/interaction/polls/${poll.id}/status`, { status: next })
      message.success(data.message)
      await loadPolls()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('updateFailed'))
    }
  }

  const removePoll = async (poll: PollItem) => {
    try {
      await apiClient.delete(`/api/interaction/polls/${poll.id}`)
      message.success(t('deleteSuccess'))
      await loadPolls()
    } catch { message.error(t('deleteFailed')) }
  }

  const openEdit = (poll: PollItem) => {
    editForm.setFieldsValue({
      question: poll.question,
      poll_type: poll.poll_type,
      subject: poll.subject || '',
      options: poll.options.map(o => o.text),
    })
    setEditPoll(poll)
  }

  const submitEdit = async () => {
    if (!editPoll) return
    const v = await editForm.validateFields()
    const options = (v.options || []).map((o: string) => String(o).trim()).filter(Boolean)
    try {
      await apiClient.put(`/api/interaction/polls/${editPoll.id}`, {
        question: v.question,
        options,
        poll_type: v.poll_type || 'single',
        subject: v.subject || '',
      })
      message.success(t('updateSuccess'))
      setEditPoll(null)
      await loadPolls()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('updateFailed'))
    }
  }

  // ── AI 生成 ──
  const generateAi = async () => {
    const v = await aiForm.validateFields()
    setAiLoading(true)
    setAiPreview(null)
    try {
      const { data } = await apiClient.post('/api/interaction/polls/ai-generate', {
        topic: v.topic,
        poll_type: v.poll_type || 'single',
        option_count: v.auto_count ? 0 : Number(v.option_count || 4),
      }, { timeout: 120000 })
      if (data.poll?.options?.length) {
        setAiPreview({
          question: data.poll.question || v.topic,
          options: data.poll.options.map((o: string) => String(o)),
        })
      } else {
        message.warning(data.error || t('aiGenerateFailed'))
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('aiGenerateFailed'))
    } finally {
      setAiLoading(false)
    }
  }

  const applyAi = () => {
    if (!aiPreview) return
    createForm.setFieldsValue({
      question: aiPreview.question,
      options: aiPreview.options,
      poll_type: aiForm.getFieldValue('poll_type') || 'single',
      subject: aiForm.getFieldValue('subject') || subjectOptions[0] || '',
      anonymous: false,
      duration: 0,
      max_choices: 0,
    })
    setAiOpen(false)
    setAiPreview(null)
    setCreateOpen(true)
  }

  // ── 列表过滤（数据一次拉回，切筛选即时生效） ──
  const subjectOptionsInList = useMemo(
    () => Array.from(new Set(polls.map(p => p.subject).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      .map(s => ({ value: s, label: s })),
    [polls],
  )

  const visible = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return polls.filter(p => {
      if (statusFilter === 'active' && p.ended) return false
      if (statusFilter === 'ended' && !p.ended) return false
      if (subjectFilter && p.subject !== subjectFilter) return false
      if (!k) return true
      return `${p.question} ${p.creator_name}`.toLowerCase().includes(k)
    })
  }, [polls, kw, statusFilter, subjectFilter])

  const paged = visible.slice((page - 1) * pageSize, page * pageSize)
  const activeCount = polls.filter(p => !p.ended).length
  const endedCount = polls.filter(p => p.ended).length

  return (
    <div>
      <PageHeader
        icon={<BarChartOutlined />}
        title={t('poll')}
        subtitle={t('pollSubtitle')}
        extra={(
          <>
            <Tooltip title={t('refresh')}>
              <Button icon={<ReloadOutlined />} onClick={() => void loadPolls()} />
            </Tooltip>
            {isTeacherOrAdmin && (
              <>
                <Button icon={<RobotOutlined />} onClick={() => setAiOpen(true)}>{t('aiCreatePoll')}</Button>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  {t('createPoll')}
                </Button>
              </>
            )}
          </>
        )}
      >
        {polls.length > 0 && (
          <ListFilterBar
            keyword={kw}
            onKeyword={(v) => { setKw(v); setPage(1) }}
            searchPlaceholder={t('listSearchPh')}
            status={statusFilter}
            onStatus={(v) => { setStatusFilter(v as 'all' | 'active' | 'ended'); setPage(1) }}
            statusOptions={[
              { value: 'all', label: `${t('all')} (${polls.length})` },
              { value: 'active', label: `${t('pollStatusActive')} (${activeCount})` },
              { value: 'ended', label: `${t('pollStatusEnded')} (${endedCount})` },
            ]}
            subject={subjectFilter}
            onSubject={(v) => { setSubjectFilter(v); setPage(1) }}
            subjectOptions={subjectOptionsInList}
            subjectPlaceholder={t('subject')}
            dirty={!!kw || statusFilter !== 'all' || !!subjectFilter}
            onReset={() => { setKw(''); setStatusFilter('all'); setSubjectFilter(''); setPage(1) }}
            resetLabel={t('clearFilter')}
            style={{ marginBottom: 0 }}
          />
        )}
      </PageHeader>

      <Card style={{ borderRadius: 8 }}>
        <Spin spinning={loading}>
          {polls.length === 0 ? <Empty description={t('noPolls')} /> : (
            <>

            {visible.length === 0 ? <Empty description={t('listNoMatch')} /> : (
              <>
                <RowList
                  items={paged}
                  split={false}
                  renderItem={(poll: PollItem) => {
                    const canVote = isStudent && !poll.ended
                    const canSeeResult = isTeacherOrAdmin || poll.voted || poll.ended
                    return (
                      <Card size="small" style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Space size={6} wrap>
                              <Tag color={poll.ended ? 'default' : 'processing'}>
                                {poll.ended ? t('pollStatusEnded') : t('pollStatusActive')}
                              </Tag>
                              <Text strong><FormulaRenderer content={poll.question} /></Text>
                            </Space>
                            <div style={{ marginTop: 6 }}>
                              <Tag color={poll.poll_type === 'multiple' ? 'purple' : 'blue'}>
                                {poll.poll_type === 'multiple' ? t('multiple') : t('single')}
                              </Tag>
                              <Tag color="blue">{poll.creator_name || poll.creator_username}</Tag>
                              {poll.subject && <Tag color="cyan">{poll.subject}</Tag>}
                              {poll.anonymous && <Tag>{t('pollAnonymous')}</Tag>}
                              {poll.poll_type === 'multiple' && !!poll.max_choices && (
                                <Tag>{t('pollMaxChoices', { count: poll.max_choices })}</Tag>
                              )}
                              {isTeacherOrAdmin && (
                                <ScopeTag scope={poll.target_scope} grade={poll.target_grade}
                                  classes={poll.target_class} users={poll.target_users} />
                              )}
                            </div>
                            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                              {t('pollOptionCount', { count: poll.option_count })}
                              {' · '}
                              {t('pollVotersShort', { count: poll.unique_voters })}
                              {poll.ends_at && (
                                <> {' · '}
                                  {t('pollDeadline')} {poll.ends_at.slice(5, 16)}
                                  {!poll.ended && remaining(poll.ends_at, t)
                                    && `（${t('pollRemaining', { time: remaining(poll.ends_at, t) })}）`}
                                </>
                              )}
                            </div>
                          </div>

                          <Space wrap size={4}>
                            {canVote && (
                              <Button size="small" type={poll.voted ? 'default' : 'primary'}
                                icon={<CheckCircleOutlined />} onClick={() => startVote(poll)}>
                                {poll.voted ? t('pollChangeVote') : t('vote')}
                              </Button>
                            )}
                            {canSeeResult && (
                              <Tooltip title={t('results')}>
                                <Button size="small" icon={<BarChartOutlined />} onClick={() => openResults(poll)} />
                              </Tooltip>
                            )}
                            {isTeacherOrAdmin && (
                              <>
                                <Tooltip title={t('pollBigScreen')}>
                                  <Button size="small" icon={<FullscreenOutlined />} onClick={() => openBigScreen(poll)} />
                                </Tooltip>
                                <Tooltip title={t('export')}>
                                  <Button size="small" icon={<DownloadOutlined />}
                                    onClick={() => window.open(`/api/export/poll/${poll.id}`, '_blank')} />
                                </Tooltip>
                                <Tooltip title={t('edit')}>
                                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => openEdit(poll)} />
                                </Tooltip>
                                <Tooltip title={poll.ended ? t('pollReopen') : t('pollEnd')}>
                                  <Button size="small" type="text"
                                    icon={poll.ended ? <PlayCircleOutlined /> : <StopOutlined />}
                                    onClick={() => {
                                      if (poll.ended) { void setPollStatus(poll, 'active'); return }
                                      modalApi.confirm({
                                        title: t('pollEnd'),
                                        content: t('pollEndConfirm'),
                                        okText: t('confirm'),
                                        cancelText: t('cancel'),
                                        onOk: () => setPollStatus(poll, 'ended'),
                                      })
                                    }} />
                                </Tooltip>
                                <ResetActivityButton activityType="poll" activityId={poll.id}
                                  iconOnly stopPropagation onSuccess={loadPolls} />
                                <DeletePollButton onConfirm={() => removePoll(poll)} />
                              </>
                            )}
                          </Space>
                        </div>
                      </Card>
                    )
                  }}
                />
                <div style={{ marginTop: 12, textAlign: 'center' }}>
                  <Pagination
                    current={page} pageSize={pageSize} total={visible.length}
                    showSizeChanger showTotal={(total) => t('totalPolls', { count: total })}
                    pageSizeOptions={['5', '10', '20', '50']}
                    onChange={(p, ps) => { setPage(p); setPageSize(ps) }} size="small"
                  />
                </div>
              </>
            )}
          </>
        )}
        </Spin>
      </Card>

      {/* ── 投票 / 改投 ── */}
      <Modal
        open={!!votePoll}
        title={votePoll?.question}
        onCancel={() => setVotePoll(null)}
        footer={[
          <Button key="cancel" onClick={() => setVotePoll(null)}>{t('cancel')}</Button>,
          <Button key="ok" type="primary" onClick={submitVote}>
            {votePoll?.voted ? t('pollUpdateVote') : t('vote')}
          </Button>,
        ]}
        width={520}
      >
        {votePoll && (
          <>
            {votePoll.poll_type === 'multiple' && (
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                {votePoll.max_choices
                  ? t('pollMaxChoices', { count: votePoll.max_choices })
                  : t('pollMultiHint')}
              </Text>
            )}
            <Space orientation="vertical" style={{ width: '100%' }} size={8}>
              {votePoll.options.map(opt => {
                const checked = picked.includes(opt.index)
                return (
                  <div
                    key={opt.index}
                    role="button"
                    tabIndex={0}
                    onClick={() => togglePick(opt.index)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') togglePick(opt.index) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                      padding: '10px 12px', borderRadius: 8,
                      border: `1px solid ${checked ? 'var(--primary-color)' : 'var(--border-color)'}`,
                      background: checked ? 'rgba(22,119,255,0.06)' : 'var(--bg-container)',
                    }}
                  >
                    {votePoll.poll_type === 'multiple'
                      ? <Checkbox checked={checked} />
                      : (
                        <span style={{
                          width: 16, height: 16, borderRadius: 8, flex: '0 0 16px',
                          border: `1px solid ${checked ? 'var(--primary-color)' : 'var(--border-color-secondary)'}`,
                          background: checked ? 'var(--primary-color)' : 'transparent',
                        }} />
                      )}
                    <span>{opt.text}</span>
                  </div>
                )
              })}
            </Space>
          </>
        )}
      </Modal>

      {/* ── 结果弹窗（3 秒自动刷新） ── */}
      <Modal
        open={resultPollId != null && !bigScreen}
        title={resultData?.question || t('pollResults')}
        onCancel={() => setResultPollId(null)}
        footer={[
          <Button key="big" icon={<FullscreenOutlined />} onClick={() => setBigScreen(true)}>
            {t('pollBigScreen')}
          </Button>,
          <Button key="close" onClick={() => setResultPollId(null)}>{t('close')}</Button>,
        ]}
        width={560}
      >
        <PollResultsView data={resultData} />
      </Modal>

      {/* ── 投屏大屏 ── */}
      <Modal
        open={bigScreen}
        onCancel={() => setBigScreen(false)}
        footer={null}
        width="92vw"
        style={{ top: 16, maxWidth: 1400 }}
        styles={{ body: { background: '#151922', borderRadius: 12, padding: 32 } }}
      >
        {resultData && (
          <div className="poll-bigscreen">
            <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.6)', marginBottom: 6 }}>
              {t('pollLiveResults')}
            </div>
            <div style={{ fontSize: 30, fontWeight: 500, lineHeight: 1.35, marginBottom: 24 }}>
              {resultData.question}
            </div>
            <PollResultsView data={resultData} big highlightMine={false} />
          </div>
        )}
      </Modal>

      {/* ── 创建投票 ── */}
      <Modal
        open={createOpen}
        title={t('createPoll')}
        onCancel={() => setCreateOpen(false)}
        onOk={submitCreate}
        okText={t('createPoll')}
        cancelText={t('cancel')}
        width={640}
        styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
      >
        <Form form={createForm} layout="vertical" initialValues={{ poll_type: 'single', duration: 0 }}>
          <Form.Item name="question" label={t('pollQuestion')} rules={[{ required: true }]}>
            <Input placeholder={t('pollQuestionPlaceholder')} maxLength={200} />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Form.Item name="poll_type" label={t('pollType')} style={{ flex: '0 0 200px' }}>
              <Segmented block options={[
                { value: 'single', label: t('singleChoice') },
                { value: 'multiple', label: t('multipleChoice') },
              ]} />
            </Form.Item>
            <Form.Item name="subject" label={t('subject')} initialValue={subjectOptions[0] || ''} style={{ flex: '1 1 180px' }}>
              <Select options={subjectOptions.map(s => ({ value: s, label: s }))} />
            </Form.Item>
            <Form.Item name="duration" label={t('pollDuration')} style={{ flex: '0 0 150px' }}>
              <Select options={[
                { value: 0, label: t('pollNoDeadline') },
                { value: 5, label: `5 ${t('minutesShort')}` },
                { value: 10, label: `10 ${t('minutesShort')}` },
                { value: 30, label: `30 ${t('minutesShort')}` },
                { value: 60, label: `1 ${t('hoursShort')}` },
                { value: 120, label: `2 ${t('hoursShort')}` },
              ]} />
            </Form.Item>
          </div>
          <Form.Item
            name="options"
            label={t('pollOptionsLabel')}
            initialValue={['', '']}
            rules={[{
              validator: (_, value: string[]) => {
                const filled = (value || []).map(v => String(v).trim()).filter(Boolean)
                if (filled.length < POLL_OPTION_MIN) return Promise.reject(new Error(t('minOptions')))
                if (filled.length !== new Set(filled).size) {
                  return Promise.reject(new Error(t('pollDuplicateOptions')))
                }
                return Promise.resolve()
              },
            }]}
          >
            <PollOptionsEditor />
          </Form.Item>
          {pollType === 'multiple' && (
            <Form.Item name="max_choices" label={t('pollMaxChoicesLabel')} initialValue={0} style={{ maxWidth: 220 }}>
              <Select options={[
                { value: 0, label: t('pollUnlimited') },
                ...[2, 3, 4, 5, 6].map(n => ({ value: n, label: String(n) })),
              ]} />
            </Form.Item>
          )}
          <Form.Item name="anonymous" label={t('pollAnonymous')} valuePropName="checked" initialValue={false}
            extra={t('pollAnonymousHint')} style={{ marginBottom: 12 }}>
            <Switch />
          </Form.Item>
          <Divider style={{ margin: '4px 0 12px' }} />
          <Form.Item label={t('targetScope')}>
            <ActivityScopeSelector value={pollScope} onChange={setPollScope} />
          </Form.Item>
        </Form>
      </Modal>

      {/* ── 编辑投票 ── */}
      <Modal
        open={!!editPoll}
        title={t('editPoll')}
        onCancel={() => setEditPoll(null)}
        onOk={submitEdit}
        okText={t('save')}
        cancelText={t('cancel')}
        width={600}
        destroyOnHidden
        styles={{ body: { maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' } }}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="question" label={t('question')} rules={[{ required: true }]}>
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="poll_type" label={t('pollType')}>
            <Segmented options={[
              { value: 'single', label: t('singleChoice') },
              { value: 'multiple', label: t('multipleChoice') },
            ]} />
          </Form.Item>
          <Form.Item name="subject" label={t('subject')}>
            <Select allowClear options={subjectOptions.map(s => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="options" label={t('pollOptionsLabel')} rules={[{ required: true }]}>
            <PollOptionsEditor />
          </Form.Item>
          <Text type="secondary" style={{ fontSize: 12 }}>{t('pollEditLockHint')}</Text>
        </Form>
      </Modal>

      {/* ── AI 生成投票 ── */}
      <Modal
        open={aiOpen}
        title={<Space><RobotOutlined />{t('aiGeneratePoll')}</Space>}
        onCancel={() => { setAiOpen(false); setAiPreview(null) }}
        footer={aiPreview ? [
          <Button key="again" icon={<ReloadOutlined />} onClick={generateAi} loading={aiLoading}>
            {t('pollRegenerate')}
          </Button>,
          <Button key="ok" type="primary" onClick={applyAi}>{t('fillForm')}</Button>,
        ] : [
          <Button key="cancel" onClick={() => setAiOpen(false)}>{t('cancel')}</Button>,
          <Button key="gen" type="primary" icon={<RobotOutlined />} loading={aiLoading} onClick={generateAi}>
            {t('aiGenerate')}
          </Button>,
        ]}
        width={600}
        styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto' } }}
      >
        <Form form={aiForm} layout="vertical" initialValues={{ poll_type: 'single', option_count: 4, auto_count: false }}>
          <Form.Item name="topic" label={t('pollTopic')} rules={[{ required: true }]}>
            <Input placeholder={t('pollTopicPlaceholder')} />
          </Form.Item>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Form.Item name="poll_type" label={t('pollType')} style={{ flex: '0 0 220px' }}>
              <Segmented block options={[
                { value: 'single', label: t('singleChoice') },
                { value: 'multiple', label: t('multipleChoice') },
              ]} />
            </Form.Item>
            <Form.Item name="subject" label={t('subject')} initialValue={subjectOptions[0] || ''} style={{ flex: '1 1 180px' }}>
              <Select options={subjectOptions.map(s => ({ value: s, label: s }))} />
            </Form.Item>
          </div>

          <Form.Item label={t('optionCount')} style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Form.Item name="auto_count" noStyle valuePropName="checked">
                <Switch size="small" />
              </Form.Item>
              <Text style={{ fontSize: 12 }}>{t('pollAutoCount')}</Text>
              {!aiAuto && (
                <Space size={4} style={{ marginLeft: 'auto' }}>
                  <Text style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t('optionsCountValue', { n: aiCount })}
                  </Text>
                  {[3, 4, 5].map(n => (
                    <Button key={n} size="small" onClick={() => aiForm.setFieldValue('option_count', n)}>
                      {n}
                    </Button>
                  ))}
                </Space>
              )}
            </div>
          </Form.Item>
          {!aiAuto && (
            <Form.Item name="option_count" style={{ marginBottom: 8 }}>
              <Slider min={POLL_OPTION_MIN} max={POLL_OPTION_MAX}
                style={{ marginRight: 10 }}
                tooltip={{ formatter: (v) => t('optionsCountValue', { n: v }) }}
                marks={{ 2: '2', 4: '4', 6: '6', 10: '10' }} />
            </Form.Item>
          )}
        </Form>

        {aiPreview && (
          <>
            <Divider style={{ margin: '4px 0 12px' }} />
            <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('previewLabel')}</Text>
            <Input
              value={aiPreview.question}
              onChange={e => setAiPreview({ ...aiPreview, question: e.target.value })}
              style={{ marginBottom: 10 }}
            />
            <PollOptionsEditor
              value={aiPreview.options}
              onChange={opts => setAiPreview({ ...aiPreview, options: opts })}
            />
          </>
        )}
      </Modal>
    </div>
  )
}

export default QuickPollPage
