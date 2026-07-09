import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Card, Table, Select, Input, Tag, Space, Typography, Row, Col,
  Statistic, message, Button, Radio, Empty, Spin, Tabs,
} from 'antd';
import {
  ReloadOutlined, FileTextOutlined,
  CheckCircleOutlined, CloseCircleOutlined, BarChartOutlined,
  ExperimentOutlined, ThunderboltOutlined,
  CheckSquareOutlined, QuestionCircleOutlined, CodeOutlined,
  TeamOutlined, HighlightOutlined, BookOutlined, EyeOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import * as activityMonitorApi from '../api/activityMonitor';
import type {
  ActivityItem, StudentStatus, ActivityStatusDetail,
} from '../api/activityMonitor';
import { useAuthStore } from '../stores/authStore';
import ResourceViewStatsPage from './ResourceViewStatsPage';

const { Title, Text } = Typography;

const getActivityTypeOptions = (t: (key: string) => string) => [
  { value: 'all', label: t('activityMonitor.activityType.all') },
  { value: 'exam', label: t('activityMonitor.activityType.exam') },
  { value: 'practice', label: t('activityMonitor.activityType.practice') },
  { value: 'quick_quiz', label: t('activityMonitor.activityType.quickQuiz') },
  { value: 'task', label: t('activityMonitor.activityType.task') },
  { value: 'quiz', label: t('activityMonitor.activityType.quiz') },
  { value: 'code', label: t('activityMonitor.activityType.code') },
  { value: 'discussion', label: t('activityMonitor.activityType.discussion') },
  { value: 'poll', label: t('activityMonitor.activityType.poll') },
  { value: 'course', label: t('activityMonitor.activityType.course') },
];

const ACTIVITY_TYPE_ICONS: Record<string, React.ReactNode> = {
  exam: <FileTextOutlined />,
  practice: <ExperimentOutlined />,
  quick_quiz: <ThunderboltOutlined />,
  task: <CheckSquareOutlined />,
  quiz: <QuestionCircleOutlined />,
  code: <CodeOutlined />,
  discussion: <TeamOutlined />,
  poll: <HighlightOutlined />,
  course: <BookOutlined />,
};

const ACTIVITY_TYPE_COLORS: Record<string, string> = {
  exam: 'blue',
  practice: 'green',
  quick_quiz: 'purple',
  task: 'cyan',
  quiz: 'orange',
  code: 'red',
  discussion: 'geekblue',
  poll: 'gold',
  course: 'lime',
};

const getStatusLabels = (t: (key: string) => string): Record<string, string> => ({
  draft: t('activityMonitor.status.draft'),
  published: t('activityMonitor.status.published'),
  ended: t('activityMonitor.status.ended'),
  active: t('activityMonitor.status.active'),
  inactive: t('activityMonitor.status.inactive'),
  waiting: t('activityMonitor.status.waiting'),
  playing: t('activityMonitor.status.playing'),
  finished: t('activityMonitor.status.finished'),
  pending: t('activityMonitor.status.pending'),
});

const STATUS_COLORS: Record<string, string> = {
  draft: 'default',
  published: 'green',
  ended: 'red',
  active: 'processing',
  inactive: 'default',
  waiting: 'orange',
  playing: 'green',
  finished: 'red',
  pending: 'orange',
};

const ActivityMonitorPage: React.FC = () => {
  const user = useAuthStore((s) => s.user);
  const { t } = useTranslation('dashboard');
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher';

  // ── 活动列表状态 ──
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [activityType, setActivityType] = useState<string>('all');
  const [keyword, setKeyword] = useState('');

  // ── 年级班级筛选 ──
  const [gradeClasses, setGradeClasses] = useState<{ grade_id: number; grade_name: string; classes: { class_id: number; display_name: string }[] }[]>([]);
  const [selectedGradeId, setSelectedGradeId] = useState<number | undefined>();
  const [selectedClassId, setSelectedClassId] = useState<number | undefined>();

  // ── 活动详情状态 ──
  const [selectedActivity, setSelectedActivity] = useState<ActivityItem | null>(null);
  const [statusDetail, setStatusDetail] = useState<ActivityStatusDetail | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'incomplete'>('all');
  const [statusPage, setStatusPage] = useState(1);

  // ── 加载年级班级 ──
  useEffect(() => {
    if (!isTeacherOrAdmin) return;
    activityMonitorApi.getTeacherGradesClasses().then((res) => {
      setGradeClasses(res.grades);
    }).catch(() => {});
  }, [isTeacherOrAdmin]);

  // ── 刷新计数器（用于触发重新加载）──
  const [refreshKey, setRefreshKey] = useState(0);
  const handleRefresh = () => setRefreshKey((k) => k + 1);

  // ── 加载活动列表 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await activityMonitorApi.listActivities({
          activity_type: activityType as any,
          keyword: keyword || undefined,
          page,
          page_size: pageSize,
        });
        if (!cancelled) {
          setActivities(res.activities);
          setTotal(res.total);
        }
      } catch (err: any) {
        if (!cancelled) {
          // 加载失败时静默返回空列表
          setActivities([]);
          setTotal(0);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activityType, keyword, page, pageSize, refreshKey]);

  // ── 加载活动完成数据（仅当活动+年级+班级都选定时才请求）──
  const loadStatusData = async (
    activity: ActivityItem,
    gradeId?: number,
    classId?: number,
    filter: 'all' | 'completed' | 'incomplete' = 'all',
    p: number = 1
  ) => {
    if (!gradeId || !classId) return;
    setStatusLoading(true);
    try {
      const res = await activityMonitorApi.getActivityStatus(
        activity.activity_type as any,
        activity.id,
        { grade_id: gradeId, class_id: classId, status_filter: filter, page: p, page_size: 20 }
      );
      setStatusDetail(res);
      setStatusPage(p);
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('activityMonitor.loadStatusFailed'));
    } finally {
      setStatusLoading(false);
    }
  };

  // ── 选择活动：仅记录选中项，不自动请求（等待年级+班级）──
  const handleViewStatus = (activity: ActivityItem) => {
    setSelectedActivity(activity);
    setStatusDetail(null);
    setStatusPage(1);
    setStatusFilter('all');
    // 如果年级和班级已选定，直接加载
    if (selectedGradeId && selectedClassId) {
      loadStatusData(activity, selectedGradeId, selectedClassId);
    }
  };

  // ── 切换年级 ──
  const handleGradeChange = (gradeId: number | undefined) => {
    setSelectedGradeId(gradeId);
    setSelectedClassId(undefined);
    setStatusDetail(null);
  };

  // ── 切换班级 ──
  const handleClassChange = (classId: number | undefined) => {
    setSelectedClassId(classId);
    setStatusDetail(null);
    if (selectedActivity && selectedGradeId && classId) {
      loadStatusData(selectedActivity, selectedGradeId, classId);
    }
  };



  // ── 切换状态筛选 ──
  const handleStatusFilterChange = async (newFilter: 'all' | 'completed' | 'incomplete') => {
    if (!selectedActivity) return;
    setStatusFilter(newFilter);
    setStatusPage(1);
    if (selectedGradeId && selectedClassId) {
      loadStatusData(selectedActivity, selectedGradeId, selectedClassId, newFilter, 1);
    }
  };

  // ── 活动列表列定义 ──
  const activityColumns: ColumnsType<ActivityItem> = [
    {
      title: t('activityMonitor.columns.activityName'),
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (text: string, record: ActivityItem) => (
        <Space>
          {ACTIVITY_TYPE_ICONS[record.activity_type]}
          <Text strong>{text}</Text>
          <Tag color={ACTIVITY_TYPE_COLORS[record.activity_type]}>
            {getActivityTypeOptions(t).find(o => o.value === record.activity_type)?.label || record.activity_type}
          </Tag>
        </Space>
      ),
    },
    {
      title: t('activityMonitor.columns.subject'),
      dataIndex: 'subject',
      key: 'subject',
      width: 120,
      render: (v: string) => v || '-',
    },
    {
      title: t('activityMonitor.columns.creator'),
      dataIndex: 'creator_name',
      key: 'creator_name',
      width: 100,
      ellipsis: true,
    },
    {
      title: t('activityMonitor.columns.status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={STATUS_COLORS[status] || 'default'}>
          {getStatusLabels(t)[status] || status}
        </Tag>
      ),
    },
    {
      title: t('activityMonitor.columns.submitted'),
      dataIndex: 'submitted_count',
      key: 'submitted_count',
      width: 100,
      sorter: (a, b) => a.submitted_count - b.submitted_count,
      render: (count: number) => <Text strong>{count}</Text>,
    },
    {
      title: t('activityMonitor.columns.createdAt'),
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
    },
    {
      title: t('activityMonitor.columns.action'),
      key: 'action',
      width: 120,
      render: (_: any, record: ActivityItem) => (
        <Button
          type="primary"
          size="small"
          icon={<BarChartOutlined />}
          onClick={() => handleViewStatus(record)}
        >
          {t('activityMonitor.viewCompletion')}
        </Button>
      ),
    },
  ];

  // ── 学生状态列定义 ──
  const studentColumns: ColumnsType<StudentStatus> = [
    {
      title: t('activityMonitor.columns.index'),
      key: 'index',
      width: 60,
      render: (_: any, __: any, index: number) =>
        (statusPage - 1) * 20 + index + 1,
    },
    {
      title: t('activityMonitor.columns.name'),
      dataIndex: 'name',
      key: 'name',
      width: 120,
    },
    {
      title: t('activityMonitor.columns.grade'),
      dataIndex: 'grade',
      key: 'grade',
      width: 100,
    },
    {
      title: t('activityMonitor.columns.class'),
      dataIndex: 'class_name',
      key: 'class_name',
      width: 100,
    },
    {
      title: t('activityMonitor.columns.completionStatus'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) =>
        status === 'completed' ? (
          <Tag icon={<CheckCircleOutlined />} color="success">{t('activityMonitor.completed')}</Tag>
        ) : (
          <Tag icon={<CloseCircleOutlined />} color="error">{t('activityMonitor.incomplete')}</Tag>
        ),
    },
    {
      title: t('activityMonitor.columns.score'),
      dataIndex: 'score',
      key: 'score',
      width: 120,
      render: (score: number, record: StudentStatus) =>
        record.status === 'completed' ? (
          <Text strong style={{ color: score >= (statusDetail?.activity?.pass_score || 60) ? '#52c41a' : '#f5222d' }}>
            {score} / {record.total_score}
          </Text>
        ) : (
          <Text type="secondary">-</Text>
        ),
    },
    {
      title: t('activityMonitor.columns.submittedAt'),
      dataIndex: 'submitted_at',
      key: 'submitted_at',
      width: 170,
      render: (v: string) => v || '-',
    },
  ];

  const gradeOptions = gradeClasses.map(g => ({
    value: g.grade_id,
    label: g.grade_name,
  }));

  const classOptions = selectedGradeId
    ? (gradeClasses.find(g => g.grade_id === selectedGradeId)?.classes || []).map(c => ({
        value: c.class_id,
        label: c.display_name,
      }))
    : [];

  if (!isTeacherOrAdmin) {
    return (
      <Card>
        <Empty description={t('activityMonitor.restricted')} />
      </Card>
    );
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      <Tabs defaultActiveKey="activity" items={[
        {
          key: 'activity',
          label: <span><BarChartOutlined />{t('activityMonitor.tabActivity')}</span>,
          children: (<>
      <Title level={4} style={{ marginBottom: 16 }}>
        <BarChartOutlined /> {t('activityMonitor.title')}
      </Title>

      {/* ── 顶部筛选栏 ── */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]} align="middle">
          <Col>
            <Text strong>{t('activityMonitor.filters.activityType')}</Text>
            <Select
              value={activityType}
              onChange={(v) => { setActivityType(v); setPage(1); }}
              style={{ width: 140 }}
              options={getActivityTypeOptions(t)}
            />
          </Col>
          <Col>
            <Text strong>{t('activityMonitor.filters.grade')}</Text>
            <Select
              allowClear
              placeholder={t('activityMonitor.filters.selectGrade')}
              value={selectedGradeId}
              onChange={handleGradeChange}
              style={{ width: 120 }}
              options={gradeOptions}
            />
          </Col>
          <Col>
            <Text strong>{t('activityMonitor.filters.class')}</Text>
            <Select
              allowClear
              placeholder={t('activityMonitor.filters.selectClass')}
              value={selectedClassId}
              onChange={handleClassChange}
              style={{ width: 120 }}
              options={classOptions}
              disabled={!selectedGradeId}
            />
          </Col>
          <Col flex="auto">
            <Input.Search
              placeholder={t('activityMonitor.filters.searchActivity')}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onSearch={() => { setPage(1); handleRefresh(); }}
              style={{ maxWidth: 250 }}
              enterButton
            />
          </Col>
          <Col>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh}>{t('activityMonitor.refresh')}</Button>
          </Col>
        </Row>
      </Card>

      {/* ── 活动列表 ── */}
      <Card title={t('activityMonitor.activityList')} size="small" style={{ marginBottom: 16 }}>
        <Table
          dataSource={activities}
          columns={activityColumns}
          rowKey={(r) => `${r.activity_type}-${r.id}`}
          loading={loading}
          size="small"
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (total) => t('activityMonitor.pagination.totalActivities', { count: total }),
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
        />
      </Card>

      {/* ── 活动完成详情 ── */}
      {selectedActivity && (
        <Card
          title={
            <Space>
              <span>{t('activityMonitor.completionDetail')}{selectedActivity.title}</span>
              <Tag color={ACTIVITY_TYPE_COLORS[selectedActivity.activity_type]}>
                {getActivityTypeOptions(t).find(o => o.value === selectedActivity.activity_type)?.label}
              </Tag>
            </Space>
          }
          size="small"
          extra={
            <Button size="small" onClick={() => { setSelectedActivity(null); setStatusDetail(null); }}>
              {t('activityMonitor.close')}
            </Button>
          }
        >
          {!selectedGradeId || !selectedClassId ? (
            /* ── 未选定年级/班级时提示 ── */
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
              <BarChartOutlined style={{ fontSize: 48, marginBottom: 16 }} />
              <div>{t('activityMonitor.selectHint')}</div>
            </div>
          ) : statusLoading ? (
            /* ── 加载中 ── */
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Spin />
              <div style={{ marginTop: 8, color: '#999' }}>{t('activityMonitor.loading')}</div>
            </div>
          ) : statusDetail ? (
            /* ── 有数据时 ── */
            <>
              {/* 统计概览 */}
              <Row gutter={24} style={{ marginBottom: 16 }}>
                <Col span={4}>
                  <Statistic title={t('activityMonitor.stats.totalStudents')} value={statusDetail.statistics.total_students} suffix={t('activityMonitor.stats.personSuffix')} />
                </Col>
                <Col span={4}>
                  <Statistic title={t('activityMonitor.stats.completed')} value={statusDetail.statistics.completed_count} suffix={t('activityMonitor.stats.personSuffix')} styles={{ content: { color: '#52c41a' } }} />
                </Col>
                <Col span={4}>
                  <Statistic title={t('activityMonitor.stats.incomplete')} value={statusDetail.statistics.incomplete_count} suffix={t('activityMonitor.stats.personSuffix')} styles={{ content: { color: '#f5222d' } }} />
                </Col>
                <Col span={4}>
                  <Statistic title={t('activityMonitor.stats.completionRate')} value={statusDetail.statistics.completion_rate} suffix="%" precision={1} />
                </Col>
                <Col span={4}>
                  <Statistic title={t('activityMonitor.stats.avgScore')} value={statusDetail.statistics.avg_score} precision={1} />
                </Col>
              </Row>

              {/* 状态筛选 */}
              <Space style={{ marginBottom: 12 }}>
                <Text strong>{t('activityMonitor.filter')}</Text>
                <Radio.Group
                  value={statusFilter}
                  onChange={(e) => handleStatusFilterChange(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                >
                  <Radio.Button value="all">{t('activityMonitor.all')}</Radio.Button>
                  <Radio.Button value="completed"><CheckCircleOutlined /> {t('activityMonitor.completed')}</Radio.Button>
                  <Radio.Button value="incomplete"><CloseCircleOutlined /> {t('activityMonitor.incomplete')}</Radio.Button>
                </Radio.Group>
              </Space>

              {/* 学生列表 */}
              <Table
                dataSource={statusDetail.students}
                columns={studentColumns}
                rowKey="username"
                size="small"
                pagination={{
                  current: statusDetail.page,
                  pageSize: statusDetail.page_size,
                  total: statusDetail.total,
                  showSizeChanger: true,
                  showTotal: (total) => t('activityMonitor.pagination.totalStudents', { count: total }),
                  onChange: (p) => {
                    setStatusPage(p);
                    if (selectedActivity && selectedGradeId && selectedClassId) {
                      loadStatusData(selectedActivity, selectedGradeId, selectedClassId, statusFilter, p);
                    }
                  },
                }}
              />
            </>
          ) : null}
        </Card>
      )}
        </>),
        },
        {
          key: 'resource-views',
          label: <span><EyeOutlined />{t('activityMonitor.tabResourceViews')}</span>,
          children: <ResourceViewStatsPage />,
        },
      ]} />
    </Card>
  );
};

export default ActivityMonitorPage;
