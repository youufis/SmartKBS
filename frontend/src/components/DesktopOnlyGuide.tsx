import React from 'react'
import { Button, Result, Space } from 'antd'
import { DesktopOutlined, LeftOutlined, HomeOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

/**
 * "请用电脑端"引导页（地基 B4）。
 * 仅当【手机端 + 白名单外路由】时替换 Outlet 渲染；桌面端永远不会走到这里。
 *
 * 第二批补充：主按钮改为"返回上一页"。此前只有"返回首页"，学生从首页卡片
 * 点进未开放路由后被拦下，再点"返回首页"会丢掉列表滚动位置与筛选状态，
 * 体验上像被"弹走"。history 为空（直接分享链接进来）时自动降级为回首页。
 */
const DesktopOnlyGuide: React.FC = () => {
  const navigate = useNavigate()
  const { t } = useTranslation('common')

  const canGoBack = typeof window !== 'undefined' && window.history.length > 1

  return (
    <Result
      icon={<DesktopOutlined style={{ fontSize: 56, color: 'var(--primary-color)' }} />}
      title={t('desktopOnlyTitle', { defaultValue: '此功能请在电脑端使用' })}
      subTitle={t('desktopOnlySub', {
        defaultValue: '手机端的适配正在逐步推进，该页面暂未开放手机视图。请在教室电脑、办公 PC 或桌面版中使用完整功能。',
      })}
      extra={
        <Space orientation="vertical" style={{ width: '100%' }} size={8}>
          {canGoBack && (
            <Button type="primary" block icon={<LeftOutlined />} onClick={() => navigate(-1)}>
              {t('backPrevPage', { defaultValue: '返回上一页' })}
            </Button>
          )}
          <Button block type={canGoBack ? 'default' : 'primary'} icon={<HomeOutlined />} onClick={() => navigate('/dashboard')}>
            {t('goDashboard', { defaultValue: '返回首页' })}
          </Button>
        </Space>
      }
    />
  )
}

export default DesktopOnlyGuide
