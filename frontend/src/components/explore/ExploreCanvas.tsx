/**
 * 探索画布 · 画布组件（M0）：tldraw 单机模式
 * - 打开：服务端快照优先；服务端不可用/为空时用本地草稿兜底
 * - 编辑：停止操作 5s 防抖保存；每 30s 给未保存内容写本地草稿
 * - 图片：粘贴/插入先上传成 URL 再进快照（与协作白板同一口径，防快照膨胀）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, type Editor, type TLAssetStore, type TLComponents, type TLStoreSnapshot } from 'tldraw'
import 'tldraw/tldraw.css'
import { message } from 'antd'
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
}

const ExploreCanvas: React.FC<Props> = ({ canvasId, pageNumber, onSaveState, onActivity, externalEditorRef }) => {
  const internalRef = useRef<Editor | null>(null)
  const editorRef = externalEditorRef || internalRef
  const [ready, setReady] = useState(false)
  const dirtyRef = useRef(false)
  const timerRef = useRef(0)
  const stateCb = useRef(onSaveState)
  stateCb.current = onSaveState
  const actCb = useRef(onActivity)
  actCb.current = onActivity
  const draftKey = canvasId + ':' + pageNumber
  const bigWarnedRef = useRef(false)

  const flushSave = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || !dirtyRef.current) return
    dirtyRef.current = false
    const snap = JSON.stringify(editor.getSnapshot())
    // 接近 8MB 硬上限时提醒一次（大图直接进快照会让保存越来越慢直到 413）
    if (snap.length > 6 * 1024 * 1024 && !bigWarnedRef.current) {
      bigWarnedRef.current = true
      message.warning('画布内容快接近大小上限：建议删掉大图，或另开一页继续')
    }
    if (stateCb.current) stateCb.current('saving')
    try {
      await savePage(canvasId, pageNumber, snap)
      await clearDraft(draftKey)
      if (stateCb.current) stateCb.current('saved')
    } catch {
      dirtyRef.current = true
      try { await saveDraft(draftKey, snap) } catch { /* 连草稿都写不进就算了 */ }
      if (stateCb.current) stateCb.current('offline')
    }
  }, [canvasId, pageNumber, draftKey])

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    ;(async () => {
      let serverSnap = ''
      let ok = true
      try {
        serverSnap = (await getPage(canvasId, pageNumber)).snapshot_data || ''
      } catch {
        ok = false
      }
      const draft = await loadDraft(draftKey).catch(() => null)
      if (ok && serverSnap) {
        try {
          editor.store.mergeRemoteChanges(() => { editor.loadSnapshot(JSON.parse(serverSnap) as TLStoreSnapshot) })
        } catch { /* 快照损坏则保持空白，不阻塞使用 */ }
        if (draft) void clearDraft(draftKey) // 服务端是新的，本地草稿作废
      } else if (draft) {
        try {
          editor.store.mergeRemoteChanges(() => { editor.loadSnapshot(JSON.parse(draft.snapshot) as TLStoreSnapshot) })
          message.info('网络不通，已恢复本地草稿')
        } catch { /* ignore */ }
      }
      setReady(true)
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
          打开画布…
        </div>
      )}
    </div>
  )
}

export default ExploreCanvas