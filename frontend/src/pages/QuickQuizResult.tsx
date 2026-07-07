/**
 * QuickQuizResult — 抢答活动结果页
 * 排行榜、每题回顾、个人成绩
 */
import React, { useState, useEffect } from 'react'
import {
  Card, Button, Typography, Space, Row, Col, Tag, Table,
  Spin, message, Collapse, Divider, Empty, Progress, Pagination,
} from 'antd'
import {
  TrophyOutlined, HomeOutlined, ThunderboltOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  CrownOutlined, FireOutlined, ClockCircleOutlined,
  TeamOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import FormulaRenderer from '../components/FormulaRenderer'
import MediaDisplay from '../components/MediaDisplay'

const { Title, Text } = Typography

const RANK_COLORS = ['#ff4d4f', '#fa8c16', '#faad14']

const QuickQuizResult: React.FC = () => {
  const { t } = useTranslation('interaction')
  const { roomId } = useParams<{ roomId: string }>()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)

  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [reviewPage, setReviewPage] = useState(1)
  const REVIEW_PAGE_SIZE = 10

  useEffect(() => {
    loadResult()
  }, [roomId])

  const loadResult = async () => {
    try {
      const { data } = await apiClient.get(`/api/quick-quiz/room/${roomId}/result`)
      setResult(data)
    } catch {
      message.error(t('loadResultFailed'))
      navigate('/quick-quiz')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh' }}>
        <Spin size="large" description={t('loading')} />
      </div>
    )
  }

  if (!result) {
    return (
      <div style={{ textAlign: 'center', paddingTop: 120 }}>
        <Title level={4}>{t('resultNotFound')}</Title>
        <Button type="primary" onClick={() => navigate('/quick-quiz')}>{t('back')}</Button>
      </div>
    )
  }

  const { room, ranking, questions, my_info } = result
  const myRank = ranking?.findIndex((r: any) => r.student_username === user?.username) + 1

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* 顶部统计 — 一行显示 */}
      <Card style={{
        borderRadius: 12, marginBottom: 16,
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }} styles={{ body: { padding: '16px 24px' } }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ThunderboltOutlined style={{ fontSize: 32, color: '#fff' }} />
            <Title level={4} style={{ color: '#fff', margin: 0 }}>{room.title}</Title>
            <Tag color={room.status === 'ended' ? 'default' : 'success'}>
              {room.status === 'ended' ? t('ended') : room.status}
            </Tag>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{t('totalQuestions')}</div>
              <div style={{ color: '#fff', fontSize: 20, fontWeight: 'bold' }}>{room.question_count}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{t('timeLimit')}</div>
              <div style={{ color: '#fff', fontSize: 20, fontWeight: 'bold' }}>{room.time_limit}s</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{t('participants')}</div>
              <div style={{ color: '#fff', fontSize: 20, fontWeight: 'bold' }}>{ranking?.length || 0}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{t('scoring')}</div>
              <div style={{ color: '#fff', fontSize: 20, fontWeight: 'bold' }}>
                {room.scoring_mode === 'speed' ? t('speedScoring') : t('tieredScoring')}
              </div>
            </div>
          </div>
        </div>
      </Card>

      {my_info && (
        <Card style={{ borderRadius: 12, marginBottom: 16 }} size="small">
          <Row gutter={24} style={{ textAlign: 'center' }}>
            <Col span={4}>
              <div style={{ fontSize: 13, color: '#888' }}>{t('myRank')}</div>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: myRank === 1 ? '#ff4d4f' : '#1677ff' }}>
                {myRank ? `#${myRank}` : '-'}
              </div>
            </Col>
            <Col span={5}>
              <div style={{ fontSize: 13, color: '#888' }}>{t('totalScore')}</div>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: '#faad14' }}>{my_info.total_score}</div>
            </Col>
            <Col span={5}>
              <div style={{ fontSize: 13, color: '#888' }}>{t('correctWrong')}</div>
              <div style={{ fontSize: 28, fontWeight: 'bold' }}>
                <span style={{ color: '#52c41a' }}>{my_info.correct_count}</span>
                <span style={{ color: '#ddd' }}> / </span>
                <span style={{ color: '#ff4d4f' }}>{my_info.wrong_count}</span>
              </div>
            </Col>
            <Col span={5}>
              <div style={{ fontSize: 13, color: '#888' }}>{t('accuracy')}</div>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: '#1677ff' }}>
                {my_info.correct_count + my_info.wrong_count > 0
                  ? `${Math.round(my_info.correct_count / (my_info.correct_count + my_info.wrong_count) * 100)}%`
                  : '-'
                }
              </div>
            </Col>
            <Col span={5}>
              <div style={{ fontSize: 13, color: '#888' }}>{t('maxStreak')}</div>
              <div style={{ fontSize: 28, fontWeight: 'bold', color: '#eb2f96' }}>
                {my_info.max_streak > 1 ? `🔥 ${my_info.max_streak}` : '-'}
              </div>
            </Col>
          </Row>
        </Card>
      )}

      {/* 排行榜 */}
      <Card title={<Space><TrophyOutlined /> {t('leaderboard')}</Space>}
        style={{ borderRadius: 12, marginBottom: 16 }}>
        <Table
          dataSource={ranking}
          rowKey="student_username"
          pagination={{ pageSize: 10, showTotal: (total) => t('totalPeople', { count: total }), showSizeChanger: false }}
          size="small"
          columns={[
            {
              title: t('rank'), key: 'rank', width: 60,
              render: (_: any, __: any, idx: number) => (
                <Text strong style={{
                  fontSize: 16,
                  color: idx < 3 ? RANK_COLORS[idx] : '#666',
                }}>
                  {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                </Text>
              ),
            },
            { title: t('name'), dataIndex: 'student_name', key: 'name', width: 100 },
            {
              title: t('totalScore'), dataIndex: 'total_score', key: 'score', width: 80,
              render: (s: number) => <Text strong style={{ color: '#faad14', fontSize: 16 }}>{s}</Text>,
              sorter: (a: any, b: any) => a.total_score - b.total_score,
              defaultSortOrder: 'descend',
            },
            {
              title: t('correct'), dataIndex: 'correct_count', key: 'correct', width: 60,
              render: (c: number) => <Text style={{ color: '#52c41a' }}>{c}</Text>,
            },
            {
              title: t('wrong'), dataIndex: 'wrong_count', key: 'wrong', width: 60,
              render: (w: number) => <Text style={{ color: '#ff4d4f' }}>{w}</Text>,
            },
            {
              title: t('accuracy'), key: 'accuracy', width: 80,
              render: (_: any, r: any) => {
                const total = (r.correct_count || 0) + (r.wrong_count || 0)
                if (!total) return '-'
                const pct = Math.round(r.correct_count / total * 100)
                return (
                  <Progress
                    type="circle"
                    percent={pct}
                    size={30}
                    strokeColor={pct >= 80 ? '#52c41a' : pct >= 50 ? '#faad14' : '#ff4d4f'}
                    format={(p) => `${p}%`}
                  />
                )
              },
            },
            {
              title: t('maxStreak'), dataIndex: 'max_streak', key: 'streak', width: 80,
              render: (s: number) => s > 1 ? <Tag color="volcano"><FireOutlined /> {t('streakN', { n: s })}</Tag> : '-',
            },
          ]}
        />
      </Card>

      {/* 每题回顾 */}
      <Card title={t('reviewTitle', { count: questions?.length || 0 })} style={{ borderRadius: 12 }}>
        {questions?.length === 0 ? (
          <Empty description={t('noQuestionData')} />
        ) : (
          <>
            <Collapse
              items={questions
                ?.slice((reviewPage - 1) * REVIEW_PAGE_SIZE, reviewPage * REVIEW_PAGE_SIZE)
                .map((q: any, idx: number) => ({
              key: String(idx),
              label: (
                <Space>
                    <Text strong>{t('questionN', { n: q.sort_order })}</Text>
                  <Tag color={q.correct_count > q.total_answers / 2 ? '#52c41a' : '#faad14'}>
                    {t('accuracy')}: {q.total_answers > 0 ? Math.round(q.correct_count / q.total_answers * 100) : 0}%
                  </Tag>
                  <Text style={{ flex: 1, maxWidth: 300 }} ellipsis>
                    <FormulaRenderer content={q.question_text} />
                  </Text>
                </Space>
              ),
              children: (
                <div>
                  <FormulaRenderer content={q.question_text} />
                  <MediaDisplay
                    svgContent={q.svg_content}
                    hasSvg={q.has_svg}
                    mediaFiles={q.media_files}
                  />
                  <div style={{ margin: '8px 0' }}>
                    {Object.entries(q.options || {}).map(([k, v]) => (
                      <Tag key={k} color={k === q.correct_answer ? '#52c41a' : 'default'}
                        style={{ margin: 4, padding: '2px 8px' }}>
                        {k}. <FormulaRenderer content={v as string} inline />
                        {k === q.correct_answer && ' ✅'}
                      </Tag>
                    ))}
                  </div>
                  <Space>
                    <CheckCircleOutlined style={{ color: '#52c41a' }} />
                    <Text strong style={{ color: '#52c41a' }}>{t('answer')}：{q.correct_answer}</Text>
                  </Space>
                  {q.explanation && (
                    <div style={{ marginTop: 8, padding: 8, background: '#f6f8fa', borderRadius: 6 }}>
                      <Text type="secondary">💡 </Text>
                      <FormulaRenderer content={q.explanation} />
                    </div>
                  )}
                  <Divider style={{ margin: '8px 0' }} />
                  <Text type="secondary">本题作答：{q.total_answers} 人，正确 {q.correct_count} 人</Text>
                  {q.option_stats && (
                    <div style={{ marginTop: 4 }}>
                      {Object.entries(q.option_stats).map(([k, v]: any) => (
                        <Text key={k} type="secondary" style={{ marginRight: 12 }}>
                          {k}: {v}人 ({q.total_answers > 0 ? Math.round(v / q.total_answers * 100) : 0}%)
                        </Text>
                      ))}
                    </div>
                  )}
                </div>
              ),
            })) || []}
            />
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <Pagination
                current={reviewPage}
                pageSize={REVIEW_PAGE_SIZE}
                total={questions?.length || 0}
                onChange={(p) => setReviewPage(p)}
                showSizeChanger={false}
                showTotal={(t) => `共 ${t} 题`}
              />
            </div>
          </>
        )}
      </Card>

      {/* 底部操作 */}
      <div style={{ textAlign: 'center', marginTop: 16, padding: 16 }}>
        <Space>
          <Button type="primary" icon={<ReloadOutlined />} onClick={loadResult}>
            刷新结果
          </Button>
          <Button icon={<HomeOutlined />} onClick={() => navigate('/quick-quiz')}>
            返回抢答主页
          </Button>
        </Space>
      </div>
    </Card>
  )
}

export default QuickQuizResult
