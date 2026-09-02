/** 对话状态管理 (Zustand) */
import i18n from '../i18n'
import { create } from 'zustand';
import type { Message, TreeNode } from '../types';
import { chatStream, checkApiKeyStatus } from '../api/chat';
import * as historyApi from '../api/history';
import apiClient from '../api/client';

/** 上传文件列表到服务器，返回服务器端路径数组 */
async function uploadFiles(filePaths: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const fp of filePaths) {
    // filePaths 可能是浏览器 File 对象的 name 或临时路径
    // 尝试通过已保存的 fileMap 获取 File 对象
    try {
      const formData = new FormData();
      // 如果是 File 对象路径，尝试从缓存获取
      const fileObj = fileUploadCache.get(fp);
      if (fileObj) {
        formData.append('file', fileObj, fileObj.name);
      } else {
        // 没有 File 对象，跳过
        continue;
      }
      const { data } = await apiClient.post('/api/files/upload-temp', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (data.path) results.push(data.path);
    } catch (e) {
      console.error('文件上传失败:', fp, e);
    }
  }
  return results;
}

/** 文件上传缓存：文件名 -> File 对象 */
export const fileUploadCache = new Map<string, File>();

interface ChatStore {
  // 状态
  messages: Message[];
  sessionId: string | null;
  isStreaming: boolean;
  currentText: string;
  filePaths: string[];
  contextEnhance: boolean;
  ragEnabled: boolean;
  useAgent: boolean;  // True=优先使用智能体(有APPID时)；False=强制直连大模型
  historyTree: TreeNode[];
  historyLoading: boolean;
  historyContent: string;
  historyFilename: string | null;

  // 操作
  sendMessage: (prompt: string) => Promise<void>;
  stopStreaming: () => void;
  newTopic: () => void;
  setFilePaths: (paths: string[]) => void;
  setContextEnhance: (v: boolean) => void;
  setRagEnabled: (v: boolean) => void;
  setUseAgent: (v: boolean) => void;
  addSystemMessage: (content: string) => void;
  loadHistoryTree: () => Promise<void>;
  loadHistoryFile: (path: string) => Promise<void>;
  deleteHistoryFile: (path: string) => Promise<void>;
}

let abortController: AbortController | null = null;

