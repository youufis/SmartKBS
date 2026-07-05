/** 每日精选状态管理 */
import { create } from 'zustand';
import * as discoveryApi from '../api/dailyDiscovery';
import type { DiscoveryCard, DiscoveryResponse } from '../api/dailyDiscovery';

interface DiscoveryStore {
  cards: DiscoveryCard[];
  favorites: DiscoveryCard[];
  loading: boolean;
  stats: {
    viewCount: number;
    refreshRemaining: number;
    pointsEarned: number;
    pointsMax: number;
  };
  poolSize: number;

  loadFeed: () => Promise<void>;
  refreshCards: () => Promise<void>;
  toggleFavorite: (cardId: number, isFav: boolean) => Promise<void>;
  loadFavorites: () => Promise<void>;
  recordView: (cardId: number) => Promise<number>;
}

export const useDiscoveryStore = create<DiscoveryStore>((set, get) => ({
  cards: [],
  favorites: [],
  loading: false,
  stats: { viewCount: 0, refreshRemaining: 3, pointsEarned: 0, pointsMax: 5 },
  poolSize: 0,

  loadFeed: async () => {
    set({ loading: true });
    try {
      const res = await discoveryApi.getFeed();
      set({
        cards: res.cards,
        poolSize: res.pool_size,
        stats: {
          viewCount: res.today_view_count,
          refreshRemaining: res.refresh_remaining,
          pointsEarned: res.today_points_earned,
          pointsMax: res.today_points_max,
        },
      });
    } catch (e) {
      console.error('加载每日精选失败', e);
    } finally {
      set({ loading: false });
    }
  },

  refreshCards: async () => {
    set({ loading: true });
    try {
      const res = await discoveryApi.refreshFeed();
      set({
        cards: res.cards,
        poolSize: res.pool_size,
        stats: {
          viewCount: res.today_view_count,
          refreshRemaining: res.refresh_remaining,
          pointsEarned: res.today_points_earned,
          pointsMax: res.today_points_max,
        },
      });
    } catch (e: any) {
      throw e;
    } finally {
      set({ loading: false });
    }
  },

  toggleFavorite: async (cardId, isFav) => {
    const action = isFav ? 'unfavorite' : 'favorite';
    try {
      await discoveryApi.toggleFavorite(cardId, action);
      set((s) => ({
        cards: s.cards.map((c) =>
          c.id === cardId ? { ...c, is_favorited: !isFav } : c
        ),
      }));
    } catch (e) {
      console.error('收藏操作失败', e);
    }
  },

  loadFavorites: async () => {
    try {
      const res = await discoveryApi.getFavorites();
      set({ favorites: res.cards });
    } catch (e) {
      console.error('加载收藏失败', e);
    }
  },

  recordView: async (cardId) => {
    try {
      const res = await discoveryApi.recordView(cardId);
      if (res.points_awarded > 0) {
        set((s) => ({
          stats: {
            ...s.stats,
            viewCount: s.stats.viewCount + 1,
            pointsEarned: s.stats.pointsEarned + res.points_awarded,
          },
        }));
      }
      return res.points_awarded;
    } catch {
      return 0;
    }
  },
}));
