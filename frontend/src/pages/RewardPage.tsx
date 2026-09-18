import React, { useState, useEffect, useCallback } from 'react'
import {
  Card, Table, Tabs, Button, Space, Typography, Tag, message,
  Spin, Empty, Statistic, Row, Col, Select, Tooltip, Progress,
  Collapse, Modal, Divider,
} from 'antd'
import {
  TrophyOutlined, HistoryOutlined, TeamOutlined,
  StarOutlined, ThunderboltOutlined, RiseOutlined,
  FireOutlined, BookOutlined, MessageOutlined,
  RobotOutlined, AuditOutlined, CheckCircleFilled,
  LockFilled, ReloadOutlined, CrownOutlined, GiftOutlined,
  LoginOutlined, CodeOutlined, ReadOutlined, FolderOpenOutlined, NotificationOutlined,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { useRewardLabels, REWARD_TAG_COLORS } from '../utils/rewardLabels'

const { Title, Text } = Typography

// 与 backend/reward_engine.py 的 ACTIVITY_TYPE_NAMES 一一对应（18 类），名称走词典 reward.activityType.*
const ACTIVITY_ICONS: Record<string, React.ReactNode> = {
  quiz: <ThunderboltOutlined style={{ color: '#1677ff' }} />,
  poll: <TeamOutlined style={{ color: '#722ed1' }} />,
  question: <MessageOutlined style={{ color: '#13c2c2' }} />,
  exam: <BookOutlined style={{ color: '#52c41a' }} />,
  practice: <RobotOutlined style={{ color: '#fa8c16' }} />,
  discussion: <TeamOutlined style={{ color: '#eb2f96' }} />,
  rollcall: <AuditOutlined style={{ color: '#faad14' }} />,
  chat: <MessageOutlined style={{ color: '#1677ff' }} />,
  task: <FireOutlined style={{ color: '#ff4d4f' }} />,
  learning: <RiseOutlined style={{ color: '#52c41a' }} />,
  login: <LoginOutlined style={{ color: '#faad14' }} />,
  code: <CodeOutlined style={{ color: '#13c2c2' }} />,
  quest: <CrownOutlined style={{ color: '#fa8c16' }} />,
  quick_quiz: <ThunderboltOutlined style={{ color: '#ff4d4f' }} />,
  course_practice: <ReadOutlined style={{ color: '#52c41a' }} />,
  resource_view: <FolderOpenOutlined style={{ color: '#1677ff' }} />,
  daily_discovery: <StarOutlined style={{ color: '#722ed1' }} />,
  news_view: <NotificationOutlined style={{ color: '#eb2f96' }} />,
}

// 学科 emoji 映射（可扩展，不在列表中的科目按名称 hash 分配）
const SUBJECT_EMOJI_MAP: Record<string, string> = {
  '信息科技': '💻',
  '通用技术': '🔧',
  '人工智能': '🤖',
  '信息技术': '💻',
  '通用': '🔧',
  '数学': '📐',
  '语文': '📖',
  '英语': '🌍',
  '物理': '⚛️',
  '化学': '🧪',
  '生物': '🧬',
  '历史': '📜',
  '地理': '🌏',
  '政治': '⚖️',
}

const FALLBACK_EMOJIS = ['📚', '🔬', '🎨', '🎵', '🏛️', '🧮', '🗺️', '🔭', '⚗️', '🖥️']

function getSubjectEmoji(subject: string): string {
  if (SUBJECT_EMOJI_MAP[subject]) return SUBJECT_EMOJI_MAP[subject]
  // 按名称 hash 分配 fallback emoji
  const hash = subject.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return FALLBACK_EMOJIS[hash % FALLBACK_EMOJIS.length]
}

const COLOR_MAP: Record<string, string> = {
  lime: '#a0d911', green: '#52c41a', cyan: '#13c2c2',
  blue: '#1677ff', geekblue: '#2f54eb', purple: '#722ed1',
  magenta: '#eb2f96', gold: '#faad14', orange: '#fa8c16',
  volcano: '#fa541c', red: '#f5222d', default: '#d9d9d9',
}

interface MainTitle { level: number; name: string; emoji: string; color: string; desc: string; min_points?: number }
interface TitleProgress { current: MainTitle; next: MainTitle | null; progress_percent: number; points_needed: number }
interface SubjectTitle { subject: string; question_count: number; level: number; name: string; emoji: string; color: string }
interface BadgeItem { badge_id: string; name: string; icon: string; desc: string; unlocked: boolean; unlocked_at?: string }
interface TitleInfo {
  main_title: MainTitle; progress: TitleProgress
  subject_titles: SubjectTitle[]; badges: BadgeItem[]
  recent_upgrades: Array<{ old_title: string; new_title: string; title_type: string; subject: string; created_at: string }>
}

// ── 主称号卡片 ──
const TitleCard: React.FC<{ info: TitleInfo }> = ({ info }) => {
  const { t } = useTranslation('score')
  const { main_title, progress } = info
  const color = COLOR_MAP[main_title.color] || '#d9d9d9'
  const bgColor = main_title.color === 'default' ? '#f5f5f5' : `${color}15`
  return (
    <Card style={{
      background: `linear-gradient(135deg, ${bgColor} 0%, #fff 100%)`,
      border: `1px solid ${color}40`, borderRadius: 12, marginBottom: 16,
    }}>
      <Row align="middle" gutter={[24, 16]}>
        <Col xs={24} sm={6} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 56, lineHeight: 1 }}>{main_title.emoji}</div>
          <Tag color={main_title.color !== 'default' ? main_title.color : undefined}
            style={{ fontSize: 16, padding: '2px 16px', marginTop: 8, borderRadius: 12 }}>
            Lv.{main_title.level} {main_title.name}
          </Tag>
        </Col>
        <Col xs={24} sm={18}>
          <Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>{main_title.desc}</Text>
          {progress.next ? (
            <>
              <Row align="middle" gutter={12}>
                <Col flex="auto">
                  <Progress percent={progress.progress_percent} strokeColor={color}
                    trailColor={`${color}20`} format={(percent) => `${percent}%`} size="small" />
                </Col>
                <Col>
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    {t('reward.pointsToNext', { points: progress.points_needed })}
                  </Text>
                </Col>
              </Row>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('reward.nextLevel', { emoji: progress.next.emoji, name: progress.next.name })}</Text>
            </>
          ) : (
            <Text type="secondary" style={{ fontSize: 13 }}>{t('reward.maxLevel')}</Text>
          )}
        </Col>
      </Row>
    </Card>
  )
}

