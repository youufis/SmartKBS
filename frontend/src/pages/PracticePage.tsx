import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Button, Input, InputNumber, Select, Tag, message, Spin,
  Radio, Space, Typography, Divider, Progress, Table, Modal, Result, Popconfirm, Pagination, Checkbox,
} from 'antd'
import {
  RobotOutlined, ReloadOutlined, CheckCircleOutlined,
  FormOutlined, FileTextOutlined, StopOutlined, DeleteOutlined,
} from '@ant-design/icons'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'
import { TYPE_LABELS as typeLabel, TYPE_OPTIONS } from '../constants/questionTypes'

const { Title, Text } = Typography
const { TextArea } = Input

// ════════════════════════════════════════
// 练习提交名册 — 已交/未交 + 班级 + 按学生查询
// ════════════════════════════════════════
const SessionRoster: React.FC<{ attempts: any[]; students: any[] }> = ({ attempts, students }) => {
  const { t } = useTranslation('practice')
  const [kw, setKw] = useState('')
  const [filter, setFilter] = useState<'all' | 'done' | 'undone'>('all')

  const rows = useMemo(() => {
    const map = new Map<string, any>()
    ;(students || []).forEach((x: any) => map.set(x.username, { ...x }))
    ;(attempts || []).forEach((a: any) => {
      if (!map.has(a.student_username)) {
        map.set(a.student_username, {
          username: a.student_username,
          name: a.student_name || a.student_username,
          class: a.student_class || '',
          submitted: true, score: a.score, total_score: a.total_score, submitted_at: a.submitted_at,
        })
      }
    })
    const k = kw.trim().toLowerCase()
    return Array.from(map.values()).filter((r: any) => {
      if (filter === 'done' && !r.submitted) return false
      if (filter === 'undone' && r.submitted) return false
      if (!k) return true
      return [r.name, r.username, String(r.class || '')].some(v => String(v).toLowerCase().includes(k))
    })
  }, [students, attempts, kw, filter])

  return (
    <div>
      <Space style={{ marginBottom: 8 }} wrap>
        <Input allowClear style={{ width: 200 }} value={kw} onChange={e => setKw(e.target.value)}
          placeholder={`${t('studentName')} / ${t('student')}`} />
        <Radio.Group value={filter} onChange={e => setFilter(e.target.value)}>
          <Radio.Button value="all">{t('all')}</Radio.Button>
          <Radio.Button value="done">{t('submitted')}</Radio.Button>
          <Radio.Button value="undone">{t('notStarted')}</Radio.Button>
        </Radio.Group>
        <Text type="secondary">{t('totalItems', { count: rows.length })}</Text>
      </Space>
      <Table size="small" rowKey="username" dataSource={rows}
        locale={{ emptyText: t('noStudentSubmissions') }}
        pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total: number) => t('totalItems', { count: total }) }}
        columns={[
          { title: t('studentName'), dataIndex: 'name', width: 120, ellipsis: true },
          {
            title: t('studentClass'), dataIndex: 'class', width: 70,
            render: (v: string) => (v ? `${v}${t('classUnit')}` : '-'),
          },
          {
            title: t('status'), dataIndex: 'submitted', width: 90,
            render: (v: boolean) => (v ? <Tag color="success">{t('submitted')}</Tag> : <Tag>{t('notStarted')}</Tag>),
          },
          {
            title: t('score'), key: 'score', width: 100,
            render: (_: any, r: any) => (r.submitted ? `${r.score ?? 0}/${r.total_score ?? 0}` : '-'),
          },
          { title: t('submitTime'), dataIndex: 'submitted_at', ellipsis: true, render: (v: string) => v || '-' },
          { title: t('actions'), key: 'user', width: 110, ellipsis: true, render: (_: any, r: any) => r.username },
        ] as any}
      />
    </div>
  )
}

