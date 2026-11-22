/**
 * tldraw SDK 授权位（全项目唯一来源）
 *
 * tldraw 不是开源库：源码可见，但按 tldraw license 商业授权。三条线必须守住：
 *   1. 生产环境必须携带有效 license key（开发环境不需要）；
 *   2. 不得隐藏、遮挡或干扰水印与授权校验 —— 水印就是免费/非商业授权的对价；
 *   3. 再分发安装包时附带许可原文（frontend/public/THIRD-PARTY-NOTICES/tldraw-LICENSE.md）。
 *
 * key 有两条来源，按优先级取用：
 *   ① 运行时：系统配置 TL_LICENSE_KEY（GET /api/config/tldraw-license）
 *      → 换 key / 年度续期只改配置，不必重新出包；
 *   ② 构建期：VITE_TLDRAW_LICENSE_KEY（frontend/.env.local，不入库）
 *      → 安装包内置，学校开箱可用，不用任何人再申请。
 *
 * 为什么还要在这里做"要不要挂载 SDK"的预判：未授权/域名不符/过期时，SDK 自己会在 5 秒后
 * 把整个画布替换成空白 div（LicenseProvider 的 LicenseGate）。老师上课点开白板看到一片空白，
 * 是最难排查的失败形态。所以这里按 SDK 的同一套判定提前给出原因，由白板组件渲染自有说明页。
 *
 * 一个容易误判的点：http（非 localhost）部署里浏览器没有 WebCrypto，SDK 无法验签，
 * 无论有没有 key 都会显示 "Get a license for production" 按钮 —— 那是 SDK 的正常显示，
 * 不得用 CSS 遮蔽。
 */

import apiClient from '../api/client'

export type TLLicenseSource = 'runtime' | 'build' | 'none'

export interface TLLicenseInfo {
  key: string
  source: TLLicenseSource
  /** key 里的授权记录 id（找 tldraw 问询时报这串） */
  id: string
  /** 授权允许的域名，["*"] = 不限 */
  hosts: string[]
  /** 到期日 YYYY-MM-DD */
  expiry: string
  /** 距到期剩余天数（负数 = 已过期） */
  daysLeft: number
  expired: boolean
  /** annual / perpetual / watermark / evaluation … */
  kinds: string[]
}

/** 会导致 SDK 隐藏画布的原因；与白板说明页一一对应 */
export type TLBlockReason = 'no-key' | 'invalid-key' | 'expired' | 'host-not-licensed'

const FLAG_LABELS: Record<number, string> = {
  1: 'annual', 2: 'perpetual', 4: 'internal', 8: 'watermark', 16: 'evaluation', 32: 'native',
}

/** 构建期内置 key（安装包自带，学校无需配置） */
export const TL_BUILD_LICENSE_KEY: string | undefined =
  ((import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined) ?? '').trim() || undefined

const padBase64 = (b64: string) => b64 + '='.repeat((4 - (b64.length % 4)) % 4)

/**
 * 解出 key 的授权信息。只解 payload 形态、不验签（验签归浏览器里的 SDK）。
 * 返回 null 表示这串不是合法 key —— 填错等于没填，必须当成问题暴露出来。
 */
export function parseTLDrawLicenseKey(key: string, source: TLLicenseSource = 'runtime'): TLLicenseInfo | null {
  const m = /^tldraw-[^/]+\/([A-Za-z0-9+/=_-]+)\.[A-Za-z0-9+/=_.-]+$/.exec(key.trim())
  if (!m) return null
  let fields: unknown
  try {
    fields = JSON.parse(atob(padBase64(m[1])))
  } catch {
    return null
  }
  if (!Array.isArray(fields) || fields.length < 4) return null
  const expiry = String(fields[3] ?? '')
  const exp = new Date(`${expiry}T00:00:00`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry) || Number.isNaN(exp.getTime())) return null
  const flags = Number(fields[2]) || 0
  const kinds = Object.entries(FLAG_LABELS)
    .filter(([bit]) => (flags & Number(bit)) === Number(bit))
    .map(([, label]) => label)
  const daysLeft = Math.floor((exp.getTime() - Date.now()) / 86_400_000)
  return {
    key: key.trim(),
    source,
    id: String(fields[0] ?? ''),
    hosts: Array.isArray(fields[1]) ? fields[1].map(String) : [],
    expiry,
    daysLeft,
    expired: daysLeft < 0,
    kinds,
  }
}

