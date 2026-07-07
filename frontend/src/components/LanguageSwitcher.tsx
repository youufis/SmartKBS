/**
 * 语言切换组件
 * - 顶部栏下拉菜单，切换中/英文
 * - 同时更新 i18next 和 Ant Design locale
 */
import React from 'react'
import { Dropdown, Button } from 'antd'
import { GlobalOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useLocaleStore, SUPPORTED_LOCALES } from '../stores/localeStore'

const LanguageSwitcher: React.FC = () => {
  const { t } = useTranslation('login')
  const currentLocale = useLocaleStore((s) => s.current)
  const setLocale = useLocaleStore((s) => s.setLocale)

  const items = SUPPORTED_LOCALES.map((loc) => ({
    key: loc.key,
    label: loc.label,
    onClick: () => setLocale(loc.key),
  }))

  return (
    <Dropdown menu={{ items }} placement="bottomRight" trigger={['click']}>
      <Button
        type="text"
        icon={<GlobalOutlined />}
        title={t('language.switch')}
        style={{ color: 'inherit', fontSize: 16 }}
      >
        {SUPPORTED_LOCALES.find(l => l.key === currentLocale)?.label || currentLocale}
      </Button>
    </Dropdown>
  )
}

export default LanguageSwitcher
