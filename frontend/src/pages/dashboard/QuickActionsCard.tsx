/** 快捷入口：按角色配置的高频功能瓦片格（图标色块底 + 文字，比_plain 按钮更强的点击 affordance） */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, Col, Row, Space } from 'antd'
import {
  AuditOutlined, BarChartOutlined, BookOutlined, BulbOutlined, CheckCircleOutlined,
  DatabaseOutlined, FileAddOutlined, FireOutlined, MessageOutlined, PictureOutlined,
  ProfileOutlined, RobotOutlined, RocketOutlined, TeamOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import { useChartTheme, withAlpha, type ChartColorToken } from './chartTheme'

type IconCmp = React.ComponentType<{ style?: React.CSSProperties }>

interface QuickAction {
  key: string
  Icon: IconCmp
  color: ChartColorToken
  labelKey: string
}

/** 收敛到 8 个真正高频的入口；色表只存主题令牌名，深色自动跟随 */
const STUDENT_ACTIONS: QuickAction[] = [
  { key: '/chat', Icon: MessageOutlined, color: 'primary', labelKey: 'aiChat' },
  { key: '/exam', Icon: FileAddOutlined, color: 'cyan', labelKey: 'onlineExam' },
  { key: '/task-todo', Icon: CheckCircleOutlined, color: 'success', labelKey: 'quick.taskTodo' },
  { key: '/wrong-book', Icon: BookOutlined, color: 'danger', labelKey: 'quick.wrongBook' },
  { key: '/quest', Icon: FireOutlined, color: 'warning', labelKey: 'quick.quest' },
  { key: '/practice', Icon: RocketOutlined, color: 'success', labelKey: 'quick.practice' },
  { key: '/daily-discovery', Icon: BulbOutlined, color: 'magenta', labelKey: 'quick.discovery' },
  { key: '/portrait', Icon: PictureOutlined, color: 'cyan', labelKey: 'quick.portrait' },
]

const TEACHER_ACTIONS: QuickAction[] = [
  { key: '/exam', Icon: FileAddOutlined, color: 'cyan', labelKey: 'examPublish' },
  { key: '/interaction', Icon: ThunderboltOutlined, color: 'danger', labelKey: 'quick.quizManage' },
  { key: '/rollcall', Icon: AuditOutlined, color: 'warning', labelKey: 'smartRollcall' },
  { key: '/question-bank', Icon: DatabaseOutlined, color: 'purple', labelKey: 'quick.questionBank' },
  { key: '/tasks', Icon: ProfileOutlined, color: 'success', labelKey: 'quick.tasks' },
  { key: '/analytics', Icon: BarChartOutlined, color: 'cyan', labelKey: 'quick.analytics' },
  { key: '/class-summary', Icon: RobotOutlined, color: 'gold', labelKey: 'quick.classSummary' },
  { key: '/chat', Icon: MessageOutlined, color: 'primary', labelKey: 'aiChat' },
]

const ADMIN_EXTRA: QuickAction[] = [
  { key: '/user-mgmt', Icon: TeamOutlined, color: 'primary', labelKey: 'quick.userMgmt' },
  { key: '/system-config', Icon: AuditOutlined, color: 'danger', labelKey: 'quick.systemConfig' },
]

const QuickActionsCard: React.FC<{ isStudent: boolean; isAdmin: boolean }> = ({ isStudent, isAdmin }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const actions = isStudent ? STUDENT_ACTIONS : [...TEACHER_ACTIONS, ...(isAdmin ? ADMIN_EXTRA : [])]
  return (
    <Card size="small" title={<Space><ThunderboltOutlined style={{ color: ct.gold }} />{t('quickNav')}</Space>}>
      <Row gutter={[8, 8]}>
        {actions.map((a) => {
          const color = ct[a.color]
          return (
            <Col span={8} xl={6} key={a.key}>
              <button
                type="button"
                className="dash-quick-tile"
                onClick={() => navigate(a.key)}
                style={{
                  '--qc': color,
                  '--qc-bg': withAlpha(color, 0.07),
                  '--qc-border': withAlpha(color, 0.35),
                  '--qc-tint': withAlpha(color, 0.13),
                } as React.CSSProperties}
              >
                <span className="dash-quick-icon" aria-hidden>
                  <a.Icon style={{ color, fontSize: 17 }} />
                </span>
                <span className="dash-quick-label">{t(a.labelKey)}</span>
              </button>
            </Col>
          )
        })}
      </Row>
    </Card>
  )
}

export default QuickActionsCard
