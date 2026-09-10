/** 认证状态管理 (Zustand) */
import { create } from 'zustand';
import type { User } from '../types';
import * as authApi from '../api/auth';
import { resetAuthFailureGuard, AUTH_TOKEN_RENEWED_EVENT } from '../api/client';
import { stopAllPollers } from '../utils/poller';
import { useChatStore } from './chatStore';
import { useCompanionStore } from './companionStore';

interface AuthStore {
  token: string | null;
  user: User | null;
  isLoggedIn: boolean;
  onlineCount: number;
  sessionRestoring: boolean;

  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  forceLogout: (msg?: string) => void;
  restoreSession: () => Promise<void>;
  fetchOnlineCount: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()((set) => ({
  token: null,
  user: null,
  isLoggedIn: false,
  onlineCount: 0,
  sessionRestoring: true,  // 初始为 true，防止登录页闪烁

  login: async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    resetAuthFailureGuard();   // 重新登录后，下一次会话失效要能再次提示
    localStorage.setItem('smartkb_token', res.token);
    localStorage.setItem('smartkb_user', JSON.stringify(res.user));
    // 切换账号时清空旧对话
    useChatStore.getState().newTopic();
    set({
      token: res.token,
      user: res.user,
      isLoggedIn: true,
      sessionRestoring: false,
    });
  },

  forceLogout: (msg?: string) => {
    stopAllPollers();
    useChatStore.getState().newTopic();
    useCompanionStore.getState().clearMessages();
    localStorage.removeItem('smartkb_token');
    localStorage.removeItem('smartkb_user');
    if (msg) localStorage.setItem('smartkb_kickout_msg', msg);
    set({ token: null, user: null, isLoggedIn: false, sessionRestoring: false });
  },

  logout: async () => {
    stopAllPollers();
    try {
      await authApi.logout();
    } catch {
      // 忽略
    }
    // 退出时清空对话
    useChatStore.getState().newTopic();
    useCompanionStore.getState().clearMessages();
    localStorage.removeItem('smartkb_token');
    localStorage.removeItem('smartkb_user');
    set({ token: null, user: null, isLoggedIn: false });
  },

  restoreSession: async () => {
    const token = localStorage.getItem('smartkb_token');
    const userStr = localStorage.getItem('smartkb_user');
    if (token && userStr) {
      try {
        // 用短超时快速验证 token（3秒，避免后端不可达时卡死）
        // skipAuthHandler: 这里失败由本函数静默处理（不该弹"登录已过期"）
        const user = await authApi.getMeWithTimeout(3000, { skipAuthHandler: true });
        if (user) {
          localStorage.setItem('smartkb_user', JSON.stringify(user));
          resetAuthFailureGuard();
          set({ token, user, isLoggedIn: true, sessionRestoring: false });
          return;
        }
      } catch {
        // token 无效或后端不可达，忽略
      }
    }
    localStorage.removeItem('smartkb_token');
    localStorage.removeItem('smartkb_user');
    set({ token: null, user: null, isLoggedIn: false, sessionRestoring: false });
  },

  fetchOnlineCount: async () => {
    try {
      const count = await authApi.getOnlineCount();
      set({ onlineCount: count });
    } catch {
      // 忽略
    }
  },
}));

// 后端 401 之外的另一件事：令牌滑动续期只换 token 不换身份，同步一下 state 即可
if (typeof window !== 'undefined') {
  window.addEventListener(AUTH_TOKEN_RENEWED_EVENT, (e) => {
    const token = (e as CustomEvent<string>).detail;
    if (token && useAuthStore.getState().isLoggedIn) {
      useAuthStore.setState({ token });
    }
  });
}
