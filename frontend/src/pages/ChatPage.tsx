import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Layout, Input, Button, Space, Checkbox, message, Modal,
  Typography, Tooltip, Tree, Drawer, Spin, Popconfirm, Card, Tag,
  List, Empty,
} from 'antd'
import {
  SendOutlined, StopOutlined, PlusOutlined,
  EyeOutlined, UploadOutlined,
  DeleteOutlined, CheckOutlined, RightOutlined, HistoryOutlined, FileOutlined, FolderOutlined,
  CopyOutlined, CameraOutlined,
} from '@ant-design/icons'
import type { Message, TreeNode, TaskInfo } from '../types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatStore, fileUploadCache, loadHistoryAsNewTopic, setTaskFilename } from '../stores/chatStore'
import { useAuthStore } from '../stores/authStore'
import { useCompanionStore, loadCompanionHistory } from '../stores/companionStore'
import * as historyApi from '../api/history'
import * as tasksApi from '../api/tasks'
import * as chatApi from '../api/chat'
import { useTranslation } from 'react-i18next'
import CameraCapture from '../components/CameraCapture'
import VoiceInput from '../components/VoiceInput'

const { TextArea } = Input

// 打字光标组件
const TypingCursor: React.FC = () => (
  <span className="typing-cursor" style={{
    display: 'inline-block', width: 2, height: '1em',
    backgroundColor: '#1677ff', marginLeft: 2,
    animation: 'blink 1s step-end infinite',
  }} />
)

// ── 学伴头像映射 ──
const COMPANION_AVATARS: Record<string, string> = {
  encouraging: '🌟',
  rigorous: '📐',
  humorous: '😄',
}

const MessageBubble: React.FC<{
  msg: Message
  isStreaming?: boolean
  onPreviewHtml?: (htmlContent: string) => void
  companionMode?: boolean
  companionName?: string
  companionPersonality?: string
}> = ({ msg, isStreaming, onPreviewHtml, companionMode, companionName, companionPersonality }) => {
  const { t } = useTranslation('chat')
  const isUser = msg.role === 'user'
  const companionAvatar = COMPANION_AVATARS[companionPersonality || 'encouraging'] || '🧠'

  // 自定义 Markdown 渲染，为 HTML 代码块添加预览按钮
  const renderCode = (props: { className?: string; children?: React.ReactNode }) => {
    const { children, className } = props
    const isHtmlBlock = className === 'language-html'
    const codeContent = String(children).replace(/\n$/, '')
    return (
      <div style={{ position: 'relative' }}>
        <pre style={{ background: '#f5f5f5', padding: '8px 12px', borderRadius: 4, overflowX: 'auto', fontSize: 13 }}>
          <code className={className}>{codeContent}</code>
        </pre>
        {isHtmlBlock && onPreviewHtml && (
          <Button
            size="small"
            type="primary"
            ghost
            icon={<EyeOutlined />}
            onClick={() => onPreviewHtml(codeContent)}
            style={{ position: 'absolute', top: 4, right: 4, fontSize: 12, lineHeight: '20px', height: 26 }}
          >
            {t('preview')}
          </Button>
        )}
      </div>
    )
  }

  if (companionMode) {
    // ── 学伴模式专属气泡样式 ──
    if (isUser) {
      return (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
          <div style={{
            maxWidth: '70%', padding: '10px 16px', borderRadius: '16px 16px 4px 16px',
            background: 'linear-gradient(135deg, #e8f4fd 0%, #d6ecff 100%)',
            border: '1px solid #bae0ff',
            boxShadow: '0 2px 4px rgba(22,119,255,0.08)',
          }}>
            <Typography.Text style={{ fontSize: 14, lineHeight: 1.6 }}>{msg.content}</Typography.Text>
          </div>
        </div>
      )
    }
    return (
      <div style={{ display: 'flex', marginBottom: 16, alignItems: 'flex-start', gap: 10 }}>
        {/* 学伴头像 */}
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, flexShrink: 0,
          boxShadow: '0 2px 6px rgba(102,126,234,0.3)',
        }}>
          {companionAvatar}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: '#667eea', fontWeight: 600, marginBottom: 4, paddingLeft: 4 }}>
            {companionName || t('assistant')}
          </div>
          <div style={{
            maxWidth: '85%', padding: '12px 16px', borderRadius: '16px 16px 16px 4px',
            background: 'linear-gradient(135deg, #ffffff 0%, #f8f9ff 100%)',
            border: '1px solid #e8ecf4',
            boxShadow: '0 2px 8px rgba(102,126,234,0.08)',
            display: 'inline-block',
          }}>
            <div className="markdown-content" style={{ fontSize: 14, lineHeight: 1.7 }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: renderCode,
                }}
              >
                {msg.content || ''}
              </ReactMarkdown>
              {isStreaming && <TypingCursor />}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── 普通模式气泡样式 ──
  return (
    <div style={{
      display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 16,
    }}>
      <div style={{
        maxWidth: '75%', padding: '10px 16px', borderRadius: 12,
        backgroundColor: isUser ? '#e6f4ff' : '#ffffff',
        border: isUser ? 'none' : '1px solid #f0f0f0',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
      }}>
        {isUser ? (
          <Typography.Text>{msg.content}</Typography.Text>
        ) : (
          <div className="markdown-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code: renderCode,
              }}
            >
              {msg.content || ''}
            </ReactMarkdown>
            {isStreaming && <TypingCursor />}
          </div>
        )}
      </div>
    </div>
  )
}

