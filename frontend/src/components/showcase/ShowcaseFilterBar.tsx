import React from 'react'
import { Input, Select, Space } from 'antd'
import { SearchOutlined } from '@ant-design/icons'

interface Props {
  grades: string[];
  classes: string[];
  selectedGrade: string;
  selectedClass: string;
  searchName: string;
  sortBy: string;
  onGradeChange: (val: string) => void;
  onClassChange: (val: string) => void;
  onSearchNameChange: (val: string) => void;
  onSortChange: (val: string) => void;
}

const ShowcaseFilterBar: React.FC<Props> = ({
  grades, classes, selectedGrade, selectedClass,
  searchName, sortBy,
  onGradeChange, onClassChange, onSearchNameChange, onSortChange,
}) => {
  return (
    <Space wrap style={{ marginBottom: 16, width: '100%' }}>
      <Input
        placeholder="搜索学生姓名..."
        prefix={<SearchOutlined />}
        value={searchName}
        onChange={(e) => onSearchNameChange(e.target.value)}
        style={{ width: 180 }}
        allowClear
      />
      <Select
        placeholder="全部年级"
        value={selectedGrade || undefined}
        onChange={onGradeChange}
        style={{ width: 130 }}
        allowClear
        options={[
          ...grades.map((g) => ({ label: g, value: g })),
        ]}
      />
      <Select
        placeholder="全部班级"
        value={selectedClass || undefined}
        onChange={onClassChange}
        style={{ width: 120 }}
        allowClear
        options={[
          ...classes.map((c) => ({ label: c, value: c })),
        ]}
      />
      <Select
        value={sortBy}
        onChange={onSortChange}
        style={{ width: 140 }}
        options={[
          { label: '🏆 积分最高', value: 'points' },
          { label: '❤️ 点赞最多', value: 'likes' },
          { label: '🆕 最新生成', value: 'newest' },
        ]}
      />
    </Space>
  )
}

export default ShowcaseFilterBar
