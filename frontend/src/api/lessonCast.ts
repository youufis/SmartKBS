/** AI 讲演（LessonCast）API —— 知识点 → 分页大纲 → 逐句音频 → 播放数据 */
import apiClient from './client';
import { pollAiTaskWithProgress, type AiTaskProgress } from './aiTask';

export type SpeakerMode = 'single' | 'duo';

/** 一个音频段 = 一句台词。**一句一段**才能在字幕上高亮到句、也才能单句重录。 */
export interface CastSegment {
  speaker: 'A' | 'B';
  text: string;
  url: string;
  seconds: number;
}

export type CastLayout =
  | 'cover' | 'bullets' | 'compare' | 'steps' | 'cards' | 'figure' | 'formula' | 'summary';

export interface CastSide {
  head: string;
  items: string[];
}

/** 参数化图形：坐标由前端算，AI 只给结构与数值（这样不会画歪、也能跟着主题变色） */
export type CastFigureKind = 'flow' | 'bars' | 'tree' | 'svg';

export interface CastFigureStep {
  label: string;
  note?: string;
}

export interface CastFigureItem {
  label: string;
  value: number;
}

export interface CastFigure {
  kind: CastFigureKind;
  caption?: string;
  /** flow */
  steps?: CastFigureStep[];
  direction?: 'h' | 'v';
  /** bars */
  items?: CastFigureItem[];
  unit?: string;
  /** tree */
  root?: string;
  children?: CastFigureStep[];
  /** svg：后端已 sanitize + is_usable_svg 校验，为空表示这张图被丢弃 */
  svg?: string;
}

/** 一句台词。warn=true 表示原文含公式符号、已转成口语，建议老师改写 */
export interface CastLine {
  speaker: 'A' | 'B';
  text: string;
  warn?: boolean;
}

export interface CastPage {
  layout: CastLayout;
  title: string;
  kicker?: string;
  subtitle?: string;
  points?: string[];
  left?: CastSide;
  right?: CastSide;
  steps?: [string, string][];
  cards?: [string, string][];
  /** 整页公式（LaTeX 本体，不带 $ 定界符） */
  formula?: string;
  formulaNote?: string;
  figure?: CastFigure;
  /** 旧数据兼容：单张图片 */
  image?: string;
  caption?: string;
  lines?: CastLine[];
  audio: CastSegment[];
}

export interface CastVoice {
  voice: string;
  name: string;
  label: string;
  gender: string;
}

export interface CastMeta {
  tts_enabled: boolean;
  duration_options: number[];
  default_minutes: number;
  max_seconds: number;
  max_pages: number;
  speaker_modes: SpeakerMode[];
  voices: { A: CastVoice; B: CastVoice };
  can_manage: boolean;
  /** 该知识点已有的讲演版本：{ duo: {id, status}, single: {...} } */
  has_cast: Partial<Record<SpeakerMode, { id: number; status: string }>>;
}

export interface CastDetail {
  id: number;
  kp_id: number;
  speaker_mode: SpeakerMode;
  title: string;
  summary: string;
  name_a: string;
  name_b: string;
  voice_a: string;
  voice_b: string;
  minutes: number;
  total_seconds: number;
  status: 'draft' | 'audio_ready' | 'published';
  version: number;
  /** 大纲改过但音频还是旧的 */
  stale: boolean;
  pages: CastPage[];
  updated_at: string;
}

export interface CastPlayback {
  cast_id: number;
  page_idx: number;
  seg_idx: number;
  pos: number;
  done_pages: number[];
}

export interface GetCastResult {
  exists: boolean;
  kp_id: number;
  mode?: SpeakerMode;
  fallback?: boolean;
  available_modes?: SpeakerMode[];
  cast?: CastDetail;
  playback?: CastPlayback | null;
}

export interface OutlineResult {
  cast_id: number;
  kp_id: number;
  kp_name: string;
  speaker_mode: SpeakerMode;
  minutes: number;
  title: string;
  summary: string;
  name_a: string;
  name_b: string;
  pages: CastPage[];
  key_points: string[];
  plan_hash: string;
  target_chars: number;
  target_pages: number;
  voices: { A: CastVoice; B: CastVoice };
}

/** 元信息：总闸状态、档位、风格、音色。入口置灰与弹窗默认值都以此为准。 */export async function getCastMeta(kpId?: number): Promise<CastMeta> {
  const { data } = await apiClient.get('/api/curriculum/lesson-cast/meta', {
    params: kpId ? { kp_id: kpId } : undefined,
  });
  return data;
}

export interface CastBrief {
  id: number;
  status: string;
  minutes: number;
  total_seconds: number;
}

/** kp_id(字符串) → { duo?: CastBrief, single?: CastBrief } */
export type CastBatch = Record<string, Partial<Record<SpeakerMode, CastBrief>>>;

