/** 学生"今日要事"卡（降噪版）：徽标只报「今天要做 N 项」（与任务清单同口径），露 3 行，
 *  底部分布行删除、换成一句规则化鼓励；"完整清单"进任务清单简化态。 */
import React, { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Empty, Space, Tag, Tooltip, Typography } from 'antd'
import { ArrowRightOutlined, FireOutlined, PushpinOutlined } from '@ant-design/icons'
import type { TaskTodoItem, TaskTodoResponse } from '../../api/taskTodo'
import type { EncouragePick } from './encourage'
import { parseMs } from './encourage'
import { deadlineInfo } from './fmt'
import { useNow } from './useNow'
import { useChartTheme } from './chartTheme'

const { Text } = Typography

interface Props {
  todo: TaskTodoResponse | null
  loading?: boolean
  todayMust: number
  enc: EncouragePick | null
}

const TodoFocusCard: React.FC<Props> = ({ todo, loading, todayMust, enc }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()
  const now = useNow()

  const items = useMemo<TaskTodoItem[]>(() => {
    if (!todo?.items?.length) return []
    const active = todo.items.filter((i) => i.status !== 'completed')
    // 紧迫度优先：逾期 → 今天截止 → 课堂进行中 → 其余按截止时间
    const rank = (it: TaskTodoItem) => {
      const dl = deadlineInfo(it.deadline, new Date(now))
      if (dl?.level === 'overdue') return 0
      if (dl?.level === 'today') return 1
      if (it.live && !it.suggest) return 2
      return 3
    }
    return [...active]
      .sort((a, b) => {
        const r = rank(a) - rank(b)
        if (r) return r
        const da = parseMs(a.deadline) || Number.MAX_SAFE_INTEGER
        const db = parseMs(b.deadline) || Number.MAX_SAFE_INTEGER
        if (da !== db) return da - db
        return (b.priority ?? 0) - (a.priority ?? 0)
      })
      .slice(0, 3)
  }, [todo, now])

  const streak = todo?.stats?.streak_days ?? 0

  return (
    <Card
      size="small"
      title={
        <Space>
          <PushpinOutlined style={{ color: ct.primary }} />
          <span>{t('todoCard.title')}</span>
          {todayMust > 0 && (
            <Tag color="orange" style={{ margin: 0 }}>{t('todoCard.todayMust', { n: todayMust })}</Tag>
          )}
        </Space>
      }
      extra={
        <Space size={8}>
          {streak > 0 && (
            <Tooltip title={t('statsS2.streakTip')}>
              <Tag color="volcano" style={{ margin: 0 }}><FireOutlined /> {t('todoCard.streak', { n: streak })}</Tag>
            </Tooltip>
          )}
          <Button type="link" size="small" onClick={() => navigate('/task-todo?simple=1')}>
            {t('todoCard.viewAll')} <ArrowRightOutlined style={{ fontSize: 10 }} />
          </Button>
        </Space>
      }
      loading={loading}
      styles={{ body: { padding: items.length ? '4px 16px 8px' : '8px 16px 16px' } }}
    >
      {items.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 13 }}>{t('enc.todayCalm')}</Text>
          }
        />
      ) : (
        items.map((item) => {
          const dl = deadlineInfo(item.deadline, new Date(now))
          const level = dl?.level ?? 'later'
          const dotColor = level === 'overdue' ? ct.danger : level === 'today' ? ct.gold : ct.primary
          const dlText = dl
            ? dl.level === 'overdue'
              ? t('todo.deadline.overdue', { days: dl.overdueDays })
              : dl.level === 'today'
                ? t('todo.deadline.today', { hours: dl.hoursLeft })
                : t('todo.deadline.remaining', { days: dl.days })
            : ''
          return (
            <div
              key={item.id}
              className="dash-row"
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 6px', margin: '0 -6px',
                borderBottom: '1px solid rgba(128,128,128,0.12)', cursor: 'pointer',
              }}
              role="button"
              tabIndex={0}
              aria-label={item.title}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); navigate(item.url) } }}
              onClick={() => navigate(item.url)}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Space size={6}>
                  <Text strong style={{ fontSize: 13 }} ellipsis={{ tooltip: item.title }}>
                    {item.title}
                  </Text>
                  <Tag style={{ fontSize: 10, lineHeight: '16px', margin: 0 }} color={level === 'overdue' ? 'red' : level === 'today' ? 'orange' : 'default'}>
                    {t(`todo.type.${item.type}`, { defaultValue: item.type })}
                  </Tag>
                </Space>
                {dlText && (
                  <div><Text type="secondary" style={{ fontSize: 11, color: dotColor }}>{dlText}</Text></div>
                )}
              </div>
              <Button size="small" type="primary" ghost style={{ flexShrink: 0 }}
                onClick={(e) => { e.stopPropagation(); navigate(item.url) }}>
                {t(`todo.action.${item.type}`, { defaultValue: item.action_label || t('todoCard.go') })}
              </Button>
            </div>
          )
        })
      )}
      {/* 分布行已删：换成一句规则化鼓励（全页鼓励句≤2 处，此处占其一） */}
      {items.length > 0 && enc && (
        <div style={{ marginTop: 10 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{t(`enc.${enc.key}`, enc.params ?? {})}</Text>
        </div>
      )}
    </Card>
  )
}

export default TodoFocusCard
