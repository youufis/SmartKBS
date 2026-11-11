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
import React, { useEffect, useRef, useState } from 'react'
import { message } from 'antd'
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

let cached: ExamProtectFlags | null = null

async function fetchFlags(): Promise<ExamProtectFlags> {
  if (cached) return cached
  try {
    const { data } = await apiClient.get('/api/config/exam-protect')
    cached = { antiCopy: !!data?.anti_copy, watermark: !!data?.watermark }
  } catch {
    cached = OFF        // 取不到就按全关处理：配置异常绝不能挡住答题
  }
  return cached
}

/** 管理员改完配置后，下次进入作答页会自动重新取；这里留个手动失效口给热更新用 */
export function invalidateExamProtect() { cached = null }

export function useExamProtect(): ExamProtectFlags {
  const [flags, setFlags] = useState<ExamProtectFlags>(OFF)
  const warnedRef = useRef(0)

  useEffect(() => {
    let alive = true
    void fetchFlags().then((f) => { if (alive) setFlags(f) })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!flags.antiCopy) return
    const inGuard = (el: EventTarget | null) => el instanceof Element && !!el.closest('[data-exam-guard]')
    const editable = (el: EventTarget | null) => el instanceof Element && !!el.closest(EDITABLE)
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
