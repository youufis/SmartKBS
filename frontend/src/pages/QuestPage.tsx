/**
 * QuestPage — 知识闯关 主页
 * 学生入口：开始闯关 + 历史记录 + 统计
 */
import React, { useState, useEffect, startTransition, useRef } from 'react'
import { Card, Button, Typography, Space, Statistic, Tag, Spin, Modal, Tooltip } from 'antd'
import { message } from '../utils/feedback'
import {
  ThunderboltOutlined, HistoryOutlined,
  FireOutlined, CrownOutlined, StarOutlined,
  RobotOutlined, DatabaseOutlined, QuestionCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { relativeTime, fullTime } from '../utils/relativeTime'
import NarrowTable from '../components/NarrowTable'

const { Title, Text, Paragraph } = Typography

interface QuestStats {
  total_quests: number
  success_count: number
  total_correct: number
  best_correct: number
  best_score: number
  badge_count: number
  total_badges: number
}

interface QuestRecord {
  id: number
  answered_count: number
  correct_count: number
  score: number
  wrong_question_index: number
  completed: number
  created_at: string
  completed_at: string | null
}

const QuestPage: React.FC = () => {
  const { t } = useTranslation('questions')
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'

  const [stats, setStats] = useState<QuestStats | null>(null)
  const [records, setRecords] = useState<QuestRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [tableLoading, setTableLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [questConfig, setQuestConfig] = useState<{ use_bank: boolean; bank_full?: boolean; time_limit_sec?: number; max_questions?: number; base_scores?: number[]; lifeline_discounts?: Record<string, number> } | null>(null)
  const [bankStats, setBankStats] = useState<{ total_questions: number; by_category: any[] } | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [expandedQuestions, setExpandedQuestions] = useState<Record<number, any[]>>({})
  const recordsLoadedRef = useRef(false)

  const loadData = async (opts?: { tableOnly?: boolean }) => {
    if (opts?.tableOnly) setTableLoading(true)
    else setLoading(true)
    try {
      const [statsRes, historyRes, bankRes, configRes] = await Promise.all([
        apiClient.get('/api/quest/stats'),
        apiClient.get('/api/quest/history', { params: { page, page_size: pageSize } }),
        apiClient.get('/api/quest/bank/stats'),
        apiClient.get('/api/quest/config'),
      ])
      setStats(statsRes.data)
      setRecords(historyRes.data.records || [])
      setTotal(historyRes.data.total || 0)
      setBankStats(bankRes.data)
      setQuestConfig(configRes.data)
      recordsLoadedRef.current = true
    } catch (e: any) {
      if (e?.response?.status !== 403) {
        message.error(t('loadQuestDataFailed'))
      }
    } finally {
      if (opts?.tableOnly) setTableLoading(false)
      else setLoading(false)
    }
  }

  useEffect(() => {
    // 首次进入整页 loading；之后翻页/改每页条数只刷新表格（保留骨架，避免整页闪白）
    const firstLoad = !recordsLoadedRef.current
    startTransition(() => loadData(firstLoad ? undefined : { tableOnly: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize])

  const handleStart = async () => {
    if (!isStudent) {
      message.warning(t('studentsOnly'))
      return
    }
    setStarting(true)
    try {
      // AI 出题即使已大幅提速，首题 + 弱网仍可能超过全局 30s，给足超时
      const { data } = await apiClient.post('/api/quest/start', null, { timeout: 90000 })
      navigate(`/quest/battle/${data.quest_id}`, { state: { initialData: data } })
    } catch (e: any) {
      const detail = e?.response?.data?.detail || t('quest.startFailed')
      message.error(detail)
    } finally {
      setStarting(false)
    }
  }

  const SCORE_COLORS = ['#ff4d4f', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1']

  const getScoreColor = (correct: number) => {
    if (correct >= 12) return SCORE_COLORS[5]
    if (correct >= 8) return SCORE_COLORS[4]
    if (correct >= 4) return SCORE_COLORS[3]
    if (correct >= 1) return SCORE_COLORS[2]
    return SCORE_COLORS[0]
  }

  const getStatusTag = (record: QuestRecord) => {
    if (record.completed === 0) return <Tag color="processing">{t('inProgress')}</Tag>
    if (record.completed === 1 && record.correct_count >= 1) return <Tag color="success">{t('success')}</Tag>
    return <Tag color="error">{t('terminated')}</Tag>
  }

  const loadQuestions = async (questId: number) => {
    if (expandedQuestions[questId]) return // 已加载
    try {
      const { data } = await apiClient.get(`/api/quest/${questId}/result`)
      setExpandedQuestions((prev) => ({ ...prev, [questId]: data.questions || [] }))
    } catch {
      message.error(t('loadQuestionDetailFailed'))
    }
  }

  const expandedRowRender = (record: QuestRecord) => {
    const questions = expandedQuestions[record.id]
    if (!questions) {
      return <Spin size="small" style={{ display: 'block', padding: 12 }} />
    }
    if (questions.length === 0) {
      return <Text type="secondary" style={{ padding: 12 }}>{t('noQuestionDetails')}</Text>
    }
    return (
      <NarrowTable
        dataSource={questions}
        rowKey="sort_order"
        pagination={false}
        size="small"
        bordered
        cardTitleKey="q"
        cardHiddenKeys={['s']}
        columns={[
          { title: '#', dataIndex: 'sort_order', key: 's', width: 36 },
          {
            title: t('quest.categoryLabel'), dataIndex: 'category', key: 'c', width: 70,
            render: (c: string) => <Tag style={{ fontSize: 11 }}>{c}</Tag>,
          },
          {
            title: t('quest.question'), dataIndex: 'question_text', key: 'q', width: 240,
            render: (qText: string) => <Text style={{ fontSize: 12 }}>{qText}</Text>,
          },
          {
            title: t('studentAnswer'), dataIndex: 'student_answer', key: 'sa', width: 80,
            render: (ans: string, q: any) => {
              if (q.is_correct === 1) return <Tag color="success">{ans || '✓'}</Tag>
              if (q.is_correct === 0) return <Tag color="error">{ans || '✗'}</Tag>
              return <Tag>-</Tag>
            },
          },
          {
            title: t('quest.correctAnswer'), key: 'ca', width: 80,
            render: (_: any, q: any) => (
              <Text style={{ fontSize: 12, color: '#52c41a' }}>{q.correct_answer}</Text>
            ),
          },
          {
            title: t('score'), dataIndex: 'score', key: 'sc', width: 44,
            render: (s: number) => <Text strong style={{ fontSize: 12 }}>{s}</Text>,
          },
          {
            title: t('timeSpent'), dataIndex: 'time_spent', key: 'ts', width: 50,
            render: (spent: number) => (
              <Space size={2}><ClockCircleOutlined style={{ fontSize: 11 }} />{spent || 0}s</Space>
            ),
          },
          {
            title: t('quest.explanationCol'), dataIndex: 'explanation', key: 'exp', width: 200,
            render: (exp: string) => <Text type="secondary" style={{ fontSize: 11 }}>{exp}</Text>,
          },
        ]}
        scroll={{ x: 800 }}
      />
    )
  }

  const columns = [
    {
      title: t('quest.round'), dataIndex: 'id', key: 'id', width: 70,
      render: (id: number) => `#${id}`,
    },
    {
      title: t('result'), key: 'status', width: 150,
      render: (_: any, r: QuestRecord) => (
        <Space size={4}>
          {getStatusTag(r)}
          {r.completed === 0 && (
            <Button size="small" type="primary" icon={<ThunderboltOutlined />}
              onClick={(e) => { e.stopPropagation(); navigate(`/quest/battle/${r.id}`) }}>
              {t('quest.continueBtn')}
            </Button>
          )}
        </Space>
      ),
    },
    {
      title: t('correctTotal'), key: 'count', width: 100,
      render: (_: any, r: QuestRecord) => (
        <Text strong style={{ color: getScoreColor(r.correct_count) }}>
          {r.correct_count} / {r.answered_count}
        </Text>
      ),
    },
    {
      title: t('score'), dataIndex: 'score', key: 'score', width: 60,
      render: (s: number) => <Text strong>{s}</Text>,
    },
    {
      title: t('wrongQuestion'), dataIndex: 'wrong_question_index', key: 'wrong', width: 60,
      render: (idx: number) => idx > 0 ? t('questionNo', { n: idx }) : '-',
    },
    {
      title: t('quest.timeLabel'), dataIndex: 'created_at', key: 'time', width: 130,
      render: (timeVal: string) => timeVal ? (
        <Tooltip title={fullTime(timeVal)}><Text type="secondary" style={{ fontSize: 12 }}>{relativeTime(timeVal)}</Text></Tooltip>
      ) : '-',
    },
  ]

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" description={t('loading')} />
      </div>
    )
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* ── 顶部大卡片（一行显示） ── */}
      <Card
        style={{
          borderRadius: 16,
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          marginBottom: 24,
          border: 'none',
        }}
        styles={{ body: { padding: '16px 24px' } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          {/* 左侧：标题 + 描述 + 切换 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <Title level={3} style={{ color: '#fff', margin: 0, whiteSpace: 'nowrap' }}>
              {t('quest.title')}
            </Title>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14, whiteSpace: 'nowrap' }}>
              {t('quest.subtitle')}
            </Text>
            <Space size={4}>
              {questConfig?.use_bank ? (
                <DatabaseOutlined style={{ fontSize: 13, color: '#52c41a' }} />
              ) : (
                <RobotOutlined style={{ fontSize: 13, color: '#fff' }} />
              )}
              <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: 500 }}>
                {questConfig?.use_bank ? t('quest.bankMode') : t('quest.aiMode')}
              </Text>
              {bankStats && (
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
                  {bankStats.total_questions}{t('quest.questions')}
                </Text>
              )}
            </Space>
          </div>
          {/* 右侧：按钮 */}
          <Space>
            <Button
              type="primary"
              size="large"
              icon={<ThunderboltOutlined />}
              loading={starting}
              onClick={handleStart}
              style={{
                height: 44,
                borderRadius: 22,
                paddingLeft: 28,
                paddingRight: 28,
                fontSize: 16,
                background: '#ffd700',
                borderColor: '#ffd700',
                color: 'var(--text-primary)',
                fontWeight: 600,
                boxShadow: '0 4px 14px rgba(255, 215, 0, 0.4)',
              }}
            >
              {starting ? t('quest.startingBtn') : t('quest.startBtn')}
            </Button>
            <Button
              ghost
              icon={<QuestionCircleOutlined />}
              onClick={() => setRulesOpen(true)}
            >
              {t('quest.rulesBtn')}
            </Button>
          </Space>
        </div>
      </Card>

      {/* ── 统计面板（一行显示；窄屏由 mobile.css 允许换行） ── */}
      <div className="quest-stats" style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title={t('quest.totalQuests')}
            value={stats?.total_quests || 0}
            prefix={<HistoryOutlined />}
            suffix={t('quest.times')}
          />
        </Card>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title={t('quest.badgeTitle')}
            value={stats?.badge_count || 0}
            prefix={<CrownOutlined style={{ color: '#faad14' }} />}
            suffix={t('quest.badgeUnit')}
            styles={{ content: { color: '#faad14' } }}
          />
        </Card>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title={t('quest.totalCorrect')}
            value={stats?.total_correct || 0}
            prefix={<FireOutlined />}
            suffix={t('quest.questions')}
          />
        </Card>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title={t('quest.bestRecord')}
            value={stats?.best_correct || 0}
            prefix={<StarOutlined style={{ color: '#1677ff' }} />}
            suffix={t('quest.bestSuffix', { max: questConfig?.max_questions || 15 })}
            styles={{ content: { color: getScoreColor(stats?.best_correct || 0) } }}
          />
        </Card>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title={t('quest.bankQuestions')}
              value={bankStats?.total_questions || 0}
              prefix={<DatabaseOutlined style={{ color: '#722ed1' }} />}
              suffix={t('quest.questions')}
              styles={{ content: { color: '#722ed1', fontSize: 22 } }}
            />
            {bankStats?.by_category && bankStats.by_category.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-tertiary)' }}>
                {bankStats.by_category.slice(0, 3).map((c: any) =>
                  `${c.category}${c.count}${t('quest.questions')}`
                ).join(' · ')}
              </div>
            )}
          </Card>
      </div>

      {/* ── 历史记录（分页 + 展开） ── */}
      <Card title={<Space><HistoryOutlined /> {t('questRecords')}</Space>}>
        {/* 明细类表格：窄屏自动摊卡片（含「展开」看每题作答），不再靠 550px 宽的表横滑 */}
        <NarrowTable
          className="nowrap-cells-table"
          cardTitleKey="id"
          dataSource={records}
          columns={columns}
          rowKey="id"
          size="small"
          loading={tableLoading}
          locale={{ emptyText: t('quest.emptyText') }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showQuickJumper: true,
            hideOnSinglePage: false,
            showTotal: (total, range) => t('pageInfo', { start: range[0], end: range[1], total }),
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
          }}
          expandable={{
            expandedRowRender,
            rowExpandable: () => true,
            onExpand: (expanded: boolean, record: QuestRecord) => {
              if (expanded) loadQuestions(record.id)
            },
          }}
          onRow={() => ({
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      {/* ── 规则说明弹窗 ── */}
      <Modal
        title={t('quest.rulesTitle')}
        open={rulesOpen}
        onCancel={() => setRulesOpen(false)}
        footer={<Button onClick={() => setRulesOpen(false)}>{t('quest.rulesGotIt')}</Button>}
        width={600}
      >
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Title level={5}>{t('quest.rules.gameTitle')}</Title>
            <Paragraph>{t('quest.rules.gameDesc', { max: questConfig?.max_questions || 15 })}</Paragraph>
          </div>
          <div>
            <Title level={5}>{t('quest.rules.timerTitle')}</Title>
            <Paragraph>{t('quest.rules.timerDesc', { n: questConfig?.time_limit_sec || 30 })}</Paragraph>
          </div>
          <div>
            <Title level={5}>{t('quest.rules.lifelineTitle')}</Title>
            <Paragraph style={{ whiteSpace: 'pre-line' }}>
              {t('quest.rules.lifelineDesc', {
                p1: Math.round((questConfig?.lifeline_discounts?.remove_one ?? 0.85) * 100),
                p2: Math.round((questConfig?.lifeline_discounts?.phone_friend ?? 0.7) * 100),
                p3: Math.round((questConfig?.lifeline_discounts?.audience_vote ?? 0.7) * 100),
              })}
            </Paragraph>
          </div>
          <div>
            <Title level={5}>{t('quest.rules.scoreTitle')}</Title>
            <Paragraph style={{ whiteSpace: 'pre-line' }}>
              {t('quest.rules.scoreDesc', { line: (questConfig?.base_scores && questConfig.base_scores.length)
                ? questConfig.base_scores.map((s, i) => (i + 1) + ':' + s).join('  ') : '' })}
            </Paragraph>
          </div>
          <div>
            <Title level={5}>{t('quest.rules.badgeTitle')}</Title>
            <Paragraph style={{ whiteSpace: 'pre-line' }}>
              {t('quest.rules.badgeDesc')}
            </Paragraph>
          </div>
        </Space>
      </Modal>
    </Card>
  )
}

export default QuestPage
