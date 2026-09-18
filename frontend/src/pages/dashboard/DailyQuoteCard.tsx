/** 每日一句：按日期从名言池稳定取一条（跟随界面语言），可手动换一句（本地记忆） */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, Space, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { getQuotes } from '../../constants/loginQuotes'
import { useChartTheme } from './chartTheme'

const { Text } = Typography

const OFFSET_KEY = 'smartkb_quote_offset'

const DailyQuoteCard: React.FC = () => {
  const { t, i18n } = useTranslation('dashboard')
  const ct = useChartTheme()
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    const v = Number(localStorage.getItem(OFFSET_KEY))
    if (Number.isFinite(v) && v > 0) setOffset(v)
  }, [])

  const quotes = getQuotes()
  const now = new Date()
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000)
  const q = quotes[(dayOfYear + offset) % quotes.length]
  const dateText = new Intl.DateTimeFormat(i18n.language && i18n.language.startsWith('en') ? 'en-US' : 'zh-CN', {
    month: 'long', day: 'numeric', weekday: 'long',
  }).format(now)

  const swap = () => {
    const n = offset + 1
    setOffset(n)
    try { localStorage.setItem(OFFSET_KEY, String(n)) } catch { /* 隐私模式下忽略 */ }
  }

  return (
    <Card
      size="small"
      style={{
        border: `1px solid ${ct.isDark ? '#2f323b' : '#dbeaff'}`,
        background: ct.isDark
          ? 'linear-gradient(135deg, rgba(79,140,255,0.16) 0%, rgba(19,194,194,0.10) 100%)'
          : 'linear-gradient(135deg, #f2f7ff 0%, #f4fbf6 100%)',
      }}
      styles={{ body: { padding: '10px 14px 12px' } }}
      title={
        <Space size={6}>
          <span style={{ fontSize: 15 }}>💡</span>
          <span style={{ fontSize: 13 }}>{t('quote.title')}</span>
        </Space>
      }
      extra={
        <Space size={8}>
          <Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>{dateText}</Text>
          <Button size="small" type="text" style={{ padding: '0 4px', fontSize: 12 }} icon={<ReloadOutlined style={{ fontSize: 11 }} />} onClick={swap}>
            {t('quote.swap')}
          </Button>
        </Space>
      }
    >
      <div style={{ fontSize: 13.5, lineHeight: 1.75, minHeight: 44 }}>{q.text}</div>
      {q.author && (
        <div style={{ textAlign: 'right', marginTop: 2 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>—— {q.author}</Text>
        </div>
      )}
    </Card>
  )
}

export default DailyQuoteCard
