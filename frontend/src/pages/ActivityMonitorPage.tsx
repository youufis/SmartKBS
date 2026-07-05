import React, { useState, useEffect } from 'react';
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

const ACTIVITY_TYPE_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'exam', label: '考试' },
  { value: 'practice', label: '智能练习' },
  { value: 'quick_quiz', label: '知识抢答' },
  { value: 'task', label: '在线任务' },
  { value: 'quiz', label: '随堂测验' },
  { value: 'code', label: '代码练习' },
  { value: 'discussion', label: '分组讨论' },
  { value: 'poll', label: '快速投票' },
  { value: 'course', label: '课程练习' },
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

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  ended: '已结束',
  active: '进行中',
  inactive: '已停用',
  waiting: '等待中',
  playing: '进行中',
  finished: '已结束',
  pending: '待开始',
};

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
          message.error(err?.response?.data?.detail || '加载活动列表失败');
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
      message.error(err?.response?.data?.detail || '加载完成情况失败');
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
      title: '活动名称',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (text: string, record: ActivityItem) => (
        <Space>
          {ACTIVITY_TYPE_ICONS[record.activity_type]}
          <Text strong>{text}</Text>
          <Tag color={ACTIVITY_TYPE_COLORS[record.activity_type]}>
            {ACTIVITY_TYPE_OPTIONS.find(o => o.value === record.activity_type)?.label || record.activity_type}
          </Tag>
        </Space>
      ),
    },
    {
      title: '科目',
      dataIndex: 'subject',
      key: 'subject',
      width: 120,
      render: (v: string) => v || '-',
    },
    {
      title: '发布者',
      dataIndex: 'creator_name',
      key: 'creator_name',
      width: 100,
      ellipsis: true,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Tag color={STATUS_COLORS[status] || 'default'}>
          {STATUS_LABELS[status] || status}
        </Tag>
      ),
    },
    {
      title: '已提交',
      dataIndex: 'submitted_count',
      key: 'submitted_count',
      width: 100,
      sorter: (a, b) => a.submitted_count - b.submitted_count,
      render: (count: number) => <Text strong>{count}</Text>,

    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 170,
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_: any, record: ActivityItem) => (
        <Button
          type="primary"
          size="small"
          icon={<BarChartOutlined />}
          onClick={() => handleViewStatus(record)}
        >
          完成情况
        </Button>
      ),
    },
  ];

  // ── 学生状态列定义 ──
  const studentColumns: ColumnsType<StudentStatus> = [
    {
      title: '序号',
      key: 'index',
      width: 60,
      render: (_: any, __: any, index: number) =>
        (statusPage - 1) * 20 + index + 1,
    },
    {
      title: '姓名',
      dataIndex: 'name',
      key: 'name',
      width: 120,
    },
    {
      title: '年级',
      dataIndex: 'grade',
      key: 'grade',
      width: 100,
    },
    {
      title: '班级',
      dataIndex: 'class_name',
      key: 'class_name',
      width: 100,
    },
    {
      title: '完成状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) =>
        status === 'completed' ? (
          <Tag icon={<CheckCircleOutlined />} color="success">已完成</Tag>
        ) : (
          <Tag icon={<CloseCircleOutlined />} color="error">未完成</Tag>
        ),
    },
    {
      title: '得分',
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
      title: '提交时间',
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
        <Empty description="仅教师和管理员可访问" />
      </Card>
    );
  }

  return (
    <div>
      <Tabs defaultActiveKey="activity" items={[
        {
          key: 'activity',
          label: <span><BarChartOutlined /> 活动监控</span>,
          children: (<>
      <Title level={4} style={{ marginBottom: 16 }}>
        <BarChartOutlined /> 活动完成监控
      </Title>

      {/* ── 顶部筛选栏 ── */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]} align="middle">
          <Col>
            <Text strong>活动类型：</Text>
            <Select
              value={activityType}
              onChange={(v) => { setActivityType(v); setPage(1); }}
              style={{ width: 140 }}
              options={ACTIVITY_TYPE_OPTIONS}
            />
          </Col>
          <Col>
            <Text strong>年级：</Text>
            <Select
              allowClear
              placeholder="选择年级"
              value={selectedGradeId}
              onChange={handleGradeChange}
              style={{ width: 120 }}
              options={gradeOptions}
            />
          </Col>
          <Col>
            <Text strong>班级：</Text>
            <Select
              allowClear
              placeholder="选择班级"
              value={selectedClassId}
              onChange={handleClassChange}
              style={{ width: 120 }}
              options={classOptions}
              disabled={!selectedGradeId}
            />
          </Col>
          <Col flex="auto">
            <Input.Search
              placeholder="搜索活动名称"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onSearch={() => { setPage(1); handleRefresh(); }}
              style={{ maxWidth: 250 }}
              enterButton
            />
          </Col>
          <Col>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh}>刷新</Button>
          </Col>
        </Row>
      </Card>

      {/* ── 活动列表 ── */}
      <Card title="活动列表" size="small" style={{ marginBottom: 16 }}>
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
            showTotal: (t) => `共 ${t} 个活动`,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
          }}
        />
      </Card>

      {/* ── 活动完成详情 ── */}
      {selectedActivity && (
        <Card
          title={
            <Space>
              <span>完成详情：{selectedActivity.title}</span>
              <Tag color={ACTIVITY_TYPE_COLORS[selectedActivity.activity_type]}>
                {ACTIVITY_TYPE_OPTIONS.find(o => o.value === selectedActivity.activity_type)?.label}
              </Tag>
            </Space>
          }
          size="small"
          extra={
            <Button size="small" onClick={() => { setSelectedActivity(null); setStatusDetail(null); }}>
              关闭
            </Button>
          }
        >
          {!selectedGradeId || !selectedClassId ? (
            /* ── 未选定年级/班级时提示 ── */
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#999' }}>
              <BarChartOutlined style={{ fontSize: 48, marginBottom: 16 }} />
              <div>请在顶部筛选栏中选择<Text strong>年级</Text>和<Text strong>班级</Text>查看完成情况</div>
            </div>
          ) : statusLoading ? (
            /* ── 加载中 ── */
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <Spin />
              <div style={{ marginTop: 8, color: '#999' }}>加载中...</div>
            </div>
          ) : statusDetail ? (
            /* ── 有数据时 ── */
            <>
              {/* 统计概览 */}
              <Row gutter={24} style={{ marginBottom: 16 }}>
                <Col span={4}>
                  <Statistic title="应完成人数" value={statusDetail.statistics.total_students} suffix="人" />
                </Col>
                <Col span={4}>
                  <Statistic title="已完成" value={statusDetail.statistics.completed_count} suffix="人" styles={{ content: { color: '#52c41a' } }} />
                </Col>
                <Col span={4}>
                  <Statistic title="未完成" value={statusDetail.statistics.incomplete_count} suffix="人" styles={{ content: { color: '#f5222d' } }} />
                </Col>
                <Col span={4}>
                  <Statistic title="完成率" value={statusDetail.statistics.completion_rate} suffix="%" precision={1} />
                </Col>
                <Col span={4}>
                  <Statistic title="平均分" value={statusDetail.statistics.avg_score} precision={1} />
                </Col>
              </Row>

              {/* 状态筛选 */}
              <Space style={{ marginBottom: 12 }}>
                <Text strong>筛选：</Text>
                <Radio.Group
                  value={statusFilter}
                  onChange={(e) => handleStatusFilterChange(e.target.value)}
                  optionType="button"
                  buttonStyle="solid"
                >
                  <Radio.Button value="all">全部</Radio.Button>
                  <Radio.Button value="completed"><CheckCircleOutlined /> 已完成</Radio.Button>
                  <Radio.Button value="incomplete"><CloseCircleOutlined /> 未完成</Radio.Button>
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
                  showTotal: (t) => `共 ${t} 名学生`,
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
          label: <span><EyeOutlined /> 浏览统计</span>,
          children: <ResourceViewStatsPage />,
        },
      ]} />
    </div>
  );
};

export default ActivityMonitorPage;
