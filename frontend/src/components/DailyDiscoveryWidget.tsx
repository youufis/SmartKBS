/** 每日精选 - 首页Widget */
import React, { useEffect, useState } from 'react';
import { Card, Tag, Button, Space, Typography, Progress, Modal, message, Spin, Tooltip } from 'antd';
import {
  ReloadOutlined, HeartOutlined, HeartFilled,
  EyeOutlined, ZoomInOutlined, StarOutlined,
} from '@ant-design/icons';
import { useDiscoveryStore } from '../stores/discoveryStore';

const { Text, Paragraph, Title } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '天文': 'purple', '科技': 'blue', '生物': 'green',
  '历史': 'orange', '人文': 'magenta', '自然': 'cyan',
  '地理': 'lime', '冷知识': 'gold',
};

const DailyDiscoveryWidget: React.FC = () => {
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
      message.warning('今日刷新次数已用完');
      return;
    }
    setRefreshing(true);
    try {
      await refreshCards();
      message.success('已为你刷新一批新知识 ✨');
    } catch {
      message.error('刷新失败，请稍后重试');
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
          <span>每日精选</span>
          <Tag color="default" style={{ fontSize: 11 }}>
            知识池 {poolSize} 条
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
          换一批{stats.refreshRemaining > 0 ? `(${stats.refreshRemaining})` : '(已用完)'}
        </Button>
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin />
        </div>
      ) : cards.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0', color: '#999' }}>
          暂无精选内容，点击"换一批"生成
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
                    style={{ fontSize: 12, color: '#666', margin: 0 }}
                  >
                    {card.summary}
                  </Paragraph>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <Tooltip title="查看详情">
                  <Button type="text" size="small" icon={<EyeOutlined />}
                    onClick={() => handleView(card)}>
                    详情
                  </Button>
                </Tooltip>
                <Tooltip title={card.is_favorited ? '取消收藏' : '收藏'}>
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
            今日已获 {stats.pointsEarned}/{stats.pointsMax} 积分
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            已看 {stats.viewCount} 条
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
                  来源：{detailCard.source}
                </Text>
              )}
              {' · '}
              <Text type="secondary" style={{ fontSize: 12 }}>
                趣味等级：{'⭐'.repeat(detailCard.fun_level || 1)}
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
                {detailCard.is_favorited ? '已收藏' : '收藏'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
};

export default DailyDiscoveryWidget;
