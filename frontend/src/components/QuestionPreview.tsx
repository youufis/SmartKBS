import React from 'react'
import { Table, Tag, Typography, Space, Button, Popconfirm, Empty, Card, Row, Col, Statistic } from 'antd'
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import FormulaRenderer from './FormulaRenderer'

const TYPE_LABELS: Record<string, string> = {
  single: '单选题',
  multiple: '多选题',
  true_false: '判断题',
  short: '简答题',
}

const TYPE_COLORS: Record<string, string> = {
  single: 'blue',
  multiple: 'purple',
  true_false: 'orange',
  short: 'green',
}

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
}

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: 'green',
  medium: 'gold',
  hard: 'red',
}

export interface SelectedQuestion {
  id: number
  type: string
  question_text: string
  options?: Record<string, string> | null
  correct_answer?: string
  difficulty: string
  knowledge_points?: string
  score?: number
}

interface QuestionPreviewProps {
  questions: SelectedQuestion[]
  loading?: boolean
  typeStats: Record<string, number>
  difficultyStats: Record<string, number>
  totalScore: number
  onRemoveQuestion?: (questionId: number) => void
  onRegenerate?: () => void
  readOnly?: boolean
}

const QuestionPreview: React.FC<QuestionPreviewProps> = ({
  questions,
  loading = false,
  typeStats,
  difficultyStats,
  totalScore,
  onRemoveQuestion,
  onRegenerate,
  readOnly = false,
}) => {
  const columns = [
    {
      title: '#',
      key: 'index',
      width: 40,
      render: (_: any, __: any, idx: number) => idx + 1,
    },
    {
      title: '题型',
      dataIndex: 'type',
      width: 80,
      render: (t: string) => (
        <Tag color={TYPE_COLORS[t] || 'default'}>
          {TYPE_LABELS[t] || t}
        </Tag>
      ),
    },
    {
      title: '题目',
      dataIndex: 'question_text',
      ellipsis: true,
      render: (text: string) => (
        <Typography.Text style={{ fontSize: 13 }}>
          <FormulaRenderer content={text} />
        </Typography.Text>
      ),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 70,
      render: (d: string) => (
        <Tag color={DIFFICULTY_COLORS[d]}>
          {DIFFICULTY_LABELS[d] || d}
        </Tag>
      ),
    },
    {
      title: '知识点',
      dataIndex: 'knowledge_points',
      width: 120,
      ellipsis: true,
      render: (text: string) => text || '-',
    },
    {
      title: '分值',
      dataIndex: 'score',
      width: 60,
      render: (s: number) => (
        <Typography.Text strong>{s?.toFixed?.(1) || s}</Typography.Text>
      ),
    },
    ...(!readOnly
      ? [
          {
            title: '操作',
            width: 60,
            key: 'action',
            render: (_: any, record: SelectedQuestion) => (
              <Popconfirm
                title="移除该题？"
                description="组卷时将不再包含此题"
                onConfirm={() => onRemoveQuestion?.(record.id)}
              >
                <Button type="link" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>
            ),
          },
        ]
      : []),
  ]

  if (!questions || questions.length === 0) {
    return (
      <Card>
        <Empty
          description={
            loading ? (
              <span>正在生成题目...</span>
            ) : (
              <span>暂无题目，请先配置参数并点击「开始组卷」</span>
            )
          }
        />
      </Card>
    )
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {/* 统计卡片 */}
      <Row gutter={12}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="总题数"
              value={questions.length}
              suffix="道"
              valueStyle={{ color: '#1677ff' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="总分"
              value={totalScore}
              suffix="分"
              precision={1}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="题型分布" valueRender={() => (
              <Space size={4} wrap>
                {Object.entries(typeStats).map(([type, count]) => (
                  <Tag key={type} color={TYPE_COLORS[type]}>
                    {TYPE_LABELS[type] || type}: {count}
                  </Tag>
                ))}
              </Space>
            )} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="难度分布" valueRender={() => (
              <Space size={4} wrap>
                {Object.entries(difficultyStats).map(([diff, count]) => (
                  <Tag key={diff} color={DIFFICULTY_COLORS[diff]}>
                    {DIFFICULTY_LABELS[diff] || diff}: {count}
                  </Tag>
                ))}
              </Space>
            )} />
          </Card>
        </Col>
      </Row>

      {/* 操作栏 */}
      {onRegenerate && (
        <Space>
          <Button icon={<ReloadOutlined />} onClick={onRegenerate} loading={loading}>
            重新生成
          </Button>
        </Space>
      )}

      {/* 题目列表 */}
      <Table
        dataSource={questions}
        columns={columns}
        rowKey="id"
        size="small"
        loading={loading}
        pagination={false}
        locale={{ emptyText: <Empty description="暂无题目" /> }}
      />
    </Space>
  )
}

export default QuestionPreview
