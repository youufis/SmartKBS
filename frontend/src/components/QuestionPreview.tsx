import React from 'react'
import { Table, Tag, Typography, Space, Button, Popconfirm, Empty, Card, Row, Col, Statistic, Image } from 'antd'
import { DeleteOutlined, ReloadOutlined, EyeOutlined } from '@ant-design/icons'
import FormulaRenderer from './FormulaRenderer'
import SVGViewer from './SVGViewer'

const TYPE_LABELS: Record<string, string> = {
  single: '单选题',
  multiple: '多选题',
  true_false: '判断题',
  short: '简答题',
  fill: '填空题',
  essay: '作文',
  subjective: '主观题',
}

const TYPE_COLORS: Record<string, string> = {
  single: 'blue',
  multiple: 'purple',
  true_false: 'orange',
  short: 'green',
  fill: 'cyan',
  essay: 'magenta',
  subjective: 'volcano',
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
  /** SVG 配图 */
  svg_content?: string
  has_svg?: number
  /** 媒体文件 */
  media_files?: any[] | string | null
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
      width: 70,
      render: (t: string) => (
        <Tag color={TYPE_COLORS[t] || 'default'} style={{ fontSize: 11 }}>
          {TYPE_LABELS[t] || t}
        </Tag>
      ),
    },
    {
      title: '题目',
      dataIndex: 'question_text',
      ellipsis: true,
      render: (text: string, record: SelectedQuestion) => (
        <Space size={4}>
          <Typography.Text style={{ fontSize: 13 }} ellipsis={{ tooltip: text }}>
            <FormulaRenderer content={text} />
          </Typography.Text>
          {/* 配图标记 */}
          {(record.svg_content || record.has_svg) && (
            <EyeOutlined style={{ color: '#1677ff', fontSize: 12 }} title="含配图" />
          )}
        </Space>
      ),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 65,
      render: (d: string) => (
        <Tag color={DIFFICULTY_COLORS[d]} style={{ fontSize: 11 }}>
          {DIFFICULTY_LABELS[d] || d}
        </Tag>
      ),
    },
    {
      title: '知识点',
      dataIndex: 'knowledge_points',
      width: 110,
      ellipsis: true,
      render: (text: string) => text || '-',
    },
    {
      title: '分值',
      dataIndex: 'score',
      width: 55,
      render: (s: number) => (
        <Typography.Text strong>{s?.toFixed?.(1) || s}</Typography.Text>
      ),
    },
    ...(!readOnly
      ? [
          {
            title: '操作',
            width: 55,
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
        expandable={{
          expandedRowRender: (record: SelectedQuestion) => (
            <div style={{ padding: '8px 16px', maxWidth: 800 }}>
              {/* 题目完整文本 */}
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                <FormulaRenderer content={record.question_text} />
              </Typography.Paragraph>

              {/* 选项展示 */}
              {record.options && Object.keys(record.options).length > 0 && (
                <div style={{ marginBottom: 8, padding: 8, background: '#fafafa', borderRadius: 4 }}>
                  {Object.entries(record.options).map(([key, val]) => (
                    <div key={key} style={{ padding: '2px 0', fontSize: 13 }}>
                      <strong>{key}.</strong> <FormulaRenderer content={val} inline />
                    </div>
                  ))}
                </div>
              )}

              {/* SVG 配图 */}
              {(record.svg_content && record.has_svg) ? (
                <div style={{ marginTop: 8 }}>
                  <SVGViewer svgCode={record.svg_content || ''} />
                </div>
              ) : null}

              {/* 媒体文件 */}
              {record.media_files && Array.isArray(record.media_files) && record.media_files.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Image.PreviewGroup>
                    <Space wrap>
                      {record.media_files.map((mf: any, idx: number) => (
                        mf?.url ? (
                          <Image
                            key={idx}
                            src={mf.url}
                            alt={mf.alt || ''}
                            width={120}
                            style={{ borderRadius: 4, border: '1px solid #f0f0f0' }}
                            preview={{ mask: '预览' }}
                          />
                        ) : null
                      ))}
                    </Space>
                  </Image.PreviewGroup>
                </div>
              )}
            </div>
          ),
          rowExpandable: (record: SelectedQuestion) => !!(
            (record.options && Object.keys(record.options).length > 0) ||
            (record.svg_content && record.has_svg) ||
            (record.media_files && Array.isArray(record.media_files) && record.media_files.length > 0)
          ),
        }}
      />
    </Space>
  )
}

export default QuestionPreview
