/**
 * 首屏数字卡（一致性收口）
 *
 * 原来 8 张卡各写一遍 Card+Statistic+suffix，三处不一致：
 * ① 零值也照样拼进文案（"答卷0·0场 · 任务1"读起来像坏了）；
 * ② 整卡可点却没有 role/键盘可达；③ 颜色各写各的十六进制，深色主题没跟着变。
 * 这里统一：零值片段自动省略、可键盘操作、颜色取主题 token。
 */
import React from 'react'
import { Card, Col, Typography } from 'antd'
import { DashStat } from './DashStat'
import { joinParts } from './fmt'

const { Text } = Typography

export interface StatCardProps {
  title: string
  value: number
  color: string
  icon: React.ReactElement
  /** 只填有意义的片段，0/空自动不显示 */
  parts?: (string | false | null | undefined)[]
  /** 一件都没有时的收尾文案（例如"都已批改完"） */
  emptyText?: string
  onGo?: () => void
}

const StatCard: React.FC<StatCardProps> = ({ title, value, color, icon, parts, emptyText, onGo }) => {
  const suffix = joinParts(parts ?? []) || emptyText || ''
  return (
    <Col xs={12} md={6}>
      <Card
        hoverable
        size="small"
        className="dash-card"
        style={{ height: '100%' }}
        onClick={onGo}
        role={onGo ? 'button' : undefined}
        tabIndex={onGo ? 0 : undefined}
        aria-label={suffix ? `${title} ${value}，${suffix}` : `${title} ${value}`}
        onKeyDown={(ev) => {
          if (!onGo) return
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault()
            onGo()
          }
        }}
      >
        <DashStat
          title={title}
          value={value}
          prefix={React.cloneElement(icon as React.ReactElement<{ style?: React.CSSProperties }>, { style: { color } })}
          styles={{ content: { color } }}
          suffix={suffix
            ? <Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>{suffix}</Text>
            : undefined}
        />
      </Card>
    </Col>
  )
}

export default StatCard