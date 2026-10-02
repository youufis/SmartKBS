/**
 * PlaceholderManager — 试题配图管理面板
 *
 * 教师端使用，展示试题的所有配图（SVG + 占位符图片 + 万相生图），
 * 支持：上传替换、AI 生成/重新生成、删除配图、批量重试失败项。
 *
 * 渲染口径（2026-10 修订）
 * ----------------------
 * 条目 = 「占位符」∪「media_files 里有图的 key」，而不是只看占位符：
 *   - 万相直接配图（key=wanxiang）没有占位符，老逻辑在有占位符时把它整个隐藏，
 *     教师看不到、删不掉、也没法再点"重新生成"；
 *   - 出题时自动生成的图片，历史上只回写了 media_files、没回写占位符的 status，
 *     于是 status 缺失的条目既不显示图片也不给任何按钮（只剩删除）。
 * 现在预览只看有没有 url，status 仅决定标签；缺 status 时按 url 推断。
 * 归一逻辑在 src/utils/mediaEntries.ts（列表页与面板共用）。
 */
import { useTranslation } from 'react-i18next'
import React, { useCallback, useMemo, useState } from 'react'
import { Card, Button, Upload, Space, Tag, Spin, Image, Empty, Alert, message } from 'antd'
import { UploadOutlined, ReloadOutlined, DeleteOutlined, PictureOutlined } from '@ant-design/icons'
import SVGViewer from './SVGViewer'
import { buildMediaEntries, type MediaEntry } from '../utils/mediaEntries'
import type { MediaFile, MediaPlaceholder } from '../types'

interface PlaceholderManagerProps {
  /** 试题 ID */
  questionId?: number
  /** SVG 代码 */
  svgContent?: string
  /** 是否有 SVG */
  hasSvg?: number
  /** 占位符列表（允许 JSON 字符串：不同接口返回形态不一致） */
  placeholders?: MediaPlaceholder[] | string | null
  /** 已上传/生成的媒体文件 */
  mediaFiles?: MediaFile[] | string | null
  /** 重新生成 SVG loading */
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
  /** 删除配图 */
  onDeleteMedia?: (key: string) => Promise<void>
  /** 万相生图（直接为试题生成配图） */
  onGenerateImage?: () => Promise<void>
  /** 后台任务进度文案（异步生图时由父组件传入，空则不显示） */
  progressText?: string
}

