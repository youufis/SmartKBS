/** 热点新闻 - 首页Widget */
import React, { useEffect } from 'react';
import { Card, Tag, Button, Space, Typography, List, Spin, Progress } from 'antd';
import { GlobalOutlined, RightOutlined, EyeOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useNewsStore } from '../stores/newsStore';

const { Text } = Typography;

const CATEGORY_COLORS: Record<string, string> = {
  '国内': 'red', '国际': 'blue', '科技': 'cyan',
  '教育': 'green', '体育': 'orange', '财经': 'gold', '娱乐': 'purple',
};

const NewsWidget: React.FC = () => {
  const navigate = useNavigate();
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
          <span>热点快讯</span>
        </Space>
      }
      size="small"
      extra={
        <Button type="link" size="small" onClick={() => navigate('/news-hub')}>
          查看全部 <RightOutlined />
        </Button>
      }
    >
      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin />
        </div>
      ) : (
        <List
          size="small"
          dataSource={articles.slice(0, 3)}
          renderItem={(item) => (
            <List.Item
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/news-hub?id=${item.id}`)}
            >
              <List.Item.Meta
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
                        <EyeOutlined /> 已读
                      </Text>
                    )}
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}

      {/* 积分进度 */}
      {stats.pointsMax > 0 && (
        <div style={{ marginTop: 8 }}>
          <Space style={{ width: '100%', justifyContent: 'space-between' }}>
            <Text type="secondary" style={{ fontSize: 11 }}>
              今日已获 {stats.todayPoints}/{stats.pointsMax} 积分
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
