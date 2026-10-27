/** 资源共享 API */
import apiClient from './client';

export interface ShareItem {
  id: number;
  owner_username: string;
  file_path: string;
  file_name: string;
  resource_type: 'html' | 'download';
  share_scope: 'all' | 'teacher' | 'staff' | 'class';
  target_users: string;
  /** 指定教师/管理员共享时，target_users 解析出来的姓名（卡片直接列出是谁） */
  target_user_names?: string[];
  target_grade: string;
  target_class: string;
  created_at: string;
  url_path?: string;
  /** 共享者真实姓名（后端 join users 得到，缺省回退账号） */
  owner_name?: string;
  /** 共享者角色：0 管理员 / 1 教师 / 2 学生 */
  owner_role?: number | null;
  /** 当前用户最近一次查看时间，null = 未看 */
  viewed_at?: string | null;
  /** 该资源被查看总次数 */
  view_count?: number;
  /** 所有人合计的浏览次数（「我共享的」这一栏关心的是有多少学生看过这份） */
  total_view_count?: number;
  /** 绑定的课程名（取第一个绑定） */
  course_name?: string;
  /** 绑定的知识点名（取第一个绑定） */
  kp_name?: string;
  /** 绑定知识点数量 */
  binding_count?: number;
  /** 目录型共享：一个共享指向整个文件夹（接收方点进去浏览而不是直接下载） */
  is_dir?: boolean;
  /** 目录内文件数 / 该共享条目总大小（字节）；仅 download 类型返回 */
  file_count?: number;
  total_size?: number;
  /** 内容小类（动画讲解/章节练习/播客…）：仅 html 类型返回，与「课程 -> 绑定资源」同一套口径 */
  sub_kind?: string;
  /** 同一物理文件被多人各共享一次时合并展示的行数（>1 表示还有别人也共享了这份） */
  share_count?: number;
  /** 除保留行之外，还共享了这份文件的人（显示名） */
  shared_by?: string[];
}

export interface ShareRequest {
  file_path: string;
  file_name: string;
  resource_type: 'html' | 'download';
  share_scope: 'all' | 'teacher' | 'staff' | 'class';
  target_users?: string[];
  target_grades?: string[];
  target_classes?: string[];
  /** 'replace' 覆盖 / 'append' 追加 / 'remove' 移除 */
  mode?: 'replace' | 'append' | 'remove';
  /**
   * 要修改的共享记录主键。
   * 编辑已有共享（含管理员代管同事的共享）必须传：后端旧实现一律按「当前登录名」当属主去找行，
   * 管理员改别人创建的共享必然匹配不到 -> 404「未找到现有共享记录，无法移除」。
   */
  share_id?: number;
}

export interface UserItem {
  username: string;
  name: string;
  role: string;
  grade: string;
  class: string;
}

/** 共享一个资源 */
export async function shareResource(body: ShareRequest): Promise<{ message: string }> {
  const { data } = await apiClient.post('/api/sharing/share', body);
  return data;
}

/** 取消共享 */
export async function unshareResource(id: number): Promise<{ message: string }> {
  const { data } = await apiClient.delete('/api/sharing/share', { params: { id } });
  return data;
}

/**
 * 获取我创建的共享（默认只含我自己名下的行）。
 * @param allShares 仅管理员排障用：要全站清单时显式打开，界面默认不传
 */
export async function getMyShares(allShares = false): Promise<{ shares: ShareItem[] }> {
  const { data } = await apiClient.get('/api/sharing/my-shares', { params: { all_shares: allShares } });
  return data;
}

/**
 * 获取共享给我的资源（= 别人共享给我的；自己共享出去的不在这个列表里）。
 * @param includeSelf 管理员要看全量（含自己共享的）时打开
 */
export async function getReceivedShares(includeSelf = false): Promise<{ shares: ShareItem[] }> {
  const { data } = await apiClient.get('/api/sharing/received', { params: { include_self: includeSelf } });
  return data;
}
