import React, { useEffect, useState, useCallback, useRef } from 'react'
import { Card, Typography, Button, Spin, Empty, Pagination, message, Space } from 'antd'
import { CrownOutlined, ReloadOutlined, FullscreenOutlined } from '@ant-design/icons'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'
import { getShowcaseList } from '../api/showcase'
import type { ShowcaseCard as ShowcaseCardType } from '../api/showcase'
import ShowcaseCard from '../components/showcase/ShowcaseCard'
import ShowcaseFilterBar from '../components/showcase/ShowcaseFilterBar'
import ShowcasePreviewModal from '../components/showcase/ShowcasePreviewModal'
import GenerateDialog from '../components/showcase/GenerateDialog'
import '../styles/showcase.css'
import { reportLoadError } from '../utils/loadError'

const { Title, Text } = Typography

const PAGE_SIZE = 20
/** 刷新按钮冷却（秒）；后端会在响应里回传真实间隔并覆盖这个兜底值 */
const REFRESH_COOLDOWN_SEC = 5

const ShowcasePage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const { t } = useTranslation('score')

  // 列表数据
  const [cards, setCards] = useState<ShowcaseCardType[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  // 筛选参数（合并管理）
  const [filters, setFilters] = useState({
    searchName: '',
    selectedGrade: '',
    selectedClass: '',
    sortBy: 'points' as string,
  })
  const [page, setPage] = useState(1)

  // 年级/班级选项
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])

  // 弹窗
  const [genOpen, setGenOpen] = useState(false)
  const [previewCard, setPreviewCard] = useState<ShowcaseCardType | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  // 防抖 timer + 首渲染标记
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFirstMount = useRef(true)

  // S2: 自动同步 —— 页面可见时每 60 秒静默拉一次（与服务端 60 秒缓存对齐），
  //     停留期间积分/称号/徽章/名次会自己更新，不用点「刷新」。
  const AUTO_SYNC_SEC = 60
  const [lastSync, setLastSync] = useState<Date | null>(null)
  const pageRef = useRef(1)
  const totalRef = useRef(0)
  const filtersRef = useRef(filters)
  filtersRef.current = filters

  // S3: 大屏「荣誉墙」模式（全屏放大 + 自动翻页，投影/典礼用）
  const [wallMode, setWallMode] = useState(false)

  // 刷新冷却与并发闸门（防止连点刷接口）
  const [cooldown, setCooldown] = useState(0)
  const cooldownSecRef = useRef(REFRESH_COOLDOWN_SEC)
  const inflightRef = useRef(false)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const startCooldown = useCallback((sec: number) => {
    cooldownSecRef.current = sec
    setCooldown(sec)
    if (tickRef.current) clearInterval(tickRef.current)
    tickRef.current = setInterval(() => {
      setCooldown((v) => {
        if (v <= 1) {
          if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null }
          return 0
        }
        return v - 1
      })
    }, 1000)
  }, [])

  useEffect(() => () => { if (tickRef.current) clearInterval(tickRef.current) }, [])

  // ── 统一加载函数 ──
  const fetchData = useCallback(async (p: number, f: typeof filters, manual = false, silent = false) => {
    if (inflightRef.current) return          // 同一时刻只允许一个列表请求
    inflightRef.current = true
    if (!silent) setLoading(true)            // 自动同步不闪整页 loading
    try {
      const res = await getShowcaseList({
        grade: f.selectedGrade || undefined,
        class_name: f.selectedClass || undefined,
        student_name: f.searchName || undefined,
        sort_by: f.sortBy,
        page: p,
        page_size: PAGE_SIZE,
        manual: manual || undefined,
      })
      setCards(res.cards)
      setTotal(res.total)
      setPage(p)
      pageRef.current = p
      totalRef.current = res.total || 0
      setLastSync(new Date())
      if (typeof res.refresh_interval === 'number' && res.refresh_interval > 0) {
        cooldownSecRef.current = res.refresh_interval
      }
    } catch (e: any) {
      // 关键修复：请求失败不再把整面墙清空，保留上一次结果再提示
      const status = e?.response?.status
      if (status === 429) {
        startCooldown(cooldownSecRef.current)
        message.warning(t('refreshCooldown', { sec: cooldownSecRef.current }))
      } else {
        message.error(e?.response?.data?.detail || t('refreshFailed'))
      }
    } finally {
      if (!silent) setLoading(false)
      inflightRef.current = false
    }
  }, [startCooldown, t])

  // ── S2: 停留期间自动同步（隐藏标签页不请求；切回来立刻补一次）──
  useEffect(() => {
    const sync = () => {
      if (document.hidden || inflightRef.current) return
      void fetchData(pageRef.current, filtersRef.current, false, true)
    }
    const id = setInterval(sync, AUTO_SYNC_SEC * 1000)
    const onVisible = () => { if (!document.hidden) sync() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchData])

  // ── S3: 大屏模式 Esc 退出 + 自动翻页 ──
  useEffect(() => {
    if (!wallMode) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setWallMode(false) }
    document.addEventListener('keydown', onKey)
    const id = setInterval(() => {
      if (document.hidden) return
      const pages = Math.max(1, Math.ceil(totalRef.current / PAGE_SIZE))
      const next = (pageRef.current % pages) + 1
      void fetchData(next, filtersRef.current, false, true)
    }, 12000)
    return () => {
      document.removeEventListener('keydown', onKey)
      clearInterval(id)
    }
  }, [wallMode, fetchData])

  // ── 筛选变化 → 防抖 → 第1页重新加载（跳过首次渲染）──
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchData(1, filters)
    }, 400)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [filters.searchName, filters.selectedGrade, filters.selectedClass, filters.sortBy])

  // ── 页码变化 → 直接加载 ──
  const handlePageChange = useCallback((newPage: number) => {
    fetchData(newPage, filters)
  }, [fetchData, filters])

  // ── 初次加载 + 手动刷新 ──
  const doRefresh = useCallback(() => {
    if (cooldown > 0) {
      message.info(t('refreshCooldown', { sec: cooldown }))
      return
    }
    if (inflightRef.current) return
    fetchData(page, filters, true)            // 刷新停在当前页，不再跳回第 1 页
    startCooldown(cooldownSecRef.current)
  }, [cooldown, fetchData, filters, page, startCooldown, t])

  // ── 加载年级列表 ──
  useEffect(() => {
    (async () => {
      try {
        const { default: apiClient } = await import('../api/client')
        const { data } = await apiClient.get('/api/scores/my-grades')
        if (Array.isArray(data) && data.length > 0) setGrades(data)
      } catch (err) { reportLoadError(err, { key: 'showcase.grades' }) }
    })()
  }, [])

  // ── 年级变化 → 加载班级 ──
  useEffect(() => {
    if (!filters.selectedGrade) { setClasses([]); return }
    (async () => {
      try {
        const { default: apiClient } = await import('../api/client')
        const { data } = await apiClient.get('/api/scores/classes', { params: { grade: filters.selectedGrade } })
        setClasses(Array.isArray(data) ? data : [])
      } catch { setClasses([]) }
    })()
  }, [filters.selectedGrade])

  // ── 年级变化 → 清除班级 ──
  useEffect(() => {
    setFilters((prev) => ({ ...prev, selectedClass: '' }))
  }, [filters.selectedGrade])

  // ── 首次加载 ──
  useEffect(() => {
    fetchData(1, filters)
  }, [])

  // ── 生成成功刷新 ──
  const handleGenerateSuccess = useCallback(() => {
    fetchData(1, filters)
  }, [fetchData, filters])

  // ── 点赞回调 ──
  const handleLikeChange = useCallback((id: number, liked: boolean, count: number) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, liked, like_count: count } : c)))
  }, [])

  const handlePreviewLike = useCallback((id: number, liked: boolean, count: number) => {
    handleLikeChange(id, liked, count)
    setPreviewCard((prev) => (prev && prev.id === id ? { ...prev, liked, like_count: count } : prev))
  }, [handleLikeChange])

  const handleCardClick = useCallback((card: ShowcaseCardType) => {
    setPreviewCard(card)
    setPreviewOpen(true)
  }, [])

  // ── 主题变化 → 同步更新卡片列表中的 theme_style ──
  const handleThemeChange = useCallback((id: number, newTheme: string) => {
    setCards((prev) => prev.map((c) =>
      c.id === id ? { ...c, theme_style: newTheme } : c,
    ))
  }, [])

  // ── 筛选变更入口 ──
  const updateFilter = useCallback((key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }))
  }, [])

  return (
    <Card style={{ borderRadius: 12 }}>
      {/* 标题行 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            <CrownOutlined style={{ color: '#faad14', marginRight: 8 }} />
            {t('hallOfGlory')}
          </Title>
          <Text type="secondary">{t('showcaseSubtitle')}</Text>
          {/* S2: 让学生看见"分数在动"：每 60 秒自动同步一次 */}
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {lastSync
                ? t('scAutoSyncAt', { time: lastSync.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) })
                : t('scAutoSyncHint')}
            </Text>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<FullscreenOutlined />} onClick={() => setWallMode(true)} disabled={!cards.length}>
            {t('scWallMode')}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={doRefresh}
            loading={loading}
            disabled={cooldown > 0}
          >
            {cooldown > 0 ? t('refreshCountdown', { sec: cooldown }) : t('refresh')}
          </Button>
          {isTeacherOrAdmin && (
            <Button type="primary" icon={<CrownOutlined />} onClick={() => setGenOpen(true)}>
              {t('generateCard')}
            </Button>
          )}
        </div>
      </div>

      {/* 筛选栏 */}
      <ShowcaseFilterBar
        grades={grades}
        classes={classes}
        selectedGrade={filters.selectedGrade}
        selectedClass={filters.selectedClass}
        searchName={filters.searchName}
        sortBy={filters.sortBy}
        onGradeChange={(v) => updateFilter('selectedGrade', v)}
        onClassChange={(v) => updateFilter('selectedClass', v)}
        onSearchNameChange={(v) => updateFilter('searchName', v)}
        onSortChange={(v) => updateFilter('sortBy', v)}
      />

      {/* 卡片网格 */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip={t('loading')} />
        </div>
      ) : cards.length === 0 ? (
        <Empty
          description={
            isTeacherOrAdmin
              ? t('noCardTeacher')
              : t('noCardStudent')
          }
          style={{ padding: 60 }}
        />
      ) : (
        <>
          <div className="showcase-grid">
            {cards.map((card) => (
              <ShowcaseCard
                key={card.id}
                card={card}
                onLikeChange={handleLikeChange}
                onClick={handleCardClick}
                onThemeChange={handleThemeChange}
              />
            ))}
          </div>

          {/* 分页 ——— 始终显示，单页时按钮自动禁用 */}
          <div style={{ textAlign: 'center', marginTop: 24 }}>
            <Pagination
              current={page}
              total={total}
              pageSize={PAGE_SIZE}
              onChange={handlePageChange}
              showSizeChanger={false}
              showTotal={(total) => t('totalShowcaseStudents', { count: total })}
              hideOnSinglePage={false}
            />
          </div>
        </>
      )}

      {/* 生成弹窗 */}
      <GenerateDialog
        open={genOpen}
        onClose={() => setGenOpen(false)}
        grades={grades}
        onSuccess={handleGenerateSuccess}
      />

      {/* 预览弹窗 */}
      <ShowcasePreviewModal
        card={previewCard}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        onLikeChange={handlePreviewLike}
      />

      {/* S3: 大屏荣誉墙 —— 全屏放大 + 12 秒自动翻页（投影/典礼用），Esc 或点右上角退出 */}
      {wallMode && (
        <div className="showcase-wall">
          <div className="showcase-wall-head">
            <Space>
              <CrownOutlined style={{ color: '#faad14' }} />
              <Text strong style={{ color: '#fff', fontSize: 22 }}>{t('hallOfGlory')}</Text>
              <Text style={{ color: 'rgba(255,255,255,0.65)' }}>
                {t('scWallPage', { page, total: Math.max(1, Math.ceil(total / PAGE_SIZE)) })}
              </Text>
            </Space>
            <Button ghost onClick={() => setWallMode(false)}>{t('scWallExit')}</Button>
          </div>
          <div className="showcase-grid showcase-wall-grid">
            {cards.map((card) => (
              <ShowcaseCard
                key={card.id}
                card={card}
                onLikeChange={handleLikeChange}
                onThemeChange={handleThemeChange}
              />
            ))}
          </div>
          <div className="showcase-wall-foot">
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>{t('scWallAutoNext')}</Text>
          </div>
        </div>
      )}
    </Card>
  )
}

export default ShowcasePage
