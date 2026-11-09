/**
 * 探索画布 · 画布组件（M0）：tldraw 单机模式
 * - 打开：服务端快照优先；服务端不可用/为空时用本地草稿兜底
 * - 编辑：停止操作 5s 防抖保存；每 30s 给未保存内容写本地草稿
 * - 图片：粘贴/插入先上传成 URL 再进快照（与协作白板同一口径，防快照膨胀）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, type Editor, type TLAssetStore, type TLComponents, type TLStoreSnapshot } from 'tldraw'
import 'tldraw/tldraw.css'
import { Modal, message } from 'antd'
import { useTranslation } from 'react-i18next'
import { getPage, savePage, uploadAsset, type SaveState } from '../../api/explore'
import { AskCardUtil } from './AskCardShape'
import { saveDraft, loadDraft, clearDraft } from '../../utils/exploreDraft'

const minimalComponents: TLComponents = {
  SharePanel: null,
  DebugPanel: null,
  MenuPanel: null,
  HelperButtons: null,
  PeopleMenu: null,
}

const DEBOUNCE_MS = 5000
const DRAFT_BACKUP_MS = 30000

interface Props {
  canvasId: number
  pageNumber: number
  onSaveState?: (s: SaveState) => void
  onActivity?: () => void
  externalEditorRef?: React.MutableRefObject<Editor | null>
  /** 版本号引用：父组件在"强制保存"（回滚/清空/分享前落盘）后也要同步它，否则下次自动保存会误判 409 */
  externalRevRef?: React.MutableRefObject<number>
  /** 画布就绪（服务端/草稿已载入）：父组件用它做"内置模板落卡"这类一次性动作 */
  onReady?: () => void
}

