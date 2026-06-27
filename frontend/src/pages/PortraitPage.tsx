import React, { useEffect, useState } from 'react'
import {
  Card, Row, Col, Typography, Spin, Button, Tag, Space, Tabs,
  Select, message, Modal, Empty, Tooltip, Divider,
  Radio, Badge, Alert,
} from 'antd'
import {
  EditOutlined, HeartOutlined, HeartFilled, ShareAltOutlined,
  GlobalOutlined, TeamOutlined, LockOutlined, DeleteOutlined,
  DownloadOutlined, EyeOutlined, CalendarOutlined,
  ThunderboltOutlined, StarOutlined,
  FireOutlined, PictureOutlined, WarningOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '../stores/authStore'
import { usePortraitStore } from '../stores/portraitStore'
import type { PortraitData } from '../api/portrait'

const { Title, Text, Paragraph } = Typography

const STYLE_EMOJI: Record<string, string> = {
  magic_academy: '🔮',
  cyber_scholar: '💻',
  chinese_ink: '🖌️',
  space_explorer: '🚀',
  anime_hero: '💥',
  fairy_spirit: '🧚',
  steampunk: '⚙️',
  pixel_world: '🎮',
  dunhuang: '🎭',
  aurora_dream: '🌌',
  superhero: '🦸',
  medieval_knight: '⚔️',
  cyber_faerie: '🦋',
  ocean_explorer: '🐚',
  time_traveler: '⏳',
  creative: '🎨',
  random: '🎲',
}

const SCOPE_MAP: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  public: { label: '公开', icon: <GlobalOutlined />, color: 'green' },
  class: { label: '本班', icon: <TeamOutlined />, color: 'blue' },
  private: { label: '私密', icon: <LockOutlined />, color: 'default' },
}

const COMMENT_COLORS = [
  '#f56a00', '#7265e6', '#ffbf00', '#00a2ae', '#eb2f96',
  '#fa541c', '#722ed1', '#13c2c2', '#52c41a', '#fa8c16',
]

