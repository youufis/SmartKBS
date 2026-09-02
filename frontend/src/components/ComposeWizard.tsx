import { useTranslation } from 'react-i18next'
import React, { useState } from 'react'
import { Steps, Button, Space, message, Form, Spin, Typography, Card } from 'antd'
import {
  SettingOutlined,
  RobotOutlined,
  FileTextOutlined,
  DownloadOutlined,
} from '@ant-design/icons'
import PaperConfigForm from './PaperConfigForm'
import QuestionPreview from './QuestionPreview'
import type { SelectedQuestion } from './QuestionPreview'
import * as examsApi from '../api/exams'
import type { ComposeResponse, TypeConfigItem } from '../api/exams'

interface ComposeWizardProps {
  examId: number
  examTitle: string
  subjects: string[]
  grades: string[]
  onClose: () => void
}

const ComposeWizard: React.FC<ComposeWizardProps> = ({
  examId,
  examTitle,
  subjects,
  grades,
  onClose,
}) => {
  const { t } = useTranslation('exam')
  const [currentStep, setCurrentStep] = useState(0)
  const [form] = Form.useForm()
  const [composing, setComposing] = useState(false)
  const [selectedQuestions, setSelectedQuestions] = useState<SelectedQuestion[]>([])
  const [composeResult, setComposeResult] = useState<ComposeResponse | null>(null)
  const [knowledgePoints, setKnowledgePoints] = useState<string[]>([])

  // 总分实时计算
  const [totalScore, setTotalScore] = useState(100)

  // 加载知识点
  React.useEffect(() => {
    examsApi.getKnowledgePoints().then((res) => {
      setKnowledgePoints(res.knowledge_points)
    }).catch(() => {})
  }, [])

  // 表单初始值
  const formInitialValues = {
    school_name: '',
    semester: '',
    subject: subjects[0] || '',
    target_grade: [],
    duration: 45,
    type_configs: [
      { type: 'single', count: 10, score_per_question: 3 },
      { type: 'multiple', count: 5, score_per_question: 4 },
      { type: 'true_false', count: 5, score_per_question: 2 },
      { type: 'short', count: 3, score_per_question: 10 },
    ],
    difficulty_easy_ratio: 20,
    difficulty_medium_ratio: 50,
    difficulty_hard_ratio: 30,
    knowledge_points: [],
    total_score: 100,
    replace_existing: true,
    use_ai: true,
  }

  // 计算总分
  const _calcTotalScore = () => {
    const configs: TypeConfigItem[] = form.getFieldValue('type_configs') || []
    let total = 0
    configs.forEach((tc) => {
      total += (tc.count || 0) * (tc.score_per_question || 0)
    })
    setTotalScore(total || 100)
  }

  // 监听表单变化以更新总分
  const handleValuesChange = (changedValues: any) => {
    if (changedValues.type_configs || changedValues.total_score !== undefined) {
      _calcTotalScore()
    }
  }

  // ── 步骤定义 ──
  const steps = [
    {
      title: t('cwStepExamInfo'),
      icon: <SettingOutlined />,
      content: (
        <div style={{ padding: '16px 0' }}>
          <Typography.Title level={5} style={{ marginBottom: 16 }}>
            {t('cwCfgBasics')}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
            {t('cwExamLabel', { title: examTitle, id: examId })}
          </Typography.Text>
          <PaperConfigForm
            subjects={subjects}
            grades={grades}
            knowledgePoints={knowledgePoints}
            totalScore={totalScore}
            onTotalScoreChange={setTotalScore}
          />
        </div>
      ),
    },
    {
      title: t('cwStepAi'),
      icon: <RobotOutlined />,
      content: (
        <div style={{ padding: '16px 0' }}>
          <Typography.Title level={5} style={{ marginBottom: 16 }}>
            {t('cwAiComposing')}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
            {t('cwAiHint')}
          </Typography.Text>
          {composing ? (
            <div style={{ textAlign: 'center', padding: '60px 0' }}>
              <Spin size="large" />
              <div style={{ marginTop: 16, color: '#666' }}>
                {t('cwAiWorking')}
              </div>
            </div>
          ) : composeResult ? (
            <div>
              <Card
                style={{
                  marginBottom: 16,
                  background: '#f6ffed',
                  borderColor: '#b7eb8f',
                }}
              >
                <Space orientation="vertical">
                  <Typography.Text style={{ fontSize: 16 }}>
                    ✅ <strong>{t('cwDone')}！</strong>
                  </Typography.Text>
                  <Typography.Text>{composeResult.message}</Typography.Text>
                  <Typography.Text type="secondary">
                    {composeResult.reason}
                  </Typography.Text>
                </Space>
              </Card>
              <QuestionPreview
                questions={selectedQuestions}
                typeStats={composeResult.type_stats}
                difficultyStats={composeResult.difficulty_stats}
                totalScore={composeResult.total_score}
                onRemoveQuestion={handleRemoveQuestion}
                onRegenerate={handleCompose}
                loading={composing}
              />
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Typography.Text type="secondary">
                {t('cwClickStart')}
              </Typography.Text>
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('cwStepExport'),
      icon: <DownloadOutlined />,
      content: (
        <div style={{ padding: '16px 0' }}>
          <Typography.Title level={5} style={{ marginBottom: 16 }}>
            {t('cwExportTitle')}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
            {t('cwExportPick')}
          </Typography.Text>

          <Space orientation="vertical" style={{ width: '100%' }} size={16}>
            <ExportCard
              icon={<FileTextOutlined style={{ fontSize: 32, color: '#1677ff' }} />}
              title={t('cwPaper')}
              description={t('cwPaperDesc')}
              onClick={() => handleExport('paper')}
            />
            <ExportCard
              icon={<FileTextOutlined style={{ fontSize: 32, color: '#52c41a' }} />}
              title={t('cwAnswerKey')}
              description={t('cwAnswerKeyDesc')}
              onClick={() => handleExport('answer-key')}
            />
            <ExportCard
              icon={<FileTextOutlined style={{ fontSize: 32, color: '#fa8c16' }} />}
              title={t('cwSheet')}
              description={t('cwSheetDesc')}
              onClick={() => handleExport('answer-sheet')}
            />
          </Space>
        </div>
      ),
    },
  ]

  // ── 处理组卷 ──
  async function handleCompose() {
    try {
      const values = await form.validateFields()
      setComposing(true)
      setComposeResult(null)
      setSelectedQuestions([])

      const req: examsApi.ComposeRequest = {
        school_name: values.school_name || '',
        semester: values.semester || '',
        target_grade: values.target_grade?.join('、') || '',
        type_configs: values.type_configs.map((tc: any) => ({
          type: tc.type,
          count: tc.count || 0,
          score_per_question: tc.score_per_question || 5,
        })),
        difficulty_easy_ratio: values.difficulty_easy_ratio || 20,
        difficulty_medium_ratio: values.difficulty_medium_ratio || 50,
        difficulty_hard_ratio: values.difficulty_hard_ratio || 30,
        knowledge_points: values.knowledge_points || [],
        total_score: values.total_score || totalScore,
        replace_existing: values.replace_existing !== false,
        use_ai: values.use_ai !== false,
      }

      const result = await examsApi.composeExam(examId, req)
      setComposeResult(result)

      // 加载组卷后的题目
      await loadExamQuestions()
      setCurrentStep(1)
    } catch (err: any) {
      console.error('组卷错误:', err)
      if (err?.response?.data?.detail) {
        message.error(err.response.data.detail)
      } else if (err?.errorFields) {
        message.warning(t('cwCfgIncomplete') + err.errorFields.map((f: any) => f.name?.join('.')).join(', '))
      } else if (err?.message) {
        message.error(t('cwFailed') + err.message)
      } else {
        message.error(t('cwFailedRetry'))
      }
    } finally {
      setComposing(false)
    }
  }

  // ── 加载考试题目 ──
  async function loadExamQuestions() {
    try {
      const detail = await examsApi.getExam(examId)
      const questions = (detail.questions || []).map((q: any) => ({
        id: q.id,
        type: q.type,
        question_text: q.question_text,
        options: q.options,
        correct_answer: q.correct_answer,
        difficulty: q.difficulty,
        knowledge_points: q.knowledge_points,
        score: q.question_score,
        svg_content: q.svg_content,
        has_svg: q.has_svg,
        media_files: q.media_files,
      }))
      setSelectedQuestions(questions)
    } catch {
      // ignore
    }
  }

  // ── 移除题目 ──
  async function handleRemoveQuestion(questionId: number) {
    try {
      await examsApi.removeQuestionsFromExam(examId, [questionId])
      message.success(t('cwRemoved'))
      await loadExamQuestions()

      // 更新统计
      if (composeResult) {
        const updatedStats = { ...composeResult.type_stats }
        const removedQ = selectedQuestions.find((q) => q.id === questionId)
        if (removedQ) {
          updatedStats[removedQ.type] = (updatedStats[removedQ.type] || 1) - 1
        }
        setComposeResult({
          ...composeResult,
          added: composeResult.added - 1,
          type_stats: updatedStats,
        })
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('cwRemoveFailed'))
    }
  }

  // ── 导出 ──
  function handleExport(type: 'paper' | 'answer-key' | 'answer-sheet') {
    const schoolName = form.getFieldValue('school_name') || ''
    const semester = form.getFieldValue('semester') || ''

    let url = ''
    switch (type) {
      case 'paper':
        url = examsApi.getExportPaperUrl(examId, schoolName, semester)
        break
      case 'answer-key':
        url = examsApi.getExportAnswerKeyUrl(examId, schoolName, semester)
        break
      case 'answer-sheet':
        url = examsApi.getExportAnswerSheetUrl(examId)
        break
    }

    if (url) {
      window.open(url, '_blank')
      message.success(t('cwDownloading'))
    }
  }

  // ── 步骤控制 ──
  async function handleNext() {
    if (currentStep === 0) {
      // 步骤0 → 步骤1：执行组卷
      await handleCompose()
      // 不自动跳转，让用户在步骤1看到结果
    } else if (currentStep === 1) {
      // 步骤1 → 步骤2
      setCurrentStep(2)
    }
  }

  function handlePrev() {
    if (currentStep === 1) {
      setCurrentStep(0)
    } else if (currentStep === 2) {
      setCurrentStep(1)
    }
  }

  return (
    <div>
      {/* 步骤条 */}
      <Steps
        current={currentStep}
        style={{ marginBottom: 24 }}
        items={steps.map((s) => ({
          title: s.title,
          icon: s.icon,
        }))}
      />

      {/* 步骤内容 */}
      <Form
        form={form}
        layout="vertical"
        initialValues={formInitialValues}
        onValuesChange={handleValuesChange}
        style={{ minHeight: 400 }}
      >
        {currentStep < steps.length && steps[currentStep].content}
      </Form>

      {/* 底部操作按钮 */}
      <div
        style={{
          marginTop: 24,
          paddingTop: 16,
          borderTop: '1px solid #f0f0f0',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <div>
          {currentStep > 0 && (
            <Button onClick={handlePrev}>{t('cwPrev')}</Button>
          )}
        </div>
        <Space>
          <Button onClick={onClose}>{t('cancelBtn')}</Button>
          {currentStep < steps.length - 1 && (
            <Button
              type="primary"
              onClick={handleNext}
              loading={currentStep === 0 && composing}
              disabled={false} // 由 loading 控制防连点，不需要额外禁用
            >
              {currentStep === 0 ? t('cwStart') : currentStep === 1 ? t('cwNextExport') : ''}
            </Button>
          )}
        </Space>
      </div>
    </div>
  )
}

/** 导出卡片 */
const ExportCard: React.FC<{
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}> = ({ icon, title, description, onClick }) => (
  <Card
    hoverable
    style={{
      border: '1px solid #e8e8e8',
      cursor: 'pointer',
    }}
    onClick={onClick}
  >
    <Space align="start" size={16}>
      {icon}
      <div>
        <Typography.Text strong style={{ fontSize: 15 }}>
          {title}
        </Typography.Text>
        <br />
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {description}
        </Typography.Text>
      </div>
    </Space>
  </Card>
)

export default ComposeWizard
