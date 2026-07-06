/** 热点新闻 - 独立页面 */
import React, { useEffect, useState } from 'react';
import {
  Card, List, Tag, Button, Space, Typography, Progress,
  message, Spin, Modal, Drawer, Tabs, Empty, Tooltip,
} from 'antd';
import {
  GlobalOutlined, ReloadOutlined, HeartOutlined, HeartFilled,
  EyeOutlined, ArrowLeftOutlined, BookOutlined, RightOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useNewsStore } from '../stores/newsStore';
import { useAuthStore } from '../stores/authStore';

const { Text, Paragraph, Title } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '国内': 'red', '国际': 'blue', '科技': 'cyan',
  '教育': 'green', '体育': 'orange', '财经': 'gold', '娱乐': 'purple',
};

const NewsHubPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const isTeacherOrAdmin = user?.role === 'teacher' || user?.role === 'admin';
  const {
    articles, categories, loading, stats,
    loadList, loadCategories, getDetail, toggleFavorite, loadStats,
  } = useNewsStore();

  const [activeCategory, setActiveCategory] = useState<string>('');
  const [detailModal, setDetailModal] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [briefing, setBriefing] = useState<any>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);
  const tabsItems = [
    { key: 'feed', label: '新闻列表' },
    { key: 'briefing', label: '今日简报' },
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
      message.error('加载新闻详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleToggleFavorite = async (newsId: number, isFav: boolean) => {
    await toggleFavorite(newsId, isFav);
    // 刷新列表更新收藏状态
    loadList(activeCategory, page);
  };

  const handleRefresh = () => {
    message.info('正在后台刷新新闻列表...');
    loadList(activeCategory, 1);
    loadStats();
  };

  const handleOpenBriefing = async () => {
    setBriefingOpen(true);
    if (!briefing) {
      try {
        const { getDailyBriefing } = await import('../api/news');
        const data = await getDailyBriefing();
        setBriefing(data);
      } catch {
        message.error('生成简报失败');
      }
    }
  };

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
            <Text strong style={{ fontSize: 16 }}>热点新闻</Text>
          </Space>
          <Space>
            {isTeacherOrAdmin && (
              <Button size="small" onClick={handleOpenBriefing}>
                📋 今日简报
              </Button>
            )}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={handleRefresh}
            >
              刷新
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
            全部
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
            📊 今日已读 {stats.todayViews} 篇，获得 {stats.todayPoints}/{stats.pointsMax} 积分
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            累计阅读 {stats.totalViews} 篇
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
          <Empty description="暂无新闻，点击刷新获取最新资讯" style={{ padding: 40 }} />
        ) : (
          <List
            dataSource={articles}
            renderItem={(item) => (
              <List.Item
                style={{ cursor: 'pointer', padding: '12px 16px' }}
                onClick={() => handleViewDetail(item.id)}
                actions={[
                  <Tooltip title={item.is_favorited ? '取消收藏' : '收藏'}>
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
                          <EyeOutlined /> 已读
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
                <Text strong style={{ fontSize: 13 }}>💡 一句话精要：</Text>
                <Paragraph style={{ margin: '4px 0 0', fontSize: 14 }}>
                  {detailModal.ai_one_liner}
                </Paragraph>
              </Card>
            )}
            {detailModal.ai_summary && (
              <Card size="small" style={{ marginBottom: 12, background: '#f6f8fa' }}>
                <Text strong style={{ fontSize: 13 }}>📝 AI摘要：</Text>
                <Paragraph style={{ margin: '4px 0 0', fontSize: 14 }}>
                  {detailModal.ai_summary}
                </Paragraph>
              </Card>
            )}

            {/* 学科关联 */}
            {detailModal.related_subjects?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Text strong style={{ fontSize: 13 }}>📐 关联学科：</Text>
                <Space style={{ marginLeft: 8 }}>
                  {detailModal.related_subjects.map((subj: string) => (
                    <Tag
                      key={subj}
                      color="blue"
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        message.info(`即将跳转到「${subj}」相关学习资源`);
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
                阅读原文
              </Button>
              <Button
                icon={detailModal.is_favorited ? <HeartFilled /> : <HeartOutlined />}
                onClick={() => {
                  const newFav = !detailModal.is_favorited;
                  handleToggleFavorite(detailModal.id, detailModal.is_favorited);
                  setDetailModal({ ...detailModal, is_favorited: newFav });
                }}
              >
                {detailModal.is_favorited ? '已收藏' : '收藏'}
              </Button>
              {detailModal.points_awarded > 0 && (
                <Tag color="green" style={{ marginLeft: 'auto' }}>
                  +{detailModal.points_awarded} 积分
                </Tag>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* 今日简报 Drawer */}
      <Drawer
        title="📋 今日要闻简报"
        placement="right"
        width={500}
        open={briefingOpen}
        onClose={() => setBriefingOpen(false)}
      >
        {briefing ? (
          <div>
            <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
              {briefing.brief_content}
            </div>
            <div style={{ marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
              <Text type="secondary">
                共 {briefing.article_count} 篇新闻 · 生成于 {briefing.generated_at?.slice(0, 16)}
              </Text>
            </div>
          </div>
        ) : (
          <Spin />
        )}
      </Drawer>
    </Card>
  );
};

export default NewsHubPage;
