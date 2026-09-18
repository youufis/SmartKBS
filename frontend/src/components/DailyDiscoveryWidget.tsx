/** 每日精选 - 首页Widget */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Tag, Button, Space, Typography, Progress, Modal, message, Spin, Tooltip } from 'antd';
import {
  ReloadOutlined, HeartOutlined, HeartFilled,
  EyeOutlined, StarOutlined,
} from '@ant-design/icons';
import { useDiscoveryStore } from '../stores/discoveryStore';

const { Text, Paragraph } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '天文': 'purple', '科技': 'blue', '生物': 'green',
  '历史': 'orange', '人文': 'magenta', '自然': 'cyan',
  '地理': 'lime', '冷知识': 'gold',
};

const DailyDiscoveryWidget: React.FC = () => {
  const { t } = useTranslation('dashboard');
  const {
    cards, loading, stats, poolSize,
    loadFeed, refreshCards, toggleFavorite, recordView,
  } = useDiscoveryStore();

  const [detailCard, setDetailCard] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  const handleRefresh = async () => {
    if (stats.refreshRemaining <= 0) {
      message.warning(t('wd.refreshLimit'));
      return;
    }
    setRefreshing(true);
    try {
      await refreshCards();
      message.success(t('wd.refreshed'));
    } catch {
      message.error(t('wd.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  };

  const handleView = (card: any) => {
    setDetailCard(card);
    recordView(card.id);
  };

  const handleFavorite = (card: any) => {
    toggleFavorite(card.id, card.is_favorited);
  };

  const progressPercent = Math.round(
    (stats.pointsEarned / stats.pointsMax) * 100
  );

  return (
    <Card
      title={
        <Space>
          <StarOutlined style={{ color: '#faad14' }} />
          <span>{t('wd.title')}</span>
          <Tag color="default" style={{ fontSize: 11 }}>
            {t('wd.pool', { n: poolSize })}
          </Tag>
        </Space>
      }
      size="small"
      extra={
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined spin={refreshing} />}
          onClick={handleRefresh}
          disabled={refreshing || stats.refreshRemaining <= 0}
        >
          {t('wd.swap')}{stats.refreshRemaining > 0 ? `(${stats.refreshRemaining})` : `(${t('wd.used')})`}
        </Button>
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin />
        </div>
      ) : cards.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-secondary)' }}>
          {t('wd.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cards.map((card) => (
            <Card
              key={card.id}
              size="small"
              hoverable
              style={{ borderRadius: 8 }}
              styles={{ body: { padding: '10px 12px' } }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Space size={6} style={{ marginBottom: 4 }}>
                    <Text style={{ fontSize: 18 }}>{card.emoji}</Text>
                    <Tag color={CATEGORY_COLORS[card.category] || 'default'} style={{ fontSize: 10, lineHeight: '16px' }}>
                      {card.category}
                    </Tag>
                    {card.related_subject && (
                      <Tag style={{ fontSize: 10, lineHeight: '16px' }}>
                        📐 {card.related_subject}
                      </Tag>
                    )}
                  </Space>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{card.title}</div>
                  <Paragraph
                    ellipsis={{ rows: 2 }}
                    style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}
                  >
                    {card.summary}
                  </Paragraph>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <Tooltip title={t('wd.detail')}>
                  <Button type="text" size="small" icon={<EyeOutlined />}
                    onClick={() => handleView(card)}>
                    {t('wd.detailBtn')}
                  </Button>
                </Tooltip>
                <Tooltip title={card.is_favorited ? t('wd.unfav') : t('wd.fav')}>
                  <Button
                    type="text"
                    size="small"
                    icon={card.is_favorited ? <HeartFilled style={{ color: '#ff4d4f' }} /> : <HeartOutlined />}
                    onClick={() => handleFavorite(card)}
                  />
                </Tooltip>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 积分进度 */}
      <div style={{ marginTop: 10 }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('wd.points', { p: stats.pointsEarned, m: stats.pointsMax })}
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {t('wd.viewed', { n: stats.viewCount })}
          </Text>
        </Space>
        <Progress
          percent={progressPercent}
          size="small"
          strokeColor="#faad14"
          showInfo={false}
          style={{ margin: 0 }}
        />
      </div>

      {/* 详情 Modal */}
      <Modal
        title={
          <Space>
            <Text style={{ fontSize: 20 }}>{detailCard?.emoji}</Text>
            <span>{detailCard?.title}</span>
            <Tag color={CATEGORY_COLORS[detailCard?.category] || 'default'}>
              {detailCard?.category}
            </Tag>
          </Space>
        }
        open={!!detailCard}
        onCancel={() => setDetailCard(null)}
        footer={null}
        width={600}
      >
        {detailCard && (
          <div>
            <Paragraph style={{ fontSize: 15, lineHeight: 1.8 }}>
              {detailCard.detail}
            </Paragraph>
            <Space style={{ marginTop: 12 }}>
              {detailCard.source && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('wd.source')}{detailCard.source}
                </Text>
              )}
              {' · '}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('wd.funLevel')}：{'⭐'.repeat(detailCard.fun_level || 1)}
              </Text>
            </Space>
            {detailCard.tags?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {detailCard.tags.map((tag: string) => (
                  <Tag key={tag} style={{ fontSize: 11 }}>{tag}</Tag>
                ))}
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <Button
                icon={detailCard.is_favorited ? <HeartFilled /> : <HeartOutlined />}
                onClick={() => {
                  handleFavorite(detailCard);
                  setDetailCard({ ...detailCard, is_favorited: !detailCard.is_favorited });
                }}
              >
                {detailCard.is_favorited ? t('wd.faved') : t('wd.fav')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
};

export default DailyDiscoveryWidget;
