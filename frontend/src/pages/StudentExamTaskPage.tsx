import React, { useState } from 'react'
import { Tabs } from 'antd'
import { FileAddOutlined, CheckCircleOutlined, CodeOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import ExamPage from './ExamPage'
import TaskPage from './TaskPage'
import CodePracticePage from './CodePracticePage'

const StudentExamTaskPage: React.FC = () => {
  const { t } = useTranslation('system')
  const [tab, setTab] = useState('exam')

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      style={{ margin: 0 }}
      items={[
        {
          key: 'exam',
          label: <span><FileAddOutlined /> {t('onlineExam')}</span>,
          children: <ExamPage />,
        },
        {
          key: 'tasks',
          label: <span><CheckCircleOutlined /> {t('onlineTask')}</span>,
          children: <TaskPage />,
        },
        {
          key: 'code',
          label: <span><CodeOutlined /> {t('codePractice')}</span>,
          children: <CodePracticePage />,
        },
      ]}
    />
  )
}

export default StudentExamTaskPage