/** 与 SDK 的 isDomainValid 同口径：精确、www. 变体、* 与 glob */
export function tlHostsLicensed(hosts: string[], hostname: string): boolean {
  const h = (hostname || '').toLowerCase()
  return hosts.some((raw) => {
    const host = String(raw).toLowerCase().trim()
    if (!host) return false
    if (host === '*') return true
    if (host === h || `www.${host}` === h || host === `www.${h}`) return true
    if (host.includes('*')) {
      // 授权 key 里的 hosts 属于外部输入：非法 glob 宁可判"不匹配"，也不能把异常抛给闸门
      try {
        const re = new RegExp(host.replace(/\*/g, '.*?'))
        return re.test(h) || re.test(`www.${h}`)
      } catch {
        return false
      }
    }
    return false
  })
}

/** SDK 会不会把这当成"生产环境"（决定它是隐藏画布，还是只显示一枚按钮） */
function sdkTreatsAsProduction(): boolean {
  // SDK 自己还有一条 NODE_ENV !== 'production' 的开发态判定：构建产物里那句会被编译成 false，
  // 但 npm run dev 与 https 调试站仍然算开发环境 —— 不跟着判就会把本地调试误锁成说明页。
  if (!import.meta.env.PROD) return false
  const proto = location.protocol
  const secureContext = ['https:', 'vscode-webview:'].includes(proto)
  return secureContext && location.hostname !== 'localhost'
}

/** SDK 有没有能力验签（http 非 localhost 时 WebCrypto 不可用，它压根不校验 key） */
function sdkCanVerify(): boolean {
  return !!(globalThis.crypto && (globalThis.crypto as Crypto).subtle)
}

let runtimePromise: Promise<string> | null = null

/** 读取系统配置里的覆盖 key；失败/超时按空串处理（回落到构建期 key），缓存一次 */
export function fetchTLDrawRuntimeKey(): Promise<string> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 4000)
        try {
          const { data } = await apiClient.get('/api/config/tldraw-license', { signal: ctrl.signal })
          return typeof data?.key === 'string' ? data.key.trim() : ''
        } finally {
          clearTimeout(timer)
        }
      } catch {
        // 401（令牌过期）/ 网络不通 / 后端还是旧版本（没有这个端点）都按"没有运行时 key"处理：
        // 回落到构建期内置 key，绝不能因为读不到配置就把白板锁死
        return ''
      }
    })()
  }
  return runtimePromise
}

/** 管理员刚保存过配置时清掉缓存，让下一次解析读到新值 */
export function resetTLDrawRuntimeCache(): void {
  runtimePromise = null
}

export interface TLDrawLicenseDecision {
  /** 传给 <Tldraw licenseKey>；undefined = 不传（SDK 自行处理） */
  key?: string
  info: TLLicenseInfo | null
  /** 非空即不应挂载 SDK，改渲染自有说明页 */
  reasons: TLBlockReason[]
  /** 不致命但值得提醒：临期、http 下无法验签等 */
  notes: string[]
}

/**
 * 解析出"该用哪枚 key、能不能挂载白板"。判定刻意与 SDK 保持一致：
 * 只有 SDK 真会把画布藏掉的情形才返回 reasons，避免把本来能用的 http 内网部署误锁。
 */
export async function resolveTLDrawLicense(): Promise<TLDrawLicenseDecision> {
  const runtime = await fetchTLDrawRuntimeKey()
  const raw = runtime || TL_BUILD_LICENSE_KEY || ''
  const source: TLLicenseSource = runtime ? 'runtime' : TL_BUILD_LICENSE_KEY ? 'build' : 'none'
  const production = sdkTreatsAsProduction()
  const verifiable = sdkCanVerify()
  const reasons: TLBlockReason[] = []
  const notes: string[] = []

  if (!raw) {
    if (production && verifiable) reasons.push('no-key')
    return { key: undefined, info: null, reasons, notes }
  }

  const info = parseTLDrawLicenseKey(raw, source)
  if (!info) {
    if (production && verifiable) reasons.push('invalid-key')
    else notes.push('invalid-key')
    return { key: undefined, info: null, reasons, notes }
  }

  // 过期：SDK 只要验得了签就会判 expired 并隐藏画布（evaluation 无宽限期）
  if (info.expired) {
    if (verifiable) reasons.push('expired')
    else notes.push('expired')
  } else if (info.daysLeft <= 21) {
    notes.push('expiring-soon')
  }

  // 域名不符：SDK 只在"非开发环境"下才因此判未授权
  if (!info.expired && production && verifiable && !tlHostsLicensed(info.hosts, location.hostname)) {
    reasons.push('host-not-licensed')
  }
  if (!verifiable) notes.push('no-webcrypto')

  return { key: info.key, info, reasons, notes }
}
