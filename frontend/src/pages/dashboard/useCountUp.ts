/**
 * 数字补间：把统计值从 0 平滑滚到目标值，系统开启"减弱动态效果"时直接给终值。
 * 单独成文件，避免和组件混在一个模块里触发 react-refresh 的 only-export-components 规则。
 */
import { useEffect, useRef, useState } from 'react'

const reducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function useCountUp(target: number, duration = 700): number {
  const safe = Number.isFinite(target) ? target : 0
  const [shown, setShown] = useState(() => (reducedMotion() ? safe : 0))
  const fromRef = useRef(0)
  const rafRef = useRef(0)

  useEffect(() => {
    if (reducedMotion() || duration <= 0) {
      setShown(safe)
      fromRef.current = safe
      return
    }
    const from = fromRef.current
    if (from === safe) return
    const startedAt = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - p, 3)
      setShown(from + (safe - from) * eased)
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step)
      } else {
        fromRef.current = safe
      }
    }
    rafRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(rafRef.current)
  }, [safe, duration])

  return shown
}

export default useCountUp
