/**
 * 移动端导航白名单（地基 B2）。
 *
 * 与 docs/mobile-adaptation-plan.md 的"首批范围·缩水版 B"一致：
 * 只有首批适配范围内的页面在手机上开放；其余管理重页面在手机端
 * 从菜单隐藏、直访显示"请用电脑端"引导页。桌面端完全不受影响。
 */

/** 学生端：首批适配路由（前缀匹配，/quick-quiz 覆盖 lobby/play/result） */
const STUDENT_ALLOWED = [
  '/dashboard',
  '/chat',
  '/wrong-book',
  '/daily-discovery',
  '/news-hub',
  '/notifications',
  '/announcements',
  '/student-questions',
  '/quick-quiz',
  // ── 第二批 A 档：补首页卡片已暴露的死胡同入口 ──
  '/task-todo',            // 首页「任务清单 N」徽标
  '/score',                // 首页「我的积分 / 称号」（学生侧为 RewardPage）
  '/exam',                 // 首页「待完成考试 / 考试成绩」（教师侧考试管理仍不开放）
  '/portrait',             // 首页「AI 周画像」
  '/companion-settings',   // 学伴设置
]

/** 教师/管理员端：首批仅轻场景（题库/组卷/用户管理等保持桌面专属） */
const STAFF_ALLOWED = [
  '/dashboard',
  '/chat',
  '/notifications',
  '/announcements',
  '/student-questions',
]

/**
 * 当前路径在手机端是否允许渲染真实页面。
 * '/'（index 即 dashboard）恒放行；命中白名单的路由及子路径放行。
 */
export function isMobileAllowedPath(role: string | undefined, path: string): boolean {
  if (path === '/') return true
  const list = role === 'student' ? STUDENT_ALLOWED : STAFF_ALLOWED
  return list.some((r) => path === r || path.startsWith(r + '/'))
}
