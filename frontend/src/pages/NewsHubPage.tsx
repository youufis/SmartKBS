/** 热点新闻 - 独立页面 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Card, Tag, Button, Space, Typography, Pagination,
  message, Spin, Modal, Drawer, Empty, Tooltip, Result, Input,
} from 'antd';
import {
  GlobalOutlined, ReloadOutlined, HeartOutlined, HeartFilled,
  EyeOutlined, BookOutlined, SyncOutlined, LeftOutlined, RightOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useNewsStore } from '../stores/newsStore';
import { getDailyBriefing } from '../api/news';
import type { NewsArticle, NewsBriefing } from '../api/news';
import { useAuthStore } from '../stores/authStore';
import { useTranslation } from 'react-i18next'
import { useIsMobile } from '../hooks/useIsMobile'
import { RowList, RowItem } from '../components/RowList'
import { relativeTime, fullTime } from '../utils/relativeTime'
import PageHeader from '../components/PageHeader'
import DailyPointsBar from '../components/DailyPointsBar'

const { Text, Paragraph } = Typography;

/** 后端 /api/news/list 的每页条数（与 page_size 默认值一致） */
const PAGE_SIZE = 20;

const CATEGORY_COLORS: Record<string, string> = {
  '国内': 'red', '国际': 'blue', '科技': 'cyan',
  '教育': 'green', '体育': 'orange', '财经': 'gold', '娱乐': 'purple',
};

