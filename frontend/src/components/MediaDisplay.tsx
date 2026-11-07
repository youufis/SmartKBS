/**
 * MediaDisplay — 试题配图展示组件
 *
 * 统一渲染 SVG 配图 + 万相生成的图片（media_files）
 * 用于在试卷、练习、错题本等页面中展示
 */
import { useTranslation } from 'react-i18next'
import React from 'react'
import { Image } from 'antd'
import SVGViewer from './SVGViewer'
import type { MediaFile } from '../types'

interface MediaDisplayProps {
  /** SVG 代码 */
  svgContent?: string | null
  /** 是否有 SVG */
  hasSvg?: number | null
  /** 媒体文件列表（万相生图等） */
  mediaFiles?: MediaFile[] | string | null
  /** 缩略图尺寸：'compact'（60px 高，表格用）| 'card'（88px 高，错题本卡片用）| 'normal'（120px 高，默认）| 'large'（200px 高，考试页用）| 'fluid'（自适应宽度，高度受限） */
size?: 'compact' | 'card' | 'normal' | 'large' | 'inline' | 'fluid'
  /** fluid 档的高度上限（px），默认 420 */
  maxHeight?: number
  /** 对齐方式：默认居中（单图），'start' 靠左（紧跟题干时用） */
  align?: 'center' | 'start'
}

const MediaDisplay: React.FC<MediaDisplayProps> = ({
  svgContent, hasSvg, mediaFiles, size = 'normal', maxHeight = 420, align = 'center',
}) => {
  const { t } = useTranslation('common')
  // 解析 mediaFiles（可能是 JSON 字符串或数组）
  let files: MediaFile[] = []
  if (Array.isArray(mediaFiles)) {
    files = mediaFiles
  } else if (typeof mediaFiles === 'string') {
    try { files = JSON.parse(mediaFiles) } catch { /* ignore */ }
  }

  const hasSvgFlag = hasSvg === 1
  const hasMediaImages = files.length > 0

  if (!hasSvgFlag && !hasMediaImages) return null

  // 根据尺寸选择缩略图高度和样式
  const sizeMap = {
    compact: { thumbHeight: 50, boxWidth: 100, svgThumbHeight: 40 },
    // SVGViewer 的缩略盒宽固定是 2×thumbHeight，所以 card 档实际约 160×80（图片档 160×88）
    card: { thumbHeight: 88, boxWidth: 160, svgThumbHeight: 80 },
    normal: { thumbHeight: 120, boxWidth: 180, svgThumbHeight: 120 },
    large: { thumbHeight: 200, boxWidth: 280, svgThumbHeight: 200 },
    // inline：紧跟题干的小图（160 高），不宣示"整块配图区"
    inline: { thumbHeight: 160, boxWidth: 220, svgThumbHeight: 160 },
    // fluid：宽度撑满容器，高度只给上限；boxWidth 用 0 表示不设死宽
    fluid: { thumbHeight: maxHeight, boxWidth: 0, svgThumbHeight: maxHeight },
  }
  const s = sizeMap[size]

  const isFluid = size === 'fluid'
  const count = (hasSvgFlag && svgContent ? 1 : 0) + files.length
  // fluid：不拉满容器，图按自身比例缩到高度上限内；左右位置交给 align（单图默认居中）
  const fluidBox: React.CSSProperties = {
    flex: '0 1 auto', maxWidth: '100%', minWidth: 0,
  }

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 12,
      // 单图居中，多图从左排开（多图居中会在两图时左右跳，读图顺序也乱）
      justifyContent: (align === 'start' || count > 1) ? 'flex-start' : 'center',
      margin: '12px 0',
    }}>
      {/* SVG 配图 */}
      {hasSvgFlag && svgContent && (
        // 边框只留 SVGViewer 自己那一层：这里以前再套一层 #f5f5f5 灰底 + padding，
        // 就成了"灰框里套白框"，配图四周全是撑出来的死空间
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          ...(isFluid ? fluidBox : {}),
        }}>
          <SVGViewer
            svgCode={svgContent}
            description={t('mdQuestionFigure')}
            expandable={true}
            thumbHeight={s.svgThumbHeight}
            fluid={isFluid}
          />
        </div>
      )}

      {/* 万相/上传的图片 */}
      {hasMediaImages && files.map((f, idx) => (
        <div key={f.key || idx} style={isFluid ? {
          ...fluidBox,
          maxHeight, padding: 4, background: '#fafafa', borderRadius: 6,
          border: '1px solid #e8e8e8',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', cursor: 'pointer',
        } : {
          width: s.boxWidth, height: s.thumbHeight,
          padding: 4, background: '#fafafa', borderRadius: 6,
          border: '1px solid #e8e8e8',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', cursor: 'pointer',
        }}>
          <Image
            src={f.url}
            alt={f.alt || t('mdQuestionFigure')}
            style={isFluid
              ? { maxWidth: '100%', maxHeight: maxHeight - 10, width: 'auto', height: 'auto', objectFit: 'contain' }
              : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            preview={{ mask: null }}
          />
        </div>
      ))}
    </div>
  )
}

export default MediaDisplay
