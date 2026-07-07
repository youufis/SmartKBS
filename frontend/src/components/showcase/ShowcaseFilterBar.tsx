import React from 'react'
import { Input, Select, Space } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation('score')
  return (
    <Space wrap style={{ marginBottom: 16, width: '100%' }}>
      <Input
        placeholder={t('searchStudentName')}
        prefix={<SearchOutlined />}
        value={searchName}
        onChange={(e) => onSearchNameChange(e.target.value)}
        style={{ width: 180 }}
        allowClear
      />
      <Select
        placeholder={t('allGrades')}
        value={selectedGrade || undefined}
        onChange={onGradeChange}
        style={{ width: 130 }}
        allowClear
        options={[
          ...grades.map((g) => ({ label: g, value: g })),
        ]}
      />
      <Select
        placeholder={t('allClasses')}
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
          { label: t('sortByPoints'), value: 'points' },
          { label: t('sortByLikes'), value: 'likes' },
          { label: t('sortByNewest'), value: 'newest' },
        ]}
      />
    </Space>
  )
}

export default ShowcaseFilterBar
