/**
 * PlaceholderManager — 试题配图管理面板
 *
 * 教师端使用，展示试题的所有配图（SVG + 占位符图片 + 万相生图），
 * 支持：上传替换、AI 重新生成、删除配图、批量重试失败项。
 */
import { useTranslation } from 'react-i18next'
import React, { useCallback, useState } from 'react'
import { Card, Button, Upload, Space, Tag, Spin, Image, Empty, message } from 'antd'
import { UploadOutlined, ReloadOutlined, DeleteOutlined, PictureOutlined } from '@ant-design/icons'
import SVGViewer from './SVGViewer'
import type { MediaPlaceholder, MediaFile } from '../types'

interface PlaceholderManagerProps {
  /** 试题 ID */
  questionId: number
  /** SVG 代码 */
  svgContent?: string
  /** 是否有 SVG */
  hasSvg?: number
  /** 占位符列表 */
  placeholders?: MediaPlaceholder[]
  /** 已上传/生成的媒体文件 */
  mediaFiles?: MediaFile[]
  /** 独立 loading 状态（不传递时使用内部粒度控制） */
  svgLoading?: boolean
  /** 万相生图 loading */
  wanxiangLoading?: boolean
  /** 重新生成 SVG 回调 */
  onRegenerateSVG?: () => Promise<void>
  /** 删除 SVG 配图 */
  onDeleteSVG?: () => Promise<void>
  /** 为某个占位符生成图片 */
  onGenerateMedia?: (key: string) => Promise<void>
  /** 上传图片替换占位符 */
  onUploadMedia?: (key: string, file: File) => Promise<void>
  /** 删除占位符配图 */
  onDeleteMedia?: (key: string) => Promise<void>
  /** 万相生图（直接为试题生成配图） */
  onGenerateImage?: () => Promise<void>
}

