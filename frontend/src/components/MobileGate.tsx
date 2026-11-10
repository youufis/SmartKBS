/**
 * 窄屏门控（MobileGate）
 *
 * 为什么需要它：白名单（constants/mobileNav.ts）只在 AppLayout 内部生效，
 * 而考试作答、AI 讲演、闯关答题这类「沉浸式」路由挂在 AppLayout 之外，
 * 门控管不到它们 —— 手机上直访 /learn/:kpId 会进到一个桌面舞台页（还会 window.open
 * 一个 1040×780 的演讲者窗口）。这里补一道闸：窄屏给「请用电脑端」引导，
 * 桌面端原样透出 children，零影响。
 */
import React from 'react'
import { useIsMobile } from '../hooks/useIsMobile'
import DesktopOnlyGuide from './DesktopOnlyGuide'

const MobileGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const isMobile = useIsMobile()
  if (isMobile) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 8 }}>
        <DesktopOnlyGuide />
      </div>
    )
  }
  return <>{children}</>
}

export default MobileGate
