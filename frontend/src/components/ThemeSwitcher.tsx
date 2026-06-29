import React from 'react'
import { Select, Space, Typography, Tooltip } from 'antd'
import { useThemeStore, themeMap, type ThemeName } from '../stores/themeStore'

const { Text } = Typography

const ThemeSwitcher: React.FC = () => {
  const { current, setTheme } = useThemeStore()

  return (
    <Tooltip title="切换主题">
      <Select
        value={current}
        onChange={(val: ThemeName) => setTheme(val)}
        style={{ width: 140 }}
        size="small"
        variant="borderless"
        options={Object.entries(themeMap).map(([key, t]) => ({
          value: key,
          label: (
            <Space size={6}>
              <span
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  backgroundColor: t.antdConfig.token?.colorPrimary as string,
                  flexShrink: 0,
                }}
              />
              {t.icon && <Text style={{ fontSize: 13 }}>{t.icon}</Text>}
              <Text style={{ fontSize: 13 }}>{t.label}</Text>
            </Space>
          ),
        }))}
      />
    </Tooltip>
  )
}

export default ThemeSwitcher
