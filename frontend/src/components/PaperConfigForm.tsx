import React, { useMemo } from 'react'
import { Form, Input, Select, InputNumber, Row, Col, Button, Space, Tag, Divider, Typography } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import type { TypeConfigItem } from '../api/exams'

const { Option } = Select

const TYPE_OPTIONS = [
  { value: 'single', label: '单选题' },
  { value: 'multiple', label: '多选题' },
  { value: 'true_false', label: '判断题' },
  { value: 'short', label: '简答题' },
]

interface PaperConfigFormProps {
  subjects: string[]
  knowledgePoints: string[]
  totalScore: number
  onTotalScoreChange: (score: number) => void
}

/** 小计计算子组件（必须独立以遵守 Hooks 规则） */
const TypeSubtotal: React.FC<{ name: number }> = ({ name }) => {
  const count = Form.useWatch(['type_configs', name, 'count']) || 0
  const score = Form.useWatch(['type_configs', name, 'score_per_question']) || 0
  const subtotal = useMemo(() => ((count || 0) * (score || 0)).toFixed(1), [count, score])
  return (
    <Typography.Text type="secondary">
      小计：<Typography.Text strong>{subtotal}</Typography.Text> 分
    </Typography.Text>
  )
}

const PaperConfigForm: React.FC<PaperConfigFormProps> = ({
  subjects,
  knowledgePoints,
  totalScore,
  onTotalScoreChange,
}) => {
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      {/* 基本信息 */}
      <CardSection title="基本信息">
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item label="学校名称" name="school_name">
              <Input placeholder="如：XX市第一中学" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label="学年学期" name="semester">
              <Input placeholder="如：2025-2026学年第一学期" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="科目" name="subject">
              <Select placeholder="选择科目">
                {subjects.map((s) => (
                  <Option key={s} value={s}>
                    {s}
                  </Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="考试年级" name="target_grade">
              <Select
                placeholder="选择年级"
                allowClear
                mode="multiple"
                maxTagCount={2}
              >
                <Option value="高一">高一</Option>
                <Option value="高二">高二</Option>
                <Option value="高三">高三</Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="考试时长（分钟）" name="duration">
              <InputNumber min={1} max={180} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
      </CardSection>

      {/* 题型配置 */}
      <CardSection title="题型配置" subtitle="设置每种题型的题量和分值">
        <Form.List name="type_configs">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }, index) => (
                <Row key={key} gutter={12} align="middle" style={{ marginBottom: 8 }}>
                  <Col span={5}>
                    <Form.Item {...restField} name={[name, 'type']} rules={[{ required: true, message: '请选择题型' }]}>
                      <Select placeholder="选择题型" disabled={index < fields.length}>
                        {TYPE_OPTIONS.map((opt) => (
                          <Option key={opt.value} value={opt.value}>
                            {opt.label}
                          </Option>
                        ))}
                      </Select>
                    </Form.Item>
                  </Col>
                  <Col span={4}>
                    <Form.Item {...restField} name={[name, 'count']} rules={[{ required: true, message: '请输入题数' }]}>
                      <InputNumber min={0} max={100} style={{ width: '100%' }} placeholder="题数" />
                    </Form.Item>
                  </Col>
                  <Col span={5}>
                    <Form.Item {...restField} name={[name, 'score_per_question']} rules={[{ required: true, message: '请输入分值' }]}>
                      <InputNumber min={0.5} max={100} step={0.5} style={{ width: '100%' }} placeholder="每题分值" />
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <TypeSubtotal name={name} />
                  </Col>
                  <Col span={4}>
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => remove(name)}
                      disabled={fields.length <= 1}
                    />
                  </Col>
                </Row>
              ))}
              <Form.Item>
                <Button type="dashed" onClick={() => add({ type: undefined, count: 0, score_per_question: 5 })} block icon={<PlusOutlined />}>
                  添加题型
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>

        <Divider />
        <Row justify="space-between" align="middle">
          <Col>
            <Space>
              <Typography.Text strong>当前总分：</Typography.Text>
              <Typography.Text style={{ fontSize: 18, fontWeight: 600, color: '#1677ff' }}>
                {totalScore.toFixed(1)}
              </Typography.Text>
              <Typography.Text type="secondary">分</Typography.Text>
            </Space>
          </Col>
          <Col>
            <Form.Item name="total_score" label="设定总分" style={{ margin: 0 }}>
              <InputNumber min={1} max={1000} style={{ width: 120 }} />
            </Form.Item>
          </Col>
        </Row>
      </CardSection>

      {/* 难度分布 */}
      <CardSection title="难度分布">
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label="简单题占比" name="difficulty_easy_ratio">
              <InputNumber min={0} max={100} formatter={(v) => `${v}%`} parser={(v) => Number(v?.replace('%', '') || 0) as any} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="中等题占比" name="difficulty_medium_ratio">
              <InputNumber min={0} max={100} formatter={(v) => `${v}%`} parser={(v) => Number(v?.replace('%', '') || 0) as any} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label="困难题占比" name="difficulty_hard_ratio">
              <InputNumber min={0} max={100} formatter={(v) => `${v}%`} parser={(v) => Number(v?.replace('%', '') || 0) as any} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          💡 建议比例：简单:中等:困难 = 20:50:30
        </Typography.Text>
      </CardSection>

      {/* 知识点范围 */}
      <CardSection title="知识点范围" subtitle="留空则覆盖所有知识点">
        <Form.Item name="knowledge_points">
          <Select
            mode="multiple"
            placeholder="搜索并选择知识点（可多选）"
            allowClear
            maxTagCount={8}
            style={{ width: '100%' }}
            showSearch
            filterOption={(input, option) =>
              (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
            }
          >
            {knowledgePoints.map((kp) => (
              <Option key={kp} value={kp}>
                {kp}
              </Option>
            ))}
          </Select>
        </Form.Item>
      </CardSection>

      {/* 高级选项 */}
      <CardSection title="高级选项">
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="replace_existing" label="替换已有题目" valuePropName="checked">
              <Select>
                <Option value={false}>保留已有题目（追加）</Option>
                <Option value={true}>替换所有已有题目</Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="use_ai" label="AI 智能选择" valuePropName="checked">
              <Select>
                <Option value={true}>启用 AI 智能组卷</Option>
                <Option value={false}>仅按规则选题（随机）</Option>
              </Select>
            </Form.Item>
          </Col>
        </Row>
      </CardSection>
    </Space>
  )
}

/** 带标题和可选副标题的卡片样式区块 */
const CardSection: React.FC<{
  title: string
  subtitle?: string
  children: React.ReactNode
}> = ({ title, subtitle, children }) => (
  <div
    style={{
      padding: '16px',
      background: '#fafafa',
      borderRadius: 8,
      border: '1px solid #f0f0f0',
    }}
  >
    <div style={{ marginBottom: 12 }}>
      <Typography.Text strong style={{ fontSize: 15 }}>
        {title}
      </Typography.Text>
      {subtitle && (
        <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
          {subtitle}
        </Typography.Text>
      )}
    </div>
    {children}
  </div>
)

export default PaperConfigForm
