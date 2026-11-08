/** 探索画布 · 工作台：页签 + 画布 + 保存状态 + 连续使用提醒（40 分钟） */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { Button, Drawer, Dropdown, Empty, Input, Modal, Popconfirm, Space, Tabs, Tag, Tooltip, message } from 'antd'
import { AppstoreOutlined, ArrowLeftOutlined, CustomerServiceOutlined, DeleteOutlined, EditOutlined, FolderAddOutlined, HistoryOutlined, MoreOutlined, PlusSquareOutlined, SendOutlined } from '@ant-design/icons'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ExploreCanvas from '../components/explore/ExploreCanvas'
import { useAuthStore } from '../stores/authStore'
import ExploreAIPanel from '../components/explore/ExploreAIPanel'
import {
  addPage, archivePage, archivePortfolio, createShare, deletePage, getCanvas, pageHistory, publishTemplate, renameCanvas, restoreHistory, savePage, speak, uploadAsset,
  type ExplorePageMeta, type HistoryItem, type SaveState,
} from '../api/explore'

// 与系统配置 EXPLORE_CONTINUOUS_REMIND_MIN 同值（M0 先取默认，接线配置属 T9）
const CONTINUOUS_REMIND_MIN = 40

/** 角色判定走平台统一数据源（authStore 的 role 是字符串 student/teacher/admin） */