/** 批量查"哪些知识点已经有讲演"：课程页行内播放按钮据此显示 */
export async function getCastBatch(kpIds: number[]): Promise<{ items: CastBatch }> {
  if (!kpIds.length) return { items: {} };
  const { data } = await apiClient.get('/api/curriculum/lesson-cast/batch', {
    params: { kp_ids: kpIds.join(',') },
  });
  return data;
}

/** AI 帮写知识点描述：只回文本、不落库，老师改过之后建大纲时才写回 */
export async function suggestCastDescription(kpId: number): Promise<{
  description: string; kp_id: number; kp_name: string;
}> {
  const { data } = await apiClient.post(
    `/api/curriculum/lesson-cast/${kpId}/describe`, null, { timeout: 60000 });
  return data;
}

/** 第一步：只出文字大纲，不花音频钱。描述为空时后端回 409 need_description。 */
export async function createCastOutline(
  kpId: number,
  body: { minutes?: number; speaker_mode?: SpeakerMode; description?: string; voice_a?: string; voice_b?: string },
): Promise<OutlineResult> {
  const { data } = await apiClient.post(`/api/curriculum/lesson-cast/${kpId}/outline`, body, {
    timeout: 180000,
  });
  return data;
}

export async function getCastOutline(castId: number): Promise<{
  cast_id: number; kp_id: number; speaker_mode: SpeakerMode; minutes: number;
  title: string; summary: string; name_a: string; name_b: string;
  pages: CastPage[]; status: string; stale: boolean;
}> {
  const { data } = await apiClient.get(`/api/curriculum/lesson-cast/${castId}/outline`);
  return data;
}

/** 保存老师改过的大纲。返回 need_audio=true 表示音频已过期。 */
export async function saveCastOutline(
  castId: number,
  body: { pages: CastPage[]; title?: string; summary?: string },
): Promise<{ cast_id: number; plan_hash: string; pages: number; need_audio: boolean }> {
  const { data } = await apiClient.put(`/api/curriculum/lesson-cast/${castId}/outline`, body);
  return data;
}

/**
 * 第二步：合成音频。几十秒的异步任务；大纲没改过时后端直接返回 reused，不重复计费。
 */
export async function synthesizeCastAudio(
  castId: number,
  onProgress?: (p: AiTaskProgress) => void,
): Promise<{ reused?: boolean; pages?: number; segments?: number; seconds?: number; error?: string }> {
  const { data } = await apiClient.post(`/api/curriculum/lesson-cast/${castId}/audio`);
  if (!data?.task_id) return { reused: true, seconds: data?.seconds };
  const task = await pollAiTaskWithProgress(data.task_id, onProgress, 900000);
  return (task.result || {}) as any;
}

/** 单页重合成：改一句只花一句的钱。 */
export async function regenCastPage(
  castId: number,
  pageIdx: number,
  lines?: { speaker: 'A' | 'B'; text: string }[],
): Promise<{ pages?: number; seconds?: number; error?: string }> {
  const { data } = await apiClient.post(
    `/api/curriculum/lesson-cast/${castId}/page/${pageIdx}/regen`,
    lines ? { lines } : {},
  );
  if (!data?.task_id) return {};
  const task = await pollAiTaskWithProgress(data.task_id, undefined, 600000);
  return (task.result || {}) as any;
}

export async function publishCast(castId: number): Promise<{ status: string }> {
  const { data } = await apiClient.post(`/api/curriculum/lesson-cast/${castId}/publish`);
  return data;
}

/** 取讲演。学生只能拿到 published；教师传 includeDraft=1 可预览草稿。 */
export async function getCast(
  kpId: number,
  opts: { mode?: SpeakerMode; includeDraft?: boolean } = {},
): Promise<GetCastResult> {
  const { data } = await apiClient.get(`/api/curriculum/lesson-cast/${kpId}`, {
    params: { mode: opts.mode, include_draft: opts.includeDraft ? 1 : 0 },
  });
  return data;
}

export async function listCasts(kpId: number): Promise<{
  kp_id: number;
  casts: { id: number; speaker_mode: SpeakerMode; status: string; minutes: number; total_seconds: number; updated_at: string; version: number }[];
}> {
  const { data } = await apiClient.get(`/api/curriculum/lesson-cast/${kpId}/casts`);
  return data;
}

/** 断点与完成度上报（页面侧 5s 节流）。**不设练习门禁**，只用于展示与统计。 */
export async function saveCastProgress(body: {
  kp_id: number; cast_id: number; page_idx: number; seg_idx: number; pos: number; done_pages: number[];
}): Promise<{ ok: boolean; completed: boolean; total_pages: number }> {
  const { data } = await apiClient.put('/api/curriculum/lesson-cast/progress', body);
  return data;
}

export async function getCastProgress(kpId: number): Promise<{ kp_id: number; playback: CastPlayback | null }> {
  const { data } = await apiClient.get(`/api/curriculum/lesson-cast/progress/${kpId}`);
  return data;
}