const PortraitPage: React.FC = () => {
  const currentUser = useAuthStore((s) => s.user)
  const {
    todayPortrait, todayExists, historyList,
    publicGallery, classGallery, hotGallery,
    styles, loading, generating, error,
    fetchToday, fetchHistory, fetchStyles,
    generate, toggleLike, share, unshare,
    deletePortrait, fetchPublicGallery, fetchClassGallery, fetchHotGallery,
  } = usePortraitStore()

  const [activeTab, setActiveTab] = useState('today')
  const [selectedStyle, setSelectedStyle] = useState('random')
  const [shareModalVisible, setShareModalVisible] = useState(false)
  const [sharingPortrait, setSharingPortrait] = useState<PortraitData | null>(null)
  const [shareScope, setShareScope] = useState('public')
  const [detailModalVisible, setDetailModalVisible] = useState(false)
  const [detailPortrait, setDetailPortrait] = useState<PortraitData | null>(null)
  const [galleryTab, setGalleryTab] = useState('public')
  const [commentColor] = useState(() => COMMENT_COLORS[Math.floor(Math.random() * COMMENT_COLORS.length)])

  useEffect(() => {
    fetchStyles()
    fetchToday()
    fetchHistory()
  }, [fetchStyles, fetchToday, fetchHistory])

  useEffect(() => {
    if (activeTab === 'gallery') {
      fetchPublicGallery()
      fetchClassGallery()
      fetchHotGallery()
    }
  }, [activeTab, fetchPublicGallery, fetchClassGallery, fetchHotGallery])

  const handleGenerate = async () => {
    const result = await generate(selectedStyle)
    if (result) {
      message.success('🎉 今日画像生成成功！')
    }
  }

  const handleLike = async (id: number) => {
    const res = await toggleLike(id)
    if (res) {
      message.success(res.action === 'liked' ? '❤️ 已点赞' : '已取消点赞')
    }
  }

  const handleShare = async () => {
    if (!sharingPortrait) return
    try {
      if (shareScope === 'private' && sharingPortrait.is_shared) {
        // 取消分享
        await unshare(sharingPortrait.id)
        message.success('已取消分享')
      } else {
        await share(sharingPortrait.id, shareScope)
        message.success(SCOPE_MAP[shareScope]?.label
          ? `已分享到「${SCOPE_MAP[shareScope].label}」`
          : '分享成功')
      }
      setShareModalVisible(false)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || '操作失败')
    }
  }

  const handleDelete = (portrait: PortraitData) => {
    Modal.confirm({
      title: '确认删除',
      content: `确定删除 ${portrait.created_date} 的画像吗？删除后无法恢复。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await deletePortrait(portrait.id)
          message.success('已删除')
        } catch {
          message.error('删除失败')
        }
      },
    })
  }

  const openShareModal = (portrait: PortraitData) => {
    const isOwner = portrait.username === currentUser?.username
    const isAdmin = currentUser?.role === 'admin'
    if (!isOwner && !isAdmin) {
      message.warning('只能管理自己的画像分享')
      return
    }
    setSharingPortrait(portrait)
    setShareScope(portrait.share_scope === 'private' ? 'public' : portrait.share_scope)
    setShareModalVisible(true)
  }

  const openDetail = async (portrait: PortraitData) => {
    setDetailPortrait(portrait)
    setDetailModalVisible(true)
  }

  const canGenerate = !todayExists && !generating

  // ─────────────────────────────────────────
  // Tab 1: 今日创作
  // ─────────────────────────────────────────
  const renderTodayTab = () => (
    <div>
      {/* 头部信息 */}
      <Card style={{ marginBottom: 16, borderRadius: 12, textAlign: 'center' }}>
        <Title level={4}>
          <CalendarOutlined /> {new Date().toLocaleDateString('zh-CN', {
            year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
          })}
        </Title>
        <Text type="secondary">每周一次，记录成长的每一步</Text>
      </Card>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip="加载中..." />
        </div>
      ) : todayExists && todayPortrait ? (
        /* 今日已生成 */
        todayPortrait.deleted ? (
          <Card style={{ borderRadius: 12, textAlign: 'center', padding: '40px 0' }}>
            <Title level={4} type="secondary"><WarningOutlined /> 今日画像已删除</Title>
            <Paragraph type="secondary">
              你本周已经生成过画像并删除了。每周仅限生成一次，<br />
              下周一后可再次创作。
            </Paragraph>
          </Card>
        ) : (
        <Row gutter={24}>
          <Col xs={24} md={12}>
            <Card
              style={{ borderRadius: 12, overflow: 'hidden' }}
              cover={
                todayPortrait.image_url ? (
                  <img
                    alt="今日画像"
                    src={todayPortrait.image_url}
                    style={{ width: '100%', maxHeight: 400, objectFit: 'contain', background: '#f5f5f5' }}
                  />
                ) : (
                  <div style={{
                    height: 300,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    flexDirection: 'column',
                    color: '#fff',
                    fontSize: 18,
                  }}>
                    <PictureOutlined style={{ fontSize: 64, marginBottom: 16 }} />
                    <Text style={{ color: 'rgba(255,255,255,0.8)' }}>图片生成中或暂不可用</Text>
                  </div>
                )
              }
            >
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Space>
                  <Tag icon={<CalendarOutlined />}>{todayPortrait.created_date}</Tag>
                  <Tag icon={STYLE_EMOJI[todayPortrait.style] || '🎨'}>
                    {styles.find(s => s.key === todayPortrait.style)?.name || todayPortrait.style}
                  </Tag>
                  {todayPortrait.is_shared ? (
                    <Tag color={SCOPE_MAP[todayPortrait.share_scope]?.color}>
                      {SCOPE_MAP[todayPortrait.share_scope]?.icon} {SCOPE_MAP[todayPortrait.share_scope]?.label}
                    </Tag>
                  ) : (
                    <Tag><LockOutlined /> 私密</Tag>
                  )}
                </Space>
                <Space>
                  <Button
                    type="text"
                    icon={todayPortrait.liked ? <HeartFilled style={{ color: '#ff4d4f' }} /> : <HeartOutlined />}
                    onClick={() => handleLike(todayPortrait.id)}
                  >
                    {todayPortrait.like_count || 0}
                  </Button>
                  <Button
                    type="text"
                    icon={<ShareAltOutlined />}
                    onClick={() => openShareModal(todayPortrait)}
                    style={{ color: todayPortrait.is_shared ? '#52c41a' : undefined }}
                  >
                    {todayPortrait.is_shared ? '已分享' : '分享'}
                  </Button>
                  {todayPortrait.image_url && (
                    <Button
                      type="text"
                      icon={<DownloadOutlined />}
                      href={todayPortrait.image_url}
                      target="_blank"
                      download
                    >
                      下载
                    </Button>
                  )}
                </Space>
              </Space>
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card
              style={{
                borderRadius: 12,
                minHeight: 300,
                borderLeft: `4px solid ${commentColor}`,
              }}
              title={<Space><EditOutlined style={{ color: commentColor }} /><Text strong>AI 今日寄语</Text></Space>}
            >
              <Paragraph
                style={{
                  fontSize: 15,
                  lineHeight: 1.8,
                  whiteSpace: 'pre-wrap',
                  fontStyle: 'italic',
                  color: '#595959',
                }}
              >
                {todayPortrait.ai_comment || '暂无寄语'}
              </Paragraph>
            </Card>
          </Col>
        </Row>
        )
      ) : (
        /* 今日未生成 - 可生成 */
        <Card style={{ borderRadius: 12, textAlign: 'center', padding: '20px 0' }}>
          <>
              <Title level={3} style={{ marginBottom: 8 }}>
                🎨 生成今日自我画像
              </Title>
              <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
                选择风格，AI 将根据你的学习数据生成专属画像和寄语 ✨
              </Text>

              <div style={{ maxWidth: 400, margin: '0 auto 24px' }}>
                <Select
                  style={{ width: '100%' }}
                  value={selectedStyle}
                  onChange={setSelectedStyle}
                  placeholder="选择风格"
                  size="large"
                  options={[
                    { label: '🎲 随机创意（由AI决定）', value: 'random' },
                    ...styles
                      .filter(s => s.key !== 'random')
                      .map(s => ({
                        label: `${STYLE_EMOJI[s.key] || '🎨'} ${s.name} - ${s.desc}`,
                        value: s.key,
                      })),
                  ]}
                />
              </div>

              {selectedStyle !== 'random' && (
                <div style={{
                  padding: 12,
                  background: '#f9f9f9',
                  borderRadius: 8,
                  margin: '0 auto 24px',
                  maxWidth: 400,
                }}>
                  <Text type="secondary">
                    {STYLE_EMOJI[selectedStyle] || '🎨'}{' '}
                    {styles.find(s => s.key === selectedStyle)?.desc || ''}
                  </Text>
                </div>
              )}

              <Button
                type="primary"
                size="large"
                icon={<ThunderboltOutlined />}
                onClick={handleGenerate}
                loading={generating}
                disabled={!canGenerate}
                style={{
                  height: 48,
                  borderRadius: 24,
                  paddingLeft: 32,
                  paddingRight: 32,
                  fontSize: 16,
                }}
              >
                {generating ? '✨ AI 创意中...' : '✨ 生成今日画像'}
              </Button>

              {error && (
                <Alert
                  type="error"
                  message={error}
                  showIcon
                  closable
                  style={{ marginTop: 16, maxWidth: 400, margin: '16px auto 0' }}
                />
              )}

              <Divider />
              <Text type="secondary" style={{ fontSize: 12 }}>
                ⏰ 每周仅可生成一次，下周一后可再次创作
              </Text>
            </>
        </Card>
      )}
    </div>
  )

  // ─────────────────────────────────────────
  // Tab 2: 个人画展
  // ─────────────────────────────────────────
  const renderGalleryTab = () => (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Title level={4}><StarOutlined /> 我的画展 · 共 {historyList.length} 幅</Title>
      </div>
      {historyList.length === 0 ? (
        <Empty description="还没有画像，去生成第一幅吧！" />
      ) : (
        <Row gutter={[16, 16]}>
          {historyList.map((portrait) => (
            <Col xs={24} sm={12} md={8} lg={6} key={portrait.id}>
              <Badge.Ribbon
                text={
                  <Space size={4}>
                    {SCOPE_MAP[portrait.share_scope]?.icon}
                    {SCOPE_MAP[portrait.share_scope]?.label}
                  </Space>
                }
                color={SCOPE_MAP[portrait.share_scope]?.color || 'default'}
              >
                <Card
                  hoverable
                  style={{ borderRadius: 12, overflow: 'hidden' }}
                  cover={
                    portrait.image_url ? (
                      <div
                        style={{
                          height: 200,
                          background: `url(${portrait.image_url}) center/cover`,
                          cursor: 'pointer',
                        }}
                        onClick={() => openDetail(portrait)}
                      />
                    ) : (
                      <div
                        style={{
                          height: 200,
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                        onClick={() => openDetail(portrait)}
                      >
                        <PictureOutlined style={{ fontSize: 48, color: 'rgba(255,255,255,0.6)' }} />
                      </div>
                    )
                  }
                  actions={[
                    <Tooltip title={portrait.liked ? '取消点赞' : '点赞'}>
                      <span onClick={() => handleLike(portrait.id)}>
                        {portrait.liked
                          ? <HeartFilled style={{ color: '#ff4d4f' }} />
                          : <HeartOutlined />}
                        {' '}{portrait.like_count || 0}
                      </span>
                    </Tooltip>,
                    <Tooltip title="分享">
                      <ShareAltOutlined onClick={() => openShareModal(portrait)} style={{ color: portrait.is_shared ? '#52c41a' : undefined }} />
                    </Tooltip>,
                    <Tooltip title="删除">
                      <DeleteOutlined onClick={() => handleDelete(portrait)} />
                    </Tooltip>,
                  ]}
                >
                  <Card.Meta
                    title={
                      <Space>
                        <Tag>{portrait.created_date}</Tag>
                        <Tag>{STYLE_EMOJI[portrait.style] || '🎨'}{' '}
                          {styles.find(s => s.key === portrait.style)?.name || portrait.style}
                        </Tag>
                      </Space>
                    }
                    description={
                      <Space>
                        <EyeOutlined /> {portrait.view_count || 0}
                        <HeartOutlined /> {portrait.like_count || 0}
                      </Space>
                    }
                  />
                </Card>
              </Badge.Ribbon>
            </Col>
          ))}
        </Row>
      )}
    </div>
  )

  // ─────────────────────────────────────────
  // Tab 3: 分享画廊
  // ─────────────────────────────────────────
  const renderPublicTab = () => {
    const data = galleryTab === 'public' ? publicGallery
      : galleryTab === 'class' ? classGallery
      : hotGallery

    return (
      <div>
        <Space style={{ marginBottom: 16 }}>
          <Radio.Group
            value={galleryTab}
            onChange={(e) => setGalleryTab(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="public"><GlobalOutlined /> 全校画廊</Radio.Button>
            <Radio.Button value="class"><TeamOutlined /> 本班画廊</Radio.Button>
            <Radio.Button value="hot"><FireOutlined /> 热门推荐</Radio.Button>
          </Radio.Group>
        </Space>

        {data.length === 0 ? (
          <Empty description={galleryTab === 'class' ? '同班同学还没有分享画像' : '还没有公开的画像'}>
            {!todayExists && (
              <Button type="primary" onClick={() => setActiveTab('today')}>
                去生成第一幅画像
              </Button>
            )}
          </Empty>
        ) : (
          <Row gutter={[16, 16]}>
            {data.map((portrait) => (
              <Col xs={24} sm={12} md={8} lg={6} key={portrait.id}>
                <Card
                  hoverable
                  style={{ borderRadius: 12, overflow: 'hidden' }}
                  cover={
                    portrait.image_url ? (
                      <div
                        style={{
                          height: 200,
                          background: `url(${portrait.image_url}) center/cover`,
                          cursor: 'pointer',
                        }}
                        onClick={() => openDetail(portrait)}
                      />
                    ) : (
                      <div
                        style={{
                          height: 200,
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                        }}
                        onClick={() => openDetail(portrait)}
                      >
                        <PictureOutlined style={{ fontSize: 48, color: 'rgba(255,255,255,0.6)' }} />
                      </div>
                    )
                  }
                  actions={[
                    <Tooltip title={portrait.liked ? '取消点赞' : '点赞'}>
                      <span onClick={() => handleLike(portrait.id)}>
                        {portrait.liked
                          ? <HeartFilled style={{ color: '#ff4d4f' }} />
                          : <HeartOutlined />}
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
                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        <Space>
                          <Tag>{portrait.created_date}</Tag>
                          <Tag>{STYLE_EMOJI[portrait.style] || '🎨'}{' '}
                            {styles.find(s => s.key === portrait.style)?.name || portrait.style}
                          </Tag>
                        </Space>
                        <Paragraph
                          ellipsis={{ rows: 2 }}
                          style={{ margin: 0, fontSize: 12, color: '#8c8c8c' }}
                        >
                          {portrait.ai_comment}
                        </Paragraph>
                      </Space>
                    }
                  />
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </div>
    )
  }

  // ─────────────────────────────────────────
  // 详情弹窗
  // ─────────────────────────────────────────
  const renderDetailModal = () => (
    <Modal
      open={detailModalVisible}
      onCancel={() => setDetailModalVisible(false)}
      footer={null}
      width={720}
      centered
      destroyOnClose
    >
      {detailPortrait && (
        <div>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              {detailPortrait.image_url ? (
                <img
                  alt="画像"
                  src={detailPortrait.image_url}
                  style={{ width: '100%', borderRadius: 8 }}
                />
              ) : (
                <div style={{
                  height: 300,
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <PictureOutlined style={{ fontSize: 64, color: 'rgba(255,255,255,0.5)' }} />
                </div>
              )}
            </Col>
            <Col xs={24} md={12}>
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <div>
                  <Text strong style={{ fontSize: 16 }}>📅 {detailPortrait.created_date}</Text>
                  <br />
                  <Tag style={{ marginTop: 8 }}>
                    {STYLE_EMOJI[detailPortrait.style] || '🎨'}{' '}
                    {styles.find(s => s.key === detailPortrait.style)?.name || detailPortrait.style}
                  </Tag>
                  {detailPortrait.student_name && (
                    <Tag>{detailPortrait.student_name}</Tag>
                  )}
                </div>

                <div style={{
                  background: '#f9f9f9',
                  borderRadius: 8,
                  padding: 16,
                  borderLeft: `4px solid ${commentColor}`,
                }}>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>
                    <EditOutlined style={{ color: commentColor }} /> AI 寄语
                  </Text>
                  <Paragraph style={{
                    fontSize: 14,
                    lineHeight: 1.8,
                    whiteSpace: 'pre-wrap',
                    fontStyle: 'italic',
                    margin: 0,
                  }}>
                    {detailPortrait.ai_comment || '暂无寄语'}
                  </Paragraph>
                </div>

                <Space>
                  <Button
                    icon={detailPortrait.liked ? <HeartFilled style={{ color: '#ff4d4f' }} /> : <HeartOutlined />}
                    onClick={() => handleLike(detailPortrait.id)}
                  >
                    {detailPortrait.like_count || 0} 人赞过
                  </Button>
                  {detailPortrait.username === currentUser?.username && (
                    <Button
                      icon={<ShareAltOutlined />}
                      onClick={() => {
                        setDetailModalVisible(false)
                        openShareModal(detailPortrait)
                      }}
                    >
                      分享
                    </Button>
                  )}
                  {detailPortrait.image_url && (
                    <Button
                      icon={<DownloadOutlined />}
                      href={detailPortrait.image_url}
                      target="_blank"
                      download
                    >
                      下载
                    </Button>
                  )}
                </Space>

                <div>
                  <Text type="secondary">
                    <EyeOutlined /> {detailPortrait.view_count || 0} 次浏览
                  </Text>
                </div>
              </Space>
            </Col>
          </Row>
        </div>
      )}
    </Modal>
  )

  // ─────────────────────────────────────────
  // 分享弹窗
  // ─────────────────────────────────────────
  const renderShareModal = () => (
    <Modal
      title={<span><ShareAltOutlined /> 分享画像</span>}
      open={shareModalVisible}
      onOk={handleShare}
      onCancel={() => setShareModalVisible(false)}
      okText="确认分享"
      cancelText="取消"
    >
      {sharingPortrait && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: 12,
            background: '#f9f9f9',
            borderRadius: 8,
          }}>
            {sharingPortrait.image_url ? (
              <img
                src={sharingPortrait.image_url}
                alt="预览"
                style={{ width: 80, height: 80, borderRadius: 8, objectFit: 'cover' }}
              />
            ) : (
              <div style={{
                width: 80, height: 80,
                background: 'linear-gradient(135deg, #667eea, #764ba2)',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <PictureOutlined style={{ fontSize: 32, color: 'rgba(255,255,255,0.6)' }} />
              </div>
            )}
            <div>
              <Text strong>{sharingPortrait.created_date} 的画像</Text>
              <br />
              <Text type="secondary">
                {STYLE_EMOJI[sharingPortrait.style] || '🎨'}{' '}
                {styles.find(s => s.key === sharingPortrait.style)?.name || sharingPortrait.style}
              </Text>
            </div>
          </div>

          <Divider style={{ margin: '8px 0' }} />
          <Text strong>选择分享范围：</Text>
          <Radio.Group
            value={shareScope}
            onChange={(e) => setShareScope(e.target.value)}
            style={{ width: '100%' }}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <Radio.Button value="public" style={{ display: 'block', height: 44, lineHeight: '44px', marginBottom: 8 }}>
                <GlobalOutlined /> 分享中心 — 全校可见
              </Radio.Button>
              <Radio.Button value="class" style={{ display: 'block', height: 44, lineHeight: '44px', marginBottom: 8 }}>
                <TeamOutlined /> 本班可见 — 仅同班同学可看
              </Radio.Button>
              <Radio.Button value="private" style={{ display: 'block', height: 44, lineHeight: '44px' }}>
                <LockOutlined /> 仅自己可见 — 不公开
              </Radio.Button>
            </Space>
          </Radio.Group>
        </Space>
      )}
    </Modal>
  )

  // ─────────────────────────────────────────
  // 主渲染
  // ─────────────────────────────────────────
  return (
    <div style={{ padding: '8px 0' }}>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        tabBarStyle={{ marginBottom: 24 }}
        items={[
          {
            key: 'today',
            label: <span><PictureOutlined /> 今日创作</span>,
            children: renderTodayTab(),
          },
          {
            key: 'history',
            label: <span><StarOutlined /> 我的画展</span>,
            children: renderGalleryTab(),
          },
          {
            key: 'gallery',
            label: <span><GlobalOutlined /> 分享画廊</span>,
            children: renderPublicTab(),
          },
        ]}
      />

      {renderDetailModal()}
      {renderShareModal()}
    </div>
  )
}

export default PortraitPage
