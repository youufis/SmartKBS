import React, { useEffect, useState } from 'react'
import {
  Card, Row, Col, Typography, Spin, Button, Tag, Space, Tabs,
  Select, message, Modal, Empty, Tooltip, Divider,
  Radio, Badge, Alert, Pagination, Input,
} from 'antd'
import {
  EditOutlined, HeartOutlined, HeartFilled, ShareAltOutlined,
  GlobalOutlined, TeamOutlined, LockOutlined, DeleteOutlined,
  DownloadOutlined, EyeOutlined, CalendarOutlined,
  ThunderboltOutlined, StarOutlined,
  FireOutlined, PictureOutlined, WarningOutlined,
  ExclamationCircleOutlined,
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
  // 分页状态
  const [historyPage, setHistoryPage] = useState(1)
  const [historyPageSize, setHistoryPageSize] = useState(12)
  const [galleryPage, setGalleryPage] = useState(1)
  const [galleryPageSize, setGalleryPageSize] = useState(12)
  // 搜索状态
  const [historySearch, setHistorySearch] = useState('')
  const [gallerySearch, setGallerySearch] = useState('')

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
    if (todayExists) {
      // 本周已生成过 → 确认是否消耗 100 积分
      Modal.confirm({
        title: '消耗 100 积分再生成一次？',
        icon: <ExclamationCircleOutlined />,
        content: (
          <div>
            <p>本周画像已生成，消耗 <Text strong style={{ color: '#faad14', fontSize: 18 }}>100</Text> 积分可再生成一次。</p>
            <p style={{ color: '#888', fontSize: 13 }}>积分不足？参与课堂活动、完成练习等均可获得积分。</p>
          </div>
        ),
        okText: '消耗 100 积分生成',
        cancelText: '算了',
        onOk: async () => {
          const result = await generate(selectedStyle, true)
          if (result) {
            message.success('🎉 画像生成成功！已扣除 50 积分')
          }
        },
      })
      return
    }
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

  const canGenerate = !generating

  // ─────────────────────────────────────────
  // Tab 1: 本周创作
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
        <>
        {todayPortrait.deleted ? (
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
              title={<Space><EditOutlined style={{ color: commentColor }} /><Text strong>AI 本周寄语</Text></Space>}
            >
              <div style={{ maxHeight: 400, overflow: 'auto' }}>
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
              </div>
            </Card>
          </Col>
        </Row>
        )}

        {/* 本周已生成 → 提供积分兑换额外机会 */}
        {todayExists && todayPortrait && !todayPortrait.deleted && (
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Divider />
            <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
              ⏰ 每周免费一次，消耗 100 积分可再生成一次
            </Text>
            <Button
              icon={<ThunderboltOutlined />}
              onClick={handleGenerate}
              loading={generating}
              disabled={!canGenerate}
              style={{ height: 40, borderRadius: 20, paddingLeft: 24, paddingRight: 24 }}
            >
              {generating ? '✨ AI 创意中...' : '🔥 消耗 100 积分再生成'}
            </Button>
            {error && (
              <Alert type="error" message={error} showIcon closable
                onClose={() => usePortraitStore.setState({ error: null })}
                style={{ marginTop: 12, maxWidth: 400, margin: '12px auto 0' }}
              />
            )}
          </div>
        )}
        </>
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
                {generating ? '✨ AI 创意中...' : todayExists ? '🔥 消耗积分再生成' : '✨ 生成今日画像'}
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
                ⏰ 每周免费生成一次{todayExists ? '，或消耗 100 积分额外生成' : '，下周一后可再次创作'}
              </Text>
            </>
        </Card>
      )}
    </div>
  )

  // ─────────────────────────────────────────
  // Tab 2: 个人画展
  // ─────────────────────────────────────────
  const renderGalleryTab = () => {
    const filtered = historySearch
      ? historyList.filter((p) =>
          [p.created_date, p.style, p.ai_comment, ...(p.student_name ? [p.student_name] : [])]
            .some((v) => v.toLowerCase().includes(historySearch.toLowerCase()))
        )
      : historyList
    const start = (historyPage - 1) * historyPageSize
    const end = start + historyPageSize
    const paged = filtered.slice(start, end)
    return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={4} style={{ margin: 0 }}><StarOutlined /> 我的画展 · 共 {filtered.length} 幅</Title>
        <Input.Search
          placeholder="搜索日期、风格、寄语…"
          allowClear
          style={{ width: 240 }}
          value={historySearch}
          onChange={(e) => { setHistorySearch(e.target.value); setHistoryPage(1) }}
          onSearch={(v) => { setHistorySearch(v); setHistoryPage(1) }}
        />
      </div>
      {historyList.length === 0 ? (
        <Empty description="还没有画像，去生成第一幅吧！" />
      ) : (
        <>
        <Row gutter={[16, 16]}>
          {paged.map((portrait) => (
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
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Pagination
            current={historyPage}
            pageSize={historyPageSize}
            total={filtered.length}
            onChange={(p, ps) => { setHistoryPage(p); setHistoryPageSize(ps) }}
            showSizeChanger
            pageSizeOptions={['12', '24', '48']}
            showTotal={(t) => `共 ${t} 幅`}
          />
        </div>
        </>
      )}
    </div>
  )
  }

  // ─────────────────────────────────────────
  // Tab 3: 分享画廊
  // ─────────────────────────────────────────
  const renderPublicTab = () => {
    const rawData = galleryTab === 'public' ? publicGallery
      : galleryTab === 'class' ? classGallery
      : hotGallery
    const filtered = gallerySearch
      ? rawData.filter((p) =>
          [p.created_date, p.style, p.ai_comment, p.student_name || p.username]
            .some((v) => v.toLowerCase().includes(gallerySearch.toLowerCase()))
        )
      : rawData
    const start = (galleryPage - 1) * galleryPageSize
    const end = start + galleryPageSize
    const data = filtered.slice(start, end)

    return (
      <div>
        <Space style={{ marginBottom: 16 }} wrap>
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
          <Input.Search
            placeholder="搜索姓名、风格、寄语…"
            allowClear
            style={{ width: 220 }}
            value={gallerySearch}
            onChange={(e) => { setGallerySearch(e.target.value); setGalleryPage(1) }}
            onSearch={(v) => { setGallerySearch(v); setGalleryPage(1) }}
          />
        </Space>

        {(filtered.length === 0 && gallerySearch) ? (
          <Empty description="未找到匹配的画像" />
        ) : data.length === 0 ? (
          <Empty description={galleryTab === 'class' ? '同班同学还没有分享画像' : '还没有公开的画像'}>
            {!todayExists && (
              <Button type="primary" onClick={() => setActiveTab('today')}>
                去生成第一幅画像
              </Button>
            )}
          </Empty>
        ) : (
          <>
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
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Pagination
              current={galleryPage}
              pageSize={galleryPageSize}
            total={filtered.length}
              onChange={(p, ps) => { setGalleryPage(p); setGalleryPageSize(ps) }}
              showSizeChanger
              pageSizeOptions={['12', '24', '48']}
              showTotal={(t) => `共 ${t} 张`}
            />
          </div>
          </>
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
              <div style={{
                marginTop: 12,
                padding: '12px 16px',
                background: '#fafafa',
                borderRadius: 8,
                border: '1px solid #f0f0f0',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Tag style={{ margin: 0 }}>
                    {STYLE_EMOJI[detailPortrait.style] || '🎨'}{' '}
                    {styles.find(s => s.key === detailPortrait.style)?.name || detailPortrait.style}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    📅 {detailPortrait.created_date}
                  </Text>
                </div>
                <Space split={<Text type="secondary">|</Text>}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <EyeOutlined /> {detailPortrait.view_count || 0} 次浏览
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <HeartOutlined /> {detailPortrait.like_count || 0} 次点赞
                  </Text>
                </Space>
              </div>
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
                  <div style={{
                    maxHeight: 300,
                    overflow: 'auto',
                  }}>
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
            label: <span><PictureOutlined /> 本周创作</span>,
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