const ChatPage: React.FC = () => {
  const { t } = useTranslation('chat')
  // 智能教育助手 - SmartKB
  const {
    messages, isStreaming, currentText, filePaths,
    contextEnhance, ragEnabled, useAgent, sendMessage, stopStreaming, newTopic,
    setFilePaths, setContextEnhance, setRagEnabled, setUseAgent,
    historyTree, historyLoading,
    loadHistoryTree,
  } = useChatStore()

  const curUser = useAuthStore((s) => s.user)
  const curRole = curUser?.role

  // 学伴模式
  const companionConfig = useCompanionStore((s) => s.config)
  const companionProfile = useCompanionStore((s) => s.profile)
  const companionMessages = useCompanionStore((s) => s.companionMessages)
  const companionIsStreaming = useCompanionStore((s) => s.isStreaming)
  const companionSendMsg = useCompanionStore((s) => s.sendMessage)
  const companionStop = useCompanionStore((s) => s.stopStreaming)
  const companionLoadConfig = useCompanionStore((s) => s.loadConfig)
  const companionLoadProfile = useCompanionStore((s) => s.loadProfile)
  const companionLoadTeacherData = useCompanionStore((s) => s.loadTeacherData)
  const companionTeacherData = useCompanionStore((s) => s.teacherData)
  const companionUnreadCount = useCompanionStore((s) => s.unreadCount)
  const companionPushes = useCompanionStore((s) => s.pushes)
  const companionMarkPushRead = useCompanionStore((s) => s.markPushRead)
  const companionMarkAllPushesRead = useCompanionStore((s) => s.markAllPushesRead)
  const companionLoadPushes = useCompanionStore((s) => s.loadPushes)

  const [companionMode, setCompanionMode] = useState(() => {
    // 从 URL 参数初始化：?companion=1 自动打开学伴模式
    const params = new URLSearchParams(window.location.search);
    return params.get('companion') === '1';
  })
  const [companionSidebar, setCompanionSidebar] = useState(false)
  const [pushModalOpen, setPushModalOpen] = useState(false)
  const navigate = useNavigate()

  // 组件挂载时预加载学伴配置（保证从设置页返回时 config 最新）
  useEffect(() => {
    if (curRole === 'student') {
      companionLoadConfig()
    }
  }, [curRole, companionLoadConfig])

  // 切入学伴/助手模式时加载数据
  useEffect(() => {
    if (!companionMode) return
    if (curRole === 'student') {
      companionLoadProfile()
      companionLoadPushes()
    } else if (curRole === 'teacher' || curRole === 'admin') {
      companionLoadTeacherData()
    }
  }, [companionMode, curRole, companionLoadProfile, companionLoadPushes, companionLoadTeacherData])

  // 组件挂载时清除 URL 中的 ?companion=1（避免刷新后重复触发）
  useEffect(() => {
    if (window.location.search.includes('companion=1')) {
      window.history.replaceState({}, '', '/chat');
    }
  }, []);

  const [input, setInput] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [imagePreviewHtml, setImagePreviewHtml] = useState('')
  const [cameraOpen, setCameraOpen] = useState(false)
  // 多任务选择弹窗
  const [taskSelectOpen, setTaskSelectOpen] = useState(false)
  const [pendingTasks, setPendingTasks] = useState<TaskInfo[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<React.ComponentRef<typeof TextArea>>(null)
  const [usage, setUsage] = useState<chatApi.UsageInfo | null>(null)

  // 加载用量信息
  useEffect(() => {
    chatApi.getUsage().then(setUsage).catch(() => {})
  }, [])

  // 检测最后一条 AI 回复是否有 HTML（派生状态）
  const hasHtmlInResponse = useMemo(() => {
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === 'assistant') {
        return /```html/i.test(last.content) || /<!DOCTYPE html/i.test(last.content) || /<html>/i.test(last.content);
      }
    }
    return false;
  }, [messages]);

  // 解析历史内容为消息列表
  const parseHistoryContent = useCallback((content: string): Message[] => {
    const blocks = content.split(/\n\n---\n\n/);
    return blocks.map((block, i) => {
      const userMatch = block.match(/^\*\*用户\*\*:\s*(.*)/s);
      const assistantMatch = block.match(/^\*\*助手\*\*:\s*(.*)/s);
      if (userMatch) {
        return { id: `hist-${i}`, role: 'user' as const, content: userMatch[1].trim(), timestamp: Date.now() };
      } else if (assistantMatch) {
        return { id: `hist-${i}`, role: 'assistant' as const, content: assistantMatch[1].trim(), timestamp: Date.now() };
      }
      return { id: `hist-${i}`, role: 'system' as const, content: block.trim(), timestamp: Date.now() };
    });
  }, []);

  // 点击历史文件 → 清空面板，显示历史内容，并自动上传为附件方便提问
  const handleHistorySelect = useCallback(async (selectedKeys: React.Key[], info: { node: TreeNode }) => {
    const node = info.node as TreeNode;
    const key = node.key || (selectedKeys.length > 0 ? String(selectedKeys[0]) : '');
    if (node.isLeaf && key) {
      message.loading({ content: t('loadingHistory'), key: 'history' });
      try {
        const result = await historyApi.readHistoryFile(key);
        if (!result) {
          message.error({ content: t('loadingHistoryFailed'), key: 'history' });
          return;
        }
        const msgs = parseHistoryContent(result.content);
        const isCompanionFile = result.filename?.startsWith('companion_') || (node.title as string).startsWith('companion_');

        if (isCompanionFile) {
          // 学伴/助手模式的对话 → 载入 companionStore（通过 loadCompanionHistory 避免重复保存）
          const companionMsgs = msgs.map(m => ({
            role: m.role === 'user' ? 'user' as const : 'assistant' as const,
            content: m.content,
          }));
          loadCompanionHistory(companionMsgs);
          // 切换到智答模式时自动清理学伴消息，反之亦然
          if (companionMode === false) {
            useChatStore.getState().newTopic();
          }
          // 自动切换到学伴/助手模式
          if (!companionMode) {
            setCompanionMode(true);
          }
        } else {
          // 智答模式的对话 → 载入 chatStore
          loadHistoryAsNewTopic(msgs);
          // 切换到智答模式时自动清理学伴消息
          if (companionMode) {
            setCompanionMode(false);
            useCompanionStore.getState().clearMessages();
          }
        }

        message.success({ content: t('copied'), key: 'history' });
      } catch (e: unknown) {
        console.error(t('errorLoad'), e);
        const err = e as { response?: { data?: { detail?: string } }; message?: string };
        message.error({ content: err?.response?.data?.detail || err?.message || t('errorLoad'), key: 'history' });
      }
    }
  }, [parseHistoryContent, companionMode, t]);

  // 删除历史文件或目录
  const handleHistoryDelete = useCallback(async (path: string) => {
    try {
      const msg = await historyApi.deleteHistoryFile(path);
      message.success(msg || t('deleted'));
      await loadHistoryTree();
    } catch (e: unknown) {
      console.error(t('deleteFailed'), e);
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      message.error(err?.response?.data?.detail || err?.message || t('deleteFailed'));
    }
  }, [loadHistoryTree, t]);

  const handleOpenHistory = useCallback(() => {
    setHistoryOpen(true);
    loadHistoryTree();
  }, [loadHistoryTree]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentText])

  // 提交对话到指定任务
  const submitToTask = useCallback(async (task: TaskInfo) => {
    const msgs = useChatStore.getState().messages;
    const content = msgs.map(m =>
      `**${m.role === 'user' ? t('you') : t('assistant')}**: ${m.content}`
    ).join('\n\n---\n\n');
    if (!content.trim()) {
      message.warning(t('taskContentEmpty'));
      return;
    }
    try {
      const res = await tasksApi.submitTask(task.id, content);
      message.success(res.message);
      setTaskFilename(task.name);
      useChatStore.getState().addSystemMessage(t('submittingToTask', { name: task.name }));
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      message.error(e?.response?.data?.detail || e?.message || t('submitFailed'));
    }
  }, [t]);

  // 检测并处理任务关键词
  const handleTaskCommand = useCallback(async (text: string): Promise<boolean> => {
    // 模式1: "提交xxx任务" 或 "提交xxx任务：说明" → 创建任务（可选说明）
    const createMatch = text.match(/^提交(.+?)任务(?:[：:]\s*(.*))?$/);
    if (createMatch) {
      const taskName = createMatch[1].trim();
      const taskDesc = (createMatch[2] || '').trim();
      if (!taskName) return false;
      if (curUser?.role !== 'admin' && curUser?.role !== 'teacher') {
        message.warning(t('onlyTeacherCreate'));
        return true;
      }
      try {
        const res = await tasksApi.createTask(taskName, taskDesc || undefined);
        message.success(res.message);
        const descText = taskDesc ? `（${taskDesc}）` : '';
        useChatStore.getState().addSystemMessage(t('taskCreated', { name: taskName, desc: descText }));
        return true;
      } catch (err: unknown) {
        const e = err as { response?: { data?: { detail?: string } }; message?: string };
        message.error(e?.response?.data?.detail || e?.message || t('createFailed'));
        return true;
      }
    }

    // 模式2: "提交到xxx任务" 或 "完成xxx任务" → 提交到指定名称的任务
    const submitMatch = text.match(/^(?:提交到|完成)(.+?)任务$/);
    if (submitMatch) {
      const taskName = submitMatch[1].trim();
      if (!taskName) return false;
      try {
        const { tasks } = await tasksApi.getActiveTasks();
        const target = tasks.find(t => t.status === 'active' && t.name === taskName);
        if (!target) {
          message.warning(t('taskNotFound', { name: taskName }));
          return true;
        }
        await submitToTask(target);
        return true;
      } catch (err: unknown) {
        const e = err as { response?: { data?: { detail?: string } }; message?: string };
        message.error(e?.response?.data?.detail || e?.message || t('submitFailed'));
        return true;
      }
    }

    // 模式3: "完成" 或 "结束" → 提交任务（多任务时弹出选择）
    if (/^(完成|结束)$/.test(text.trim())) {
      try {
        const { tasks } = await tasksApi.getActiveTasks();
        const activeTasks = tasks.filter(t => t.status === 'active');
        if (activeTasks.length === 0) {
          message.info(t('noActiveTask'));
          return false;
        }
        if (activeTasks.length === 1) {
          // 只有一个任务，直接提交
          await submitToTask(activeTasks[0]);
          return true;
        }
        // 多个任务，弹出选择框让用户选择
        setPendingTasks(activeTasks);
        setTaskSelectOpen(true);
        return true;
      } catch (err: unknown) {
        const e = err as { response?: { data?: { detail?: string } }; message?: string };
        message.error(e?.response?.data?.detail || e?.message || t('submitFailed'));
        return true;
      }
    }
    return false;
  }, [curUser, submitToTask, t]);

  const handleSend = async () => {
    if (!input.trim() && filePaths.length === 0) return
    // 先检测是否是任务命令
    const handled = await handleTaskCommand(input);
    if (handled) {
      setInput('');
      return;
    }
    if (companionMode) {
      companionSendMsg(input, filePaths, contextEnhance)
    } else {
      sendMessage(input)
    }
    setInput('')
    // 发送后刷新当日用量
    chatApi.getUsage().then(setUsage).catch(() => {})
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSend()
    }
  }

  // 文件上传 - 用 hidden input 替代 Upload 组件（避免文件累积）
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleNativeFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const paths: string[] = [];
    const imgExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
    let imgsHtml = '';

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const name = file.name;
      const ext = name.toLowerCase().substring(name.lastIndexOf('.'));
      // 清除旧缓存后重新缓存
      fileUploadCache.delete(name);
      fileUploadCache.set(name, file);
      if (imgExtensions.includes(ext)) {
        const url = URL.createObjectURL(file);
        imgsHtml += `<img src="${url}" style="max-height:60px;margin:2px;border-radius:4px;" />`;
      }
      paths.push(name);
    }

    setFilePaths(paths);
    setImagePreviewHtml(imgsHtml ? `<div style="display:flex;flex-wrap:wrap;">${imgsHtml}</div>` : '');
    // 清空 input，保证再次选择同一文件也能触发 onChange
    e.target.value = '';
  };

  // 处理语音输入
  const handleVoiceTranscript = useCallback((text: string) => {
    setInput((prev) => prev + text)
    inputRef.current?.focus()
  }, [])

  // 处理摄像头拍照
  const handleCameraCapture = useCallback((file: File) => {
    fileUploadCache.clear();
    fileUploadCache.set(file.name, file);
    setFilePaths([file.name]);
    // 生成图片预览
    const url = URL.createObjectURL(file);
    const imgsHtml = `<div style="display:flex;flex-wrap:wrap;"><img src="${url}" style="max-height:60px;margin:2px;border-radius:4px;" /></div>`;
    setImagePreviewHtml(imgsHtml);
  }, [setFilePaths]);

  // 提取 HTML 预览
  const extractHtmlPreview = useCallback(() => {
    const fullContent = messages.map((m: Message) => m.content).join('\n');
    const match = fullContent.match(/```html\n?([\s\S]*?)\n?```/);
    if (match) {
      setPreviewHtml(match[1]);
      setShowPreview(true);
    } else if (/<!DOCTYPE html/i.test(fullContent) || /<html>/i.test(fullContent)) {
      setPreviewHtml(fullContent);
      setShowPreview(true);
    } else {
      message.info(t('noHtmlFound'));
    }
  }, [messages, t]);

  // 复制对话内容
  const handleCopy = useCallback(() => {
    const copyMsgs = companionMode ? companionMessages : messages
    if (!copyMsgs.length) { message.warning(t('noContentToCopy')); return }

    // 优先使用 DOM 选取方式复制渲染后的内容（保留完整样式，Word 友好）
    const container = messagesRef.current
    if (container && container.children.length > 0 && document.createRange) {
      try {
        const range = document.createRange()
        range.selectNodeContents(container)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
        const ok = document.execCommand('copy')
        sel?.removeAllRanges()
        if (ok) { message.success(t('copied')); return }
      } catch { /* 降级到 HTML clipboard */ }
    }

    // 降级方案：ClipboardItem API（text + html 双格式）
    const text = copyMsgs.map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`).join('\n\n---\n\n')
    const html = copyMsgs.map(m => {
      const role = m.role === 'user' ? `👤 ${t('you')}` : `🤖 ${t('assistant')}`
      const bg = m.role === 'user' ? '#f0f5ff' : '#f6ffed'
      return `<div style="margin:8px 0;padding:10px 14px;background:${bg};border-radius:6px;border-left:3px solid ${m.role === 'user' ? '#1677ff' : '#52c41a'}">\n        <div style="font-weight:600;font-size:14px;margin-bottom:4px;color:#333">${role}</div>\n        <div style="font-size:14px;line-height:1.7;color:#1a1a1a;white-space:pre-wrap">${m.content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>\n      </div>`
    }).join('\n')
    if (navigator.clipboard?.write) {
      navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([`<div style="font-family:'Microsoft YaHei',sans-serif">${html}</div>`], { type: 'text/html' }),
        }),
      ]).then(() => message.success(t('copied')), () => message.error(t('copyFailed')))
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy'); message.success(t('copied')) } catch { message.error(t('copyFailed')) }
      document.body.removeChild(ta)
    }
  }, [messages, companionMode, companionMessages, t]);

  // 判断是否处于流式状态（普通模式或学伴模式）
  const isAnyStreaming = companionMode ? companionIsStreaming : isStreaming
  const activeMessages = companionMode ? companionMessages : messages
  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
      {/* 顶部模式切换 */}
      <div style={{
        padding: '8px 24px',
        borderBottom: companionMode ? '1px solid #d6d0f0' : '1px solid #f0f0f0',
        display: 'flex', alignItems: 'center', gap: 12,
        background: companionMode
          ? 'linear-gradient(90deg, #f0ecff 0%, #f5f0ff 50%, #f0f4ff 100%)'
          : '#fff',
        transition: 'all 0.3s ease',
      }}>
        {(curRole === 'student' || curRole === 'teacher' || curRole === 'admin') && (
          <>
            <Button
              type={companionMode ? 'primary' : 'default'}
              size="small"
              icon={<span>{companionMode ? (curRole === 'teacher' || curRole === 'admin' ? '🎓' : '🧠') : '💬'}</span>}
              onClick={() => {
                if (!companionMode) {
                  if (curRole === 'student') {
                    if (companionConfig === null) {
                      companionLoadConfig()
                    } else if (!companionConfig.enabled) {
                      message.warning(t('companionDisabled'))
                      return
                    }
                  }
                }
                setCompanionMode(!companionMode)
                if (!companionMode) {
                  companionLoadProfile()
                  companionLoadPushes()
                }
              }}
              style={companionMode ? { background: 'linear-gradient(135deg, #667eea, #764ba2)', borderColor: 'transparent' } : {}}
            >
              {companionMode ? (curRole === 'teacher' || curRole === 'admin' ? t('assistantMode') : t('companionMode')) : t('smartMode')}
            </Button>
            {companionMode && (
              <>
                {/* 学伴/教学助手头像 */}
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: curRole === 'teacher' || curRole === 'admin'
                    ? 'linear-gradient(135deg, #52c41a, #13c2c2)'
                    : 'linear-gradient(135deg, #667eea, #764ba2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, flexShrink: 0,
                }}>
                  {curRole === 'teacher' || curRole === 'admin' ? '🎓' : (COMPANION_AVATARS[companionConfig?.personality || 'encouraging'] || '🧠')}
                </div>
                <div>
                  <Typography.Text strong style={{ fontSize: 14, color: curRole === 'teacher' || curRole === 'admin' ? '#13c2c2' : '#5b4fa0' }}>
                    {curRole === 'teacher' || curRole === 'admin' ? t('assistant') : (companionConfig?.companion_name || t('companionName'))}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11, marginLeft: 6, color: '#8c7fbf' }}>
                    {curRole === 'teacher' || curRole === 'admin' ? `🎓 ${t('assistant')}` : (companionConfig?.personality_label || t('companionName'))}
                  </Typography.Text>
                </div>
                <div style={{ flex: 1 }} />
                <Button size="small" type="text" onClick={() => setCompanionSidebar(!companionSidebar)}
                  style={{ color: curRole === 'teacher' || curRole === 'admin' ? '#13c2c2' : '#667eea' }}>
                  📊 {t('teachingData')}
                </Button>
                {curRole === 'student' && (
                  <Button size="small" type="text" icon={<span>⚙️</span>}
                    onClick={() => navigate('/companion-settings')}
                    style={{ color: '#667eea' }}
                  />
                )}
              </>
            )}
          </>
        )}
        {(!curRole || (curRole !== 'student' && curRole !== 'teacher' && curRole !== 'admin')) && (
          <Typography.Text strong style={{ fontSize: 14 }}>{t('modeLabelSmart')}</Typography.Text>
        )}
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 消息列表 */}
        <div ref={messagesRef} style={{
          flex: 1, overflow: 'auto', padding: 24,
          background: companionMode
            ? 'linear-gradient(135deg, #f5f0ff 0%, #f0f4ff 50%, #f5f8ff 100%)'
            : '#fafafa',
          transition: 'background 0.3s ease',
        }}>
          {activeMessages.length === 0 ? (
            companionMode ? (
              (curRole === 'teacher' || curRole === 'admin') ? (
                // ── 教师/管理员空态 ──
                <div style={{
                  textAlign: 'center', paddingTop: 60,
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                }}>
                  <div style={{
                    width: 80, height: 80, borderRadius: '50%',
                    background: 'linear-gradient(135deg, #52c41a 0%, #13c2c2 100%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 40, marginBottom: 16,
                    boxShadow: '0 4px 16px rgba(82,196,26,0.3)',
                  }}>
                    🎓
                  </div>
                  <Typography.Title level={4} style={{ color: '#13c2c2', margin: 0 }}>
                    {t('greetingTeacher')}
                  </Typography.Title>
                  <Typography.Text style={{ color: '#999', marginTop: 8, maxWidth: 520, fontSize: 14 }}>
                    {t('greetingTeacherDesc')}
                  </Typography.Text>
                  <div style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <Button size="small" style={{ borderColor: '#13c2c2', color: '#13c2c2' }}
                      onClick={() => companionSendMsg('请替我生成一份完整的教案，课题是「网络协议」，附带课堂活动和作业设计')}
                    >
                      {t('genLessonPlan')}
                    </Button>
                    <Button size="small" style={{ borderColor: '#13c2c2', color: '#13c2c2' }}
                      onClick={() => companionSendMsg('请出10道关于进制转换的题目，包含单选、多选和判断，附答案和解析')}
                    >
                      {t('genExam')}
                    </Button>
                    <Button size="small" style={{ borderColor: '#13c2c2', color: '#13c2c2' }}
                      onClick={() => companionSendMsg('帮我分析高一1班最近一次考试的成绩，指出整体薄弱点')}
                    >
                      {t('classAnalysis')}
                    </Button>
                    <Button size="small" style={{ borderColor: '#13c2c2', color: '#13c2c2' }}
                      onClick={() => companionSendMsg('请帮我设计一个45分钟的课堂活动方案，主题是「算法与程序设计」')}
                    >
                      {t('activityPlan')}
                    </Button>
                  </div>
                </div>
              ) : (
                // ── 学生空态 ──
                <div style={{
                  textAlign: 'center', paddingTop: 60,
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                }}>
                  <div style={{
                    width: 80, height: 80, borderRadius: '50%',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 40, marginBottom: 16,
                    boxShadow: '0 4px 16px rgba(102,126,234,0.3)',
                  }}>
                    {COMPANION_AVATARS[companionConfig?.personality || 'encouraging'] || '🧠'}
                  </div>
                  <Typography.Title level={4} style={{ color: '#667eea', margin: 0 }}>
                    {t('greetingStudent', { name: companionConfig?.companion_name || t('companionName') })}
                  </Typography.Title>
                  <Typography.Text style={{ color: '#999', marginTop: 8, maxWidth: 400, fontSize: 14 }}>
                    {'<'}{companionConfig?.personality_label || t('companionName')}{'>'} {t('companionTagline', { label: '' })}
                  </Typography.Text>
                  <div style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {companionProfile?.weakness?.length ? (
                      <Button size="small" type="primary" ghost
                        onClick={() => companionSendMsg('帮我复习一下薄弱知识点')}
                      >
                        {t('reviewWeakness')}
                      </Button>
                    ) : null}
                    <Button size="small" type="primary" ghost
                      onClick={() => companionSendMsg('给我做个学习计划')}
                    >
                      {t('makePlan')}
                    </Button>
                    <Button size="small" type="primary" ghost
                      onClick={() => companionSendMsg('今天有什么建议？')}
                    >
                      {t('todayAdvice')}
                    </Button>
                  </div>
                  {companionProfile && (
                    <div style={{ marginTop: 16, display: 'flex', gap: 16, fontSize: 13, color: '#888' }}>
                      {companionProfile.titles?.main && (
                        <span>🏆 {companionProfile.titles.main}</span>
                      )}
                      {companionProfile.total_points !== undefined && (
                        <span>⭐ {companionProfile.total_points} 积分</span>
                      )}
                      {companionProfile.streak_days > 0 && (
                        <span>🔥 {t('daysStreak', { count: companionProfile.streak_days })}</span>
                      )}
                    </div>
                  )}
                </div>
              )
            ) : (
              <div style={{ textAlign: 'center', paddingTop: 40, color: '#999' }}>
                <Typography.Title level={4} type="secondary">{t('emptyChatTitle')}</Typography.Title>
                <Typography.Text type="secondary">{t('emptyChatDesc')}</Typography.Text>
              </div>
            )
          ) : (
          activeMessages.map((msg: { role: string; content: string; id?: string }, i: number) => (
            <MessageBubble
              key={msg.id || i}
              msg={msg as Message}
              isStreaming={isAnyStreaming && i === activeMessages.length - 1 && msg.role === 'assistant'}
              onPreviewHtml={(html) => {
                setPreviewHtml(html);
                setShowPreview(true);
              }}
              companionMode={companionMode}
              companionName={curRole === 'teacher' || curRole === 'admin' ? t('assistant') : (companionConfig?.companion_name || t('companionName'))}
              companionPersonality={companionConfig?.personality}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 学伴侧边栏 */}
      {companionMode && companionSidebar && (
        <div style={{
          width: 280, borderLeft: '1px solid #e0daf5', padding: 16,
          overflow: 'auto', background: 'linear-gradient(180deg, #faf8ff 0%, #ffffff 100%)',
        }}>
          <Typography.Text strong style={{ fontSize: 14, display: 'block', marginBottom: 12, color: curRole === 'teacher' || curRole === 'admin' ? '#13c2c2' : '#5b4fa0' }}>
            {curRole === 'teacher' || curRole === 'admin' ? t('teachingData') : t('learningProfile')}
          </Typography.Text>

          {(curRole === 'teacher' || curRole === 'admin') ? (
            // ── 教师/管理员侧边栏 ──
            <>
              {/* 头部信息 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%',
                  background: 'linear-gradient(135deg, #52c41a, #13c2c2)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, flexShrink: 0,
                  boxShadow: '0 2px 8px rgba(82,196,26,0.25)',
                }}>🎓</div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#13c2c2' }}>{t('assistantMode')}</div>
                  <div style={{ fontSize: 11, color: '#999' }}>{t('greetingTeacherDesc')}</div>
                </div>
              </div>

              {/* 教学数据概览 */}
              {companionTeacherData ? (
                <>
                  {/* 核心指标卡片 */}
                  <div style={{
                    background: 'linear-gradient(135deg, #f0faf0, #f5fffa)',
                    borderRadius: 10, padding: 12, marginBottom: 12,
                    border: '1px solid #d9f0d9',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
                      {companionTeacherData.total_students !== undefined && (
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: '#52c41a' }}>{companionTeacherData.total_students}</div>
                          <div style={{ fontSize: 11, color: '#888' }}>{t('students')}</div>
                        </div>
                      )}
                      {companionTeacherData.exam_stats && (
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: '#1677ff' }}>{companionTeacherData.exam_stats.total}</div>
                          <div style={{ fontSize: 11, color: '#888' }}>{t('exams')}</div>
                        </div>
                      )}
                      {companionTeacherData.total_submissions !== undefined && (
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: '#fa8c16' }}>{companionTeacherData.total_submissions}</div>
                          <div style={{ fontSize: 11, color: '#888' }}>{t('submitted')}</div>
                        </div>
                      )}
                      {companionTeacherData.rollcall_this_week !== undefined && (
                        <div>
                          <div style={{ fontSize: 22, fontWeight: 700, color: '#722ed1' }}>{companionTeacherData.rollcall_this_week}</div>
                          <div style={{ fontSize: 11, color: '#888' }}>{t('rollcall')}</div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 今日概况 */}
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 12, lineHeight: 1.8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>{t('todayChats')}</span>
                      <span style={{ fontWeight: 600 }}>{companionTeacherData.today_chat_count ?? 0} {t('times')}</span>
                    </div>
                    {companionTeacherData.teacher_grade && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{t('grade')}</span>
                        <span style={{ fontWeight: 600 }}>{companionTeacherData.teacher_grade} {companionTeacherData.teacher_classes || ''}</span>
                      </div>
                    )}
                  </div>

                  {/* 考试状态 + 课堂互动 */}
                  <div style={{
                    background: '#fafafa', borderRadius: 8, padding: 10,
                    border: '1px solid #f0f0f0',
                  }}>
                    {companionTeacherData.exam_stats && (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#666', marginBottom: 4 }}>📋 {t('exams')}</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <Tag color="default" style={{ fontSize: 11 }}>{t('status.draft')} {companionTeacherData.exam_stats.draft}</Tag>
                          <Tag color="blue" style={{ fontSize: 11 }}>{t('status.published')} {companionTeacherData.exam_stats.published}</Tag>
                          <Tag color="green" style={{ fontSize: 11 }}>{t('status.ended')} {companionTeacherData.exam_stats.ended}</Tag>
                        </div>
                      </div>
                    )}
                    {(companionTeacherData.teacher_quiz_count !== undefined || companionTeacherData.teacher_poll_count !== undefined) && (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#666', marginBottom: 4 }}>🎯 {t('activity')}</div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {companionTeacherData.teacher_quiz_count !== undefined && <Tag color="purple" style={{ fontSize: 11 }}>{t('quiz')} {companionTeacherData.teacher_quiz_count}</Tag>}
                          {companionTeacherData.teacher_poll_count !== undefined && <Tag color="orange" style={{ fontSize: 11 }}>{t('poll')} {companionTeacherData.teacher_poll_count}</Tag>}
                          {companionTeacherData.teacher_question_count !== undefined && <Tag color="cyan" style={{ fontSize: 11 }}>{t('question')} {companionTeacherData.teacher_question_count}</Tag>}
                        </div>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '12px 0', color: '#ccc', fontSize: 12 }}>
                  {t('loadingTeachingData')}
                </div>
              )}
            </>
          ) : (
            // ── 学生侧边栏 ──
            companionProfile && (
            <>
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <span style={{ fontSize: 32 }}>{companionProfile.titles?.main === '初窥门径' ? '🥚' : '🏆'}</span>
                <div style={{ fontWeight: 600 }}>{companionProfile.titles?.main || t('companionName')}</div>
                <div style={{ fontSize: 12, color: '#999' }}>{companionProfile.total_points || 0} {t('points')}</div>
              </div>

              {/* 薄弱点 */}
              {companionProfile.weakness && companionProfile.weakness.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text type="danger" style={{ fontSize: 12, fontWeight: 600 }}>{t('weaknessKnowledge')}</Typography.Text>
                  {companionProfile.weakness.slice(0, 3).map((w, i) => (
                    <div key={i} style={{
                      fontSize: 12, padding: '4px 8px', marginTop: 4,
                      background: '#fff2f0', borderRadius: 4,
                    }}>
                      {w.kp}
                      <span style={{ color: '#ff4d4f', marginLeft: 4 }}>
                        {'❌'.repeat(Math.min(w.wrong_count, 3))}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* 考试趋势 */}
              {companionProfile.recent_exams && companionProfile.recent_exams.count > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text style={{ fontSize: 12, fontWeight: 600 }}>{t('examTrend')}</Typography.Text>
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    {t('averageScore')}：{companionProfile.recent_exams.avg}
                    <span style={{ marginLeft: 8, color: companionProfile.recent_exams.trend === '上升' ? '#52c41a' : companionProfile.recent_exams.trend === '下降' ? '#ff4d4f' : '#999' }}>
                      {companionProfile.recent_exams.trend === '上升' ? '📈' : companionProfile.recent_exams.trend === '下降' ? '📉' : '➡️'}
                      {companionProfile.recent_exams.trend === '上升' ? t('trendUp') : companionProfile.recent_exams.trend === '下降' ? t('trendDown') : ''}
                    </span>
                  </div>
                </div>
              )}

              {/* 连续学习 */}
              {companionProfile.streak_days > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text style={{ fontSize: 12, fontWeight: 600 }}>{t('streakDays')}</Typography.Text>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#fa8c16' }}>
                    {companionProfile.streak_days} {t('days')}
                  </div>
                </div>
              )}

              {/* 学习建议 */}
              {companionProfile.recommendation && (
                <div style={{
                  padding: 8, background: '#f6ffed', borderRadius: 4,
                  fontSize: 12, marginBottom: 16,
                }}>
                  <Typography.Text style={{ color: '#52c41a', fontWeight: 600 }}>{t('companionAdvice')}</Typography.Text>
                  <div style={{ marginTop: 4, color: '#666' }}>{companionProfile.recommendation}</div>
                </div>
              )}

              {/* 推送消息 */}
              {companionUnreadCount > 0 && (
                <div
                  onClick={() => { setPushModalOpen(true); companionLoadPushes(); }}
                  style={{
                    padding: 8, background: '#fff7e6', borderRadius: 4,
                    fontSize: 12, cursor: 'pointer',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#ffedd5'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#fff7e6'; }}
                >
                  <Typography.Text style={{ color: '#fa8c16', fontWeight: 600 }}>
                    {t('unreadMessages')}
                    <span style={{ float: 'right', fontSize: 11, fontWeight: 400, color: '#d48806' }}>{t('viewAll')}</span>
                  </Typography.Text>
                  <div style={{ marginTop: 4, color: '#666' }}>
                    {t('unreadCountMessage', { count: companionUnreadCount })}
                  </div>
                </div>
              )}
            </>
          ))}
        </div>
      )}
      </div>

      {/* 推送消息弹窗 */}
      <Modal
        open={pushModalOpen}
        onCancel={() => setPushModalOpen(false)}
        footer={null}
        width={420}
        styles={{ body: { padding: 0 } }}
      >
        <div style={{ maxHeight: 420, display: 'flex', flexDirection: 'column' }}>
          {/* 头部 */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 12px', borderBottom: '1px solid #f0f0f0',
          }}>
            <Typography.Text strong style={{ fontSize: 14 }}>{t('pushModalTitle')}</Typography.Text>
            <Space size={4}>
              {companionPushes.length > 0 && (
                <Button type="text" size="small" icon={<CheckOutlined />}
                  onClick={async () => {
                    await companionMarkAllPushesRead();
                    setPushModalOpen(false);
                  }}
                >
                  {t('markAllRead')}
                </Button>
              )}
            </Space>
          </div>
          {/* 列表 */}
          <div style={{ flex: 1, overflow: 'auto', minHeight: 100 }}>
            {companionPushes.length === 0 ? (
              <Empty description={t('noUnread')} style={{ padding: 24 }} />
            ) : (
              <List
                dataSource={companionPushes}
                renderItem={(item) => {
                  const PUSH_TYPES: Record<string, { color: string; icon: string; label: string }> = {
                    morning: { color: '#fa8c16', icon: '☀️', label: t('pushMorning') },
                    achievement: { color: '#52c41a', icon: '🏆', label: t('pushAchievement') },
                    encourage: { color: '#1677ff', icon: '💪', label: t('pushEncourage') },
                    reminder: { color: '#ff4d4f', icon: '📌', label: t('pushReminder') },
                    milestone: { color: '#722ed1', icon: '⭐', label: t('pushMilestone') },
                  }
                  const cfg = PUSH_TYPES[item.push_type] || { color: '#999', icon: '💌', label: item.push_type_label }
                  const isUnread = !item.is_read
                  return (
                    <List.Item
                      style={{
                        padding: '8px 12px',
                        background: isUnread ? '#f6f8ff' : 'transparent',
                        cursor: 'default',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#f5f5f5' }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = isUnread ? '#f6f8ff' : 'transparent'
                      }}
                      actions={[
                        isUnread ? (
                          <Button key="read" type="text" size="small" icon={<CheckOutlined />}
                            onClick={async () => {
                              await companionMarkPushRead(item.id);
                              companionLoadPushes();
                            }}
                          />
                        ) : null,
                        <Popconfirm key="delete" title={t('deleteConfirm')} placement="left"
                          onConfirm={async () => {
                            const { deletePush } = await import('../api/companion');
                            await deletePush(item.id);
                            companionLoadPushes();
                          }}
                        >
                          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                        </Popconfirm>,
                      ].filter(Boolean)}
                    >
                      <List.Item.Meta
                        avatar={<span style={{ fontSize: 18, lineHeight: '36px' }}>{cfg.icon}</span>}
                        title={
                          <Space size={4}>
                            <Typography.Text strong={isUnread} style={{ fontSize: 13 }}>{item.title}</Typography.Text>
                            <Tag color={cfg.color} style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', border: 'none' }}>{cfg.label}</Tag>
                            {isUnread && <Tag color="blue" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>{t('pushNew')}</Tag>}
                          </Space>
                        }
                        description={
                          <div>
                            {item.content && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{item.content}</Typography.Text>}
                            <br />
                            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                              {item.created_at ? new Date(item.created_at).toLocaleString('zh-CN') : ''}
                            </Typography.Text>
                          </div>
                        }
                      />
                    </List.Item>
                  )
                }}
              />
            )}
          </div>
          {/* 底部 */}
          {companionPushes.length > 0 && (
            <div style={{ borderTop: '1px solid #f0f0f0', padding: '6px 12px', textAlign: 'center' }}>
              <Button type="link" size="small"
                onClick={() => { setPushModalOpen(false); navigate('/notifications') }}
              >
                {t('viewAllMessages')} <RightOutlined />
              </Button>
            </div>
          )}
        </div>
      </Modal>

      {/* 输入区域 */}
      <div style={{
        padding: '12px 24px',
        borderTop: companionMode ? '1px solid #e0daf5' : '1px solid #f0f0f0',
        background: companionMode ? 'linear-gradient(0deg, #f8f6ff 0%, #ffffff 100%)' : '#fff',
        transition: 'all 0.3s ease',
      }}>
        <Space orientation="vertical" style={{ width: '100%' }} size={6}>
          {/* 图片预览 */}
          {imagePreviewHtml && (
            <div dangerouslySetInnerHTML={{ __html: imagePreviewHtml }} style={{ borderBottom: '1px solid #f0f0f0', padding: '4px 0' }} />
          )}

          {/* 隐藏的文件上传 input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".jpg,.jpeg,.png,.gif,.bmp,.webp,.txt,.md,.pdf,.csv,.json,.html,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
            onChange={handleNativeFileSelect}
            style={{ display: 'none' }}
          />

          <Space.Compact style={{ width: '100%' }}>
            <VoiceInput
              onTranscript={handleVoiceTranscript}
              disabled={isStreaming}
            />
            <TextArea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={companionMode ? (curRole === 'teacher' || curRole === 'admin' ? t('placeholderTeacher') : t('placeholderStudent', { name: companionConfig?.companion_name || t('companionName') })) : t('placeholderNormal')}
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={isAnyStreaming}
              style={{ flex: 1 }}
            />
            {isAnyStreaming ? (
              <Button icon={<StopOutlined />} onClick={companionMode ? companionStop : stopStreaming} danger>
                {t('stop')}
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={handleSend}
              >
                {t('send')}
              </Button>
            )}
            <Button icon={<CopyOutlined />} onClick={handleCopy} title={t('copy')} />
          </Space.Compact>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Tooltip title={t('upload')}>
              <Button icon={<UploadOutlined />} size="small" onClick={() => fileInputRef.current?.click()} />
            </Tooltip>
            <Tooltip title={t('cameraInput')}>
              <Button icon={<CameraOutlined />} size="small" onClick={() => setCameraOpen(true)} />
            </Tooltip>
            {filePaths.length > 0 && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('filesCount', { count: filePaths.length })}
                </Typography.Text>
                <Button type="link" size="small" danger icon={<DeleteOutlined />}
                  onClick={() => {
                    setFilePaths([]);
                    setImagePreviewHtml('');
                    fileUploadCache.clear();
                  }} />
              </>
            )}
            <Tooltip title={
              <span style={{ fontSize: 12, lineHeight: 1.6 }}>
                {t('contextEnhanceTip')}
              </span>
            }>
              <Checkbox checked={contextEnhance}
                onChange={(e) => setContextEnhance(e.target.checked)}>
                {t('summary')}
              </Checkbox>
            </Tooltip>
            <Tooltip title={
              <span style={{ fontSize: 12, lineHeight: 1.6 }}>
                {t('ragTip')}
              </span>
            }>
              <Checkbox checked={ragEnabled}
                onChange={(e) => setRagEnabled(e.target.checked)}>
                {t('knowledge')}
              </Checkbox>
            </Tooltip>
            {hasHtmlInResponse && (
              <Button size="small" icon={<EyeOutlined />} onClick={extractHtmlPreview}>
                {t('previewHtml')}
              </Button>
            )}
            <div style={{ width: 1, height: 20, background: '#e8e8e8', margin: '0 2px' }} />
            <Button size="small" icon={<PlusOutlined />} onClick={() => {
              // 清除图片预览和文件缓存
              setImagePreviewHtml('')
              setFilePaths([])
              fileUploadCache.clear()
              if (companionMode) {
                useCompanionStore.getState().clearMessages()
              } else {
                newTopic()
              }
            }}>
              {t('newTopic')}
            </Button>
            <Button size="small" icon={<HistoryOutlined />} onClick={handleOpenHistory}>
              {t('chatHistory')}
            </Button>
            {usage && (
              <Tooltip title={usage.multimodal_enabled ? t('multimodalTip') : t('textModelTip')}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontSize: 12, padding: '2px 8px', borderRadius: 4,
                  background: usage.multimodal_enabled ? '#e6f7ff' : '#f6f6f6',
                  color: usage.multimodal_enabled ? '#1677ff' : '#999',
                  border: '1px solid', borderColor: usage.multimodal_enabled ? '#91caff' : '#e8e8e8',
                  cursor: 'default', whiteSpace: 'nowrap',
                }}>
                  {usage.multimodal_enabled ? t('multimodal') : t('textOnly')}
                </span>
              </Tooltip>
            )}
            {usage && (
              <Tooltip
                title={usage.appid_configured ? t('useAgentTip') : t('useAgentDisabledTip')}
              >
                <Checkbox
                  checked={usage.appid_configured ? useAgent : false}
                  disabled={!usage.appid_configured}
                  onChange={(e) => setUseAgent(e.target.checked)}
                  style={{ fontSize: 12, marginLeft: 4 }}
                >
                  <span style={{ fontSize: 12, color: usage.appid_configured ? '#666' : '#bbb' }}>
                    {usage.appid_configured && useAgent ? t('useAgent') : t('directModel')}
                  </span>
                </Checkbox>
              </Tooltip>
            )}
            <div style={{ flex: 1, minWidth: 0 }} />
            {usage && (
              <div style={{ fontSize: 12, color: '#999', whiteSpace: 'nowrap' }}>
                {usage.remaining === -1 ? (
                  <span style={{ color: '#bbb' }}>{t('adminUnlimited')}</span>
                ) : usage.enabled ? (
                  <span>
                    <span style={{ color: usage.remaining > 5 ? '#52c41a' : usage.remaining > 0 ? '#faad14' : '#ff4d4f', marginRight: 4 }}>●</span>
                    {t('todayUsed', { used: usage.used, max: usage.max })}
                    {usage.remaining > 0
                      ? <span style={{ marginLeft: 4, color: '#aaa' }}>{t('remaining')} {usage.remaining}</span>
                      : <span style={{ marginLeft: 4, color: '#ff4d4f', fontWeight: 600 }}>{t('usedUp')}</span>}
                  </span>
                ) : (
                  <span style={{ color: '#bbb' }}>{t('rateLimitDisabled')}</span>
                )}
              </div>
            )}
          </div>
        </Space>
      </div>

      {/* 历史记录侧栏（点击文件加载到对话面板） */}
      <Drawer
        title={`📋 ${t('chatHistory')}`}
        placement="left"
        size={360}
        open={historyOpen}
        onClose={() => { setHistoryOpen(false); }}
      >
        <Spin spinning={historyLoading}>
          {historyTree.length > 0 ? (
            <Tree<TreeNode>
              treeData={historyTree}
              showLine
              onSelect={handleHistorySelect}
              titleRender={(node: TreeNode) => {
                const isCompanion = node.isLeaf && (node.title as string).startsWith('companion_')
                const displayTitle = node.isLeaf
                  ? (node.title as string).replace(/^companion_/, '').replace(/^conversation_/, '').replace(/\.md$/, '')
                  : node.title
                return (
                  <Space size={4} style={{ width: '100%' }} className="history-tree-node">
                    {node.isLeaf ? (isCompanion ? <span>🧠</span> : <FileOutlined />) : <FolderOutlined />}
                    {isCompanion && <Tag color="purple" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginRight: 0 }}>{t('companionLabel')}</Tag>}
                    <span style={{
                      fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap', maxWidth: 190,
                      display: 'inline-block', verticalAlign: 'middle',
                    }} title={node.title as string}>{displayTitle}</span>
                    <span onClick={(e) => e.stopPropagation()} className="history-delete-btn"
                      style={{ flexShrink: 0, opacity: 0, transition: 'opacity 0.2s' }}>
                      <Popconfirm title={t('confirmDeleteFile', { type: node.isLeaf ? t('file') : t('directory') })}
                        onConfirm={() => handleHistoryDelete(node.key)}>
                        <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </span>
                  </Space>
                )}}
            />
          ) : (
            <Typography.Text type="secondary">{t('noHistory')}</Typography.Text>
          )}
        </Spin>
      </Drawer>

      {/* 摄像头拍照 Modal */}
      <CameraCapture
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={handleCameraCapture}
      />

      {/* HTML 预览 Modal */}
      <Modal
        title={t('htmlPreview')}
        open={showPreview}
        onCancel={() => setShowPreview(false)}
        width="90%"
        footer={null}
        destroyOnHidden
      >
        <iframe
          srcDoc={previewHtml}
          style={{ width: '100%', height: '70vh', border: 'none' }}
          title={t('htmlPreview')}
          sandbox="allow-scripts allow-same-origin"
        />
      </Modal>

      {/* 多任务选择 Modal */}
      <Modal
        title={t('selectTaskTitle')}
        open={taskSelectOpen}
        onCancel={() => setTaskSelectOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Typography.Text type="secondary" style={{ marginBottom: 16, display: 'block' }}>
          {t('selectTaskDesc')}
        </Typography.Text>
        <Space orientation="vertical" style={{ width: '100%' }}>
          {pendingTasks.map(task => (
            <Card
              key={task.id}
              size="small"
              hoverable
              onClick={async () => {
                setTaskSelectOpen(false);
                await submitToTask(task);
              }}
              style={{ cursor: 'pointer' }}
            >
              <Space align="center">
                <SendOutlined style={{ fontSize: 18, color: '#1677ff' }} />
                <div>
                  <Typography.Text strong>{task.name}</Typography.Text>
                  {task.description && (
                    <Typography.Paragraph
                      ellipsis={{ rows: 1 }}
                      style={{ margin: 0, fontSize: 12, color: '#888', maxWidth: 260 }}
                    >
                      {task.description}
                    </Typography.Paragraph>
                  )}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('creator')}: {task.creator} ｜ {t('submitted')}: {task.submissions?.length || 0} {t('people')}
                  </Typography.Text>
                </div>
              </Space>
            </Card>
          ))}
        </Space>
      </Modal>

      {/* 全局动画 */}
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
        @keyframes voice-pulse {
          0% { box-shadow: 0 0 0 0 rgba(255, 77, 79, 0.6); }
          50% { box-shadow: 0 0 0 6px rgba(255, 77, 79, 0); }
          100% { box-shadow: 0 0 0 0 rgba(255, 77, 79, 0); }
        }
        .markdown-content p { margin-bottom: 4px; }
        .markdown-content pre { background: #f5f5f5; padding: 8px; border-radius: 4px; overflow-x: auto; }
        .markdown-content code { background: #f5f5f5; padding: 2px 4px; border-radius: 3px; font-size: 0.9em; }
        .markdown-content pre code.language-html {
          border-left: 3px solid #1677ff;
          padding-left: 8px;
        }
        .history-tree-node:hover .history-delete-btn {
          opacity: 1 !important;
        }
      `}</style>
    </Layout>
  )
}

export default ChatPage
