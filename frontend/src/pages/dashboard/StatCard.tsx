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
import { Card, Col, Tooltip } from 'antd'
import { useCountUp } from './useCountUp'

export interface StatCardProps {
  title: string
  value?: number
  color: string
  icon: React.ReactElement
  /** 只填有意义的片段，0/空自动不显示 */
  parts?: (string | false | null | undefined)[]
  /** 一件都没有时的收尾文案（例如"都已批改完"） */
  emptyText?: string
  /** 首页降噪：value 为 0 时大数字位置换成这句鼓励文案（"0"不当主角） */
  zeroText?: string
  /** 文本主值（如称号名）：给了它就替代数字大位 */
  textValue?: string
  /** 0-100 细进度条（称号升级进度用） */
  progress?: number
  /** 悬停补充信息（徽章数等） */
  tip?: string
  /** 自定义栅格（嵌进左列时用 2×2） */
  span?: { xs?: number; md?: number; lg?: number }
  onGo?: () => void
}

const StatCard: React.FC<StatCardProps> = ({ title, value, color, icon, parts, emptyText, zeroText, textValue, progress, tip, span, onGo }) => {
  // 片段内 nowrap：窄屏换行只发生在片段之间，不再出现「考试 / 2」孤行
  const validParts = (parts ?? []).filter((x) => x !== false && x !== null && x !== undefined && x !== '') as string[]
  const suffix = validParts.join(' · ') || emptyText || ''
  const num = Number(value) || 0
  const shown = useCountUp(num)
  const zeroShown = !textValue && num === 0 && !!zeroText
  const cardEl = (
      <Card
        hoverable
        size="small"
        className="dash-card"
        style={{ height: '100%' }}
        styles={{ body: { padding: '12px 14px' } }}
        onClick={onGo}
        role={onGo ? 'button' : undefined}
        tabIndex={onGo ? 0 : undefined}
        aria-label={suffix ? `${title} ${textValue ?? value ?? 0}，${suffix}` : `${title} ${textValue ?? value ?? 0}`}
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
              className="dash-stat-title"
              style={{
                fontSize: 12, lineHeight: 1.4, color: 'rgba(128,128,128,0.95)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {title}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              {textValue ? (
                <span style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.3, color, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {textValue}
                </span>
              ) : zeroShown ? (
                <span style={{ fontSize: 13, lineHeight: 1.4, color: 'rgba(128,128,128,0.95)' }}>{zeroText}</span>
              ) : (
                <span style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.2, color, fontVariantNumeric: 'tabular-nums' }}>
                  {Math.round(shown).toLocaleString()}
                </span>
              )}
              {!zeroShown && suffix && (
                <span style={{ fontSize: 11, color: 'rgba(128,128,128,0.95)', display: 'inline-flex', flexWrap: 'wrap', gap: '0 4px' }}>
                  {validParts.length > 0
                    ? validParts.map((p, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <span aria-hidden>·</span>}
                        <span style={{ whiteSpace: 'nowrap' }}>{p}</span>
                      </React.Fragment>
                    ))
                    : emptyText}
                </span>
              )}
            </div>
            {typeof progress === 'number' && (
              <div aria-hidden style={{ marginTop: 7, height: 4, borderRadius: 2, background: `${color}22`, overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, Math.max(0, progress))}%`, height: '100%', background: color, borderRadius: 2, transition: 'width .4s' }} />
              </div>
            )}
          </div>
        </div>
      </Card>
    )
  return (
    <Col xs={span?.xs ?? 12} md={span?.md ?? 6} lg={span?.lg ?? 6}>
      {tip ? <Tooltip title={tip} placement="bottom">{cardEl}</Tooltip> : cardEl}
    </Col>
  )
}

export default StatCard