/** 本地"今天"前缀（服务器与学生同时区；不能用 toISOString 的 UTC 日期） */
function todayPrefix(): string {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isToday(ts: string): boolean {
  return !!ts && ts.slice(0, 10) === todayPrefix();
}

/** 列表缩略图：无图/加载失败直接不占位，懒加载 */
function NewsThumb({ url }: { url?: string }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return null;
  return (
    <img src={url} alt="" loading="lazy" onError={() => setBroken(true)}
      style= { { width: 92, height: 62, borderRadius: 8, objectFit: 'cover', display: 'block' } } />
  );
}

const NewsHubPage: React.FC = () => {
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [searchParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const isTeacherOrAdmin = user?.role === 'teacher' || user?.role === 'admin';
  const {
    articles, favorites, categories, loading, stats, total,
    loadList, loadCategories, loadFavorites, getDetail, toggleFavorite, loadStats,
    refreshing, lastFetch, refreshNow,
  } = useNewsStore();

  const [tab, setTab] = useState<'feed' | 'fav'>('feed');
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [detailModal, setDetailModal] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [cooldown, setCooldown] = useState(0);
  const [briefing, setBriefing] = useState<NewsBriefing | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingGenerating, setBriefingGenerating] = useState(false);
  const [briefingError, setBriefingError] = useState('');
  const briefingTimer = useRef<number | null>(null);

  // 列表加载（收藏 tab 用本地 favorites，不打列表接口）
  useEffect(() => {
    if (tab === 'fav') return;
    loadList(activeCategory, page, { keyword, unreadOnly });
  }, [tab, activeCategory, page, keyword, unreadOnly]);

  // 429 冷却倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  // NW16: 冷启动兜底 —— 首屏（全部分类第 1 页、无筛选）拿到空列表时自动强制抓一次。
  // 每个会话只兜底一次；并发与成本由后端抓取锁 + 每人 60s 刷新节流兜住。
  const coldStartFilled = useRef(false);
  useEffect(() => {
    if (coldStartFilled.current) return;
    if (tab !== 'feed') return;
    if (loading || activeCategory !== '' || page !== 1 || keyword || unreadOnly || articles.length > 0) return;
    coldStartFilled.current = true;
    void refreshNow().then(() => loadList('', 1)).catch(() => undefined);
  }, [loading, articles.length, activeCategory, page, tab, keyword, unreadOnly]);

  // 切分类/筛选后条数变少，可能停在一张空页上，自动回到第 1 页
  useEffect(() => {
    if (!loading && page > 1 && articles.length === 0 && total > 0) setPage(1);
  }, [loading, articles.length, page, total]);

  const handleCategoryChange = (cat: string) => {
    setActiveCategory(cat);
    setPage(1);
  };

  const handleViewDetail = async (newsId: number) => {
    setDetailLoading(true);
    try {
      const data = await getDetail(newsId);
      setDetailModal(data);
    } catch {
      message.error(t('loadFailed'))
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    loadCategories();
    loadStats();

    // 如果有指定新闻ID，自动打开详情
    const newsId = searchParams.get('id');
    if (newsId) {
      handleViewDetail(Number(newsId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 收藏：store 已乐观更新列表与 favorites，这里不再整页重读
  const handleToggleFavorite = (newsId: number, isFav: boolean) => {
    void toggleFavorite(newsId, isFav);
  };

  /**
   * NW11: 刷新 = 真的向后端要一次强制抓取，抓完再重读列表。
   * 429"过于频繁"带精确等待秒数，透传给学生并进入按钮冷却倒计时。
   */
  const handleRefresh = async () => {
    if (refreshing || cooldown > 0) return;
    const { res, error } = await refreshNow();

    const reload = async () => {
      if (page !== 1) setPage(1); // useEffect 会按第 1 页重新拉
      else await loadList(activeCategory, 1, { keyword, unreadOnly });
      await loadStats();
    };

    if (!res) {
      if (error) {
        message.error(error);
        const m = error.match(/(\d+)\s*秒/);
        if (m) setCooldown(Math.min(120, Number(m[1])));
      } else {
        message.error(t('networkError'));
      }
      await reload();
      return;
    }
    await reload();

    if (res.status === 'busy') {
      message.info(t('refreshBusy'));
      window.setTimeout(() => loadList(activeCategory, 1, { keyword, unreadOnly }), 5000);
      return;
    }
    if (res.status === 'failed') {
      message.error(t('refreshFailed'));
      return;
    }
    if (res.status === 'empty') {
      message.warning(t('refreshEmpty'));
      return;
    }
    if ((res.inserted ?? 0) > 0) {
      message.success(t('refreshOk', { added: res.inserted, renewed: res.renewed ?? 0 }));
    } else {
      message.success(t('refreshNoNew', { total: res.stored_total ?? 0 }));
    }
  };

  /** 最近一次抓取状态（顶栏"更新于 HH:MM"；源健康度明细只对教师展示） */
  const sourceHealth = lastFetch?.detail?.sources ?? [];
  const fetchStateText = !lastFetch?.fetched_at
    ? t('newsNeverFetched')
    : t('newsUpdatedAt', { time: lastFetch.fetched_at.slice(11, 16) })
      + (lastFetch.status === 'failed' ? ' · ' + t('newsFetchFailed')
        : lastFetch.status === 'partial' || lastFetch.status === 'empty'
          ? ' · ' + t('newsFetchPartial') : '');

  const stopBriefingPoll = () => {
    if (briefingTimer.current) {
      window.clearTimeout(briefingTimer.current);
      briefingTimer.current = null;
    }
  };

  /**
   * NW21: 简报改为「后端有界等待 + 前端轮询」。
   * generating 就明确显示"正在生成"并继续轮询，不再假报"加载失败"。
   */
  const loadBriefing = async (attempt = 0) => {
    setBriefingLoading(true);
    setBriefingError('');
    try {
      const data = await getDailyBriefing();
      if (data.status === 'generating') {
        setBriefing(null);
        setBriefingGenerating(true);
        if (attempt < 30) {
          briefingTimer.current = window.setTimeout(() => loadBriefing(attempt + 1), 3000);
        } else {
          setBriefingGenerating(false);
          setBriefingError(t('briefingTimeout'));
        }
        return;
      }
      setBriefingGenerating(false);
      setBriefing(data);
    } catch (e) {
      setBriefingGenerating(false);
      setBriefingError(t('loadFailed'));
      message.error(t('loadFailed'));
    } finally {
      setBriefingLoading(false);
    }
  };

  const handleOpenBriefing = () => {
    setBriefingOpen(true);
    if (!briefing) void loadBriefing();
  };

  useEffect(() => stopBriefingPoll, []);

  // 详情上一条/下一条：在当前展示源（推荐流或收藏）里走
  const sourceList: NewsArticle[] = tab === 'fav' ? favorites : articles;
  const curIdx = detailModal ? sourceList.findIndex((a) => a.id === detailModal.id) : -1;
  const gotoRelative = (delta: number) => {
    const next = curIdx >= 0 ? sourceList[curIdx + delta] : undefined;
    if (next) void handleViewDetail(next.id);
  };

  const renderRow = (item: NewsArticle) => (
    <RowItem
      key={item.id}
      style={{ cursor: 'pointer', padding: '12px 16px', opacity: item.is_viewed ? 0.66 : 1 }}
      onClick={() => handleViewDetail(item.id)}
      avatar={<NewsThumb url={item.image_url} />}
      actions={[
        <Tooltip key="fav" title={item.is_favorited ? t('unfavorite') : t('favorite')}>
          <Button
            type="text"
            size="small"
            icon={item.is_favorited
              ? <HeartFilled style={{ color: '#ff4d4f' }} />
              : <HeartOutlined />
            }
            onClick={(e) => {
              e.stopPropagation();
              handleToggleFavorite(item.id, item.is_favorited);
            }}
          />
        </Tooltip>,
      ]}
      title={
        <Space size={6}>
          <Tag color={CATEGORY_COLORS[item.category] || 'default'}
            style={{ fontSize: 10, lineHeight: '16px' }}>
            {item.category}
          </Tag>
          <Text strong style={{ fontSize: 14 }}>
            {item.title}
          </Text>
          {item.is_viewed && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              <EyeOutlined /> {t('readLabel')}
            </Text>
          )}
        </Space>
      }
      description={
        <Space size={16} style={{ marginTop: 4 }} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {item.source_name}
          </Text>
          {item.published_at && (
            <Tooltip title={fullTime(item.published_at)}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {relativeTime(item.published_at)}
              </Text>
            </Tooltip>
          )}
          {!!item.view_count && item.view_count > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              👀 {item.view_count} {t('newsHot')}
            </Text>
          )}
          {item.summary && (
            <Text type="secondary" style={{ fontSize: 12, maxWidth: 520 }} ellipsis>
              {item.summary}
            </Text>
          )}
        </Space>
      }
    />
  );

  const feedGroups: Array<[string, NewsArticle[]]> = (() => {
    const today = articles.filter((a) => isToday(a.published_at || a.fetched_at));
    const earlier = articles.filter((a) => !isToday(a.published_at || a.fetched_at));
    const out: Array<[string, NewsArticle[]]> = [];
    if (today.length) out.push([t('newsToday'), today]);
    if (earlier.length) out.push([t('newsEarlier'), earlier]);
    return out;
  })();

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* 顶部栏 */}
      <PageHeader
        icon={<GlobalOutlined />}
        title={t('hotNews')}
        extra={
          <Space>
            <Button size="small" onClick={handleOpenBriefing}>
              {t('dailyBriefingBtn')}
            </Button>
            {isTeacherOrAdmin && sourceHealth.length ? (
              <Tooltip
                title={
                  <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                    <div>{t('newsSourceHealth')}</div>
                    {sourceHealth.map((item) => (
                      <div key={item.source}>
                        {item.ok ? '✅' : '⚠️'} {item.source}
                        {item.ok ? ' (' + item.kept + '/' + item.entries + ')' : ' — ' + (item.error || 'HTTP ' + item.http)}
                      </div>
                    ))}
                  </div>
                }
              >
                <Text type="secondary" style={{ fontSize: 12, cursor: 'default' }}>
                  {fetchStateText}
                </Text>
              </Tooltip>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>{fetchStateText}</Text>
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={refreshing}
              disabled={cooldown > 0}
              onClick={handleRefresh}
            >
              {cooldown > 0 ? cooldown + 's' : t('refresh')}
            </Button>
          </Space>
        }
      />

      {/* 推荐流 / 收藏 */}
      <Space style={{ marginBottom: 12 }}>
        <Button size="small" type={tab === 'feed' ? 'primary' : 'default'} onClick={() => setTab('feed')}>
          {t('newsTabFeed')}
        </Button>
        <Button size="small" type={tab === 'fav' ? 'primary' : 'default'}
          onClick={() => { setTab('fav'); void loadFavorites(); }}>
          {t('newsTabFav')} ({favorites.length})
        </Button>
      </Space>

      {tab === 'feed' && (<>
        {/* 分类 + 搜索 + 未读筛选 */}
        <Card size="small" style={{ marginBottom: 16, borderRadius: 8 }}
          styles={{ body: { padding: '8px 12px' } }}>
          <Space wrap size={6} style={{ width: '100%' }}>
            <Tag
              color={activeCategory === '' ? 'blue' : 'default'}
              style={{ cursor: 'pointer', padding: '2px 8px' }}
              onClick={() => handleCategoryChange('')}
            >
              {t('all')}
            </Tag>
            {categories.map((cat) => (
              <Tag
                key={cat}
                color={activeCategory === cat ? CATEGORY_COLORS[cat] || 'blue' : 'default'}
                style={{ cursor: 'pointer', padding: '2px 8px' }}
                onClick={() => handleCategoryChange(cat)}
              >
                {cat}
              </Tag>
            ))}
            <Tag
              color={unreadOnly ? 'orange' : 'default'}
              style={{ cursor: 'pointer', padding: '2px 8px' }}
              onClick={() => { setUnreadOnly((v) => !v); setPage(1); }}
            >
              {t('newsUnreadOnly')}
            </Tag>
            <Input
              size="small"
              style={{ width: isMobile ? 150 : 220, marginLeft: 'auto' }}
              allowClear
              placeholder={t('newsSearchPh')}
              prefix={<SearchOutlined />}
              value={keywordInput}
              onChange={(e) => {
                setKeywordInput(e.target.value);
                if (!e.target.value) { setKeyword(''); setPage(1); }
              }}
              onPressEnter={() => { setKeyword(keywordInput.trim()); setPage(1); }}
            />
          </Space>
        </Card>
      </>)}

      {/* 积分进度条 */}
      <Card size="small" style={{ marginBottom: 16, borderRadius: 8 }}
        styles={{ body: { padding: '6px 16px' } }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('todayReadStats', { todayViews: stats.todayViews, todayPoints: stats.todayPoints, pointsMax: stats.pointsMax })}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('totalReadCount', { count: stats.totalViews })}
          </Text>
        </Space>
        <DailyPointsBar earned={stats.todayPoints} max={stats.pointsMax} strokeColor="#1677ff"
          tip={t('newsPointsRule', { max: stats.pointsMax })} />
      </Card>

      {/* 新闻列表 */}
      <Card loading={loading} styles={{ body: { padding: 0 } }}>
        {tab === 'fav' ? (
          favorites.length === 0 && !loading ? (
            <Empty style={{ padding: 40 }} description={
              <Space direction="vertical" size={2}>
                <Text>{t('newsFavEmpty')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('newsFavHint')}</Text>
              </Space>
            } />
          ) : (
            <RowList items={favorites} renderItem={(item) => renderRow(item)} />
          )
        ) : articles.length === 0 && !loading ? (
          <Empty
            style={{ padding: 40 }}
            description={
              <Space direction="vertical" size={2}>
                <Text>
                  {keyword || unreadOnly || activeCategory
                    ? t('listNoMatch')
                    : lastFetch?.status === 'failed'
                      ? t('newsSourceUnreachable')
                      : t('noNews')}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('noNewsRefreshHint')}
                </Text>
              </Space>
            }
          >
            <Button icon={<ReloadOutlined />} loading={refreshing} onClick={handleRefresh}>
              {t('refresh')}
            </Button>
          </Empty>
        ) : (
          <>
            {feedGroups.map(([label, list]) => (
              <div key={label}>
                <div style={{ padding: '8px 16px 2px', fontSize: 12, color: 'var(--text-tertiary)' }}>{label}</div>
                <RowList items={list} renderItem={(item) => renderRow(item)} />
              </div>
            ))}
            {total > PAGE_SIZE && (
              <div style={{ padding: '12px 16px', textAlign: 'center', borderTop: '1px solid var(--border-color-secondary, #f0f0f0)' }}>
                <Pagination
                  current={page} pageSize={PAGE_SIZE} total={total}
                  size="small" showSizeChanger={false}
                  showTotal={(tt) => t('newsTotalCount', { total: tt })}
                  onChange={(p) => setPage(p)}
                />
              </div>
            )}
          </>
        )}
      </Card>

      {/* 新闻详情 Modal */}
      <Modal
        title={
          <Space>
            <GlobalOutlined />
            <span>{detailModal?.title}</span>
          </Space>
        }
        open={!!detailModal}
        onCancel={() => setDetailModal(null)}
        footer={null}
        width={isMobile ? '94vw' : 700}
        loading={detailLoading}
      >
        {detailModal && (
          <div>
            <Space style={{ marginBottom: 12 }} wrap>
              <Tag color={CATEGORY_COLORS[detailModal.category] || 'default'}>
                {detailModal.category}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {detailModal.source_name}
              </Text>
              {detailModal.published_at && (
                <Tooltip title={fullTime(detailModal.published_at)}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {relativeTime(detailModal.published_at)}
                  </Text>
                </Tooltip>
              )}
            </Space>

            {/* 头图 */}
            {detailModal.image_url && (
              <img src={detailModal.image_url} alt="" loading="lazy"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                style={{ width: '100%', maxHeight: 240, objectFit: 'cover', borderRadius: 8, marginBottom: 12 }} />
            )}

            {/* AI摘要 */}
            {detailModal.ai_one_liner && (
              <Card size="small" style={{ marginBottom: 12, background: '#f6f8fa' }}>
                <Text strong style={{ fontSize: 13 }}>💡 {t('aiOneLiner')}</Text>
                <Paragraph style={{ margin: '4px 0 0', fontSize: 14 }}>
                  {detailModal.ai_one_liner}
                </Paragraph>
              </Card>
            )}
            {detailModal.ai_summary && (
              <Card size="small" style={{ marginBottom: 12, background: '#f6f8fa' }}>
                <Text strong style={{ fontSize: 13 }}>📝 {t('aiSummary')}</Text>
                <Paragraph style={{ margin: '4px 0 0', fontSize: 14 }}>
                  {detailModal.ai_summary}
                </Paragraph>
              </Card>
            )}
            {!detailModal.ai_one_liner && !detailModal.ai_summary && detailModal.ai_generating && (
              <Card size="small" style={{ marginBottom: 12, background: '#fffbe6' }}>
                <Text type="secondary" style={{ fontSize: 13 }}>💡 {t('newsAiGenerating')}</Text>
              </Card>
            )}

            {/* 学科关联 */}
            {detailModal.related_subjects?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Text strong style={{ fontSize: 13 }}>📐 {t('relatedSubjects')}</Text>
                <Space style={{ marginLeft: 8 }} wrap>
                  {detailModal.related_subjects.map((subj: string) => (
                    <Tag
                      key={subj}
                      color="blue"
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        navigate('/curriculum');
                        message.info(t('jumpToSubject', { subject: subj }));
                      }}
                    >
                      <BookOutlined /> {subj}
                    </Tag>
                  ))}
                </Space>
              </div>
            )}

            {/* 标签 */}
            {detailModal.tags?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {detailModal.tags.map((tag: string) => (
                  <Tag key={tag} style={{ fontSize: 11 }}>{tag}</Tag>
                ))}
              </div>
            )}

            {/* 底部操作：原文链接 / 收藏 / 上一篇下一篇 */}
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button
                type="primary"
                icon={<GlobalOutlined />}
                onClick={() => window.open(detailModal.url, '_blank')}
              >
                {t('readOriginal')}
              </Button>
              <Button
                icon={detailModal.is_favorited ? <HeartFilled /> : <HeartOutlined />}
                onClick={() => {
                  const newFav = !detailModal.is_favorited;
                  handleToggleFavorite(detailModal.id, detailModal.is_favorited);
                  setDetailModal({ ...detailModal, is_favorited: newFav });
                }}
              >
                {detailModal.is_favorited ? t('favorited') : t('favorite')}
              </Button>
              <div style={{ flex: 1 }} />
              <Button size="small" icon={<LeftOutlined />} disabled={curIdx <= 0}
                onClick={() => gotoRelative(-1)}>
                {t('prevArticle')}
              </Button>
              <Button size="small" iconPosition="end" icon={<RightOutlined />}
                disabled={curIdx < 0 || curIdx >= sourceList.length - 1}
                onClick={() => gotoRelative(1)}>
                {t('nextArticle')}
              </Button>
              {detailModal.points_awarded > 0 && (
                <Tag color="green">{t('pointsAwarded', { points: detailModal.points_awarded })}</Tag>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* 今日简报 Drawer（NW21 后对所有角色开放：内容就是当日新闻摘要，学生正是最需要导读的人） */}
      <Drawer
        title={t('dailyBriefingTitle')}
        placement="right"
        width={isMobile ? '100%' : 500}
        open={briefingOpen}
        onClose={() => { setBriefingOpen(false); stopBriefingPoll(); }}
      >
        {briefing ? (
          <div>
            <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
              {briefing.brief_content}
            </div>
            <div style={{ marginTop: 16, borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
              <Text type="secondary">
                {t('briefingInfo', { count: briefing.article_count, date: briefing.generated_at?.slice(0, 16) })}
              </Text>
            </div>
          </div>
        ) : briefingGenerating ? (
          <Result
            icon={<SyncOutlined spin style={{ color: '#1677ff' }} />}
            title={t('briefingGeneratingTitle')}
            subTitle={t('briefingGeneratingDesc')}
          />
        ) : briefingError ? (
          <Result
            status="warning"
            title={t('loadFailed')}
            subTitle={briefingError}
            extra={<Button onClick={() => loadBriefing()}>{t('retry')}</Button>}
          />
        ) : (
          <Spin tip={briefingLoading ? t('briefingGeneratingTitle') : undefined}>
            <div style={{ minHeight: 120 }} />
          </Spin>
        )}
      </Drawer>
    </Card>
  );
};

export default NewsHubPage;