// ════════════════════════════════════════
// 学生端
// ════════════════════════════════════════
const StudentView: React.FC = () => {
  const { t } = useTranslation('practice')
  const [loading, setLoading] = useState(true)
  const [sessions, setSessions] = useState<any[]>([])
  const [activeSession, setActiveSession] = useState<any>(null)
  const [questions, setQuestions] = useState<any[]>([])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [submittedView, setSubmittedView] = useState<any>(null)
  const [stuPage, setStuPage] = useState(1)
  const [stuPageSize, setStuPageSize] = useState(10)

  const loadSessions = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/practice/my-sessions')
      setSessions(data.sessions || [])
    } catch { message.error(t('loadFailed')) }
    finally { setLoading(false) }
  }, [])

  // 初始加载：不在 effect 中同步调用 setLoading，直接从 true→false
  useEffect(() => {
    apiClient.get('/api/practice/my-sessions')
      .then(({ data }) => setSessions(data.sessions || []))
      .catch(() => message.error(t('loadFailed')))
      .finally(() => setLoading(false))
  }, [])

  const startPractice = async (sid: number) => {
    try {
      const { data } = await apiClient.get(`/api/practice/my-sessions/${sid}`)
      if (data.attempt) {
        setSubmittedView(data)
      } else {
        setActiveSession(data.session)
        setQuestions(data.questions || [])
        setAnswers({})
        setResult(null)
      }
    } catch { message.error(t('loadPracticeFailed')) }
  }

  const submitAnswers = async () => {
    setSubmitting(true)
    try {
      const { data } = await apiClient.post(
        `/api/practice/my-sessions/${activeSession.id}/submit`,
        { answers },
      )
      setResult(data)
    } catch (e: any) {
      message.error(e.response?.data?.detail || t('submitFailed'))
    } finally { setSubmitting(false) }
  }

  const allAnswered = questions.length > 0 && questions.every(q => answers[String(q.id)]?.trim())

  if (submittedView) {
    return (
      <div>
        <Title level={4}><CheckCircleOutlined /> {submittedView.session?.title} — {t('practiceComplete')}</Title>
        <Card style={{ textAlign: 'center', marginBottom: 16 }}>
          <Progress type="circle" percent={submittedView.attempt?.accuracy || 0}
            format={p => `${p}%`}
            strokeColor={submittedView.attempt?.accuracy >= 80 ? '#52c41a' : submittedView.attempt?.accuracy >= 60 ? '#faad14' : '#ff4d4f'}
          />
          <div style={{ marginTop: 8 }}>
            <Text>{t('scoreLabel', { score: submittedView.attempt?.score, total: submittedView.attempt?.total_score })}</Text>
          </div>
        </Card>
        {submittedView.results?.map((r: any, i: number) => (
          <Card key={i} size="small" style={{ marginBottom: 8 }}
            title={t('questionN', { n: i+1 })}
            extra={r.is_correct ? <Tag color="success">{t('correct')}</Tag> : <Tag color="error">{t('incorrect')}</Tag>}
          >
            <FormulaRenderer content={r.question_text} />
            <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={(r as any).media_files} />
            <div style={{ marginTop: 8 }}>
              <Text>{t('yourAnswer')}：<Text type={r.is_correct ? 'success' : 'danger'}>{r.student_answer || t('noHistory')}</Text></Text>
              {!r.is_correct && <div><Text type="secondary">{t('correctAnswer')}：{r.correct_answer}</Text></div>}
              {!!r.feedback && <div style={{ marginTop: 4 }}><Text type="secondary">{r.feedback}</Text></div>}
            </div>
            {r.explanation && (
              <div style={{ marginTop: 8, padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
                <Text type="secondary"><FormulaRenderer content={r.explanation} /></Text>
              </div>
            )}
          </Card>
        ))}
        <Button icon={<FormOutlined />} onClick={() => { setSubmittedView(null); loadSessions() }}
          style={{ marginTop: 16 }}>{t('practiceHistory')}</Button>
      </div>
    )
  }

  if (activeSession) {
    return (
      <div>
        <Title level={4}><FormOutlined /> {activeSession.title}</Title>
        <Text type="secondary">{t('knowledgePoints')}：{activeSession.knowledge_points}</Text>
        <Divider />
        {questions.map((q, i) => (
          <Card key={q.id} size="small" title={t('questionNWithType', { n: i+1, type: typeLabel[q.type] || q.type })}
            style={{ marginBottom: 12 }}>
            <FormulaRenderer content={q.question_text} />
            <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} />
            {q.type === 'single' && q.options && (
              <Radio.Group value={answers[String(q.id)]} onChange={e => setAnswers(p => ({...p, [String(q.id)]: e.target.value}))}>
                <Space orientation="vertical">
                  {Object.entries(q.options).map(([k, v]) => (
                    <Radio key={k} value={k} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{k}. <FormulaRenderer content={v as string} inline /></Radio>
                  ))}
                </Space>
              </Radio.Group>
            )}
            {q.type === 'true_false' && (
              <Radio.Group value={answers[String(q.id)]} onChange={e => setAnswers(p => ({...p, [String(q.id)]: e.target.value}))}>
                <Radio value="对">{t('true')}</Radio>
                <Radio value="错" style={{ marginLeft: 24 }}>{t('false')}</Radio>
              </Radio.Group>
            )}
            {q.type === 'multiple' && q.options && (
              <Checkbox.Group
                value={answers[String(q.id)] ? String(answers[String(q.id)]).split('') : []}
                onChange={(v: any) => setAnswers(p => ({ ...p, [String(q.id)]: [...(v as string[])].sort().join('') }))}>
                <Space orientation="vertical">
                  {Object.entries(q.options).map(([k, v]) => (
                    <Checkbox key={k} value={k} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{k}. <FormulaRenderer content={v as string} inline /></Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            )}
            {!['single', 'multiple', 'true_false'].includes(q.type) && (
              <TextArea rows={q.type === 'short' || q.type === 'fill' ? 3 : 5} placeholder={t('inputAnswer')}
                value={answers[String(q.id)] || ''}
                onChange={e => setAnswers(p => ({...p, [String(q.id)]: e.target.value}))} />
            )}
          </Card>
        ))}
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Button type="primary" size="large" loading={submitting} disabled={!allAnswered}
            onClick={submitAnswers}>
            {allAnswered ? `${t('submit')} (${Object.keys(answers).length}/${questions.length})` : t('answerAll')}
          </Button>
          <Button style={{ marginLeft: 12 }} onClick={() => { setActiveSession(null); loadSessions() }}>{t('practiceHistory')}</Button>
        </div>
        {result && (
          <Card style={{ marginTop: 16, textAlign: 'center' }}>
            <Title level={4}>{t('submit')}</Title>
            <Progress type="circle" percent={result.accuracy}
              format={p => `${p}%`}
              strokeColor={result.accuracy >= 80 ? '#52c41a' : result.accuracy >= 60 ? '#faad14' : '#ff4d4f'} />
            <div style={{ marginTop: 8 }}><Text>{t('score')}：{result.score}/{result.total_score}</Text></div>
            <Space style={{ marginTop: 12 }}>
              <Button type="primary" icon={<CheckCircleOutlined />}
                onClick={() => startPractice(activeSession.id)}>{t('detail')}</Button>
              <Button icon={<ReloadOutlined />}
                onClick={() => { setActiveSession(null); setResult(null); loadSessions() }}>{t('practiceHistory')}</Button>
            </Space>
          </Card>
        )}
      </div>
    )
  }

  return (
    <div>
      <Title level={4}><FormOutlined /> {t('practiceHistory')}</Title>
      <Text type="secondary">{t('practiceComplete')}</Text>
      <Divider />
      {loading ? <Spin style={{ display: 'block', margin: '40px auto' }} />
        : sessions.length === 0
        ? <Result icon={<FileTextOutlined />} title={t('noProblems')} subTitle={t('noHistory')} />
        : <>
            {sessions.slice((stuPage - 1) * stuPageSize, stuPage * stuPageSize).map(s => (
              <Card key={s.id} size="small" style={{ marginBottom: 8 }}
                hoverable onClick={() => startPractice(s.id)}
                extra={s.attempted ? <Tag color="processing">{t('submitted')}</Tag> : <Tag color="default">{t('notStarted')}</Tag>}>
                <Text strong>{s.title}</Text>
                <div><Text type="secondary">{s.knowledge_points}</Text></div>
                <div><Text type="secondary">{t('publisher')}：{s.creator_name} · {s.question_count} {t('questionCount')}
                  {s.source === 'wrong_book' && <Tag color="purple" style={{ marginLeft: 6 }}>{t('sourceWrongBook')}</Tag>}
                </Text></div>
              </Card>
            ))}
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Pagination
                current={stuPage} pageSize={stuPageSize} total={sessions.length}
                showSizeChanger showTotal={(total) => t('totalItems', { count: total })}
                pageSizeOptions={['5', '10', '20', '50']}
                onChange={(p, ps) => { setStuPage(p); setStuPageSize(ps) }}
                size="small"
              />
            </div>
          </>
      }
    </div>
  )
}

// ════════════════════════════════════════
// 教师端
// ════════════════════════════════════════
const TeacherView: React.FC = () => {
  const { t } = useTranslation('practice')
  const [tab, setTab] = useState<'generate' | 'sessions'>('generate')
  const [kpInput, setKpInput] = useState('')
  const [subject, setSubject] = useState('')
  const [subjectOptions, setSubjectOptions] = useState<string[]>([])
  const [difficulty, setDifficulty] = useState('medium')
  const [qType, setQType] = useState('mixed')
  const [count, setCount] = useState(5)
  const [generating, setGenerating] = useState(false)
  const [questions, setQuestions] = useState<any[]>([])
  const [title, setTitle] = useState('')
  const [targetGrade, setTargetGrade] = useState('')
  const [targetClass, setTargetClass] = useState('')
  const [gradeOptions, setGradeOptions] = useState<string[]>([])
  const [classOptions, setClassOptions] = useState<string[]>([])
  const [publishing, setPublishing] = useState(false)
  const [sessions, setSessions] = useState<any[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const user = useAuthStore(s => s.user)
  const isAdmin = user?.role === 'admin'

  // 加载教师的年级列表
  useEffect(() => {
    apiClient.get('/api/scores/my-grades').then(({ data }) => {
      const grades = Array.isArray(data) ? data : []
      setGradeOptions(grades)
      if (grades.length > 0) setTargetGrade(grades[0])
    }).catch(() => {})
    // 加载学科列表
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) {
        setSubjectOptions(data.subjects)
        setSubject(data.subjects[0])
      }
    }).catch(() => {})
  }, [])

  // 选择年级时加载对应班级
  useEffect(() => {
    if (targetGrade) {
      apiClient.get('/api/scores/classes', { params: { grade: targetGrade } })
        .then(({ data }) => {
          const classes = Array.isArray(data) ? data : []
          // 从班级名提取数字，如 "高一1班" → "1"
          const nums = classes.map((c: string) => c.replace(/^.*?(\d+).*$/, '$1')).filter((n: string) => n)
          setClassOptions(nums)
        }).catch(() => {})
    }
  }, [targetGrade])

  const generateQuestions = async () => {
    if (!kpInput.trim()) { message.warning(t('inputKp')); return }
    setGenerating(true)
    setQuestions([])
    try {
      const { data } = await apiClient.post('/api/practice/generate-async', {
        knowledge_points: kpInput.trim(), subject, question_type: qType, count, difficulty,
      })
      message.info(t('aiGeneratingWait'))
      const result = await pollAiTask(data.task_id, 120000)
      if (result?.error) {
        message.error(result.error)
      } else if (result) {
        setQuestions(result.questions || [])
        setTitle(`${kpInput.trim()}${t('practiceSuffix')}`)
        message.success(t('generatedCount', { count: result.total || result.questions?.length || 0 }))
      } else {
        message.error(t('aiTimeout'))
      }
    } catch (e: any) { message.error(e.response?.data?.detail || t('generateFailed')) }
    finally { setGenerating(false) }
  }

  const publishSession = async () => {
    if (!title.trim()) { message.warning(t('inputTitle')); return }
    setPublishing(true)
    try {
      const { data } = await apiClient.post('/api/practice/sessions', {
        title: title.trim(),
        knowledge_points: kpInput.trim(),
        question_ids: questions.map((q: any) => q.id),
        target_grade: targetGrade,
        target_class: targetClass,
        subject,
      })
      message.success(data.message)
      setQuestions([])
      setTab('sessions')
      loadSessions()
    } catch (e: any) { message.error(e.response?.data?.detail || t('publishFailed')) }
    finally { setPublishing(false) }
  }

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const { data } = await apiClient.get('/api/practice/sessions')
      setSessions(data.sessions || [])
    } catch { /* ignore */ }
    finally { setLoadingSessions(false) }
  }, [])

  useEffect(() => { if (tab === 'sessions') loadSessions() }, [tab, loadSessions])

  const viewSessionDetail = async (sid: number) => {
    try {
      const { data } = await apiClient.get(`/api/practice/sessions/${sid}`)
      Modal.info({
        title: data.session?.title,
        width: 800,
        content: (
          <div style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <p>{t('knowledgePoints')}：{data.session?.knowledge_points}</p>
            <p>{t('questionCountTitle')}：{data.session?.question_count} · {t('totalScoreTitle')}：{data.session?.total_score}</p>
            <Divider />
            <Text strong>{t('questionListTitle')}</Text>
            {data.questions?.map((q: any, i: number) => (
              <Card key={q.id || i} size="small" style={{ marginBottom: 8, marginTop: 8 }}
                title={t('questionN', { n: i + 1 })}>
                <FormulaRenderer content={q.question_text} />
                <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={q.media_files} size="normal" />
                {q.options && Object.entries(q.options).map(([k, v]: [string, any]) => (
                  <div key={k} style={{ margin: '2px 0' }}>
                    <Text>{k}. <FormulaRenderer content={v as string} inline /></Text>
                  </div>
                ))}
                <div style={{ marginTop: 4 }}>
                  <Tag color="blue">{t('answerColon')}{q.correct_answer}</Tag>
                </div>
              </Card>
            ))}
            <Divider />
            <Text strong>{t('submissionStatus', { count: data.attempts?.length || 0 })}</Text>
            <SessionRoster attempts={data.attempts || []} students={data.students || []} />
          </div>
        ),
      })
    } catch { message.error(t('loadDetailFailed')) }
  }

  const endSession = async (sid: number) => {
    try {
      await apiClient.put(`/api/practice/sessions/${sid}/end`)
      message.success(t('endedSuccess'))
      loadSessions()
    } catch (e: any) { message.error(e.response?.data?.detail || t('operationFailed')) }
  }

  const deleteSession = async (sid: number) => {
    try {
      await apiClient.delete(`/api/practice/sessions/${sid}`)
      message.success(t('deletedSuccess'))
      loadSessions()
    } catch (e: any) { message.error(e.response?.data?.detail || t('deleteFailed')) }
  }

  return (
    <div>
      <Title level={4}>{t('syncPractice')}</Title>
      <Space style={{ marginBottom: 16 }}>
        <Button type={tab === 'generate' ? 'primary' : 'default'} onClick={() => setTab('generate')}>{t('aiGenerate')}</Button>
        <Button type={tab === 'sessions' ? 'primary' : 'default'} onClick={() => setTab('sessions')}>{t('publishedPractices')}</Button>
      </Space>

      {tab === 'generate' && (
        <>
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space orientation="vertical" style={{ width: '100%' }}>
              <TextArea rows={2} placeholder={t('kpPlaceholder')}
                value={kpInput} onChange={e => setKpInput(e.target.value)} />
              <Space wrap>
                <Select value={subject} onChange={setSubject} style={{ width: 130 }}>
                  {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
                </Select>
                <Select value={qType} onChange={setQType} style={{ width: 130 }}>
                  <Select.Option value="mixed">{t('mixedQuestions')}</Select.Option>
                  {TYPE_OPTIONS.map(opt => (
                    <Select.Option key={opt.value} value={opt.value}>{opt.label}</Select.Option>
                  ))}
                </Select>
                <Select value={difficulty} onChange={setDifficulty} style={{ width: 100 }}>
                  <Select.Option value="easy">{t('easy')}</Select.Option>
                  <Select.Option value="medium">{t('medium')}</Select.Option>
                  <Select.Option value="hard">{t('hard')}</Select.Option>
                </Select>
                <InputNumber min={1} max={20} value={count} onChange={v => setCount(v || 5)}
                  style={{ width: 80 }} /> {t('questionCount')}
                <Button type="primary" icon={<RobotOutlined />} loading={generating} onClick={generateQuestions}>
                  {t('aiGenerate')}
                </Button>
              </Space>
            </Space>
          </Card>

          {generating && <Spin description={t('aiGeneratingWait')} style={{ display: 'block', margin: '40px auto' }} />}

          {questions.map((q, i) => (
            <Card key={q.id} size="small" title={t('questionNWithType', { n: i+1, type: typeLabel[q.type] || q.type })}
              extra={<Tag>{q.difficulty === 'easy' ? t('easy') : q.difficulty === 'hard' ? t('hard') : t('medium')}</Tag>}
              style={{ marginBottom: 8, overflowX: 'auto' }}>
              <div style={{ overflowX: 'auto' }}>
                <FormulaRenderer content={q.question} />
              </div>
              <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} />
              {q.options && Object.entries(q.options).map(([k, v]) => (
                <div key={k} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><Text type="secondary">{k}. <FormulaRenderer content={v as string} inline /></Text></div>
              ))}
              <div style={{ marginTop: 8 }}><Tag color="blue">{t('correctAnswer')}：{q.answer}</Tag></div>
            </Card>
          ))}

          {questions.length > 0 && (
            <Card size="small" style={{ marginTop: 16 }}>
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Input placeholder={t('title')} value={title} onChange={e => setTitle(e.target.value)} />
                <Space>
                  <Select value={targetGrade} onChange={setTargetGrade} placeholder={t('targetGrade')} style={{ width: 150 }}>
                    {gradeOptions.map(g => (
                      <Select.Option key={g} value={g}>{g}</Select.Option>
                    ))}
                    {isAdmin && <Select.Option value="">{t('allGrades')}</Select.Option>}
                  </Select>
                  <Select value={targetClass} onChange={setTargetClass} placeholder={t('targetClass')} style={{ width: 150 }} allowClear>
                    {classOptions.map(n => (
                      <Select.Option key={n} value={n}>{n}{t('classUnit')}</Select.Option>
                    ))}
                    <Select.Option value="">{t('allClasses')}</Select.Option>
                  </Select>
                  <Button type="primary" loading={publishing} onClick={publishSession}>
                    {t('publishPractice')}
                  </Button>
                </Space>
              </Space>
            </Card>
          )}
        </>
      )}

      {tab === 'sessions' && (
        loadingSessions ? <Spin style={{ display: 'block', margin: '40px auto' }} />
        : sessions.length === 0 ? <Result icon={<FileTextOutlined />} title={t('publishedRecords')} />
        : <Table dataSource={sessions} rowKey="id"
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (total: number) => t('totalItems', { count: total }), pageSizeOptions: ['5', '10', '20', '50'] }}
            columns={[
              { title: t('title_'), dataIndex: 'title', ellipsis: true },
              { title: t('publisher'), dataIndex: 'creator_name', width: 100 },
              { title: t('gradeClass'), render: (_, r) => 
                r.target_students?.length > 0 
                  ? <Tag color="green">{t('targeted')} {r.target_students.length} {t('people')}</Tag>
                  : <>{`${r.target_grade || t('all')} ${r.target_class ? r.target_class+t('classUnit') : t('all')}`}
                    {r.source === 'wrong_book' && <Tag color="purple" style={{ marginLeft: 6 }}>{t('sourceWrongBook')}</Tag>}</>
              },
              { title: t('questionCount'), dataIndex: 'question_count', width: 60 },
              { title: t('status'), render: (_, r) => r.status === 'active' ? <Tag color="processing">{t('inProgress')}</Tag> : <Tag>{t('endedSuccess')}</Tag>, width: 80 },
              { title: t('submitted'), render: (_, r) => `${r.submitted_count}/${r.student_count}`, width: 80 },
              { title: t('actions'), render: (_, r) => <Space wrap>
                <Button size="small" onClick={() => viewSessionDetail(r.id)}>{t('detail')}</Button>
                {r.status === 'active' && (
                  <Popconfirm title={t('endConfirm')} onConfirm={() => endSession(r.id)}>
                    <Button size="small" icon={<StopOutlined />}>{t('endedSuccess')}</Button>
                  </Popconfirm>
                )}
                <Popconfirm title={t('deleteConfirm')} onConfirm={() => deleteSession(r.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />}>{t('delete')}</Button>
                </Popconfirm>
              </Space> },
            ]}
          />
      )}
    </div>
  )
}

// ════════════════════════════════════════
// 主入口 — 同时导出供其他组件使用
// ════════════════════════════════════════
const PracticePage: React.FC = () => {
  const user = useAuthStore(s => s.user)
  const isTeacher = user?.role === 'admin' || user?.role === 'teacher'
  return (
    <Card style={{ borderRadius: 8 }}>
      {isTeacher ? <TeacherView /> : <StudentView />}
    </Card>
  )
}

export default PracticePage
export { StudentView, TeacherView }