// ── 称号一览 ──
const TitleDirectory: React.FC<{ titleConfig: MainTitle[]; currentLevel: number }> = ({ titleConfig, currentLevel }) => {
  const { t } = useTranslation('score')
  return (
  <Collapse ghost items={[{
    key: 'titles',
    label: <Text strong><CrownOutlined /> {t('reward.allTitles', { count: titleConfig.length })}</Text>,
    children: (
      <Row gutter={[8, 8]}>
        {titleConfig.map((title) => {
          const unlocked = currentLevel >= title.level
          const color = COLOR_MAP[title.color] || '#d9d9d9'
          return (
            <Col xs={12} sm={8} md={6} key={title.level}>
              <Card size="small" style={{
                opacity: unlocked ? 1 : 0.5,
                border: unlocked ? `1px solid ${color}40` : '1px dashed #d9d9d9',
                background: unlocked ? `${color}08` : '#fafafa', textAlign: 'center',
              }}>
                <div style={{ fontSize: 28, marginBottom: 4 }}>{title.emoji}</div>
                <Tag color={unlocked && title.color !== 'default' ? title.color : undefined} style={{ fontSize: 11, margin: 0 }}>Lv.{title.level}</Tag>
                <div style={{ fontSize: 13, fontWeight: unlocked ? 600 : 400, marginTop: 2 }}>{title.name}</div>
                {unlocked
                  ? <CheckCircleFilled style={{ color: '#52c41a', fontSize: 14, marginTop: 2 }} />
                  : <LockFilled style={{ color: '#d9d9d9', fontSize: 14, marginTop: 2 }} />}
                <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                  {unlocked ? t('reward.unlocked') : t('reward.unlockAt', { points: title.min_points || '?' })}
                </div>
              </Card>
            </Col>
          )
        })}
      </Row>
    ),
  }]} />
  )
}

// ── 学科称号卡片 ──
const SubjectTitleCards: React.FC<{ titles: SubjectTitle[] }> = ({ titles }) => {
  const { t } = useTranslation('score')
  return (
  <Row gutter={[12, 12]}>
    {titles.map((st) => {
      const color = COLOR_MAP[st.color] || '#d9d9d9'
      const emoji = st.emoji || getSubjectEmoji(st.subject)
      return (
        <Col xs={24} sm={8} key={st.subject}>
          <Card size="small" style={{ borderLeft: `4px solid ${color}`, borderRadius: 8 }}>
            <Space orientation="vertical" size={2} style={{ width: '100%' }}>
              <Space><span style={{ fontSize: 20 }}>{emoji}</span><Text strong>{st.subject}</Text></Space>
              <Tag color={st.color !== 'default' ? st.color : undefined} style={{ alignSelf: 'flex-start' }}>
                {emoji} Lv.{st.level} {st.name}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('reward.answeredQuestions', { count: st.question_count })}</Text>
            </Space>
          </Card>
        </Col>
      )
    })}
  </Row>
  )
}

