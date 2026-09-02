import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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

// ── 10 套预设主题外观（用户可自选） ──
const PRESET_THEMES = [
  { key: 'aurora',     name: '极光紫', color: '#722ed1', gradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', borderColor: '#d3adf7', bgTint: '#f9f0ff' },
  { key: 'ocean',      name: '海洋蓝', color: '#1890ff', gradient: 'linear-gradient(135deg, #00c6fb 0%, #005bea 100%)', borderColor: '#91d5ff', bgTint: '#e6f7ff' },
  { key: 'forest',     name: '森林绿', color: '#52c41a', gradient: 'linear-gradient(135deg, #56ab2f 0%, #a8e063 100%)', borderColor: '#b7eb8f', bgTint: '#f6ffed' },
  { key: 'sunset',     name: '日落橙', color: '#fa8c16', gradient: 'linear-gradient(135deg, #f2994a 0%, #f2c94c 100%)', borderColor: '#ffd591', bgTint: '#fff7e6' },
  { key: 'cherry',     name: '樱花粉', color: '#eb2f96', gradient: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)', borderColor: '#ffadd2', bgTint: '#fff0f6' },
  { key: 'night',      name: '星空黑', color: '#1a1a2e', gradient: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)', borderColor: '#5a5a8a', bgTint: '#f0f0f5' },
  { key: 'minimal',    name: '极简灰', color: '#8c8c8c', gradient: 'linear-gradient(135deg, #a8a8a8 0%, #5c5c5c 100%)', borderColor: '#d9d9d9', bgTint: '#fafafa' },
  { key: 'passion',    name: '热情红', color: '#f5222d', gradient: 'linear-gradient(135deg, #cb2d3e 0%, #ef473a 100%)', borderColor: '#ffa39e', bgTint: '#fff1f0' },
  { key: 'golden',     name: '金色麦田', color: '#d4b106', gradient: 'linear-gradient(135deg, #d4b106 0%, #f5d76e 100%)', borderColor: '#ffe58f', bgTint: '#fffbe6' },
  { key: 'mint',       name: '薄荷清凉', color: '#13c2c2', gradient: 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)', borderColor: '#87e8de', bgTint: '#e6fffb' },
]

// 每种画像风格 → 绑定对应的主题（auto 模式使用此映射）
const STYLE_THEME_MAP: Record<string, string> = {
  magic_academy: 'aurora',
  cyber_scholar: 'ocean',
  chinese_ink: 'minimal',
  space_explorer: 'night',
  anime_hero: 'passion',
  fairy_spirit: 'cherry',
  steampunk: 'sunset',
  pixel_world: 'mint',
  dunhuang: 'golden',
  aurora_dream: 'aurora',
  superhero: 'passion',
  medieval_knight: 'sunset',
  cyber_faerie: 'cherry',
  ocean_explorer: 'ocean',
  time_traveler: 'night',
  creative: 'minimal',
}

/** 获取主题：用户手动选择时用固定主题，auto 模式跟随画像风格 */
function getTheme(themeKey: string, styleKey?: string) {
  const key = themeKey === 'auto' ? (styleKey ? STYLE_THEME_MAP[styleKey] : undefined) : themeKey
  return PRESET_THEMES.find(t => t.key === (key || 'aurora')) || PRESET_THEMES[0]
}

const DEFAULT_THEME_KEY = 'auto'
const STORAGE_THEME_KEY = 'portrait_theme_key'

const PortraitPage: React.FC = () => {
  const { t } = useTranslation('score')

  const SCOPE_MAP: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
    public: { label: t('scopePublic'), icon: <GlobalOutlined />, color: 'green' },
    class: { label: t('scopeClass'), icon: <TeamOutlined />, color: 'blue' },
    private: { label: t('scopePrivate'), icon: <LockOutlined />, color: 'default' },
  }
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
  // 用户选择的主题（'auto'=跟随画像风格，其他=固定主题，持久化到后端+localStorage）
  const [themeKey, setThemeKey] = useState<string>(DEFAULT_THEME_KEY)
  const [themeLoaded, setThemeLoaded] = useState(false)
  const theme = getTheme(themeKey, todayPortrait?.style)
  const [themePickerOpen, setThemePickerOpen] = useState(false)
  // 分页状态
  const [historyPage, setHistoryPage] = useState(1)
  const [historyPageSize, setHistoryPageSize] = useState(12)
  const [galleryPage, setGalleryPage] = useState(1)
  const [galleryPageSize, setGalleryPageSize] = useState(12)
  // 搜索状态
  const [historySearch, setHistorySearch] = useState('')
  const [gallerySearch, setGallerySearch] = useState('')

  // 启动时从后端加载主题偏好，降级到 localStorage
  useEffect(() => {
    (async () => {
      try {
        const { getPortraitTheme } = await import('../api/portrait')
        const backendTheme = await getPortraitTheme()
        if (backendTheme) {
          setThemeKey(backendTheme)
          localStorage.setItem(STORAGE_THEME_KEY, backendTheme)
        }
      } catch {
        // 后端不可用时使用 localStorage
        const local = localStorage.getItem(STORAGE_THEME_KEY)
        if (local) setThemeKey(local)
      }
      setThemeLoaded(true)
    })()
  }, [])

  // 主题切换时持久化到 localStorage + 后端
  useEffect(() => {
    localStorage.setItem(STORAGE_THEME_KEY, themeKey)
    if (themeLoaded) {
      import('../api/portrait').then(m => m.setPortraitTheme(themeKey)).catch(() => {})
    }
  }, [themeKey, themeLoaded])

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
        title: t('confirmRegenerate'),
        icon: <ExclamationCircleOutlined />,
        content: (
          <div>
            <p>{t('regenerateDesc', { points: 100 })}</p>
            <p style={{ color: '#888', fontSize: 13 }}>{t('pointsNotEnough')}</p>
          </div>
        ),
        okText: t('okRegenerate', { points: 100 }),
        cancelText: t('cancelRegenerate'),
        onOk: async () => {
          const result = await generate(selectedStyle, true)
          if (result) {
            message.success(t('generateSuccess', { points: 100 }))
          }
        },
      })
      return
    }
    const result = await generate(selectedStyle)
    if (result) {
      message.success(t('generateSuccess', { points: 0 }))
    }
  }

  const handleLike = async (id: number) => {
    const res = await toggleLike(id)
    if (res) {
      message.success(res.action === 'liked' ? t('alreadyLiked') : t('unliked'))
    }
  }

  const handleShare = async () => {
    if (!sharingPortrait) return
    try {
      if (shareScope === 'private' && sharingPortrait.is_shared) {
        // 取消分享
        await unshare(sharingPortrait.id)
        message.success(t('shareCancelled'))
      } else {
        await share(sharingPortrait.id, shareScope)
        message.success(SCOPE_MAP[shareScope]?.label
          ? t('ptSharedToScope', { scope: SCOPE_MAP[shareScope].label })
          : t('ptShareOk'))
      }
      setShareModalVisible(false)
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('ptOpFailed'))
    }
  }

  const handleDelete = (portrait: PortraitData) => {
    Modal.confirm({
      title: t('confirmDelete'),
      content: t('confirmDeletePortrait', { date: portrait.created_date }),
      okText: t('delete'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        try {
          await deletePortrait(portrait.id)
          message.success(t('deleteSuccess'))
        } catch {
          message.error(t('deleteFailed'))
        }
      },
    })
  }

  const openShareModal = (portrait: PortraitData) => {
    const isOwner = portrait.username === currentUser?.username
    const isAdmin = currentUser?.role === 'admin'
    if (!isOwner && !isAdmin) {
      message.warning(t('selfShareOnly'))
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
    <Card style={{ borderRadius: 8 }}>
      {/* 头部信息 */}
      <Card style={{ marginBottom: 16, borderRadius: 12, textAlign: 'center' }}>
        <Title level={4}>
          <CalendarOutlined /> {new Date().toLocaleDateString('zh-CN', {
            year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
          })}
        </Title>
        <Text type="secondary">{t('weeklyPortraitDesc')}</Text>
      </Card>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" description={t('loading')} />
        </div>
      ) : todayExists && todayPortrait ? (
        <>
        {todayPortrait.deleted ? (
          <Card style={{ borderRadius: 12, textAlign: 'center', padding: '40px 0' }}>
            <Title level={4} type="secondary"><WarningOutlined /> {t('todayPortraitDeleted')}</Title>
            <Paragraph type="secondary">
              {t('todayPortraitDeletedDesc')}
            </Paragraph>
          </Card>
        ) : (
        <Row gutter={24}>
          <Col xs={24} md={12}>
            <Card
              style={{
                borderRadius: 12, overflow: 'hidden',
                borderTop: `4px solid ${theme.color}`,
                background: theme.bgTint,
              }}
              cover={
                todayPortrait.image_url ? (
                  <img
                    alt={t('ptTodayPortrait')}
                    src={todayPortrait.image_url}
                    style={{ width: '100%', maxHeight: 400, objectFit: 'contain', background: theme.bgTint }}
                  />
                ) : (
                  <div style={{
                    height: 300,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: theme.gradient,
                    flexDirection: 'column',
                    color: '#fff',
                    fontSize: 18,
                  }}>
                    <PictureOutlined style={{ fontSize: 64, marginBottom: 16 }} />
                    <Text style={{ color: 'rgba(255,255,255,0.8)' }}>{t('ptImgPending')}</Text>
                  </div>
                )
              }
            >
              <Space orientation="vertical" style={{ width: '100%' }} size="small">
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
                    <Tag><LockOutlined /> {t('ptPrivate')}</Tag>
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
                    {todayPortrait.is_shared ? t('ptShared') : t('ptShare')}
                  </Button>
                  {todayPortrait.image_url && (
                    <Button
                      type="text"
                      icon={<DownloadOutlined />}
                      href={todayPortrait.image_url}
                      target="_blank"
                      download
                    >
                      {t('ptDownload')}
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
                borderLeft: `5px solid ${theme.color}`,
                background: theme.bgTint,
              }}
              title={<Space><EditOutlined style={{ color: theme.color }} /><Text strong>{t('ptWeeklyNote')}</Text></Space>}
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
                  {todayPortrait.ai_comment || t('ptNoNote')}
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
              {t('weeklyFreeHint')}
            </Text>
            <Button
              icon={<ThunderboltOutlined />}
              onClick={handleGenerate}
              loading={generating}
              disabled={!canGenerate}
              style={{ height: 40, borderRadius: 20, paddingLeft: 24, paddingRight: 24 }}
            >
              {generating ? '✨ ' + t('ptCreating') : `🔥 ${t('regenerateWithPoints')}`}
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
                🎨 {t('generateTodayPortrait')}
              </Title>
              <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
                {t('generateTodayPortraitDesc')}
              </Text>

              <div style={{ maxWidth: 400, margin: '0 auto 24px' }}>
                <Select
                  style={{ width: '100%' }}
                  value={selectedStyle}
                  onChange={setSelectedStyle}
                  placeholder={t('ptPickStyle')}
                  size="large"
                  options={[
                    { label: t('ptRandomStyle'), value: 'random' },
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
                {generating ? '✨ ' + t('ptCreating') : todayExists ? `🔥 ${t('regenerateWithPoints')}` : `✨ ${t('generateTodayPortrait')}`}
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
                {t('weeklyFreeHint')}
              </Text>
            </>
        </Card>
      )}
    </Card>
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
    <Card style={{ borderRadius: 8 }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Title level={4} style={{ margin: 0 }}><StarOutlined /> {t('ptMyGallery')} · {t('ptCountFrames', { count: filtered.length })}</Title>
        <Input.Search
          placeholder={t('ptSearchMine')}
          allowClear
          style={{ width: 240 }}
          value={historySearch}
          onChange={(e) => { setHistorySearch(e.target.value); setHistoryPage(1) }}
          onSearch={(v) => { setHistorySearch(v); setHistoryPage(1) }}
        />
      </div>
      {historyList.length === 0 ? (
        <Empty description={t('ptEmptyMine')} />
      ) : (
        <>
        <Row gutter={[16, 16]}>
          {paged.map((portrait) => {
            const ct = getTheme(themeKey, portrait.style)
            return (
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
                  style={{ borderRadius: 12, overflow: 'hidden', borderTop: `4px solid ${ct.color}`, background: ct.bgTint }}
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
                          background: getTheme(themeKey, portrait.style).gradient,
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
                    <Tooltip title={portrait.liked ? t('ptUnlike') : t('ptLike')}>
                      <span onClick={() => handleLike(portrait.id)}>
                        {portrait.liked
                          ? <HeartFilled style={{ color: '#ff4d4f' }} />
                          : <HeartOutlined />}
                        {' '}{portrait.like_count || 0}
                      </span>
                    </Tooltip>,
                    <Tooltip title={t('ptShare')}>
                      <ShareAltOutlined onClick={() => openShareModal(portrait)} style={{ color: portrait.is_shared ? '#52c41a' : undefined }} />
                    </Tooltip>,
                    <Tooltip title={t('ptDelete')}>
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
          )})}
        </Row>
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <Pagination
            current={historyPage}
            pageSize={historyPageSize}
            total={filtered.length}
            onChange={(p, ps) => { setHistoryPage(p); setHistoryPageSize(ps) }}
            showSizeChanger
            pageSizeOptions={['12', '24', '48']}
            showTotal={(num) => t('ptCountFrames', { count: num })}
          />
        </div>
        </>
      )}
    </Card>
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
            <Radio.Button value="public"><GlobalOutlined /> {t('ptSchoolGallery')}</Radio.Button>
            <Radio.Button value="class"><TeamOutlined /> {t('ptClassGallery')}</Radio.Button>
            <Radio.Button value="hot"><FireOutlined /> {t('ptHotGallery')}</Radio.Button>
          </Radio.Group>
          <Input.Search
            placeholder={t('ptSearchAll')}
            allowClear
            style={{ width: 220 }}
            value={gallerySearch}
            onChange={(e) => { setGallerySearch(e.target.value); setGalleryPage(1) }}
            onSearch={(v) => { setGallerySearch(v); setGalleryPage(1) }}
          />
        </Space>

        {(filtered.length === 0 && gallerySearch) ? (
          <Empty description={t('ptNoMatch')} />
        ) : data.length === 0 ? (
          <Empty description={galleryTab === 'class' ? t('ptEmptyClass') : t('ptEmptyPublic')}>
            {!todayExists && (
              <Button type="primary" onClick={() => setActiveTab('today')}>
                {t('ptGoGenerate')}
              </Button>
            )}
          </Empty>
        ) : (
          <>
          <Row gutter={[16, 16]}>
            {data.map((portrait) => {
              const ct = getTheme(portrait.portrait_theme || themeKey, portrait.style)
              return (
              <Col xs={24} sm={12} md={8} lg={6} key={portrait.id}>
                <Card
                  hoverable
                  style={{ borderRadius: 12, overflow: 'hidden', borderTop: `4px solid ${ct.color}`, background: ct.bgTint }}
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
                          background: getTheme(themeKey, portrait.style).gradient,
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
                    <Tooltip title={portrait.liked ? t('ptUnlike') : t('ptLike')}>
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
                        {portrait.grade && <Tag>{portrait.grade}{portrait.class_name ? ' ' + t('ptClassSuffix', { cls: portrait.class_name }) : ''}</Tag>}
                      </Space>
                    }
                    description={
                      <Space orientation="vertical" size={2} style={{ width: '100%' }}>
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
            )})}
          </Row>
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Pagination
              current={galleryPage}
              pageSize={galleryPageSize}
            total={filtered.length}
              onChange={(p, ps) => { setGalleryPage(p); setGalleryPageSize(ps) }}
              showSizeChanger
              pageSizeOptions={['12', '24', '48']}
              showTotal={(num) => t('ptCountSheets', { count: num })}
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
      destroyOnHidden
    >
      {detailPortrait && (() => {
        const dt = getTheme(detailPortrait.portrait_theme || themeKey, detailPortrait.style)
        return (
        <div>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              {detailPortrait.image_url ? (
                <img
                  alt={t('ptPortrait')}
                  src={detailPortrait.image_url}
                  style={{ width: '100%', borderRadius: 8 }}
                />
              ) : (
                <div style={{
                  height: 300,
                  background: dt.gradient,
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
                    <EyeOutlined /> {t('ptViews', { count: detailPortrait.view_count || 0 })}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    <HeartOutlined /> {t('ptLikes', { count: detailPortrait.like_count || 0 })}
                  </Text>
                </Space>
              </div>
            </Col>
            <Col xs={24} md={12}>
              <Space orientation="vertical" style={{ width: '100%' }} size="middle">
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
                  background: dt.bgTint,
                  borderRadius: 8,
                  padding: 16,
                  borderLeft: `5px solid ${dt.color}`,
                }}>
                  <Text strong style={{ display: 'block', marginBottom: 8 }}>
                    <EditOutlined style={{ color: dt.color }} /> {t('ptAiNote')}
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
                      {detailPortrait.ai_comment || t('ptNoNote')}
                    </Paragraph>
                  </div>
                </div>

                <Space>
                  <Button
                    icon={detailPortrait.liked ? <HeartFilled style={{ color: '#ff4d4f' }} /> : <HeartOutlined />}
                    onClick={() => handleLike(detailPortrait.id)}
                  >
                    {t('ptPeopleLiked', { count: detailPortrait.like_count || 0 })}
                  </Button>
                  {detailPortrait.username === currentUser?.username && (
                    <Button
                      icon={<ShareAltOutlined />}
                      onClick={() => {
                        setDetailModalVisible(false)
                        openShareModal(detailPortrait)
                      }}
                    >
                      {t('ptShare')}
                    </Button>
                  )}
                  {detailPortrait.image_url && (
                    <Button
                      icon={<DownloadOutlined />}
                      href={detailPortrait.image_url}
                      target="_blank"
                      download
                    >
                      {t('ptDownload')}
                    </Button>
                  )}
                </Space>

                <div>
                  <Text type="secondary">
                    <EyeOutlined /> {t('ptViews', { count: detailPortrait.view_count || 0 })}
                  </Text>
                </div>
              </Space>
            </Col>
          </Row>
        </div>
      )})()}
    </Modal>
  )

  // ─────────────────────────────────────────
  // 分享弹窗
  // ─────────────────────────────────────────
  const renderShareModal = () => (
    <Modal
      title={<span><ShareAltOutlined /> {t('ptSharePortrait')}</span>}
      open={shareModalVisible}
      onOk={handleShare}
      onCancel={() => setShareModalVisible(false)}
      okText={t('ptConfirmShare')}
      cancelText={t('ptCancel')}
    >
      {sharingPortrait && (() => {
        const st = getTheme(sharingPortrait.portrait_theme || themeKey, sharingPortrait.style)
        return (
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
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
                alt={t('ptPreview')}
                style={{ width: 80, height: 80, borderRadius: 8, objectFit: 'cover' }}
              />
            ) : (
              <div style={{
                width: 80, height: 80,
                background: st.gradient,
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <PictureOutlined style={{ fontSize: 32, color: 'rgba(255,255,255,0.6)' }} />
              </div>
            )}
            <div>
              <Text strong>{sharingPortrait.created_date} {t('ptOfPortrait')}</Text>
              <br />
              <Text type="secondary">
                {STYLE_EMOJI[sharingPortrait.style] || '🎨'}{' '}
                {styles.find(s => s.key === sharingPortrait.style)?.name || sharingPortrait.style}
              </Text>
            </div>
          </div>

          <Divider style={{ margin: '8px 0' }} />
          <Text strong>{t('ptPickScope')}</Text>
          <Radio.Group
            value={shareScope}
            onChange={(e) => setShareScope(e.target.value)}
            style={{ width: '100%' }}
          >
            <Space orientation="vertical" style={{ width: '100%' }}>
              <Radio.Button value="public" style={{ display: 'block', height: 44, lineHeight: '44px', marginBottom: 8 }}>
                <GlobalOutlined /> {t('ptScopeCenter')}
              </Radio.Button>
              <Radio.Button value="class" style={{ display: 'block', height: 44, lineHeight: '44px', marginBottom: 8 }}>
                <TeamOutlined /> 本班可见 — 仅同班同学可看
              </Radio.Button>
              <Radio.Button value="private" style={{ display: 'block', height: 44, lineHeight: '44px' }}>
                <LockOutlined /> {t('ptScopePrivate')}
              </Radio.Button>
            </Space>
          </Radio.Group>
        </Space>
      )})()}
    </Modal>
  )

  // ─────────────────────────────────────────
  // 主渲染
  // ─────────────────────────────────────────
  return (
    <Card style={{ borderRadius: 8 }}>
      {/* ── 主题选择器 ── */}
      <div style={{
        display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
        marginBottom: 12, gap: 8,
      }}>
        <Button
          type="text"
          size="small"
          icon={<span style={{
            display: 'inline-block', width: 12, height: 12,
            borderRadius: '50%', background: theme.color,
            border: '2px solid ' + theme.borderColor,
            verticalAlign: 'middle',
          }} />}
          onClick={() => setThemePickerOpen(!themePickerOpen)}
        >
          {themeKey === 'auto' ? '🎨 ' + t('ptAutoTheme') : `🎨 ${theme.name}`}
        </Button>
      </div>
      {themePickerOpen && (
        <div style={{
          background: '#fafafa', borderRadius: 10, padding: '12px 16px',
          marginBottom: 16, border: '1px solid #f0f0f0',
        }}>
          <Text type="secondary" style={{ display: 'block', marginBottom: 10, fontSize: 13 }}>
            {t('ptThemeHint')}
          </Text>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {/* 自动匹配 */}
            <Tooltip title={t('ptAutoThemeTip')}>
              <div
                onClick={() => { setThemeKey('auto'); setThemePickerOpen(false) }}
                style={{
                  width: 36, height: 36, borderRadius: '50%', cursor: 'pointer',
                  background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                  border: themeKey === 'auto' ? '3px solid #333' : '3px solid transparent',
                  boxShadow: themeKey === 'auto' ? '0 0 0 2px #bbb' : 'none',
                  transition: 'all 0.2s',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 18,
                }}
              >
                ✨
              </div>
            </Tooltip>
            {PRESET_THEMES.map(t => (
              <Tooltip key={t.key} title={t.name}>
                <div
                  onClick={() => { setThemeKey(t.key); setThemePickerOpen(false) }}
                  style={{
                    width: 36, height: 36, borderRadius: '50%', cursor: 'pointer',
                    background: t.gradient,
                    border: themeKey === t.key ? `3px solid ${t.color}` : '3px solid transparent',
                    boxShadow: themeKey === t.key ? `0 0 0 2px ${t.borderColor}` : 'none',
                    transition: 'all 0.2s',
                  }}
                />
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        tabBarStyle={{ marginBottom: 24 }}
        items={[
          {
            key: 'today',
            label: <span><PictureOutlined /> {t('weeklyPortrait')}</span>,
            children: renderTodayTab(),
          },
          {
            key: 'history',
            label: <span><StarOutlined /> {t('myGallery')}</span>,
            children: renderGalleryTab(),
          },
          {
            key: 'gallery',
            label: <span><GlobalOutlined /> {t('sharedGallery')}</span>,
            children: renderPublicTab(),
          },
        ]}
      />

      {renderDetailModal()}
      {renderShareModal()}
    </Card>
  )
}

export default PortraitPage
