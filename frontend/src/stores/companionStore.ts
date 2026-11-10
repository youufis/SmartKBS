/** 学伴状态管理 (Zustand) */
import { create } from 'zustand';
import apiClient from '../api/client';
import type { CompanionConfig, CompanionProfile, PushMessage } from '../api/companion';
import * as companionApi from '../api/companion';
import * as historyApi from '../api/history';
import { fileUploadCache } from './chatStore';
import { promoteChatAssets } from '../api/files';
import { buildAttachmentsComment } from '../utils/chatAttachments';
import type { ChatAttachment } from '../types';

async function uploadFiles(filePaths: string[]): Promise<{ path: string; name: string }[]> {
  const results: { path: string; name: string }[] = [];
  for (const fp of filePaths) {
    try {
      const formData = new FormData();
      const fileObj = fileUploadCache.get(fp);
      if (fileObj) {
        formData.append('file', fileObj, fileObj.name);
      } else {
        continue;
      }
      const { data } = await apiClient.post('/api/files/upload-temp', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (data.path) results.push({ path: data.path, name: fileObj.name || fp });
    } catch (e) {
      console.error('文件上传失败:', fp, e);
    }
  }
  return results;
}

export interface TeacherDashboardData {
  exam_stats?: { total: number; draft: number; published: number; ended: number }
  total_submissions?: number
  total_students?: number
  total_teachers?: number
  rollcall_this_week?: number
  today_chat_count?: number
  teacher_quiz_count?: number
  teacher_poll_count?: number
  teacher_question_count?: number
  practice_published?: number
  teacher_grade?: string
  teacher_classes?: string
}

interface CompanionStore {
  // 配置
  config: CompanionConfig | null;
  configLoading: boolean;

  // 画像（学生）
  profile: CompanionProfile['profile'] | null;
  profileLoading: boolean;

  // 教学数据（教师/管理员）
  teacherData: TeacherDashboardData | null;
  teacherDataLoading: boolean;

  // 推送
  pushes: PushMessage[];
  unreadCount: number;
  pushLoading: boolean;

  // 对话
  companionMessages: { role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] }[];
  isStreaming: boolean;
  currentText: string;

  // 操作
  loadConfig: () => Promise<void>;
  updateConfig: (cfg: Partial<CompanionConfig>) => Promise<void>;
  loadProfile: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  loadPushes: () => Promise<void>;
  markPushRead: (pushId: number) => Promise<void>;
  markAllPushesRead: () => Promise<void>;
  loadTeacherData: () => Promise<void>;

  // 对话
  sendMessage: (prompt: string, file_paths?: string[], context_enhance?: boolean) => Promise<void>;
  stopStreaming: () => void;
  clearMessages: () => void;

  // 初始化
  checkMorningPush: () => Promise<void>;
}

let abortController: AbortController | null = null;

// ── 学伴对话自动保存到历史文件 ──
let _companionLastSavedCount = 0
let _companionSaveFilename: string | null = null
let _companionLoadingHistory = false  // 加载历史标记，阻止自动保存干扰

