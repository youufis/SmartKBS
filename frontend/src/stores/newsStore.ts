/** 热点新闻状态管理 */
import { create } from 'zustand';
import * as newsApi from '../api/news';
import type {
  NewsArticle, NewsDetail, NewsBriefing, NewsFetchHealth, NewsRefreshResult,
} from '../api/news';

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

  refreshing: boolean;
  lastFetch: NewsFetchHealth | null;

  loadList: (category?: string, page?: number, opts?: { keyword?: string; unreadOnly?: boolean }) => Promise<boolean>;
  refreshNow: () => Promise<{ res: NewsRefreshResult | null; error: string }>;
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
  refreshing: false,
  lastFetch: null,
  stats: { todayViews: 0, todayPoints: 0, pointsMax: 3, totalViews: 0, totalFavorites: 0 },

  loadList: async (category, page = 1, opts) => {
    set({ loading: true });
    try {
      const res = await newsApi.getNewsList(category, page, 20, opts);
      set({
        articles: res.articles,
        total: res.total,
        lastFetch: res.last_fetch ?? get().lastFetch,
      });
      return true;
    } catch (e) {
      // 旧实现只 console.error 且不告知调用方，页面把"请求失败"当成"没有新闻"显示
      console.error('加载新闻列表失败', e);
      return false;
    } finally {
      set({ loading: false });
    }
  },

  /** NW11: 强制抓取 —— 后端同步抓完返回，这里再重读列表，确保用户看到的是新数据 */
  refreshNow: async () => {
    set({ refreshing: true });
    try {
      const res = await newsApi.refreshNews();
      if (res.last_fetch) set({ lastFetch: res.last_fetch });
      return { res, error: '' };
    } catch (e) {
      // 429 等带原因的失败把后端 detail 透出去（"请 X 秒后再试"对学生有用），其余归为网络错误
      console.error('强制刷新热点新闻失败', e);
      return { res: null, error: newsApi.apiErrorDetail(e) };
    } finally {
      set({ refreshing: false });
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
      // 乐观更新：列表与收藏就地改状态，不再整页重读（旧实现收藏一次闪一次屏、丢滚动位置）
      set((s) => {
        const articles = s.articles.map((a) => (a.id === newsId ? { ...a, is_favorited: !isFav } : a));
        let favorites: NewsArticle[];
        if (isFav) {
          favorites = s.favorites.filter((a) => a.id !== newsId);
        } else if (s.favorites.some((a) => a.id === newsId)) {
          favorites = s.favorites.map((a) => (a.id === newsId ? { ...a, is_favorited: true } : a));
        } else {
          const src = articles.find((a) => a.id === newsId);
          favorites = src ? [{ ...src, is_favorited: true }, ...s.favorites] : s.favorites;
        }
        return { articles, favorites };
      });
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
