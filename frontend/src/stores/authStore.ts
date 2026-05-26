/** 认证状态管理 (Zustand) */
import { create } from 'zustand';
import type { User } from '../types';
import * as authApi from '../api/auth';
import { useChatStore } from './chatStore';

interface AuthStore {
  token: string | null;
  user: User | null;
  isLoggedIn: boolean;
  onlineCount: number;

  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  restoreSession: () => void;
  fetchOnlineCount: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()((set) => ({
  token: null,
  user: null,
  isLoggedIn: false,
  onlineCount: 0,

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
    });
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // 忽略
    }
    // 退出时清空对话
    useChatStore.getState().newTopic();
    localStorage.removeItem('smartkb_token');
    localStorage.removeItem('smartkb_user');
    set({ token: null, user: null, isLoggedIn: false });
  },

  restoreSession: () => {
    const token = localStorage.getItem('smartkb_token');
    const userStr = localStorage.getItem('smartkb_user');
    if (token && userStr) {
      try {
        const user = JSON.parse(userStr) as User;
        set({ token, user, isLoggedIn: true });
      } catch {
        localStorage.removeItem('smartkb_token');
        localStorage.removeItem('smartkb_user');
      }
    }
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
