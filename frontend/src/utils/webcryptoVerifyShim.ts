/**
 * 明文 http（非环回）补齐 WebCrypto —— 让 tldraw 自己的验签真的执行
 *
 * 背景（实测，见 @tldraw/editor 的 LicenseManager）：
 *   · 协议不是 https（且不是 localhost）时，SDK 认为自己在"开发环境"；
 *   · 此时如果浏览器没有 crypto.subtle（明文 http 非环回就是这样），会直接跳过验签，
 *     状态记为 unlicensed，只在右下角渲染 "Get a license for production" 按钮。
 *     也就是说：管理员填了合法 key，内网 http 访问也看不到任何效果。
 *
 * 这里按需加载 utils/tlVerifyImpl（独立 chunk，只实现 importKey/verify 两个方法），让 SDK 的
 * 验签真的跑起来。判定结果仍然完全由 SDK 给出：合法 → licensed（无水印位就没有
 * 任何标记）；过期 → expired；带水印位 → licensed-with-watermark（官方水印照显）。
 *
 * 三条硬约束（改之前先读）：
 *   1. 已有原生 crypto.subtle 时一律不动（https / 环回 / 桌面版都走原生）；
 *   2. 加载失败、结构异常、老浏览器没有 BigInt —— 一律返回 'none'，调用方原样回落
 *      （按钮 + 白板照常可用），绝不把异常抛给白板；
 *   3. 只在「系统配置里确实填了形态合法的 key」时才调用（由 constants/tldrawLicense.ts 保证），
 *      留空的内网部署与今天的行为逐字节一致。
 */
export type TLVerifyCapability = 'native' | 'shim' | 'none'

/** 本次页面会话里已经确定的能力：'shim' 一旦装上就不再回退 */
let settled: 'native' | 'shim' | null = null

export function nativeVerifyAvailable(): boolean {
  return !!(globalThis.crypto && globalThis.crypto.subtle)
}

/** 只读查询，不加载任何东西（给 UI 打标签用） */
export function tlVerifyCapability(): TLVerifyCapability {
  if (settled) return settled
  return nativeVerifyAvailable() ? 'native' : 'none'
}

/**
 * 确保验签能力可用。返回值：
 *   'native' 浏览器本来就能验签；
 *   'shim'   本次由 tlVerifyImpl 补上（仅明文 http 非环回）；
 *   'none'   补不上（老浏览器/资源缺失），调用方按"没有验签"处理。
 */
export async function ensureTLVerifyCapability(): Promise<TLVerifyCapability> {
  if (settled) return settled
  if (nativeVerifyAvailable()) {
    settled = 'native'
    return 'native'
  }
  try {
    // 独立按需 chunk：主包不含这段（BigInt 不进 es2015 主包），只有这台机器真正需要时才下载
    const mod = (await import('./tlVerifyImpl')) as { installVerifyShim?: () => boolean }
    if (mod && typeof mod.installVerifyShim === 'function' && mod.installVerifyShim()) {
      settled = 'shim'
      return 'shim'
    }
  } catch {
    // 动态 import 失败（离线/静态资源缺失/浏览器不支持 BigInt）—— 回落到原生行为
  }
  return 'none'
}