const PlaceholderManager: React.FC<PlaceholderManagerProps> = ({
  svgContent,
  hasSvg,
  placeholders,
  mediaFiles,
  svgLoading = false,
  wanxiangLoading = false,
  onRegenerateSVG,
  onDeleteSVG,
  onGenerateMedia,
  onUploadMedia,
  onDeleteMedia,
  onGenerateImage,
  progressText = '',
}) => {
  const { t } = useTranslation('exam')
  const [uploadingKey, setUploadingKey] = useState<string | null>(null)
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set())

  const entries = useMemo(
    () => buildMediaEntries(placeholders, mediaFiles),
    [placeholders, mediaFiles],
  )
  // "全部重试"只针对明确失败/文件丢失的条目：待配图是教师还没决定要不要生成，不该顺手烧配额
  const retryableKeys = entries
    .filter(e => e.fromPlaceholder && (e.status === 'failed' || e.status === 'missing'))
    .map(e => e.key)

  const markLoading = (key: string, on: boolean) => {
    setLoadingKeys(prev => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const handleGenerateMedia = useCallback(async (key: string) => {
    if (!onGenerateMedia) return
    markLoading(key, true)
    try {
      await onGenerateMedia(key)
    } finally {
      markLoading(key, false)
    }
  }, [onGenerateMedia])

  const handleRetryAll = useCallback(async () => {
    if (!onGenerateMedia || retryableKeys.length === 0) return
    for (const key of retryableKeys) {
      await handleGenerateMedia(key)
    }
    message.success(t('pmRetryOk', { count: retryableKeys.length }))
  }, [handleGenerateMedia, onGenerateMedia, retryableKeys, t])

  const showSvgSection = hasSvg === 1 || !!onRegenerateSVG
  const showImageSection = entries.length > 0

  // 进度条：异步生图（后台任务）时显示，没有它教师只能盯着转圈猜进行到哪一步
  const progressLine = progressText ? (
    <div style={{
      marginBottom: 10, padding: '6px 10px', borderRadius: 6,
      background: '#e6f4ff', color: '#1677ff', fontSize: 13,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <Spin size="small" />
      <span>{progressText}</span>
    </div>
  ) : null

  if (!showSvgSection && !showImageSection) {
    return (
      <div>
        {progressLine}
        <Empty description={t('pmNoFigure')} />
      </div>
    )
  }

  /** 渲染单条配图条目 */
  const renderMediaItem = (entry: MediaEntry) => {
    const { key, url, status, fromPlaceholder } = entry
    const isLoading = loadingKeys.has(key)
    const isDone = status === 'generated' || status === 'uploaded'
    const isFailed = status === 'failed'
    const isMissing = status === 'missing'
    const isPending = status === 'pending'

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
          background: (isFailed || isMissing) ? '#fff2f0' : isPending ? '#fffbe6' : '#f6ffed',
        }}
      >
        {/* 预览：只看有没有 url，不再依赖 status */}
        <div style={{ width: 120, height: 90, overflow: 'hidden', borderRadius: 4, flexShrink: 0 }}>
          {url && !isMissing ? (
            <Image
              src={url}
              alt={entry.description}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              preview={{ mask: t('preview') }}
            />
          ) : (isFailed || isMissing) ? (
            <div style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: '#f5f5f5', color: '#ff4d4f', fontSize: 24,
            }}>⚠️</div>
          ) : (
            <div style={{
              width: '100%', height: '100%', display: 'flex', alignItems: 'center',
              justifyContent: 'center', background: '#fafafa', color: '#999',
            }}>{isLoading ? <Spin /> : '📷'}</div>
          )}
        </div>

        {/* 信息 + 操作 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, marginBottom: 4, wordBreak: 'break-word' }}>
            {entry.description?.slice(0, 60)}
            {entry.description?.length > 60 ? '...' : ''}
          </div>
          <Space size={4} wrap style={{ marginBottom: 4 }}>
            {isDone && <Tag color="success">{t('pmDone')}</Tag>}
            {isPending && <Tag color="warning">{t('pmPending')}</Tag>}
            {isFailed && <Tag color="error">{t('pmFailed')}</Tag>}
            {isMissing && <Tag color="error">{t('pmMissing')}</Tag>}
            {!fromPlaceholder && <Tag>{t('pmWanxiang')}</Tag>}
            {entry.purpose && <Tag>{entry.purpose}</Tag>}
          </Space>

          <Space size={4} wrap style={{ marginTop: 4 }}>
            {/* AI 生图 / 重试 / 重新生成：有占位符描述就能反复生成 */}
            {onGenerateMedia && fromPlaceholder && (
              <Button
                size="small"
                type={isDone ? 'default' : 'primary'}
                icon={<ReloadOutlined />}
                loading={isLoading}
                onClick={() => handleGenerateMedia(key)}
              >
                {(isFailed || isMissing) ? t('pmRetry')
                  : isDone ? t('regenerate')
                  : t('pmAiGen')}
              </Button>
            )}

            {/* 上传图片替换 */}
            {onUploadMedia && (
              <Upload
                accept=".jpg,.jpeg,.png,.gif,.webp,.bmp"
                showUploadList={false}
                beforeUpload={(file) => {
                  setUploadingKey(key)
                  onUploadMedia(key, file)
                    .finally(() => setUploadingKey(null))
                  return false
                }}
              >
                <Button size="small" icon={<UploadOutlined />} loading={uploadingKey === key}>
                  {t('pmUpload')}
                </Button>
              </Upload>
            )}

            {/* 删除：删已有图片，或把占位符重置为待配图 */}
            {onDeleteMedia && (url || fromPlaceholder) && (
              <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDeleteMedia(key)}>
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
      {progressLine}

      {/* SVG 配图区域 */}
      {showSvgSection && (
        <Card
          size="small"
          title={t('pmSvgTitle')}
          extra={
            <Space wrap>
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

      {/* 图片配图区域：占位符图片与万相直接配图合并列出 */}
      {showImageSection && (
        <Card
          size="small"
          title={t('pmPhotoWithCount', { count: entries.length })}
          extra={
            onGenerateMedia && retryableKeys.length > 0 ? (
              <Button size="small" icon={<ReloadOutlined />} onClick={handleRetryAll}>
                {t('pmRetryAll')} ({retryableKeys.length})
              </Button>
            ) : undefined
          }
        >
          {entries.some(e => e.status === 'missing') && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message={t('pmMissingTip')}
            />
          )}
          <Space orientation="vertical" style={{ width: '100%' }}>
            {entries.map(renderMediaItem)}
          </Space>
        </Card>
      )}
    </div>
  )
}

export default PlaceholderManager
