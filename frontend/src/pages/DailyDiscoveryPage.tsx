/** 每日精选 - 独立页面 */
import React, { useEffect, useState } from 'react';
import {
  Card, Row, Col, Tag, Button, Space, Typography,
  Progress, message, Spin, Modal, Tooltip, Empty,
} from 'antd';
import {
  ReloadOutlined, HeartOutlined, HeartFilled,
  EyeOutlined, StarOutlined, ArrowLeftOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useDiscoveryStore } from '../stores/discoveryStore';
import { useTranslation } from 'react-i18next'

const { Text, Paragraph, Title } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '天文': 'purple', '科技': 'blue', '生物': 'green',
  '历史': 'orange', '人文': 'magenta', '自然': 'cyan',
  '地理': 'lime', '冷知识': 'gold',
};

const DailyDiscoveryPage: React.FC = () => {
  const { t } = useTranslation('common')
  const navigate = useNavigate();
  const {
    cards, favorites, loading, stats, poolSize,
    loadFeed, refreshCards, toggleFavorite, recordView, loadFavorites,
  } = useDiscoveryStore();

  const [detailCard, setDetailCard] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'feed' | 'favorites'>('feed');
  const [refreshing, setRefreshing] = useState(false);

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
    setRefreshing(true);
    try {
      await refreshCards();
      message.success(t('refreshed'));
    } catch (e: any) {
      message.error(e?.response?.data?.detail || t('refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleView = (card: any) => {
    setDetailCard(card);
    recordView(card.id);
  };

  const handleFavorite = async (card: any) => {
    await toggleFavorite(card.id, card.is_favorited);
    if (activeTab === 'favorites') {
      loadFavorites();
    }
  };

  const renderCard = (card: any) => (
    <Col xs={24} sm={12} lg={8} key={card.id}>
      <Card
        hoverable
        style={{ borderRadius: 10, height: '100%' }}
        styles={{ body: { padding: 16, display: 'flex', flexDirection: 'column', height: '100%' } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Text style={{ fontSize: 24 }}>{card.emoji}</Text>
          <Tag color={CATEGORY_COLORS[card.category] || 'default'}>
            {card.category}
          </Tag>
          {card.related_subject && (
            <Tag color="blue" style={{ fontSize: 11 }}>
              📐 {card.related_subject}
            </Tag>
          )}
        </div>
        <Title level={5} style={{ margin: '0 0 6px 0' }}>{card.title}</Title>
        <Paragraph
          ellipsis={{ rows: 3 }}
          style={{ fontSize: 13, color: '#555', flex: 1, margin: 0 }}
        >
          {card.summary}
        </Paragraph>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, paddingTop: 10, borderTop: '1px solid #f0f0f0' }}>
          <Tooltip title={t('viewDetail')}>
            <Button size="small" icon={<EyeOutlined />} onClick={() => handleView(card)}>
              {t('detail')}
            </Button>
          </Tooltip>
          <Tooltip title={card.is_favorited ? t('unfavorite') : t('favorite')}>
            <Button
              size="small"
              icon={card.is_favorited ? <HeartFilled style={{ color: '#ff4d4f' }} /> : <HeartOutlined />}
              onClick={() => handleFavorite(card)}
            />
          </Tooltip>
          <div style={{ flex: 1 }} />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {'⭐'.repeat(card.fun_level || 1)}
          </Text>
        </div>
      </Card>
    </Col>
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
            <StarOutlined style={{ color: '#faad14', fontSize: 18 }} />
            <Text strong style={{ fontSize: 16 }}>{t('dailyDiscovery')}</Text>
            <Tag>{t('knowledgePool', { count: poolSize })}</Tag>
          </Space>
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
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              onClick={handleRefresh}
              disabled={refreshing || stats.refreshRemaining <= 0}
            >
              {t('refreshBatch', { count: stats.refreshRemaining })}
            </Button>
          </Space>
        </div>
      </Card>

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
        <Progress
          percent={Math.round((stats.pointsEarned / stats.pointsMax) * 100)}
          strokeColor="#faad14"
          size="small"
          format={() => `${stats.pointsEarned}/${stats.pointsMax}`}
        />
      </Card>

      {/* 内容区 */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" />
        </div>
      ) : activeTab === 'feed' ? (
        cards.length === 0 ? (
          <Empty description={t('noDiscoveryContent')} />
        ) : (
          <Row gutter={[16, 16]}>
            {cards.map(renderCard)}
          </Row>
        )
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
            <Tag color={CATEGORY_COLORS[detailCard?.category] || 'default'}>
              {detailCard?.category}
            </Tag>
          </Space>
        }
        open={!!detailCard}
        onCancel={() => setDetailCard(null)}
        footer={null}
        width={640}
      >
        {detailCard && (
          <div>
            <Paragraph style={{ fontSize: 15, lineHeight: 2, whiteSpace: 'pre-wrap' }}>
              {detailCard.detail}
            </Paragraph>
            <Space style={{ marginTop: 12 }}>
              {detailCard.source && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('sourceFrom', { source: detailCard.source })}
                </Text>
              )}
              {detailCard.source && <Text type="secondary">·</Text>}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('funLevel')}{'⭐'.repeat(detailCard.fun_level || 1)}
              </Text>
            </Space>
            {detailCard.tags?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {detailCard.tags.map((tag: string) => (
                  <Tag key={tag} style={{ fontSize: 11 }}>{tag}</Tag>
                ))}
              </div>
            )}
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <Button
                icon={detailCard.is_favorited ? <HeartFilled /> : <HeartOutlined />}
                onClick={() => {
                  handleFavorite(detailCard);
                  setDetailCard({ ...detailCard, is_favorited: !detailCard.is_favorited });
                }}
              >
                {detailCard.is_favorited ? t('favorited') : t('favorite')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
};

export default DailyDiscoveryPage;
