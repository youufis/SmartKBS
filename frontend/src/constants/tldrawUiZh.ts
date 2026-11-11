/**
 * tldraw 的 zh-cn 翻译缺这两个键（实测 5.1.1），每缺一个就刷一条
 * "Language zh-cn: missing messages for keys: page-menu.*" 警告，开一次画布十几条，
 * 真报错就埋在里面了。这里补齐，两个画布组件共用一份，别各写各的。
 */
import type { TLUiOverrides } from 'tldraw'

export const TLUI_ZH_OVERRIDES: TLUiOverrides = {
  translations: {
    'zh-cn': {
      'page-menu.max-pages-reached': '已达页面数上限',
      'page-menu.resize': '调整页面列表宽度',
    },
  },
}
