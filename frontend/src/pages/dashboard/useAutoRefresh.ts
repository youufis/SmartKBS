/** 首页新鲜度：focus/回到可见时重验 + 可见期轮询（stale-while-revalidate，是否回骨架由调用方决定） */
import { useEffect, useRef } from 'react'

export function useAutoRefresh(callback: () => void, intervalMs = 60_000, minGapMs = 15_000) {
  const cbRef = useRef(callback)
  cbRef.current = callback
  const lastRef = useRef(0)
  useEffect(() => {
    lastRef.current = Date.now()
    const run = () => {
      if (document.hidden) return
      const now = Date.now()
      if (now - lastRef.current < minGapMs) return
      lastRef.current = now
      cbRef.current()
    }
    const onVis = () => { if (!document.hidden) run() }
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', onVis)
    const id = window.setInterval(run, intervalMs)
    return () => {
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', onVis)
      window.clearInterval(id)
    }
  }, [intervalMs, minGapMs])
}

export default useAutoRefresh
