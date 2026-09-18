/** 快捷入口：按角色配置的高频功能九宫格 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Col, Row, Space } from 'antd'
import {
  AuditOutlined, BarChartOutlined, BookOutlined, BulbOutlined, CheckCircleOutlined,
  DatabaseOutlined, FireOutlined, GlobalOutlined, MessageOutlined, PictureOutlined,
  ProfileOutlined, RobotOutlined, RocketOutlined, TeamOutlined, ThunderboltOutlined,
  TrophyOutlined, FileAddOutlined,
} from '@ant-design/icons'

type IconCmp = React.ComponentType<{ style?: React.CSSProperties }>

interface QuickAction {
  key: string
  Icon: IconCmp
  color: string
  labelKey: string
}

const STUDENT_ACTIONS: QuickAction[] = [
  { key: '/chat', Icon: MessageOutlined, color: '#1677ff', labelKey: 'aiChat' },
  { key: '/exam', Icon: FileAddOutlined, color: '#13c2c2', labelKey: 'onlineExam' },
  { key: '/task-todo', Icon: CheckCircleOutlined, color: '#52c41a', labelKey: 'quick.taskTodo' },
  { key: '/wrong-book', Icon: BookOutlined, color: '#ff4d4f', labelKey: 'quick.wrongBook' },
  { key: '/quest', Icon: FireOutlined, color: '#fa8c16', labelKey: 'quick.quest' },
  { key: '/quick-quiz', Icon: ThunderboltOutlined, color: '#722ed1', labelKey: 'quick.quickQuiz' },
  { key: '/discussion', Icon: TeamOutlined, color: '#2f54eb', labelKey: 'groupDiscussion' },
  { key: '/daily-discovery', Icon: BulbOutlined, color: '#eb2f96', labelKey: 'quick.discovery' },
  { key: '/news-hub', Icon: GlobalOutlined, color: '#faad14', labelKey: 'quick.news' },
  { key: '/showcase', Icon: TrophyOutlined, color: '#d48806', labelKey: 'quick.showcase' },
  { key: '/portrait', Icon: PictureOutlined, color: '#08979c', labelKey: 'quick.portrait' },
  { key: '/practice', Icon: RocketOutlined, color: '#389e0d', labelKey: 'quick.practice' },
]

const TEACHER_ACTIONS: QuickAction[] = [
  { key: '/chat', Icon: MessageOutlined, color: '#1677ff', labelKey: 'aiChat' },
  { key: '/exam', Icon: FileAddOutlined, color: '#13c2c2', labelKey: 'examPublish' },
  { key: '/interaction', Icon: ThunderboltOutlined, color: '#ff4d4f', labelKey: 'quick.quizManage' },
  { key: '/rollcall', Icon: AuditOutlined, color: '#fa8c16', labelKey: 'smartRollcall' },
  { key: '/question-bank', Icon: DatabaseOutlined, color: '#722ed1', labelKey: 'quick.questionBank' },
  { key: '/tasks', Icon: ProfileOutlined, color: '#52c41a', labelKey: 'quick.tasks' },
  { key: '/quick-quiz', Icon: FireOutlined, color: '#eb2f96', labelKey: 'quick.quickQuiz' },
  { key: '/discussion', Icon: TeamOutlined, color: '#2f54eb', labelKey: 'groupDiscussion' },
  { key: '/analytics', Icon: BarChartOutlined, color: '#08979c', labelKey: 'quick.analytics' },
  { key: '/class-summary', Icon: RobotOutlined, color: '#d48806', labelKey: 'quick.classSummary' },
  { key: '/activity-monitor', Icon: CheckCircleOutlined, color: '#389e0d', labelKey: 'quick.activityMonitor' },
  { key: '/shared-center', Icon: GlobalOutlined, color: '#faad14', labelKey: 'quick.sharedCenter' },
]

const ADMIN_EXTRA: QuickAction[] = [
  { key: '/user-mgmt', Icon: TeamOutlined, color: '#1677ff', labelKey: 'quick.userMgmt' },
  { key: '/system-config', Icon: AuditOutlined, color: '#f5222d', labelKey: 'quick.systemConfig' },
]

const QuickActionsCard: React.FC<{ isStudent: boolean; isAdmin: boolean }> = ({ isStudent, isAdmin }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const actions = isStudent ? STUDENT_ACTIONS : [...TEACHER_ACTIONS, ...(isAdmin ? ADMIN_EXTRA : [])]
  return (
    <Card size="small" title={<Space><ThunderboltOutlined style={{ color: '#faad14' }} />{t('quickNav')}</Space>}>
      <Row gutter={[8, 8]}>
        {actions.map((a) => (
          <Col span={6} xl={4} key={a.key}>
            <Button
              block
              size="small"
              icon={<a.Icon style={{ color: a.color, fontSize: 16 }} />}
              onClick={() => navigate(a.key)}
              style={{ height: 44 }}
            >
              <span style={{ fontSize: 12 }}>{t(a.labelKey)}</span>
            </Button>
          </Col>
        ))}
      </Row>
    </Card>
  )
}

export default QuickActionsCard
