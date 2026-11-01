/**
 * 图表形式切换：单图标 + 下拉。
 *
 * 一开始做成三个并排小按钮（柱/线/格），单张卡还行，四张卡都加上就是首屏 12 个图标，
 * 又吵又挤。改成「当前形式的图标 + 点开选」，每张卡只占 24px，
 * 而且菜单项能带完整名称，比只靠图标猜含义好懂。
 */
import React from 'react'
import { Button, Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { useChartTheme } from './chartTheme'

export interface VariantOption<V extends string> {
  key: V
  icon: React.ReactNode
  label: string
}

interface Props<V extends string> {
  options: VariantOption<V>[]
  value: V
  onChange: (v: V) => void
  /** 按钮的无障碍名与原生提示 */
  title: string
}

export function VariantSwitch<V extends string>({ options, value, onChange, title }: Props<V>) {
  const ct = useChartTheme()
  const current = options.find((o) => o.key === value) ?? options[0]
  if (!current || options.length < 2) return null

  const menu: MenuProps = {
    items: options.map((o) => ({ key: o.key, icon: o.icon, label: o.label })),
    selectable: true,
    selectedKeys: [value],
    onClick: ({ key }) => onChange(key as V),
  }

  return (
    <Dropdown menu={menu} trigger={['click']} placement="bottomRight">
      <Button
        size="small"
        type="text"
        icon={current.icon}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        style={{ width: 24, height: 24, minWidth: 24, color: ct.tick, flexShrink: 0 }}
      />
    </Dropdown>
  )
}

export default VariantSwitch
