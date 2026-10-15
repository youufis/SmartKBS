/**
 * 答题页的题号导航（练习 / 随堂测验共用）。
 *
 * 长列表（5~20 题）与弹窗内长滚动都靠它定位：已答=绿、当前/下一题=蓝、未答=灰。
 * 点击只做"滚动到那一题"，不改变各页既有的渲染结构，改动面最小。
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip, Typography, theme } from 'antd'

const { Text } = Typography

interface Props {
  /** 每题是否已作答（按题序号） */
  answered: boolean[]
  /** 点击某题号（一般传 scrollIntoView） */
  onJump: (index: number) => void
  /** 当前题号（可选，0 基）；练习/测验传"第一道没答的题"，等于给学员一个下一步 */
  current?: number
}

const AnswerNav: React.FC<Props> = ({ answered, onJump, current }) => {
  const { t } = useTranslation('common')
  const { token } = theme.useToken()
  if (!answered.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
      <Text type="secondary" style={{ fontSize: 12, marginRight: 2 }}>{t('answerNavLabel')}</Text>
      {answered.map((done, i) => {
        const isCurrent = current === i
        const label = t('jumpToQuestion', { n: i + 1 })
        return (
          <Tooltip key={i} title={label}>
            <button
              type="button"
              aria-label={label}
              aria-current={isCurrent ? 'step' : undefined}
              onClick={() => onJump(i)}
              style={{
                width: 26, height: 26, borderRadius: 8, cursor: 'pointer',
                fontSize: 12, fontWeight: 600, lineHeight: 1, padding: 0,
                border: isCurrent ? `2px solid ${token.colorPrimary}` : `1px solid ${token.colorBorderSecondary}`,
                background: done ? token.colorSuccessBg : token.colorFillQuaternary,
                color: done ? token.colorSuccess : token.colorTextSecondary,
              }}
            >
              {i + 1}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

export default AnswerNav
