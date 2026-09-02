import React from 'react'
import { Select, Space, Typography, Tooltip } from 'antd'
import { useThemeStore, themeMap, type ThemeName } from '../stores/themeStore'
import { useTranslation } from 'react-i18next'

const { Text } = Typography

const ThemeSwitcher: React.FC = () => {
  const { t: tr } = useTranslation('login')
  const { current, setTheme } = useThemeStore()

  return (
    <Tooltip title={tr('theme.switch')}>
      <Select
        value={current}
        onChange={(val: ThemeName) => setTheme(val)}
        style={{ width: 140 }}
        size="small"
        variant="borderless"
        options={Object.entries(themeMap).map(([key, th]) => ({
          value: key,
          label: (
            <Space size={6}>
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  backgroundColor: th.antdConfig.token?.colorPrimary as string,
                  flexShrink: 0,
                }}
              />
              <Text style={{ fontSize: 13 }}>{th.icon}</Text>
              <Text style={{ fontSize: 13 }}>{tr(`theme.${key}`)}</Text>
            </Space>
          ),
        }))}
      />
    </Tooltip>
  )
}

export default ThemeSwitcher
