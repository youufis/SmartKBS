/**
 * 探索画布 · AI 伴随面板（M0 问答/生图/朗读/拍照/语音 + M1 引用来源/思维导图/知识星图/追问胶囊）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useTranslation } from 'react-i18next'
import remarkGfm from 'remark-gfm'
import { Box, type Editor } from 'tldraw'
import { Button, Input, Modal, Space, Tag, Tooltip, Typography, message } from 'antd'
import {
  AimOutlined, ApartmentOutlined, AudioOutlined, CameraOutlined, CloseOutlined, CustomerServiceOutlined, ExportOutlined, SyncOutlined,
  ClearOutlined, ColumnWidthOutlined, DeploymentUnitOutlined, ExpandAltOutlined, ExpandOutlined, LoadingOutlined, PictureOutlined, ReadOutlined, RocketOutlined, SendOutlined,
  ShrinkOutlined, SoundOutlined,
} from '@ant-design/icons'
import CameraCapture from '../CameraCapture'
import VoiceInput from '../VoiceInput'
import { getFeed, type DiscoveryCard } from '../../api/dailyDiscovery'
import { blobToDataUrl, collectText, detectPenCircles, shapePlainText, smartExcerptInCircle } from './selectionHelpers'
import { insertShapesIntoEditor } from './shapeInsert'
import {
  askExplore, getQuota, pollGenerate, speak, submitGenerate, submitMindmap, submitTopicCard,
  transcribeAudio, uploadAsset, pollStruct,
  type AskHistoryItem, type GenResult, type KbRefItem, type QuotaMap, type ShapeSpec,
} from '../../api/explore'

const { Text, Paragraph } = Typography
const { TextArea } = Input

// 生图/导图/星图没法像问答那样自然回一段话，后端把关怀话术放在 422 的 detail 里、
// 以 [CARE] 为前缀。这类文本必须原样显示——危机场景加个 ⚠️ 会让学生以为自己操作错了。
const CARE_PREFIX = '[CARE] '
const asAssistantText = (raw: unknown, fallback: string): string => {
  const s = String(raw ?? '')
  return s.startsWith(CARE_PREFIX) ? s.slice(CARE_PREFIX.length) : '⚠️ ' + (s || fallback)
}

interface Msg { role: 'user' | 'assistant'; content: string; refs?: KbRefItem[]; q?: string; cardId?: string }

interface Props {
  canvasId: number
  getEditor: () => Editor | null
  onClose: () => void
  mobile?: boolean
  popMode: boolean
  onPopToggle: () => void
  pendingAsk?: { text: string; nonce: number } | null
  onAskConsumed?: () => void
  wide: boolean
  onWide: () => void
}

/** 同一文档多切片命中时只展示一次，最多 3 条 */
function uniqRefs(refs: KbRefItem[]): KbRefItem[] {
  const seen = new Set<string>()
  const out: KbRefItem[] = []
  for (const r of refs) {
    const k = (r.doc_name || '') + '|' + (r.title || '')
    if (!seen.has(k)) { seen.add(k); out.push(r) }
  }
  return out.slice(0, 3)
}

const SPEECH_SUPPORTED = typeof window !== 'undefined'
  && (('SpeechRecognition' in window) || ('webkitSpeechRecognition' in window))

/** 浏览器语音不可用时的兜底：录音上送后端 ASR（系统配置开启后可用） */
const FallbackMic: React.FC<{ onText: (t: string) => void; disabled?: boolean }> = ({ onText, disabled }) => {
  const { t } = useTranslation('explore')
  const [rec, setRec] = useState(false)
  const mrRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const toggle = async () => {
    if (rec) { mrRef.current?.stop(); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      chunksRef.current = []
      mr.ondataavailable = (e) => chunksRef.current.push(e.data)
      mr.onstop = async () => {
        stream.getTracks().forEach((tk) => tk.stop())
        setRec(false)
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        try {
          const r = await transcribeAudio(blob)
          if (r.text) onText(r.text)
          else message.info(t('asrEmpty'))
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('asrFail'))
        }
      }
      mr.start()
      mrRef.current = mr
      setRec(true)
    } catch {
      message.error(t('micDenied'))
    }
  }
  return (
    <Tooltip title={rec ? t('micTipOn') : t('micTipOff')}>
      <Button icon={rec ? <LoadingOutlined /> : <AudioOutlined />} type={rec ? 'primary' : 'default'}
        onClick={() => void toggle()} disabled={disabled && !rec}>
        {rec ? t('micListening') : t('micSay')}
      </Button>
    </Tooltip>
  )
}

