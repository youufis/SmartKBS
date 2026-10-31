/**
 * 首屏数字卡（一致性收口）
 *
 * 原来 8 张卡各写一遍 Card+Statistic+suffix，三处不一致：
 * ① 零值也照样拼进文案（"答卷0·0场 · 任务1"读起来像坏了）；
 * ② 整卡可点却没有 role/键盘可达；③ 颜色各写各的十六进制，深色主题没跟着变。
 * 这里统一：零值片段自动省略、可键盘操作、颜色取主题 token。
 *
 * 另外把 antd Statistic 换成自定义排版：Statistic 的默认结构把卡撑到 ~92px 高，
 * 而内容只有 50px，四张卡下方各留一条空白；数字与后缀也各占一行，读起来是断的。
 */
import React from 'react'
import { Card, Col } from 'antd'
import { useCountUp } from './useCountUp'
import { joinParts } from './fmt'

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
  const shown = useCountUp(Number(value) || 0)
  return (
    <Col xs={12} md={6}>
      <Card
        hoverable
        size="small"
        className="dash-card"
        style={{ height: '100%' }}
        styles={{ body: { padding: '12px 14px' } }}
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
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 32, height: 32, borderRadius: 9, flexShrink: 0,
              background: `${color}16`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            {React.cloneElement(icon as React.ReactElement<{ style?: React.CSSProperties }>, {
              style: { color, fontSize: 16 },
            })}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 12, lineHeight: 1.4, color: 'rgba(128,128,128,0.95)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {title}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2, color, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(shown).toLocaleString()}
              </span>
              {suffix && (
                <span style={{ fontSize: 11, color: 'rgba(128,128,128,0.95)' }}>{suffix}</span>
              )}
            </div>
          </div>
        </div>
      </Card>
    </Col>
  )
}

export default StatCard
