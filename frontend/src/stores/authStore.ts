/** 认证状态管理 (Zustand) */
import { create } from 'zustand';
import type { User } from '../types';
import * as authApi from '../api/auth';
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
    useChatStore.getState().newTopic();
    useCompanionStore.getState().clearMessages();
    localStorage.removeItem('smartkb_token');
    localStorage.removeItem('smartkb_user');
    if (msg) localStorage.setItem('smartkb_kickout_msg', msg);
    set({ token: null, user: null, isLoggedIn: false, sessionRestoring: false });
  },

  logout: async () => {
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
        const user = await authApi.getMeWithTimeout(3000);
        if (user) {
          localStorage.setItem('smartkb_user', JSON.stringify(user));
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
