/**
 * 探索画布 · 只读快照视图（M2 授权巡览）
 * 加载 tldraw 快照副本：不保存、不编辑；自定义形状(ask-card)同步注册防校验崩溃。
 */
import React, { useCallback, useRef, useState } from 'react'
import { Tldraw, type TLComponents, type TLStoreSnapshot } from 'tldraw'
import 'tldraw/tldraw.css'
import { AskCardUtil } from './AskCardShape'

const minimalComponents: TLComponents = {
  SharePanel: null,
  DebugPanel: null,
  MenuPanel: null,
  HelperButtons: null,
  PeopleMenu: null,
}

const ExploreSnapshotView: React.FC<{ snapshot: string }> = ({ snapshot }) => {
  const [ready, setReady] = useState(false)
  const loaded = useRef(false)
  const handleMount = useCallback((editor: any) => {
    if (loaded.current) return
    loaded.current = true
    try { editor.updateInstanceState({ isReadonly: true }) } catch { /* ignore */ }
    try {
      editor.store.mergeRemoteChanges(() => { editor.loadSnapshot(JSON.parse(snapshot) as TLStoreSnapshot) })
    } catch { /* 快照损坏保持空白，不报错阻塞 */ }
    try { editor.zoomToFit() } catch { /* ignore */ }
    setReady(true)
  }, [snapshot])
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw onMount={handleMount} components={minimalComponents} shapeUtils={[AskCardUtil]} licenseKey="oss" />
      {/* 隐藏 TLDraw 右下角许可水印（与画布同一处理） */}
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
          读取分享内容…
        </div>
      )}
    </div>
  )
}

export default ExploreSnapshotView
