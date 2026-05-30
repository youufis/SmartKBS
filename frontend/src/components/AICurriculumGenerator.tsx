import React, { useState } from 'react'
import {
  Modal, Form, Input, Select, Button, message, Steps, Tree, Space, Tag,
  Typography, Spin, Alert, Divider, Upload, Tabs,
} from 'antd'
import {
  RobotOutlined, FileTextOutlined, CheckCircleOutlined,
  BookOutlined, NodeIndexOutlined, UploadOutlined, InboxOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'

const { TextArea } = Input
const { Option } = Select
const { Dragger } = Upload

interface Props {
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

const AICurriculumGenerator: React.FC<Props> = ({ open, onClose, onSuccess }) => {
  const [step, setStep] = useState(0) // 0=输入, 1=AI生成中, 2=预览
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const [result, setResult] = useState<any>(null)
  const [treeData, setTreeData] = useState<any[]>([])
  const [saveDone, setSaveDone] = useState(false)
  const [inputMode, setInputMode] = useState<'text' | 'file'>('text')
  const [uploadFile, setUploadFile] = useState<File | null>(null)

  // ── 文字输入生成 ──
  const handleGenerateFromText = async () => {
    try {
      const values = await form.validateFields(['content', 'subject', 'grade', 'course_name'])
      setLoading(true)
      setStep(1)
      const { data } = await apiClient.post('/api/curriculum/ai-generate', {
        content: values.content,
        subject: values.subject,
        grade: values.grade,
        course_name: values.course_name || '',
        auto_save: false,
      })
      setResult(data)
      setTreeData(buildPreviewTree(data))
      setStep(2)
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      if (detail) message.error(detail)
      setStep(0)
    } finally {
      setLoading(false)
    }
  }

  // ── 文件上传生成 ──
  const handleGenerateFromFile = async () => {
    if (!uploadFile) {
      message.warning('请先选择文件')
      return
    }
    const values = form.getFieldsValue(['subject', 'grade', 'course_name'])
    setLoading(true)
    setStep(1)
    try {
      const formData = new FormData()
      formData.append('file', uploadFile)
      formData.append('subject', values.subject || '信息技术')
      formData.append('grade', values.grade || '高一')
      formData.append('course_name', values.course_name || '')
      formData.append('auto_save', 'false')
      const { data } = await apiClient.post('/api/curriculum/ai-generate-from-file', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setResult(data)
      setTreeData(buildPreviewTree(data))
      setStep(2)
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      message.error(detail || 'AI 生成失败')
      setStep(0)
    } finally {
      setLoading(false)
    }
  }

  // ── 保存到数据库 ──
  const handleSave = async () => {
    if (!result) return
    const values = form.getFieldsValue(['subject', 'grade', 'course_name'])
    setLoading(true)
    try {
      if (inputMode === 'text') {
        const { data } = await apiClient.post('/api/curriculum/ai-generate', {
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
        const { data } = await apiClient.post('/api/curriculum/ai-generate-from-file', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        setResult(data)
      }
      setSaveDone(true)
      message.success(`课程「${result.course_name}」已成功创建！共 ${result.saved?.chapters || 0} 章、${result.saved?.knowledge_points || 0} 个知识点`)
      onSuccess?.()
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      message.error(detail || '保存失败')
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
          setStep(0); setResult(null); setTreeData([]); setSaveDone(false)
          setUploadFile(null); form.resetFields(); onClose()
        },
      })
    } else {
      setStep(0); setResult(null); setTreeData([]); setSaveDone(false)
      setUploadFile(null); form.resetFields(); onClose()
    }
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
        current={step}
        size="small"
        style={{ marginBottom: 24 }}
        items={[
          { title: '输入内容', icon: <FileTextOutlined /> },
          { title: 'AI 生成中...', icon: <RobotOutlined /> },
          { title: '预览与保存', icon: <CheckCircleOutlined /> },
        ]}
      />

      {/* ── 步骤 0：输入 ── */}
      {step === 0 && (
        <Form form={form} layout="vertical" initialValues={{ subject: '信息技术', grade: '高一' }}>
          <Tabs activeKey={inputMode} onChange={(k) => setInputMode(k as 'text' | 'file')}>
            <Tabs.TabPane tab={<span><FileTextOutlined /> 粘贴文本</span>} key="text">
              <Form.Item name="content" label="教学内容文本" rules={[{ required: true, message: '请输入教学内容' }]}>
                <TextArea
                  rows={12}
                  placeholder={`请粘贴教材原文、教学大纲、课程目录等内容...`}
                />
              </Form.Item>
            </Tabs.TabPane>
            <Tabs.TabPane tab={<span><UploadOutlined /> 上传文件</span>} key="file">
              <Form.Item label="上传文档（txt/md/pdf/docx）" required>
                <Dragger
                  accept=".txt,.md,.pdf,.docx"
                  maxCount={1}
                  beforeUpload={(file) => {
                    const valid = ['.txt', '.md', '.pdf', '.docx'].some(ext =>
                      file.name.toLowerCase().endsWith(ext)
                    )
                    if (!valid) {
                      message.error('仅支持 txt/md/pdf/docx 格式')
                      return Upload.LIST_IGNORE
                    }
                    if (file.size > 20 * 1024 * 1024) {
                      message.error('文件大小不能超过 20MB')
                      return Upload.LIST_IGNORE
                    }
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
            </Tabs.TabPane>
          </Tabs>

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
            message="AI 会根据内容自动提取章、节、知识点结构。上传文件支持教材原文、教学大纲、教案等。"
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
            {inputMode === 'text' ? '开始生成' : `上传并生成${uploadFile ? `（${uploadFile.name}）` : ''}`}
          </Button>
        </Form>
      )}

      {/* ── 步骤 1：生成中 ── */}
      {step === 1 && (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spin size="large" tip={inputMode === 'file' ? '正在解析文件并生成课程结构...' : 'AI 正在分析教学内容...'} />
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
    </Modal>
  )
}

export default AICurriculumGenerator