function _generateCompanionFilename(): string {
  const now = new Date()
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`
  // 教师/管理员的「教学助手」用 assistant_ 前缀，历史列表里能和学生的「学伴」区分开。
  // 从 localStorage 读角色，避免 authStore ↔ companionStore 的循环 import。
  let role = ''
  try {
    role = JSON.parse(localStorage.getItem('smartkb_user') || '{}')?.role || ''
  } catch { /* 读不到就按学伴处理 */ }
  const prefix = role === 'teacher' || role === 'admin' ? 'assistant' : 'companion'
  return `${prefix}_${ts}.md`
}

/** 加载学伴历史对话（不触发自动保存） */
export function loadCompanionHistory(msgs: { role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] }[]) {
  _companionLoadingHistory = true
  _companionSaveFilename = null
  _companionLastSavedCount = msgs.length
  useCompanionStore.setState({ companionMessages: msgs, currentText: '' })
  _companionLoadingHistory = false
}

export const useCompanionStore = create<CompanionStore>()((set, get) => ({
  config: null,
  configLoading: false,
  profile: null,
  profileLoading: false,
  teacherData: null,
  teacherDataLoading: false,
  pushes: [],
  unreadCount: 0,
  pushLoading: false,
  companionMessages: [],
  isStreaming: false,
  currentText: '',

  loadConfig: async () => {
    set({ configLoading: true });
    try {
      const config = await companionApi.getConfig();
      set({ config, configLoading: false });
    } catch {
      set({ configLoading: false });
    }
  },

  updateConfig: async (cfg) => {
    try {
      const result = await companionApi.updateConfig(cfg);
      set({ config: result.config });
    } catch (e: any) {
      console.error('更新学伴配置失败:', e);
      throw e;
    }
  },

  loadProfile: async () => {
    set({ profileLoading: true });
    try {
      const data = await companionApi.getProfile();
      set({ profile: data.profile, config: data.config, profileLoading: false });
    } catch {
      set({ profileLoading: false });
    }
  },

  refreshProfile: async () => {
    try {
      const result = await companionApi.refreshProfile();
      set({ profile: result.profile });
    } catch (e) {
      console.error('刷新画像失败:', e);
    }
  },

  loadPushes: async () => {
    set({ pushLoading: true });
    try {
      const [pushData, countData] = await Promise.all([
        companionApi.getPushes(),
        companionApi.getUnreadPushCount(),
      ]);
      set({ pushes: pushData.pushes, unreadCount: countData.count, pushLoading: false });
    } catch {
      set({ pushLoading: false });
    }
  },

  markPushRead: async (pushId) => {
    try {
      await companionApi.markPushRead(pushId);
      const { pushes, unreadCount } = get();
      set({
        pushes: pushes.filter((p) => p.id !== pushId),
        unreadCount: Math.max(0, unreadCount - 1),
      });
    } catch (e) {
      console.error('标记已读失败:', e);
    }
  },

  markAllPushesRead: async () => {
    try {
      await companionApi.markAllPushesRead();
      set({ pushes: [], unreadCount: 0 });
    } catch (e) {
      console.error('标记全部已读失败:', e);
    }
  },

  loadTeacherData: async () => {
    set({ teacherDataLoading: true });
    try {
      const { data } = await apiClient.get('/api/dashboard/summary');
      set({
        teacherData: {
          exam_stats: data.exam_stats,
          total_submissions: data.total_submissions,
          total_students: data.total_students,
          total_teachers: data.total_teachers,
          rollcall_this_week: data.rollcall_this_week,
          today_chat_count: data.today_chat_count,
          teacher_quiz_count: data.teacher_quiz_count,
          teacher_poll_count: data.teacher_poll_count,
          teacher_question_count: data.teacher_question_count,
          practice_published: data.practice_published,
          teacher_grade: data.teacher_grade,
          teacher_classes: data.teacher_classes,
        },
        teacherDataLoading: false,
      });
    } catch {
      set({ teacherDataLoading: false });
    }
  },

  sendMessage: async (prompt, file_paths, context_enhance) => {
    const { companionMessages } = get();
    if (!prompt.trim() && (!file_paths || file_paths.length === 0)) return;

    // 上传到暂存区后立即入档（与智答模式同一套逻辑）
    let serverFilePaths: string[] = [];
    let attachments: ChatAttachment[] = [];
    if (file_paths && file_paths.length > 0) {
      const uploaded = await uploadFiles(file_paths);
      if (uploaded.length) {
        try {
          const promoted = await promoteChatAssets(uploaded.map((u) => ({ path: u.path, name: u.name })));
          const ok = promoted.filter((p) => p.f && p.path);
          attachments = ok.map((p) => ({ name: p.name, f: p.f, kind: p.kind || 'file', size: p.size }));
          serverFilePaths = ok.length ? ok.map((p) => p.path as string) : uploaded.map((u) => u.path);
        } catch (e) {
          console.error('附件入档失败', e);
          serverFilePaths = uploaded.map((u) => u.path);
        }
      }
    }

    const userMsg = { role: 'user' as const, content: prompt, attachments: attachments.length ? attachments : undefined };
    const aiMsg = { role: 'assistant' as const, content: '' };

    set({
      companionMessages: [...companionMessages, userMsg, aiMsg],
      isStreaming: true,
      currentText: '',
    });

    abortController = new AbortController();

    // 后端 SSE 的 delta 帧只携带新增片段（与智答模式同一协议），前端负责累加并 ~60ms 节流落屏
    let acc = '';
    let lastFlush = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      lastFlush = Date.now();
      const msgs = get().companionMessages;
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        last.content = acc;
        set({ companionMessages: [...msgs], currentText: acc });
      }
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      const wait = Math.max(0, 60 - (Date.now() - lastFlush));
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, wait);
    };

    await companionApi.companionChat(
      prompt,
      (inc: string) => {
        acc += inc;
        scheduleFlush();
      },
      () => {
        flush();
        set({ isStreaming: false, currentText: '' });
        abortController = null;
      },
      (error) => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        const msgs = get().companionMessages;
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          last.content = error ? `❌ ${error}` : '对话生成失败，请重试';
          set({ companionMessages: [...msgs], isStreaming: false, currentText: '' });
        }
        abortController = null;
      },
      abortController.signal,
      serverFilePaths,
      context_enhance,
    );
  },

  stopStreaming: () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    set({ isStreaming: false, currentText: '' });
  },

  clearMessages: () => {
    _companionLoadingHistory = false
    _companionLastSavedCount = 0
    _companionSaveFilename = null
    set({ companionMessages: [], currentText: '' });
  },

  checkMorningPush: async () => {
    try {
      await companionApi.checkMorningPush();
    } catch {
      // 静默失败
    }
  },
}));

// ── 自动保存学伴对话到历史文件（与智答模式共用同一套历史系统）──
useCompanionStore.subscribe((state) => {
  // 加载历史记录时不触发自动保存
  if (_companionLoadingHistory) return
  if (!state.isStreaming && state.companionMessages.length > 0
      && state.companionMessages.length !== _companionLastSavedCount) {
    // 避免空对话和仅错误消息的对话
    const hasContent = state.companionMessages.some(m => m.content && !m.content.startsWith('❌'))
    if (!hasContent) return

    _companionLastSavedCount = state.companionMessages.length
    if (!_companionSaveFilename) {
      _companionSaveFilename = _generateCompanionFilename()
    }

    const content = state.companionMessages.map((m) => {
      const head = `**${m.role === 'user' ? '用户' : '助手'}**: ${m.content}`
      const meta = buildAttachmentsComment(m.attachments)
      return meta ? `${head}\n\n${meta}` : head
    }).join('\n\n---\n\n')

    // 在文件名前添加 🧠 标记，方便前端识别
    historyApi.saveConversation(content, 'companion', _companionSaveFilename)
      .then(() => { window.dispatchEvent(new Event('chat:history-saved')) })
      .catch(() => {})
  }
})
