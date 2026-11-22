/**
 * 白板授权闸门 hook —— 解析该用哪枚 key、能不能挂载 tldraw SDK。
 *
 * 单独成文件（不放组件里）：一个模块同时导出 hook 与组件会让 Fast Refresh 失效，
 * eslint 的 react-refresh/only-export-components 就是拦这个的。
 * 判定逻辑本身在 constants/tldrawLicense.ts，这里只管 React 侧的状态与兜底。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  TL_BUILD_LICENSE_KEY,
  resetTLDrawRuntimeCache,
  resolveTLDrawLicense,
  type TLDrawLicenseDecision,
} from '../constants/tldrawLicense'
export type TLDrawLicenseState = 'checking' | 'ok' | 'blocked'

/**
 * 解析链出异常时的兜底：只保留构建期内置 key、不给拦截理由。
 * 判定本身出错不该让老师连白板都打不开 —— 最坏交给 SDK 显示它自己的提示。
 */
function fallbackDecision(): TLDrawLicenseDecision {
  return { key: TL_BUILD_LICENSE_KEY, info: null, reasons: [], notes: ['resolve-failed'] }
}

/** 白板组件用它在挂载 SDK 前取到 key 与判定结果 */
export function useTLDrawLicense() {
  const [decision, setDecision] = useState<TLDrawLicenseDecision | null>(null)

  const recheck = useCallback(() => {
    setDecision(null)
    resetTLDrawRuntimeCache()
    resolveTLDrawLicense().then(setDecision).catch(fallbackDecision)
  }, [])

  useEffect(() => {
    let alive = true
    resetTLDrawRuntimeCache()
    resolveTLDrawLicense()
      .then((d) => { if (alive) setDecision(d) })
      .catch(() => { if (alive) setDecision(fallbackDecision()) })
    return () => { alive = false }
  }, [])

  const state: TLDrawLicenseState = !decision ? 'checking' : decision.reasons.length ? 'blocked' : 'ok'
  return { state, key: decision?.key, info: decision?.info ?? null, reasons: decision?.reasons ?? [], notes: decision?.notes ?? [], recheck }
}
