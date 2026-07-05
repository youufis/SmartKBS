/**
 * SVGViewer — SVG 配图渲染组件
 *
 * 功能：
 * - 安全渲染 AI 生成的 SVG 代码
 * - 点击放大预览（基于 Ant Design Image）
 * - 下载为 PNG
 * - 复制 SVG 代码
 */
import React, { useState } from 'react'
import { Modal, Tooltip, message, Image } from 'antd'

interface SVGViewerProps {
  /** SVG 代码 */
  svgCode: string
  /** 图片说明（alt 文本） */
  description?: string
  /** 是否可点击放大 */
  expandable?: boolean
  /** 缩略图高度（默认 60px，传 0 用实际尺寸） */
  thumbHeight?: number
}

const SVGViewer: React.FC<SVGViewerProps> = ({
  svgCode,
  description = '',
  expandable = true,
  thumbHeight = 60,
}) => {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [imgError, setImgError] = useState(false)

  if (!svgCode) return null

  // SVG → data: URI（最可靠的跨浏览器渲染方式）
  const svgDataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgCode)

  // 下载为 PNG
  const handleDownload = () => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new window.Image()
    img.onload = () => {
      canvas.width = img.width
      canvas.height = img.height
      ctx?.drawImage(img, 0, 0)
      const link = document.createElement('a')
      link.download = `${description || 'svg_image'}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    }
    img.src = svgDataUri
  }

  // 复制 SVG 代码
  const handleCopy = () => {
    navigator.clipboard.writeText(svgCode).then(() => message.success('SVG 代码已复制'))
  }

  // 缩略图内容
  const thumbContent = imgError ? (
    // 降级：直接渲染 SVG 源码
    <div style={{ fontSize: 12, color: '#999', textAlign: 'center', padding: 4 }}>SVG</div>
  ) : (
    <img
      src={svgDataUri}
      alt={description || 'SVG'}
      onError={() => setImgError(true)}
      style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
    />
  )

  const thumbBox = (
    <div
      onClick={() => expandable && !imgError && setPreviewOpen(true)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: thumbHeight > 0 ? thumbHeight * 2 : 240,
        height: thumbHeight || 180,
        padding: 2,
        border: '1px solid #e8e8e8', borderRadius: 6,
        background: '#fafafa',
        cursor: expandable && !imgError ? 'pointer' : 'default',
        overflow: 'hidden',
      }}
    >
      {thumbContent}
    </div>
  )

  if (!expandable || imgError) return thumbBox

  return (
    <>
      <Tooltip title="点击放大预览">{thumbBox}</Tooltip>
      <Modal
        title={description || 'SVG 配图'}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null} width={700} destroyOnHidden
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          <img src={svgDataUri} alt={description || 'SVG'} style={{ maxWidth: '100%' }} />
        </div>
        <div style={{ marginTop: 12, textAlign: 'center', display: 'flex', gap: 16, justifyContent: 'center' }}>
          <span style={{ color: '#1677ff', cursor: 'pointer', fontSize: 14 }} onClick={handleDownload}>
            💾 下载为 PNG
          </span>
          <span style={{ color: '#1677ff', cursor: 'pointer', fontSize: 14 }} onClick={handleCopy}>
            📋 复制代码
          </span>
        </div>
      </Modal>
    </>
  )
}

export default SVGViewer
