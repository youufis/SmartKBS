import React, { useState, useEffect } from 'react'
import { Layout, Card, Table, Button, message, Tag, Space, Typography, Spin, Collapse, Modal, Select, Pagination, Divider, Input, InputNumber } from 'antd'
import { ReloadOutlined, BookOutlined, RobotOutlined, DownloadOutlined } from '@ant-design/icons'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

interface WrongQuestion {
  question_id: string
  question_text: string
  question_type: string
  options: Record<string, string>
  correct_answer: string
  student_answer: string
  score: number
  max_score: number
  knowledge_points: string
  /** SVG 配图 */
  svg_content?: string
  has_svg?: number
  /** 万相/上传的图片 */
  media_files?: any
}

interface ExamWrongGroup {
  exam_id: number
  exam_title: string
  exam_subject: string
  submitted_at: string
  score: number
  total_score: number
  wrong_count: number
  wrong_questions: WrongQuestion[]
}

const typeLabel: Record<string, string> = {
  single: '单选题', multiple: '多选题', true_false: '判断题', short: '简答题',
}

const WrongBookPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'

  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<{ total_wrong: number; exams: ExamWrongGroup[]; student_username?: string } | null>(null)

  // 考试列表分页
  const [examPage, setExamPage] = useState(1)
  const [examPageSize, setExamPageSize] = useState(10)

  // 年级/班级/学生三级联动
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [students, setStudents] = useState<{ username: string; name: string; grade: string; class: string }[]>([])
  const [selectedGrade, setSelectedGrade] = useState<string>('')
  const [selectedClass, setSelectedClass] = useState<string>('')
  const [selectedStudent, setSelectedStudent] = useState<string>('')
  const [selectedStudentName, setSelectedStudentName] = useState<string>('')

  const [planModal, setPlanModal] = useState(false)
  const [planLoading, setPlanLoading] = useState(false)
  const [planData, setPlanData] = useState<{ plan: string; total_wrong: number; knowledge_points: string[]; weak_types: string[] } | null>(null)

  // ── 生成练习 ──
  const [practiceModal, setPracticeModal] = useState(false)
  const [genLoading, setGenLoading] = useState(false)
  const [generatedQuestions, setGeneratedQuestions] = useState<any[]>([])
  const [genKp, setGenKp] = useState('')
  const [pubTitle, setPubTitle] = useState('')
  const [pubGrade, setPubGrade] = useState('')
  const [pubClass, setPubClass] = useState('')
  const [pubLoading, setPubLoading] = useState(false)
  const [practiceCount, setPracticeCount] = useState(5)
  const [countModal, setCountModal] = useState(false)

  const loadGrades = async () => {
    if (isStudent) return
    try {
      const { data: res } = await apiClient.get('/api/wrong-book/grades')
      setGrades(res.grades || [])
      if (res.grades?.length > 0) {
        setSelectedGrade(res.grades[0])
        // 自动加载第一个年级的班级
        loadClasses(res.grades[0])
      }
    } catch { /* ignore */ }
  }

  const loadClasses = async (grade: string) => {
    try {
      const { data: res } = await apiClient.get('/api/wrong-book/classes', { params: { grade } })
      setClasses(res.classes || [])
      if (res.classes?.length > 0) {
        setSelectedClass(res.classes[0])
        // 自动加载第一个班级的学生
        loadStudents(grade, res.classes[0])
      } else {
        setSelectedClass('')
        setSelectedStudent('')
        setStudents([])
      }
    } catch { /* ignore */ }
  }

  const loadStudents = async (grade: string, cls: string) => {
    try {
      const params: any = { grade }
      if (cls) params.class_name = cls
      const { data: res } = await apiClient.get('/api/wrong-book/students', { params })
      setStudents(res.students || [])
      if (res.students?.length > 0) {
        // 自动选择第一个学生并加载错题
        setSelectedStudent(res.students[0].username)
        loadData(res.students[0].username)
      } else {
        setSelectedStudent('')
        setData(null)
      }
    } catch { /* ignore */ }
  }

  const handleGradeChange = (grade: string) => {
    setSelectedGrade(grade)
    setSelectedClass('')
    setSelectedStudent('')
    setStudents([])
    setData(null)
    loadClasses(grade)
  }

  const handleClassChange = (cls: string) => {
    setSelectedClass(cls)
    setSelectedStudent('')
    setData(null)
    if (cls) loadStudents(selectedGrade, cls)
  }


  const loadData = async (studentUsername?: string) => {
    setLoading(true)
    try {
      const params = studentUsername ? { student_username: studentUsername } : {}
      const { data: res } = await apiClient.get('/api/wrong-book/list', { params })
      setData(res)
    } catch {
      message.error('加载错题失败')
    }
    setLoading(false)
  }

  const handleStudentChange = (username: string) => {
    setSelectedStudent(username)
    const student = students.find(s => s.username === username)
    setSelectedStudentName(student?.name || username)
    if (username) loadData(username)
  }

  // 错题考试列表分页
  const pagedExams = data ? data.exams.slice((examPage - 1) * examPageSize, examPage * examPageSize) : []

  const loadReviewPlan = async () => {
    setPlanLoading(true)
    setPlanData(null)
    setPlanModal(true)
    try {
      const params = selectedStudent ? { student_username: selectedStudent } : {}
      const { data: res } = await apiClient.get('/api/wrong-book/review-plan', { params })
      if (res.task_id) {
        const result = await pollAiTask(res.task_id)
        if (result) {
          setPlanData({ plan: result.plan || result.result, total_wrong: res.total_wrong, knowledge_points: res.knowledge_points, weak_types: res.weak_types })
        } else {
          message.error('AI 分析超时')
          setPlanModal(false)
        }
      } else {
        setPlanData(res)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '生成复习计划失败')
      setPlanModal(false)
    }
    setPlanLoading(false)
  }

  const generatePracticeFromWrong = async () => {
    if (!data || data.exams.length === 0) { message.warning('没有错题数据'); return }
    // 收集所有错题的知识点（去重）
    const kpSet = new Set<string>()
    data.exams.forEach(exam => exam.wrong_questions.forEach(q => {
      if (q.knowledge_points) q.knowledge_points.split(/[,，、]/).forEach(kp => { if (kp.trim()) kpSet.add(kp.trim()) })
    }))
    const kps = Array.from(kpSet)
    if (kps.length === 0) { message.warning('错题中未提取到知识点'); return }

    // 教师/管理员 → 生成并弹窗预览，可直接布置
    if (!isStudent) {
      // 立即弹窗显示 loading
      setGeneratedQuestions([])
      setGenLoading(true)
      setPracticeModal(true)
      try {
        const { data: gen } = await apiClient.post('/api/wrong-book/practice/generate', {
          count: practiceCount,
          subjects: ['信息科技'],
          knowledge_points: kps.join('，'),
          student_username: selectedStudent,
        })
        // 直接返回题目列表（非异步）
        const questions = gen.questions || []
        // 存入 state 供弹窗使用
        const studentName = students.find(s => s.username === selectedStudent)?.name || selectedStudent
        setGeneratedQuestions(questions)
        setGenKp(kps.join('，'))
        setGenLoading(false)
        setPubGrade('')
        setPubClass('')
        setPubTitle(`${studentName} 的错题巩固练习`)
      } catch (e: any) {
        message.error(e.response?.data?.detail || '生成失败')
        setGenLoading(false)
        setPracticeModal(false)
      }
    } else {
      // 学生 → 跳转到错题巩固练习（TODO）
      message.info('正在从错题本中抽取原题进行巩固练习...')
    }
  }

  useEffect(() => {
    if (isStudent) {
      loadData()
      apiClient.get('/api/wrong-book/practice/check-auto').then(() => {}).catch(() => {})
    } else {
      const init = async () => { await loadGrades() }
      init()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStudent])

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Title level={4} style={{ margin: 0 }}>📕 错题本</Title>
            {data && (
              <Text type="secondary">共 {data.total_wrong} 道错题，来自 {data.exams.length} 场考试</Text>
            )}
          </Space>
          <Space>
            {!isStudent && (
            <Space>
              <Select
                style={{ width: 100 }}
                placeholder="年级"
                value={selectedGrade || undefined}
                onChange={handleGradeChange}
                options={grades.map(g => ({ label: g, value: g }))}
              />
              <Select
                style={{ width: 100 }}
                placeholder="班级"
                value={selectedClass || undefined}
                onChange={handleClassChange}
                options={classes.map(c => ({ label: `${c}班`, value: c }))}
              />
              <Select
                style={{ width: 160 }}
                placeholder="选择学生"
                value={selectedStudent || undefined}
                onChange={handleStudentChange}
                options={students.map(s => ({ label: `${s.name} (${s.username})`, value: s.username }))}
              />
            </Space>
          )}
            {!isStudent && (
              <Button icon={<RobotOutlined />} onClick={loadReviewPlan} loading={planLoading}
                disabled={!data || data.total_wrong === 0}>
                AI 复习计划
              </Button>
            )}
            {!isStudent && (
              <Button icon={<RobotOutlined />} onClick={() => setCountModal(true)}
                disabled={!data || data.total_wrong === 0}>
                生成练习
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={() => isStudent ? loadData() : loadData(selectedStudent)} loading={loading}>刷新</Button>
          </Space>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><Spin size="large" /></div>
        ) : !data || data.exams.length === 0 ? (
          <Card>
            <Space direction="vertical" style={{ width: '100%', textAlign: 'center', padding: 40 }}>
              <BookOutlined style={{ fontSize: 48, color: '#d9d9d9' }} />
              <Text type="secondary">暂无错题，继续保持！</Text>
            </Space>
          </Card>
        ) : (
          <div>
            <div style={{ marginBottom: 12, textAlign: 'right' }}>
              <Text type="secondary">共 {data.exams.length} 场考试，{data.total_wrong} 道错题</Text>
            </div>
            {pagedExams.map((exam) => (
              <Collapse key={exam.exam_id} size="small" style={{ marginBottom: 12 }}
                items={[{
                  key: String(exam.exam_id),
                  label: (
                    <Space>
                      <Text strong>{exam.exam_title}</Text>
                      <Tag>{exam.exam_subject}</Tag>
                      <Tag color="red">{exam.wrong_count} 道错题</Tag>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        得分 {exam.score}/{exam.total_score} | {exam.submitted_at ? exam.submitted_at.slice(0, 10) : ''}
                      </Text>
                    </Space>
                  ),
                  children: (
                    <Table dataSource={exam.wrong_questions} rowKey="question_id" size="small"
                      pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => '共 ' + t + ' 道错题', pageSizeOptions: ['5', '10', '20'] }}
                      columns={[
                        { title: '题型', dataIndex: 'question_type', width: 70, render: (t: string) => <Tag>{typeLabel[t] || t}</Tag> },
                        { title: '题目', dataIndex: 'question_text', width: 300,
                          render: (t: string) => <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><FormulaRenderer content={t} /></div> },
                        { title: '配图', key: 'media', width: 100,
                          render: (_: any, r: WrongQuestion) => (
                            <MediaDisplay svgContent={r.svg_content} hasSvg={r.has_svg} mediaFiles={r.media_files} size="compact" />
                          ),
                        },
                        { title: '选项', key: 'options', width: 300,
                          render: (_: any, r: WrongQuestion) => {
                          const opts = r.options || {}
                          return (
                            <Space direction="vertical" size={2} style={{ width: '100%' }}>
                              {Object.entries(opts).map(([k, v]) => {
                                const isStudent = r.student_answer === k
                                const isCorrect = r.correct_answer === k
                                let color = '#333'
                                if (isStudent && isCorrect) color = '#52c41a'
                                else if (isStudent) color = '#ff4d4f'
                                else if (isCorrect) color = '#52c41a'
                                return (
                                  <div key={k} style={{ color, fontSize: 12, lineHeight: 1.8, background: isStudent ? '#fff2f0' : 'transparent', padding: '2px 6px', borderRadius: 3, border: isCorrect ? '1px solid #b7eb8f' : 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                    <Text style={{ fontWeight: isStudent || isCorrect ? 600 : 400, color, fontSize: 12 }}>{k}. <FormulaRenderer content={v} inline /></Text>
                                    {isStudent && <Text style={{ fontSize: 10, color: '#ff4d4f', marginLeft: 4 }}>你的选择</Text>}
                                    {isCorrect && <Text style={{ fontSize: 10, color: '#52c41a', marginLeft: 4 }}>✓</Text>}
                                  </div>
                                )
                              })}
                            </Space>
                          )
                        }},
                        { title: '知识点', dataIndex: 'knowledge_points', width: 150, ellipsis: true },
                        { title: '得分', key: 'score', width: 80, render: (_: any, r: WrongQuestion) => <Text type="danger">{r.score} / {r.max_score}</Text> },
                      ]}
                    />
                  ),
                }]}
              />
            ))}
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Pagination
                current={examPage} pageSize={examPageSize} total={data.exams.length}
                showSizeChanger showTotal={(t) => '共 ' + t + ' 场考试'}
                pageSizeOptions={['5', '10', '20', '50']}
                onChange={(p, ps) => { setExamPage(p); setExamPageSize(ps) }}
                size="small"
              />
            </div>
          </div>
        )}
      </Space>

      <Modal
        title={<><RobotOutlined style={{ color: '#1677ff' }} /> AI 复习计划</>}
        open={planModal}
        onCancel={() => { if (planLoading) return; setPlanModal(false) }}
        width={700}
        footer={
          planLoading ? null : (
            <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <Button icon={<DownloadOutlined />} onClick={() => {
                const token = localStorage.getItem('smartkb_token')
                const studentParam = selectedStudent ? `&student_username=${selectedStudent}` : ''
                window.open(`/api/wrong-book/review-plan/export?token=${token}${studentParam}`, '_blank')
              }}>导出 Word</Button>
              <Button onClick={() => setPlanModal(false)}>关闭</Button>
            </Space>
          )
        }
      >
        {planLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#666' }}>AI 正在生成复习计划，请稍候...</div>
          </div>
        ) : planData ? (
          <div style={{ maxHeight: '70vh', overflow: 'auto', padding: '0 4px' }}>
            {planData.total_wrong > 0 && (
              <Space style={{ marginBottom: 16 }} wrap>
                <Tag icon={<BookOutlined />} color="blue">共 {planData.total_wrong} 道错题</Tag>
                {planData.weak_types?.map(t => <Tag key={t} color="orange">{t}</Tag>)}
                {planData.knowledge_points?.slice(0, 5).map(kp => (
                  <Tag key={kp} color="purple">{kp}</Tag>
                ))}
              </Space>
            )}
            <div className="markdown-content">
              <FormulaRenderer content={planData.plan} />
            </div>
          </div>
        ) : null}
      </Modal>

      {/* ── 设置题目数量 ── */}
      <Modal title="生成错题练习" open={countModal}
        onCancel={() => setCountModal(false)}
        footer={[
          <Button key="cancel" onClick={() => setCountModal(false)}>取消</Button>,
          <Button key="go" type="primary" icon={<RobotOutlined />}
            onClick={() => {
              setCountModal(false);
              setTimeout(() => generatePracticeFromWrong(), 100);
            }}>
            开始生成
          </Button>,
        ]}>
        <Space direction="vertical" style={{ width: '100%', padding: '20px 0' }}>
          <Text>生成题目数量：</Text>
          <InputNumber min={1} max={20} value={practiceCount} onChange={v => setPracticeCount(v || 5)}
            style={{ width: 120 }} />
          <Text type="secondary" style={{ fontSize: 13 }}>将从题库中搜索同知识点的题目，不够时由 AI 补充。范围 1~20 题。</Text>
        </Space>
      </Modal>

      {/* ── 生成练习弹窗 ── */}
      <Modal title={<><RobotOutlined style={{ color: '#1677ff' }} /> {genLoading ? 'AI 正在出题...' : '已生成练习'}</>}
        open={practiceModal} onCancel={() => { if (genLoading) return; setPracticeModal(false) }}
        width={700} footer={null} closable={!genLoading}>
        {genLoading ? (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: '#666' }}>AI 正在根据错题知识点生成练习题，请稍候...</div>
          </div>
        ) : generatedQuestions.length > 0 && (
          <>
            <div style={{ marginBottom: 12 }}>
              <Text type="secondary">共 {generatedQuestions.length} 道题，知识点：{genKp}</Text>
            </div>
            {generatedQuestions.map((q: any, i: number) => (
              <Card key={i} size="small" title={`第 ${i+1} 题 [${typeLabel[q.type] || q.type}]`}
                style={{ marginBottom: 8, overflowX: 'auto' }}>
                <div style={{ overflowX: 'auto' }}>
                  <FormulaRenderer content={q.question || q.question_text} />
                </div>
                <MediaDisplay svgContent={q.svg_content} hasSvg={q.has_svg} mediaFiles={(q as any).media_files} />
                {q.options && Object.entries(q.options).map(([k, v]) => (
                  <div key={k}><Text type="secondary">{k}. <FormulaRenderer content={v as string} inline /></Text></div>
                ))}
                <div style={{ marginTop: 4 }}><Tag color="blue">答案：{q.answer}</Tag></div>
              </Card>
            ))}
            <Divider />
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input placeholder="练习标题（如：错题巩固练习）" value={pubTitle} onChange={e => setPubTitle(e.target.value)} />
              <Card size="small" style={{ background: '#f6ffed', border: '1px solid #b7eb8f' }}>
                <Space>
                  <Tag color="green">定向推送</Tag>
                  <Text strong>{selectedStudentName}</Text>
                  <Text type="secondary">({selectedStudent})</Text>
                </Space>
              </Card>
              <Space style={{ marginTop: 8 }}>
                <Button type="primary" loading={pubLoading} onClick={async () => {
                  if (!pubTitle.trim()) { message.warning('请输入标题'); return }
                  setPubLoading(true)
                  try {
                    await apiClient.post('/api/practice/sessions', {
                      title: pubTitle.trim(), knowledge_points: genKp,
                      question_ids: generatedQuestions.map((q: any) => q.id),
                      target_students: [selectedStudent],
                    })
                    message.success('练习已定向推送给学生')
                    setPracticeModal(false)
                  } catch (e: any) { message.error(e.response?.data?.detail || '布置失败') }
                  finally { setPubLoading(false) }
                }}>定向布置练习</Button>
              </Space>
            </Space>
          </>
        )}
      </Modal>
    </Layout>
  )
}

export default WrongBookPage
