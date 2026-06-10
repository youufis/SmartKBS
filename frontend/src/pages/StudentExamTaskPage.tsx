import React, { useState } from 'react'
import { Tabs } from 'antd'
import { FileAddOutlined, CheckCircleOutlined, CodeOutlined } from '@ant-design/icons'
import ExamPage from './ExamPage'
import TaskPage from './TaskPage'
import CodePracticePage from './CodePracticePage'

const StudentExamTaskPage: React.FC = () => {
  const [tab, setTab] = useState('exam')

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      style={{ margin: 0 }}
      items={[
        {
          key: 'exam',
          label: <span><FileAddOutlined /> 在线考试</span>,
          children: <ExamPage />,
        },
        {
          key: 'tasks',
          label: <span><CheckCircleOutlined /> 在线任务</span>,
          children: <TaskPage />,
        },
        {
          key: 'code',
          label: <span><CodeOutlined /> 代码练习</span>,
          children: <CodePracticePage inTab />,
        },
      ]}
    />
  )
}

export default StudentExamTaskPage
