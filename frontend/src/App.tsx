import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './stores/authStore'
import LoginPage from './pages/LoginPage'
import AppLayout from './components/AppLayout'
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

function App() {
  const restoreSession = useAuthStore((s: { restoreSession: () => void }) => s.restoreSession)
  const isLoggedIn = useAuthStore((s: { isLoggedIn: boolean }) => s.isLoggedIn)
  const user = useAuthStore((s) => s.user)

  useEffect(() => {
    restoreSession()
  }, [restoreSession])

  return (
    <Routes>
      <Route path="/login" element={isLoggedIn ? <Navigate to="/chat" /> : <LoginPage />} />
      <Route path="/exam-take/:examId" element={isLoggedIn && user?.role === 'student' ? <ExamTakePage /> : <Navigate to={isLoggedIn ? '/chat' : '/login'} />} />
      <Route path="/" element={isLoggedIn ? <AppLayout /> : <Navigate to="/login" />}>
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
        <Route path="about" element={<AboutPage />} />
        <Route index element={<Navigate to="/chat" />} />
      </Route>
      <Route path="*" element={<Navigate to="/login" />} />
    </Routes>
  )
}

export default App
