/**
 * QuestPage — 知识闯关 主页
 * 学生入口：开始闯关 + 历史记录 + 统计
 */
import React, { useState, useEffect, startTransition } from 'react'
import {
  Card, Button, Typography, Space, Statistic,
  Table, Tag, message, Spin, Modal,
} from 'antd'
import {
  ThunderboltOutlined, HistoryOutlined,
  FireOutlined, CrownOutlined, StarOutlined,
  RobotOutlined, DatabaseOutlined, QuestionCircleOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

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
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'

  const [stats, setStats] = useState<QuestStats | null>(null)
  const [records, setRecords] = useState<QuestRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [questConfig, setQuestConfig] = useState<{ use_bank: boolean; bank_full?: boolean } | null>(null)
  const [bankStats, setBankStats] = useState<{ total_questions: number; by_category: any[] } | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [total, setTotal] = useState(0)
  const [expandedQuestions, setExpandedQuestions] = useState<Record<number, any[]>>({})

  const loadData = async () => {
    setLoading(true)
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
    } catch (e: any) {
      if (e?.response?.status !== 403) {
        message.error('加载闯关数据失败')
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    startTransition(() => loadData())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize])

  const handleStart = async () => {
    if (!isStudent) {
      message.warning('仅学生可以参与闯关')
      return
    }
    setStarting(true)
    try {
      const { data } = await apiClient.post('/api/quest/start')
      navigate(`/quest/battle/${data.quest_id}`, { state: { initialData: data } })
    } catch (e: any) {
      const detail = e?.response?.data?.detail || '启动闯关失败'
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
    if (record.completed === 0) return <Tag color="processing">进行中</Tag>
    if (record.completed === 1 && record.correct_count >= 1) return <Tag color="success">成功</Tag>
    return <Tag color="error">终止</Tag>
  }

  const loadQuestions = async (questId: number) => {
    if (expandedQuestions[questId]) return // 已加载
    try {
      const { data } = await apiClient.get(`/api/quest/${questId}/result`)
      setExpandedQuestions((prev) => ({ ...prev, [questId]: data.questions || [] }))
    } catch {
      message.error('加载题目详情失败')
    }
  }

  const expandedRowRender = (record: QuestRecord) => {
    const questions = expandedQuestions[record.id]
    if (!questions) {
      return <Spin size="small" style={{ display: 'block', padding: 12 }} />
    }
    if (questions.length === 0) {
      return <Text type="secondary" style={{ padding: 12 }}>暂无题目详情</Text>
    }
    return (
      <Table
        dataSource={questions}
        rowKey="sort_order"
        pagination={false}
        size="small"
        bordered
        columns={[
          { title: '#', dataIndex: 'sort_order', key: 's', width: 36 },
          {
            title: '领域', dataIndex: 'category', key: 'c', width: 70,
            render: (c: string) => <Tag style={{ fontSize: 11 }}>{c}</Tag>,
          },
          {
            title: '题目', dataIndex: 'question_text', key: 'q', width: 240,
            render: (t: string) => <Text style={{ fontSize: 12 }}>{t}</Text>,
          },
          {
            title: '你的答案', dataIndex: 'student_answer', key: 'sa', width: 80,
            render: (ans: string, q: any) => {
              if (q.is_correct === 1) return <Tag color="success">{ans || '✓'}</Tag>
              if (q.is_correct === 0) return <Tag color="error">{ans || '✗'}</Tag>
              return <Tag>-</Tag>
            },
          },
          {
            title: '正确答案', key: 'ca', width: 80,
            render: (_: any, q: any) => (
              <Text style={{ fontSize: 12, color: '#52c41a' }}>{q.correct_answer}</Text>
            ),
          },
          {
            title: '得分', dataIndex: 'score', key: 'sc', width: 44,
            render: (s: number) => <Text strong style={{ fontSize: 12 }}>{s}</Text>,
          },
          {
            title: '用时', dataIndex: 'time_spent', key: 'ts', width: 50,
            render: (t: number) => (
              <Space size={2}><ClockCircleOutlined style={{ fontSize: 11 }} />{t || 0}s</Space>
            ),
          },
          {
            title: '解析', dataIndex: 'explanation', key: 'exp', width: 200,
            render: (e: string) => <Text type="secondary" style={{ fontSize: 11 }}>{e}</Text>,
          },
        ]}
        scroll={{ x: 800 }}
      />
    )
  }

  const columns = [
    {
      title: '回合', dataIndex: 'id', key: 'id', width: 70,
      render: (id: number) => `#${id}`,
    },
    {
      title: '结果', key: 'status', width: 70,
      render: (_: any, r: QuestRecord) => getStatusTag(r),
    },
    {
      title: '答对/总题', key: 'count', width: 100,
      render: (_: any, r: QuestRecord) => (
        <Text strong style={{ color: getScoreColor(r.correct_count) }}>
          {r.correct_count} / {r.answered_count}
        </Text>
      ),
    },
    {
      title: '得分', dataIndex: 'score', key: 'score', width: 60,
      render: (s: number) => <Text strong>{s}</Text>,
    },
    {
      title: '终止', dataIndex: 'wrong_question_index', key: 'wrong', width: 60,
      render: (idx: number) => idx > 0 ? `第${idx}题` : '-',
    },
    {
      title: '时间', dataIndex: 'created_at', key: 'time', width: 130,
      render: (t: string) => t?.slice(0, 16) || '-',
    },
  ]

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 120 }}>
        <Spin size="large" description="加载中..." />
      </div>
    )
  }

  return (
    <div style={{ width: '100%', padding: 24 }}>
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
              ⚡ 知识闯关
            </Title>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14, whiteSpace: 'nowrap' }}>
              12 大领域 · 答错即止
            </Text>
            <Space size={4}>
              {questConfig?.use_bank ? (
                <DatabaseOutlined style={{ fontSize: 13, color: '#52c41a' }} />
              ) : (
                <RobotOutlined style={{ fontSize: 13, color: '#fff' }} />
              )}
              <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, fontWeight: 500 }}>
                {questConfig?.use_bank ? '📚 题库出题' : '🤖 AI 出题'}
              </Text>
              {bankStats && (
                <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
                  {bankStats.total_questions}题
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
                color: '#333',
                fontWeight: 600,
                boxShadow: '0 4px 14px rgba(255, 215, 0, 0.4)',
              }}
            >
              {starting ? '生成题目中...' : '🎯 开始闯关'}
            </Button>
            <Button
              ghost
              icon={<QuestionCircleOutlined />}
              onClick={() => setRulesOpen(true)}
            >
              规则
            </Button>
          </Space>
        </div>
      </Card>

      {/* ── 统计面板（一行显示） ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title="累计闯关"
            value={stats?.total_quests || 0}
            prefix={<HistoryOutlined />}
            suffix="次"
          />
        </Card>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title="🏅 闯关徽章"
            value={stats?.badge_count || 0}
            prefix={<CrownOutlined style={{ color: '#faad14' }} />}
            suffix="枚"
            styles={{ content: { color: '#faad14' } }}
          />
        </Card>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title="累计答对"
            value={stats?.total_correct || 0}
            prefix={<FireOutlined />}
            suffix="题"
          />
        </Card>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title="最佳战绩"
            value={stats?.best_correct || 0}
            prefix={<StarOutlined style={{ color: '#1677ff' }} />}
            suffix={`/ ${15} 题`}
            styles={{ content: { color: getScoreColor(stats?.best_correct || 0) } }}
          />
        </Card>
        <Card hoverable size="small" style={{ flex: 1, minWidth: 0 }}>
          <Statistic
            title="题库储备"
              value={bankStats?.total_questions || 0}
              prefix={<DatabaseOutlined style={{ color: '#722ed1' }} />}
              suffix="题"
              styles={{ content: { color: '#722ed1', fontSize: 22 } }}
            />
            {bankStats?.by_category && bankStats.by_category.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 11, color: '#999' }}>
                {bankStats.by_category.slice(0, 3).map((c: any) =>
                  `${c.category}${c.count}题`
                ).join(' · ')}
              </div>
            )}
          </Card>
      </div>

      {/* ── 历史记录（分页 + 展开） ── */}
      <Card title={<Space><HistoryOutlined /> 闯关记录</Space>}>
        <Table
          dataSource={records}
          columns={columns}
          rowKey="id"
          size="small"
          loading={loading}
          locale={{ emptyText: '还没有闯关记录，开始你的第一次挑战吧！' }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showQuickJumper: true,
            hideOnSinglePage: false,
            showTotal: (t, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${t} 条`,
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
        title="📋 闯关规则"
        open={rulesOpen}
        onCancel={() => setRulesOpen(false)}
        footer={<Button onClick={() => setRulesOpen(false)}>知道了</Button>}
        width={600}
      >
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <div>
            <Title level={5}>🎯 玩法</Title>
            <Paragraph>
              AI 即时生成百科单选题，涵盖 12 大知识领域。每轮最多 15 题，
              <Text strong>答错一题即终止</Text>！
            </Paragraph>
          </div>
          <div>
            <Title level={5}>⏱ 计时</Title>
            <Paragraph>每题限时 <Text strong>30 秒</Text>，超时视为答错。</Paragraph>
          </div>
          <div>
            <Title level={5}>🎯 三大锦囊（每轮各用一次）</Title>
            <Paragraph>
              <Text strong>去伪存真</Text>：去掉一个错误选项，变 3 选 1（得分 ×85%）<br />
              <Text strong>远程连线</Text>：AI 朋友给提示线索（得分 ×70%）<br />
              <Text strong>群策群力</Text>：100 位观众投票分布（得分 ×70%）
            </Paragraph>
          </div>
          <div>
            <Title level={5}>🏆 计分</Title>
            <Paragraph>
              第 1 题：10 分 → 2-3 题：15 分 → 4-6 题：20 分 →<br />
              7-9 题：25 分 → 10-12 题：30 分 → 13-15 题：<Text strong>50 分</Text>
            </Paragraph>
          </div>
          <div>
            <Title level={5}>🏅 徽章</Title>
            <Paragraph>
              每次闯关答对1题即可积累积分，全部通关获得 <Text strong>🏅 闯关徽章 ×1</Text>，可无限累积！<br />
              集齐里程碑还可解锁专属称号：🥉初出茅庐 → 🥈闯关新秀 → 🥇闯关达人 → 💎闯关大师 → 👑闯关传奇
            </Paragraph>
          </div>
        </Space>
      </Modal>
    </div>
  )
}

export default QuestPage
