import React, { useState, useRef, useEffect } from 'react'
import {
  Modal, Form, Input, Select, Button, message, Steps, Tree, Space, Tag,
  Typography, Spin, Alert, Divider, Upload, Progress,
} from 'antd'
import {
  RobotOutlined, FileTextOutlined, CheckCircleOutlined,
  BookOutlined, NodeIndexOutlined, InboxOutlined,
  CloseCircleOutlined, LoadingOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import apiClient from '../api/client'

const { Option } = Select
const { Dragger } = Upload

const TIMEOUT_MS = 300_000 // 300 秒超时（5 分钟）

// ── 类型定义 ──

interface KnowledgePoint {
  name: string
  difficulty?: 'easy' | 'medium' | 'hard'
  estimated_minutes?: number
}

interface Section {
  name: string
  knowledge_points?: KnowledgePoint[]
}

interface Chapter {
  name: string
  children?: Section[]
  knowledge_points?: KnowledgePoint[]
}

interface AiResult {
  course_name: string
  course_code?: string
  course_description?: string
  source_file?: string
  chapters: Chapter[]
  saved?: { chapters: number; knowledge_points: number }
}

interface TreeNode {
  title: React.ReactNode
  key: string
  children?: TreeNode[]
  isLeaf?: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

const AICurriculumGenerator: React.FC<Props> = ({ open, onClose, onSuccess }) => {
  const { t } = useTranslation('curriculum')
  const [step, setStep] = useState(0) // 0=输入, 1=生成中, 2=预览, 3=错误
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const [result, setResult] = useState<AiResult | null>(null)
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [saveDone, setSaveDone] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [subjects, setSubjects] = useState<string[]>([])
  const [gradeOptions, setGradeOptions] = useState<string[]>([])

  // 从后端加载课程列表和年级列表
  useEffect(() => {
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setSubjects(data.subjects)
    }).catch(() => {})
    apiClient.get('/api/config/grades').then(({ data }) => {
      const list = data?.grades
      if (list?.length > 0) setGradeOptions(list.map((g: any) => g.name || g))
    }).catch(() => {})
  }, [])

  // ── 动态进度 ──
  const [progressPercent, setProgressPercent] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // ── 清理定时器 ──
  const clearTimers = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  // ── 启动动态进度动画 ──
  const startProgress = () => {
    clearTimers()
    setProgressPercent(5)
    setProgressText(t('aiGenerator.preparing'))
    const stageDurations = [
      { key: 'sending', label: t('aiGenerator.sending'), duration: 3000 },
      { key: 'analyzing', label: t('aiGenerator.analyzing'), duration: 5000 },
      { key: 'extracting', label: t('aiGenerator.extracting'), duration: 5000 },
      { key: 'building', label: t('aiGenerator.building'), duration: 4000 },
      { key: 'parsing', label: t('aiGenerator.parsing'), duration: 2000 },
    ]
    const totalDuration = stageDurations.reduce((s, st) => s + st.duration, 0)
    let elapsed = 0
    const stepMs = 300
    timerRef.current = setInterval(() => {
      elapsed += stepMs
      const pct = Math.min(85, Math.round((elapsed / totalDuration) * 85))
      setProgressPercent(pct)
      // 根据进度显示对应的阶段文字
      let accDuration = 0
      let currentLabel = t('aiGenerator.processing')
      for (const st of stageDurations) {
        accDuration += st.duration
        if (elapsed <= accDuration) {
          currentLabel = st.label
          break
        }
      }
      setProgressText(currentLabel)
    }, stepMs)
  }

  // ── 停止进度（完成或失败）──
  const stopProgress = (success: boolean) => {
    clearTimers()
    setProgressPercent(success ? 100 : 0)
    setProgressText(success ? t('aiGenerator.completed') : t('aiGenerator.failed'))
  }

  // ── 通用错误处理 ──
  const handleError = (err: unknown, customMsg?: string) => {
    stopProgress(false)
    setLoading(false)
    let detail = customMsg || ''
    const e = err as { response?: { data?: { detail?: string } }; message?: string }
    if (e?.response?.data?.detail) {
      detail = e.response.data.detail
    } else if (e?.message) {
      detail = e.message
    } else if (typeof err === 'string') {
      detail = err
    }
    if (!detail) detail = t('aiGenerator.errorDefault')
    setErrorMsg(detail)
    setStep(3) // 错误步骤
  }

  // ── 调用 API 封装（带超时和取消） ──
  const callApi = async (url: string, data: Record<string, unknown> | FormData, config?: Record<string, unknown>) => {
    abortRef.current = new AbortController()
    const timeoutId = setTimeout(() => {
      abortRef.current?.abort()
    }, TIMEOUT_MS)
    try {
      const response = await apiClient.post(url, data, {
        signal: abortRef.current.signal,
        timeout: TIMEOUT_MS,
        ...config,
      } as Record<string, unknown>)
      return response.data
    } catch (err: unknown) {
      const e = err as { code?: string; name?: string; message?: string }
      if (e?.code === 'ERR_CANCELED' || e?.name === 'AbortError' || e?.message?.includes('aborted')) {
        throw new Error(t('aiGenerator.errorTimeout'), { cause: err })
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ── 文件上传生成 ──
  const handleGenerateFromFile = async () => {
    if (!uploadFile) {
      message.warning(t('aiGenerator.selectFileFirst'))
      return
    }
    const values = form.getFieldsValue(['subject', 'grade', 'course_name'])
    if (!values.subject) {
      message.warning(t('aiGenerator.selectSubjectFirst'))
      setLoading(false)
      return
    }
    setErrorMsg('')
    setLoading(true)
    setStep(1)
    startProgress()
    try {
      const formData = new FormData()
      formData.append('file', uploadFile)
      formData.append('subject', values.subject)
      formData.append('grade', values.grade || '')
      formData.append('course_name', values.course_name || '')
      formData.append('auto_save', 'false')
      const data = await callApi('/api/curriculum/ai-generate-from-file', formData)
      stopProgress(true)
      setResult(data)
      setTreeData(buildPreviewTree(data))
      setStep(2)
    } catch (err: unknown) {
      handleError(err, t('aiGenerator.errorFileGen'))
    } finally {
      setLoading(false)
      clearTimers()
    }
  }

  // ── 保存到数据库 ──
  const handleSave = async () => {
    if (!result) return
    const values = form.getFieldsValue(['subject', 'grade', 'course_name'])
    setLoading(true)
    setErrorMsg('')
    try {
      const formData = new FormData()
      formData.append('file', uploadFile!)
      formData.append('subject', values.subject || subjects[0] || '')
      formData.append('grade', values.grade || '')
      formData.append('course_name', values.course_name || '')
      formData.append('auto_save', 'true')
      const data = await callApi('/api/curriculum/ai-generate-from-file', formData)
      setResult(data)
      setSaveDone(true)
      message.success(t('aiGenerator.saveSuccess', { name: result.course_name, chapters: result.saved?.chapters || 0, kps: result.saved?.knowledge_points || 0 }))
      onSuccess?.()
    } catch (err: unknown) {
      handleError(err, t('aiGenerator.errorSaveFailed'))
    } finally {
      setLoading(false)
    }
  }

  // ── 构建预览树 ──
  const buildPreviewTree = (data: AiResult): TreeNode[] => {
    const chapters = data.chapters || []
    return chapters.map((ch: Chapter, idx: number) => {
      const chNode: TreeNode = {
        title: (
          <Space size={4}>
            <BookOutlined />
            <Typography.Text strong>{ch.name}</Typography.Text>
          </Space>
        ),
        key: `ch_${idx}`,
        children: [],
      }
      const children = ch.children || []
      children.forEach((sec: Section, secIdx: number) => {
        const secNode: TreeNode = {
          title: (
            <Space size={4}>
              <FileTextOutlined />
              <Typography.Text>{sec.name}</Typography.Text>
            </Space>
          ),
          key: `ch_${idx}_sec_${secIdx}`,
          children: (sec.knowledge_points || []).map((kp: KnowledgePoint, kpIdx: number) => ({
            title: (
              <Space size={4}>
                <NodeIndexOutlined style={{ fontSize: 12 }} />
                <Typography.Text>{kp.name}</Typography.Text>
                <Tag color={kp.difficulty === 'easy' ? 'green' : kp.difficulty === 'hard' ? 'red' : 'gold'} style={{ fontSize: 11 }}>
                  {kp.difficulty === 'easy' ? t('easy') : kp.difficulty === 'hard' ? t('hard') : t('medium')}
                </Tag>
                {kp.estimated_minutes && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('aiGenerator.minutes', { minutes: kp.estimated_minutes })}</Typography.Text>
                )}
              </Space>
            ),
            key: `ch_${idx}_sec_${secIdx}_kp_${kpIdx}`,
            isLeaf: true,
          })),
        }
        if (!secNode.children?.length) secNode.isLeaf = true
        chNode.children!.push(secNode)
      })
      const topKps = ch.knowledge_points || []
      topKps.forEach((kp: KnowledgePoint, kpIdx: number) => {
        chNode.children!.push({
          title: (
            <Space size={4}>
              <NodeIndexOutlined style={{ fontSize: 12 }} />
              <Typography.Text>{kp.name}</Typography.Text>
              <Tag color={kp.difficulty === 'easy' ? 'green' : kp.difficulty === 'hard' ? 'red' : 'gold'} style={{ fontSize: 11 }}>
                {kp.difficulty === 'easy' ? t('easy') : kp.difficulty === 'hard' ? t('hard') : t('medium')}
              </Tag>
              {kp.estimated_minutes && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('aiGenerator.minutes', { minutes: kp.estimated_minutes })}</Typography.Text>
              )}
            </Space>
          ),
          key: `ch_${idx}_kp_${kpIdx}`,
          isLeaf: true,
        })
      })
      if (!chNode.children?.length) chNode.isLeaf = true
      return chNode
    })
  }

  // ── 关闭后重置 ──
  const handleClose = () => {
    if (!saveDone && result && !loading) {
      Modal.confirm({
        title: t('aiGenerator.confirmCloseTitle'),
        content: t('aiGenerator.confirmCloseContent'),
        okText: t('aiGenerator.confirmCloseOk'),
        cancelText: t('aiGenerator.confirmCloseCancel'),
        onOk: () => {
          clearTimers(); abortRef.current?.abort()
          setStep(0); setResult(null); setTreeData([]); setSaveDone(false)
          setUploadFile(null); setErrorMsg(''); form.resetFields(); onClose()
        },
      })
    } else {
      clearTimers(); abortRef.current?.abort()
      setStep(0); setResult(null); setTreeData([]); setSaveDone(false)
      setUploadFile(null); setErrorMsg(''); form.resetFields(); onClose()
    }
  }

  // ── 组件卸载时清理 ──
  useEffect(() => {
    return () => { clearTimers(); abortRef.current?.abort() }
  }, [])

  // ── 重试 ──
  const handleRetry = () => {
    setStep(0); setErrorMsg('')
  }

  const chapterCount = result?.chapters?.length || 0
  const kpCount = treeData.reduce((sum: number, ch: TreeNode) => {
    return sum + (ch.children || []).reduce((s2: number, c: TreeNode) => {
      return s2 + (c.children?.length || 0) + (c.isLeaf && c.key?.includes('_kp_') ? 1 : 0)
    }, 0)
  }, 0)

  return (
    <Modal
      title={
        <Space>
          <RobotOutlined style={{ color: '#1677ff' }} />
          <span>{t('aiGenerator.title')}</span>
        </Space>
      }
      open={open}
      onCancel={handleClose}
      width={780}
      footer={null}
      destroyOnHidden
    >
      <Steps
        current={step >= 2 ? 2 : step}
        size="small"
        style={{ marginBottom: 24 }}
        items={[
          { title: t('aiGenerator.stepInput'), icon: step === 3 ? <CloseCircleOutlined /> : <FileTextOutlined /> },
          { title: t('aiGenerator.stepGenerating'), icon: step === 1 ? <LoadingOutlined /> : <RobotOutlined /> },
          { title: t('aiGenerator.stepPreview'), icon: step === 2 ? <CheckCircleOutlined /> : <CheckCircleOutlined /> },
        ]}
      />

      {/* ── 步骤 0：输入 ── */}
      {step === 0 && (
        <Form form={form} layout="vertical" initialValues={{ subject: '', grade: '' }}>
          <Form.Item label={t('aiGenerator.uploadLabel')} required>
            <Dragger
              accept=".txt,.md,.pdf,.docx"
              maxCount={1}
              beforeUpload={(file) => {
                const valid = ['.txt', '.md', '.pdf', '.docx'].some(ext =>
                  file.name.toLowerCase().endsWith(ext)
                )
                if (!valid) { message.error(t('aiGenerator.uploadInvalidFormat')); return Upload.LIST_IGNORE }
                if (file.size > 20 * 1024 * 1024) { message.error(t('aiGenerator.uploadTooLarge')); return Upload.LIST_IGNORE }
                setUploadFile(file)
                return false
              }}
              onRemove={() => setUploadFile(null)}
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">{t('aiGenerator.uploadDragText')}</p>
              <p className="ant-upload-hint">{t('aiGenerator.uploadHint')}</p>
            </Dragger>
          </Form.Item>

          <Space style={{ width: '100%' }} align="start" wrap>
            <Form.Item name="subject" label={t('aiGenerator.subjectLabel')} style={{ width: 160 }} rules={[{ required: true, message: t('aiGenerator.subjectRequired') }]}>
              <Select placeholder={t('aiGenerator.subjectPlaceholder')}>
                {subjects.length > 0 ? subjects.map(s => <Option key={s} value={s}>{s}</Option>) : (
                  <Option value="" disabled>{t('aiGenerator.noSubjectConfig')}</Option>
                )}
              </Select>
            </Form.Item>
            <Form.Item name="grade" label={t('aiGenerator.gradeLabel')} style={{ width: 160 }}>
              <Select placeholder={t('aiGenerator.gradePlaceholder')} allowClear>
                {gradeOptions.map(g => <Option key={g} value={g}>{g}</Option>)}
              </Select>
            </Form.Item>
            <Form.Item name="course_name" label={t('aiGenerator.courseNameLabel')} style={{ width: 280 }}>
              <Input placeholder={t('aiGenerator.courseNamePlaceholder')} />
            </Form.Item>
          </Space>

          <Alert
            message={t('aiGenerator.alertHint')}
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />

          <Button
            type="primary"
            icon={<RobotOutlined />}
            onClick={handleGenerateFromFile}
            block
            size="large"
          >
            {uploadFile ? t('aiGenerator.uploadAndGenerateWithFile', { name: uploadFile.name }) : t('aiGenerator.uploadAndGenerate')}
          </Button>
        </Form>
      )}

      {/* ── 步骤 1：生成中 + 动态进度 ── */}
      {step === 1 && (
        <div style={{ padding: '24px 0' }}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <Spin indicator={<LoadingOutlined style={{ fontSize: 36 }} />} />
            <Typography.Title level={5} style={{ marginTop: 16, marginBottom: 4 }}>
              {t('aiGenerator.generatingTitle')}
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {progressText || t('aiGenerator.generatingText')}
            </Typography.Text>
          </div>
          <Progress
            percent={progressPercent}
            status="active"
            strokeColor={{
              from: '#108ee9',
              to: '#87d068',
            }}
            style={{ padding: '0 16px' }}
          />
          <Typography.Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 8, fontSize: 12 }}>
            {t('aiGenerator.estimatedTime')}
          </Typography.Text>
        </div>
      )}

      {/* ── 步骤 2：预览 ── */}
      {step === 2 && result && (
        <div>
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, padding: '12px 16px', marginBottom: 16, background: '#f6ffed' }}>
            <Space>
              <BookOutlined style={{ fontSize: 20, color: '#52c41a' }} />
              <div>
                <Typography.Title level={5} style={{ margin: 0 }}>{result.course_name}</Typography.Title>
                <Typography.Text type="secondary">
                  {result.course_code && `[${result.course_code}] `}
                  {result.course_description}
                  {result.source_file && t('aiGenerator.sourceFrom', { file: result.source_file })}
                </Typography.Text>
              </div>
            </Space>
          </div>

          <Space style={{ marginBottom: 12 }}>
            <Tag icon={<BookOutlined />} color="blue">{t('aiGenerator.chapterCount', { count: chapterCount })}</Tag>
            <Tag icon={<NodeIndexOutlined />} color="geekblue">{t('aiGenerator.kpCount', { count: kpCount })}</Tag>
          </Space>

          <Divider style={{ margin: '8px 0' }} />
          <Typography.Text strong>{t('aiGenerator.previewTitle')}</Typography.Text>
          <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 8 }}>
            <Tree
              treeData={treeData}
              defaultExpandAll
              showLine={{ showLeafIcon: false }}
              style={{ background: 'transparent' }}
            />
          </div>

          <Divider />
          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={() => { setStep(0); setResult(null); setTreeData([]); setUploadFile(null) }}>
              {t('aiGenerator.backToEdit')}
            </Button>
            {saveDone ? (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleClose}>{t('aiGenerator.done')}</Button>
            ) : (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleSave} loading={loading}>{t('aiGenerator.saveCourse')}</Button>
            )}
          </Space>
        </div>
      )}

      {/* ── 步骤 3：错误 ── */}
      {step === 3 && (
        <div style={{ padding: '16px 0' }}>
          <Alert
            message={t('aiGenerator.errorTitle')}
            description={
              <div>
                <Typography.Paragraph style={{ marginBottom: 8 }}>{errorMsg}</Typography.Paragraph>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('aiGenerator.possibleReasons')}
                </Typography.Text>
                <ul style={{ fontSize: 12, color: '#888', marginTop: 4, paddingLeft: 20 }}>
                  <li>{t('aiGenerator.reasonApiKey')}</li>
                  <li>{t('aiGenerator.reasonContent')}</li>
                  <li>{t('aiGenerator.reasonTimeout')}</li>
                  <li>{t('aiGenerator.reasonNetwork')}</li>
                </ul>
              </div>
            }
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Space style={{ width: '100%', justifyContent: 'center' }}>
            <Button onClick={handleRetry}>{t('aiGenerator.backToEdit')}</Button>
            <Button type="primary" icon={<RobotOutlined />} onClick={handleGenerateFromFile} loading={loading}>
              {t('aiGenerator.retry')}
            </Button>
          </Space>
        </div>
      )}
    </Modal>
  )
}

export default AICurriculumGenerator
