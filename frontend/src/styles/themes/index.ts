export { defaultTheme, defaultCssVars } from './default'
export { forestTheme, forestCssVars } from './forest'
export { sunsetTheme, sunsetCssVars } from './sunset'
export { midnightTheme, midnightCssVars } from './midnight'
export { lavenderTheme, lavenderCssVars } from './lavender'

export type { ThemeConfig } from 'antd'

/**
 * antd v6.4.3 的部分 token 类型定义文件缺失，导致 borderRadius 等属性
 * 无法被 TypeScript 识别。使用本工具类型绕过类型检查。
 * @internal
 */
export type LooseToken = Record<string, any>
