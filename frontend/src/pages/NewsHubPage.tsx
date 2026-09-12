/** 热点新闻 - 独立页面 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Card, List, Tag, Button, Space, Typography, Progress,
  message, Spin, Modal, Drawer, Tabs, Empty, Tooltip, Result,
} from 'antd';
import {
  GlobalOutlined, ReloadOutlined, HeartOutlined, HeartFilled,
  EyeOutlined, ArrowLeftOutlined, BookOutlined, RightOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useNewsStore } from '../stores/newsStore';
import { apiErrorDetail, getDailyBriefing } from '../api/news';
import type { NewsBriefing } from '../api/news';
import { useAuthStore } from '../stores/authStore';
import { useTranslation } from 'react-i18next'

const { Text, Paragraph, Title } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '国内': 'red', '国际': 'blue', '科技': 'cyan',
  '教育': 'green', '体育': 'orange', '财经': 'gold', '娱乐': 'purple',
};

const NewsHubPage: React.FC = () => {
  const { t } = useTranslation('common')
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const isTeacherOrAdmin = user?.role === 'teacher' || user?.role === 'admin';
  const {
    articles, categories, loading, stats,
    loadList, loadCategories, getDetail, toggleFavorite, loadStats,
    refreshing, lastFetch, refreshNow,
  } = useNewsStore();

  const [activeCategory, setActiveCategory] = useState<string>('');
  const [detailModal, setDetailModal] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [briefing, setBriefing] = useState<NewsBriefing | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingGenerating, setBriefingGenerating] = useState(false);
  const [briefingError, setBriefingError] = useState('');
  const briefingTimer = useRef<number | null>(null);
  const tabsItems = [
    { key: 'feed', label: t('newsList') },
    { key: 'briefing', label: t('dailyBriefing') },
  ];

  useEffect(() => {
    loadCategories();
    loadStats();

    // 如果有指定新闻ID，自动打开详情
    const newsId = searchParams.get('id');
    if (newsId) {
      handleViewDetail(Number(newsId));
    }
  }, []);

  useEffect(() => {
    loadList(activeCategory, page);
  }, [activeCategory, page]);

  // NW16: 冷启动兜底 —— 首屏（全部分类第 1 页）拿到空列表时自动强制抓一次。
  // 旧行为要先点一次刷新才可能有数据，而"抓取在后台 + 本次响应仍是旧数据"让学生以为功能坏了。
  // 每个会话只兜底一次；并发与成本由后端抓取锁 + 每人 60s 刷新节流兜住。
  const coldStartFilled = useRef(false);
  useEffect(() => {
    if (coldStartFilled.current) return;
    if (loading || activeCategory !== '' || page !== 1 || articles.length > 0) return;
    coldStartFilled.current = true;
    void refreshNow().then(() => loadList('', 1)).catch(() => undefined);
  }, [loading, articles.length, activeCategory, page]);

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

  const handleToggleFavorite = async (newsId: number, isFav: boolean) => {
    await toggleFavorite(newsId, isFav);
    // 刷新列表更新收藏状态
    loadList(activeCategory, page);
  };

  /**
   * NW11: 刷新 = 真的向后端要一次强制抓取，抓完再重读列表。
   * 旧实现是先无条件弹"已刷新"再读旧列表，后端抓取既被 2h 缓存/10min 节流拦住、
   * 又是后台异步，所以点了永远没反应。
   */
  const handleRefresh = async () => {
    if (refreshing) return;
    const res = await refreshNow();

    const reload = async () => {
      if (page !== 1) setPage(1); // useEffect 会按第 1 页重新拉
      else await loadList(activeCategory, 1);
      await loadStats();
    };

    if (!res) {
      message.error(t('networkError'));
      await reload();
      return;
    }
    await reload();

    if (res.status === 'busy') {
      message.info(t('refreshBusy'));
      window.setTimeout(() => loadList(activeCategory, 1), 5000);
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

  /** 最近一次抓取状态（顶栏"更新于 HH:MM" + 源健康度 tooltip） */
  const sourceHealth = lastFetch?.detail?.sources ?? [];
  const fetchStateText = !lastFetch?.fetched_at
    ? t('newsNeverFetched')
    : t('newsUpdatedAt', { time: lastFetch.fetched_at.slice(11, 16) })
      + (lastFetch.status === 'failed' ? ` · ${t('newsFetchFailed')}`
        : lastFetch.status === 'partial' || lastFetch.status === 'empty'
          ? ` · ${t('newsFetchPartial')}` : '');

  const stopBriefingPoll = () => {
    if (briefingTimer.current) {
      window.clearTimeout(briefingTimer.current);
      briefingTimer.current = null;
    }
  };

  /**
   * NW21: 简报改为「后端有界等待 + 前端轮询」。
   * 旧实现：后端同步跑完整次 AI（实测 57s）才返回，而 axios 全局超时 30s
   * → 必然报"加载失败"且抽屉空白；可服务器仍在后台把简报写进了缓存，
   * 于是"关掉再点开就有了"。现在 generating 就明确显示"正在生成"并继续轮询。
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
      setBriefingError(apiErrorDetail(e) || t('networkError'));
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

  const progressPercent = Math.round(
    (stats.todayPoints / stats.pointsMax) * 100
  );

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* 顶部栏 */}
      <Card
        size="small"
        style={{ marginBottom: 16, borderRadius: 8 }}
        styles={{ body: { padding: '8px 16px' } }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Space>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)} />
            <GlobalOutlined style={{ color: '#1677ff', fontSize: 18 }} />
            <Text strong style={{ fontSize: 16 }}>{t('hotNews')}</Text>
          </Space>
          <Space>
            {isTeacherOrAdmin && (
              <Button size="small" onClick={handleOpenBriefing}>
                {t('dailyBriefingBtn')}
              </Button>
            )}
            <Tooltip
              title={
                sourceHealth.length
                  ? (
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      <div>{t('newsSourceHealth')}</div>
                      {sourceHealth.map((item) => (
                        <div key={item.source}>
                          {item.ok ? '✅' : '⚠️'} {item.source}
                          {item.ok ? ` (${item.kept}/${item.entries})` : ` — ${item.error || `HTTP ${item.http}`}`}
                        </div>
                      ))}
                    </div>
                  )
                  : undefined
              }
            >
              <Text type="secondary" style={{ fontSize: 12, cursor: 'default' }}>
                {fetchStateText}
              </Text>
            </Tooltip>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={refreshing}
              onClick={handleRefresh}
            >
              {t('refresh')}
            </Button>
          </Space>
        </div>
      </Card>

      {/* 分类标签 */}
      <Card size="small" style={{ marginBottom: 16, borderRadius: 8 }}
        styles={{ body: { padding: '8px 12px' } }}>
        <Space wrap size={4}>
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
        </Space>
      </Card>

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
        <Progress
          percent={progressPercent}
          size="small"
          strokeColor="#1677ff"
          showInfo={false}
        />
      </Card>

      {/* 新闻列表 */}
      <Card
        loading={loading}
        styles={{ body: { padding: 0 } }}
      >
        {articles.length === 0 && !loading ? (
          <Empty
            style={{ padding: 40 }}
            description={
              <Space direction="vertical" size={2}>
                <Text>
                  {lastFetch?.status === 'failed'
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
          <List
            dataSource={articles}
            renderItem={(item) => (
              <List.Item
                style={{ cursor: 'pointer', padding: '12px 16px' }}
                onClick={() => handleViewDetail(item.id)}
                actions={[
                  <Tooltip title={item.is_favorited ? t('unfavorite') : t('favorite')}>
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
              >
                <List.Item.Meta
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
                    <Space size={16} style={{ marginTop: 4 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {item.source_name}
                      </Text>
                      {item.published_at && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {item.published_at.slice(0, 16).replace('T', ' ')}
                        </Text>
                      )}
                      {item.summary && (
                        <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                          {item.summary}
                        </Text>
                      )}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
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
        width={700}
        loading={detailLoading}
      >
        {detailModal && (
          <div>
            <Space style={{ marginBottom: 12 }}>
              <Tag color={CATEGORY_COLORS[detailModal.category] || 'default'}>
                {detailModal.category}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {detailModal.source_name}
              </Text>
              {detailModal.published_at && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {detailModal.published_at.slice(0, 16).replace('T', ' ')}
                </Text>
              )}
            </Space>

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

            {/* 学科关联 */}
            {detailModal.related_subjects?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Text strong style={{ fontSize: 13 }}>📐 {t('relatedSubjects')}</Text>
                <Space style={{ marginLeft: 8 }}>
                  {detailModal.related_subjects.map((subj: string) => (
                    <Tag
                      key={subj}
                      color="blue"
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        message.info(t('jumpToSubject', { subject: subj }));
                        // 可以跳转到课程或练习页面
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

            {/* 原文链接 */}
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
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
              {detailModal.points_awarded > 0 && (
                <Tag color="green" style={{ marginLeft: 'auto' }}>
                  {t('pointsAwarded', { points: detailModal.points_awarded })}
                </Tag>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* 今日简报 Drawer */}
      <Drawer
        title={t('dailyBriefingTitle')}
        placement="right"
        width={500}
        open={briefingOpen}
        onClose={() => { setBriefingOpen(false); stopBriefingPoll(); }}
      >
        {briefing ? (
          <div>
            <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
              {briefing.brief_content}
            </div>
            <div style={{ marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
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
