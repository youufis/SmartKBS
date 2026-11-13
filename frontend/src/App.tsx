import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { Spin, Result, Button } from 'antd'
import { message } from './utils/feedback'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from './stores/authStore'
import { AUTH_UNAUTHORIZED_EVENT, type UnauthorizedDetail } from './api/client'
import LoginPage from './pages/LoginPage'
import { useLocaleStore } from './stores/localeStore'

/**
 * 路由级角色守卫（B4）。
 *
 * 侧边菜单按角色隐藏 ≠ 地址栏进不去：学生手输 /rollcall、/console 这类教师/管理员页面，
 * 过去会先进页面再被接口 403 打回（表现为白屏或一串报错）。这里在路由层直接挡掉，
 * 并给出可读的 403 页面与返回入口。
 */
function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const { t } = useTranslation('common')
  if (!user) return null
  if (!roles.includes(String(user.role))) {
    return (
      <Result
        status="403"
        title={t('noPermission')}
        subTitle={t('noPermissionDesc')}
        style={{ paddingTop: 64 }}
        extra={[
          <Button key="back" onClick={() => navigate(-1)}>{t('backPrevPage')}</Button>,
          <Button key="home" type="primary" onClick={() => navigate('/dashboard')}>{t('goDashboard')}</Button>,
        ]}
      />
    )
  }
  return <>{children}</>
}

const TA = ['admin', 'teacher']

import AppLayout from './components/AppLayout'
import MobileGate from './components/MobileGate'
import DashboardPage from './pages/DashboardPage'
const ChatPage = lazy(() => import('./pages/ChatPage'))
const HtmlFilesPage = lazy(() => import('./pages/HtmlFilesPage'))
const ResourceMgmtPage = lazy(() => import('./pages/ResourceMgmtPage'))
const DownloadsPage = lazy(() => import('./pages/DownloadsPage'))
const UserMgmtPage = lazy(() => import('./pages/UserMgmtPage'))
const TaskPage = lazy(() => import('./pages/TaskPage'))
const SystemConfigPage = lazy(() => import('./pages/SystemConfigPage'))
const ScorePage = lazy(() => import('./pages/ScorePage'))
const RollcallManagePage = lazy(() => import('./pages/RollcallManagePage'))
const AboutPage = lazy(() => import('./pages/AboutPage'))
const QuestionBankPage = lazy(() => import('./pages/QuestionBankPage'))
const QuestionBankAnalyticsPage = lazy(() => import('./pages/QuestionBankAnalyticsPage'))
const ExamPage = lazy(() => import('./pages/ExamPage'))
const QuestionExamPage = lazy(() => import('./pages/QuestionExamPage'))
const ExamTakePage = lazy(() => import('./pages/ExamTakePage'))
const ExamComposePage = lazy(() => import('./pages/ExamComposePage'))
const NotificationsPage = lazy(() => import('./pages/NotificationsPage'))
const AnnouncementsPage = lazy(() => import('./pages/AnnouncementsPage'))
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'))
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'))
const SummaryExportPage = lazy(() => import('./pages/SummaryExportPage'))
const InteractionPage = lazy(() => import('./pages/InteractionPage'))
const DiscussionPage = lazy(() => import('./pages/DiscussionPage'))
const DiscussionRoomPage = lazy(() => import('./pages/DiscussionRoomPage'))
const DiscussionMonitorPage = lazy(() => import('./pages/DiscussionMonitorPage'))
const CurriculumPage = lazy(() => import('./pages/CurriculumPage'))
const LessonCastPage = lazy(() => import('./pages/LessonCastPage'))
const PresenterPage = lazy(() => import('./pages/PresenterPage'))
const WrongBookPage = lazy(() => import('./pages/WrongBookPage'))
const SharedCenterPage = lazy(() => import('./pages/SharedCenterPage'))
const StudentExamTaskPage = lazy(() => import('./pages/StudentExamTaskPage'))
const RewardPage = lazy(() => import('./pages/RewardPage'))
const QuestPage = lazy(() => import('./pages/QuestPage'))
const QuestBattlePage = lazy(() => import('./pages/QuestBattlePage'))
const QuestResultPage = lazy(() => import('./pages/QuestResultPage'))
const QuestAdminPage = lazy(() => import('./pages/QuestAdminPage'))
const QuickQuizPage = lazy(() => import('./pages/QuickQuizPage'))
const QuickQuizLobby = lazy(() => import('./pages/QuickQuizLobby'))
const QuickQuizPlay = lazy(() => import('./pages/QuickQuizPlay'))
const QuickQuizConsole = lazy(() => import('./pages/QuickQuizConsole'))
const QuickQuizResult = lazy(() => import('./pages/QuickQuizResult'))
const PracticePage = lazy(() => import('./pages/PracticePage'))
const CodePracticePage = lazy(() => import('./pages/CodePracticePage'))
const StudentQuestionsPage = lazy(() => import('./pages/StudentQuestionsPage'))
const ClassQuestionPage = lazy(() => import('./pages/ClassQuestionPage'))
const ClassLadderPage = lazy(() => import('./pages/class-ladder'))
const QuickPollPage = lazy(() => import('./pages/QuickPollPage'))
const ClassSummaryPage = lazy(() => import('./pages/ClassSummaryPage'))
const ActivityMonitorPage = lazy(() => import('./pages/ActivityMonitorPage'))
const AuthorPanelPage = lazy(() => import('./pages/AuthorPanelPage'))
const CompanionSettings = lazy(() => import('./pages/CompanionSettings'))
const WhiteboardPage = lazy(() => import('./pages/WhiteboardPage'))
const WhiteboardRoomPage = lazy(() => import('./pages/WhiteboardRoomPage'))
const ExploreCanvasPage = lazy(() => import('./pages/ExploreCanvasPage'))
const ExploreWorkspacePage = lazy(() => import('./pages/ExploreWorkspacePage'))
const ExploreShareViewPage = lazy(() => import('./pages/ExploreShareViewPage'))
const TaskTodoPage = lazy(() => import('./pages/TaskTodoPage'))
const PortraitPage = lazy(() => import('./pages/PortraitPage'))
const DailyDiscoveryPage = lazy(() => import('./pages/DailyDiscoveryPage'))
const NewsHubPage = lazy(() => import('./pages/NewsHubPage'))
const DailyDiscoveryAdminPage = lazy(() => import('./pages/DailyDiscoveryAdminPage'))
const NewsAdminPage = lazy(() => import('./pages/NewsAdminPage'))
const ShowcasePage = lazy(() => import('./pages/ShowcasePage'))

