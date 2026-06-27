import React, { useEffect, useState } from 'react'
import { Tabs, Card, Row, Col, Tag, Typography, Space, Empty, Spin, Button, Tooltip, Modal } from 'antd'
import { FileOutlined, DownloadOutlined, FolderOutlined, PictureOutlined, HeartOutlined, HeartFilled, EyeOutlined } from '@ant-design/icons'
import { useAuthStore } from '../stores/authStore'
import { usePortraitStore } from '../stores/portraitStore'
import HtmlFilesPage from './HtmlFilesPage'
import DownloadsPage from './DownloadsPage'
import ResourceMgmtPage from './ResourceMgmtPage'

const STYLE_EMOJI: Record<string, string> = {
  magic_academy: '🔮', cyber_scholar: '💻', chinese_ink: '🖌️',
  space_explorer: '🚀', anime_hero: '💥', fairy_spirit: '🧚',
  steampunk: '⚙️', pixel_world: '🎮', dunhuang: '🎭',
  aurora_dream: '🌌', superhero: '🦸', medieval_knight: '⚔️',
  cyber_faerie: '🦋', ocean_explorer: '🐚', time_traveler: '⏳',
  creative: '🎨', random: '🎲',
}

const { Text } = Typography

const SharedCenterPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  const { publicGallery, fetchPublicGallery, toggleLike } = usePortraitStore()
  const [galleryLoading, setGalleryLoading] = useState(true)
  const [previewModal, setPreviewModal] = useState<any>(null)

  useEffect(() => {
    fetchPublicGallery().finally(() => setGalleryLoading(false))
  }, [fetchPublicGallery])

  const handleLike = async (id: number) => {
    await toggleLike(id)
  }

  const portraitGalleryTab = (
    <div>
      {galleryLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin /></div>
      ) : publicGallery.length === 0 ? (
        <Empty description="还没有学生分享画像" />
      ) : (
        <Row gutter={[16, 16]}>
          {publicGallery.map((portrait) => (
            <Col xs={24} sm={12} md={8} lg={6} key={portrait.id}>
              <Card
                hoverable
                style={{ borderRadius: 12, overflow: 'hidden' }}
                cover={
                  portrait.image_url ? (
                    <div
                      style={{ height: 180, background: `url(${portrait.image_url}) center/cover`, cursor: 'pointer' }}
                      onClick={() => setPreviewModal(portrait)}
                    />
                  ) : (
                    <div style={{ height: 180, background: 'linear-gradient(135deg, #667eea, #764ba2)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                      onClick={() => setPreviewModal(portrait)}
                    >
                      <PictureOutlined style={{ fontSize: 48, color: 'rgba(255,255,255,0.6)' }} />
                    </div>
                  )
                }
                actions={[
                  <Tooltip title={portrait.liked ? '取消点赞' : '点赞'}>
                    <span onClick={() => handleLike(portrait.id)}>
                      {portrait.liked ? <HeartFilled style={{ color: '#ff4d4f' }} /> : <HeartOutlined />}
                      {' '}{portrait.like_count || 0}
                    </span>
                  </Tooltip>,
                  <span><EyeOutlined /> {portrait.view_count || 0}</span>,
                ]}
              >
                <Card.Meta
                  title={
                    <Space>
                      <Text strong>{portrait.student_name || portrait.username}</Text>
                      {portrait.grade && <Tag>{portrait.grade}{portrait.class_name ? ` ${portrait.class_name}班` : ''}</Tag>}
                    </Space>
                  }
                  description={
                    <Space>
                      <Tag>{portrait.created_date}</Tag>
                      <Tag>{STYLE_EMOJI[portrait.style] || '🎨'} {portrait.style}</Tag>
                    </Space>
                  }
                />
              </Card>
            </Col>
          ))}
        </Row>
      )}

      {/* 预览弹窗 */}
      <Modal
        open={!!previewModal}
        onCancel={() => setPreviewModal(null)}
        footer={null}
        width={640}
        centered
      >
        {previewModal && (
          <div>
            {previewModal.image_url ? (
              <img src={previewModal.image_url} alt="画像" style={{ width: '100%', borderRadius: 8, marginBottom: 16 }} />
            ) : (
              <div style={{ height: 300, background: 'linear-gradient(135deg, #667eea, #764ba2)', borderRadius: 8, marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <PictureOutlined style={{ fontSize: 64, color: 'rgba(255,255,255,0.5)' }} />
              </div>
            )}
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Text strong>{previewModal.student_name || previewModal.username}</Text>
                <Tag>{previewModal.created_date}</Tag>
                <Tag>{STYLE_EMOJI[previewModal.style] || '🎨'} {previewModal.style}</Tag>
              </Space>
              {previewModal.ai_comment && (
                <Typography.Paragraph style={{ fontStyle: 'italic', color: '#595959', background: '#f9f9f9', padding: 12, borderRadius: 8, borderLeft: '4px solid #f56a00' }}>
                  {previewModal.ai_comment}
                </Typography.Paragraph>
              )}
              <Space>
                <Button
                  icon={previewModal.liked ? <HeartFilled style={{ color: '#ff4d4f' }} /> : <HeartOutlined />}
                  onClick={() => handleLike(previewModal.id)}
                >
                  {previewModal.like_count || 0} 人赞过
                </Button>
              </Space>
            </Space>
          </div>
        )}
      </Modal>
    </div>
  )

  const baseTabs = [
    {
      key: 'portrait',
      label: <span><PictureOutlined /> 学生画像</span>,
      children: portraitGalleryTab,
    },
  ]

  if (isTeacherOrAdmin) {
    baseTabs.push(
      {
        key: 'browse',
        label: <span><FileOutlined /> 资源浏览</span>,
        children: <HtmlFilesPage />,
      },
      {
        key: 'manage',
        label: <span><FolderOutlined /> 资源管理</span>,
        children: <ResourceMgmtPage />,
      },
      {
        key: 'downloads',
        label: <span><DownloadOutlined /> 文件中心</span>,
        children: <DownloadsPage />,
      },
    )
  } else {
    baseTabs.push(
      {
        key: 'html',
        label: <span><FileOutlined /> 共享资源</span>,
        children: <HtmlFilesPage />,
      },
      {
        key: 'downloads',
        label: <span><DownloadOutlined /> 共享文件</span>,
        children: <DownloadsPage />,
      },
    )
  }

  return (
    <Card style={{ margin: 24, borderRadius: 8 }}>
      <Tabs defaultActiveKey="portrait" items={baseTabs} />
    </Card>
  )
}

export default SharedCenterPage
