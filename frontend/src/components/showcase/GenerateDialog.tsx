import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('dashboard')
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
      message.error(err?.response?.data?.detail || t('scGenFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={t('scTitle')}
      open={open}
      onCancel={onClose}
      onOk={handleGenerate}
      confirmLoading={loading}
      okText={t('scGenBtn')}
      cancelText={t('scCancel')}
      width={480}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>{t('scGenCount')}</Text>
          <InputNumber
            min={1}
            max={200}
            value={count}
            onChange={(v) => setCount(v || 10)}
            style={{ width: '100%' }}
            addonAfter={t('scUnit')}
          />
        </div>

        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>{t('scGradeFilter')}</Text>
          <Select
            placeholder={t('scAllGrades')}
            value={grade || undefined}
            onChange={setGrade}
            style={{ width: '100%' }}
            allowClear
            options={grades.map((g) => ({ label: g, value: g }))}
          />
        </div>

        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>{t('scClassFilter')}</Text>
          <Select
            placeholder={t('scAllClasses')}
            value={className || undefined}
            onChange={setClassName}
            style={{ width: '100%' }}
            allowClear
            options={availableClasses.map((c) => ({ label: c, value: c }))}
            notFoundContent={t('scNoClass')}
          />
        </div>

        <div>
          <Text style={{ display: 'block', marginBottom: 6 }}>{t('scStudentFilter')}</Text>
          <Input
            placeholder={t('scStudentPh')}
            value={studentName}
            onChange={(e) => setStudentName(e.target.value)}
            allowClear
          />
        </div>

        <Text type="secondary" style={{ fontSize: 12 }}>
          {t('scOverwriteHint')}
        </Text>
      </Space>
    </Modal>
  )
}

export default GenerateDialog
