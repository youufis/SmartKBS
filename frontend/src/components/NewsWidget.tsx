/** 热点新闻 - 首页Widget */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Tag, Button, Space, Typography, Spin, Progress } from 'antd';
import { GlobalOutlined, RightOutlined, EyeOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useNewsStore } from '../stores/newsStore';
import { RowList, RowItem } from './RowList'

const { Text } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '国内': 'red', '国际': 'blue', '科技': 'cyan',
  '教育': 'green', '体育': 'orange', '财经': 'gold', '娱乐': 'purple',
};

const NewsWidget: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation('dashboard');
  const { articles, loading, stats, loadList, loadStats } = useNewsStore();

  useEffect(() => {
    loadList(undefined, 1);
    loadStats();
  }, []);

  return (
    <Card
      title={
        <Space>
          <GlobalOutlined style={{ color: '#1677ff' }} />
          <span>{t('wn.title')}</span>
        </Space>
      }
      size="small"
      extra={
        <Button type="link" size="small" onClick={() => navigate('/news-hub')}>
          {t('viewAll')} <RightOutlined />
        </Button>
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin />
        </div>
      ) : (
        <RowList
          items={articles.slice(0, 3)}
          renderItem={(item) => (
            <RowItem
              dense
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/news-hub?id=${item.id}`)}
              title={
                  <Space size={4}>
                    <Tag color={CATEGORY_COLORS[item.category] || 'default'}
                      style={{ fontSize: 10, lineHeight: '16px' }}>
                      {item.category}
                    </Tag>
                    <Text style={{ fontSize: 13 }} ellipsis={{ tooltip: item.title }}>
                      {item.title}
                    </Text>
                  </Space>
                }
                description={
                  <Space size={12}>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {item.source_name}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {item.published_at ? item.published_at.slice(0, 10) : ''}
                    </Text>
                    {item.is_viewed && (
                      <Text type="secondary" style={{ fontSize: 11 }}>
                        <EyeOutlined /> {t('wn.viewed')}
                      </Text>
                    )}
                  </Space>
                }
            />
          )}
        />
      )}

      {/* 积分进度 */}
      {stats.pointsMax > 0 && (
        <div style={{ marginTop: 8 }}>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {t('wn.points', { p: stats.todayPoints, m: stats.pointsMax })}
            </Text>
          </Space>
          <Progress
            percent={Math.round((stats.todayPoints / stats.pointsMax) * 100)}
            size="small"
            strokeColor="#1677ff"
            showInfo={false}
          />
        </div>
      )}
    </Card>
  );
};

export default NewsWidget;
