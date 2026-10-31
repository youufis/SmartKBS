/** 讲演画面主题：只影响幻灯片配色，不动整站主题。
    深墨那套专为暗光教室准备（投影偏亮时反白更清楚）。 */
export type CastTheme = 'white' | 'warm' | 'ink' | 'forest';

export interface CastThemeOption {
  id: CastTheme;
  name: string;
  /** 色块预览用的底色 */
  dot: string;
}

export const CAST_THEMES: CastThemeOption[] = [
  { id: 'white', name: '清晰白', dot: '#ffffff' },
  { id: 'warm', name: '暖米', dot: '#fdf8f1' },
  { id: 'ink', name: '深墨', dot: '#1b1f26' },
  { id: 'forest', name: '淡青', dot: '#f3f7f4' },
];

export const CAST_THEME_KEY = 'smartkb_cast_theme';

export function normalizeTheme(v: string | null | undefined): CastTheme {
  return CAST_THEMES.some((t) => t.id === v) ? (v as CastTheme) : 'white';
}

export function loadTheme(): CastTheme {
  try {
    return normalizeTheme(localStorage.getItem(CAST_THEME_KEY));
  } catch {
    return 'white';
  }
}

export function saveTheme(t: CastTheme): void {
  try {
    localStorage.setItem(CAST_THEME_KEY, t);
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}
