import React, { useState, useEffect } from 'react'
import {
  Modal, Form, Input, Button, Space, Select, Radio, Checkbox,
  Typography, Divider, Tag, message, Empty, Popconfirm,
} from 'antd'
import { PlusOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons'
import ActivityScopeSelector from './ActivityScopeSelector'
import type { ActivityScopeValue } from './ActivityScopeSelector'

const { Text } = Typography
const { TextArea } = Input

interface Question {
  id: string
  type: 'single' | 'multiple' | 'true_false'
  question: string
  options: string[]
  answer: string
  score: number
  explanation: string
}

interface QuizEditorProps {
  open: boolean
  onCancel: () => void
  onSave: (title: string, description: string, questions: Question[], scope?: ActivityScopeValue) => Promise<void>
  initialTitle?: string
  initialDescription?: string
  initialQuestions?: Question[]
}

const generateId = () => Math.random().toString(36).substring(2, 10)

const defaultOptions = {
  single: ['A. 选项A', 'B. 选项B', 'C. 选项C', 'D. 选项D'],
  multiple: ['A. 选项A', 'B. 选项B', 'C. 选项C', 'D. 选项D'],
  true_false: ['对', '错'],
}

const QuizEditor: React.FC<QuizEditorProps> = ({
  open, onCancel, onSave,
  initialTitle = '', initialDescription = '', initialQuestions,
}) => {
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [questions, setQuestions] = useState<Question[]>(initialQuestions || [])
  const [saving, setSaving] = useState(false)
  const [scope, setScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes',
    target_grade: '',
    target_class: '',
    target_users: '',
  })

  useEffect(() => {
    if (open) {
      setTitle(initialTitle)
      setDescription(initialDescription)
      setQuestions(initialQuestions || [])
      setScope({ target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
    }
  }, [open, initialTitle, initialDescription, initialQuestions])

  const addQuestion = (type: 'single' | 'multiple' | 'true_false') => {
    const newQ: Question = {
      id: generateId(),
      type,
      question: '',
      options: [...defaultOptions[type]],
      answer: '',
      score: 1,
      explanation: '',
    }
    setQuestions([...questions, newQ])
  }

  const removeQuestion = (id: string) => {
    setQuestions(questions.filter(q => q.id !== id))
  }

  const moveQuestion = (index: number, direction: 'up' | 'down') => {
    const newQs = [...questions]
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= newQs.length) return
    ;[newQs[index], newQs[target]] = [newQs[target], newQs[index]]
    setQuestions(newQs)
  }

  const updateQuestion = (id: string, field: keyof Question, value: any) => {
    setQuestions(questions.map(q => {
      if (q.id !== id) return q
      const updated = { ...q, [field]: value }
      // 切换题型时重置选项和答案
      if (field === 'type') {
        updated.options = [...defaultOptions[value as 'single' | 'multiple' | 'true_false']]
        updated.answer = ''
      }
      return updated
    }))
  }

  const updateOption = (qId: string, optIndex: number, value: string) => {
    setQuestions(questions.map(q => {
      if (q.id !== qId) return q
      const newOpts = [...q.options]
      newOpts[optIndex] = value
      return { ...q, options: newOpts }
    }))
  }

  const addOption = (qId: string) => {
    setQuestions(questions.map(q => {
      if (q.id !== qId) return q
      const prefix = String.fromCharCode(65 + q.options.length) // A, B, C, ...
      return { ...q, options: [...q.options, `${prefix}. 新选项${q.options.length + 1}`] }
    }))
  }

  const removeOption = (qId: string, optIndex: number) => {
    setQuestions(questions.map(q => {
      if (q.id !== qId) return q
      const newOpts = q.options.filter((_, i) => i !== optIndex)
      return { ...q, options: newOpts, answer: '' }
    }))
  }

  const handleSave = async () => {
    if (!title.trim()) { message.warning('请输入测验标题'); return }
    if (questions.length === 0) { message.warning('请至少添加一道题目'); return }

    // 校验每道题
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      if (!q.question.trim()) {
        message.warning(`第 ${i + 1} 题题目内容不能为空`)
        return
      }
      if (q.type !== 'true_false' && q.options.length < 2) {
        message.warning(`第 ${i + 1} 题至少需要2个选项`)
        return
      }
      if (!q.answer) {
        message.warning(`请设置第 ${i + 1} 题的正确答案`)
        return
      }
      // 验证 multiple 题型的答案格式：逗号分隔的选项字母
      if (q.type === 'multiple') {
        const answerLetters = q.answer.split(',').map(a => a.trim().toUpperCase())
        const validLetters = q.options.map(o => o.charAt(0).toUpperCase())
        for (const letter of answerLetters) {
          if (!validLetters.includes(letter)) {
            message.warning(`第 ${i + 1} 题多选题答案 "${letter}" 不是有效选项`)
            return
          }
        }
      }
      if (q.type === 'single') {
        const letter = q.answer.toUpperCase()
        const validLetters = q.options.map(o => o.charAt(0).toUpperCase())
        if (!validLetters.includes(letter)) {
          message.warning(`第 ${i + 1} 题单选题答案 "${letter}" 不是有效选项`)
          return
        }
      }
    }

    setSaving(true)
    try {
      await onSave(title, description, questions, scope)
    } finally {
      setSaving(false)
    }
  }

  const questionTypeLabel = (type: string) => {
    const map: Record<string, string> = {
      single: '单选题',
      multiple: '多选题',
      true_false: '判断题',
    }
    return map[type] || type
  }

  const questionTypeColor = (type: string) => {
    const map: Record<string, string> = {
      single: 'blue',
      multiple: 'purple',
      true_false: 'orange',
    }
    return map[type] || 'default'
  }

  return (
    <Modal
      title={<Text strong style={{ fontSize: 18 }}>📝 创建随堂测验</Text>}
      open={open}
      onCancel={onCancel}
      footer={[
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="save" type="primary" loading={saving} onClick={handleSave}>
          创建测验 ({questions.length} 题)
        </Button>,
      ]}
      width={800}
      style={{ top: 20 }}
    >
      {/* 基本信息 */}
      <div style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label="测验标题" required>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="例如：第3章 随堂小测"
            />
          </Form.Item>
          <Form.Item label="描述（可选）">
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="测验说明..."
            />
          </Form.Item>
        </Form>
      </div>

      {/* 目标范围 */}
      <div style={{ marginBottom: 16 }}>
        <ActivityScopeSelector value={scope} onChange={setScope} />
      </div>

      <Divider />

      {/* 添加题目按钮 */}
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ fontSize: 15 }}>题目列表</Text>
        <div style={{ marginTop: 8 }}>
          <Space>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => addQuestion('single')}>
              添加单选题
            </Button>
            <Button icon={<PlusOutlined />} onClick={() => addQuestion('multiple')}>
              添加多选题
            </Button>
            <Button icon={<PlusOutlined />} onClick={() => addQuestion('true_false')}>
              添加判断题
            </Button>
          </Space>
        </div>
      </div>

      {/* 题目列表 */}
      {questions.length === 0 ? (
        <Empty description="点击上方按钮添加题目" />
      ) : (
        questions.map((q, index) => (
          <div
            key={q.id}
            style={{
              marginBottom: 16,
              padding: 16,
              borderRadius: 8,
              border: '1px solid #e8e8e8',
              background: '#fafafa',
            }}
          >
            {/* 题号 + 题型 + 操作 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Space>
                <Text strong style={{ fontSize: 15 }}>第 {index + 1} 题</Text>
                <Tag color={questionTypeColor(q.type)}>{questionTypeLabel(q.type)}</Tag>
                <Select
                  value={q.type}
                  onChange={v => updateQuestion(q.id, 'type', v)}
                  size="small"
                  style={{ width: 90 }}
                >
                  <Select.Option value="single">单选题</Select.Option>
                  <Select.Option value="multiple">多选题</Select.Option>
                  <Select.Option value="true_false">判断题</Select.Option>
                </Select>
              </Space>
              <Space>
                <Button size="small" icon={<ArrowUpOutlined />}
                  disabled={index === 0} onClick={() => moveQuestion(index, 'up')} />
                <Button size="small" icon={<ArrowDownOutlined />}
                  disabled={index === questions.length - 1} onClick={() => moveQuestion(index, 'down')} />
                <Popconfirm title="删除此题？" onConfirm={() => removeQuestion(q.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            </div>

            {/* 题目内容 */}
            <TextArea
              value={q.question}
              onChange={e => updateQuestion(q.id, 'question', e.target.value)}
              placeholder="输入题目内容..."
              rows={2}
              style={{ marginBottom: 12 }}
            />

            {/* 选项编辑 */}
            {q.type !== 'true_false' ? (
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>选项：</Text>
                {q.options.map((opt, oi) => (
                  <div key={oi} style={{ display: 'flex', alignItems: 'center', marginTop: 6 }}>
                    <Space style={{ flex: 1 }}>
                      <Input
                        value={opt}
                        onChange={e => updateOption(q.id, oi, e.target.value)}
                        style={{ flex: 1 }}
                        size="small"
                        addonBefore={String.fromCharCode(65 + oi)}
                      />
                      {q.options.length > 2 && (
                        <Button size="small" type="text" danger
                          icon={<DeleteOutlined />}
                          onClick={() => removeOption(q.id, oi)}
                        />
                      )}
                    </Space>
                  </div>
                ))}
                <Button size="small" type="dashed" icon={<PlusOutlined />}
                  onClick={() => addOption(q.id)} style={{ marginTop: 6 }}>
                  添加选项
                </Button>
              </div>
            ) : (
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>选项：</Text>
                <div style={{ marginTop: 4 }}>
                  <Tag>对</Tag>
                  <Tag>错</Tag>
                </div>
              </div>
            )}

            {/* 正确答案 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>正确答案：</Text>
              {q.type === 'single' && (
                <Radio.Group
                  value={q.answer}
                  onChange={e => updateQuestion(q.id, 'answer', e.target.value)}
                >
                  {q.options.map((opt, oi) => (
                    <Radio key={oi} value={opt.charAt(0)}>
                      {opt.charAt(0)}. {opt.substring(opt.indexOf('.') + 1) || opt}
                    </Radio>
                  ))}
                </Radio.Group>
              )}
              {q.type === 'multiple' && (
                <Checkbox.Group
                  value={q.answer ? q.answer.split(',').map(s => s.trim()) : []}
                  onChange={vals => updateQuestion(q.id, 'answer', vals.sort().join(','))}
                >
                  {q.options.map((opt, oi) => (
                    <Checkbox key={oi} value={opt.charAt(0)}>
                      {opt.charAt(0)}. {opt.substring(opt.indexOf('.') + 1) || opt}
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              )}
              {q.type === 'true_false' && (
                <Radio.Group
                  value={q.answer}
                  onChange={e => updateQuestion(q.id, 'answer', e.target.value)}
                >
                  <Radio value="对">对</Radio>
                  <Radio value="错">错</Radio>
                </Radio.Group>
              )}
            </div>

            {/* 解析 */}
            <div style={{ marginTop: 8 }}>
              <Input
                value={q.explanation}
                onChange={e => updateQuestion(q.id, 'explanation', e.target.value)}
                placeholder="解析（可选）：帮助学生理解..."
                size="small"
              />
            </div>
          </div>
        ))
      )}
    </Modal>
  )
}

export default QuizEditor
export type { Question }