function App() {
  const navigate = useNavigate()
  const restoreSession = useAuthStore((s) => s.restoreSession)
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const sessionRestoring = useAuthStore((s) => s.sessionRestoring)
  const user = useAuthStore((s) => s.user)
  const forceLogout = useAuthStore((s) => s.forceLogout)
  const lang = useLocaleStore((s) => s.current)
  // common 命名空间由 http-backend 异步加载：直接用 i18n.t 会在未加载完成时吐回键名，
  // 改用 hook 的 t，加载完成后组件重渲染、标题 effect 会自动重跑纠正
  const { t: trCommon } = useTranslation('common')
  useEffect(() => {
    restoreSession()
  }, [restoreSession])

  // A7: 登录后的标签标题恢复为平台名（登录页标题由 LoginPage 自行设置）
  useEffect(() => {
    if (isLoggedIn) document.title = trCommon('app.name')
  }, [isLoggedIn, lang, trCommon])

  // W10: 错题巩固练习的阈值检查改在"进入错题本页"时后台触发(见 WrongBookPage),
  // 不再在每次应用启动时都做一次重活

  // 会话失效统一收口：token 过期/无效/被同账号顶下线 -> 停掉全部轮询 + 清凭证 + 回登录页
  // （没有这段，挂机页面的轮询会每 30 秒把 401 刷满后端日志，且界面看起来"卡死"）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = ((e as CustomEvent<UnauthorizedDetail>).detail || {}) as UnauthorizedDetail
      const msg = detail.message || '登录已过期，请重新登录'
      forceLogout(msg)
      message.warning(msg)
      navigate('/login', { replace: true })
    }
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler)
    // 兼容历史事件名（桌面端等仍可能派发 auth:kickout）
    window.addEventListener('auth:kickout', handler)
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler)
      window.removeEventListener('auth:kickout', handler)
    }
  }, [navigate, forceLogout])

  return (
    <>
      {sessionRestoring ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
          <Spin size="large" description="加载中..." />
        </div>
      ) : (
        <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}><Spin size="large" /></div>}>
        <Routes>
          <Route path="/login" element={isLoggedIn ? <Navigate to="/dashboard" /> : <LoginPage />} />
          <Route path="/exam-take/:examId" element={isLoggedIn && user?.role === 'student' ? <ExamTakePage /> : <Navigate to={isLoggedIn ? '/chat' : '/login'} />} />
          {/* AI 讲演播放页：与考试作答页同级，脱离主布局做沉浸式（舞台 + 右栏目录 + 字幕）。
              这些路由在 AppLayout 之外，白名单门控管不到，故显式加 MobileGate：窄屏给「请用电脑端」。 */}
          <Route path="/learn/:kpId" element={isLoggedIn ? <MobileGate><LessonCastPage /></MobileGate> : <Navigate to="/login" />} />
          {/* 演讲者视图：投屏时放在老师自己屏幕上，显示下一页与逐字稿 */}
          <Route path="/learn/:kpId/presenter" element={isLoggedIn ? <MobileGate><PresenterPage /></MobileGate> : <Navigate to="/login" />} />
          <Route path="/" element={isLoggedIn ? <AppLayout /> : <Navigate to="/login" />}>
            <Route index element={<DashboardPage />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="task-todo" element={user?.role === 'student' ? <TaskTodoPage /> : <Navigate to="/dashboard" />} />
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
            <Route path="question-bank/analytics" element={user?.role === 'admin' || user?.role === 'teacher' ? <QuestionBankAnalyticsPage /> : <Navigate to="/chat" />} />
            <Route path="exam" element={<ExamPage />} />
            <Route path="exam-compose/:examId" element={user?.role === 'admin' || user?.role === 'teacher' ? <ExamComposePage /> : <Navigate to="/exam" />} />
            <Route path="score" element={user?.role === 'student' ? <RewardPage /> : <ScorePage />} />
            <Route path="rollcall" element={<RequireRole roles={TA}><RollcallManagePage /></RequireRole>} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="announcements" element={<AnnouncementsPage />} />
            <Route path="portfolio" element={<PortfolioPage />} />
            <Route path="portfolio/:username" element={<PortfolioPage />} />
            <Route path="analytics" element={<RequireRole roles={TA}><AnalyticsPage /></RequireRole>} />
            <Route path="summary-export" element={<RequireRole roles={TA}><SummaryExportPage /></RequireRole>} />
            <Route path="interaction" element={<InteractionPage />} />
            <Route path="discussion" element={<DiscussionPage />} />
            <Route path="discussion-room/:groupId" element={<DiscussionRoomPage />} />
            <Route path="discussion-monitor/:discId" element={<RequireRole roles={TA}><DiscussionMonitorPage /></RequireRole>} />
            <Route path="student-exam-task" element={<StudentExamTaskPage />} />
            <Route path="curriculum" element={<CurriculumPage />} />
            <Route path="wrong-book" element={<WrongBookPage />} />
            <Route path="quest" element={user?.role === 'student' ? <QuestPage /> : <QuestAdminPage />} />
            <Route path="quest-records" element={user?.role === 'admin' || user?.role === 'teacher' ? <QuestAdminPage /> : <Navigate to="/chat" />} />
            <Route path="quick-quiz" element={<QuickQuizPage />} />
            <Route path="quick-quiz/lobby/:roomId" element={<QuickQuizLobby />} />
            <Route path="quick-quiz/play/:roomId" element={<QuickQuizPlay />} />
            <Route path="quick-quiz/console/:roomId" element={<RequireRole roles={TA}><QuickQuizConsole /></RequireRole>} />
            <Route path="quick-quiz/result/:roomId" element={<QuickQuizResult />} />
            <Route path="practice" element={<PracticePage />} />
            <Route path="code-practice" element={<CodePracticePage />} />
            <Route path="student-questions" element={<StudentQuestionsPage />} />
          <Route path="class-question" element={<RequireRole roles={TA}><ClassQuestionPage /></RequireRole>} />
          <Route path="class-ladder" element={<RequireRole roles={TA}><ClassLadderPage /></RequireRole>} />
            <Route path="quick-poll" element={<QuickPollPage />} />
            <Route path="class-summary" element={user?.role === 'admin' || user?.role === 'teacher' ? <ClassSummaryPage /> : <Navigate to="/chat" />} />
            <Route path="activity-monitor" element={user?.role === 'admin' || user?.role === 'teacher' ? <ActivityMonitorPage /> : <Navigate to="/chat" />} />
            <Route path="companion-settings" element={<CompanionSettings />} />
            <Route path="whiteboard" element={<WhiteboardPage />} />
            <Route path="explore" element={<ExploreCanvasPage />} />
            <Route path="explore/:canvasId" element={<ExploreWorkspacePage />} />
            <Route path="explore-share/:shareId" element={<ExploreShareViewPage />} />
            <Route path="daily-discovery" element={<DailyDiscoveryPage />} />
            <Route path="news-hub" element={<NewsHubPage />} />
            <Route path="daily-discovery-admin" element={<RequireRole roles={TA}><DailyDiscoveryAdminPage /></RequireRole>} />
            <Route path="news-admin" element={<RequireRole roles={TA}><NewsAdminPage /></RequireRole>} />
            <Route path="whiteboard-room/:roomId" element={<WhiteboardRoomPage />} />
            <Route path="portrait" element={<PortraitPage />} />
            <Route path="showcase" element={<ShowcasePage />} />
            <Route path="about" element={<AboutPage />} />
            <Route path="console" element={<RequireRole roles={['admin']}><AuthorPanelPage /></RequireRole>} />
          </Route>
          <Route path="/quest/battle/:questId" element={isLoggedIn ? <QuestBattlePage /> : <Navigate to="/login" />} />
          <Route path="/quest/result/:questId" element={isLoggedIn ? <QuestResultPage /> : <Navigate to="/login" />} />
          <Route path="*" element={<Navigate to="/login" />} />
        </Routes>
        </Suspense>
      )}
    </>
  )
}

export default App
