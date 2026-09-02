/**
 * 随堂测验 AI 生成题目管理组件
 * 与试题管理页面保持一致的 UI 风格
 */
import { useTranslation } from 'react-i18next'
import React, { useState, useEffect, useCallback } from 'react'
import {
  Layout, Table, Tag, Space, Typography, Button, Empty, message,
  Select, Input, Popconfirm, Tooltip, Image, Divider,
} from 'antd'
import {
  ReloadOutlined, RobotOutlined, ImportOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import FormulaRenderer from './FormulaRenderer'
import SVGViewer from './SVGViewer'
import MediaDisplay from './MediaDisplay'
import { TYPE_LABELS, TYPE_COLORS } from '../constants/questionTypes'

const { Text } = Typography

interface QuizQuestion {
  type: string
  question: string
  options?: string[] | Record<string, string>
  answer: string
  score?: number
  explanation?: string
  svg_code?: string
  svg_content?: string
  media_placeholders?: any[]
  media_files?: any[]
}

interface QuizItem {
  id: number
  title: string
  creator_name?: string
  creator_username?: string
  questions: QuizQuestion[]
}

interface FlatQuestion extends QuizQuestion {
  _quizId: number
  _quizTitle: string
  _creatorName: string
  _key: string
}

const QuizManager: React.FC = () => {
  const { t } = useTranslation('interaction')
  const [flatQuestions, setFlatQuestions] = useState<FlatQuestion[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState<Set<string>>(new Set())
  const [typeFilter, setTypeFilter] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')

  const loadQuestions = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/interaction/quizzes', {
        params: { page: 1, page_size: 200 },
      })
      const quizzes: QuizItem[] = Array.isArray(data) ? data : data?.quizzes || []
      const flat: FlatQuestion[] = []
      for (const quiz of quizzes) {
        if (!quiz.questions || !Array.isArray(quiz.questions)) continue
        quiz.questions.forEach((q, idx) => {
          flat.push({
            ...q,
            _quizId: quiz.id,
            _quizTitle: quiz.title,
            _creatorName: quiz.creator_name || quiz.creator_username || '',
            _key: `${quiz.id}_${idx}`,
          })
        })
      }
      setFlatQuestions(flat)
    } catch {
      message.error(t('qmLoadFailed'))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    loadQuestions()
  }, [])

  const filtered = flatQuestions.filter((q) => {
    if (typeFilter && q.type !== typeFilter) return false
    if (keyword) {
      const kw = keyword.toLowerCase()
      return q.question.toLowerCase().includes(kw) || (q.explanation || '').toLowerCase().includes(kw)
    }
    return true
  })

  const handleImportToBank = async (q: FlatQuestion) => {
    setImporting((prev) => new Set(prev).add(q._key))
    try {
      const payload: any = {
        type: q.type,
        question_text: q.question,
        correct_answer: q.answer,
        explanation: q.explanation || '',
        knowledge_points: '',
        difficulty: 'medium',
        source: 'quiz_import',
        svg_content: q.svg_content || q.svg_code || '',
        has_svg: (q.svg_content || q.svg_code) ? 1 : 0,
        media_files: q.media_files || [],
        media_placeholders: q.media_placeholders || [],
      }
      // 选项格式统一转为 JSON 对象
      if (q.options) {
        if (Array.isArray(q.options)) {
          const obj: Record<string, string> = {}
          q.options.forEach((opt, i) => {
            const letter = String.fromCharCode(65 + i)
            obj[letter] = opt.replace(/^[A-Z][.、]\s*/, '')
          })
          payload.options = obj
        } else {
          payload.options = q.options
        }
      }
      await apiClient.post('/api/questions/import', payload)
      message.success(t('qmImported'))
    } catch {
      message.error(t('qmImportFailed'))
    }
    setImporting((prev) => {
      const next = new Set(prev)
      next.delete(q._key)
      return next
    })
  }

  const handleDeleteQuiz = async (quizId: number) => {
    try {
      await apiClient.delete(`/api/interaction/quizzes/${quizId}`)
      message.success(t('qmQuizDeleted'))
      loadQuestions()
    } catch {
      message.error(t('qmDeleteFailed'))
    }
  }

  const handleDeleteQuestion = async (record: FlatQuestion) => {
    const parts = record._key.split('_')
    const questionIndex = parseInt(parts[parts.length - 1], 10)
    try {
      await apiClient.delete(`/api/interaction/quizzes/${record._quizId}/questions/${questionIndex}`)
      message.success(t('qmQuestionDeleted'))
      loadQuestions()
    } catch {
      message.error(t('qmDeleteFailed'))
    }
  }

  // ── 表格列定义 ──
  const columns = [
    {
      title: 'ID',
      key: 'id',
      width: 72,
      render: (_: any, __: any, idx: number) => (
        <span style={{ fontSize: 12, color: '#999', fontFamily: 'monospace' }}>#{idx + 1}</span>
      ),
    },
    {
      title: t('qmColType'),
      dataIndex: 'type',
      key: 'type',
      width: 80,
      render: (t: string) => (
        <Tag color={TYPE_COLORS[t]}>{TYPE_LABELS[t] || t}</Tag>
      ),
    },
    {
      title: t('qmColContent'),
      dataIndex: 'question',
      key: 'question',
      ellipsis: true,
      render: (text: string) => (
        <Tooltip
          title={<div style={{ maxWidth: 400 }}><FormulaRenderer content={text} /></div>}
          overlayStyle={{ maxWidth: 500 }}
        >
          <span style={{ cursor: 'pointer' }}>
            {text.length > 80 ? (
              <FormulaRenderer content={text.slice(0, 80) + '...'} inline />
            ) : (
              <FormulaRenderer content={text} inline />
            )}
          </span>
        </Tooltip>
      ),
    },
    {
      title: t('qmColCreator'),
      dataIndex: '_creatorName',
      key: '_creatorName',
      width: 90,
      render: (name: string) => (
        <span style={{ fontSize: 13, color: '#888' }}>{name || '-'}</span>
      ),
    },
    {
      title: t('qmColImage'),
      key: 'media',
      width: 80,
      render: (_: any, record: FlatQuestion) => {
        const svgContent = record.svg_content || record.svg_code
        if (svgContent) {
          return <SVGViewer svgCode={svgContent} description={t('qmPreview')} thumbHeight={50} />
        }
        const hasMediaImages = Array.isArray(record.media_files) && record.media_files.length > 0
        if (hasMediaImages && record.media_files![0].url) {
          return (
            <div style={{ width: 60, height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              <Image src={record.media_files![0].url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} preview={{ mask: null }} />
            </div>
          )
        }
        if (record.media_placeholders?.length) {
          return <Tag color="orange">📷 {record.media_placeholders.length}</Tag>
        }
        return <span style={{ color: '#ddd' }}>—</span>
      },
    },
    {
      title: t('qmColSource'),
      dataIndex: '_quizTitle',
      key: '_quizTitle',
      width: 140,
      ellipsis: true,
      render: (title: string) => (
        <Space size={4}>
          <RobotOutlined style={{ color: '#1677ff', fontSize: 12 }} />
          <Text style={{ fontSize: 12 }}>{title}</Text>
        </Space>
      ),
    },
    {
      title: t('qmColActions'),
      key: 'actions',
      width: 190,
      render: (_: any, record: FlatQuestion) => (
        <Space size="small">
          <Tooltip title={t('qmImportTip')}>
            <Button type="link" size="small" icon={<ImportOutlined />}
              loading={importing.has(record._key)}
              onClick={(e) => { e.stopPropagation(); handleImportToBank(record) }} />
          </Tooltip>
          <Popconfirm
            title={t('qmDelQTitle')}
            description={t('qmDelQDesc')}
            onConfirm={(e) => { e?.stopPropagation(); handleDeleteQuestion(record) }}
            okText={t('qmOk')}
            cancelText={t('qmCancel')}
          >
            <Tooltip title={t('qmDelQTip')}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />}
                onClick={(e) => e.stopPropagation()} />
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            title={t('qmDelQuizTitle', { title: record._quizTitle })}
            description={t('qmDelQuizDesc')}
            onConfirm={(e) => { e?.stopPropagation(); handleDeleteQuiz(record._quizId) }}
            okText={t('qmOk')}
            cancelText={t('qmCancel')}
          >
            <Tooltip title={t('qmDelQuizTip')}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />}
                style={{ opacity: 0.5 }}
                onClick={(e) => e.stopPropagation()} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // ── 展开行渲染 ──
  const expandedRowRender = (record: FlatQuestion) => (
    <div style={{ padding: '8px 0', maxWidth: 800 }}>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>
        <FormulaRenderer content={record.question} />
      </div>
      {(record.svg_content || record.svg_code || record.media_files?.length) && (
        <MediaDisplay
          svgContent={record.svg_content || record.svg_code}
          hasSvg={(record.svg_content || record.svg_code) ? 1 : 0}
          mediaFiles={record.media_files}
          size="normal"
        />
      )}
      {record.type !== 'short' && record.options && (() => {
        const entries = Array.isArray(record.options)
          ? record.options.map((v, i) => [String.fromCharCode(65 + i), v] as [string, string])
          : Object.entries(record.options as Record<string, string>)
        return entries.map(([k, v]) => (
          <div key={k} style={{ margin: '4px 0 0 20px', fontSize: 13, color: '#555' }}>
            <Tag>{k}</Tag> <FormulaRenderer content={v} inline />
          </div>
        ))
      })()}
      {record.type === 'short' && (
        <div style={{ margin: '4px 0 0 20px', fontSize: 13, color: '#555' }}>
          {t('qmRefAnswer')}<FormulaRenderer content={record.answer} inline />
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <Tag color="green">{t('qmCorrectAnswer')}{record.answer}</Tag>
        {record.explanation && (
          <div style={{ marginTop: 4 }}>
            <FormulaRenderer content={record.explanation} />
          </div>
        )}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#aaa' }}>
        {t('qmSourceLine', { title: record._quizTitle, score: record.score ?? '-' })}
      </div>
    </div>
  )

  return (
    <Layout style={{ height: '100%', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 20, fontSize: 14 }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        {/* ── 标题和操作栏 ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>
              {t('qmTitle')}
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('qmSubtitle')}
            </Typography.Text>
          </div>
          <div>
            <Button icon={<ReloadOutlined />} onClick={loadQuestions} loading={loading}>
              {t('qmRefresh')}
            </Button>
          </div>
        </div>

        <Divider style={{ margin: '0 0 8px 0' }} />

        {/* ── 筛选栏 ── */}
        <Space wrap>
          <Select
            allowClear
            placeholder={t('qmFilterType')}
            style={{ width: 110 }}
            value={typeFilter}
            onChange={(v: string | undefined) => setTypeFilter(v)}
          >
            <Select.Option value="single">{t('qmTypeSingle')}</Select.Option>
            <Select.Option value="true_false">{t('qmTypeTrueFalse')}</Select.Option>
            <Select.Option value="multiple">{t('qmTypeMultiple')}</Select.Option>
            <Select.Option value="short">{t('qmTypeShort')}</Select.Option>
          </Select>
          <Input.Search
            allowClear
            placeholder={t('qmSearchPh')}
            value={keyword}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKeyword(e.target.value)}
            onSearch={(val: string) => setKeyword(val)}
            style={{ width: 220 }}
          />
          <Text type="secondary" style={{ fontSize: 13 }}>
            {t('qmTotalN', { count: filtered.length })}
          </Text>
        </Space>

        {/* ── 题目表格 ── */}
        <Table
          dataSource={filtered}
          columns={columns}
          rowKey="_key"
          loading={loading}
          size="small"
          pagination={{ pageSize: 20, showTotal: (num: number) => t('qmTotalPage', { count: num }) }}
          locale={{ emptyText: <Empty description={t('qmEmpty')} /> }}
          expandable={{
            expandedRowRender,
            rowExpandable: () => true,
          }}
        />
      </Space>
    </Layout>
  )
}

export default QuizManager
