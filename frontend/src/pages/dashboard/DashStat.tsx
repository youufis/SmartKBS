/**
 * 带滚动动画的统计数字（批次 2）
 *
 * 原来首屏四个数字是"瞬间跳变"，看不出变化来自哪里。这里做两件事：
 * 数值用 rAF 补间（easeOutCubic），以及系统开启"减弱动态效果"时直接显示终值。
 * 统一从 DashStat 出口，避免每张卡各写一遍 Statistic 的样板。
 */
import React, { useEffect, useRef, useState } from 'react'
import { Statistic } from 'antd'

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

const CountValue: React.FC<{ value: number }> = ({ value }) => {
  const shown = useCountUp(value)
  return <>{Math.round(shown).toLocaleString()}</>
}

/** 与 antd Statistic 同 props，只是数字带补间 */
export const DashStat: React.FC<React.ComponentProps<typeof Statistic>> = ({ value, ...rest }) => {
  const n = Number(value ?? 0)
  return <Statistic {...rest} value={n} formatter={() => <CountValue value={n} />} />
}