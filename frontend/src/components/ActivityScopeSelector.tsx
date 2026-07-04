import React, { useState, useEffect, useMemo } from 'react'
import { Select, Radio, Space, Tag, Divider, Typography, Checkbox } from 'antd'
import { BookOutlined, GlobalOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons'
import { fetchGrades, fetchAllGradeClasses } from '../api/gradeClass'
import { useAuthStore } from '../stores/authStore'

const { Text } = Typography

export type TargetScope = 'teacher_classes' | 'all' | 'grade' | 'class' | 'individual'

export interface ActivityScopeValue {
  target_scope: TargetScope
  target_grade: string
  target_class: string
  target_users: string
}

interface Props {
  value?: ActivityScopeValue
  onChange?: (val: ActivityScopeValue) => void
  /** 是否显示"全体学生"选项（仅管理员） */
  showAllOption?: boolean
}

const ActivityScopeSelector: React.FC<Props> = ({
  value,
  onChange,
  showAllOption = false,
}) => {
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'

  const [scope, setScope] = useState<TargetScope>('teacher_classes')
  const [grades, setGrades] = useState<string[]>([])
  const [classOptions, setClassOptions] = useState<{ grade: string; classes: string[] }[]>([])
  const [selectedGrades, setSelectedGrades] = useState<string[]>([])
  const [selectedClasses, setSelectedClasses] = useState<string[]>([])

  // 从 value prop 同步内部状态（支持 Ant Design Form 的受控模式）
  useEffect(() => {
    if (value) {
      setScope(value.target_scope || 'teacher_classes')
      setSelectedGrades(value.target_grade ? value.target_grade.split(',').filter(Boolean) : [])
      setSelectedClasses(value.target_class ? value.target_class.split(',').filter(Boolean) : [])
    }
  }, [value])

  // 使用共享 gradeClass 服务加载年级/班级
  useEffect(() => {
    fetchGrades().then(setGrades).catch(() => {})
  }, [])

  useEffect(() => {
    if (grades.length > 0) {
      fetchAllGradeClasses().then(setClassOptions).catch(() => {})
    }
  }, [grades])

  // ── 范围变更 ──
  const handleScopeChange = (newScope: TargetScope) => {
    setScope(newScope)
    if (newScope === 'teacher_classes' || newScope === 'all') {
      setSelectedGrades([])
      setSelectedClasses([])
      notifyChange(newScope, '', '', '')
    } else if (newScope === 'grade') {
      setSelectedClasses([])
      notifyChange(newScope, selectedGrades.join(','), '', '')
    } else if (newScope === 'class') {
      notifyChange(newScope, selectedGrades.join(','), selectedClasses.join(','), '')
    } else {
      notifyChange(newScope, '', '', '')
    }
  }

  // ── 年级变更 ──
  const handleGradeChange = (vals: string[]) => {
    setSelectedGrades(vals)
    if (scope === 'grade') {
      notifyChange(scope, vals.join(','), '', '')
    } else if (scope === 'class') {
      // 清除不在选中年级中的班级
      const validClasses = selectedClasses.filter((c) => {
        return classOptions.some(
          (opt) => vals.includes(opt.grade) && opt.classes.includes(c)
        )
      })
      setSelectedClasses(validClasses)
      notifyChange(scope, vals.join(','), validClasses.join(','), '')
    }
  }

  // ── 班级变更 ──
  const handleClassChange = (vals: string[]) => {
    setSelectedClasses(vals)
    notifyChange(scope, selectedGrades.join(','), vals.join(','), '')
  }

  const notifyChange = (
    s: TargetScope,
    g: string,
    c: string,
    u: string
  ) => {
    onChange?.({
      target_scope: s,
      target_grade: g,
      target_class: c,
      target_users: u,
    })
  }

  // 当前选中年级下的所有班级
  const availableClasses = useMemo(() => {
    return classOptions
      .filter((opt) => selectedGrades.includes(opt.grade))
      .flatMap((opt) => opt.classes)
  }, [classOptions, selectedGrades])

  const scopeOptions: { value: TargetScope; label: React.ReactNode; desc: string }[] = [
    { value: 'teacher_classes', label: <><TeamOutlined /> 任教班级</>, desc: '对您任教的所有班级学生可见（默认）' },
    { value: 'grade', label: <><BookOutlined /> 指定年级</>, desc: '对选中的年级全体学生可见' },
    { value: 'class', label: <><BookOutlined /> 指定班级</>, desc: '对选中的具体班级学生可见' },
  ]
  if (showAllOption || isAdmin) {
    scopeOptions.unshift({ value: 'all', label: <><GlobalOutlined /> 全体学生</>, desc: '对所有学生可见' })
  }

  return (
    <div style={{ border: '1px solid #d9d9d9', borderRadius: 6, padding: '12px 16px', background: '#fafafa' }}>
      <Text strong style={{ marginBottom: 8, display: 'block' }}>
        <GlobalOutlined /> 活动目标范围
      </Text>
      <Radio.Group
        value={scope}
        onChange={(e) => handleScopeChange(e.target.value)}
        optionType="button"
        buttonStyle="solid"
        size="small"
        style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: 4 }}
      >
        {scopeOptions.map((opt) => (
          <Radio.Button key={opt.value} value={opt.value} style={{ flex: 'none' }}>
            {opt.label}
          </Radio.Button>
        ))}
      </Radio.Group>

      {/* 年级/班级选择 */}
      {(scope === 'grade' || scope === 'class') && (
        <div style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 8 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>选择年级：</Text>
            <Select
              mode="multiple"
              value={selectedGrades}
              onChange={handleGradeChange}
              placeholder="选择年级"
              style={{ width: '100%', marginTop: 4 }}
              options={grades.map((g) => ({ label: g, value: g }))}
            />
          </div>
          {scope === 'class' && selectedGrades.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 13 }}>选择班级：</Text>
              <Select
                mode="multiple"
                value={selectedClasses}
                onChange={handleClassChange}
                placeholder="选择班级"
                style={{ width: '100%', marginTop: 4 }}
                options={availableClasses.map((c) => ({ label: `${c}班`, value: c }))}
              />
            </div>
          )}
        </div>
      )}

      {/* 范围说明 */}
      <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
        {scope === 'teacher_classes' && '活动将对您任教的所有班级学生可见。'}
        {scope === 'all' && '活动将对全校所有学生可见。'}
        {scope === 'grade' && selectedGrades.length > 0 && `活动将对 ${selectedGrades.join('、')} 的所有学生可见。`}
        {scope === 'grade' && selectedGrades.length === 0 && '请选择目标年级。'}
        {scope === 'class' && selectedClasses.length > 0 && `活动将对 ${selectedClasses.map(c => `${c}班`).join('、')} 的学生可见。`}
        {scope === 'class' && selectedClasses.length === 0 && '请选择目标年级和班级。'}
      </div>
    </div>
  )
}

export default ActivityScopeSelector
