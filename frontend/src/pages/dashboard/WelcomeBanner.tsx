/** 欢迎横幅：三种角色共用「当前头像」（本期画像或固定的往期画像，都没有则角色默认头像）；学生另显示称号/积分/排名/连签/考试倒计时，教师·管理员显示任教范围与在线 */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Progress, Tag, Typography } from 'antd'
import {
  FireOutlined, TeamOutlined, TrophyOutlined,
} from '@ant-design/icons'
import { getAvatarInfo } from '../../api/portrait'
import type { AvatarInfo } from '../../api/portrait'
import TeacherScopeChips from '../../components/TeacherScopeChips'
import { deadlineInfo } from './fmt'
import type { DashboardSummary } from '../../api/dashboard'
import { reportLoadError } from '../../utils/loadError'

const { Text } = Typography

/** 批次4：早/午/晚各一套渐变，首屏随时间有变化 */
const TIME_THEME: Record<string, { bg: string }> = {
  morning: { bg: 'linear-gradient(135deg, #1677ff 0%, #0ea5e9 100%)' },
  afternoon: { bg: 'linear-gradient(135deg, #0958d9 0%, #1677ff 100%)' },
  evening: { bg: 'linear-gradient(135deg, #531dab 0%, #0958d9 100%)' },
}

interface Props {
  summary: DashboardSummary
  todoTotal: number
  isStudent: boolean
  isTeacher: boolean
  isAdmin: boolean
}

const WelcomeBanner: React.FC<Props> = ({ summary, todoTotal, isStudent, isTeacher, isAdmin }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const [avatar, setAvatar] = useState<AvatarInfo | null>(null)

  // 头像位走 /portrait/avatar：本期画像、用户固定的往期画像都从这一条只读接口出
  // （不复用 /today —— 它每次调用都会给画像浏览量 +1，首页每开一次就涨一次）
  useEffect(() => {
    let cancelled = false
    getAvatarInfo().then((res) => {
      if (!cancelled) setAvatar(res.avatar)
    }).catch((err) => { if (!cancelled) reportLoadError(err, { key: 'dashboard.Avatar' }) })
    return () => { cancelled = true }
  }, [])

  const avatarUrl = avatar?.image_url || ''

  const hour = new Date().getHours()
  const timeKey = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const roleKey = isStudent ? 'student' : isTeacher ? 'teacher' : 'admin'
  const roleText = t(`welcome.${roleKey}`)
  const displayName = summary.user_name || ''
  // 昵称里已含角色词（如管理员账号名就是「管理员」）时不再重复拼接
  const roleSuffix = displayName.includes(roleText) ? '' : roleText

  // 最近一场待考考试的截止倒计时
  const nextDeadline = isStudent && summary.pending_exams && summary.pending_exams.length > 0
    ? deadlineInfo(summary.pending_exams[0].end_time)
    : null

  return (
    <Card style={{
      marginBottom: 16,
      background: TIME_THEME[timeKey].bg,
      borderRadius: 10,
      border: 'none',
    }} styles={{ body: { padding: '12px 20px' } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* 头像位：当前头像（本期或固定的往期画像）；没有 → 角色默认头像（管理员 ⚜️ / 其余 🎓），点击进画像页 */}
        <div
          onClick={() => navigate('/portrait')}
          title={avatarUrl ? t('banner.portraitHint') : t('banner.portraitDefaultHint')}
          style={{
            width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
            background: 'rgba(255,255,255,0.25)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid rgba(255,255,255,0.6)',
          }}
        >
          {avatarUrl ? (
            <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: 22 }}>{isAdmin ? '⚜️' : '🎓'}</span>
          )}
        </div>
        <span style={{ fontSize: 16, fontWeight: 600, whiteSpace: 'nowrap', color: '#fff' }}>
          {t('welcome.greeting', { time: t(`welcome.${timeKey}`), name: displayName, role: roleSuffix })}
        </span>
        {isStudent && summary.title_name && (
          <Tag style={{ fontSize: 13, padding: '0 10px', borderRadius: 10, margin: 0 }}
            color={summary.title_color !== 'default' ? summary.title_color : undefined}>
            {summary.title_emoji} {summary.title_name}
          </Tag>
        )}
        {isStudent && (summary.streak_days ?? 0) > 0 && (
          <Tag color="volcano" style={{ margin: 0, borderRadius: 10 }}>
            <FireOutlined /> {t('welcome.streak', { n: summary.streak_days })}
          </Tag>
        )}
        {isStudent && nextDeadline && (
          <Tag color={nextDeadline.level === 'overdue' ? 'red' : nextDeadline.level === 'today' ? 'orange' : 'blue'}
            style={{ margin: 0, borderRadius: 10 }}>
            {nextDeadline.level === 'overdue'
              ? t('welcome.overdueDays', { n: nextDeadline.overdueDays })
              : nextDeadline.level === 'today'
                ? t('welcome.dueToday', { h: nextDeadline.hoursLeft })
                : t('welcome.daysToExam', { n: nextDeadline.days })}
          </Tag>
        )}
        {!isStudent && (
          <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, whiteSpace: 'nowrap' }}>
            {t('welcome.teacherPrompt')}
          </span>
        )}
        {isStudent && (
          <span className="banner-student-meta" style={{ marginLeft: 'auto', fontSize: 14, color: '#fff', whiteSpace: 'nowrap' }}>
            <TrophyOutlined style={{ marginRight: 4 }} />
            {t('welcome.score')} <Text strong style={{ color: '#fff', fontSize: 18 }}>{summary.total_score ?? 0}</Text>
            <Text style={{ color: 'rgba(255,255,255,0.7)', marginLeft: 8, fontSize: 13 }}>
              · {t('welcome.rank')} {summary.rank ?? '-'}
            </Text>
            {summary.title_name && summary.next_title_name && (
              <Progress percent={summary.title_progress ?? 0} size="small" strokeColor="#fff"
                railColor="rgba(255,255,255,0.3)" format={() => ''}
                style={{ width: 80, display: 'inline-flex', marginLeft: 8, verticalAlign: 'middle' }} />
            )}
            <Text style={{ color: 'rgba(255,255,255,0.3)', margin: '0 8px' }}>|</Text>
            <Button size="small" type="text" style={{ color: '#fff', padding: 0 }} icon={<span>📋</span>}
              onClick={() => navigate('/task-todo')}>
              {t('welcome.taskList')}
              <Tag style={{ marginLeft: 4, fontSize: 10, borderRadius: 8, background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', lineHeight: '16px' }}>
                {todoTotal}
              </Tag>
            </Button>
            <Text style={{ color: 'rgba(255,255,255,0.3)', margin: '0 8px' }}>|</Text>
            <Button size="small" type="text" style={{ color: '#fff', padding: 0 }} icon={<span>🧠</span>}
              onClick={() => navigate('/chat?companion=1')}>
              {t('welcome.aiCompanion')}
            </Button>
          </span>
        )}
        {(isTeacher || isAdmin) && (
          <span className="banner-teacher-meta" style={{ marginLeft: 'auto', maxWidth: '62%', display: 'inline-flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'rgba(255,255,255,0.9)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {isAdmin && (
              <span><TeamOutlined /> {t('currentOnline')}: {summary.online_count ?? 0}</span>
            )}
            {isTeacher && (
              <TeacherScopeChips
                scope={summary.teacher_scope}
                legacyGrades={summary.teacher_grades}
                legacyClasses={summary.teacher_classes}
                legacySubjects={summary.teacher_subjects}
              />
            )}
          </span>
        )}
      </div>
    </Card>
  )
}

export default WelcomeBanner
