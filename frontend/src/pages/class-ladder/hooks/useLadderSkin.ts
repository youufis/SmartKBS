import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LadderConfig, LadderSession } from '../../../api/classLadder'
import { SKIN_PREF_KEY } from '../constants'
import { buildLadderTheme } from '../theme'

/**
 * 皮肤状态：本地偏好 > 本场皮肤 > 服务端默认 > 云白课堂。
 * 输出明暗模式与局部 antd 主题（皮肤切换即时生效）。
 */
export function useLadderSkin(config: LadderConfig | null, session: LadderSession | null) {
  const [skin, setSkin] = useState(() => localStorage.getItem(SKIN_PREF_KEY) || '')

  // 首次拿到配置且没有本地偏好时，落到服务端默认皮肤（浅色优先）
  useEffect(() => {
    if (!skin && config) setSkin(config.default_skin || 'cloud')
  }, [config, skin])

  const activeSkin = skin || session?.skin || config?.default_skin || 'cloud'
  const skinMeta = useMemo(
    () => config?.skins.find((s) => s.value === activeSkin),
    [config, activeSkin])
  const mode = (skinMeta?.light ? 'light' : 'dark') as 'light' | 'dark'
  const theme = useMemo(() => buildLadderTheme(mode, activeSkin), [mode, activeSkin])

  const handleSkinChange = useCallback((v: string) => {
    setSkin(v)
    localStorage.setItem(SKIN_PREF_KEY, v)
  }, [])

  return { activeSkin, mode, theme, handleSkinChange }
}
