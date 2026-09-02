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
  /** 缩略图尺寸：'compact'（60px 高，表格用）| 'normal'（120px 高，默认）| 'large'（200px 高，考试页用） */
  size?: 'compact' | 'normal' | 'large'
}

const MediaDisplay: React.FC<MediaDisplayProps> = ({ svgContent, hasSvg, mediaFiles, size = 'normal' }) => {
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
    normal: { thumbHeight: 120, boxWidth: 180, svgThumbHeight: 120 },
    large: { thumbHeight: 200, boxWidth: 280, svgThumbHeight: 200 },
  }
  const s = sizeMap[size]

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', margin: '12px 0' }}>
      {/* SVG 配图 */}
      {hasSvgFlag && svgContent && (
        <div style={{
          padding: 8, background: '#f5f5f5', borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <SVGViewer svgCode={svgContent} description={t('mdQuestionFigure')} expandable={true} thumbHeight={s.svgThumbHeight} />
        </div>
      )}

      {/* 万相/上传的图片 */}
      {hasMediaImages && files.map((f, idx) => (
        <div key={f.key || idx} style={{
          width: s.boxWidth, height: s.thumbHeight,
          padding: 4, background: '#fafafa', borderRadius: 6,
          border: '1px solid #e8e8e8',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden', cursor: 'pointer',
        }}>
          <Image
            src={f.url}
            alt={f.alt || t('mdQuestionFigure')}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            preview={{ mask: null }}
          />
        </div>
      ))}
    </div>
  )
}

export default MediaDisplay