// ── 成就徽章墙 ──
const BadgeWall: React.FC<{ badges: BadgeItem[] }> = ({ badges }) => {
  const { t } = useTranslation('score')
  const unlockedCount = badges.filter((b) => b.unlocked).length
  return (
    <div>
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        {t('reward.badgesUnlocked', { unlocked: unlockedCount, total: badges.length })}
      </Text>
      <Row gutter={[12, 12]}>
        {badges.map((badge) => (
          <Col xs={12} sm={8} md={6} lg={4} key={badge.badge_id}>
            <Tooltip title={badge.desc}>
              <Card size="small" hoverable style={{
                textAlign: 'center', opacity: badge.unlocked ? 1 : 0.5,
                background: badge.unlocked ? '#fff' : '#fafafa',
                border: badge.unlocked ? '1px solid #e8e8e8' : '1px dashed #e8e8e8',
                cursor: 'default', borderRadius: 12,
              }}>
                <div style={{ fontSize: 36, marginBottom: 4, filter: badge.unlocked ? 'none' : 'grayscale(100%)' }}>{badge.icon}</div>
                <Text strong style={{ fontSize: 12 }}>{badge.name}</Text><br />
                {badge.unlocked
                  ? <Text style={{ fontSize: 10, color: '#52c41a' }}>{t('reward.unlocked')}</Text>
                  : <Text style={{ fontSize: 10, color: '#999' }}>{t('reward.locked')}</Text>}
              </Card>
            </Tooltip>
          </Col>
        ))}
      </Row>
    </div>
  )
}

