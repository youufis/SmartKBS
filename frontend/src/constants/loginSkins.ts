/**
 * 登录页皮肤色板
 * 手工挑选"明度中高、饱和度适中"的渐变对：
 * 白色玻璃卡片与深色主题文字都能保持可读，任意全局主题下都不违和。
 * 规则：默认每日一色（全校当天稳定），可 🎲 临时随机（仅本次会话记住）。
 */

export interface LoginSkin {
  id: string
  /** 中文名（调试 / 后续菜单扩展用） */
  label: string
  /** 渐变起始色（左上） */
  from: string
  /** 渐变结束色（右下） */
  to: string
}

export const LOGIN_SKINS: LoginSkin[] = [
  { id: 'indigo',   label: '靛蓝暮紫', from: '#667eea', to: '#764ba2' },
  { id: 'ocean',    label: '碧海晴空', from: '#2193b0', to: '#6dd5ed' },
  { id: 'mint',     label: '薄荷清晨', from: '#43c6ac', to: '#7be0c8' },
  { id: 'leaf',     label: '春山新绿', from: '#56ab2f', to: '#a8e063' },
  { id: 'coral',    label: '落日珊瑚', from: '#ff6a88', to: '#ff99ac' },
  { id: 'gold',     label: '暖金麦浪', from: '#f6d365', to: '#fda085' },
  { id: 'lilac',    label: '丁香浅雾', from: '#a18cd1', to: '#fbc2eb' },
  { id: 'royal',    label: '宝石蓝调', from: '#00c6fb', to: '#005bea' },
  { id: 'amethyst', label: '紫晶辉映', from: '#b06ab3', to: '#4568dc' },
  { id: 'mist',     label: '烟雨青瓷', from: '#83a4d4', to: '#b6fbff' },
  { id: 'peach',    label: '桃夭暖光', from: '#ffecd2', to: '#fcb69f' },
  { id: 'rose',     label: '蔷薇粉黛', from: '#ee9ca7', to: '#ffdde1' },
]

/** 会话级随机皮肤记录（sessionStorage）；无值即"每日一色" */
export const LOGIN_SKIN_STORAGE_KEY = 'smartkb_login_skin'

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/** 每日一色：同一天全校稳定同一款，刷新不跳变、投屏不闪色 */
export function dailySkinIndex(date = new Date()): number {
  return hashString(`${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`) % LOGIN_SKINS.length
}

/** 随机挑一款与当前不同的皮肤 */
export function randomSkinIndex(exclude?: number): number {
  if (LOGIN_SKINS.length <= 1) return 0
  let idx = Math.floor(Math.random() * LOGIN_SKINS.length)
  while (idx === exclude) idx = Math.floor(Math.random() * LOGIN_SKINS.length)
  return idx
}

/** 读取本次会话已随机选过的皮肤（没有或非法则返回 null） */
export function readStoredSkinIndex(): number | null {
  const raw = sessionStorage.getItem(LOGIN_SKIN_STORAGE_KEY)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n < LOGIN_SKINS.length ? n : null
}

/** #rrggbb -> rgba(r, g, b, alpha) */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function relLuminance(hex: string): number {
  const h = hex.replace('#', '')
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)].map((x) => {
    const v = parseInt(x, 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 这套皮肤整体是否"浅"（右上角控件条的图标文字颜色据此翻转） */
export function isLightSkin(skin: LoginSkin): boolean {
  return (relLuminance(skin.from) + relLuminance(skin.to)) / 2 > 0.62
}