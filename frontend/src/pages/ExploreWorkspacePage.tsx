/** 探索画布 · 工作台：页签 + 画布 + 保存状态 + 连续使用提醒（40 分钟） */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { Button, Drawer, Dropdown, Empty, Input, Modal, Popconfirm, Space, Tabs, Tag, Tooltip, message } from 'antd'
import { AppstoreOutlined, ArrowLeftOutlined, CustomerServiceOutlined, DeleteOutlined, EditOutlined, FolderAddOutlined, HistoryOutlined, MoreOutlined, PlusSquareOutlined, RestOutlined, SendOutlined } from '@ant-design/icons'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ExploreCanvas from '../components/explore/ExploreCanvas'
import PageThumb from '../components/explore/PageThumb'
import { useAuthStore } from '../stores/authStore'
import ExploreAIPanel from '../components/explore/ExploreAIPanel'
import { insertShapesIntoEditor } from '../components/explore/shapeInsert'
import { BUILTIN_TEMPLATES } from '../constants/exploreTemplates'
import {
  addPage, archivePage, archivePortfolio, createShare, deletePage, getCanvas, getQuota, listPageTrash, pageHistory, publishTemplate, renameCanvas, restoreHistory, restorePage, savePage, speak, uploadAsset,
  type ExplorePageMeta, type HistoryItem, type PageTrashItem, type SaveState,
} from '../api/explore'

// 连续使用提醒默认 40 分钟，实际值由 /api/explore/quota 按系统配置下发

/** 角色判定走平台统一数据源（authStore 的 role 是字符串 student/teacher/admin） */

/** 页面标题的默认形态（后端自动写“第 N 页”）：命中就按现存顺序显示连续序号，自定义标题原样保留 */
const DEFAULT_PAGE_TITLE = /^第\s*\d+\s*页$/

