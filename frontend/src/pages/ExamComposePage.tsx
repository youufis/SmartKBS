import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Layout,
  Typography,
  Spin,
  Button,
  Dropdown,
  message,
  Modal,
  Space,
  Tag,
} from 'antd'
import { ArrowLeftOutlined, RobotOutlined, DownloadOutlined } from '@ant-design/icons'
import ComposeWizard from '../components/ComposeWizard'
import * as examsApi from '../api/exams'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const ExamComposePage: React.FC = () => {
  const { examId } = useParams<{ examId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  const [exam, setExam] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [subjects, setSubjects] = useState<string[]>([])
  const [grades, setGrades] = useState<string[]>([])
  const [wizardVisible, setWizardVisible] = useState(false)

  useEffect(() => {
    if (!examId || !isTeacherOrAdmin) {
      navigate('/exam')
      return
    }
    loadExam()
    loadSubjects()
    loadGrades()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId])

  async function loadExam() {
    try {
      const id = Number(examId)
      const data = await examsApi.getExam(id)
      setExam(data)
    } catch {
      message.error('加载考试信息失败')
      navigate('/exam')
    } finally {
      setLoading(false)
    }
  }

  async function loadSubjects() {
    try {
      const { data } = await apiClient.get('/api/config/subjects')
      if (data?.subjects?.length > 0) {
        setSubjects(data.subjects)
      }
    } catch { /* ignore */ }
  }

  async function loadGrades() {
    try {
      const { data } = await apiClient.get('/api/config/grades')
      const gradeList = data?.grades
      if (gradeList?.length > 0) {
        // 新API返回 [{id, name, stage, sort_order}, ...]
        setGrades(gradeList.map((g: any) => g.name || g))
      }
    } catch { /* ignore */ }
  }

  // ── 快捷导出 ──
  const handleQuickExport = (type: 'paper' | 'answer-key' | 'answer-sheet') => {
    const id = Number(examId)
    let url = ''
    switch (type) {
      case 'paper':
        url = examsApi.getExportPaperUrl(id)
        break
      case 'answer-key':
        url = examsApi.getExportAnswerKeyUrl(id)
        break
      case 'answer-sheet':
        url = examsApi.getExportAnswerSheetUrl(id)
        break
    }
    if (url) window.open(url, '_blank')
  }

  if (loading) {
    return (
      <Layout style={{
        height: 'calc(100vh - 112px)',
        background: '#fff',
        borderRadius: 8,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}>
        <Spin size="large" />
      </Layout>
    )
  }

  if (!exam) {
    return null
  }

  return (
    <Layout style={{
      height: 'calc(100vh - 112px)',
      background: '#fff',
      borderRadius: 8,
      overflow: 'auto',
      padding: 24,
    }}>
      {/* ── 页面头部 ── */}
      <div style={{ marginBottom: 24 }}>
        <Space>
          <Button
            icon={<ArrowLeftOutlined />}
            onClick={() => navigate('/exam')}
            type="text"
          >
            返回
          </Button>
        </Space>
        <div style={{ marginTop: 8 }}>
          <Typography.Title level={4} style={{ margin: 0, fontSize: 20 }}>
            <RobotOutlined style={{ marginRight: 8, color: '#1677ff' }} />
            智能组卷
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            考试：<strong>{exam.title}</strong>
            <Tag style={{ marginLeft: 8 }}>{exam.subject}</Tag>
            <Tag>{exam.status === 'draft' ? '草稿' : exam.status === 'published' ? '已发布' : '已结束'}</Tag>
          </Typography.Text>
        </div>
      </div>

      {/* 从题库中选择的题目统计 */}
      <div style={{ marginBottom: 24 }}>
        <ExamQuestionsSummary examId={Number(examId)} />
      </div>

      {/* ── 主操作区 ── */}
      <div
        style={{
          background: '#f6f8fa',
          border: '1px dashed #d9d9d9',
          borderRadius: 12,
          padding: 40,
          textAlign: 'center',
        }}
      >
        <RobotOutlined style={{ fontSize: 48, color: '#1677ff', marginBottom: 16 }} />
        <Typography.Title level={4} style={{ marginBottom: 8 }}>
          开启智能组卷
        </Typography.Title>
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 24, maxWidth: 500, margin: '0 auto 24px' }}>
          配置题型题量、难度分布、知识点范围，AI 将从题库中智能选择最优试题组合，
          并生成排版规范的 Word 文档供打印使用。
        </Typography.Text>
        <Space size={16}>
          <Button
            type="primary"
            size="large"
            icon={<RobotOutlined />}
            onClick={() => setWizardVisible(true)}
          >
            开始智能组卷
          </Button>
          <Dropdown.Button
            size="large"
            icon={<DownloadOutlined />}
            menu={{
              items: [
                { key: 'paper', icon: <DownloadOutlined />, label: '导出学生试卷', onClick: () => handleQuickExport('paper') },
                { key: 'answer-key', icon: <DownloadOutlined />, label: '导出教师答案卷', onClick: () => handleQuickExport('answer-key') },
                { key: 'answer-sheet', icon: <DownloadOutlined />, label: '导出答题卡', onClick: () => handleQuickExport('answer-sheet') },
              ],
            }}
          >
            导出文档
          </Dropdown.Button>
        </Space>
      </div>

      {/* ── 组卷向导弹窗 ── */}
      <Modal
        title={
          <Space>
            <RobotOutlined />
            <span>智能组卷向导 - {exam.title}</span>
          </Space>
        }
        open={wizardVisible}
        onCancel={() => setWizardVisible(false)}
        width={900}
        footer={null}
        destroyOnClose
      >
        <ComposeWizard
          examId={Number(examId)}
          examTitle={exam.title}
          subjects={subjects}
          grades={grades}
          onClose={() => {
            setWizardVisible(false)
            loadExam() // 刷新
          }}
        />
      </Modal>
    </Layout>
  )
}

/** 考试现有题目统计组件 */
const ExamQuestionsSummary: React.FC<{ examId: number }> = ({ examId }) => {
  const [questions, setQuestions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    examsApi.getExam(examId).then((data) => {
      setQuestions(data.questions || [])
    }).catch(() => {}).finally(() => setLoading(false))
  }, [examId])

  if (loading) return <Spin size="small" />

  if (questions.length === 0) {
    return (
      <Typography.Text type="secondary">
        💡 当前考试还没有题目，请使用智能组卷或手动添加
      </Typography.Text>
    )
  }

  const typeCount: Record<string, number> = {}
  let totalScore = 0
  questions.forEach((q: any) => {
    typeCount[q.type] = (typeCount[q.type] || 0) + 1
    totalScore += q.question_score || 0
  })

  return (
    <Space wrap size={[8, 4]}>
      <Typography.Text strong>已有题目：</Typography.Text>
      {Object.entries(typeCount).map(([type, count]) => (
        <Tag key={type}>
          {({single:'单选',multiple:'多选',true_false:'判断',short:'简答',fill:'填空',essay:'作文',subjective:'主观题'} as Record<string,string>)[type] || type}: {count}题
        </Tag>
      ))}
      <Tag color="blue">共 {questions.length} 题</Tag>
      <Tag color="green">总分: {totalScore.toFixed(1)}</Tag>
    </Space>
  )
}

export default ExamComposePage