// ── 升级历程 ──
const UpgradeTimeline: React.FC<{ upgrades: TitleInfo['recent_upgrades'] }> = ({ upgrades }) => {
  const { t } = useTranslation('score')
  if (upgrades.length === 0) return <Empty description={t('reward.noUpgrades')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
  return (
    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
      {upgrades.map((u, i) => {
        const isBadge = u.title_type === 'badge'
        const isSubject = u.title_type === 'subject'
        const isMain = u.title_type === 'main'
        return (
          <div key={i} style={{
            display: 'flex', gap: 12, padding: '8px 0',
            borderBottom: i < upgrades.length - 1 ? '1px solid #f0f0f0' : 'none',
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: 4,
              background: isBadge ? '#faad14' : isSubject ? '#1677ff' : '#52c41a',
              marginTop: 6, flexShrink: 0,
            }} />
            <div>
              {isMain && <Text style={{ fontSize: 13 }}>{t('reward.upgradeMain', { old: u.old_title, newTitle: u.new_title })}</Text>}
              {isSubject && <Text style={{ fontSize: 13 }}>{t('reward.upgradeSubject', { subject: u.subject, old: u.old_title, newTitle: u.new_title })}</Text>}
              {isBadge && <Text style={{ fontSize: 13 }}>{t('reward.upgradeBadge', { newTitle: u.new_title })}</Text>}
              <br /><Text type="secondary" style={{ fontSize: 11 }}>{u.created_at?.slice(0, 16) || ''}</Text>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── 积分转称号（前端 fallback） ──
const pointsToTitle = (points: number, config: MainTitle[]): MainTitle => {
  if (config.length > 0) {
    let result = config[0]
    for (const t of config) {
      if (points >= (t.min_points || 0)) result = t
    }
    return result
  }
  // 无配置时 fallback
  if (points >= 800) return { level: 12, name: '至高贤者', emoji: '✨', color: 'red', desc: '' }
  if (points >= 640) return { level: 11, name: '传奇大师', emoji: '👑', color: 'volcano', desc: '' }
  if (points >= 520) return { level: 10, name: '全能学神', emoji: '🏆', color: 'orange', desc: '' }
  if (points >= 420) return { level: 9, name: '创新领袖', emoji: '🧠', color: 'gold', desc: '' }
  if (points >= 330) return { level: 8, name: '班级学霸', emoji: '🌟', color: 'magenta', desc: '' }
  if (points >= 250) return { level: 7, name: '学业先锋', emoji: '🚀', color: 'purple', desc: '' }
  if (points >= 180) return { level: 6, name: '逻辑新星', emoji: '⚡', color: 'geekblue', desc: '' }
  if (points >= 120) return { level: 5, name: '解题能手', emoji: '💡', color: 'blue', desc: '' }
  if (points >= 75) return { level: 4, name: '知识猎人', emoji: '🔍', color: 'cyan', desc: '' }
  if (points >= 40) return { level: 3, name: '勤学新人', emoji: '📖', color: 'green', desc: '' }
  if (points >= 15) return { level: 2, name: '筑基学徒', emoji: '🌱', color: 'lime', desc: '' }
  return { level: 1, name: '初窥门径', emoji: '🥚', color: 'default', desc: '' }
}

// ── 教师个人积分面板（独立组件避免 IIFE 中调用 hooks） ──
const TeacherMyPoints: React.FC = () => {
  const { t } = useTranslation('score')
  const { actLabel, rewardTypeLabel } = useRewardLabels()
  const [tMyPoints, setTMyPoints] = useState(0)
  const [tMyHistory, setTMyHistory] = useState<any[]>([])
  useEffect(() => {
    let ignore = false
    const load = async () => {
      try {
        const [p, h] = await Promise.all([
          apiClient.get('/api/rewards/my-points'),
          apiClient.get('/api/rewards/my-history', { params: { limit: 100 } }),
        ])
        if (!ignore) {
          setTMyPoints(p.data.total_points || 0)
          setTMyHistory(Array.isArray(h.data) ? h.data : [])
        }
      } catch { /* ignore */ }
    }
    load()
    return () => { ignore = true }
  }, [])
  return (
    <>
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Card>
            <Statistic title={t('reward.myTotalPoints')} value={tMyPoints} prefix={<TrophyOutlined style={{ color: '#faad14' }} />} />
          </Card>
        </Col>
      </Row>
      <Table dataSource={tMyHistory} rowKey="id" size="small" pagination={{ pageSize: 15 }}
        columns={[
          { title: t('time'), dataIndex: 'created_at', render: (val: string) => val?.slice(0, 16) || '', width: 140 },
          { title: t('activity'), dataIndex: 'activity_type', width: 96,
            render: (type: string, record: any) => (
              <Tag icon={ACTIVITY_ICONS[type]}>{actLabel(type, record.activity_type_name)}</Tag>
            ) },
          { title: t('activityName'), dataIndex: 'activity_title', ellipsis: true },
          { title: t('rewardType'), dataIndex: 'reward_type', width: 100,
            render: (type: string, record: any) => (
              <Tag color={REWARD_TAG_COLORS[type] || 'default'}>{rewardTypeLabel(type, record.reward_type_name)}</Tag>
            ) },
          { title: t('points'), dataIndex: 'points', width: 70, render: (p: number) => <Text strong style={{ color: '#52c41a' }}>+{p}</Text> },
          { title: t('description'), dataIndex: 'reason', ellipsis: true },
        ]}
      />
    </>
  )
}

const RewardPage: React.FC = () => {
  const { t } = useTranslation('score')
  const { actLabel, rewardTypeLabel } = useRewardLabels()
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const isStudent = user?.role === 'student'

  const [myPoints, setMyPoints] = useState<number>(0)
  const [myHistory, setMyHistory] = useState<any[]>([])
  const [titleInfo, setTitleInfo] = useState<TitleInfo | null>(null)
  const [titleConfig, setTitleConfig] = useState<MainTitle[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState('my')
  const [rulesOpen, setRulesOpen] = useState(false)

  // ── 积分规则（数值与 backend/reward_engine.py 的 REWARD_CONFIG 一致，改那边记得同步这里）──
  // 活动名一律走词典 reward.activityType.*，emoji 只是装饰；graded=是否还有成绩等级奖励
  const RULES: Array<{ type: string; emoji: string; base: number; graded: boolean }> = [
    { type: 'quiz', emoji: '📝', base: 2, graded: true },
    { type: 'poll', emoji: '📊', base: 2, graded: false },
    { type: 'question', emoji: '🙋', base: 2, graded: false },
    { type: 'exam', emoji: '📖', base: 2, graded: true },
    { type: 'practice', emoji: '🤖', base: 2, graded: true },
    { type: 'discussion', emoji: '💬', base: 2, graded: true },
    { type: 'rollcall', emoji: '✅', base: 2, graded: false },
    { type: 'chat', emoji: '💭', base: 2, graded: false },
    { type: 'task', emoji: '📋', base: 2, graded: true },
    { type: 'learning', emoji: '📈', base: 2, graded: false },
    { type: 'login', emoji: '🔑', base: 1, graded: false },
    { type: 'code', emoji: '💻', base: 2, graded: true },
    { type: 'quest', emoji: '🎮', base: 1, graded: true },
    { type: 'quick_quiz', emoji: '⚡', base: 2, graded: true },
    { type: 'course_practice', emoji: '📚', base: 2, graded: true },
    { type: 'resource_view', emoji: '🗂️', base: 1, graded: false },
    { type: 'daily_discovery', emoji: '✨', base: 1, graded: false },
    { type: 'news_view', emoji: '📰', base: 1, graded: false },
  ]

  // ── 等级头像成长进化表（与 PortfolioPage / AppLayout 保持一致） ──
  const LEVEL_AVATARS = [
    { level: 'Lv.1', emoji: '🪴' },
    { level: 'Lv.2', emoji: '🌱' },
    { level: 'Lv.3', emoji: '🌿' },
    { level: 'Lv.4', emoji: '🌳' },
    { level: 'Lv.5', emoji: '🎯' },
    { level: 'Lv.6', emoji: '🔮' },
    { level: 'Lv.7', emoji: '🚀' },
    { level: 'Lv.8', emoji: '🌟' },
    { level: 'Lv.9', emoji: '🌙' },
    { level: 'Lv.10', emoji: '☀️' },
    { level: 'Lv.11', emoji: '👑' },
    { level: 'Lv.12', emoji: '💎' },
  ]

  // 教师端：班级排名
  const [grades, setGrades] = useState<string[]>([])
  const [selectedGrade, setSelectedGrade] = useState<string>('')
  const [selectedClass, setSelectedClass] = useState<string>('')
  const [classes, setClasses] = useState<string[]>([])
  const [ranking, setRanking] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
  const [rankingLoading, setRankingLoading] = useState(false)

  // 加载年级列表
  useEffect(() => {
    if (isTeacherOrAdmin) {
      apiClient.get('/api/config/subjects').then(({ data }) => {
        if (data?.subjects?.length > 0) {
          // 从用户信息获取年级
          apiClient.get('/api/scores/my-grades').then(({ data: grades }) => {
            if (Array.isArray(grades) && grades.length > 0) {
              setGrades(grades)
              setSelectedGrade(grades[0])
            }
          }).catch(() => {})
        }
      }).catch(() => {})
    }
  }, [isTeacherOrAdmin])

  // 加载班级列表
  useEffect(() => {
    if (selectedGrade) {
      apiClient.get('/api/scores/classes', { params: { grade: selectedGrade } }).then(({ data }) => {
        setClasses(Array.isArray(data) ? data : [])
      }).catch(() => {})
    }
  }, [selectedGrade])

  // 加载排名
  const loadRanking = useCallback(async () => {
    if (!selectedGrade) return
    setRankingLoading(true)
    try {
      const params: any = { grade: selectedGrade }
      if (selectedClass) params.class_name = selectedClass
      const [rankRes, statsRes] = await Promise.all([
        apiClient.get('/api/rewards/ranking', { params }),
        apiClient.get('/api/rewards/statistics', { params }),
      ])
      setRanking(Array.isArray(rankRes.data) ? rankRes.data : [])
      setStats(statsRes.data || null)
    } catch (err: any) {
      // R3/R8: 后端会按任教范围拦截(403), 必须显示原因, 否则界面看起来像坏了
      setRanking([])
      setStats(null)
      message.warning(err?.response?.data?.detail || t('loadFailed'))
    } finally {
      setRankingLoading(false)
    }
  }, [selectedGrade, selectedClass, t])

  useEffect(() => {
    if (!isTeacherOrAdmin || !selectedGrade) return
    let ignore = false
    const fetchData = async () => {
      setRankingLoading(true)
      try {
        const params: any = { grade: selectedGrade }
        if (selectedClass) params.class_name = selectedClass
        const [rankRes, statsRes] = await Promise.all([
          apiClient.get('/api/rewards/ranking', { params }),
          apiClient.get('/api/rewards/statistics', { params }),
        ])
        if (!ignore) {
          setRanking(Array.isArray(rankRes.data) ? rankRes.data : [])
          setStats(statsRes.data || null)
        }
      } catch (err: any) {
        if (!ignore) {
          setRanking([])
          setStats(null)
          message.warning(err?.response?.data?.detail || t('loadFailed'))
        }
      }
      if (!ignore) setRankingLoading(false)
    }
    fetchData()
    return () => { ignore = true }
  }, [isTeacherOrAdmin, selectedGrade, selectedClass])

  useEffect(() => {
    if (!isStudent) return
    let ignore = false
    const fetchData = async () => {
      setLoading(true)
      try {
        const [pointsRes, historyRes] = await Promise.all([
          apiClient.get('/api/rewards/my-points'),
          apiClient.get('/api/rewards/my-history', { params: { limit: 100 } }),
        ])
        if (!ignore) {
          setMyPoints(pointsRes.data.total_points || 0)
          setMyHistory(Array.isArray(historyRes.data) ? historyRes.data : [])
        }
      } catch { /* 忽略 */ }
      if (!ignore) setLoading(false)
    }
    fetchData()
    return () => { ignore = true }
  }, [isStudent])
  // 称号信息加载函数（供初始化和按钮刷新使用）
  const fetchTitleInfo = useCallback(async (ignoreRef?: { current: boolean }) => {
    try {
      const [titleRes, configRes] = await Promise.all([
        apiClient.get('/api/rewards/my-title'),
        apiClient.get('/api/rewards/title-config'),
      ])
      if (!ignoreRef?.current) {
        setTitleInfo(titleRes.data)
        if (configRes.data?.main_titles) setTitleConfig(configRes.data.main_titles)
      }
    } catch { /* 忽略 */ }
  }, [])

  useEffect(() => {
    if (!isStudent) return
    const ignore = { current: false }
    const load = async () => {
      try {
        const [titleRes, configRes] = await Promise.all([
          apiClient.get('/api/rewards/my-title'),
          apiClient.get('/api/rewards/title-config'),
        ])
        if (!ignore.current) {
          setTitleInfo(titleRes.data)
          if (configRes.data?.main_titles) setTitleConfig(configRes.data.main_titles)
        }
      } catch { /* 忽略 */ }
    }
    load()
    return () => { ignore.current = true }
  }, [isStudent])

  // 学生视图：称号 + 积分
  // ── 积分规则弹窗 ──
  const renderRulesModal = () => (
    <Modal title={t('reward.rulesTitle')} open={rulesOpen} onCancel={() => setRulesOpen(false)} footer={null} width={640}>
      <Table dataSource={RULES} rowKey="type" size="small" pagination={false}
        columns={[
          { title: t('activity'), dataIndex: 'type', width: 150,
            render: (type: string, record: any) => (
              <Space size={6}><span>{record.emoji}</span><span>{actLabel(type)}</span></Space>
            ) },
          { title: t('reward.basePoints'), dataIndex: 'base', width: 100, render: (v: number) => <Tag color="blue">+{v}</Tag> },
          { title: t('reward.gradeReward'), dataIndex: 'graded',
            render: (v: boolean) => v
              ? <Text style={{ color: '#52c41a' }}>{t('reward.gradeScale')}</Text>
              : <Text type="secondary">{t('reward.none')}</Text> },
        ]} />
      <Divider />
      <Text strong style={{ fontSize: 14 }}>{t('reward.levelAvatarEvolution')}</Text>
      <Table dataSource={LEVEL_AVATARS} rowKey="level" size="small" pagination={false} style={{ marginTop: 8 }}
        columns={[
          { title: t('levelLabel'), dataIndex: 'level', width: 60, render: (lvl: string) => <Tag>{lvl}</Tag> },
          { title: t('reward.avatar'), dataIndex: 'emoji', width: 60, render: (em: string) => <span style={{ fontSize: 22 }}>{em}</span> },
          { title: t('reward.titleRange'), key: 'range', render: (_: unknown, record: any) => <Text style={{ fontSize: 13 }}>{t(`reward.levelRange${record.level.replace('Lv.', '')}`)}</Text> },
        ]} />
    </Modal>
  )

  const renderStudentView = () => (
    <Spin spinning={loading}>
      {renderRulesModal()}
      {/* 主称号卡片 */}
      {titleInfo && <TitleCard info={titleInfo} />}

      {/* 三维成长 Tabs */}
      <Card style={{ marginBottom: 16 }} size="small">
        <Tabs defaultActiveKey="main" size="small"
          tabBarStyle={{ display: 'flex', justifyContent: 'space-around' }}
          items={[
            {
              key: 'main',
              label: <span><CrownOutlined /> {t('reward.mainTitle')}</span>,
              children: (
                <div>
                  <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                    <Col xs={12} sm={6}>
                      <Card size="small">
                        <Statistic title={t('totalScore')} value={myPoints}
                          prefix={<TrophyOutlined style={{ color: '#faad14' }} />}
                          styles={{ content: { color: '#faad14', fontSize: 24, fontWeight: 'bold' } }} suffix={t('portfolio.pointsSuffix')} />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small">
                        <Statistic title={t('reward.participationCount')} value={myHistory.length}
                          prefix={<ThunderboltOutlined style={{ color: '#1677ff' }} />}
                          styles={{ content: { color: '#1677ff' } }} />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small">
                        <Statistic title={t('reward.rewardCount')} value={myHistory.filter(h => h.reward_type !== 'participation').length}
                          prefix={<StarOutlined style={{ color: '#52c41a' }} />}
                          styles={{ content: { color: '#52c41a' } }} />
                      </Card>
                    </Col>
                    <Col xs={12} sm={6}>
                      <Card size="small">
                        <Statistic title={t('reward.badgeCount')} value={titleInfo?.badges?.filter((b: BadgeItem) => b.unlocked).length || 0}
                          prefix={<GiftOutlined style={{ color: '#faad14' }} />}
                          styles={{ content: { color: '#faad14' } }} suffix={`/ ${titleInfo?.badges?.length || 0}`} />
                      </Card>
                    </Col>
                  </Row>
                  {titleConfig.length > 0 && (
                    <TitleDirectory titleConfig={titleConfig} currentLevel={titleInfo?.main_title?.level || 1} />
                  )}
                  {titleInfo?.recent_upgrades && titleInfo.recent_upgrades.length > 0 && (
                    <Card size="small" title={<Space><HistoryOutlined /> {t('reward.upgradeHistory')}</Space>} style={{ marginTop: 12 }}>
                      <UpgradeTimeline upgrades={titleInfo.recent_upgrades} />
                    </Card>
                  )}
                </div>
              ),
            },
            {
              key: 'subject',
              label: <span><BookOutlined /> {t('reward.subjectTitle')}</span>,
              children: (
                <div>
                  {titleInfo?.subject_titles ? (
                    <>
                      <SubjectTitleCards titles={titleInfo.subject_titles} />
                      <Button type="link" icon={<ReloadOutlined />} size="small" style={{ marginTop: 8 }}
                        onClick={async () => {
                          try {
                            const { data } = await apiClient.post('/api/rewards/update-subject-counts')
                            if (data?.upgrades?.length > 0) message.success(t('reward.subjectUpgraded', { count: data.upgrades.length }))
                            await fetchTitleInfo()
                          } catch { message.error(t('updateFailed')) }
                        }}>
                        {t('reward.refreshSubjectData')}
                      </Button>
                    </>
                  ) : <Empty description={t('reward.noSubjectData')} />}
                </div>
              ),
            },
            {
              key: 'badges',
              label: <span><GiftOutlined /> {t('reward.achievementBadges')}</span>,
              children: (
                <div>
                  {titleInfo?.badges ? (
                    <>
                      <BadgeWall badges={titleInfo.badges} />
                      <Button type="link" icon={<ReloadOutlined />} size="small" style={{ marginTop: 8 }}
                        onClick={async () => {
                          try {
                            const { data } = await apiClient.post('/api/rewards/check-badges')
                            if (data?.newly_unlocked?.length > 0) message.success(t('unlockedBadges', { count: data.newly_unlocked.length }))
                            else message.info(t('noNewBadges'))
                            await fetchTitleInfo()
                          } catch { message.error(t('detectFailed')) }
                        }}>
                        {t('reward.redetectBadges')}
                      </Button>
                    </>
                  ) : <Empty description={t('reward.noBadgeData')} />}
                </div>
              ),
            },
          ]} />
      </Card>

      {/* 积分流水 */}
      <Card title={<Space><HistoryOutlined /> {t('reward.pointDetails')}</Space>}>
        {myHistory.length === 0 ? (
          <Empty description={t('reward.noPointRecords')} />
        ) : (
          <Table dataSource={myHistory} rowKey="id" size="small"
            pagination={{ pageSize: 15, showTotal: (total) => t('totalRecords', { count: total }) }}
            columns={[
              { title: t('time'), dataIndex: 'created_at', width: 140, render: (val: string) => val ? val.slice(0, 16) : '' },
              // 活动名走词典：原来把 activity_type 首字母大写，中英文界面显示的都是裸键名
              { title: t('activity'), dataIndex: 'activity_type', width: 96,
                render: (type: string, record: any) => (
                  <Tag icon={ACTIVITY_ICONS[type]}>{actLabel(type, record.activity_type_name)}</Tag>
                ) },
              { title: t('activityName'), dataIndex: 'activity_title', ellipsis: true },
              { title: t('rewardType'), dataIndex: 'reward_type', width: 100,
                render: (type: string, record: any) => (
                  <Tag color={REWARD_TAG_COLORS[type] || 'default'}>{rewardTypeLabel(type, record.reward_type_name)}</Tag>
                ) },
              { title: t('points'), dataIndex: 'points', width: 70,
                render: (points: number) => <Text strong style={{ color: points > 2 ? '#52c41a' : '#1677ff', fontSize: 15 }}>+{points}</Text> },
              { title: t('description'), dataIndex: 'reason', ellipsis: true },
            ]} />
        )}
      </Card>
    </Spin>
  )

  // 教师视图：排名与统计
  const renderTeacherView = () => (
    <div>
      {/* 筛选条件 */}
      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            value={selectedGrade}
            onChange={v => { setSelectedGrade(v); setSelectedClass('') }}
            style={{ width: 150 }}
            placeholder={t('selectGrade')}
          >
            {grades.map(g => <Select.Option key={g} value={g}>{g}</Select.Option>)}
          </Select>
          <Select
            value={selectedClass}
            onChange={setSelectedClass}
            style={{ width: 180 }}
            placeholder={t('reward.selectClassAll')}
            allowClear
          >
            {classes.map(c => <Select.Option key={c} value={c}>{c}</Select.Option>)}
          </Select>
          <Button type="primary" icon={<RiseOutlined />} onClick={loadRanking}>
            {t('reward.refreshRanking')}
          </Button>
        </Space>
      </Card>

      {/* 统计概览 */}
      {stats && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title={t('totalScore')} value={stats.total_points} prefix={<TrophyOutlined />} styles={{ content: { color: '#faad14' } }} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title={t('reward.participantCount')} value={stats.participant_count} prefix={<TeamOutlined />} styles={{ content: { color: '#1677ff' } }} />
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" title={t('reward.activityDistribution')}>
              <Space wrap>
                {Object.entries(stats.activity_breakdown || {}).map(([type, info]: any) => (
                  <Tag key={type} icon={ACTIVITY_ICONS[type]} color="processing">
                    {actLabel(type, info.name)}: {info.points}{t('score')}
                  </Tag>
                ))}
              </Space>
            </Card>
          </Col>
        </Row>
      )}

      {/* 排名表 */}
      <Card title={
        <Space><TrophyOutlined style={{ color: '#faad14' }} /> {t('reward.studentRanking')}</Space>
      }>
        <Spin spinning={rankingLoading}>
          {ranking.length === 0 ? (
            <Empty description={selectedGrade ? t('noData') : t('reward.selectGradeFirst')} />
          ) : (
            <Table
              dataSource={ranking}
              rowKey="username"
              size="small"
              pagination={{ pageSize: 30, showTotal: (total) => t('totalStudents', { count: total }) }}
              columns={[
                {
                  title: t('rank'), dataIndex: 'rank', key: 'rank', width: 60,
                  render: (rank: number) => {
                    if (rank === 1) return <Tag color="gold">🥇 1</Tag>
                    if (rank === 2) return <Tag color="silver">🥈 2</Tag>
                    if (rank === 3) return <Tag color="bronze">🥉 3</Tag>
                    return <Text type="secondary">{rank}</Text>
                  },
                },
                {
                  title: t('name'), dataIndex: 'name', key: 'name',
                  render: (name: string, record: any) => (
                    <Text strong>{name || record.username}</Text>
                  ),
                },
                {
                  title: t('username'), dataIndex: 'username', key: 'username',
                },
                {
                  title: t('grade'), dataIndex: 'grade', key: 'grade', width: 90,
                  render: (v: string) => v || '-',
                },
                {
                  title: t('class_'), dataIndex: 'class_name', key: 'class_name', width: 110,
                  render: (v: string) => v || '-',
                },
                {
                  title: t('totalScore'), dataIndex: 'total_points', key: 'total_points', width: 100,
                  render: (points: number) => (
                    <Text strong style={{ color: '#fa8c16', fontSize: 16 }}>{points}</Text>
                  ),
                  sorter: (a: any, b: any) => a.total_points - b.total_points,
                  defaultSortOrder: 'descend' as const,
                },
                {
                  title: t('levelLabel'), key: 'level', width: 140,
                  render: (_: any, record: any) => {
                    const title = pointsToTitle(record.total_points, titleConfig)
                    return <Tooltip title={`Lv.${title.level} ${title.name}`}>
                      <Tag color={title.color !== 'default' ? title.color : undefined}>{title.emoji} Lv.{title.level} {title.name}</Tag>
                    </Tooltip>
                  },
                },
                {
                  title: t('reward.nextLevelCol'), key: 'next', width: 100,
                  render: (_: any, record: any) => {
                    const title = pointsToTitle(record.total_points, titleConfig)
                    const next = titleConfig.find(c => c.level === title.level + 1)
                    if (!next) return <Text type="secondary">{t('reward.maxLevelReached')}</Text>
                    return <Text type="secondary" style={{ fontSize: 12 }}>{t('reward.nextPointsNeeded', { points: next.min_points! - record.total_points })}</Text>
                  },
                },
              ]}
            />
          )}
        </Spin>
      </Card>
    </div>
  )

  return (
    <div>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space>
            <TrophyOutlined style={{ fontSize: 24, color: '#faad14' }} />
            <Title level={4} style={{ margin: 0 }}>{t('reward.pageTitle')}</Title>
          </Space>
          <Button type="link" icon={<TrophyOutlined />} onClick={() => setRulesOpen(true)}>
            {t('scoreRules')}
          </Button>
        </div>

        {isStudent ? renderStudentView() : (
          <Tabs activeKey={activeTab} onChange={setActiveTab}>
            <Tabs.TabPane tab={<span><TrophyOutlined /> {t('scoreRank')}</span>} key="my">
              {renderTeacherView()}
            </Tabs.TabPane>
            <Tabs.TabPane tab={<span><HistoryOutlined /> {t('myScore')}</span>} key="history">
              <TeacherMyPoints />
            </Tabs.TabPane>
          </Tabs>
        )}
      </Card>
    </div>
  )
}

export default RewardPage

