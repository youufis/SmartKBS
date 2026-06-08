/**
 * PlaceholderManager — 试题配图管理面板
 *
 * 教师端使用，展示试题的所有配图（SVG + 占位符图片），
 * 支持：上传替换、AI重新生成、删除配图。
 */
import React, { useState } from 'react'
import { Card, Button, Upload, Space, Tag, Tooltip, message, Spin, Image, Empty } from 'antd'
import { UploadOutlined, ReloadOutlined, DeleteOutlined } from '@ant-design/icons'
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
  /** 是否正在生成 */
  generating?: boolean
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
}

const PlaceholderManager: React.FC<PlaceholderManagerProps> = ({
  questionId,
  svgContent,
  hasSvg,
  placeholders = [],
  mediaFiles = [],
  generating = false,
  onRegenerateSVG,
  onDeleteSVG,
  onGenerateMedia,
  onUploadMedia,
  onDeleteMedia,
}) => {
  const [uploadingKey, setUploadingKey] = useState<string | null>(null)

  // 查找占位符对应的媒体文件 URL
  const getMediaUrl = (key: string): string | undefined => {
    return mediaFiles.find(f => f.key === key)?.url
  }

  // 获取占位符状态
  const getPlaceholderStatus = (key: string): string => {
    const ph = placeholders.find(p => p.key === key)
    return ph?.status || 'pending'
  }

  if (!hasSvg && placeholders.length === 0 && !onRegenerateSVG) {
    return (
      <Empty description="暂无配图" />
    )
  }

  return (
    <div>
      {/* SVG 配图区域（有图时展示卡片+删除，无图时保留生成入口） */}
      {(hasSvg === 1 || onRegenerateSVG) && (
        <Card
          size="small"
          title="🖼️ SVG 配图"
          extra={
            <Space>
              {onDeleteSVG && hasSvg === 1 && (
                <Button size="small" danger icon={<DeleteOutlined />} onClick={onDeleteSVG}>
                  删除
                </Button>
              )}
              {onRegenerateSVG && (
                <Button size="small" icon={<ReloadOutlined />} loading={generating} onClick={onRegenerateSVG}>
                  {hasSvg === 1 ? '重新生成' : '生成 SVG'}
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
              暂无 SVG 配图，点击「生成 SVG」自动创建
            </div>
          )}
        </Card>
      )}

      {/* 占位符图片区域 */}
      {placeholders.length > 0 && (
        <Card
          size="small"
          title={`📷 图片配图（${placeholders.length} 个）`}
        >
          <Space direction="vertical" style={{ width: '100%' }}>
            {placeholders.map((ph) => {
              const status = ph.status
              const mediaUrl = getMediaUrl(ph.key)
              const isFailed = status === 'failed'
              const isPending = status === 'pending'
              const isDone = status === 'generated' || status === 'uploaded'

              return (
                <div
                  key={ph.key}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: 8,
                    border: '1px solid #f0f0f0',
                    borderRadius: 6,
                    background: isFailed ? '#fff2f0' : isPending ? '#fffbe6' : '#f6ffed',
                  }}
                >
                  {/* 图片预览 */}
                  <div style={{ width: 120, height: 90, overflow: 'hidden', borderRadius: 4, flexShrink: 0 }}>
                    {isDone && mediaUrl ? (
                      <Image
                        src={mediaUrl}
                        alt={ph.description}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        preview={{ mask: '预览' }}
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
                        {generating ? <Spin /> : '📷'}
                      </div>
                    )}
                  </div>

                  {/* 信息 + 操作 */}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 500, marginBottom: 4 }}>
                      {ph.description?.slice(0, 60)}
                      {ph.description?.length > 60 ? '...' : ''}
                    </div>
                    <Space size={4} style={{ marginBottom: 4 }}>
                      {isDone && <Tag color="success">已配图</Tag>}
                      {isPending && <Tag color="warning">待配图</Tag>}
                      {isFailed && <Tag color="error">生成失败</Tag>}
                      {ph.purpose && <Tag>{ph.purpose}</Tag>}
                    </Space>

                    {/* 操作按钮 */}
                    <Space size={4} style={{ marginTop: 4 }}>
                      {/* AI 生成按钮 */}
                      {(isPending || isFailed) && onGenerateMedia && (
                        <Button
                          size="small"
                          type="primary"
                          icon={<ReloadOutlined />}
                          loading={generating}
                          onClick={() => onGenerateMedia(ph.key)}
                        >
                          {isFailed ? '重试' : 'AI 生图'}
                        </Button>
                      )}

                      {/* 上传按钮 */}
                      {onUploadMedia && (
                        <Upload
                          accept=".jpg,.jpeg,.png,.gif,.webp"
                          showUploadList={false}
                          beforeUpload={(file) => {
                            setUploadingKey(ph.key)
                            onUploadMedia(ph.key, file).finally(() => setUploadingKey(null))
                            return false
                          }}
                        >
                          <Button
                            size="small"
                            icon={<UploadOutlined />}
                            loading={uploadingKey === ph.key}
                          >
                            上传
                          </Button>
                        </Upload>
                      )}

                      {/* 删除按钮（所有状态下都显示） */}
                      {onDeleteMedia && (
                        <Button
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={() => onDeleteMedia(ph.key)}
                        >
                          删除
                        </Button>
                      )}
                    </Space>
                  </div>
                </div>
              )
            })}
          </Space>
        </Card>
      )}
    </div>
  )
}

export default PlaceholderManager
