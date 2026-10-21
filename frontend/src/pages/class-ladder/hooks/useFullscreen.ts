import { useCallback, useEffect, useState } from 'react'

/**
 * 投屏全屏：状态跟随 fullscreenchange（Esc 退出也能对上）；
 * 全屏期间给 body 挂 cl-fs，由 CSS 隐藏后台顶栏与侧栏。
 */
export function useFullscreen() {
  const [fs, setFs] = useState(false)

  const toggleFs = useCallback(() => {
    if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => {})
    else void document.exitFullscreen?.()
  }, [])

  useEffect(() => {
    const onFsChange = () => {
      const active = Boolean(document.fullscreenElement)
      setFs(active)
      document.body.classList.toggle('cl-fs', active)
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange)
      document.body.classList.remove('cl-fs')
    }
  }, [])

  return { fs, toggleFs }
}
