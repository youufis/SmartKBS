import React, { useState } from 'react'
import {
  Modal, Form, Input, Select, Button, message, Steps, Tree, Space, Tag,
  Typography, Spin, Alert, Divider, Checkbox,
} from 'antd'
import {
  RobotOutlined, UploadOutlined, FileTextOutlined, CheckCircleOutlined,
  BookOutlined, NodeIndexOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'

const { TextArea } = Input
const { Option } = Select

interface Props {
  open: boolean
  onClose: () => void
  onSuccess?: () => void
}

const AICurriculumGenerator: React.FC<Props> = ({ open, onClose, onSuccess }) => {
  const [step, setStep] = useState(0) // 0=输入, 1=预览, 2=完成
  const [loading, setLoading] = useState(false)
  const [form] = Form.useForm()
  const [result, setResult] = useState<any>(null)
  const [treeData, setTreeData] = useState<any[]>([])
  const [saveDone, setSaveDone] = useState(false)

  // ── 生成课程 ──
  const handleGenerate = async () => {
    try {
      const values = await form.validateFields()
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

      // 构建预览树
      const tree = buildPreviewTree(data)
      setTreeData(tree)
      setStep(2)
    } catch (err: any) {
      const detail = err?.response?.data?.detail
      if (detail) {
        message.error(detail)
      }
      setStep(0)
    } finally {
      setLoading(false)
    }
  }

  // ── 保存到数据库 ──
  const handleSave = async () => {
    if (!result) return
    setLoading(true)
    try {
      // 调用保存 API：用相同内容但 auto_save=true
      const values = await form.validateFields()
      const { data } = await apiClient.post('/api/curriculum/ai-generate', {
        content: values.content,
        subject: values.subject,
        grade: values.grade,
        course_name: values.course_name || '',
        auto_save: true,
      })
      setResult(data)
      setSaveDone(true)
      message.success(`课程「${data.course_name}」已成功创建！共 ${data.saved?.chapters || 0} 章、${data.saved?.knowledge_points || 0} 个知识点`)
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

      // 子章节
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

      // 顶层知识点
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
          setStep(0)
          setResult(null)
          setTreeData([])
          setSaveDone(false)
          form.resetFields()
          onClose()
        },
      })
    } else {
      setStep(0)
      setResult(null)
      setTreeData([])
      setSaveDone(false)
      form.resetFields()
      onClose()
    }
  }

  const chapterCount = result?.chapters?.length || 0
  const kpCount = treeData.reduce((sum: number, ch: any) => {
    return sum + (ch.children || []).reduce((s2: number, c: any) => {
      return s2 + (c.children?.length || 0) + (c.isLeaf ? (c.key?.includes('_kp_') ? 1 : 0) : 0)
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
      {/* ── 步骤条 ── */}
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
          <Form.Item name="content" label="教学内容文本" rules={[{ required: true, message: '请输入教学内容' }]}>
            <TextArea
              rows={12}
              placeholder={`请粘贴教材原文、教学大纲、课程目录等内容...\n\n例如：\n第一章 走进技术世界\n1.1 技术与人\n  技术的产生与发展\n  技术对人的影响\n1.2 技术的性质\n  技术的实践性\n  技术的创新性\n  技术的综合性\n...`}
            />
          </Form.Item>

          <Space style={{ width: '100%' }} align="start">
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
            message="提示：AI 会根据文本内容自动提取章、节、知识点结构。文本越长越详细，生成效果越好。支持教材章节、教学大纲、教案等文本。"
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />

          <Button type="primary" icon={<RobotOutlined />} onClick={handleGenerate} block size="large">
            开始生成
          </Button>
        </Form>
      )}

      {/* ── 步骤 1：生成中 ── */}
      {step === 1 && (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spin size="large" tip="AI 正在分析教学内容，提取课程结构..." />
        </div>
      )}

      {/* ── 步骤 2：预览 ── */}
      {step === 2 && result && (
        <div>
          {/* 课程信息 */}
          <Card
            size="small"
            style={{ marginBottom: 16, background: '#f6ffed' }}
          >
            <Space>
              <BookOutlined style={{ fontSize: 20, color: '#52c41a' }} />
              <div>
                <Typography.Title level={5} style={{ margin: 0 }}>{result.course_name}</Typography.Title>
                <Typography.Text type="secondary">
                  {result.course_code && `[${result.course_code}] `}
                  {result.course_description}
                </Typography.Text>
              </div>
            </Space>
          </Card>

          {/* 统计 */}
          <Space style={{ marginBottom: 12 }}>
            <Tag icon={<BookOutlined />} color="blue">{chapterCount} 章</Tag>
            <Tag icon={<NodeIndexOutlined />} color="geekblue">{kpCount} 个知识点</Tag>
          </Space>

          {/* 树预览 */}
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

          {/* 操作按钮 */}
          <Divider />
          <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
            <Button onClick={() => { setStep(0); setResult(null); setTreeData([]) }}>
              返回修改
            </Button>
            {saveDone ? (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleClose}>
                完成
              </Button>
            ) : (
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleSave} loading={loading}>
                保存课程
              </Button>
            )}
          </Space>
        </div>
      )}
    </Modal>
  )
}

// 内联 Card 组件
const Card: React.FC<{ size?: 'small' | 'default'; style?: React.CSSProperties; children: React.ReactNode }> = ({ children, style }) => (
  <div style={{
    border: '1px solid #f0f0f0',
    borderRadius: 8,
    padding: '12px 16px',
    ...style,
  }}>
    {children}
  </div>
)

export default AICurriculumGenerator
