/** 可拖移 / 可缩放 / 可全屏的预览窗口：尺寸与位置按 storageKey 记忆，不再固定大小位置。 */

import React, { useCallback, useEffect, useRef, useState } from 'react'

import { Button, Modal, Tooltip } from 'antd'

import { CloseOutlined, CompressOutlined, ExpandOutlined } from '@ant-design/icons'

import { useTranslation } from 'react-i18next'

interface Props {

  open: boolean

  title: React.ReactNode

  onClose: () => void

  footer?: React.ReactNode

  storageKey: string

  children: React.ReactNode

  /** 生成中等场景禁止关闭 */

  cancelDisabled?: boolean

  /** 满幅模式：去掉内边距/边框，iframe 贴边最大化内容区 */

  flush?: boolean

}

interface WinState { w: number; h: number; x: number; y: number; full: boolean }

const defaults = (): WinState => ({

  w: Math.max(480, window.innerWidth - 24),

  h: Math.max(320, window.innerHeight - 110),

  x: 0, y: 0, full: false,

})

const ResizableModal: React.FC<Props> = ({ open, title, onClose, footer, storageKey, children, cancelDisabled, flush }) => {

  const { t } = useTranslation('common')

  const [win, setWin] = useState<WinState>(defaults)

  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  const sizeRef = useRef<{ px: number; py: number; w: number; h: number } | null>(null)

  useEffect(() => {

    if (!open) return

    try {

      const raw = localStorage.getItem(storageKey)

      if (raw) {

        const s = JSON.parse(raw) as Partial<WinState>

        const d = defaults()

        setWin({ ...d, ...s,

          w: Math.min(Number(s.w) || d.w, Math.max(480, window.innerWidth - 24)),

          h: Math.min(Number(s.h) || d.h, Math.max(320, window.innerHeight - 110)) })

      } else {

        setWin(defaults())

      }

    } catch { setWin(defaults()) }

  }, [open, storageKey])

  useEffect(() => {

    if (!open) return

    try { localStorage.setItem(storageKey, JSON.stringify(win)) } catch { /* 隐私模式忽略 */ }

  }, [win, open, storageKey])

  const onDragDown = useCallback((e: React.PointerEvent<HTMLSpanElement>) => {

    if (win.full) return

    dragRef.current = { px: e.clientX, py: e.clientY, x: win.x, y: win.y }

    e.currentTarget.setPointerCapture(e.pointerId)

  }, [win.full, win.x, win.y])

  const onDragMove = useCallback((e: React.PointerEvent<HTMLSpanElement>) => {

    const d = dragRef.current

    if (!d) return

    const nx = Math.max(-window.innerWidth / 2, Math.min(window.innerWidth / 2, d.x + e.clientX - d.px))

    const ny = Math.max(-window.innerHeight / 2, Math.min(window.innerHeight / 2, d.y + e.clientY - d.py))

    setWin((p) => ({ ...p, x: nx, y: ny }))

  }, [])

  const onDragUp = useCallback((e: React.PointerEvent<HTMLSpanElement>) => {

    dragRef.current = null

    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }

  }, [])

  const onSizeDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {

    sizeRef.current = { px: e.clientX, py: e.clientY, w: win.w, h: win.h }

    e.currentTarget.setPointerCapture(e.pointerId)

    e.stopPropagation()

  }, [win.w, win.h])

  const onSizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {

    const d = sizeRef.current

    if (!d) return

    const nw = Math.max(480, Math.min(window.innerWidth - 16, d.w + e.clientX - d.px))

    const nh = Math.max(320, Math.min(window.innerHeight - 120, d.h + e.clientY - d.py))

    setWin((p) => ({ ...p, w: nw, h: nh }))

  }, [])

  const onSizeUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {

    sizeRef.current = null

    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }

  }, [])

  const preset = (ratio: number) => setWin((p) => ({

    ...p, full: false,

    w: Math.round(window.innerWidth * ratio),

    h: Math.round(window.innerHeight * 0.72),

  }))

  const titleBar = (

    <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>

      <span

        onPointerDown={onDragDown}

        onPointerMove={onDragMove}

        onPointerUp={onDragUp}

        title={t('previewWinDragHint')}

        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: win.full ? 'default' : 'move' }}

      >

        {title}

      </span>

      <Tooltip title={t('previewWin70')}><Button size="small" type="text" onClick={() => preset(0.7)}>70%</Button></Tooltip>

      <Tooltip title={t('previewWin90')}><Button size="small" type="text" onClick={() => preset(0.9)}>90%</Button></Tooltip>

      <Tooltip title={win.full ? t('previewWinExitFull') : t('previewWinFull')}>

        <Button size="small" type="text" icon={win.full ? <CompressOutlined /> : <ExpandOutlined />}

          aria-label={win.full ? t('previewWinExitFull') : t('previewWinFull')}

          onClick={() => setWin((p) => ({ ...p, full: !p.full }))} />

      </Tooltip>

      <Tooltip title={t('previewWinClose')}>
        <Button size="small" type="text" icon={<CloseOutlined />}
          aria-label={t('previewWinClose')} disabled={cancelDisabled} onClick={onClose} />
      </Tooltip>
    </div>

  )

  return (

    <Modal

      open={open}
      closable={false}

      onCancel={() => { if (!cancelDisabled) onClose() }}

      title={titleBar}

      footer={footer}

      destroyOnHidden

      width={win.full ? '100vw' : win.w}

      style={win.full

        ? { top: 0, margin: 0, paddingBottom: 0, maxWidth: '100vw' }

        : { top: Math.max(4, 12 + win.y), transform: `translateX(${win.x}px)`, paddingBottom: 0 }}

      styles={{

        body: { height: win.full ? 'calc(100vh - 92px)' : win.h, overflow: flush ? 'hidden' : 'auto', padding: flush ? 0 : 12 },

        content: { padding: flush ? 0 : undefined, borderRadius: win.full ? 0 : undefined, minHeight: win.full ? '100vh' : undefined },

        container: { padding: flush ? 0 : undefined, borderRadius: win.full ? 0 : undefined, minHeight: win.full ? '100vh' : undefined },

        header: flush ? { padding: '8px 14px', marginBottom: 0 } : undefined,

        footer: flush ? { padding: '6px 14px', marginTop: 0 } : undefined,

      }}

    >

      <div style={{ position: 'relative', height: '100%' }}>

        {children}

        {!win.full && (

          <div

            onPointerDown={onSizeDown}

            onPointerMove={onSizeMove}

            onPointerUp={onSizeUp}

            title={t('previewWinResizeHint')}

            style={{

              position: 'absolute', right: 2, bottom: 2, width: 16, height: 16,

              cursor: 'nwse-resize', zIndex: 5,

              background: 'linear-gradient(135deg, transparent 50%, var(--text-tertiary, #999) 50%)',

              borderRadius: 2, opacity: 0.6,

            }}

          />

        )}

      </div>

    </Modal>

  )

}

export default ResizableModal

