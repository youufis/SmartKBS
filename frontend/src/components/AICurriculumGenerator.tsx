import React, { useState, useRef, useEffect } from 'react'
import {
  Modal, Form, Input, Select, Button, message, Steps, Tree, Space, Tag,
  Typography, Spin, Alert, Divider, Upload, Tabs, Progress,
} from 'antd'
import {
  RobotOutlined, FileTextOutlined, CheckCircleOutlined,
  BookOutlined, NodeIndexOutlined, UploadOutlined, InboxOutlined,
  CloseCircleOutlined, LoadingOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'

const { TextArea } = Input
const { Option } = Select
const { Dragger } = Upload

// ── 进度阶段定义 ──
const PROGRESS_STAGES = [
  { key: 'sending', label: '发送请求...', duration: 3000 },
  { key: 'analyzing', label: 'AI 正在分析内容...', duration: 5000 },
  { key: 'extracting', label: '提取章节结构...', duration: 5000 },
  { key: 'building', label: '构建知识点树...', duration: 4000 },
  { key: 'parsing', label: '解析生成结果...', duration: 2000 },
]

const TIMEOUT_MS = 120_000 // 120 秒超时

interface Props {
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

const AICurriculumGenerator: React.FC<Props> = ({ open, onClose, onSuccess }) => {
  const [step, setStep] = useState(0) // 0=输入, 1=生成中, 2=预览, 3=错误
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const [result, setResult] = useState<any>(null)
  const [treeData, setTreeData] = useState<any[]>([])
  const [saveDone, setSaveDone] = useState(false)
  const [inputMode, setInputMode] = useState<'text' | 'file'>('text')
  const [uploadFile, setUploadFile] = useState<File | null>(null)

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
    setProgressText('正在准备请求...')
    const stageDurations = PROGRESS_STAGES
    const totalDuration = stageDurations.reduce((s, st) => s + st.duration, 0)
    let elapsed = 0
    const stepMs = 300
    timerRef.current = setInterval(() => {
      elapsed += stepMs
      const pct = Math.min(85, Math.round((elapsed / totalDuration) * 85))
      setProgressPercent(pct)
      // 根据进度显示对应的阶段文字
      let accDuration = 0
      let currentLabel = 'AI 处理中...'
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
    setProgressText(success ? '生成完成' : '生成失败')
  }

  // ── 通用错误处理 ──
  const handleError = (err: any, customMsg?: string) => {
    stopProgress(false)
    setLoading(false)
    let detail = customMsg || ''
    if (err?.response?.data?.detail) {
      detail = err.response.data.detail
    } else if (err?.message) {
      detail = err.message
    } else if (typeof err === 'string') {
      detail = err
    }
    if (!detail) detail = 'AI 生成失败，请检查 API Key 配置或稍后重试'
    setErrorMsg(detail)
    setStep(3) // 错误步骤
  }

  // ── 调用 API 封装（带超时和取消） ──
  const callApi = async (url: string, data: any, config?: any) => {
    abortRef.current = new AbortController()
    const timeoutId = setTimeout(() => {
      abortRef.current?.abort()
    }, TIMEOUT_MS)
    try {
      const response = await apiClient.post(url, data, {
        signal: abortRef.current.signal,
        timeout: TIMEOUT_MS,
        ...config,
      })
      return response.data
    } catch (err: any) {
      if (err?.code === 'ERR_CANCELED' || err?.name === 'AbortError' || err?.message?.includes('aborted')) {
        throw new Error('请求超时，AI 响应时间过长，请稍后重试或缩短输入内容')
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
    }
  }

  // ── 文字输入生成 ──
  const handleGenerateFromText = async () => {
    try {
      const values = await form.validateFields(['content', 'subject', 'grade', 'course_name'])
      setErrorMsg('')
      setLoading(true)
      setStep(1)
      startProgress()
      const data = await callApi('/api/curriculum/ai-generate', {
        content: values.content,
        subject: values.subject,
        grade: values.grade,
        course_name: values.course_name || '',
        auto_save: false,
      })
      stopProgress(true)
      setResult(data)
      setTreeData(buildPreviewTree(data))
      setStep(2)
    } catch (err: any) {
      handleError(err, '文字生成失败')
    } finally {
      setLoading(false)
      clearTimers()
    }
  }

  // ── 文件上传生成 ──
  const handleGenerateFromFile = async () => {
    if (!uploadFile) {
      message.warning('请先选择文件')
      return
    }
    const values = form.getFieldsValue(['subject', 'grade', 'course_name'])
    setErrorMsg('')
    setLoading(true)
    setStep(1)
    startProgress()
    try {
      const formData = new FormData()
      formData.append('file', uploadFile)
      formData.append('subject', values.subject || '信息技术')
      formData.append('grade', values.grade || '高一')
      formData.append('course_name', values.course_name || '')
      formData.append('auto_save', 'false')
      const data = await callApi('/api/curriculum/ai-generate-from-file', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      stopProgress(true)
      setResult(data)
      setTreeData(buildPreviewTree(data))
      setStep(2)
    } catch (err: any) {
      handleError(err, '文件生成失败')
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
      if (inputMode === 'text') {
        const data = await callApi('/api/curriculum/ai-generate', {
          content: values.content,
          subject: values.subject,
          grade: values.grade,
          course_name: values.course_name || '',
          auto_save: true,
        })
        setResult(data)
      } else {
        const formData = new FormData()
        formData.append('file', uploadFile!)
        formData.append('subject', values.subject || '信息技术')
        formData.append('grade', values.grade || '高一')
        formData.append('course_name', values.course_name || '')
        formData.append('auto_save', 'true')
        const data = await callApi('/api/curriculum/ai-generate-from-file', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        setResult(data)
      }
      setSaveDone(true)
      message.success(`课程「${result.course_name}」已成功创建！共 ${result.saved?.chapters || 0} 章、${result.saved?.knowledge_points || 0} 个知识点`)
      onSuccess?.()
    } catch (err: any) {
      handleError(err, '保存失败')
    } finally {
      setLoading(false)
    }
  }

  // ── 构建预览树 ──
  const buildPreviewTree = (data: any): any[] => {
    const chapters = data.chapters || []
    return chapters.map((ch: any, idx: number) => {
      const chNode: any = {
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
      children.forEach((sec: any, secIdx: number) => {
        const secNode: any = {
          title: (
            <Space size={4}>
              <FileTextOutlined />
              <Typography.Text>{sec.name}</Typography.Text>
            </Space>
          ),
          key: `ch_${idx}_sec_${secIdx}`,
          children: (sec.knowledge_points || []).map((kp: any, kpIdx: number) => ({
            title: (
              <Space size={4}>
                <NodeIndexOutlined style={{ fontSize: 12 }} />
                <Typography.Text>{kp.name}</Typography.Text>
                <Tag color={kp.difficulty === 'easy' ? 'green' : kp.difficulty === 'hard' ? 'red' : 'gold'} style={{ fontSize: 11 }}>
                  {kp.difficulty === 'easy' ? '简单' : kp.difficulty === 'hard' ? '困难' : '中等'}
                </Tag>
                {kp.estimated_minutes && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{kp.estimated_minutes}分钟</Typography.Text>
                )}
              </Space>
            ),
            key: `ch_${idx}_sec_${secIdx}_kp_${kpIdx}`,
            isLeaf: true,
          })),
        }
        if (!secNode.children?.length) secNode.isLeaf = true
        chNode.children.push(secNode)
      })
      const topKps = ch.knowledge_points || []
      topKps.forEach((kp: any, kpIdx: number) => {
        chNode.children.push({
          title: (
            <Space size={4}>
              <NodeIndexOutlined style={{ fontSize: 12 }} />
              <Typography.Text>{kp.name}</Typography.Text>
              <Tag color={kp.difficulty === 'easy' ? 'green' : kp.difficulty === 'hard' ? 'red' : 'gold'} style={{ fontSize: 11 }}>
                {kp.difficulty === 'easy' ? '简单' : kp.difficulty === 'hard' ? '困难' : '中等'}
              </Tag>
              {kp.estimated_minutes && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{kp.estimated_minutes}分钟</Typography.Text>
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
        title: '确认关闭？',
        content: '生成的课程尚未保存，关闭后将丢失。',
        okText: '确认关闭',
        cancelText: '继续编辑',
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
  const kpCount = treeData.reduce((sum: number, ch: any) => {
    return sum + (ch.children || []).reduce((s2: number, c: any) => {
      return s2 + (c.children?.length || 0) + (c.isLeaf && c.key?.includes('_kp_') ? 1 : 0)
    }, 0)
  }, 0)

  return (
    <Modal
      title={
        <Space>
          <RobotOutlined style={{ color: '#1677ff' }} />
          <span>AI 智能生成课程大纲</span>
        </Space>
      }
      open={open}
      onCancel={handleClose}
      width={780}
      footer={null}
      destroyOnClose
    >
      <Steps
        current={step >= 2 ? 2 : step}
        size="small"
        style={{ marginBottom: 24 }}
        items={[
          { title: '输入内容', icon: step === 3 ? <CloseCircleOutlined /> : <FileTextOutlined /> },
          { title: 'AI 生成中...', icon: step === 1 ? <LoadingOutlined /> : <RobotOutlined /> },
          { title: '预览与保存', icon: step === 2 ? <CheckCircleOutlined /> : <CheckCircleOutlined /> },
        ]}
      />

      {/* ── 步骤 0：输入 ── */}
      {step === 0 && (
        <Form form={form} layout="vertical" initialValues={{ subject: '信息技术', grade: '高一' }}>
          <Tabs
            activeKey={inputMode}
            onChange={(k) => setInputMode(k as 'text' | 'file')}
            items={[
              {
                key: 'text',
                label: <span><FileTextOutlined /> 粘贴文本</span>,
                children: (
                  <Form.Item name="content" label="教学内容文本" rules={[{ required: true, message: '请输入教学内容' }]}>
                    <TextArea rows={12} placeholder="请粘贴教材原文、教学大纲、课程目录等内容..." />
                  </Form.Item>
                ),
              },
              {
                key: 'file',
                label: <span><UploadOutlined /> 上传文件</span>,
                children: (
                  <Form.Item label="上传文档（txt/md/pdf/docx）" required>
                    <Dragger
                      accept=".txt,.md,.pdf,.docx"
                      maxCount={1}
                      beforeUpload={(file) => {
                        const valid = ['.txt', '.md', '.pdf', '.docx'].some(ext =>
                          file.name.toLowerCase().endsWith(ext)
                        )
                        if (!valid) { message.error('仅支持 txt/md/pdf/docx 格式'); return Upload.LIST_IGNORE }
                        if (file.size > 20 * 1024 * 1024) { message.error('文件大小不能超过 20MB'); return Upload.LIST_IGNORE }
                        setUploadFile(file)
                        return false
                      }}
                      onRemove={() => setUploadFile(null)}
                    >
                      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                      <p className="ant-upload-text">点击或拖拽文件到此区域上传</p>
                      <p className="ant-upload-hint">支持 txt、md、pdf、docx 格式，最大 20MB</p>
                    </Dragger>
                  </Form.Item>
                ),
              },
            ]}
          />

          <Space style={{ width: '100%' }} align="start" wrap>
            <Form.Item name="subject" label="科目" style={{ width: 160 }}>
              <Select>
                <Option value="信息技术">信息技术</Option>
                <Option value="通用技术">通用技术</Option>
              </Select>
            </Form.Item>
            <Form.Item name="grade" label="年级" style={{ width: 160 }}>
              <Select>
                <Option value="高一">高一</Option>
                <Option value="高二">高二</Option>
              </Select>
            </Form.Item>
            <Form.Item name="course_name" label="课程名称（留空由 AI 推断）" style={{ width: 280 }}>
              <Input placeholder="例如：信息技术必修1" />
            </Form.Item>
          </Space>

          <Alert
            message="提示：AI 会根据内容自动提取章、节、知识点结构。生成过程约需 30-60 秒，请耐心等待。"
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />

          <Button
            type="primary"
            icon={<RobotOutlined />}
            onClick={inputMode === 'text' ? handleGenerateFromText : handleGenerateFromFile}
            block
            size="large"
          >
            {inputMode === 'text' ? '开始生成课程大纲' : `上传并生成${uploadFile ? `（${uploadFile.name}）` : ''}`}
          </Button>
        </Form>
      )}

      {/* ── 步骤 1：生成中 + 动态进度 ── */}
      {step === 1 && (
        <div style={{ padding: '24px 0' }}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <Spin indicator={<LoadingOutlined style={{ fontSize: 36 }} />} />
            <Typography.Title level={5} style={{ marginTop: 16, marginBottom: 4 }}>
              AI 正在生成课程大纲
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {progressText || '处理中...'}
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
            预计 30-60 秒，请勿关闭弹窗
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
                  {result.source_file && `（来源：${result.source_file}）`}
                </Typography.Text>
              </div>
            </Space>
          </div>

          <Space style={{ marginBottom: 12 }}>
            <Tag icon={<BookOutlined />} color="blue">{chapterCount} 章</Tag>
            <Tag icon={<NodeIndexOutlined />} color="geekblue">{kpCount} 个知识点</Tag>
          </Space>

          <Divider style={{ margin: '8px 0' }} />
          <Typography.Text strong>生成的结构预览：</Typography.Text>
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
              返回修改
            </Button>
            {saveDone ? (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleClose}>完成</Button>
            ) : (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleSave} loading={loading}>保存课程</Button>
            )}
          </Space>
        </div>
      )}

      {/* ── 步骤 3：错误 ── */}
      {step === 3 && (
        <div style={{ padding: '16px 0' }}>
          <Alert
            message="生成失败"
            description={
              <div>
                <Typography.Paragraph style={{ marginBottom: 8 }}>{errorMsg}</Typography.Paragraph>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  可能的原因：
                </Typography.Text>
                <ul style={{ fontSize: 12, color: '#888', marginTop: 4, paddingLeft: 20 }}>
                  <li>API Key 未配置或已失效 — 请在系统配置中检查 API Key</li>
                  <li>输入内容过少或格式不规范 — 建议提供完整的教材章节文本</li>
                  <li>AI 服务超时 — 请稍后重试，或缩短输入内容</li>
                  <li>网络连接异常 — 请检查服务器网络</li>
                </ul>
              </div>
            }
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
          />
          <Space style={{ width: '100%', justifyContent: 'center' }}>
            <Button onClick={handleRetry}>返回修改</Button>
            <Button type="primary" icon={<RobotOutlined />} onClick={inputMode === 'text' ? handleGenerateFromText : handleGenerateFromFile} loading={loading}>
              重新生成
            </Button>
          </Space>
        </div>
      )}
    </Modal>
  )
}

export default AICurriculumGenerator
