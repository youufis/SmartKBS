/**
 * LearningProgress — 学习进度概览组件
 * 教师/管理员查看班级或单个学生的学习进度统计
 */
import React, { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Card, Row, Col, Select, Table, Statistic, Typography, Spin, Empty, message, Tag, Space,
} from 'antd'
import {
  BookOutlined, CheckCircleOutlined, TrophyOutlined, FireOutlined,
  ReloadOutlined, UserOutlined, TeamOutlined,
} from '@ant-design/icons'
import * as activityMonitorApi from '../api/activityMonitor'
import type { StudentProgress } from '../api/activityMonitor'
import { useAuthStore } from '../stores/authStore'
import { fetchGrades, fetchClasses } from '../api/gradeClass'

const { Text } = Typography

const LearningProgress: React.FC = () => {
  const { t } = useTranslation('curriculum')
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'

  const [loading, setLoading] = useState(false)
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [selectedGrade, setSelectedGrade] = useState<string | undefined>()
  const [selectedClass, setSelectedClass] = useState<string | undefined>()
  const [selectedStudent, setSelectedStudent] = useState<string | undefined>()
  const [students, setStudents] = useState<{ username: string; name: string }[]>([])
  const [progressData, setProgressData] = useState<StudentProgress[]>([])
  const [summary, setSummary] = useState<activityMonitorApi.ClassProgressSummary | null>(null)

  // 加载年级
  useEffect(() => {
    fetchGrades().then(setGrades).catch(() => {})
  }, [])

  // 年级变化 -> 加载班级
  useEffect(() => {
    if (selectedGrade) {
      fetchClasses(selectedGrade).then(setClasses).catch(() => setClasses([]))
    } else {
      setClasses([])
    }
    setSelectedClass(undefined)
    setSelectedStudent(undefined)
    setProgressData([])
    setSummary(null)
  }, [selectedGrade])

  // 班级变化 -> 加载学生数据
  useEffect(() => {
    if (selectedGrade && selectedClass) {
      // 规范化班级名：从 "高一1班" 提取纯数字 "1"
      const cls = selectedClass.replace(/^[^\d]*/, '').replace(/班$/, '')
      loadData(selectedGrade, cls)
    } else {
      setProgressData([])
      setSummary(null)
      setStudents([])
    }
  }, [selectedGrade, selectedClass])

  const loadData = async (grade: string, cls: string) => {
    setLoading(true)
    try {
      const res = await activityMonitorApi.getLearningProgress({
        grade,
        class_name: cls,
      })
      setProgressData(res.students || [])
      setSummary(res.summary || null)
      setStudents((res.students || []).map((s) => ({
        username: s.username,
        name: s.student_name,
      })))
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      message.error(err?.response?.data?.detail || err?.message || t('loadDataFailed'))
    } finally {
      setLoading(false)
    }
  }

  const loadStudentData = async (username: string) => {
    setLoading(true)
    try {
      const res = await activityMonitorApi.getLearningProgress({ username })
      if (res && res.students && res.students.length > 0) {
        setProgressData(res.students)
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      message.error(err?.response?.data?.detail || err?.message || t('loadDataFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleStudentChange = (val: string | undefined) => {
    setSelectedStudent(val)
    if (val) {
      loadStudentData(val)
    } else if (selectedGrade && selectedClass) {
      loadData(selectedGrade, selectedClass)
    }
  }

  const columns = [
    { title: t('studentName'), dataIndex: 'student_name', key: 'name', width: 100 },
    {
      title: t('courseProgress'), dataIndex: 'course_progress', key: 'course_progress', width: 120,
      sorter: (a: StudentProgress, b: StudentProgress) => a.course_progress - b.course_progress,
      render: (v: number) => <span>{v}% <Text type="secondary" style={{ fontSize: 11 }}>({v > 0 ? `${Math.round(v / 10)}/10` : '-'})</Text></span>,
    },
    {
      title: t('completionRate'), dataIndex: 'completion_rate', key: 'completion_rate', width: 100,
      sorter: (a: StudentProgress, b: StudentProgress) => a.completion_rate - b.completion_rate,
      render: (v: number) => <span>{v}%</span>,
    },
    {
      title: t('accuracyRate'), dataIndex: 'accuracy_rate', key: 'accuracy_rate', width: 100,
      sorter: (a: StudentProgress, b: StudentProgress) => a.accuracy_rate - b.accuracy_rate,
      render: (v: number) => <span>{v}%</span>,
    },
    {
      title: t('streakDays'), dataIndex: 'streak_days', key: 'streak_days', width: 100,
      sorter: (a: StudentProgress, b: StudentProgress) => a.streak_days - b.streak_days,
      render: (v: number) => v > 0 ? <Tag color="orange"><FireOutlined /> {v}{t('days')}</Tag> : '-',
    },
    {
      title: t('detailHeader'),
      key: 'detail',
      width: 200,
      render: (_: any, r: StudentProgress) => (
        <Space size={4} split={<Text type="secondary">|</Text>}>
          <span title={t('tooltipExamDone')}>📝{r.exam_done || 0}</span>
          <span title={t('tooltipPracticeDone')}>📋{r.practice_done || 0}</span>
          <span title={t('tooltipCourseDone')}>📖{r.course_done || 0}</span>
          <span title={t('tooltipCodeDone')}>💻{r.code_done || 0}</span>
        </Space>
      ),
    },
  ]

  return (
    <div>
      {/* 筛选栏 */}
      <Card size="small" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 12]} align="middle">
          <Col>
            <Text strong>{t('gradeLabel')}：</Text>
            <Select
              allowClear
              placeholder={t('selectGrade')}
              value={selectedGrade}
              onChange={(v) => setSelectedGrade(v)}
              style={{ width: 120 }}
              options={grades.map((g) => ({ value: g, label: g }))}
            />
          </Col>
          <Col>
            <Text strong>{t('classLabel')}：</Text>
            <Select
              allowClear
              placeholder={t('selectClass')}
              value={selectedClass}
              onChange={(v) => setSelectedClass(v)}
              style={{ width: 120 }}
              disabled={!selectedGrade}
              options={classes.map((c) => ({ value: c, label: c }))}
            />
          </Col>
          <Col>
            <Text strong>{t('studentLabel')}：</Text>
            <Select
              allowClear
              placeholder={t('allStudents')}
              value={selectedStudent}
              onChange={handleStudentChange}
              style={{ width: 150 }}
              disabled={students.length === 0}
              options={students.map((s) => ({ value: s.username, label: s.name }))}
            />
          </Col>
          <Col>
            <ReloadOutlined
              style={{ cursor: 'pointer', fontSize: 18, color: '#1677ff' }}
              onClick={() => {
                if (selectedStudent) {
                  loadStudentData(selectedStudent)
                } else if (selectedGrade && selectedClass) {
                  loadData(selectedGrade, selectedClass)
                }
              }}
            />
          </Col>
        </Row>
      </Card>

      {/* 班级汇总卡片 */}
      {summary && summary.total_students > 0 && !selectedStudent && (
        <Row gutter={16} style={{ marginBottom: 16 }}>
          <Col span={6}>
            <Card size="small">
              <Statistic title={t('totalStudentsLabel')} value={summary.total_students} prefix={<TeamOutlined />} suffix={t('personUnit')} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title={t('avgCourseProgress')} value={summary.avg_course_progress} prefix={<BookOutlined />} suffix="%" />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title={t('avgCompletionRate')} value={summary.avg_completion_rate} prefix={<CheckCircleOutlined />} suffix="%" />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic title={t('avgAccuracyRate')} value={summary.avg_accuracy_rate} prefix={<TrophyOutlined />} suffix="%" />
            </Card>
          </Col>
        </Row>
      )}

      {/* 学生详情表格 */}
      <Card size="small" title={selectedStudent ? t('individualProgress') : t('classProgress')}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}><Spin /><div style={{ marginTop: 8, color: '#999' }}>{t('loadingData')}</div></div>
        ) : progressData.length === 0 ? (
          <Empty description={t('selectGradeClassPrompt')} />
        ) : (
          <Table
            dataSource={progressData}
            columns={columns}
            rowKey="username"
            size="small"
            pagination={progressData.length > 20 ? { pageSize: 20 } : false}
          />
        )}
      </Card>
    </div>
  )
}

export default LearningProgress
