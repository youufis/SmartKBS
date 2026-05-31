import React, { useState } from 'react'
import { Tabs } from 'antd'
import { DatabaseOutlined, FileAddOutlined } from '@ant-design/icons'
import QuestionBankPage from './QuestionBankPage'
import ExamPage from './ExamPage'

const QuestionExamPage: React.FC = () => {
  const [tab, setTab] = useState('question-bank')

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      style={{ margin: 0 }}
      items={[
        {
          key: 'question-bank',
          label: <span><DatabaseOutlined /> 试题管理</span>,
          children: <QuestionBankPage />,
        },
        {
          key: 'exam',
          label: <span><FileAddOutlined /> 考试发布</span>,
          children: <ExamPage />,
        },
      ]}
    />
  )
}

export default QuestionExamPage