const ExploreCanvas: React.FC<Props> = ({ canvasId, pageNumber, onSaveState, onActivity, externalEditorRef, externalRevRef, onReady }) => {
  const { t } = useTranslation('explore')
  const internalRef = useRef<Editor | null>(null)
  const editorRef = externalEditorRef || internalRef
  const [ready, setReady] = useState(false)
  const dirtyRef = useRef(false)
  const timerRef = useRef(0)
  const stateCb = useRef(onSaveState)
  stateCb.current = onSaveState
  const actCb = useRef(onActivity)
  actCb.current = onActivity
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const draftKey = canvasId + ':' + pageNumber
  const bigWarnedRef = useRef(false)
  const localRevRef = useRef(0)   // 服务端快照版本号（乐观锁）
  const revRef = externalRevRef || localRevRef

  const flushSave = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || !dirtyRef.current) return
    const snap = JSON.stringify(editor.getSnapshot())
    const bytes = new Blob([snap]).size
    // 已超上限就别再反复撞 413：保留 dirty，等用户删大图或分页
    if (bytes > 8 * 1024 * 1024) {
      if (stateCb.current) stateCb.current('toolarge')
      return
    }
    if (bytes > 6 * 1024 * 1024 && !bigWarnedRef.current) {
      bigWarnedRef.current = true
      message.warning(t('nearLimit'))
    }
    dirtyRef.current = false
    if (stateCb.current) stateCb.current('saving')
    try {
      const r = await savePage(canvasId, pageNumber, snap, undefined, revRef.current)
      if (r && typeof r.rev === 'number') revRef.current = r.rev
      await clearDraft(draftKey)
      if (stateCb.current) stateCb.current('saved')
    } catch (e: any) {
      const status = e?.response?.status
      dirtyRef.current = true
      if (status === 409) {
        // 别处已经写过：本地这份留成草稿，绝不直接覆盖别人的内容
        try { await saveDraft(draftKey, snap) } catch { /* ignore */ }
        if (stateCb.current) stateCb.current('conflict')
        return
      }
      if (status === 413) {
        // 超上限：草稿进 IndexedDB（能存 MB 级），云端存不下
        try { await saveDraft(draftKey, snap) } catch { /* ignore */ }
        if (stateCb.current) stateCb.current('toolarge')
        return
      }
      try { await saveDraft(draftKey, snap) } catch { /* 连草稿都写不进就算了 */ }
      if (stateCb.current) stateCb.current('offline')
    }
  }, [canvasId, pageNumber, draftKey])

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    ;(async () => {
      let serverSnap = ''
      let serverRev = 0
      let ok = true
      try {
        const d = await getPage(canvasId, pageNumber)
        serverSnap = d.snapshot_data || ''
        serverRev = Number(d.rev || 0)
      } catch {
        ok = false
      }
      revRef.current = serverRev
      const draft = await loadDraft(draftKey).catch(() => null)
      if (ok && serverSnap) {
        // 云端有内容、本地还有草稿：让用户选，别默默丢弃任何一份
        let useDraft = false
        if (draft) {
          useDraft = await new Promise<boolean>((resolve) => {
            Modal.confirm({
              title: t('draftFound'),
              content: t('draftFoundBody'),
              okText: t('draftUse'),
              cancelText: t('draftCloud'),
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            })
          })
        }
        try {
          const src = useDraft ? draft!.snapshot : serverSnap
          editor.store.mergeRemoteChanges(() => { editor.loadSnapshot(JSON.parse(src) as TLStoreSnapshot) })
          if (useDraft) dirtyRef.current = true
          else void clearDraft(draftKey)
        } catch { /* 快照损坏则保持空白，不阻塞使用 */ }
      } else if (draft) {
        try {
          editor.store.mergeRemoteChanges(() => { editor.loadSnapshot(JSON.parse(draft.snapshot) as TLStoreSnapshot) })
          dirtyRef.current = true
          message.info(t('offlineRestored'))
        } catch { /* ignore */ }
      }
      setReady(true)
      try { onReadyRef.current && onReadyRef.current() } catch { /* 落卡失败不影响打开 */ }
    })()
  }, [canvasId, pageNumber, draftKey])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !ready) return
    const cleanup = editor.store.listen(({ changes }) => {
      for (const rec of Object.values((changes as any)?.added || {})) {
        if (rec && String((rec as any).type) === 'draw') {
          window.dispatchEvent(new CustomEvent('explore:draw-created', { detail: { id: (rec as any).id } }))
        }
      }
      dirtyRef.current = true
      if (actCb.current) actCb.current()
      if (stateCb.current) stateCb.current('saving')
      window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => { void flushSave() }, DEBOUNCE_MS)
    }, { source: 'user', scope: 'document' })
    const backupTimer = window.setInterval(() => {
      if (dirtyRef.current && editorRef.current) {
        void saveDraft(draftKey, JSON.stringify(editorRef.current.getSnapshot())).catch(() => {})
      }
    }, DRAFT_BACKUP_MS)
    const onHide = () => { if (document.visibilityState === 'hidden') void flushSave() }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      cleanup()
      document.removeEventListener('visibilitychange', onHide)
      window.clearTimeout(timerRef.current)
      window.clearInterval(backupTimer)
      void flushSave()
    }
  }, [ready, flushSave, draftKey])

  // 有未保存内容时拦一下关页/刷新（5s 防抖窗口里关掉会丢内容）
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // 图片先传成 URL 再进快照（同协作白板：一张 dataURL 大图会让后续每份快照都背上它）
  const assetStore = useMemo<TLAssetStore>(() => ({
    async upload(_asset, file) {
      const asDataUrl = () => new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      if (!file.type.startsWith('image/')) return { src: await asDataUrl() }
      try {
        const res = await uploadAsset(canvasId, file)
        if (res && res.src) return { src: res.src }
      } catch {
        // 上传失败退回 data URL：宁可变大，也不能让贴图直接失败
      }
      return { src: await asDataUrl() }
    },
    resolve(asset) {
      return (asset.props as { src?: string }).src || null
    },
  }), [canvasId])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw onMount={handleMount} components={minimalComponents}
        assets={assetStore} shapeUtils={[AskCardUtil]} licenseKey="oss" />
      {/* 隐藏 TLDraw 右下角许可水印（与协作白板同一处理） */}
      <style>{`
        .tl-watermark,
        [class*="watermark"],
        [class*="license"],
        .tlui-debug-panel,
        .tlui-share-panel,
        a[href*="tldraw"][href*="license"],
        a[href*="tldraw"][href*="pricing"] { display: none !important; }
      `}</style>
      {!ready && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-layout)', zIndex: 1000,
        }}>
          {t('openingCanvas')}
        </div>
      )}
    </div>
  )
}

export default ExploreCanvas