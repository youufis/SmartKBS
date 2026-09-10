/** Axios 实例 + JWT 拦截器（携带令牌 / 滑动续期 / 401 统一收敛） */
import axios from 'axios';
import type { AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { stopAllPollers, TOKEN_STORAGE_KEY } from '../utils/poller';

export const USER_STORAGE_KEY = 'smartkb_user';

/** 后端滑动续期下发新令牌的响应头（backend/middleware.py: RENEW_HEADER） */
const RENEW_HEADER = 'x-renew-token';

/** 与 backend/auth_errors.py 保持一致的 401 原因码 */
export type AuthErrorCode =
  | 'auth_missing'
  | 'token_expired'
  | 'token_invalid'
  | 'token_stale'
  | 'account_missing';

/** 会话失效广播事件：App.tsx 监听后统一 forceLogout + 跳登录页 */
export const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';
/** 令牌被后端滑动续期（App 启动后长时间挂机不掉线） */
export const AUTH_TOKEN_RENEWED_EVENT = 'auth:token-renewed';

export interface UnauthorizedDetail {
  code: AuthErrorCode | 'unknown';
  /** 给用户看的一句话（后端 detail 优先） */
  message: string;
  /** true = 被同账号在其他设备登录顶下线 */
  kicked: boolean;
  /** 触发本次失效的请求，便于排查 */
  source?: string;
}

/** 这些接口返回的 401 属于"业务答案"而不是"会话失效"，不能触发跳登录 */
const NOT_A_SESSION_401 = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/verify-security',
  '/api/auth/reset-password-by-security',
  '/api/auth/security-check/',
];

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 该请求的 401 不触发全局"停轮询+跳登录"（如启动时静默校验 session） */
    skipAuthHandler?: boolean;
  }
}

const apiClient = axios.create({
  baseURL: '/',
  timeout: 30000,
});

// ── 401 只处理一次：进登录页前，同轮的多个并发请求不再重复广播 ──
let handlingUnauthorized = false;

/** 登录成功 / session 校验通过后调用，让下一次真失效能重新提示 */
export function resetAuthFailureGuard(): void {
  handlingUnauthorized = false;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const carrier = headers as { get?: (key: string) => unknown };
  const raw = typeof carrier.get === 'function' ? carrier.get(name) : (headers as Record<string, unknown>)[name];
  return typeof raw === 'string' && raw ? raw : undefined;
}

/** 后端滑动续期：把新令牌写回 localStorage，业务侧（WS/SSE/下载）读的都是它 */
function adoptRenewedToken(response: AxiosResponse | undefined): void {
  const renewed = readHeader(response?.headers, RENEW_HEADER);
  if (!renewed || !getToken()) return;   // 未登录时不无中生有地保存令牌
  if (renewed === getToken()) return;
  localStorage.setItem(TOKEN_STORAGE_KEY, renewed);
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_RENEWED_EVENT, { detail: renewed }));
}

// 请求拦截器：自动添加 JWT（每次都现读 localStorage，续期后立即生效）
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    } else if (typeof config.headers?.delete === 'function') {
      // 凭证已被清掉时别再带上残留的 Authorization，否则每轮请求都白挨一次 401
      config.headers.delete('Authorization');
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error)
);

// 响应拦截器：滑动续期收新令牌；401 一律"停轮询 + 清凭证 + 广播跳登录"
apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    adoptRenewedToken(response);
    return response;
  },
  (error: AxiosError) => {
    adoptRenewedToken(error.response);
    if (error.response?.status === 401) {
      handleUnauthorized(error);
    }
    return Promise.reject(error);
  }
);

function handleUnauthorized(error: AxiosError): void {
  const config = error.config as InternalAxiosRequestConfig | undefined;
  const url = config?.url || '';
  if (config?.skipAuthHandler) return;
  if (NOT_A_SESSION_401.some((path) => url.includes(path))) return;

  const data = error.response?.data as
    | { code?: unknown; detail?: unknown }
    | undefined;
  const code = typeof data?.code === 'string' ? (data.code as AuthErrorCode) : 'unknown';
  const detail = typeof data?.detail === 'string' ? data.detail : '';

  // 老后端/反代直接吐 401 时没有 code，按"未登录"兜底处理
  const kicked =
    code === 'token_stale' ||
    detail.includes('已在其他地方登录') ||
    detail.includes('其他设备登录') ||
    detail.includes('已在其他设备登录');
  const message =
    (kicked ? '您的账号已在其他设备登录，您已下线' : '') ||
    detail ||
    '登录已过期，请重新登录';

  // 关键一步：先把所有轮询停掉，避免"每 30 秒三连发 401"刷屏
  stopAllPollers();

  if (handlingUnauthorized) return;
  handlingUnauthorized = true;

  localStorage.removeItem(TOKEN_STORAGE_KEY);
  localStorage.removeItem(USER_STORAGE_KEY);

  const payload: UnauthorizedDetail = { code, message, kicked, source: url };
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT, { detail: payload }));
}

export default apiClient;
