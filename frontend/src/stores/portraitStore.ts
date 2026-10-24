/** AI 画像状态管理 (Zustand) */
import { create } from 'zustand';
import type { AvatarInfo, PeriodInfo, PortraitData, PortraitStyle } from '../api/portrait';
import * as portraitApi from '../api/portrait';
import { pollAiTask } from '../api/aiTask';
import i18n from '../i18n';

/** 状态层没有 hook，文案走 i18n 直取（与 submitGuard 同一做法） */
const tt = (key: string, opts?: Record<string, unknown>): string =>
  String(i18n.t(`score:${key}`, opts ?? {}));

interface PortraitStore {
  // 本期画像
  todayPortrait: PortraitData | null;
  todayExists: boolean;
  /** 本期是哪一段（周 / 月，后端按系统配置给出） */
  period: PeriodInfo | null;
  /** 本期已生成后再要一次的积分价（来自后端配置，前端不再硬编码 100） */
  extraPoints: number;
  /** 教职工每周期生成上限（null=后端未下发，视为不限制，不隐藏按钮） */
  staffMax: number | null;
  /** 本周期已生成几张（软删除不占额度，与后端 _count_period_portraits 同口径） */
  usedInPeriod: number;
  /** 当前头像（哪幅画像在当头像；null=还没取到） */
  avatar: AvatarInfo | null;
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
  fetchAvatar: () => Promise<void>;
  /** 返回 null=成功，字符串=后端给的失败原因 */
  setAvatar: (mode: AvatarInfo['mode'], portraitId?: number) => Promise<string | null>;
  fetchHistory: () => Promise<void>;
  fetchStyles: () => Promise<void>;
  generate: (style?: string, usePoints?: boolean) => Promise<{ portrait: PortraitData | null; message: string } | null>;
  /** 只补配图（生图失败时用；不占额度、不扣积分） */
  retryImage: (id: number) => Promise<string | null>;
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
  period: null,
  extraPoints: 100,
  staffMax: null,
  usedInPeriod: 0,
  avatar: null,
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
        period: res.period || null,
        extraPoints: res.cost?.extra_points ?? get().extraPoints,
        staffMax: res.cost?.staff_max ?? null,
        usedInPeriod: res.cost?.used ?? 0,
        loading: false,
      });
    } catch (e: any) {
      set({ loading: false, error: e?.message || tt('loadPortraitFailed') });
    }
  },

  fetchAvatar: async () => {
    try {
      const res = await portraitApi.getAvatarInfo();
      set({ avatar: res.avatar });
    } catch {
      // 静默：头像取不到不影响画像页
    }
  },

  setAvatar: async (mode, portraitId = 0) => {
    try {
      const res = await portraitApi.setAvatar(mode, portraitId);
      set({ avatar: res.avatar });
      return null;
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || tt('setAvatarFailed');
      set({ error: msg });
      return msg;
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

  generate: async (style = 'random', usePoints = false) => {
    set({ generating: true, error: null });
    try {
      // P-5: 后端已改后台任务 —— 先创建任务，再轮询；出图/落库都在任务体里
      const res = await portraitApi.generatePortrait(style, usePoints);
      const out: any = await pollAiTask(res.task_id, 300000);
      set({ generating: false });
      if (!out || out.error) {
      const msg = out?.error || tt('generateTimeoutHint');
        set({ error: msg });
        // 超时不代表失败（后端可能已出图），仍刷新一次
        await get().fetchToday();
        return { portrait: null, message: msg };
      }
      const portrait: PortraitData = out.portrait || null;
      set({ todayPortrait: portrait, todayExists: !!portrait });
      await get().fetchToday();
      get().fetchHistory();
      return { portrait, message: out.message || '生成完成' };
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || tt('generateFailed');
      set({ generating: false, error: msg });
      return { portrait: null, message: msg };
    }
  },

  retryImage: async (id: number) => {
    try {
      const res = await portraitApi.retryPortraitImage(id);
      await get().fetchToday();
      get().fetchHistory();
      return res.message || '配图已补上';
    } catch (e: any) {
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
