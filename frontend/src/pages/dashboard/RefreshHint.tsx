/** 首页新鲜度提示：更新于 + 统一刷新入口（刷新不回骨架，旧值先展示后更新） */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

const { Text } = Typography

interface Props {
  updatedAt: number | null
  refreshing: boolean
  onRefresh: () => void
}

const RefreshHint: React.FC<Props> = ({ updatedAt, refreshing, onRefresh }) => {
  const { t, i18n } = useTranslation('dashboard')
  const locale = i18n.language?.startsWith('en') ? 'en-US' : 'zh-CN'
  const timeText = updatedAt
    ? new Date(updatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : ''
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, margin: '-6px 0 8px' }}>
      {timeText && (
        <Text type="secondary" style={{ fontSize: 11 }}>{t('refresh.updatedAt', { time: timeText })}</Text>
      )}
      <Button
        type="text" size="small" icon={<ReloadOutlined spin={refreshing} />} onClick={onRefresh}
        aria-label={t('refresh.label')} title={t('refresh.label')}
      />
    </div>
  )
}

export default RefreshHint
