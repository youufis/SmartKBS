/** 热点新闻状态管理 */
import { create } from 'zustand';
import * as newsApi from '../api/news';
import type { NewsArticle, NewsDetail, NewsBriefing } from '../api/news';

interface NewsStore {
  articles: NewsArticle[];
  favorites: NewsArticle[];
  categories: string[];
  total: number;
  loading: boolean;
  stats: {
    todayViews: number;
    todayPoints: number;
    pointsMax: number;
    totalViews: number;
    totalFavorites: number;
  };

  loadList: (category?: string, page?: number) => Promise<void>;
  loadCategories: () => Promise<void>;
  loadFavorites: () => Promise<void>;
  getDetail: (newsId: number) => Promise<NewsDetail>;
  toggleFavorite: (newsId: number, isFav: boolean) => Promise<void>;
  loadStats: () => Promise<void>;
}

export const useNewsStore = create<NewsStore>((set, get) => ({
  articles: [],
  favorites: [],
  categories: [],
  total: 0,
  loading: false,
  stats: { todayViews: 0, todayPoints: 0, pointsMax: 3, totalViews: 0, totalFavorites: 0 },

  loadList: async (category, page = 1) => {
    set({ loading: true });
    try {
      const res = await newsApi.getNewsList(category, page);
      set({ articles: res.articles, total: res.total });
    } catch (e) {
      console.error('加载新闻列表失败', e);
    } finally {
      set({ loading: false });
    }
  },

  loadCategories: async () => {
    try {
      const res = await newsApi.getCategories();
      set({ categories: res.categories });
    } catch (e) {
      console.error('加载分类失败', e);
    }
  },

  loadFavorites: async () => {
    try {
      const res = await newsApi.getFavorites();
      set({ favorites: res.articles });
    } catch (e) {
      console.error('加载新闻收藏失败', e);
    }
  },

  getDetail: async (newsId) => {
    const data = await newsApi.getNewsDetail(newsId);
    // 更新统计
    if (data.points_awarded > 0) {
      set((s) => ({
        stats: {
          ...s.stats,
          todayViews: s.stats.todayViews + 1,
          todayPoints: s.stats.todayPoints + data.points_awarded,
        },
      }));
    }
    return data;
  },

  toggleFavorite: async (newsId, isFav) => {
    const action = isFav ? 'unfavorite' : 'favorite';
    try {
      await newsApi.toggleFavorite(newsId, action);
    } catch (e) {
      console.error('新闻收藏失败', e);
    }
  },

  loadStats: async () => {
    try {
      const res = await newsApi.getStats();
      set({
        stats: {
          todayViews: res.today_views,
          todayPoints: res.today_points,
          pointsMax: res.points_max,
          totalViews: res.total_views,
          totalFavorites: res.total_favorites,
        },
      });
    } catch (e) {
      console.error('加载新闻统计失败', e);
    }
  },
}));