export const useChatStore = create<ChatStore>()((set, get) => ({
  messages: [],
  sessionId: null,
  isStreaming: false,
  currentText: '',
  filePaths: [],
  contextEnhance: false,
  ragEnabled: false,
  useAgent: true,  // 默认勾选智能体（有 APPID 时生效）
  historyTree: [],
  historyLoading: false,
  historyContent: '',
  historyFilename: null,

  sendMessage: async (prompt: string) => {
    const { sessionId, filePaths, contextEnhance, useAgent, messages } = get();
    if (!prompt.trim() && filePaths.length === 0) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: prompt || i18n.t('chat:fileTag'),
      timestamp: Date.now(),
    };
    const aiMsg: Message = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    set({ messages: [...messages, userMsg, aiMsg], isStreaming: true, currentText: '' });

    // 发送前检查 API Key 是否已配置
    try {
      const keyStatus = await checkApiKeyStatus();
      if (!keyStatus.configured) {
        const msgs = get().messages;
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          last.content = `❌ API Key 未配置\n\n请管理员在 **系统配置** 中填写 DashScope API Key，或联系管理员在服务器设置环境变量 \`DASHSCOPE_API_KEY\``;
          set({ messages: [...msgs], isStreaming: false, currentText: '' });
        }
        abortController = null;
        return;
      }
    } catch {
      // 检查失败时继续尝试发送，由后端兜底
    }

    // 上传文件到服务器，获取真实路径
    let serverFilePaths: string[] = [];
    if (filePaths.length > 0) {
      serverFilePaths = await uploadFiles(filePaths);
    }

    abortController = new AbortController();

    await chatStream(
      { prompt, file_paths: serverFilePaths, session_id: sessionId, context_enhance: contextEnhance, use_agent: useAgent },
      (text: string) => {
        set({ currentText: text });
        const msgs = get().messages;
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          last.content = text;
          set({ messages: [...msgs] });
        }
      },
      (newSessionId: string) => {
        set({ isStreaming: false, sessionId: newSessionId || null, currentText: '' });
        abortController = null;
      },
      (error: string) => {
        const msgs = get().messages;
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'assistant') {
          last.content = `❌ ${error}`;
          set({ messages: [...msgs], isStreaming: false, currentText: '' });
        }
        abortController = null;
      },
      abortController.signal
    );
  },

  stopStreaming: () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    set({ isStreaming: false });
  },

  newTopic: () => {
    set({ messages: [], sessionId: null, currentText: '', filePaths: [] });
  },

  setFilePaths: (paths: string[]) => set({ filePaths: paths }),
  setContextEnhance: (v: boolean) => set({ contextEnhance: v }),
  setRagEnabled: (v: boolean) => set({ ragEnabled: v }),
  setUseAgent: (v: boolean) => set({ useAgent: v }),

  addSystemMessage: (content: string) => {
    const msg: Message = {
      id: Date.now().toString(),
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    set((state) => ({ messages: [...state.messages, msg] }));
  },

  loadHistoryTree: async () => {
    set({ historyLoading: true });
    try {
      const { tree } = await historyApi.getHistoryTree();
      set({ historyTree: tree });
    } catch {
      // 忽略错误
    } finally {
      set({ historyLoading: false });
    }
  },

  loadHistoryFile: async (path: string) => {
    try {
      const result = await historyApi.readHistoryFile(path);
      console.log('历史文件加载成功:', result.filename, '长度:', result.content.length);
      set({ historyContent: result.content, historyFilename: result.filename });
    } catch (e: any) {
      console.error('历史文件加载失败:', e);
      const detail = e?.response?.data?.detail || e.message || i18n.t('chat:unknownError');
      set({ historyContent: `\u274c ${i18n.t('chat:loadFailed')}: ${detail}`, historyFilename: null });
    }
  },

  deleteHistoryFile: async (path: string) => {
    try {
      await historyApi.deleteHistoryFile(path);
      // 刷新树
      const { tree } = await historyApi.getHistoryTree();
      set({ historyTree: tree, historyContent: '', historyFilename: null });
    } catch (e: any) {
      throw new Error(e.message);
    }
  },
}));

// 自动保存历史到文件（每个话题只保存一个文件）
let lastSavedMessageCount = 0;
let currentSaveFilename: string | null = null;
let _loadingHistory = false;  // 加载历史标记，阻止自动保存干扰

/** 设置下次自动保存使用任务相关文件名 */
export function setTaskFilename(taskName: string) {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  currentSaveFilename = `task_${taskName}_${ts}.md`;
}

function generateTopicFilename(): string {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  return `conversation_${ts}.md`;
}

useChatStore.subscribe((state) => {
  // 加载历史记录时不触发自动保存
  if (_loadingHistory) return;
  if (!state.isStreaming && state.messages.length > 0 && state.messages.length !== lastSavedMessageCount) {
    if (!currentSaveFilename) {
      currentSaveFilename = generateTopicFilename();
    }
    lastSavedMessageCount = state.messages.length;
    const content = state.messages.map(m =>
      `**${m.role === 'user' ? '用户' : '助手'}**: ${m.content}`
    ).join('\n\n---\n\n');
    historyApi.saveConversation(content, state.sessionId || undefined, currentSaveFilename || undefined);
  }
});

// 重置话题时重置文件名和计数（在 newTopic 中处理）
// 用 monkey-patch 方式在 newTopic 被调用时同步重置
const origNewTopic = useChatStore.getState().newTopic;
useChatStore.setState({
  newTopic: () => {
    currentSaveFilename = null;
    lastSavedMessageCount = 0;
    origNewTopic();
  },
});

// 加载历史消息为新话题（不触发自动保存）
export function loadHistoryAsNewTopic(msgs: Message[]) {
  _loadingHistory = true;
  currentSaveFilename = null;
  const store = useChatStore.getState();
  store.newTopic();
  lastSavedMessageCount = msgs.length;
  useChatStore.setState({
    messages: msgs,
    sessionId: null,
    currentText: '',
    filePaths: [],
  });
  _loadingHistory = false;
}

// ChatPage 中加载历史时调用此函数设置标记
export function beginHistoryLoad() { _loadingHistory = true; }
export function endHistoryLoad() { _loadingHistory = false; }
