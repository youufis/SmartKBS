/** 每日精选 - 独立页面 */
import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Tag, Button, Space, Typography, Spin, Modal, Tooltip, Empty, Result } from 'antd'
import { message } from '../utils/feedback';
import {
  ReloadOutlined, HeartOutlined, HeartFilled,
  EyeOutlined, StarOutlined, DownloadOutlined,
  LeftOutlined, RightOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useDiscoveryStore } from '../stores/discoveryStore';
import { getPosterBlob } from '../api/dailyDiscovery';
import type { DiscoveryCard } from '../api/dailyDiscovery';
import { useTranslation } from 'react-i18next'
import { useIsMobile } from '../hooks/useIsMobile'
import PageHeader from '../components/PageHeader'
import DailyPointsBar from '../components/DailyPointsBar'
import { relativeTime } from '../utils/relativeTime'

const { Text, Paragraph, Title } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '天文': 'purple', '科技': 'blue', '生物': 'green',
  '历史': 'orange', '人文': 'magenta', '自然': 'cyan',
  '地理': 'lime', '冷知识': 'gold',
};

const stars = (n: number) => '⭐'.repeat(Math.min(5, Math.max(1, n || 1)));

const DailyDiscoveryPage: React.FC = () => {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const {
    cards, favorites, loading, error, refreshing, stats, poolSize,
    loadFeed, refreshCards, toggleFavorite, recordView, loadFavorites,
  } = useDiscoveryStore();

  const [detailCard, setDetailCard] = useState<DiscoveryCard | null>(null);
  const [activeTab, setActiveTab] = useState<'feed' | 'favorites'>('feed');
  // 本次会话内点开过的卡片（服务端 viewed_today 只在 feed 响应里带，翻页/收藏态就地补）
  const [viewedIds, setViewedIds] = useState<Set<number>>(new Set());
  const [posterBusy, setPosterBusy] = useState(false);

  useEffect(() => {
    loadFeed();
    loadFavorites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = async () => {
    if (stats.refreshRemaining <= 0) {
      message.warning(t('refreshLimitReached'))
      return;
    }
    try {
      await refreshCards();
      message.success(t('refreshed'));
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      message.error((typeof d === 'string' && d) || t('refreshFailed'));
    }
  };

  const handleView = (card: DiscoveryCard) => {
    setDetailCard(card);
    recordView(card.id).then((p) => {
      if (p > 0) {
        message.success(t('discPointsToast', { p }));
        setViewedIds((s) => new Set(s).add(card.id));
      }
    });
  };

  const handleFavorite = async (card: DiscoveryCard) => {
    await toggleFavorite(card.id, !!card.is_favorited);
    setDetailCard((d) => (d && d.id === card.id ? { ...d, is_favorited: !card.is_favorited } : d));
  };

  const handlePoster = async (card: DiscoveryCard) => {
    setPosterBusy(true);
    try {
      const blob = await getPosterBlob(card.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'discovery_' + card.id + '.png';
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      message.error(t('discPosterFail'));
    } finally {
      setPosterBusy(false);
    }
  };

  // 详情上一条/下一条（在当前 tab 的列表里走）
  const sourceList = activeTab === 'favorites' ? favorites : cards;
  const curIdx = detailCard ? sourceList.findIndex((c) => c.id === detailCard.id) : -1;
  const gotoRelative = (delta: number) => {
    const next = curIdx >= 0 ? sourceList[curIdx + delta] : undefined;
    if (next) handleView(next);
  };

  const renderCard = (card: DiscoveryCard) => {
    const viewed = viewedIds.has(card.id) || !!card.viewed_today;
    return (
      <Col xs={24} sm={12} lg={8} key={card.id}>
        <Card
          hoverable
          onClick={() => handleView(card)}
          style={{ borderRadius: 10, height: '100%', opacity: viewed ? 0.78 : 1 }}
          styles={{ body: { padding: 16, display: 'flex', flexDirection: 'column', height: '100%' } }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <Text style={{ fontSize: 24 }}>{card.emoji}</Text>
            <Tag color={CATEGORY_COLORS[card.category] || 'default'}>
              {card.category}
            </Tag>
            {card.related_subject && (
              <Tag color="blue" style={{ fontSize: 11 }}>
                📐 {card.related_subject}
              </Tag>
            )}
            {viewed && (
              <Tag style={{ fontSize: 11 }} icon={<EyeOutlined />}>{t('discReadTag')}</Tag>
            )}
          </div>
          <Title level={5} style={{ margin: '0 0 6px 0' }}>{card.title}</Title>
          <Paragraph
            ellipsis={{ rows: 3 }}
            style={{ fontSize: 13, color: '#555', flex: 1, margin: 0 }}
          >
            {card.summary}
          </Paragraph>
          {activeTab === 'favorites' && card.favorited_at && (
            <Text type="secondary" style={{ fontSize: 11, marginTop: 6 }}>
              {t('discFavAt', { time: relativeTime(card.favorited_at) })}
            </Text>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-color)' }}>
            <Tooltip title={t('viewDetail')}>
              <Button size="small" icon={<EyeOutlined />} onClick={(e) => { e.stopPropagation(); handleView(card); }}>
                {t('detail')}
              </Button>
            </Tooltip>
            <Tooltip title={card.is_favorited ? t('unfavorite') : t('favorite')}>
              <Button
                size="small"
                icon={card.is_favorited ? <HeartFilled style={{ color: '#ff4d4f' }} /> : <HeartOutlined />}
                onClick={(e) => { e.stopPropagation(); void handleFavorite(card); }}
              />
            </Tooltip>
            <div style={{ flex: 1 }} />
            <Text type="secondary" style={{ fontSize: 11 }}>
              {stars(card.fun_level)}
            </Text>
          </div>
        </Card>
      </Col>
    );
  };

  const refreshBtn = (
    <Button
      icon={<ReloadOutlined spin={refreshing} />}
      onClick={handleRefresh}
      disabled={refreshing || stats.refreshRemaining <= 0}
    >
      {t('refreshBatch', { count: stats.refreshRemaining })}
    </Button>
  );

  return (
    <Card style={{ borderRadius: 8 }}>
      {/* 顶部栏 */}
      <PageHeader
        icon={<StarOutlined />}
        title={
          <Space size={8}>
            <span>{t('dailyDiscovery')}</span>
            <Tag>{t('knowledgePool', { count: poolSize })}</Tag>
          </Space>
        }
        extra={
          <Space>
            <Button
              type={activeTab === 'feed' ? 'primary' : 'default'}
              size="small"
              onClick={() => setActiveTab('feed')}
            >
              {t('recommended')}
            </Button>
            <Button
              type={activeTab === 'favorites' ? 'primary' : 'default'}
              size="small"
              onClick={() => {
                setActiveTab('favorites');
                if (activeTab !== 'favorites') loadFavorites();
              }}
            >
              {t('myFavorites', { count: favorites.length })}
            </Button>
            {stats.refreshRemaining > 0
              ? refreshBtn
              : <Tooltip title={t('discRefreshTomorrow')}>{<span>{refreshBtn}</span>}</Tooltip>}
          </Space>
        }
      />

      {/* 积分进度条 */}
      <Card size="small" style={{ marginBottom: 16, borderRadius: 8 }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Text type="secondary">
            {t('todayViewedStats', { viewCount: stats.viewCount, pointsEarned: stats.pointsEarned, pointsMax: stats.pointsMax })}
          </Text>
          <Text type="secondary">
            {t('refreshChanceRemaining', { count: stats.refreshRemaining })}
          </Text>
        </Space>
        <DailyPointsBar earned={stats.pointsEarned} max={stats.pointsMax}
          tip={t('discPointsRule', { max: stats.pointsMax })} />
      </Card>

      {/* 内容区 */}
      {error && cards.length === 0 ? (
        <Result
          status="warning"
          title={t('discErrorTitle')}
          extra={<Button type="primary" onClick={() => loadFeed()}>{t('retry')}</Button>}
        />
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" />
        </div>
      ) : activeTab === 'feed' ? (
        <div style={{ position: 'relative' }}>
          {refreshing && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 5, borderRadius: 10,
              background: 'rgba(255,255,255,0.68)', display: 'flex',
              flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12,
            }}>
              <Spin size="large" />
              <Text type="secondary">{t('discRefreshing')}</Text>
            </div>
          )}
          {cards.length === 0 ? (
            <Empty description={t('noDiscoveryContent')} />
          ) : (
            <Row gutter={[16, 16]}>
              {cards.map(renderCard)}
            </Row>
          )}
        </div>
      ) : (
        favorites.length === 0 ? (
          <Empty description={t('noFavorites')} />
        ) : (
          <Row gutter={[16, 16]}>
            {favorites.map(renderCard)}
          </Row>
        )
      )}

      {/* 详情 Modal */}
      <Modal
        title={
          <Space>
            <Text style={{ fontSize: 24 }}>{detailCard?.emoji}</Text>
            <span>{detailCard?.title}</span>
            <Tag color={CATEGORY_COLORS[detailCard?.category ?? ''] || 'default'}>
              {detailCard?.category}
            </Tag>
          </Space>
        }
        open={!!detailCard}
        onCancel={() => setDetailCard(null)}
        footer={null}
        width={isMobile ? '94vw' : 640}
      >
        {detailCard && (
          <div>
            <div style={{ fontSize: 15, lineHeight: 1.9 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{detailCard.detail || detailCard.summary}</ReactMarkdown>
            </div>
            <Space style={{ marginTop: 12 }} wrap>
              {detailCard.source && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('sourceFrom', { source: detailCard.source })}
                </Text>
              )}
              {detailCard.source && <Text type="secondary">·</Text>}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('funLevel')}{stars(detailCard.fun_level)}
              </Text>
            </Space>
            {detailCard.tags?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {detailCard.tags.map((tag: string) => (
                  <Tag key={tag} style={{ fontSize: 11 }}>{tag}</Tag>
                ))}
              </div>
            )}
            <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Button
                icon={detailCard.is_favorited ? <HeartFilled /> : <HeartOutlined />}
                onClick={() => { void handleFavorite(detailCard); }}
              >
                {detailCard.is_favorited ? t('favorited') : t('favorite')}
              </Button>
              <Button icon={<DownloadOutlined />} loading={posterBusy}
                onClick={() => { void handlePoster(detailCard); }}>
                {t('discPosterBtn')}
              </Button>
              <div style={{ flex: 1 }} />
              <Button size="small" icon={<LeftOutlined />} disabled={curIdx <= 0}
                onClick={() => gotoRelative(-1)}>
                {t('prevArticle')}
              </Button>
              <Button size="small" icon={<RightOutlined />} iconPosition="end"
                disabled={curIdx < 0 || curIdx >= sourceList.length - 1}
                onClick={() => gotoRelative(1)}>
                {t('nextArticle')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
};

export default DailyDiscoveryPage;
