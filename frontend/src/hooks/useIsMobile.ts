import { Grid } from 'antd'

/**
 * 移动端统一判定钩子（地基 B1）。
 *
 * 基于 antd Grid 断点体系：<768px 视为移动端。
 * 全站布局/菜单/门控一律经由本钩子判断，禁止散落的宽度判断。
 * 桌面端（>=768px，含 Electron minWidth:1024）恒为 false，相关分支不生效。
 */
export function useIsMobile(): boolean {
  const screens = Grid.useBreakpoint()
  // 首帧 screens 可能为空对象：仅当 md 明确为 false 才算移动端，避免桌面闪屏
  return screens.md === false
}
