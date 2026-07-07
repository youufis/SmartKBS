import React, { useState } from 'react'
import { Tabs } from 'antd'
import { DatabaseOutlined, FileAddOutlined, CodeOutlined, RobotOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import QuestionBankPage from './QuestionBankPage'
import ExamPage from './ExamPage'
import CodePracticePage from './CodePracticePage'
import QuizManager from '../components/QuizManager'

const QuestionExamPage: React.FC = () => {
  const { t } = useTranslation('questions')
  const [tab, setTab] = useState('question-bank')

  return (
    <Tabs
      activeKey={tab}
      onChange={setTab}
      style={{ margin: 0 }}
      items={[
        {
          key: 'question-bank',
          label: <span><DatabaseOutlined /> {t('questionManagement')}</span>,
          children: <QuestionBankPage />,
        },
        {
          key: 'exam',
          label: <span><FileAddOutlined /> {t('examPublish')}</span>,
          children: <ExamPage />,
        },
        {
          key: 'quiz',
          label: <span><RobotOutlined /> {t('quizQuestions')}</span>,
          children: <QuizManager />,
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

export default QuestionExamPage