/** 本地时间戳（以前用 toISOString 是 UTC，卡上时间比北京时间早 8 小时） */
function localStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 学生才展示探索积分（荣誉体系是学生侧的） */
const MY_ROLE: string = (() => {
  try { return String((JSON.parse(localStorage.getItem('smartkb_user') || '{}') as any).role || '') } catch { return '' }
})()

// 探究话题池：按「学生+日期」做种子随机抽 3 条——人人不同、天天不同、同日稳定
const SAMPLE_POOL_ZH = [
  '用小学生能懂的话讲讲什么是递归', '光合作用的产物是什么', '帮我起个探究主题：黑洞',
  '为什么天空是蓝色的', '恐龙是怎么灭绝的', '二维码里是怎么存信息的',
  '给我一个适合画布的探究主题：海洋', '为什么磁铁能吸铁但不能吸铜', '闪电是怎么形成的',
  '用生活例子讲讲什么是概率', '金字塔是怎么建起来的', '为什么熬夜会困',
  '帮我起个探究主题：人工智能', '月亮为什么会圆缺', '船那么重为什么能浮起来',
  '什么是区块链，能打个比方吗', '为什么冬天哈气是白的', '指南针为什么指北',
  '给我一个探究主题：一座桥的诞生', '为什么切洋葱会流泪', '火山喷发前有什么征兆',
  '用故事讲一下计算机的历史', '为什么飞机在天上不会掉下去', '银河系有多大',
  '帮我起个探究主题：身边的经济学', '为什么猫总是脚着地', 'DNA 是怎么遗传信息的',
  '一个城市是怎么供电的', '为什么声音在水里传得更快', '给我出 3 个适合做星图的科学主题',
  '为什么天空晚上是黑的', '地震是怎么测量的', '帮我起个探究主题：月球',
  '为什么煮饺子会浮起来', '古人怎么计时', '给我一个探究主题：天气',
  '为什么跑步后腿会酸', '地图上的比例尺怎么用', '帮我起个探究主题：机器人',
  '为什么铁会生锈', '灯塔是怎么给船引路的', '给我一个探究主题：丝绸之路',
]
const SAMPLE_POOL_EN = [
  'Explain recursion like I am ten', 'What do photosynthesis products mean', 'Give me a research topic: black holes',
  'Why is the sky blue', 'How do QR codes store information', 'Why does a ship float',
  'Give me a canvas topic: the ocean', 'How does a compass work', 'Explain probability with daily examples',
  'Why do we feel sleepy at night', 'How are cities powered', 'Suggest 3 science topics for a star map',
  'Why does ice float on water', 'How did ancients tell time', 'Give me a topic: how a bridge is born',
  'Why do onions make us cry', 'How are earthquakes measured', 'Give me a topic: robots',
  'Why does iron rust', 'How do lighthouses guide ships', 'Give me a topic: the Silk Road',
]

function pickSamples(username: string, lang: string, nonce: number): string[] {
  const pool = (lang || '').startsWith('zh') ? SAMPLE_POOL_ZH : SAMPLE_POOL_EN
  const day = new Date().toISOString().slice(0, 10)
  const key = username + '|' + day + '|' + nonce
  let h = 2166136261
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) }
  const rand = () => { h += 0x6D2B79F5; let x = h; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296 }
  const idx = pool.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp
  }
  return idx.slice(0, 3).map((i) => pool[i])
}

