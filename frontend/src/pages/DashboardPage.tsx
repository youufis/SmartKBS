/**
 * 首页看板入口：按角色分发到学生端 / 教师·管理员端
 * 具体实现见 ./dashboard/ 目录
 */
import React from 'react'
import { useAuthStore } from '../stores/authStore'
import StudentDashboard from './dashboard/StudentDashboard'
import TeacherDashboard from './dashboard/TeacherDashboard'

const DashboardPage: React.FC = () => {
  const role = useAuthStore((s) => s.user?.role)
  if (role === 'student') return <StudentDashboard />
  return <TeacherDashboard isAdmin={role === 'admin'} />
}

export default DashboardPage
