import React from 'react'
import { Button, Result } from 'antd'
import { DesktopOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

/**
 * "请用电脑端"引导页（地基 B4）。
 * 仅当【手机端 + 白名单外路由】时替换 Outlet 渲染；桌面端永远不会走到这里。
 */
const DesktopOnlyGuide: React.FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation('common')

  return (
    <Result
      icon={<DesktopOutlined style={{ fontSize: 56, color: 'var(--primary-color)' }} />}
      title={t('desktopOnlyTitle', { defaultValue: '此功能请在电脑端使用' })}
      subTitle={t('desktopOnlySub', {
        defaultValue: '手机端的适配正在逐步推进，该页面暂未开放手机视图。请在教室电脑、办公 PC 或桌面版中使用完整功能。',
      })}
      extra={
        <Button type="primary" onClick={() => navigate('/dashboard')}>
          {t('goDashboard', { defaultValue: '返回首页' })}
        </Button>
      }
    />
  )
}

export default DesktopOnlyGuide
