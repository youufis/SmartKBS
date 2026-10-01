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
  // ── 第二批 B 档：刷题与课堂活动 ──
  '/quest',                // 知识闯关（学生侧 QuestPage；教师侧闯关管理仍不开放）
  '/practice',             // 同步练习
  '/interaction',          // 课堂互动（随堂测验参与）
  '/quick-poll',           // 课堂投票参与
  '/downloads',            // 文件中心
  // ── 第二批 D 档：成长档案与风采 ──
  '/portfolio',            // 成长档案（/portfolio/:username 查看他人）
  '/showcase',             // 风采展示
  // ── E 档：资源浏览与说明页（分组讨论因下级 /discussion-room 未开放、暂不列入） ──
  '/html-files',           // 我的 HTML 资源
  '/shared-center',        // 资源中心（HTML资源/文件中心/资源管理 三合一）
  '/about',                // 关于平台
]

/** 教师/管理员端：首批仅轻场景（题库/组卷/用户管理等保持桌面专属） */
const STAFF_ALLOWED = [
  '/dashboard',
  '/chat',
  '/notifications',
  '/announcements',
  '/student-questions',
  '/downloads',          // 文件中心：教师取用资料，轻场景
  // ── 第二批 C 档：教师移动轻只读（看数据、走审批，不做重管理） ──
  '/class-summary',      // AI 课堂总结
  '/analytics',          // 学情分析（只读）
  '/portrait',           // 班级/AI 画像（教师侧同样使用，首页有入口）
  '/tasks',              // 对话作业：批改结果确认与发布
  '/score',              // 课堂积分查看
  // ── 第二批 D 档：成长档案与风采 ──
  '/portfolio',
  '/showcase',
  // ── E 档候选（实测后再定去留）──
  '/html-files',
  '/shared-center',
  '/resource-mgmt',        // 资源管理（无表格，浏览型）
  '/about',
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
