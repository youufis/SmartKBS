import React, { useState, useEffect, useCallback } from 'react'
import { Modal, InputNumber, Select, Input, Space, Typography, message } from 'antd'
import { generateShowcase } from '../../api/showcase'
import apiClient from '../../api/client'

const { Text } = Typography

interface Props {
  open: boolean;
  onClose: () => void;
  grades: string[];
  onSuccess: () => void;
}

const GenerateDialog: React.FC<Props> = ({ open, onClose, grades, onSuccess }) => {
  const [count, setCount] = useState(10)
  const [grade, setGrade] = useState('')
  const [className, setClassName] = useState('')
  const [studentName, setStudentName] = useState('')
  const [loading, setLoading] = useState(false)
  const [availableClasses, setAvailableClasses] = useState<string[]>([])

  // 弹窗打开时重置表单
  useEffect(() => {
    if (open) {
      setCount(10)
      setGrade('')
      setClassName('')
      setStudentName('')
      setAvailableClasses([])
    }
  }, [open])

  // 年级变化 → 动态加载班级
  const loadClasses = useCallback(async (g: string) => {
    if (!g) {
      setAvailableClasses([])
      setClassName('')
      return
    }
    try {
      const { data } = await apiClient.get('/api/scores/classes', { params: { grade: g } })
      setAvailableClasses(Array.isArray(data) ? data : [])
    } catch {
      setAvailableClasses([])
    }
    setClassName('')
  }, [])

  useEffect(() => {
    loadClasses(grade)
  }, [grade, loadClasses])

  const handleGenerate = async () => {
    setLoading(true)
    try {
      const res = await generateShowcase({
        count,
        grade: grade || undefined,
        class_name: className || undefined,
        student_name: studentName || undefined,
      })
      message.success(res.message)
      onSuccess()
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '生成失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title="✨ 生成荣誉展示卡"
      open={open}
      onCancel={onClose}
      onOk={handleGenerate}
      confirmLoading={loading}
      okText="确认生成"
      cancelText="取消"
      width={480}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>生成数量</Text>
          <InputNumber
            min={1}
            max={200}
            value={count}
            onChange={(v) => setCount(v || 10)}
            style={{ width: '100%' }}
            addonAfter="张"
          />
        </div>

        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>年级筛选（可选）</Text>
          <Select
            placeholder="全部年级"
            value={grade || undefined}
            onChange={setGrade}
            style={{ width: '100%' }}
            allowClear
            options={grades.map((g) => ({ label: g, value: g }))}
          />
        </div>

        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>班级筛选（可选）</Text>
          <Select
            placeholder="全部班级"
            value={className || undefined}
            onChange={setClassName}
            style={{ width: '100%' }}
            allowClear
            options={availableClasses.map((c) => ({ label: c, value: c }))}
            notFoundContent="该年级暂无班级"
          />
        </div>

        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>学生姓名（可选，模糊搜索）</Text>
          <Input
            placeholder="输入学生姓名"
            value={studentName}
            onChange={(e) => setStudentName(e.target.value)}
            allowClear
          />
        </div>

        <Text type="secondary" style={{ fontSize: 12 }}>
          ⚠️ 已存在的学生卡片将自动覆盖更新，点赞和浏览数据保留不受影响
        </Text>
      </Space>
    </Modal>
  )
}

export default GenerateDialog