const ExploreWorkspacePage: React.FC = () => {
  const { canvasId } = useParams()
  const cid = Number(canvasId)
  const nav = useNavigate()
  const { t } = useTranslation('explore')
  const myRole = useAuthStore((s) => s.user?.role)
  const [title, setTitle] = useState('')
  const [pages, setPages] = useState<ExplorePageMeta[]>([])
  const [sp] = useSearchParams()
  const [current, setCurrent] = useState(() => { const n = Number(sp.get('page')); return Number.isFinite(n) && n > 0 ? n : 1 })
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [renameOpen, setRenameOpen] = useState(false)
  const [nameInput, setNameInput] = useState('')

  const lastActiveRef = useRef(Date.now())
  const sessionMsRef = useRef(0)
  const editorRef = useRef<Editor | null>(null)
  const [mobile, setMobile] = useState(() => window.innerWidth < 768)
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
  // ── M2：分享给老师 / 发布为模板 ──
  const [shareOpen, setShareOpen] = useState(false)
  const [shareTitle, setShareTitle] = useState('')
  const [sharing, setSharing] = useState(false)
  const [tplOpen, setTplOpen] = useState(false)
  const [tplTitle, setTplTitle] = useState('')
  const [tplDesc, setTplDesc] = useState('')
  const [publishing, setPublishing] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const d = await getCanvas(cid)
      setTitle(d.canvas.title)
      setPages(d.pages)
      if (d.pages.length && !d.pages.some((p) => p.page_number === current)) {
        setCurrent(d.pages[0].page_number)
      }
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '画布加载失败')
      nav('/explore')
    }
  }, [cid, current, nav]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (Number.isFinite(cid) && cid > 0) void refresh() }, [cid]) // eslint-disable-line react-hooks/exhaustive-deps

  // 连续使用 40 分钟提醒：近 2 分钟有操作才算"连续"
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (Date.now() - lastActiveRef.current < 120000) sessionMsRef.current += 30000
      else sessionMsRef.current = 0
      if (sessionMsRef.current >= CONTINUOUS_REMIND_MIN * 60000) {
        sessionMsRef.current = 0
        Modal.warning({
          title: '休息一下吧',
          content: '已经连续探索 ' + CONTINUOUS_REMIND_MIN + ' 分钟啦，站起来活动活动，画布随时等你回来。',
        })
      }
    }, 30000)
    return () => window.clearInterval(iv)
  }, [])

  const onActivity = () => { lastActiveRef.current = Date.now() }

  // 画布提问卡上的按钮：面板关着也能用（追问→唤起面板并预填；朗读/复制就地执行）
  useEffect(() => {
    const onCard = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { action: string; question: string; answer: string }
      if (!d) return
      if (d.action === 'followup') {
        localStorage.setItem('explore:panel:open', '1')
        setPanelOpen(true)
        setPendingAsk({ text: '关于「' + (d.question || '').slice(0, 24) + '」，我还想问：', nonce: Date.now() })
      } else if (d.action === 'speak') {
        speak(d.answer || d.question || '').then((r) => {
          r.urls.reduce((p, url) => p.then(() => new Promise<void>((resolve) => {
            const a = new Audio(url); cardAudioRef.current = a; a.onended = () => resolve(); a.onerror = () => resolve(); void a.play()
          })), Promise.resolve())
        }).catch(() => message.warning('朗读失败'))
      } else if (d.action === 'copy') {
        void navigator.clipboard.writeText(d.answer || '').then(
          () => message.success('回答已复制'), () => message.warning('浏览器不允许复制'))
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
    if (movable.length < 3) { message.info('卡片太少，不需要整理'); return }
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
        message.success('已重排 ' + updates.length + ' 张卡片')
      },
    })
  }

  /** 一键清除本页：先存当前内容并强制归档到时间线，再清空——后悔可回 */
  const doClearPage = () => {
    const ed = editorRef.current
    if (!ed) { message.warning('画布还没准备好'); return }
    if (ed.getCurrentPageShapes().length === 0) { message.info('这一页本来就是空的'); return }
    Modal.confirm({
      title: t('clearTitle'),
      content: t('clearBody'),
      okText: '清除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const snap = JSON.stringify(ed.getSnapshot())
          await savePage(cid, current, snap)
          await archivePage(cid, current, snap)
          ed.deleteShapes(ed.getCurrentPageShapes().map((s) => s.id) as never)
          await savePage(cid, current, JSON.stringify(ed.getSnapshot()))
          setSaveState('saved')
          message.success('已清除；需要找回就点「时间线」')
        } catch (e: any) {
          message.error(e?.response?.data?.detail || '清除失败')
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
    if (!ed.getCurrentPageShapes().length) { message.info('这一页还是空的，先画点东西再分享吧'); return }
    setSharing(true)
    try {
      // 先把服务端快照存到最新，再生成分享副本——老师看到的就是这一刻的最新状态
      await savePage(cid, current, JSON.stringify(ed.getSnapshot()))
      const src = await buildCover()
      const r = await createShare({ canvas_id: cid, page_number: current, title: shareTitle.trim(), image_src: src })
      message.success('已生成只读快照，' + (r.expires_at || '').slice(5, 10) + ' 前有效，可随时收回')
      setShareOpen(false)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '分享失败，稍后再试')
    } finally { setSharing(false) }
  }

  const doPublishSubmit = async () => {
    const ed = editorRef.current
    const tt = tplTitle.trim()
    if (!ed || publishing) return
    if (!tt) { message.info('请给模板起个名字'); return }
    if (!ed.getCurrentPageShapes().length) { message.info('这一页还是空的，先做点内容再发布吧'); return }
    setPublishing(true)
    try {
      await savePage(cid, current, JSON.stringify(ed.getSnapshot()))
      const src = await buildCover()
      const r = await publishTemplate({ canvas_id: cid, page_number: current, title: tt, description: tplDesc.trim(), image_src: src })
      message.success('已发布到模板库：《' + r.title + '》')
      setTplOpen(false)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '发布失败，稍后再试')
    } finally { setPublishing(false) }
  }

  /** 一键存入成长档案：整页导出成图片（限边长防膨胀）→ 上传入册 → 服务端归档+弱积分+徽章 */
  const doArchive = async () => {
    const ed = editorRef.current
    if (!ed || archiving) return
    const shapes = ed.getCurrentPageShapes()
    if (!shapes.length) { message.info('这一页还是空的，先画点东西再存档吧'); return }
    setArchiving(true)
    try {
      const { blob } = await ed.toImage(shapes as never, { format: 'png', background: true, padding: 24 })
      const png = new File([blob], 'archive.png', { type: 'image/png' })
      const up = await uploadAsset(cid, png)
      const r = await archivePortfolio(cid, current, { image_src: up.src, title: title ? title + ' · 第 ' + current + ' 页' : '' })
      const badgeText = (r.badges || []).map((b) => b.icon + ' ' + b.name).join('、')
      message.success('已存入成长档案'
        + (r.points ? ' · 探索+' + r.points + ' 分' : '')
        + (badgeText ? ' · 解锁徽章 ' + badgeText : ''))
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '存档失败，稍后再试')
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
    if (!ed) { message.warning('画布还没准备好'); return }
    try {
      // 服务端先把当前内容存档，再取目标快照；前端载入后立即显式写回（双向可回）
      const snapText = await restoreHistory(cid, current, hid)
      if (!snapText) { message.info('这份存档是空的'); return }
      ed.store.mergeRemoteChanges(() => { ed.loadSnapshot(JSON.parse(snapText)) })
      await savePage(cid, current, JSON.stringify(ed.getSnapshot()))
      setSaveState('saved')
      setHistOpen(false)
      message.success('已回到 ' + hid + ' 号存档；刚才的内容也存进了时间线，可再回来')
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '回滚失败')
    }
  }

  const doAddPage = async () => {
    try {
      const d = await addPage(cid)
      setCurrent(d.page_number)
      await refresh()
    } catch { message.error('新增页面失败') }
  }

  const doDeletePage = (pn: number) => {
    Modal.confirm({
      title: '删除这一页？',
      content: '这一页上的全部内容会被移除。',
      okButtonProps: { danger: true },
      okText: '删除',
      onOk: async () => {
        try {
          await deletePage(cid, pn)
          if (pn === current) setCurrent(1)
          await refresh()
        } catch (e: any) { message.error(e?.response?.data?.detail || '删除失败') }
      },
    })
  }

  const doRename = async () => {
    const t = nameInput.trim()
    if (!t) return
    try {
      await renameCanvas(cid, t)
      setTitle(t)
      setRenameOpen(false)
    } catch { message.error('改名失败') }
  }

  const displayPages: ExplorePageMeta[] = pages.length
    ? pages
    : [{ page_number: 1, title: '第 1 页', updated_at: '' }]

  const tabItems = displayPages.map((p) => ({
    key: String(p.page_number),
    label: p.title,
    closable: displayPages.length > 1,
  }))

  const saveTagMap: Record<SaveState, { text: string; color: string }> = {
    idle: { text: '已保存', color: 'default' },
    saving: { text: '保存中', color: 'processing' },
    saved: { text: '已保存', color: 'success' },
    offline: { text: '离线·本地已暂存', color: 'warning' },
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
        }}>{title || '探索画布'}</span>
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
            <Tooltip title="把本页作品存入成长档案">
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
            <Tooltip title="清空当前页（可经时间线找回）">
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
          <Tooltip title="唤起 AI 助手（问 / 画 / 说 / 贴）">
            <button
              onClick={togglePanel}
              style={{
                position: 'absolute', right: 22, bottom: 26, zIndex: 25,
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

      <Drawer title={t('histTitle')} placement="right" width={340} open={histOpen} onClose={() => setHistOpen(false)}>
        {histItems.length === 0 ? (
          <Empty description={t('histEmpty')} />
        ) : (
          <div>
            {histItems.map((it) => (
              <div key={it.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 2px', borderBottom: '1px solid var(--border-color, #f0f0f0)',
              }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{it.saved_at}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary, #888)' }}>{Math.max(1, Math.round(it.bytes / 1024))} KB</div>
                </div>
                <Popconfirm title={t('restoreTitle')} description={t('restoreBody')} okText={t('restore')} onConfirm={() => void doRestore(it.id)}>
                  <Button size="small">{t('restoreHere')}</Button>
                </Popconfirm>
              </div>
            ))}
          </div>
        )}
      </Drawer>

      <style>{`
        .explore-canvas-wrap .tlui-style-panel__wrapper { transition: transform 0.18s ease; }
        /* 弹出对话窗 = 专注对话：tldraw 工具栏与样式面板让位，收回侧栏模式即恢复 */
        .explore-canvas-wrap.panel-pop .tlui-style-panel__wrapper { display: none; }
        .explore-canvas-wrap.panel-pop .tlui-toolbar { display: none; }
        .explore-canvas-wrap.panel-open .tlui-style-panel__wrapper { transform: translateX(-470px); }
        .explore-canvas-wrap.panel-open.panel-wide .tlui-style-panel__wrapper { transform: translateX(-670px); }
        @media (max-width: 1000px) {
          .explore-canvas-wrap.panel-open .tlui-style-panel__wrapper { display: none; }
        }
      `}</style>

      <Modal title={t('rename')} open={renameOpen} onOk={doRename} onCancel={() => setRenameOpen(false)}>
        <Input value={nameInput} maxLength={60} onChange={(e) => setNameInput(e.target.value)} onPressEnter={doRename} autoFocus />
      </Modal>
    </div>
  )
}

export default ExploreWorkspacePage