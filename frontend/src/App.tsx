import { useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { Spin, message } from 'antd'
import { useAuthStore } from './stores/authStore'
import LoginPage from './pages/LoginPage'
import AppLayout from './components/AppLayout'
import DashboardPage from './pages/DashboardPage'
import ChatPage from './pages/ChatPage'
import HtmlFilesPage from './pages/HtmlFilesPage'
import ResourceMgmtPage from './pages/ResourceMgmtPage'
import DownloadsPage from './pages/DownloadsPage'
import UserMgmtPage from './pages/UserMgmtPage'
import TaskPage from './pages/TaskPage'
import SystemConfigPage from './pages/SystemConfigPage'
import ScorePage from './pages/ScorePage'
import RollcallManagePage from './pages/RollcallManagePage'
import AboutPage from './pages/AboutPage'
import QuestionBankPage from './pages/QuestionBankPage'
import ExamPage from './pages/ExamPage'
import QuestionExamPage from './pages/QuestionExamPage'
import ExamTakePage from './pages/ExamTakePage'
import ExamComposePage from './pages/ExamComposePage'
import NotificationsPage from './pages/NotificationsPage'
import AnnouncementsPage from './pages/AnnouncementsPage'
import PortfolioPage from './pages/PortfolioPage'
import AnalyticsPage from './pages/AnalyticsPage'
import InteractionPage from './pages/InteractionPage'
import DiscussionPage from './pages/DiscussionPage'
import DiscussionRoomPage from './pages/DiscussionRoomPage'
import DiscussionMonitorPage from './pages/DiscussionMonitorPage'
import CurriculumPage from './pages/CurriculumPage'
import WrongBookPage from './pages/WrongBookPage'
import CurriculumProgressPage from './pages/CurriculumProgressPage'
import SharedCenterPage from './pages/SharedCenterPage'
import StudentExamTaskPage from './pages/StudentExamTaskPage'
import RewardPage from './pages/RewardPage'
import QuestPage from './pages/QuestPage'
import QuestBattlePage from './pages/QuestBattlePage'
import QuestResultPage from './pages/QuestResultPage'
import QuestAdminPage from './pages/QuestAdminPage'
import QuickQuizPage from './pages/QuickQuizPage'
import QuickQuizLobby from './pages/QuickQuizLobby'
import QuickQuizPlay from './pages/QuickQuizPlay'
import QuickQuizConsole from './pages/QuickQuizConsole'
import QuickQuizResult from './pages/QuickQuizResult'
import PracticePage from './pages/PracticePage'
import CodePracticePage from './pages/CodePracticePage'
import StudentQuestionsPage from './pages/StudentQuestionsPage'
import QuickPollPage from './pages/QuickPollPage'
import ClassSummaryPage from './pages/ClassSummaryPage'
import ActivityMonitorPage from './pages/ActivityMonitorPage'
import AuthorPanelPage from './pages/AuthorPanelPage'
import CompanionSettings from './pages/CompanionSettings'
import WhiteboardPage from './pages/WhiteboardPage'
import WhiteboardRoomPage from './pages/WhiteboardRoomPage'

function App() {
  const navigate = useNavigate()
  const restoreSession = useAuthStore((s) => s.restoreSession)
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const sessionRestoring = useAuthStore((s) => s.sessionRestoring)
  const user = useAuthStore((s) => s.user)
  const forceLogout = useAuthStore((s) => s.forceLogout)

  useEffect(() => {
    restoreSession()
  }, [restoreSession])

  // 学生登录后自动检查错题数，超过30则生成错题巩固练习
  useEffect(() => {
    if (!sessionRestoring && isLoggedIn && user?.role === 'student') {
      (async () => {
        try {
          await fetch('/api/wrong-book/practice/check-auto')
        } catch {
          // 静默失败，不影响登录
        }
      })()
    }
  }, [sessionRestoring, isLoggedIn, user?.role])

  // 监听异地登录踢出事件
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent
      forceLogout(customEvent.detail)
      message.warning(customEvent.detail)
      navigate('/login', { replace: true })
    }
    window.addEventListener('auth:kickout', handler)
    return () => window.removeEventListener('auth:kickout', handler)
  }, [navigate, forceLogout])

  return (
    <>
      {sessionRestoring ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
          <Spin size="large" tip="加载中..." />
        </div>
      ) : (
        <Routes>
          <Route path="/login" element={isLoggedIn ? <Navigate to="/dashboard" /> : <LoginPage />} />
          <Route path="/exam-take/:examId" element={isLoggedIn && user?.role === 'student' ? <ExamTakePage /> : <Navigate to={isLoggedIn ? '/chat' : '/login'} />} />
          <Route path="/" element={isLoggedIn ? <AppLayout /> : <Navigate to="/login" />}>
            <Route index element={<DashboardPage />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route path="html-files" element={<HtmlFilesPage />} />
            <Route path="shared-center" element={<SharedCenterPage />} />
            <Route path="resource-mgmt" element={user?.role === 'admin' || user?.role === 'teacher' ? <ResourceMgmtPage /> : <Navigate to="/chat" />} />
            <Route path="downloads" element={<DownloadsPage />} />
            <Route path="user-mgmt" element={<UserMgmtPage />} />
            <Route path="tasks" element={<TaskPage />} />
            <Route path="system-config" element={user?.role === 'admin' ? <SystemConfigPage /> : <Navigate to="/chat" />} />
            <Route path="question-exam" element={user?.role === 'admin' || user?.role === 'teacher' ? <QuestionExamPage /> : <Navigate to="/chat" />} />
            <Route path="question-bank" element={user?.role === 'admin' || user?.role === 'teacher' ? <QuestionBankPage /> : <Navigate to="/chat" />} />
            <Route path="exam" element={<ExamPage />} />
            <Route path="exam-compose/:examId" element={user?.role === 'admin' || user?.role === 'teacher' ? <ExamComposePage /> : <Navigate to="/exam" />} />
            <Route path="score" element={user?.role === 'student' ? <RewardPage /> : <ScorePage />} />
            <Route path="rollcall" element={<RollcallManagePage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="announcements" element={<AnnouncementsPage />} />
            <Route path="portfolio" element={<PortfolioPage />} />
            <Route path="portfolio/:username" element={<PortfolioPage />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="interaction" element={<InteractionPage />} />
            <Route path="discussion" element={<DiscussionPage />} />
            <Route path="discussion-room/:groupId" element={<DiscussionRoomPage />} />
            <Route path="discussion-monitor/:discId" element={<DiscussionMonitorPage />} />
            <Route path="student-exam-task" element={<StudentExamTaskPage />} />
            <Route path="curriculum" element={<CurriculumPage />} />
            <Route path="curriculum/progress" element={user?.role === 'admin' || user?.role === 'teacher' ? <CurriculumProgressPage /> : <Navigate to="/curriculum" />} />
            <Route path="wrong-book" element={<WrongBookPage />} />
            <Route path="quest" element={user?.role === 'student' ? <QuestPage /> : <QuestAdminPage />} />
            <Route path="quest-records" element={user?.role === 'admin' || user?.role === 'teacher' ? <QuestAdminPage /> : <Navigate to="/chat" />} />
            <Route path="quick-quiz" element={<QuickQuizPage />} />
            <Route path="quick-quiz/lobby/:roomId" element={<QuickQuizLobby />} />
            <Route path="quick-quiz/play/:roomId" element={<QuickQuizPlay />} />
            <Route path="quick-quiz/console/:roomId" element={<QuickQuizConsole />} />
            <Route path="quick-quiz/result/:roomId" element={<QuickQuizResult />} />
            <Route path="practice" element={<PracticePage />} />
            <Route path="code-practice" element={<CodePracticePage />} />
            <Route path="student-questions" element={<StudentQuestionsPage />} />
            <Route path="quick-poll" element={<QuickPollPage />} />
            <Route path="class-summary" element={user?.role === 'admin' || user?.role === 'teacher' ? <ClassSummaryPage /> : <Navigate to="/chat" />} />
            <Route path="activity-monitor" element={user?.role === 'admin' || user?.role === 'teacher' ? <ActivityMonitorPage /> : <Navigate to="/chat" />} />
            <Route path="companion-settings" element={<CompanionSettings />} />
            <Route path="whiteboard" element={<WhiteboardPage />} />
            <Route path="whiteboard-room/:roomId" element={<WhiteboardRoomPage />} />
            <Route path="about" element={<AboutPage />} />
            <Route path="console" element={<AuthorPanelPage />} />
          </Route>
          <Route path="/quest/battle/:questId" element={isLoggedIn ? <QuestBattlePage /> : <Navigate to="/login" />} />
          <Route path="/quest/result/:questId" element={isLoggedIn ? <QuestResultPage /> : <Navigate to="/login" />} />
          <Route path="*" element={<Navigate to="/login" />} />
        </Routes>
      )}
    </>
  )
}

export default App
