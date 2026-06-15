/** Axios 实例 + JWT 拦截器 */
import axios from 'axios';
import type { AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';

const apiClient = axios.create({
  baseURL: '/',
  timeout: 30000,
});

// 请求拦截器：自动添加 JWT
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = localStorage.getItem('smartkb_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error)
);

// 响应拦截器：401 时处理 token 失效/异地登录
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      const detail = (error.response.data as any)?.detail || ''
      const isKicked = detail.includes('已在其他地方登录')
      localStorage.removeItem('smartkb_token');
      localStorage.removeItem('smartkb_user');
      if (isKicked) {
        // 触发自定义事件，由 App.tsx 处理导航（避免 window.location.href 全页刷新）
        window.dispatchEvent(new CustomEvent('auth:kickout', {
          detail: '您的账号已在其他设备登录，您已下线',
        }))
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
