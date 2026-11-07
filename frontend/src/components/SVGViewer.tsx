/**
 * SVGViewer — SVG 配图渲染组件
 *
 * 功能：
 * - 安全渲染 AI 生成的 SVG 代码
 * - 点击放大预览（基于 Ant Design Image）
 * - 下载为 PNG
 * - 复制 SVG 代码
 */
import { useTranslation } from 'react-i18next'
import React, { useEffect, useState } from 'react'
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
  /** 自适应模式：宽度撑满容器，高度不超过 thumbHeight，等比不裁切 */
  fluid?: boolean
}

const SVGViewer: React.FC<SVGViewerProps> = ({
  svgCode,
  description = '',
  expandable = true,
  thumbHeight = 60,
  fluid = false,
}) => {
  const { t } = useTranslation('common')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [imgError, setImgError] = useState(false)

  // svgCode 变了必须清掉上一次的失败标记：否则"重新生成"已经拿到好图，
  // 组件却还停在降级态（降级分支不挂 <img>，onError 再也不会触发），
  // 教师只能看到一张永远空白的配图，非得关掉弹窗重开才恢复。
  useEffect(() => {
    setImgError(false)
  }, [svgCode])

  if (!svgCode) return null

  // SVG → data: URI（最可靠的跨浏览器渲染方式）
  const svgDataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgCode)

  // AI 生成的 SVG 通常只写 viewBox、不写 width/height，浏览器给的固有尺寸是 300×150
  // （在自适应宽度的容器里甚至会直接塌成 0×0）。这里按 viewBox 反推宽高比，
  // 缩略图据此给确定宽度：既不变形，也不再留左右灰边。
  const box = /viewBox\s*=\s*["']\s*[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)/i.exec(svgCode)
  const vbW = box ? parseFloat(box[1]) : 0
  const vbH = box ? parseFloat(box[2]) : 0
  const ratio = vbW > 0 && vbH > 0 ? vbW / vbH : 1.5
  const capHeight = thumbHeight || 420
  // 缩略盒自己还要吃 4px padding + 1px 边框：图按内圈高度算，才不会上下被裁掉一条
  const fluidHeight = Math.max(60, capHeight - 10)

  // 下载为 PNG
  const handleDownload = () => {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const img = new window.Image()
    img.onload = () => {
      const scale = 2 // 2 倍导出，打印/插入课件更清晰
      const width = (vbW || img.width || 600) * scale
      const height = (vbH || img.height || 400) * scale
      canvas.width = Math.round(width)
      canvas.height = Math.round(height)
      ctx?.drawImage(img, 0, 0, canvas.width, canvas.height)
      const link = document.createElement('a')
      link.download = `${description || 'svg_image'}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    }
    img.src = svgDataUri
  }

  // 复制 SVG 代码
  const handleCopy = () => {
    navigator.clipboard.writeText(svgCode).then(() => message.success(t('svCopied')))
  }

  // 缩略图内容
  const thumbContent = imgError ? (
    // 降级：明确说"渲染失败"并给出可操作出口，而不是只留两个灰字让人猜
    <div style={{ fontSize: 12, color: '#ff4d4f', textAlign: 'center', padding: 4, lineHeight: 1.6 }}>
      ⚠️ {t('svRenderFail')}
      <div style={{ color: '#999', fontSize: 11 }}>{t('svRenderFailTip')}</div>
    </div>
  ) : (
    <img
      src={svgDataUri}
      alt={description || 'SVG'}
      onError={() => setImgError(true)}
      style={fluid
        ? { width: Math.round(ratio * fluidHeight), height: 'auto', maxWidth: '100%', maxHeight: fluidHeight, objectFit: 'contain', display: 'block' }
        : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
    />
  )

  const thumbBox = (
    <div
      onClick={() => expandable && !imgError && setPreviewOpen(true)}
      style={fluid ? {
        // 自适应：按 SVG 自身比例缩，高度封顶；宽度用 auto 让它可以缩到很窄（width:100% 会在
        // 外层是 flex 自适应宽度时互相依赖，最终塌成一条竖线）
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 'auto', maxWidth: '100%', maxHeight: capHeight,
        padding: 4,
        border: '1px solid #e8e8e8', borderRadius: 6,
        background: '#fafafa',
        cursor: expandable && !imgError ? 'pointer' : 'default',
        overflow: 'hidden',
      } : {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        // 盒子按 viewBox 比例收边（以前固定 2:1，3:2 的图左右各空 50px）；
        // 上限仍是原来的 2:1，避免横长画布把表格/窄容器顶宽
        width: thumbHeight > 0 ? Math.round(thumbHeight * Math.min(ratio, 2)) : 240,
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
      <Tooltip title={t('svZoomTip')}>{thumbBox}</Tooltip>
      <Modal
        title={description || t('svDefault')}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null} width="min(90vw, 1100px)" destroyOnHidden
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
          {/* AI 的 SVG 通常只写 viewBox、没有固有尺寸，<img> 会退回默认 300×150 铺，
              放大弹窗里反而和缩略图差不多大；给死宽度让它按 viewBox 比例撑满弹窗 */}
          <img src={svgDataUri} alt={description || 'SVG'}
            style={{ width: '100%', maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
        </div>
        <div style={{ marginTop: 12, textAlign: 'center', display: 'flex', gap: 16, justifyContent: 'center' }}>
          <span style={{ color: '#1677ff', cursor: 'pointer', fontSize: 14 }} onClick={handleDownload}>
            {t('svDownloadPng')}
          </span>
          <span style={{ color: '#1677ff', cursor: 'pointer', fontSize: 14 }} onClick={handleCopy}>
            {t('svCopyCode')}
          </span>
        </div>
      </Modal>
    </>
  )
}

export default SVGViewer