const ExploreWorkspacePage: React.FC = () => {
  const { canvasId } = useParams()
  const cid = Number(canvasId)
  const nav = useNavigate()
  const { t } = useTranslation('explore')
  const myRole = useAuthStore((s) => s.user?.role)
  const [title, setTitle] = useState('')
  const [pages, setPages] = useState<ExplorePageMeta[]>([])
  const [sp, setSp] = useSearchParams()
  const [current, setCurrent] = useState(() => { const n = Number(sp.get('page')); return Number.isFinite(n) && n > 0 ? n : 1 })
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [renameOpen, setRenameOpen] = useState(false)
  const [nameInput, setNameInput] = useState('')

  const lastActiveRef = useRef(Date.now())
  const sessionMsRef = useRef(0)
  const editorRef = useRef<Editor | null>(null)
  const revRef = useRef(0)   // 与画布组件共享的快照版本号
  const [remindMin, setRemindMin] = useState(40)
  const [mobile, setMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    getQuota().then((q) => { if (q?.continuous_remind_min) setRemindMin(q.continuous_remind_min) }).catch(() => { /* 未开放时用默认 */ })
  }, [])
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [panelOpen, setPanelOpen] = useState(() => localStorage.getItem('explore:panel:open') === '1' && window.innerWidth >= 768)
  const [popMode, setPopMode] = useState(() => localStorage.getItem('explore:panel:mode') === 'pop')
  const togglePop = () => setPopMode((v) => { localStorage.setItem('explore:panel:mode', v ? 'side' : 'pop'); return !v })
  const [wide, setWide] = useState(() => localStorage.getItem('explore:panel:wide') === '1')
  const toggleWide = () => setWide((v) => { localStorage.setItem('explore:panel:wide', v ? '0' : '1'); return !v })
  const togglePanel = () => setPanelOpen((v) => { localStorage.setItem('explore:panel:open', v ? '0' : '1'); return !v })
  const [histOpen, setHistOpen] = useState(false)
  const [pendingAsk, setPendingAsk] = useState<{ text: string; nonce: number } | null>(null)
  const cardAudioRef = useRef<HTMLAudioElement | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [histItems, setHistItems] = useState<HistoryItem[]>([])
  // 页面回收站：删掉的页只是软删，快照和时间线都还在，30 天内可还原
  const [pageTrash, setPageTrash] = useState<PageTrashItem[]>([])
  const [pageTrashOpen, setPageTrashOpen] = useState(false)
  // ── M2：分享给老师 / 发布为模板 ──
  const [shareOpen, setShareOpen] = useState(false)
  const [shareTitle, setShareTitle] = useState('')
  const [sharing, setSharing] = useState(false)
  const [tplOpen, setTplOpen] = useState(false)
  const [tplTitle, setTplTitle] = useState('')
  const [tplDesc, setTplDesc] = useState('')
  const [publishing, setPublishing] = useState(false)

  // 从模板库「系统范例」进来：把预置卡片落到这一页，落完就把 seed 从地址栏抹掉
  const seededRef = useRef(false)
  const onCanvasReady = useCallback(() => {
    const seed = sp.get('seed')
    if (!seed || seededRef.current) return
    const tpl = BUILTIN_TEMPLATES.find((x) => x.id === seed)
    const ed = editorRef.current
    if (!tpl || !ed) return
    seededRef.current = true
    insertShapesIntoEditor(ed, tpl.shapes)
    void savePage(cid, current, JSON.stringify(ed.getSnapshot()), undefined, revRef.current)
      .then((r) => { revRef.current = r.rev ?? revRef.current })
      .catch(() => { /* 自动保存还会再试一次 */ })
    const next = new URLSearchParams(sp)
    next.delete('seed')
    setSp(next, { replace: true })
  }, [sp, setSp, cid, current])

  const refresh = useCallback(async () => {
    try {
      const d = await getCanvas(cid)
      setTitle(d.canvas.title)
      setPages(d.pages)
      void listPageTrash(cid).then(setPageTrash).catch(() => setPageTrash([]))
      if (d.pages.length && !d.pages.some((p) => p.page_number === current)) {
        setCurrent(d.pages[0].page_number)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('errCanvasLoad'))
      nav('/explore')
    }
  }, [cid, current, nav]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 这一页在页签上的序号：page_number 是稳定内部编号，删页会留空洞，展示要用位置 */
  const ordinalOf = useCallback((pn: number) => {
    const i = pages.findIndex((p) => p.page_number === pn)
    return i >= 0 ? i + 1 : pn
  }, [pages])

  useEffect(() => { if (Number.isFinite(cid) && cid > 0) void refresh() }, [cid]) // eslint-disable-line react-hooks/exhaustive-deps

  // 连续使用 40 分钟提醒：近 2 分钟有操作才算"连续"
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (Date.now() - lastActiveRef.current < 120000) sessionMsRef.current += 30000
      else sessionMsRef.current = 0
      if (sessionMsRef.current >= remindMin * 60000) {
        sessionMsRef.current = 0
        Modal.warning({
          title: t('breakTitle'),
          content: t('breakBody', { n: remindMin }),
        })
      }
    }, 30000)
    return () => window.clearInterval(iv)
  }, [remindMin])

  const onActivity = () => { lastActiveRef.current = Date.now() }

  // 画布提问卡上的按钮：面板关着也能用（追问→唤起面板并预填；朗读/复制就地执行）
  useEffect(() => {
    const onCard = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { action: string; question: string; answer: string }
      if (!d) return
      if (d.action === 'followup') {
        localStorage.setItem('explore:panel:open', '1')
        setPanelOpen(true)
        setPendingAsk({ text: t('followupPrefix', { q: (d.question || '').slice(0, 24) }), nonce: Date.now() })
      } else if (d.action === 'speak') {
        speak(d.answer || d.question || '').then((r) => {
          r.urls.reduce((p, url) => p.then(() => new Promise<void>((resolve) => {
            const a = new Audio(url); cardAudioRef.current = a; a.onended = () => resolve(); a.onerror = () => resolve(); void a.play()
          })), Promise.resolve())
        }).catch(() => message.warning(t('speakFail')))
      } else if (d.action === 'copy') {
        void navigator.clipboard.writeText(d.answer || '').then(
          () => message.success(t('copied')), () => message.warning(t('copyDenied')))
      }
    }
    window.addEventListener('explore:card-action', onCard)
    return () => window.removeEventListener('explore:card-action', onCard)
  }, [])

  /** 一键整理布局：把卡片（geo/note/text/ask-card）按行列重排；笔迹/箭头/图片不动 */
  const doOrganize = () => {
    const ed = editorRef.current
    if (!ed) return
    const movable = ed.getCurrentPageShapes()
      .filter((s) => ['geo', 'note', 'text', 'ask-card'].includes(String(s.type)))
      .map((s) => ({ s, b: ed.getShapePageBounds(s.id) }))
      .filter((x) => !!x.b)
    if (movable.length < 3) { message.info(t('tooFewCards')); return }
    Modal.confirm({
      title: t('organizeTitle'),
      content: t('organizeBody'),
      okText: t('organizeOk'),
      onOk: () => {
        movable.sort((a, z) => (a.b!.y - z.b!.y) || (a.b!.x - z.b!.x))
        const maxW = Math.max(...movable.map((x) => x.b!.w))
        const maxH = Math.max(...movable.map((x) => x.b!.h))
        const gap = 48
        const perRow = Math.max(2, Math.min(4, Math.floor(1200 / (maxW + gap))))
        const vp = ed.getViewportPageBounds()
        const updates = movable.map((x, i) => ({
          id: x.s.id,
          type: x.s.type,
          x: vp.x + 60 + (i % perRow) * (maxW + gap),
          y: vp.y + 60 + Math.floor(i / perRow) * (maxH + gap),
        }))
        ed.updateShapes(updates as never)
        message.success(t('organizeDone', { n: updates.length }))
      },
    })
  }

  /** 一键清除本页：先存当前内容并强制归档到时间线，再清空——后悔可回 */
  const doClearPage = () => {
    const ed = editorRef.current
    if (!ed) { message.warning(t('canvasNotReady')); return }
    if (ed.getCurrentPageShapes().length === 0) { message.info(t('pageEmpty')); return }
    Modal.confirm({
      title: t('clearTitle'),
      content: t('clearBody'),
      okText: t('clearOk'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const snap = JSON.stringify(ed.getSnapshot())
          revRef.current = (await savePage(cid, current, snap, undefined, revRef.current)).rev ?? revRef.current
          await archivePage(cid, current, snap)
          ed.deleteShapes(ed.getCurrentPageShapes().map((s) => s.id) as never)
          revRef.current = (await savePage(cid, current, JSON.stringify(ed.getSnapshot()), undefined, revRef.current)).rev ?? revRef.current
          setSaveState('saved')
          message.success(t('clearDone'))
        } catch (e: any) {
          message.error(e?.response?.data?.detail || t('clearFail'))
        }
      },
    })
  }

  const buildCover = async (): Promise<string> => {
    const ed = editorRef.current
    if (!ed) return ''
    const shapes = ed.getCurrentPageShapes()
    if (!shapes.length) return ''
    try {
      const { blob } = await ed.toImage(shapes as never, { format: 'png', background: true, padding: 24 })
      const png = new File([blob], 'cover.png', { type: 'image/png' })
      const up = await uploadAsset(cid, png)
      return up.src
    } catch { return '' }
  }

  const doShareSubmit = async () => {
    const ed = editorRef.current
    if (!ed || sharing) return
    if (!ed.getCurrentPageShapes().length) { message.info(t('shareEmpty')); return }
    setSharing(true)
    try {
      // 先把服务端快照存到最新，再生成分享副本——老师看到的就是这一刻的最新状态
      revRef.current = (await savePage(cid, current, JSON.stringify(ed.getSnapshot()), undefined, revRef.current)).rev ?? revRef.current
      const src = await buildCover()
      const r = await createShare({ canvas_id: cid, page_number: current, title: shareTitle.trim(), image_src: src })
      message.success(t('shareDone', { date: (r.expires_at || '').slice(5, 10) }))
      setShareOpen(false)
    } catch (e: any) {
      message.error(e?.response?.status === 409 ? t('saveConflict') : (e?.response?.data?.detail || t('shareFail')))
    } finally { setSharing(false) }
  }

  const doPublishSubmit = async () => {
    const ed = editorRef.current
    const tt = tplTitle.trim()
    if (!ed || publishing) return
    if (!tt) { message.info(t('tplNeedName')); return }
    if (!ed.getCurrentPageShapes().length) { message.info(t('tplEmpty')); return }
    setPublishing(true)
    try {
      revRef.current = (await savePage(cid, current, JSON.stringify(ed.getSnapshot()), undefined, revRef.current)).rev ?? revRef.current
      const src = await buildCover()
      const r = await publishTemplate({ canvas_id: cid, page_number: current, title: tt, description: tplDesc.trim(), image_src: src })
      message.success(t('tplDone', { title: r.title }))
      setTplOpen(false)
    } catch (e: any) {
      message.error(e?.response?.status === 409 ? t('saveConflict') : (e?.response?.data?.detail || t('tplFail')))
    } finally { setPublishing(false) }
  }

  /** 一键存入成长档案：整页导出成图片（限边长防膨胀）→ 上传入册 → 服务端归档+弱积分+徽章 */
  const doArchive = async () => {
    const ed = editorRef.current
    if (!ed || archiving) return
    const shapes = ed.getCurrentPageShapes()
    if (!shapes.length) { message.info(t('archEmpty')); return }
    setArchiving(true)
    try {
      const { blob } = await ed.toImage(shapes as never, { format: 'png', background: true, padding: 24 })
      const png = new File([blob], 'archive.png', { type: 'image/png' })
      const up = await uploadAsset(cid, png)
      const r = await archivePortfolio(cid, current, { image_src: up.src, title: title ? title + ' · ' + t('pageLabel', { n: ordinalOf(current) }) : '' })
      const badgeText = (r.badges || []).map((b) => b.icon + ' ' + b.name).join('、')
      message.success(t('archDone')
        + (r.points ? t('archPoints', { n: r.points }) : '')
        + (badgeText ? t('archBadges', { names: badgeText }) : ''))
    } catch (e: any) {
      message.error(e?.response?.status === 409 ? t('saveConflict') : (e?.response?.data?.detail || t('archFail')))
    } finally {
      setArchiving(false)
    }
  }

  const openHistory = async () => {
    setHistOpen(true)
    try { setHistItems(await pageHistory(cid, current)) }
    catch { setHistItems([]) }
  }

  const doRestore = async (hid: number) => {
    const ed = editorRef.current
    if (!ed) { message.warning(t('canvasNotReady')); return }
    try {
      // 服务端先把当前内容存档，再取目标快照；前端载入后立即显式写回（双向可回）
      const snapText = await restoreHistory(cid, current, hid)
      if (!snapText) { message.info(t('histEmptySnap')); return }
      ed.store.mergeRemoteChanges(() => { ed.loadSnapshot(JSON.parse(snapText)) })
      revRef.current = (await savePage(cid, current, JSON.stringify(ed.getSnapshot()), undefined, revRef.current)).rev ?? revRef.current
      setSaveState('saved')
      setHistOpen(false)
      message.success(t('histDone'))
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('histFail'))
    }
  }

  const doAddPage = async () => {
    try {
      const d = await addPage(cid)
      setCurrent(d.page_number)
      await refresh()
    } catch { message.error(t('addPageFail')) }
  }

  const doDeletePage = (pn: number) => {
    Modal.confirm({
      title: t('delPageTitle'),
      content: t('delPageBody'),
      okButtonProps: { danger: true },
      okText: t('delBtn'),
      onOk: async () => {
        try {
          await deletePage(cid, pn)
          const next = pages.find((p) => p.page_number !== pn)
          if (next) setCurrent(next.page_number)
          await refresh()
          message.success(t('pageTrashed'))
        } catch (e: any) { message.error(e?.response?.data?.detail || t('delPageFail')) }
      },
    })
  }

  const openPageTrash = async () => {
    try { setPageTrash(await listPageTrash(cid)) } catch { setPageTrash([]) }
    setPageTrashOpen(true)
  }

  const doRestorePage = async (pn: number) => {
    try {
      await restorePage(cid, pn)
      setPageTrash(await listPageTrash(cid).catch(() => []))
      setCurrent(pn)
      await refresh()
      message.success(t('pageRestored'))
    } catch (e: any) { message.error(e?.response?.data?.detail || t('pageRestoreFail')) }
  }

  const doRename = async () => {
    const nextTitle = nameInput.trim()
    if (!nextTitle) return
    try {
      await renameCanvas(cid, nextTitle)
      setTitle(nextTitle)
      setRenameOpen(false)
    } catch { message.error(t('renameFail')) }
  }

  const displayPages: ExplorePageMeta[] = pages.length
    ? pages
    : [{ page_number: 1, ordinal: 1, title: '第 1 页', updated_at: '' }]

  const tabItems = displayPages.map((p, i) => ({
    key: String(p.page_number),
    // 删过页的画布 page_number 不连续，页签一律按现存顺序重新编号
    label: DEFAULT_PAGE_TITLE.test(p.title || '') ? t('pageLabel', { n: p.ordinal ?? i + 1 }) : p.title,
    closable: displayPages.length > 1,
  }))

  const saveTagMap: Record<SaveState, { text: string; color: string }> = {
    idle: { text: t('saveIdle'), color: 'default' },
    saving: { text: t('saveSaving'), color: 'processing' },
    saved: { text: t('saveSaved'), color: 'success' },
    offline: { text: t('saveOffline'), color: 'warning' },
    conflict: { text: t('saveConflict'), color: 'error' },
    toolarge: { text: t('saveTooLarge'), color: 'error' },
  }
  const tag = saveTagMap[saveState]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: mobile ? 6 : 10,
        padding: mobile ? '6px 8px' : '8px 16px', borderBottom: '1px solid var(--border-color, #f0f0f0)', flexShrink: 0,
      }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => nav('/explore')} />
        <span style={{
          fontWeight: 600, fontSize: 15, maxWidth: mobile ? 130 : 320,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title || t('untitledCanvas')}</span>
        <Button size="small" type="text" icon={<EditOutlined />}
          onClick={() => { setNameInput(title); setRenameOpen(true) }} />
        <div style={{ flex: 1 }} />
        <Tag color={tag.color}>{tag.text}</Tag>
        {mobile ? (
          <Dropdown
            menu={{
              items: [
                { key: 'ai', label: t('aiAssistant'), icon: <CustomerServiceOutlined /> },
                { key: 'hist', label: t('history'), icon: <HistoryOutlined /> },
                { key: 'organize', label: t('organize'), icon: <AppstoreOutlined /> },
                { key: 'arch', label: t('archive'), icon: <FolderAddOutlined />, disabled: archiving },
                ...(myRole === 'student'
                  ? [{ key: 'share', label: t('shareBtn'), icon: <SendOutlined /> }]
                  : [{ key: 'tpl', label: t('tplBtn'), icon: <PlusSquareOutlined /> }]),
                { key: 'clear', label: t('clearPage'), icon: <DeleteOutlined />, danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'ai') togglePanel()
                else if (key === 'hist') void openHistory()
                else if (key === 'organize') doOrganize()
                else if (key === 'arch') void doArchive()
                else if (key === 'share') { setShareTitle(''); setShareOpen(true) }
                else if (key === 'tpl') { setTplTitle(title); setTplOpen(true) }
                else if (key === 'clear') doClearPage()
              },
            }}
          >
            <Button size="small" icon={<MoreOutlined />} />
          </Dropdown>
        ) : (
          <>
            <Button size="small" icon={<AppstoreOutlined />} onClick={doOrganize}>{t('organize')}</Button>
            <Button size="small" icon={<HistoryOutlined />} onClick={() => void openHistory()}>{t('history')}</Button>
            <Tooltip title={t('archiveTip')}>
              <Button size="small" icon={<FolderAddOutlined />} loading={archiving} onClick={() => void doArchive()}>{t('archive')}</Button>
            </Tooltip>
            {myRole === 'student' && (
              <Tooltip title={t('shareTip')}>
                <Button size="small" icon={<SendOutlined />} onClick={() => { setShareTitle(''); setShareOpen(true) }}>{t('shareBtn')}</Button>
              </Tooltip>
            )}
            {myRole !== 'student' && (
              <Tooltip title={t('tplTip')}>
                <Button size="small" icon={<PlusSquareOutlined />} onClick={() => { setTplTitle(title); setTplOpen(true) }}>{t('tplBtn')}</Button>
              </Tooltip>
            )}
            <Tooltip title={t('clearTip')}>
              <Button size="small" icon={<DeleteOutlined />} onClick={doClearPage}>{t('clearPage')}</Button>
            </Tooltip>
            <Button size="small" type={panelOpen ? 'primary' : 'default'} icon={<CustomerServiceOutlined />} onClick={togglePanel}>{t('aiAssistant')}</Button>
          </>
        )}
      </div>

      <Tabs
        type="editable-card"
        items={tabItems}
        activeKey={String(current)}
        onChange={(k) => setCurrent(Number(k))}
        onEdit={(targetKey, action) => {
          if (action === 'add') void doAddPage()
          else if (action === 'remove') doDeletePage(Number(targetKey))
        }}
        tabBarExtraContent={{
          right: (
            <Tooltip title={t('pageTrashTip')}>
              <Button size="small" type="text" icon={<RestOutlined />} onClick={() => void openPageTrash()}>
                {mobile ? (pageTrash.length ? String(pageTrash.length) : null)
                  : t('pageTrash') + (pageTrash.length ? ' · ' + pageTrash.length : '')}
              </Button>
            </Tooltip>
          ),
        }}
        style={{ padding: '0 16px', flexShrink: 0 }}
      />

      <div className={'explore-canvas-wrap' + (panelOpen ? ' panel-open' : '') + (wide ? ' panel-wide' : '') + (panelOpen && popMode ? ' panel-pop' : '')} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <ExploreCanvas
          key={cid + ':' + current}
          canvasId={cid}
          pageNumber={current}
          onSaveState={setSaveState}
          onActivity={onActivity}
          externalEditorRef={editorRef}
          externalRevRef={revRef}
          onReady={onCanvasReady}
        />
        {panelOpen ? (
          <ExploreAIPanel
            canvasId={cid}
            getEditor={() => editorRef.current}
            onClose={() => { localStorage.setItem('explore:panel:open', '0'); setPanelOpen(false) }}
            wide={wide}
            onWide={toggleWide}
            mobile={mobile}
            popMode={popMode}
            onPopToggle={togglePop}
            pendingAsk={pendingAsk}
            onAskConsumed={() => setPendingAsk(null)}
          />
        ) : (
          <Tooltip title={t('aiFabTip')}>
            <button
              className="explore-fab"
              onClick={togglePanel}
              style={{
                position: 'absolute', zIndex: 25,
                width: 54, height: 54, borderRadius: '50%', cursor: 'pointer',
                border: '1px solid var(--border-color, #d9e3f2)', background: '#fff',
                boxShadow: '0 4px 16px rgba(15, 35, 75, 0.18)', fontSize: 26, lineHeight: 1,
              }}
            >🤖</button>
          </Tooltip>
        )}
      </div>

      <Modal title={t('shareModalTitle')} open={shareOpen} onCancel={() => setShareOpen(false)} onOk={doShareSubmit} okText={t('shareOk')} confirmLoading={sharing}>
        <Space orientation="vertical" style={{ width: '100%' }} size={10}>
          <Input value={shareTitle} maxLength={60} placeholder={t('shareNamePh')} onChange={(e) => setShareTitle(e.target.value)} autoFocus />
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', lineHeight: 1.7 }}>{t('sharePrivacy')}</div>
        </Space>
      </Modal>

      <Modal title={t('tplModalTitle')} open={tplOpen} onCancel={() => setTplOpen(false)} onOk={doPublishSubmit} okText={t('tplOk')} confirmLoading={publishing}>
        <Space orientation="vertical" style={{ width: '100%' }} size={10}>
          <Input value={tplTitle} maxLength={60} placeholder={t('tplNamePh')} onChange={(e) => setTplTitle(e.target.value)} autoFocus />
          <Input.TextArea value={tplDesc} maxLength={200} rows={2} placeholder={t('tplDescPh')} onChange={(e) => setTplDesc(e.target.value)} />
          <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', lineHeight: 1.7 }}>{t('tplPrivacy')}</div>
        </Space>
      </Modal>

      <Drawer title={t('histTitle')} placement="right" size={mobile ? 320 : 400} open={histOpen} onClose={() => setHistOpen(false)}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', lineHeight: 1.7, marginBottom: 10 }}>
          {t('histHint')}
        </div>
        {histItems.length === 0 ? (
          <Empty description={t('histEmpty')} />
        ) : (
          <div>
            {histItems.map((it, i) => (
              <div key={it.id} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 2px', borderBottom: '1px solid var(--border-color, #f0f0f0)',
              }}>
                <PageThumb preview={it.preview} width={mobile ? 96 : 128} height={mobile ? 70 : 92} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{it.saved_at}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 2 }}>
                    {Math.max(1, Math.round(it.bytes / 1024))} KB
                    {i === 0 && <Tag style={{ marginInlineStart: 6 }}>{t('histLatest')}</Tag>}
                  </div>
                  <Popconfirm title={t('restoreTitle')} description={t('restoreBody')} okText={t('restoreOk')}
                    onConfirm={() => void doRestore(it.id)}>
                    <Button size="small" style={{ marginTop: 8 }}>{t('restoreHere')}</Button>
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <style>{`
        .explore-canvas-wrap .tlui-style-panel__wrapper { transition: transform 0.18s ease; }
        /* 弹出对话窗 = 专注对话：tldraw 工具栏与样式面板让位，收回侧栏模式即恢复 */
        .explore-canvas-wrap.panel-pop .tlui-style-panel__wrapper { display: none; }
        /* tldraw 5.x 把工具条根节点改名成 .tlui-main-toolbar，两个都写，否则规则是死的 */
        .explore-canvas-wrap.panel-pop .tlui-toolbar,
        .explore-canvas-wrap.panel-pop .tlui-main-toolbar { display: none; }
        .explore-canvas-wrap.panel-open .tlui-style-panel__wrapper { transform: translateX(-470px); }
        .explore-canvas-wrap.panel-open.panel-wide .tlui-style-panel__wrapper { transform: translateX(-670px); }
        @media (max-width: 1000px) {
          .explore-canvas-wrap.panel-open .tlui-style-panel__wrapper { display: none; }
        }
        /* 悬浮 AI 入口：默认压在右下角，手机上要抬到 tldraw 工具条之上 */
        .explore-fab { right: 22px; bottom: 26px; }
        /* 手机上 AI 面板占下半屏：tldraw 工具条/样式面板不让位就会盖住输入区（点不到也看不见） */
        @media (max-width: 767px) {
          .explore-canvas-wrap .tlui-style-panel__wrapper { display: none; }
          .explore-canvas-wrap.panel-open .tlui-toolbar,
          .explore-canvas-wrap.panel-open .tlui-main-toolbar { display: none; }
          .explore-fab { right: 14px; bottom: calc(env(safe-area-inset-bottom, 0px) + 108px); }
        }
      `}</style>

      <Modal title={t('pageTrashTitle')} open={pageTrashOpen} onCancel={() => setPageTrashOpen(false)}
        footer={<Button onClick={() => setPageTrashOpen(false)}>{t('close')}</Button>} width={560}>
        {pageTrash.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('pageTrashEmpty')} />
        ) : (
          pageTrash.map((p) => (
            <div key={p.page_number} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px',
              borderBottom: '1px solid var(--border-color, #f0f0f0)',
            }}>
              <PageThumb preview={p.preview} width={104} height={76} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)', marginTop: 2 }}>
                  {t('pageTrashRow', { time: p.archived_at, n: p.history_count })}
                </div>
              </div>
              <Button size="small" type="primary" onClick={() => void doRestorePage(p.page_number)}>{t('restore')}</Button>
            </div>
          ))
        )}
      </Modal>

      <Modal title={t('rename')} open={renameOpen} onOk={doRename} onCancel={() => setRenameOpen(false)}>
        <Input value={nameInput} maxLength={60} onChange={(e) => setNameInput(e.target.value)} onPressEnter={doRename} autoFocus />
      </Modal>
    </div>
  )
}

export default ExploreWorkspacePage