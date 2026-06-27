/** 自我画像状态管理 (Zustand) */
import { create } from 'zustand';
import type { PortraitData, PortraitStyle } from '../api/portrait';
import * as portraitApi from '../api/portrait';

interface PortraitStore {
  // 今日画像
  todayPortrait: PortraitData | null;
  todayExists: boolean;
  // 历史列表
  historyList: PortraitData[];
  // 画廊
  publicGallery: PortraitData[];
  classGallery: PortraitData[];
  hotGallery: PortraitData[];
  // 风格列表
  styles: PortraitStyle[];
  // 状态
  loading: boolean;
  generating: boolean;
  error: string | null;

  // 动作
  fetchToday: () => Promise<void>;
  fetchHistory: () => Promise<void>;
  fetchStyles: () => Promise<void>;
  generate: (style?: string) => Promise<PortraitData | null>;
  toggleLike: (id: number) => Promise<{ action: string; count: number } | null>;
  share: (id: number, scope: string) => Promise<void>;
  unshare: (id: number) => Promise<void>;
  deletePortrait: (id: number) => Promise<void>;
  fetchPublicGallery: () => Promise<void>;
  fetchClassGallery: () => Promise<void>;
  fetchHotGallery: () => Promise<void>;
}

export const usePortraitStore = create<PortraitStore>()((set, get) => ({
  todayPortrait: null,
  todayExists: false,
  historyList: [],
  publicGallery: [],
  classGallery: [],
  hotGallery: [],
  styles: [],
  loading: false,
  generating: false,
  error: null,

  fetchToday: async () => {
    set({ loading: true, error: null });
    try {
      const res = await portraitApi.getTodayPortrait();
      set({
        todayExists: res.exists,
        todayPortrait: res.portrait || null,
        loading: false,
      });
    } catch (e: any) {
      set({ loading: false, error: e?.message || '获取今日画像失败' });
    }
  },

  fetchHistory: async () => {
    try {
      const res = await portraitApi.listPortraits();
      set({ historyList: res.portraits });
    } catch {
      // 静默
    }
  },

  fetchStyles: async () => {
    try {
      const res = await portraitApi.getPortraitStyles();
      set({ styles: res.styles });
    } catch {
      // 静默
    }
  },

  generate: async (style = 'random') => {
    set({ generating: true, error: null });
    try {
      const res = await portraitApi.generatePortrait(style);
      set({
        todayPortrait: res.portrait,
        todayExists: true,
        generating: false,
      });
      // 刷新历史列表
      get().fetchHistory();
      return res.portrait;
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || '生成失败';
      set({ generating: false, error: msg });
      return null;
    }
  },

  toggleLike: async (id: number) => {
    try {
      const res = await portraitApi.toggleLike(id);
      // 更新本地状态
      const update = (list: PortraitData[]) =>
        list.map((p) => (p.id === id ? { ...p, liked: res.action === 'liked', like_count: res.count } : p));

      set((state) => ({
        todayPortrait: state.todayPortrait?.id === id
          ? { ...state.todayPortrait, liked: res.action === 'liked', like_count: res.count }
          : state.todayPortrait,
        historyList: update(state.historyList),
        publicGallery: update(state.publicGallery),
        classGallery: update(state.classGallery),
        hotGallery: update(state.hotGallery),
      }));
      return res;
    } catch {
      return null;
    }
  },

  share: async (id: number, scope: string) => {
    await portraitApi.sharePortrait(id, scope);
    // 同步更新今日画像和列表的状态
    set((state) => ({
      todayPortrait: state.todayPortrait?.id === id
        ? { ...state.todayPortrait, is_shared: 1, share_scope: scope }
        : state.todayPortrait,
      historyList: state.historyList.map((p) =>
        p.id === id ? { ...p, is_shared: 1, share_scope: scope } : p,
      ),
    }));
    get().fetchHistory();
  },

  unshare: async (id: number) => {
    await portraitApi.unsharePortrait(id);
    // 同步更新今日画像和列表的状态
    set((state) => ({
      todayPortrait: state.todayPortrait?.id === id
        ? { ...state.todayPortrait, is_shared: 0, share_scope: 'private', like_count: 0 }
        : state.todayPortrait,
      historyList: state.historyList.map((p) =>
        p.id === id ? { ...p, is_shared: 0, share_scope: 'private', like_count: 0 } : p,
      ),
    }));
    get().fetchHistory();
  },

  deletePortrait: async (id: number) => {
    await portraitApi.deletePortrait(id);
    set((state) => ({
      historyList: state.historyList.filter((p) => p.id !== id),
      todayPortrait: state.todayPortrait?.id === id ? null : state.todayPortrait,
      todayExists: state.todayPortrait?.id === id ? false : state.todayExists,
    }));
  },

  fetchPublicGallery: async () => {
    try {
      const res = await portraitApi.getPublicGallery();
      set({ publicGallery: res.portraits });
    } catch {
      // 静默
    }
  },

  fetchClassGallery: async () => {
    try {
      const res = await portraitApi.getClassGallery();
      set({ classGallery: res.portraits });
    } catch {
      // 静默
    }
  },

  fetchHotGallery: async () => {
    try {
      const res = await portraitApi.getHotGallery();
      set({ hotGallery: res.portraits });
    } catch {
      // 静默
    }
  },
}));
