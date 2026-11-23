/**
 * tldraw SDK 授权位（全项目唯一来源）
 *
 * tldraw 不是开源库：源码可见，但按 tldraw license 商业授权。三条线必须守住：
 *   1. 生产环境必须携带有效 license key（开发环境不需要）；
 *   2. 不得隐藏、遮挡或干扰水印与授权校验 —— 水印就是免费/非商业授权的对价；
 *   3. 再分发安装包时附带许可原文（frontend/public/THIRD-PARTY-NOTICES/tldraw-LICENSE.md）。
 *
 * key 只有一条来源：**系统配置 TL_LICENSE_KEY**（GET /api/config/tldraw-license）。
 * 构建期不内置、打包不校验 —— 由部署者自己填；换 key / 年度续期只改配置，不必重新出包。
 * 留空也完全合法：内网 http 下白板照常可用，只是会显示 SDK 自带的授权提示按钮。
 *
 * 三种访问形态（照 SDK 的 LicenseManager 源码判，不是猜）：
 *   ① https / vscode-webview：SDK 自己验签。无 key、域名不符、过期 → 5 秒后画布变空白。
 *   ② 明文 http + 环回（127.0.0.1 / localhost）：浏览器提供 WebCrypto，SDK 自己验签，正常。
 *   ③ 明文 http + 非环回（内网 IP/域名）：浏览器不给 crypto.subtle，SDK 跳过验签，只显示
 *      "Get a license for production" 按钮。此形态由 utils/webcryptoVerifyShim.ts 补上
 *      importKey/verify，让 SDK 的验签真的执行：合法 key → licensed（无 watermark 位即无标记）；
 *      过期 → expired（闸门提前拦成说明页）；带 watermark 位 → 官方水印照显，不得遮蔽。
 *
 * 为什么还要在这里做"要不要挂载 SDK"的预判：未授权/域名不符/过期时，SDK 自己会在 5 秒后
 * 把整个画布替换成空白 div（LicenseProvider 的 LicenseGate）。老师上课点开白板看到一片空白，
 * 是最难排查的失败形态。所以这里按 SDK 的同一套判定提前给出原因，由白板组件渲染自有说明页。
 */

import apiClient from '../api/client'
import {
  ensureTLVerifyCapability,
  nativeVerifyAvailable,
  type TLVerifyCapability,
} from '../utils/webcryptoVerifyShim'

export type TLLicenseSource = 'runtime' | 'none'

export interface TLLicenseInfo {
  key: string
  source: TLLicenseSource
  /** key 里的授权记录 id（找 tldraw 问询时报这串） */
  id: string
  /** 授权允许的域名，["*"] = 不限 */
  hosts: string[]
  /** 到期日 YYYY-MM-DD（取自 payload；前缀里的日期不参与验签，不能当依据） */
  expiry: string
  /** 距到期剩余天数（负数 = 已过期） */
  daysLeft: number
  expired: boolean
  /** annual / perpetual / internal / watermark / evaluation / native … */
  kinds: string[]
}

/** 会导致 SDK 隐藏画布的原因；与白板说明页一一对应 */
export type TLBlockReason = 'no-key' | 'invalid-key' | 'expired' | 'host-not-licensed'

const FLAG_LABELS: Record<number, string> = {
  1: 'annual', 2: 'perpetual', 4: 'internal', 8: 'watermark', 16: 'evaluation', 32: 'native',
}

const padBase64 = (b64: string) => b64 + '='.repeat((4 - (b64.length % 4)) % 4)

/**
 * 解出 key 的授权信息。只解 payload 形态、不验签（验签归浏览器里的 SDK / tl-verify.js）。
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

let runtimePromise: Promise<string> | null = null

/** 读取系统配置里的 key；失败/超时按空串处理，缓存一次 */
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
        // 401（令牌过期）/ 网络不通 / 后端还是旧版本（没有这个端点）都按"没有 key"处理：
        // 绝不能因为读不到配置就把白板锁死
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
  /** 传给 <Tldraw licenseKey>；undefined = 不传（SDK 自行处理，结果就是显示它自己的提示） */
  key?: string
  info: TLLicenseInfo | null
  /** 非空即不应挂载 SDK，改渲染自有说明页 */
  reasons: TLBlockReason[]
  /** 不致命但值得提醒：临期、http 下无法验签、本次由 tl-verify 补齐等 */
  notes: string[]
  /** 本次页面里 SDK 能不能验签（native=浏览器原生 / shim=tl-verify 补齐 / none=不能） */
  capability: TLVerifyCapability
}

/**
 * 解析出"该用哪枚 key、能不能挂载白板"。判定刻意与 SDK 保持一致：
 * 只有 SDK 真会把画布藏掉的情形才返回 reasons，避免把本来能用的 http 内网部署误锁。
 *
 * 关键差异（与旧版相比）：只要系统配置里填了形态合法的 key，就在非 https 的非环回环境里
 * 补上 WebCrypto。补上之后 SDK 会真的验签，于是"过期"也会真的触发空白 —— 这里照实拦成说明页。
 * 留空则完全不动（不加载 tl-verify.js），行为与旧版一致。
 */
export async function resolveTLDrawLicense(): Promise<TLDrawLicenseDecision> {
  const raw = await fetchTLDrawRuntimeKey()
  const production = sdkTreatsAsProduction()
  const reasons: TLBlockReason[] = []
  const notes: string[] = []

  if (!raw) {
    if (production && nativeVerifyAvailable()) reasons.push('no-key')
    return { key: undefined, info: null, reasons, notes, capability: nativeVerifyAvailable() ? 'native' : 'none' }
  }

  const info = parseTLDrawLicenseKey(raw, 'runtime')
  if (!info) {
    // 形态不合法：不补 WebCrypto（补了也只会让 SDK 报 invalid key），按"没填"处理
    if (production && nativeVerifyAvailable()) reasons.push('invalid-key')
    else notes.push('invalid-key')
    return { key: undefined, info: null, reasons, notes, capability: nativeVerifyAvailable() ? 'native' : 'none' }
  }

  // 只在这里补能力：有合法形态的 key + 浏览器没有原生 WebCrypto（= 明文 http 非环回）
  const capability = await ensureTLVerifyCapability()
  const verifiable = capability !== 'none'
  if (capability === 'shim') notes.push('verify-shim')
  else if (!verifiable) notes.push('no-webcrypto')

  // 过期：SDK 只要验得了签就会判 expired 并隐藏画布（evaluation 无宽限期）
  if (info.expired) {
    if (verifiable) reasons.push('expired')
    else notes.push('expired')
  } else if (info.daysLeft <= 21) {
    notes.push('expiring-soon')
  }

  // 域名不符：SDK 只在"非开发环境"下才因此判未授权（http 属开发环境，会跳过域名校验）
  if (!info.expired && production && verifiable && !tlHostsLicensed(info.hosts, location.hostname)) {
    reasons.push('host-not-licensed')
  }

  return { key: info.key, info, reasons, notes, capability }
}