const ExploreAIPanel: React.FC<Props> = ({ canvasId, getEditor, onClose, wide, onWide, mobile, popMode, onPopToggle, pendingAsk, onAskConsumed }) => {
  const { t, i18n } = useTranslation('explore')
  const [roll, setRoll] = useState(0)
  const myName: string = (() => { try { return String((JSON.parse(localStorage.getItem('smartkb_user') || '{}') as any).username || '') } catch { return '' } })()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [genBusy, setGenBusy] = useState(false)
  const [structBusy, setStructBusy] = useState<'mind' | 'topic' | null>(null)
  const [playBusy, setPlayBusy] = useState(false)
  const [camOpen, setCamOpen] = useState(false)
  const [quota, setQuota] = useState<QuotaMap | null>(null)
  const [followUps, setFollowUps] = useState<string[]>([])
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const [pickOpen, setPickOpen] = useState(false)
  const [pickCards, setPickCards] = useState<DiscoveryCard[]>([])
  const [picking, setPicking] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const refsRef = useRef<KbRefItem[]>([])
  const lastDrawsRef = useRef<{ id: string; ts: number }[]>([])
  const [ctxHint, setCtxHint] = useState('')
  // 动作行的文字标签按面板实际宽度决定：侧栏 440 / 手机窄屏放不下六个带字按钮（会挤成两行，
  // 把输入区顶得更窄），这时只留图标 + 悬停说明；宽栏与弹出窗才显示文字。
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const [roomy, setRoomy] = useState(true)
  const inputRef = useRef('')
  const textAreaRef = useRef<any>(null)
  const prefillTimer = useRef(0)

  const refreshQuota = useCallback(() => {
    getQuota().then(setQuota).catch(() => { /* 未开放时静默 */ })
  }, [])

  useEffect(() => { refreshQuota() }, [refreshQuota])

  useEffect(() => {
    const el = actionsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const fit = () => setRoomy(el.clientWidth >= 560)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 画布卡片「追问」→ 预填输入框（由工作台派发）
  useEffect(() => {
    if (!pendingAsk) return
    setInput(pendingAsk.text)
    inputRef.current = pendingAsk.text
    window.setTimeout(() => textAreaRef.current?.focus?.(), 80)
    onAskConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk?.nonce])

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages])
  useEffect(() => () => {
    abortRef.current?.abort()
    audioRef.current?.pause()
    window.clearTimeout(prefillTimer.current)
  }, [])

  // 笔迹圈选 + 选区变化 → 输入框上方提示会带上什么内容
  useEffect(() => {
    const refreshHint = () => {
      const e2 = getEditor()
      if (!e2) { setCtxHint(''); return }
      const n = e2.getSelectedShapeIds().length
      if (n > 0) setCtxHint(t('ctxSelected', { n }))
      else if (lastDrawsRef.current.some((r) => Date.now() - r.ts < 90000)) setCtxHint(t('ctxCircle'))
      else setCtxHint('')
    }
    const onDraw = (ev: Event) => {
      const id = (ev as CustomEvent).detail?.id
      if (id) { lastDrawsRef.current.push({ id, ts: Date.now() }); if (lastDrawsRef.current.length > 8) lastDrawsRef.current.shift() }
      refreshHint()
      window.clearTimeout(prefillTimer.current)
      prefillTimer.current = window.setTimeout(() => {
        const e3 = getEditor()
        if (!e3 || inputRef.current.trim()) return
        const circ = detectPenCircles(e3, lastDrawsRef.current)
        if (!circ || !circ.inside.length) return
        // ① 智能提取：只取落在圈内的文字；② 取不到再退回问题行/首行
        const smart = smartExcerptInCircle(e3, circ)
        if (smart) {
          setInput(smart)
          setCtxHint(t('ctxExtracted'))
          window.setTimeout(() => textAreaRef.current?.focus?.(), 60)
          return
        }
        const lines = circ.inside
          .map((s: any) => shapePlainText({ type: String(s.type), props: s.props as Record<string, unknown> }))
          .join('\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 1)
        const pick = lines.find((l) => l.startsWith('Q：')) || lines[0] || ''
        const excerpt = (pick.startsWith('Q：') ? pick.slice(2) : pick).replace(/[#*·]/g, '').trim().slice(0, 80)
        if (!excerpt) return
        setInput(excerpt)
        setCtxHint(t('ctxPlaced'))
        window.setTimeout(() => textAreaRef.current?.focus?.(), 60)
      }, 700)
    }
    window.addEventListener('explore:draw-created', onDraw)
    const ed = getEditor()
    let hintTimer = 0
    const debounced = () => { window.clearTimeout(hintTimer); hintTimer = window.setTimeout(refreshHint, 250) }
    const off = ed?.store.listen(debounced, { source: 'user', scope: 'all' })
    const t0 = window.setTimeout(refreshHint, 600)
    return () => {
      window.clearTimeout(hintTimer)
      window.removeEventListener('explore:draw-created', onDraw)
      off?.()
      window.clearTimeout(t0)
    }
  }, [getEditor])

  /** 把一批形状落到当前视野正中并选中、缩放到刚好看得见（生成即定位） */
  const insertShapes = (shapes: ShapeSpec[]) => {
    const ed = getEditor()
    if (ed) insertShapesIntoEditor(ed, shapes)
  }

  const send = async (explicit?: string) => {
    const text = (explicit ?? input).trim()
    if (!text || busy) return
    setInput('')
    inputRef.current = ''
    refsRef.current = []
    const history: AskHistoryItem[] = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, { role: 'user', content: text }, { role: 'assistant', content: '', q: text }])
    setBusy(true)

    let selectionText = ''
    let pageImage = ''
    const ed = getEditor()
    if (ed) {
      let focus = ed.getSelectedShapes() as never[]
      let circMode = false
      const onlyDraws = focus.length > 0 && focus.every((s: any) => String(s.type) === 'draw')
      if (!focus.length || onlyDraws) {
        const circ = detectPenCircles(ed, lastDrawsRef.current)
        if (circ) { focus = [circ.draw, ...circ.inside] as never[]; circMode = true }
      }
      if (focus.length) {
        selectionText = collectText(focus as never)
        if (circMode && selectionText) {
          selectionText = '（学生用笔在画布上圈了一块区域；配图里的笔圈就是圈选范围，下面文字是与之重叠的卡片全文，请聚焦被圈住的部分作答）\n' + selectionText
        }
        const kinds = new Set<string>((focus as never as { type: string }[]).map((s) => String(s.type)))
        if (kinds.has('draw') || kinds.has('image') || kinds.has('asset') || kinds.has('svg-text') || kinds.has('frame')) {
          try {
            const { blob } = await ed.toImage(focus as never, { format: 'jpeg', quality: 0.86, background: true, padding: 12 })
            pageImage = await blobToDataUrl(blob)
          } catch { /* 降级纯文字 */ }
        }
      }
    }

    const ctrl = new AbortController()
    abortRef.current = ctrl
    await askExplore(
      text,
      (full) => setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { ...next[next.length - 1], content: full }
        return next
      }),
      (err) => setMessages((prev) => {
        const next = [...prev]
        next[next.length - 1] = { ...next[next.length - 1], content: '⚠️ ' + err }
        return next
      }),
      {
        canvasId, selectionText, pageImage, history, signal: ctrl.signal,
        onReferences: (items) => { refsRef.current = items },
      },
    )
    setMessages((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (last && last.role === 'assistant' && refsRef.current.length) last.refs = refsRef.current
      return next
    })
    setBusy(false)
    refreshQuota()
  }

  /** 回答沉淀成提问卡：问题、回答、教材来源、追问/朗读/复制按钮都在卡上 */
  const placeOnCanvas = (m: Msg) => {
    const ed = getEditor()
    if (!ed) { message.warning(t('canvasNotReady')); return }
    const bounds = ed.getViewportPageBounds()
    const cardId = 'shape:card' + Date.now()
    ed.createShapes([{
      id: cardId,
      type: 'ask-card',
      x: bounds.center.x - 180,
      y: bounds.center.y - 120,
      props: {
        w: 380, h: 260,
        question: (m.q || m.content || '').slice(0, 200),
        answer: (m.content || '').slice(0, 4000),
        refs: JSON.stringify((m.refs || []).slice(0, 3)),
        createdAt: localStamp(),
      },
    }] as never)
    setMessages((prev) => {
      const next = [...prev]
      const idx = next.findIndex((x) => x.role === 'assistant' && x.content === m.content)
      if (idx >= 0) next[idx] = { ...next[idx], cardId }
      return next
    })
    message.success(t('askCardSaved'))
  }

  /** 每日精选：三选一贴画布（把选择权给学生） */
  const openPick = async () => {
    setPicking(true)
    try {
      const r = await getFeed()
      const all = r.cards || []
      if (!all.length) { message.info(t('pickEmpty')); return }
      const idx = all.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, Math.min(3, all.length))
      setPickCards(idx.map((i) => all[i]))
      setPickOpen(true)
    } catch {
      message.error(t('pickFail'))
    } finally {
      setPicking(false)
    }
  }

  const pasteCard = (c: DiscoveryCard) => {
    setPickOpen(false)
    {
      const ed = getEditor()
      if (!ed) return
      const bounds = ed.getViewportPageBounds()
      ed.createShapes([{
        id: 'shape:news' + Date.now(),
        type: 'ask-card',
        x: bounds.center.x - 170,
        y: bounds.center.y - 110,
        props: {
          w: 360, h: 230,
          question: (c.emoji ? c.emoji + ' ' : '') + t('pickCardPrefix') + (c.category || ''),
          answer: c.title + '\n\n' + (c.summary || '') + (c.source ? '\n\n' + t('pickSource') + c.source : ''),
          refs: '[]',
          createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        },
      }] as never)
      message.success(t('pickPasted'))
    }
  }

  const playTts = async (text: string) => {
    if (playBusy) return
    setPlayBusy(true)
    try {
      const r = await speak(text)
      for (const url of r.urls) {
        await new Promise<void>((resolve) => {
          const audio = new Audio(url)
          audioRef.current = audio
          audio.onended = () => resolve()
          audio.onerror = () => resolve()
          void audio.play()
        })
      }
      if (r.partial) message.warning(t('partialTts'))
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('speakFail'))
    } finally {
      setPlayBusy(false)
      refreshQuota()
    }
  }

  const doGenerate = async () => {
    const desc = input.trim()
    if (!desc || genBusy) return
    setInput('')
    setMessages((prev) => [...prev,
      { role: 'user', content: t('msgGenImage', { desc }) }, { role: 'assistant', content: t('msgGenBusy') }])
    setGenBusy(true)
    try {
      const { task_id } = await submitGenerate(desc, '', canvasId)
      const r: GenResult = await pollGenerate(task_id)
      const ed = getEditor()
      if (r.mode === 'svg' && r.svg && ed) {
        await ed.putExternalContent({ type: 'svg-text', text: r.svg } as never)
        setMessages((prev) => [...prev, { role: 'assistant', content: t('msgSvgPlaced', { title: r.title || '' }) }])
      } else if (r.mode === 'image' && r.image_url && ed) {
        await ed.putExternalContent({ type: 'url', url: r.image_url } as never)
        setMessages((prev) => [...prev, { role: 'assistant', content: t('msgImagePlaced', { title: r.title || '' }) }])
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: asAssistantText(r.error, t('genFail')) }])
      }
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: 'assistant', content: asAssistantText(e?.response?.data?.detail, t('genFail')) }])
    } finally {
      setGenBusy(false)
      refreshQuota()
    }
  }

  /** 思维导图 / 知识星图：输入框当主题，生成后整棵树落到视野中心 */
  const doStructured = async (kind: 'mind' | 'topic') => {
    const topic = input.trim()
    if (!topic || structBusy) return
    setInput('')
    setMessages((prev) => [...prev,
      { role: 'user', content: kind === 'mind' ? t('msgMindPrefix', { topic }) : t('msgTopicPrefix', { topic }) },
      { role: 'assistant', content: kind === 'mind' ? t('msgMindBusy') : t('msgTopicBusy') }])
    setStructBusy(kind)
    setFollowUps([])
    try {
      const { task_id } = kind === 'mind'
        ? await submitMindmap(topic, '', canvasId)
        : await submitTopicCard(topic, '', canvasId)
      const r = await pollStruct(task_id)
      if (r.mode === 'shapes' && r.shapes?.length) {
        insertShapes(r.shapes)
        setMessages((prev) => [...prev, { role: 'assistant', content: (r.intro || t('msgTopicDone', { title: r.title || topic })) }])
        setFollowUps(r.followups || [])
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', content: asAssistantText(r.error, t('genFail')) }])
      }
    } catch (e: any) {
      setMessages((prev) => [...prev, { role: 'assistant', content: asAssistantText(e?.response?.data?.detail, t('genFail')) }])
    } finally {
      setStructBusy(null)
      refreshQuota()
    }
  }

  const onCapture = async (file: File) => {
    setCamOpen(false)
    try {
      const r = await uploadAsset(canvasId, file)
      const ed = getEditor()
      if (ed) {
        await ed.putExternalContent({ type: 'url', url: r.src } as never)
        message.success(t('photoPasted'))
      }
    } catch {
      message.error(t('photoFail'))
    }
  }

  return (
    <div ref={rootRef} style={popMode ? {
      position: 'absolute', zIndex: 900,
      // 上下锚定：高度始终等于画布可视区，输入框不可能被裁掉（此前居中+固定高会溢出）
      ...(pos ? { left: pos.x, top: pos.y, bottom: 8 } : { left: '50%', top: 8, bottom: 8, transform: 'translateX(-50%)' }),
      width: mobile ? 'calc(100% - 16px)' : 760,
      maxWidth: 'calc(100% - 16px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      borderRadius: 14, border: '1px solid var(--border-color, #e5e9f0)',
      boxShadow: '0 16px 48px rgba(15, 35, 75, 0.28)', background: 'var(--bg-container, #fff)',
    } : mobile ? {
      position: 'absolute', left: 8, right: 8, bottom: 8, top: '42%', zIndex: 100,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      borderRadius: 16, border: '1px solid var(--border-color, #e5e9f0)',
      boxShadow: '0 -6px 28px rgba(15, 35, 75, 0.22)', background: 'var(--bg-container, #fff)',
    } : {
      // bottom 80：让开 tldraw 底部居中工具栏（此前工具栏浮层会挡住输入区按钮的点击）
      position: 'absolute', right: 14, top: 14, bottom: 80, zIndex: 100,
      width: wide ? 640 : 440, maxWidth: 'calc(100vw - 24px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      borderRadius: 12, border: '1px solid var(--border-color, #e5e9f0)',
      boxShadow: '0 8px 32px rgba(15, 35, 75, 0.18)', background: 'var(--bg-container, #fff)',
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border-color, #f0f0f0)', cursor: popMode && !mobile ? 'move' : 'default', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (!popMode || mobile) return
          if ((e.target as HTMLElement).closest('button')) return
          const wrap = rootRef.current?.parentElement?.getBoundingClientRect()
          const r = rootRef.current?.getBoundingClientRect()
          if (!wrap || !r) return
          dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
          setPos({ x: r.left - wrap.left, y: r.top - wrap.top })
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return
          const wrap = rootRef.current?.parentElement?.getBoundingClientRect()
          if (!wrap) return
          const self = rootRef.current?.getBoundingClientRect()
          const w = self?.width || 400
          const nx = Math.max(4, Math.min(e.clientX - wrap.left - dragRef.current.dx, wrap.width - w - 4))
          // 窗口底边锚定在容器底部，往下拖=压扁自己：按最小可用高度(≈268px)钳制，
          // 保证头部+消息区+输入区任何时刻都完整可见
          const ny = Math.max(0, Math.min(e.clientY - wrap.top - dragRef.current.dy, Math.max(0, wrap.height - 268)))
          setPos({ x: nx, y: ny })
        }}
        onPointerUp={() => { dragRef.current = null }}
      >
        <CustomerServiceOutlined style={{ marginRight: 8 }} />
        <Text strong>{t('panelTitle')}</Text>
        <div style={{ flex: 1 }} />
        <Tooltip title={popMode ? t('popBack') : t('popOut')}>
          <Button size="small" type="text" icon={popMode ? <ColumnWidthOutlined /> : <ExpandOutlined />}
            onClick={() => { setPos(null); onPopToggle() }} />
        </Tooltip>
        {messages.length > 0 && (
          <Tooltip title={t('clearChat')}>
            <Button size="small" type="text" icon={<ClearOutlined />}
              onClick={() => { setMessages([]); setFollowUps([]); inputRef.current = ''; setInput('') }} />
          </Tooltip>
        )}
        {!mobile && !popMode && (
          <Tooltip title={wide ? t('narrow') : t('widen')}>
            <Button size="small" type="text" icon={wide ? <ShrinkOutlined /> : <ExpandAltOutlined />}
              onClick={onWide} />
          </Tooltip>
        )}
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} />
      </div>

                  <div ref={listRef} style={{ flex: 1, minHeight: 120, overflowY: 'auto', padding: '10px 10px 6px' }}>
        {messages.length === 0 && (
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            {t('panelIntro')}
          </Paragraph>
        )}
        {messages.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {pickSamples(myName, i18n.language, roll).map((s) => (
              <Button key={s} size="small" style={{ textAlign: 'left', whiteSpace: 'normal', height: 'auto', padding: '6px 10px', fontSize: 12 }}
                onClick={() => { setInput(s); inputRef.current = s; textAreaRef.current?.focus?.() }}>💬 {s}</Button>
            ))}
            <Button size="small" type="text" icon={<SyncOutlined />} style={{ alignSelf: 'flex-start', fontSize: 12 }}
              onClick={() => setRoll((v) => v + 1)}>{t('samplesReroll')}</Button>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
            <div style={{
              maxWidth: '92%', padding: '8px 10px', borderRadius: 10, fontSize: 13, lineHeight: 1.65,
              background: m.role === 'user' ? 'var(--primary-2, #e6f4ff)' : 'var(--bg-layout, #f6f6f6)',
              wordBreak: 'break-word',
              whiteSpace: m.role === 'assistant' && m.content && !m.content.startsWith('⚠️') ? 'normal' : 'pre-wrap',
            }}>
              {m.role === 'assistant' && m.content && !m.content.startsWith('⚠️')
                ? <div className="explore-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown></div>
                : (m.content || (busy ? t('thinking') : ''))}
              {m.role === 'assistant' && !!m.refs?.length && (
                <div style={{
                  marginTop: 6, fontSize: 11, color: 'var(--text-secondary, #999)',
                  display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'flex-start',
                }}>
                  <span style={{ flexShrink: 0, lineHeight: '20px' }}>{t('kbSourceLabel')}</span>
                  {uniqRefs(m.refs).map((r, j) => {
                    const label = (r.doc_name || '') + (r.title ? '·' + r.title : '')
                    return (
                      <Tooltip key={j} title={label}>
                        <Tag style={{ fontSize: 11, margin: 0, maxWidth: '100%', whiteSpace: 'normal', lineHeight: 1.5, textAlign: 'left' }}>
                          {label.length > 34 ? label.slice(0, 33) + '…' : label}
                        </Tag>
                      </Tooltip>
                    )
                  })}
                </div>
              )}
              {m.role === 'assistant' && m.content && !m.content.startsWith('⚠️') && i === messages.length - 1 && (
                <Space size={4} style={{ marginTop: 6 }}>
                  <Tooltip title={t('dropCanvasTip')}>
                    <Button size="small" icon={<ExportOutlined />} onClick={() => placeOnCanvas(m)}>{t('dropCanvas')}</Button>
                  </Tooltip>
                  <Tooltip title={t('readAloudTip')}>
                    <Button size="small" icon={<SoundOutlined />} loading={playBusy} onClick={() => void playTts(m.content)}>{t('readAloud')}</Button>
                  </Tooltip>
                  {!!m.cardId && (
                    <Tooltip title={t('locateTip')}>
                      <Button size="small" icon={<AimOutlined />} onClick={() => {
                        const ed = getEditor()
                        if (!ed || !m.cardId) return
                        try {
                          ed.setSelectedShapes([m.cardId] as never)
                          const b = ed.getShapePageBounds(m.cardId as never)
                          if (b) ed.zoomToBounds(new Box(b.x, b.y, b.w, b.h), { inset: 80, animation: { duration: 200 } })
                        } catch { /* 卡片可能已被删除 */ }
                      }}>{t('locate')}</Button>
                    </Tooltip>
                  )}
                </Space>
              )}
            </div>
          </div>
        ))}
      </div>

      {!!followUps.length && (
        <div style={{
          padding: '0 10px 6px', display: 'flex', flexWrap: 'nowrap', gap: 6,
          overflowX: 'auto', scrollbarWidth: 'thin',
        }}>
          {followUps.map((f, i) => (
            <Button key={i} size="small" shape="round" icon={<RocketOutlined />} disabled={busy}
              style={{ flexShrink: 0 }} onClick={() => void send(f)}>{f}</Button>
          ))}
        </div>
      )}

      {quota && (
        <div style={{ padding: '2px 12px', fontSize: 11, color: 'var(--text-secondary, #999)' }}>
          {t('quotaLeft', { chat: Math.max(0, quota.chat.limit - quota.chat.used), image: Math.max(0, quota.image.limit - quota.image.used), tts: Math.max(0, quota.tts.limit - quota.tts.used) })}
          {quota.points && MY_ROLE === 'student' ? t('quotaPoints', { used: quota.points.used, cap: quota.points.cap }) : ''}
        </div>
      )}

      <div style={{ padding: '6px 10px 10px', borderTop: '1px solid var(--border-color, #f0f0f0)' }}>
        {!!ctxHint && (
          <div style={{ fontSize: 11, color: '#389e0d', marginBottom: 6 }}>🟢 {ctxHint}</div>
        )}
        <TextArea
          ref={textAreaRef}
          value={input}
          onChange={(e) => { setInput(e.target.value); inputRef.current = e.target.value }}
          onPressEnter={(e) => { if (!e.shiftKey) { e.preventDefault(); void send() } }}
          placeholder={t('askPh')}
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={busy}
        />
        <div ref={actionsRef} style={{ display: 'flex', gap: 4, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={() => void send()} style={{ marginInlineEnd: 4 }}>{t('askAi')}</Button>
          <Tooltip title={t('mindmapTip')}>
            <Button icon={<ApartmentOutlined />} aria-label={t('mindmap')} loading={structBusy === 'mind'} disabled={!!structBusy && structBusy !== 'mind'}
              onClick={() => void doStructured('mind')}>{roomy ? t('mindmap') : null}</Button>
          </Tooltip>
          <Tooltip title={t('topicmapTip')}>
            <Button icon={<DeploymentUnitOutlined />} aria-label={t('topicmap')} loading={structBusy === 'topic'} disabled={!!structBusy && structBusy !== 'topic'}
              onClick={() => void doStructured('topic')}>{roomy ? t('topicmap') : null}</Button>
          </Tooltip>
          <Tooltip title={t('genimgTip')}>
            <Button icon={<PictureOutlined />} aria-label={t('genimg')} loading={genBusy} onClick={() => void doGenerate()}>{roomy ? t('genimg') : null}</Button>
          </Tooltip>
          <Tooltip title={t('pickTip')}>
            <Button icon={<ReadOutlined />} aria-label={t('pick')} loading={picking} onClick={() => void openPick()}>{roomy ? t('pick') : null}</Button>
          </Tooltip>
          <Tooltip title={t('photoTip')}>
            <Button icon={<CameraOutlined />} aria-label={t('photo')} onClick={() => setCamOpen(true)}>{roomy ? t('photo') : null}</Button>
          </Tooltip>
          <div style={{ flex: 1 }} />
          {SPEECH_SUPPORTED
            ? <VoiceInput onTranscript={(txt) => setInput((s) => (s ? s + txt : txt))} disabled={busy} />
            : <FallbackMic onText={(txt) => setInput((s) => (s ? s + txt : txt))} disabled={busy} />}
        </div>
      </div>

      <Modal title={t('pickModalTitle')} open={pickOpen} footer={null} onCancel={() => setPickOpen(false)}>
        {pickCards.map((c, i) => (
          <div key={i} style={{ padding: '10px 2px', borderBottom: '1px solid var(--border-color, #f0f0f0)', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{c.emoji ? c.emoji + ' ' : ''}{c.title}
                <Tag style={{ marginInlineStart: 6 }}>{c.category}</Tag></div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.summary}</div>
            </div>
            <Button size="small" type="primary" onClick={() => pasteCard(c)}>{t('pickPaste')}</Button>
          </div>
        ))}
      </Modal>

      <CameraCapture open={camOpen} onClose={() => setCamOpen(false)} onCapture={(f) => void onCapture(f)} />
      <style>{`
        .explore-md p { margin: 0 0 6px; }
        .explore-md ul, .explore-md ol { margin: 0 0 6px; padding-left: 18px; }
        .explore-md li { margin: 2px 0; }
        .explore-md h1, .explore-md h2, .explore-md h3, .explore-md h4 { font-size: 13px; margin: 6px 0 4px; }
        .explore-md code { background: #eef2f7; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
        .explore-md pre { background: #f2f4f7; padding: 8px; border-radius: 6px; overflow-x: auto; margin: 0 0 6px; }
        .explore-md blockquote { margin: 0 0 6px; padding-left: 8px; border-left: 3px solid #d6e2f5; color: #556; }
        .explore-md table { border-collapse: collapse; margin: 0 0 6px; }
        .explore-md td, .explore-md th { border: 1px solid #e3e8f0; padding: 2px 6px; font-size: 12px; }
      `}</style>
    </div>
  )
}

export default ExploreAIPanel