const PlaceholderManager: React.FC<PlaceholderManagerProps> = ({
  svgContent,
  hasSvg,
  placeholders = [],
  mediaFiles = [],
  svgLoading = false,
  wanxiangLoading = false,
  onRegenerateSVG,
  onDeleteSVG,
  onGenerateMedia,
  onUploadMedia,
  onDeleteMedia,
  onGenerateImage,
}) => {
  const { t } = useTranslation('exam')
  const [uploadingKey, setUploadingKey] = useState<string | null>(null)
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set())

  // 查找占位符对应的媒体文件 URL
  const getMediaUrl = (key: string): string | undefined => {
    return mediaFiles.find(f => f.key === key)?.url
  }

  const handleGenerateMedia = useCallback(async (key: string) => {
    if (!onGenerateMedia) return
    setLoadingKeys(prev => new Set(prev).add(key))
    try {
      await onGenerateMedia(key)
    } finally {
      setLoadingKeys(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [onGenerateMedia])

  const handleRetryAllFailed = useCallback(async () => {
    if (!onGenerateMedia) return
    const failedKeys = placeholders
      .filter(ph => ph.status === 'failed')
      .map(ph => ph.key)
    if (failedKeys.length === 0) return

    for (const key of failedKeys) {
      setLoadingKeys(prev => new Set(prev).add(key))
      try {
        await onGenerateMedia(key)
      } finally {
        setLoadingKeys(prev => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    }
    message.success(t('pmRetryOk', { count: failedKeys.length }))
  }, [onGenerateMedia, placeholders])

  // 是否显示任何内容
  const showSvgSection = hasSvg === 1 || onRegenerateSVG
  const showPlaceholderSection = placeholders.length > 0
  // 收集所有要展示的媒体条目（占位符 + wanxiang 独立配图）
  const wanxiangEntries = mediaFiles.filter(f => f.key === 'wanxiang')
  const showWanxiangSection = wanxiangEntries.length > 0 && !showPlaceholderSection

  if (!showSvgSection && !showPlaceholderSection && !showWanxiangSection) {
    return (
      <Empty description={t('pmNoFigure')} />
    )
  }

  /** 渲染单条媒体条目（占位符或 wanxiang） */
  const renderMediaItem = (
    key: string,
    description: string,
    status?: string,
    purpose?: string,
  ) => {
    const mediaUrl = getMediaUrl(key)
    const isFailed = status === 'failed'
    const isPending = status === 'pending'
    const isDone = status === 'generated' || status === 'uploaded'
    const isLoading = loadingKeys.has(key)

    return (
      <div
        key={key}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          padding: 8,
          border: '1px solid #f0f0f0',
          borderRadius: 6,
          background: isFailed ? '#fff2f0' : isPending ? '#fffbe6' : (isDone || !status) ? '#f6ffed' : undefined,
        }}
      >
        {/* 图片预览 */}
        <div style={{ width: 120, height: 90, overflow: 'hidden', borderRadius: 4, flexShrink: 0 }}>
          {isDone && mediaUrl ? (
            <Image
              src={mediaUrl}
              alt={description}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              preview={{ mask: t('preview') }}
            />
          ) : isFailed ? (
            <div style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#f5f5f5', color: '#ff4d4f', fontSize: 24,
            }}>
              ⚠️
            </div>
          ) : (
            <div style={{
              width: '100%', height: '100%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#fafafa', color: '#999',
            }}>
              {isLoading ? <Spin /> : '📷'}
            </div>
          )}
        </div>

        {/* 信息 + 操作 */}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {description?.slice(0, 60)}
            {description?.length > 60 ? '...' : ''}
          </div>
          <Space size={4} style={{ marginBottom: 4 }}>
            {isDone && <Tag color="success">{t("pmDone")}</Tag>}
            {isPending && <Tag color="warning">{t('pmPending')}</Tag>}
            {isFailed && <Tag color="error">{t('pmFailed')}</Tag>}
            {!status && <Tag color="success">{t("pmDone")}</Tag>}
            {purpose && <Tag>{purpose}</Tag>}
          </Space>

          {/* 操作按钮 */}
          <Space size={4} style={{ marginTop: 4 }}>
            {/* AI 生成按钮（占位符专用） */}
            {(isPending || isFailed) && onGenerateMedia && (
              <Button
                size="small"
                type="primary"
                icon={<ReloadOutlined />}
                loading={isLoading}
                onClick={() => handleGenerateMedia(key)}
              >
                {isFailed ? t('pmRetry') : t('pmAiGen')}
              </Button>
            )}

            {/* 上传按钮（占位符专用） */}
            {onUploadMedia && status && (
              <Upload
                accept=".jpg,.jpeg,.png,.gif,.webp"
                showUploadList={false}
                beforeUpload={(file) => {
                  setUploadingKey(key)
                  onUploadMedia(key, file).finally(() => setUploadingKey(null))
                  return false
                }}
              >
                <Button
                  size="small"
                  icon={<UploadOutlined />}
                  loading={uploadingKey === key}
                >
                  {t('pmUpload')}
                </Button>
              </Upload>
            )}

            {/* 删除按钮 */}
            {onDeleteMedia && (
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={() => onDeleteMedia(key)}
              >
                {t('pmDelete')}
              </Button>
            )}
          </Space>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* SVG 配图区域 */}
      {showSvgSection && (
        <Card
          size="small"
          title={t('pmSvgTitle')}
          extra={
            <Space>
              {onDeleteSVG && hasSvg === 1 && (
                <Button size="small" danger icon={<DeleteOutlined />} onClick={onDeleteSVG}>
                  {t('pmDelete')}
                </Button>
              )}
              {onGenerateImage && (
                <Button size="small" icon={<PictureOutlined />} loading={wanxiangLoading} onClick={onGenerateImage}>
                  {t('pmWanxiang')}
                </Button>
              )}
              {onRegenerateSVG && (
                <Button size="small" icon={<ReloadOutlined />} loading={svgLoading} onClick={onRegenerateSVG}>
                  {hasSvg === 1 ? t('regenerate') : t('pmGenSvg')}
                </Button>
              )}
            </Space>
          }
          style={{ marginBottom: 12 }}
        >
          {hasSvg === 1 && svgContent ? (
            <SVGViewer svgCode={svgContent} expandable={true} />
          ) : (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#999' }}>
              {t('pmNoSvg')}
            </div>
          )}
        </Card>
      )}

      {/* 图片配图区域：合并占位符 + wanxiang 在一张卡片中 */}
      {(showPlaceholderSection || showWanxiangSection) && (
        <Card
          size="small"
          title={showPlaceholderSection ? t('pmPhotoWithCount', { count: placeholders.length }) : t('pmPhoto')}
          extra={
            // 批量重试：有失败占位符时显示
            placeholders.filter(ph => ph.status === 'failed').length > 0 && onGenerateMedia ? (
              <Button size="small" icon={<ReloadOutlined />} onClick={handleRetryAllFailed}>
                {t('pmRetryAll')} ({placeholders.filter(ph => ph.status === 'failed').length})
              </Button>
            ) : undefined
          }
        >
          <Space orientation="vertical" style={{ width: '100%' }}>
            {/* 占位符条目 */}
            {placeholders.map(ph =>
              renderMediaItem(ph.key, ph.description, ph.status, ph.purpose)
            )}
            {/* wanxiang 独立配图条目（仅在无占位符时展示在此处） */}
            {showWanxiangSection && wanxiangEntries.map(f =>
              renderMediaItem(f.key, f.alt || t('pmFigure'))
            )}
          </Space>
        </Card>
      )}

      {/* 仅有 wanxiang 配图时，也保留展示（已被上面合并，这里兜底） */}
      {!showPlaceholderSection && !showWanxiangSection && wanxiangEntries.length > 0 && (
        <Card size="small" title={t('pmPhoto')}>
          <Space orientation="vertical" style={{ width: '100%' }}>
            {wanxiangEntries.map(f =>
              renderMediaItem(f.key, f.alt || t('pmFigure'))
            )}
          </Space>
        </Card>
      )}
    </div>
  )
}

export default PlaceholderManager
