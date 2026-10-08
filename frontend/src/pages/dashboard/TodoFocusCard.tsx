/** 学生"今日要事"卡：逾期/紧急优先 Top 项 + 直达按钮 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button, Card, Empty, Space, Tag, Tooltip, Typography } from 'antd'
import { ArrowRightOutlined, FireOutlined } from '@ant-design/icons'
import type { TaskTodoItem, TaskTodoResponse } from '../../api/taskTodo'
import { deadlineInfo } from './fmt'
import { useChartTheme } from './chartTheme'

const { Text } = Typography

interface Props {
  todo: TaskTodoResponse | null
  loading?: boolean
}

const TodoFocusCard: React.FC<Props> = ({ todo, loading }) => {
  const navigate = useNavigate()
  const { t } = useTranslation('dashboard')
  const ct = useChartTheme()

  const items: TaskTodoItem[] = React.useMemo(() => {
    if (!todo?.items?.length) return []
    const active = todo.items.filter((i) => i.status !== 'completed')
    return [...active]
      .sort((a, b) => {
        const da = a.deadline ? new Date(a.deadline.replace(' ', 'T')).getTime() : Infinity
        const db = b.deadline ? new Date(b.deadline.replace(' ', 'T')).getTime() : Infinity
        if (da !== db) return da - db
        return (b.priority ?? 0) - (a.priority ?? 0)
      })
      .slice(0, 4)
  }, [todo])

  const streak = todo?.stats?.streak_days ?? 0
  const totalActive = todo?.items?.filter((i) => i.status !== 'completed').length ?? 0
  // 分类分布按"未完成的要事"自己统计：todo.counts 是各板块计数，与标题的 N 项不同口径，
  // 两个数并排显示只会让人以为数据错了
  const allTypes = Object.entries(
    (todo?.items ?? [])
      .filter((x) => x.status !== 'completed')
      .reduce<Record<string, number>>((acc, x) => {
        acc[x.type] = (acc[x.type] ?? 0) + 1
        return acc
      }, {}),
  )
    .filter(([, c]) => Number(c) > 0)
    .sort((x, y) => y[1] - x[1])
  const typeSummary = allTypes.slice(0, 6)
  const restTypes = allTypes.slice(6)
  const restCount = restTypes.reduce((a, [, c]) => a + Number(c), 0)

  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      title={
        <Space>
          <span>📌</span>
          <span>{t('todoCard.title')}</span>
          {totalActive > 0 && <Tag color="blue" style={{ margin: 0 }}>{t('todoCard.count', { n: totalActive })}</Tag>}
        </Space>
      }
      extra={
        <Space size={8}>
          {streak > 0 && (
            <Tag color="volcano" style={{ margin: 0 }}><FireOutlined /> {t('todoCard.streak', { n: streak })}</Tag>
          )}
          <Button type="link" size="small" onClick={() => navigate('/task-todo')}>
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
            <Text type="secondary" style={{ fontSize: 13 }}>{t('todoCard.empty')}</Text>
          }
        />
      ) : (
        items.map((item) => {
          const dl = deadlineInfo(item.deadline)
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
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0',
                borderBottom: '1px solid rgba(128,128,128,0.12)', cursor: 'pointer',
              }}
              role="button"
              tabIndex={0}
              aria-label={item.title}
              onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); navigate(item.url) } }}
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
          {restCount > 0 && (
            <Tooltip title={restTypes.map(([kk, cc]) => `${t(`todo.type.${kk}`, { defaultValue: kk })} ${cc}`).join('、')}>
              <span>+{restCount}</span>
            </Tooltip>
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
      {items.length > 0 && typeSummary.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12, color: ct.tick }}>
          {typeSummary.map(([k, c]) => (
            <span key={k}>
              {t(`todo.type.${k}`, { defaultValue: k })}
              <strong style={{ marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{c}</strong>
            </span>
          ))}
        </div>
      )}

    </Card>
  )
}

export default TodoFocusCard
