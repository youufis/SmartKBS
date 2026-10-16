/**
 * 点名/抽问的「念学生姓名」语音播报（音源来自 /api/rollcall/speech）。
 *
 * 抽出来是因为点名页与抽问页原来各写一份，且失败时把后端原文直接弹给老师看：
 *   message.warning("websocket connection could not established within 5s. Please
 *   check your network connection, firewall settings, or server status.")
 * 现场表现就是"偶尔闪现一条语音异常提示，也没念出名字"。现在统一成：
 *   · 后端已按 error_kind 分类（backend/tts_service.py 的 FAIL_*），并已自动重试一次；
 *   · 这里只把「一句人话 + 一个重试入口」放在揭示卡片上，不再用弹窗打断课堂；
 *   · 只有"需要管理员动手"的配置类问题（音色与模型不匹配等）才提示一次，且 60 秒冷却；
 *   · 播报失败绝不影响点名主流程（画面照样揭示姓名）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import apiClient from '../api/client'

/** 与 backend/tts_service.py 的 FAIL_* 对齐；network = 浏览器到服务端就没通 */
export type SpeechErrorKind =
  | 'transient' | 'quota' | 'config' | 'disabled' | 'invalid' | 'unknown' | 'network'

export interface SpeechFailure {
  /** 这次没能念出名字的学生 */
  name: string
  kind: SpeechErrorKind
  /** 后端给的人话（中文短句，可直接展示） */
  message: string
}

interface Options {
  grade?: string
  class?: string
  /** 管理员总开关（页面从 /api/rollcall/speech-status 拿到） */
  enabled: boolean
  /** 页面上的 🔊 偏好 */
  speakOn: boolean
  /** 后端回 disabled：页面把图标置灰 */
  onDisabled?: () => void
  /** 需要管理员处理的配置类问题（音色/模型不匹配、没配 Key）：值得提示一次 */
  onConfigIssue?: (message: string) => void
}

export function useNameSpeech({ grade, class: cls, enabled, speakOn, onDisabled, onConfigIssue }: Options) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // 待播的音频任务连同姓名一起存：万一两次点名交叠，宁可不说也不能说错人
  const pendingRef = useRef<{ name: string; task: Promise<string | null> } | null>(null)
  const configWarnedAtRef = useRef(0)
  const [failure, setFailure] = useState<SpeechFailure | null>(null)

  // 离开页面时收声，别让点名页的音频在别的页面继续念名字
  useEffect(() => () => { audioRef.current?.pause() }, [])

  const fetchAudio = useCallback(async (name: string): Promise<string | null> => {
    try {
      const { data } = await apiClient.get('/api/rollcall/speech', {
        params: { grade, class: cls, name },
      })
      if (data?.ok && data.url) {
        setFailure(null)
        return String(data.url)
      }
      const kind = (data?.error_kind as SpeechErrorKind)
        || (data?.disabled ? 'disabled' : 'unknown')
      const message = String(data?.error || '')
      if (kind === 'disabled') onDisabled?.()
      setFailure({ name, kind, message })
      // 配置类问题老师处理不了，但需要让管理员知道；同一会话内 60 秒只说一次
      if (kind === 'config' && Date.now() - configWarnedAtRef.current > 60_000) {
        configWarnedAtRef.current = Date.now()
        onConfigIssue?.(message)
      }
      return null
    } catch {
      // 浏览器到服务端就没通：静默（画面已经揭示姓名，弹窗只会添乱）
      setFailure({ name, kind: 'network', message: '' })
      return null
    }
  }, [grade, cls, onDisabled, onConfigIssue])

  /** 姓名定了就先去要音频：合成约 1 秒，完全藏得进 4~5 秒的滚动动画 */
  const prepare = useCallback((name: string) => {
    if (!enabled || !speakOn || !name) { pendingRef.current = null; return }
    pendingRef.current = { name, task: fetchAudio(name) }
  }, [enabled, speakOn, fetchAudio])

  /** 动画被中断（重置/切班/卸载）时丢掉待播任务，免得事后突然念一个名字 */
  const cancel = useCallback(() => { pendingRef.current = null }, [])

  const playUrl = useCallback(async (url: string) => {
    try {
      audioRef.current?.pause()                 // 连按空格时打断上一段，不叠音
      const audio = new Audio(url)
      audioRef.current = audio
      await audio.play()
    } catch {
      // 浏览器拦下自动播放（未与页面交互过）：静默，教师点一次按钮就恢复了
    }
  }, [])

  /** 揭示时播放：最多再等 2 秒，等不到就放弃这一次，绝不拖住点名节奏 */
  const play = useCallback(async (name: string) => {
    if (!enabled || !speakOn) return
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending || pending.name !== name) return
    const url = await Promise.race([
      pending.task, new Promise<null>((r) => window.setTimeout(() => r(null), 2000)),
    ])
    if (url) await playUrl(url)
  }, [enabled, speakOn, playUrl])

  /** 老师点「重试朗读」：重新要一次音频并立即播（多已命中服务端缓存，秒回） */
  const retry = useCallback(async () => {
    const name = failure?.name
    if (!name) return
    const url = await fetchAudio(name)
    if (url) await playUrl(url)
  }, [failure, fetchAudio, playUrl])

  return { prepare, cancel, play, retry, failure, clearFailure: useCallback(() => setFailure(null), []) }
}

export default useNameSpeech
