import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Button, Input, InputNumber, Select, Tag, message, Spin,
  Radio, Space, Typography, Divider, Progress, Table, Modal, Result, Popconfirm, Pagination,
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
// 学生端
// ════════════════════════════════════════
const StudentView: React.FC = () => {
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
    } catch { message.error('加载练习列表失败') }
    finally { setLoading(false) }
  }, [])

  // 初始加载：不在 effect 中同步调用 setLoading，直接从 true→false
  useEffect(() => {
    apiClient.get('/api/practice/my-sessions')
      .then(({ data }) => setSessions(data.sessions || []))
      .catch(() => message.error('加载练习列表失败'))
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
    } catch { message.error('获取练习失败') }
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
      message.error(e.response?.data?.detail || '提交失败')
    } finally { setSubmitting(false) }
  }

  const allAnswered = questions.length > 0 && questions.every(q => answers[String(q.id)]?.trim())

  if (submittedView) {
    return (
      <div>
        <Title level={4}><CheckCircleOutlined /> {submittedView.session?.title} — 答题结果</Title>
        <Card style={{ textAlign: 'center', marginBottom: 16 }}>
          <Progress type="circle" percent={submittedView.attempt?.accuracy || 0}
            format={p => `${p}%`}
            strokeColor={submittedView.attempt?.accuracy >= 80 ? '#52c41a' : submittedView.attempt?.accuracy >= 60 ? '#faad14' : '#ff4d4f'}
          />
          <div style={{ marginTop: 8 }}>
            <Text>得分：{submittedView.attempt?.score}/{submittedView.attempt?.total_score}</Text>
          </div>
        </Card>
        {submittedView.results?.map((r: any, i: number) => (
          <Card key={i} size="small" style={{ marginBottom: 8 }}
            title={`第 ${i+1} 题`}
            extra={r.is_correct ? <Tag color="success">正确</Tag> : <Tag color="error">错误</Tag>}
          >
            <FormulaRenderer content={r.question_text} />
            <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={(r as any).media_files} />
            <div style={{ marginTop: 8 }}>
              <Text>你的答案：<Text type={r.is_correct ? 'success' : 'danger'}>{r.student_answer || '（未作答）'}</Text></Text>
              {!r.is_correct && <div><Text type="secondary">正确答案：{r.correct_answer}</Text></div>}
            </div>
            {r.explanation && (
              <div style={{ marginTop: 8, padding: 8, background: '#f5f5f5', borderRadius: 4 }}>
                <Text type="secondary"><FormulaRenderer content={r.explanation} /></Text>
              </div>
            )}
          </Card>
        ))}
        <Button icon={<FormOutlined />} onClick={() => { setSubmittedView(null); loadSessions() }}
          style={{ marginTop: 16 }}>返回列表</Button>
      </div>
    )
  }

  if (activeSession) {
    return (
      <div>
        <Title level={4}><FormOutlined /> {activeSession.title}</Title>
        <Text type="secondary">知识点：{activeSession.knowledge_points}</Text>
        <Divider />
        {questions.map((q, i) => (
          <Card key={q.id} size="small" title={`第 ${i+1} 题 [${typeLabel[q.type] || q.type}]`}
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
                <Radio value="对">对</Radio>
                <Radio value="错" style={{ marginLeft: 24 }}>错</Radio>
              </Radio.Group>
            )}
            {q.type === 'short' && (
              <TextArea rows={3} placeholder="请输入答案..."
                value={answers[String(q.id)] || ''}
                onChange={e => setAnswers(p => ({...p, [String(q.id)]: e.target.value}))} />
            )}
          </Card>
        ))}
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <Button type="primary" size="large" loading={submitting} disabled={!allAnswered}
            onClick={submitAnswers}>
            {allAnswered ? `提交答案 (${Object.keys(answers).length}/${questions.length})` : '请完成所有题目'}
          </Button>
          <Button style={{ marginLeft: 12 }} onClick={() => setActiveSession(null)}>返回</Button>
        </div>
        {result && (
          <Card style={{ marginTop: 16, textAlign: 'center' }}>
            <Title level={4}>提交成功</Title>
            <Progress type="circle" percent={result.accuracy}
              format={p => `${p}%`}
              strokeColor={result.accuracy >= 80 ? '#52c41a' : result.accuracy >= 60 ? '#faad14' : '#ff4d4f'} />
            <div style={{ marginTop: 8 }}><Text>得分：{result.score}/{result.total_score}</Text></div>
            <Button icon={<ReloadOutlined />} style={{ marginTop: 12 }}
              onClick={() => { setActiveSession(null); setResult(null); loadSessions() }}>返回列表</Button>
          </Card>
        )}
      </div>
    )
  }

  return (
    <div>
      <Title level={4}><FormOutlined /> 我的练习</Title>
      <Text type="secondary">查看并完成教师布置的练习任务</Text>
      <Divider />
      {loading ? <Spin style={{ display: 'block', margin: '40px auto' }} />
        : sessions.length === 0
        ? <Result icon={<FileTextOutlined />} title="暂无练习" subTitle="教师还未给你布置练习任务" />
        : <>
            {sessions.slice((stuPage - 1) * stuPageSize, stuPage * stuPageSize).map(s => (
              <Card key={s.id} size="small" style={{ marginBottom: 8 }}
                hoverable onClick={() => startPractice(s.id)}
                extra={s.attempted ? <Tag color="success">已完成</Tag> : <Tag color="processing">待完成</Tag>}>
                <Text strong>{s.title}</Text>
                <div><Text type="secondary">{s.knowledge_points}</Text></div>
                <div><Text type="secondary">发布者：{s.creator_name} · {s.question_count} 题</Text></div>
              </Card>
            ))}
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Pagination
                current={stuPage} pageSize={stuPageSize} total={sessions.length}
                showSizeChanger showTotal={(t) => `共 ${t} 个练习`}
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
    if (!kpInput.trim()) { message.warning('请输入知识点'); return }
    setGenerating(true)
    setQuestions([])
    try {
      const { data } = await apiClient.post('/api/practice/generate-async', {
        knowledge_points: kpInput.trim(), subject, question_type: qType, count, difficulty,
      })
      message.info('AI 正在出题，请稍候...')
      const result = await pollAiTask(data.task_id, 120000)
      if (result) {
        setQuestions(result.questions || [])
        setTitle(`${kpInput.trim()} 练习`)
        message.success(`已生成 ${result.total || result.questions?.length || 0} 道题`)
      } else {
        message.error('AI 出题超时或失败，请重试')
      }
    } catch (e: any) { message.error(e.response?.data?.detail || '生成失败') }
    finally { setGenerating(false) }
  }

  const publishSession = async () => {
    if (!title.trim()) { message.warning('请输入练习标题'); return }
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
    } catch (e: any) { message.error(e.response?.data?.detail || '发布失败') }
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
            <p>知识点：{data.session?.knowledge_points}</p>
            <p>题目数：{data.session?.question_count} · 总分：{data.session?.total_score}</p>
            <Divider />
            <Text strong>题目列表：</Text>
            {data.questions?.map((q: any, i: number) => (
              <Card key={q.id || i} size="small" style={{ marginBottom: 8, marginTop: 8 }}
                title={`第 ${i + 1} 题`}>
                <FormulaRenderer content={q.question_text} />
                <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={q.media_files} size="normal" />
                {q.options && Object.entries(q.options).map(([k, v]: [string, any]) => (
                  <div key={k} style={{ margin: '2px 0' }}>
                    <Text>{k}. <FormulaRenderer content={v as string} inline /></Text>
                  </div>
                ))}
                <div style={{ marginTop: 4 }}>
                  <Tag color="blue">答案：{q.correct_answer}</Tag>
                </div>
              </Card>
            ))}
            <Divider />
            <Text strong>提交情况 ({data.attempts?.length || 0} 人)</Text>
            {data.attempts?.map((a: any, i: number) => (
              <div key={i} style={{ margin: '4px 0' }}>
                {a.student_name}：{a.score}/{a.total_score} ({Math.round(a.score/a.total_score*100)}%)
              </div>
            ))}
          </div>
        ),
      })
    } catch { message.error('加载详情失败') }
  }

  const endSession = async (sid: number) => {
    try {
      await apiClient.put(`/api/practice/sessions/${sid}/end`)
      message.success('已结束')
      loadSessions()
    } catch (e: any) { message.error(e.response?.data?.detail || '操作失败') }
  }

  const deleteSession = async (sid: number) => {
    try {
      await apiClient.delete(`/api/practice/sessions/${sid}`)
      message.success('已删除')
      loadSessions()
    } catch (e: any) { message.error(e.response?.data?.detail || '删除失败') }
  }

  return (
    <div>
      <Title level={4}><RobotOutlined /> 同步练习</Title>
      <Space style={{ marginBottom: 16 }}>
        <Button type={tab === 'generate' ? 'primary' : 'default'} onClick={() => setTab('generate')}>AI 生成</Button>
        <Button type={tab === 'sessions' ? 'primary' : 'default'} onClick={() => setTab('sessions')}>已发布练习</Button>
      </Space>

      {tab === 'generate' && (
        <>
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space orientation="vertical" style={{ width: '100%' }}>
              <TextArea rows={2} placeholder="输入知识点，如：算法与程序设计、数据结构..."
                value={kpInput} onChange={e => setKpInput(e.target.value)} />
              <Space wrap>
                <Select value={subject} onChange={setSubject} style={{ width: 130 }}>
                  {subjectOptions.map(s => <Select.Option key={s} value={s}>{s}</Select.Option>)}
                </Select>
                <Select value={qType} onChange={setQType} style={{ width: 130 }}>
                  <Select.Option value="mixed">🔄 混合出题</Select.Option>
                  {TYPE_OPTIONS.map(opt => (
                    <Select.Option key={opt.value} value={opt.value}>{opt.label}</Select.Option>
                  ))}
                </Select>
                <Select value={difficulty} onChange={setDifficulty} style={{ width: 100 }}>
                  <Select.Option value="easy">简单</Select.Option>
                  <Select.Option value="medium">中等</Select.Option>
                  <Select.Option value="hard">困难</Select.Option>
                </Select>
                <InputNumber min={1} max={50} value={count} onChange={v => setCount(v || 5)}
                  style={{ width: 80 }} /> 题
                <Button type="primary" icon={<RobotOutlined />} loading={generating} onClick={generateQuestions}>
                  AI 出题
                </Button>
              </Space>
            </Space>
          </Card>

          {generating && <Spin description="AI 正在出题..." style={{ display: 'block', margin: '40px auto' }} />}

          {questions.map((q, i) => (
            <Card key={q.id} size="small" title={`第 ${i+1} 题 [${typeLabel[q.type] || q.type}]`}
              extra={<Tag>{q.difficulty === 'easy' ? '简单' : q.difficulty === 'hard' ? '困难' : '中等'}</Tag>}
              style={{ marginBottom: 8, overflowX: 'auto' }}>
              <div style={{ overflowX: 'auto' }}>
                <FormulaRenderer content={q.question} />
              </div>
              <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} />
              {q.options && Object.entries(q.options).map(([k, v]) => (
                <div key={k} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><Text type="secondary">{k}. <FormulaRenderer content={v as string} inline /></Text></div>
              ))}
              <div style={{ marginTop: 8 }}><Tag color="blue">答案：{q.answer}</Tag></div>
            </Card>
          ))}

          {questions.length > 0 && (
            <Card size="small" style={{ marginTop: 16 }}>
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Input placeholder="练习标题（自动生成）" value={title} onChange={e => setTitle(e.target.value)} />
                <Space>
                  <Select value={targetGrade} onChange={setTargetGrade} placeholder="目标年级" style={{ width: 150 }}>
                    {gradeOptions.map(g => (
                      <Select.Option key={g} value={g}>{g}</Select.Option>
                    ))}
                    {isAdmin && <Select.Option value="">全部年级</Select.Option>}
                  </Select>
                  <Select value={targetClass} onChange={setTargetClass} placeholder="目标班级" style={{ width: 150 }} allowClear>
                    {classOptions.map(n => (
                      <Select.Option key={n} value={n}>{n}班</Select.Option>
                    ))}
                    <Select.Option value="">全部班级</Select.Option>
                  </Select>
                  <Button type="primary" loading={publishing} onClick={publishSession}>
                    布置练习
                  </Button>
                </Space>
              </Space>
            </Card>
          )}
        </>
      )}

      {tab === 'sessions' && (
        loadingSessions ? <Spin style={{ display: 'block', margin: '40px auto' }} />
        : sessions.length === 0 ? <Result icon={<FileTextOutlined />} title="暂无发布记录" />
        : <Table dataSource={sessions} rowKey="id"
            pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t: number) => `共 ${t} 条`, pageSizeOptions: ['5', '10', '20', '50'] }}
            columns={[
              { title: '标题', dataIndex: 'title', ellipsis: true },
              { title: '发布者', dataIndex: 'creator_name', width: 100 },
              { title: '年级/班级', render: (_, r) => 
                r.target_students?.length > 0 
                  ? <Tag color="green">定向 {r.target_students.length} 人</Tag>
                  : `${r.target_grade || '全部'} ${r.target_class ? r.target_class+'班' : '全部'}`
              },
              { title: '题数', dataIndex: 'question_count', width: 60 },
              { title: '状态', render: (_, r) => r.status === 'active' ? <Tag color="processing">进行中</Tag> : <Tag>已结束</Tag>, width: 80 },
              { title: '提交', render: (_, r) => `${r.submitted_count}/${r.student_count}`, width: 80 },
              { title: '操作', render: (_, r) => <Space wrap>
                <Button size="small" onClick={() => viewSessionDetail(r.id)}>详情</Button>
                {r.status === 'active' && (
                  <Popconfirm title="结束此练习？学生将无法再提交" onConfirm={() => endSession(r.id)}>
                    <Button size="small" icon={<StopOutlined />}>结束</Button>
                  </Popconfirm>
                )}
                <Popconfirm title="删除此练习？（所有答题记录将被清除）" onConfirm={() => deleteSession(r.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
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
    <div style={{ padding: '0 24px' }}>
      {isTeacher ? <TeacherView /> : <StudentView />}
    </div>
  )
}

export default PracticePage
export { StudentView, TeacherView }
