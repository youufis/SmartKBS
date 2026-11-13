/**
 * 学生作答页防复制 / 个人水印（考试、同步练习、随堂测验共用）
 *
 * 两个开关都在系统配置里且**默认关**：关掉时这里不挂任何监听、不注入任何 DOM，
 * 作答流程与没做这个功能时完全一致。
 * 开启时也只作用于打了 data-exam-guard 的题目区：
 * 选中、复制、剪切、右键、Ctrl/⌘+C/X/S/P/U 被拦，
 * 而答题输入框（含代码编辑器、公式输入）照常可选中与粘贴。
 *
 * 说在前面的边界：网页端拦不住系统截屏、手机拍照，也拦不住 DevTools 直接读接口。
 * 这一层的作用是「防顺手搬运 + 事后能追到人」，不是绝对防泄题。
 */
import { message } from '../utils/feedback'
import React, { useEffect, useRef, useState } from 'react'

import apiClient from '../api/client'
import i18n from '../i18n'
import { useAuthStore } from '../stores/authStore'
import '../styles/examProtect.css'

export interface ExamProtectFlags { antiCopy: boolean; watermark: boolean }

const OFF: ExamProtectFlags = { antiCopy: false, watermark: false }
// 输入区豁免：这些元素内部一律不拦，保证学生能正常作答与粘贴
const EDITABLE = 'input, textarea, select, [contenteditable="true"], [role="textbox"], .monaco-editor'

/** 题目区标记：只在开关打开时展开到 Card/div 上 */
export const GUARD_PROPS = { 'data-exam-guard': '1', className: 'exam-guard' }

// 只缓存 10 秒：同一页反复挂载不重复请求，但管理员改完配置不会被旧值卡住。
// （之前是常驻缓存：在已经打开的作答页里改开关，要整页刷新才生效，实测就踩了这个坑）
const TTL_MS = 10000
let cached: ExamProtectFlags | null = null
let cachedAt = 0

async function fetchFlags(force = false): Promise<ExamProtectFlags> {
  if (cached && !force && Date.now() - cachedAt < TTL_MS) return cached
  try {
    const { data } = await apiClient.get('/api/config/exam-protect')
    cached = { antiCopy: !!data?.anti_copy, watermark: !!data?.watermark }
  } catch {
    cached = OFF        // 取不到就按全关处理：配置异常绝不能挡住答题
  }
  cachedAt = Date.now()
  return cached
}

/** 管理员保存配置后可强制丢弃缓存，让正在作答的页面下一次取数就是新值 */
export function invalidateExamProtect() { cached = null; cachedAt = 0 }

export function useExamProtect(): ExamProtectFlags {
  const [flags, setFlags] = useState<ExamProtectFlags>(OFF)
  const warnedRef = useRef(0)

  useEffect(() => {
    let alive = true
    const pull = (force = false) => { void fetchFlags(force).then((f) => { if (alive) setFlags(f) }) }
    pull(true)
    // 管理员在别的标签页改完配置，这边切回来就生效，不用整页刷新
    const onVisible = () => { if (document.visibilityState === 'visible') pull(true) }
    const onFocus = () => pull(true)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (!flags.antiCopy) return
    // 事件 target 有时是文本节点（选中题目文字后右键就是这种），先归一成元素再判断
    const asElement = (t: EventTarget | null): Element | null =>
      (t instanceof Element ? t : ((t as Node | null)?.parentElement ?? null)) as Element | null
    const inGuard = (t: EventTarget | null) => !!asElement(t)?.closest('[data-exam-guard]')
    const editable = (t: EventTarget | null) => !!asElement(t)?.closest(EDITABLE)
    const block = (e: Event) => {
      if (!inGuard(e.target) || editable(e.target)) return
      e.preventDefault()
      const now = Date.now()
      if (now - warnedRef.current > 8000) {   // 8 秒内只提示一次，别打断答题节奏
        warnedRef.current = now
        message.info(i18n.t('common:antiCopyBlocked'))
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      // 只拦复制/剪切/保存/打印/查看源码；Ctrl+A、Ctrl+V、回车、退格等一律放行
      if (!['c', 'x', 's', 'p', 'u'].includes((e.key || '').toLowerCase())) return
      block(e)
    }
    document.addEventListener('copy', block, true)
    document.addEventListener('cut', block, true)
    document.addEventListener('contextmenu', block, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('copy', block, true)
      document.removeEventListener('cut', block, true)
      document.removeEventListener('contextmenu', block, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [flags.antiCopy])

  return flags
}

/** 个人水印：position:fixed + pointer-events:none，不占位、不拦截点击与滚动 */
export const ExamWatermark: React.FC<{ show: boolean }> = ({ show }) => {
  const user = useAuthStore((s) => s.user)
  const [text, setText] = useState('')

  useEffect(() => {
    if (!show) { setText(''); return }
    const pad = (n: number) => String(n).padStart(2, '0')
    const tick = () => {
      const who = [user?.name || '', user?.username || ''].filter(Boolean).join(' · ')
      if (!who) { setText(''); return }
      const d = new Date()
      setText(`${who} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`)
    }
    tick()
    const iv = window.setInterval(tick, 60000)
    return () => window.clearInterval(iv)
  }, [show, user?.name, user?.username])

  if (!show || !text) return null
  const safe = text.replace(/[<>&"']/g, '')
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='180'>` +
    `<text x='6' y='96' transform='rotate(-24 6 96)' fill='rgba(110,120,140,0.20)' ` +
    `font-family='system-ui,-apple-system,sans-serif' font-size='15'>${safe}</text></svg>`
  return (
    <div
      aria-hidden
      className="exam-watermark"
      style={{ backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")` }}
    />
  )
}
