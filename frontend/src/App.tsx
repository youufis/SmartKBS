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
import ExamTakePage from './pages/ExamTakePage'
import NotificationsPage from './pages/NotificationsPage'
import AnnouncementsPage from './pages/AnnouncementsPage'
import PortfolioPage from './pages/PortfolioPage'
import AnalyticsPage from './pages/AnalyticsPage'
import InteractionPage from './pages/InteractionPage'
import DiscussionPage from './pages/DiscussionPage'
import DiscussionRoomPage from './pages/DiscussionRoomPage'
import DiscussionMonitorPage from './pages/DiscussionMonitorPage'
import CurriculumPage from './pages/CurriculumPage'
import CurriculumProgressPage from './pages/CurriculumProgressPage'

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
            <Route path="resource-mgmt" element={user?.role === 'admin' || user?.role === 'teacher' ? <ResourceMgmtPage /> : <Navigate to="/chat" />} />
            <Route path="downloads" element={<DownloadsPage />} />
            <Route path="user-mgmt" element={<UserMgmtPage />} />
            <Route path="tasks" element={<TaskPage />} />
            <Route path="system-config" element={user?.role === 'admin' ? <SystemConfigPage /> : <Navigate to="/chat" />} />
            <Route path="question-bank" element={user?.role === 'admin' || user?.role === 'teacher' ? <QuestionBankPage /> : <Navigate to="/chat" />} />
            <Route path="exam" element={<ExamPage />} />
            <Route path="score" element={<ScorePage />} />
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
            <Route path="curriculum" element={<CurriculumPage />} />
            <Route path="curriculum/progress" element={user?.role === 'admin' || user?.role === 'teacher' ? <CurriculumProgressPage /> : <Navigate to="/curriculum" />} />
            <Route path="about" element={<AboutPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/login" />} />
        </Routes>
      )}
    </>
  )
}

export default App
