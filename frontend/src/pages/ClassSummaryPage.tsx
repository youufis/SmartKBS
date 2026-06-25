/**
 * ClassSummaryPage — AI 课堂总结（独立页）
 * 教师端：AI 生成课堂活动综合分析报告
 */
import React, { useState, useEffect } from 'react'
import {
  Card, Button, Space, Typography, message, Spin, Empty,
  Statistic, Row, Col, Select,
} from 'antd'
import {
  RobotOutlined, BarChartOutlined, DownloadOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import apiClient from '../api/client'
import { pollAiTask } from '../api/aiTask'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

const ClassSummaryPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)

  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])
  const [selectedGrade, setSelectedGrade] = useState<string>('')
  const [selectedClass, setSelectedClass] = useState<string>('')

  // 加载年级列表
  useEffect(() => {
    apiClient.get('/api/scores/my-grades')
      .then(({ data }) => setGrades(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  // 年级变更 → 加载班级
  useEffect(() => {
    setSelectedClass('')
    setClasses([])
    if (!selectedGrade) return
    apiClient.get('/api/scores/classes', { params: { grade: selectedGrade, teacher: user?.username || 'root' } })
      .then(({ data }) => setClasses(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [selectedGrade, user?.username])

  const grade = selectedGrade || ''
  const cls = selectedClass || ''

  const [classSummaryLoading, setClassSummaryLoading] = useState(false)
  const [classSummaryData, setClassSummaryData] = useState<{ summary: string; data?: any } | null>(null)

  const handleClassSummary = async () => {
    if (!grade || !cls) {
      message.warning('请先选择年级和班级')
      return
    }
    setClassSummaryLoading(true)
    setClassSummaryData(null)
    try {
      const { data } = await apiClient.get('/api/interaction/class-summary', {
        params: { grade, cls, subject: '', teacher_username: user?.username },
      })
      if (data.task_id) {
        const result = await pollAiTask(data.task_id)
        if (result) setClassSummaryData(result)
      } else {
        setClassSummaryData(data)
      }
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '生成课堂总结失败')
    }
    setClassSummaryLoading(false)
  }

  return (
    <div>
      <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none' }}>
        <div style={{ color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Space>
            <RobotOutlined style={{ fontSize: 28 }} />
            <Title level={3} style={{ color: '#fff', margin: 0 }}>AI 课堂总结</Title>
            <Text style={{ color: 'rgba(255,255,255,0.85)', marginLeft: 12 }}>
              综合分析课堂活动数据
            </Text>
          </Space>
        </div>
      </Card>

      <Card>
        <Space style={{ marginBottom: 16 }}>
          <Select
            placeholder="选择年级"
            value={selectedGrade || undefined}
            onChange={setSelectedGrade}
            style={{ width: 140 }}
            options={grades.map(g => ({ value: g, label: g }))}
          />
          <Select
            placeholder="选择班级"
            value={selectedClass || undefined}
            onChange={setSelectedClass}
            style={{ width: 140 }}
            disabled={!selectedGrade || classes.length === 0}
            options={classes.map(c => ({ value: c, label: c }))}
          />
          <Button icon={<RobotOutlined />} onClick={handleClassSummary} loading={classSummaryLoading}>
            AI 课堂总结
          </Button>
        </Space>

        {classSummaryData && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <Row gutter={12} style={{ flex: 1 }}>
                <Col span={6}><Statistic title="测验数" value={classSummaryData.data?.quiz_count || 0} /></Col>
                <Col span={6}><Statistic title="投票数" value={classSummaryData.data?.poll_count || 0} /></Col>
                <Col span={6}><Statistic title="提问数" value={classSummaryData.data?.question_count || 0} /></Col>
                <Col span={6}><Statistic title="参与学生" value={classSummaryData.data?.student_count || 0} /></Col>
              </Row>
              <Button
                icon={<DownloadOutlined />}
                type="primary"
                ghost
                onClick={() => {
                  const token = localStorage.getItem('smartkb_token')
                  const params = new URLSearchParams({
                      grade,
                      cls,
                    subject: '',
                    teacher_username: user?.username || '',
                    token: token || '',
                  })
                  window.open(`/api/interaction/class-summary/export?${params.toString()}`, '_blank')
                }}
              >
                导出 Word
              </Button>
            </div>
            <Card style={{ background: '#f6ffed', border: '1px solid #b7eb8f' }}>
              <div className="markdown-content">
                <ReactMarkdown>{classSummaryData.summary}</ReactMarkdown>
              </div>
            </Card>
          </>
        )}
        {!classSummaryData && !classSummaryLoading && (
          <Empty description="点击「AI 课堂总结」生成综合分析报告" />
        )}
      </Card>
    </div>
  )
}

export default ClassSummaryPage
