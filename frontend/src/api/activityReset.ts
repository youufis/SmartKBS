/** 活动数据重置 API（清空参与数据、保留活动内容） */
import apiClient from './client';

/** 一条会进界面的文本：code 供前端查 i18n 词典，text 为中文兜底，params 为插值参数 */
export interface ResetTextItem {
  code: string;
  text: string;
  params?: Record<string, string | number>;
}

/** 单个可选项（后端下发键与默认值，文案由前端 i18n 决定） */
export interface ResetOptionMeta {
  key: string;
  label: string;
  default: boolean;
}

/** 服务端下发的规则：能不能重置、要不要强制、要不要确认，前端不再自己算 */
export interface ResetPolicy {
  requires_force: boolean;
  requires_confirmation: boolean;
  /** 需要原样输入的确认口令（就是活动名称） */
  confirmation_expected: string;
  nothing_to_do: boolean;
}

/** 某一类活动的重置口径 */
export interface ResetScope {
  activity_type: string;
  /** 这一类活动在 i18n 词典里的键，由服务端给出，前端不维护映射表 */
  i18n_key?: string;
  label: string;
  /** 重置后仍保留的活动内容（key 供 i18n 查表，label 为后端中文回退） */
  keep_content: { key: string; label: string }[];
  clears: string[];
  options: ResetOptionMeta[];
  notes: ResetTextItem[];
}

/** 状态回滚计划；*_label 为后端中文兜底，前端优先用 i18n(statusValue.<枚举>) */
export interface StatusPlan {
  column: string;
  from: string;
  to: string;
  from_label?: string;
  to_label?: string;
  will_change?: boolean;
}

export interface ResetTargetRow {
  label: string;
  table: string;
  db: 'main' | 'qdb';
  count: number;
  student_count: number;
}

export interface ResetPreview {
  dry_run: boolean;
  policy: ResetPolicy;
  activity: {
    id: string | number;
    type: string;
    type_label: string;
    /** 词典键（activityMonitor.activityType.<key>） */
    type_i18n_key?: string;
    title: string;
    /** 剥掉 markdown 后的可读标题：界面正文与确认口令都以它为准 */
    title_plain?: string;
    creator: string;
    /** 创建者显示名（教师姓名），仅用于展示；权限判定仍用 creator 登录名 */
    creator_name?: string;
    status: string;
    status_label?: string;
    grade?: string;
  };
  options_effective: Record<string, boolean>;
  targets: ResetTargetRow[];
  rewards: { rows: number; points: number };
  notifications: number;
  wrong_book: number;
  students_affected: number;
  student_usernames: string[];
  student_preview: string[];
  status_reset: StatusPlan | null;
  total_rows: number;
  warnings: ResetTextItem[];
  in_progress: { count: number; label: string; code?: string };
}

/** 一条实际发生的删除回执 */
export interface DeletedRow {
  db: string;
  table: string;
  label: string;
  rows: number;
}

export interface ResetResult {
  ok: boolean;
  activity: ResetPreview['activity'];
  deleted: DeletedRow[];
  deleted_total: number;
  rewards_rows: number;
  rewards_points: number;
  notifications_rows: number;
  wrong_book_rows: number;
  status_reset: (StatusPlan & { unchanged?: boolean }) | null;
  students_affected: number;
  points_recomputed_students: number;
  runtime: string[];
  notified_students: number;
  finished_at: string;
}

/** scopes 基本不变，进程内缓存一次即可 */
let scopesCache: ResetScope[] | null = null;
let scopesPromise: Promise<ResetScope[]> | null = null;

export async function getResetScopes(force = false): Promise<ResetScope[]> {
  if (!force && scopesCache) return scopesCache;
  if (!scopesPromise) {
    scopesPromise = apiClient
      .get<{ types: ResetScope[] }>('/api/activity-reset/scopes')
      .then((res) => {
        scopesCache = res.data.types || [];
        return scopesCache;
      })
      .finally(() => {
        scopesPromise = null;
      });
  }
  return scopesPromise;
}

export function findScope(types: ResetScope[], activityType: string): ResetScope | null {
  return types.find((s) => s.activity_type === activityType) || null;
}

export async function previewReset(
  activityType: string,
  activityId: string | number,
  options: Record<string, boolean> = {},
): Promise<ResetPreview> {
  const { data } = await apiClient.post<ResetPreview>(
    `/api/activity-reset/preview/${activityType}/${encodeURIComponent(String(activityId))}`,
    { options },
  );
  return data;
}

export async function resetActivity(
  activityType: string,
  activityId: string | number,
  payload: {
    options?: Record<string, boolean>; force?: boolean; notify_students?: boolean;
    /** 服务端会校验：必须等于 preview 返回的 policy.confirmation_expected */
    confirm_text?: string;
  },
): Promise<ResetResult> {
  const { data } = await apiClient.post<ResetResult>(
    `/api/activity-reset/reset/${activityType}/${encodeURIComponent(String(activityId))}`,
    { options: {}, force: false, notify_students: true, confirm_text: '', ...payload },
  );
  return data;
}

export interface ResetLogItem {
  id: number;
  operator_username: string;
  activity_type: string;
  activity_id: string;
  activity_title: string;
  deleted_total: number;
  points_revoked: number;
  students_affected: number;
  admin_override: number;
  notified_students: number;
  created_at: string;
  type_label?: string;
}

export async function listResetLogs(params?: {
  activity_type?: string;
  limit?: number;
}): Promise<ResetLogItem[]> {
  const { data } = await apiClient.get<{ logs: ResetLogItem[] }>('/api/activity-reset/logs', { params });
  return data.logs || [];
}

/** 后端错误：{code,msg,params} 结构优先，旧版纯字符串 detail 也兼容 */
export interface ResetErrorInfo {
  /** 机器可读代码 -> activityMonitor.reset.err.<code>；空串表示后端没给代码 */
  code: string;
  /** 中文兜底文案（词典缺项时直接用，绝不会把键名漏到界面上） */
  msg: string;
  params: Record<string, string | number>;
}

/** 统一提取后端错误文案（FastAPI 的 detail 可能是字符串、{code,msg,params} 或校验数组）
 * msg 允许为空：由调用方按当前语言给最终兜底，这里不写死中文 */
export function resetErrorInfo(err: unknown): ResetErrorInfo {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return { code: '', msg: detail, params: {} };
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as { code?: unknown; msg?: unknown; params?: unknown };
    return {
      code: typeof d.code === 'string' ? d.code : '',
      msg: typeof d.msg === 'string' ? d.msg : '',
      params: d.params && typeof d.params === 'object'
        ? (d.params as Record<string, string | number>) : {},
    };
  }
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: string };
    return { code: '', msg: String(first?.msg || ''), params: {} };
  }
  return { code: '', msg: (err as Error)?.message || '', params: {} };
}
