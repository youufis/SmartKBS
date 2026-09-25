/** 欢迎横幅：学生（画像头像/称号/积分/排名/连签/考试倒计时）教师·管理员（任教范围/学科/在线） */
import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Progress, Tag, Typography } from 'antd'
import {
  FireOutlined, TeamOutlined, ExperimentOutlined, TrophyOutlined,
} from '@ant-design/icons'
import { getTodayPortrait } from '../../api/portrait'
import type { PortraitData } from '../../api/portrait'
import { teacherScopeText } from '../../utils/studentLabel'
import { deadlineInfo } from './fmt'
import type { DashboardSummary } from '../../api/dashboard'
import { reportLoadError } from '../../utils/loadError'

const { Text } = Typography

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
  const [portrait, setPortrait] = useState<PortraitData | null>(null)

  useEffect(() => {
    if (!isStudent) return
    let cancelled = false
    getTodayPortrait().then((res) => {
      if (!cancelled && res.exists && res.portrait && !res.portrait.deleted) setPortrait(res.portrait)
    }).catch((err) => { if (!cancelled) reportLoadError(err, { key: 'dashboard.TodayPortrait' }) })
    return () => { cancelled = true }
  }, [isStudent])

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
      background: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
      borderRadius: 10,
      border: 'none',
    }} styles={{ body: { padding: '12px 20px' } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {isStudent && (
          <div
            onClick={() => navigate('/portrait')}
            title={t('banner.portraitHint')}
            style={{
              width: 44, height: 44, borderRadius: '50%', overflow: 'hidden', flexShrink: 0,
              background: 'rgba(255,255,255,0.25)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: '2px solid rgba(255,255,255,0.6)',
            }}
          >
            {portrait?.image_url ? (
              <img src={portrait.image_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ fontSize: 22 }}>🎓</span>
            )}
          </div>
        )}
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
          <span style={{ marginLeft: 'auto', fontSize: 14, color: '#fff', whiteSpace: 'nowrap' }}>
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
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'rgba(255,255,255,0.9)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {isAdmin && (
              <span><TeamOutlined /> {t('currentOnline')}: {summary.online_count ?? 0}</span>
            )}
            {isTeacher && summary.teacher_grades && (
              <span><TeamOutlined /> {teacherScopeText(summary.teacher_grades, summary.teacher_classes)}</span>
            )}
            {isTeacher && summary.teacher_subjects && summary.teacher_subjects.length > 0 && (
              <span><ExperimentOutlined style={{ marginRight: 4 }} />{t('welcome.teaching')}{summary.teacher_subjects.join('、')}</span>
            )}
          </span>
        )}
      </div>
    </Card>
  )
}

export default WelcomeBanner
