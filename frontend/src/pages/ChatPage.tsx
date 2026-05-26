import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Layout, Input, Button, Space, Checkbox, message, Modal,
  Typography, Dropdown, Tooltip, Tree, Drawer, Spin, Popconfirm, Card,
} from 'antd'
import {
  SendOutlined, StopOutlined, PlusOutlined,
  ReloadOutlined, EyeOutlined, UploadOutlined,
  DeleteOutlined, HistoryOutlined, FileOutlined, FolderOutlined,
  CopyOutlined, CameraOutlined,
} from '@ant-design/icons'
import type { Message, TreeNode, TaskInfo } from '../types'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useChatStore, fileUploadCache, loadHistoryAsNewTopic, setTaskFilename } from '../stores/chatStore'
import { useAuthStore } from '../stores/authStore'
import * as historyApi from '../api/history'
import * as tasksApi from '../api/tasks'
import * as chatApi from '../api/chat'
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

const MessageBubble: React.FC<{
  msg: Message
  isStreaming?: boolean
  onPreviewHtml?: (htmlContent: string) => void
}> = ({ msg, isStreaming, onPreviewHtml }) => {
  const isUser = msg.role === 'user'

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
            预览
          </Button>
        )}
      </div>
    )
  }

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
  // 智能教育助手 - SmartKB
  const {
    messages, isStreaming, currentText, filePaths,
    contextEnhance, sendMessage, stopStreaming, newTopic,
    setFilePaths, setContextEnhance,
    historyTree, historyLoading,
    loadHistoryTree,
  } = useChatStore()

  const curUser = useAuthStore((s) => s.user)

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
      message.loading({ content: '加载中...', key: 'history' });
      try {
        const result = await historyApi.readHistoryFile(key);
        if (result) {
          const msgs = parseHistoryContent(result.content);
          // 用原子操作替换整个对话（含 _loadingHistory 保护）
          loadHistoryAsNewTopic(msgs);

          // 自动将历史文件作为附件上传，方便用户对文件内容提问
          if (result.filename) {
            const file = new File([result.content], result.filename, { type: 'text/markdown' });
            fileUploadCache.clear();
            fileUploadCache.set(result.filename, file);
            setFilePaths([result.filename]);
            setImagePreviewHtml('');
            message.info({ content: `已附加「${result.filename}」，可对该文件提问`, key: 'attach-info', duration: 3 });
          }
        }
      } finally {
        message.success({ content: '已加载', key: 'history' });
      }
    }
  }, [parseHistoryContent, setFilePaths]);

  // 删除历史文件或目录
  const handleHistoryDelete = useCallback(async (path: string) => {
    try {
      const msg = await historyApi.deleteHistoryFile(path);
      message.success(msg || '已删除');
      // 重新加载树
      await loadHistoryTree();
    } catch (e: unknown) {
      console.error('删除失败:', e);
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      message.error(err?.response?.data?.detail || err?.message || '删除失败');
    }
  }, [loadHistoryTree]);

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
      `**${m.role === 'user' ? '用户' : '助手'}**: ${m.content}`
    ).join('\n\n---\n\n');
    if (!content.trim()) {
      message.warning('对话内容为空，请先进行对话');
      return;
    }
    try {
      const res = await tasksApi.submitTask(task.id, content);
      message.success(res.message);
      // 设置下次自动保存使用任务相关文件名
      setTaskFilename(task.name);
      useChatStore.getState().addSystemMessage(`✅ 已提交到任务「${task.name}」`);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string };
      message.error(e?.response?.data?.detail || e?.message || '提交失败');
    }
  }, []);

  // 检测并处理任务关键词
  const handleTaskCommand = useCallback(async (text: string): Promise<boolean> => {
    // 模式1: "提交xxx任务" 或 "提交xxx任务：说明" → 创建任务（可选说明）
    const createMatch = text.match(/^提交(.+?)任务(?:[：:]\s*(.*))?$/);
    if (createMatch) {
      const taskName = createMatch[1].trim();
      const taskDesc = (createMatch[2] || '').trim();
      if (!taskName) return false;
      if (curUser?.role !== 'admin' && curUser?.role !== 'teacher') {
        message.warning('仅管理员和教师可创建任务');
        return true;
      }
      try {
        const res = await tasksApi.createTask(taskName, taskDesc || undefined);
        message.success(res.message);
        const descText = taskDesc ? `（${taskDesc}）` : '';
        useChatStore.getState().addSystemMessage(`✅ 任务「${taskName}」${descText}已创建成功`);
        return true;
      } catch (err: unknown) {
        const e = err as { response?: { data?: { detail?: string } }; message?: string };
        message.error(e?.response?.data?.detail || e?.message || '创建任务失败');
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
          message.warning(`未找到活动任务「${taskName}」`);
          return true;
        }
        await submitToTask(target);
        return true;
      } catch (err: unknown) {
        const e = err as { response?: { data?: { detail?: string } }; message?: string };
        message.error(e?.response?.data?.detail || e?.message || '提交失败');
        return true;
      }
    }

    // 模式3: "完成" 或 "结束" → 提交任务（多任务时弹出选择）
    if (/^(完成|结束)$/.test(text.trim())) {
      try {
        const { tasks } = await tasksApi.getActiveTasks();
        const activeTasks = tasks.filter(t => t.status === 'active');
        if (activeTasks.length === 0) {
          message.info('当前没有活动任务可提交');
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
        message.error(e?.response?.data?.detail || e?.message || '提交任务失败');
        return true;
      }
    }
    return false;
  }, [curUser, submitToTask]);

  const handleSend = async () => {
    if (!input.trim() && filePaths.length === 0) return
    // 先检测是否是任务命令
    const handled = await handleTaskCommand(input);
    if (handled) {
      setInput('');
      return;
    }
    sendMessage(input)
    setInput('')
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
      message.info('未找到 HTML 代码块');
    }
  }, [messages]);

  // 复制对话内容
  const handleCopy = useCallback(() => {
    const text = messages.map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content}`).join('\n\n---\n\n');
    navigator.clipboard.writeText(text).then(
      () => message.success('已复制'),
      () => message.error('复制失败')
    );
  }, [messages]);

  const moreMenu = {
    items: [
      { key: 'preview', icon: <EyeOutlined />, label: '预览 HTML', disabled: !hasHtmlInResponse },
      { key: 'copy', icon: <CopyOutlined />, label: '复制对话' },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'preview') extractHtmlPreview();
      if (key === 'copy') handleCopy();
    },
  }

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
      {/* 消息列表 */}
      <div style={{
        flex: 1, overflow: 'auto', padding: 24,
        background: '#fafafa',
      }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 40, color: '#999' }}>
            <Typography.Title level={4} type="secondary">开始一段新对话</Typography.Title>
            <Typography.Text type="secondary">在下方输入问题，或上传文件进行分析</Typography.Text>
          </div>
        ) : (
          messages.map((msg: Message, i: number) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              isStreaming={isStreaming && i === messages.length - 1 && msg.role === 'assistant'}
              onPreviewHtml={(html) => {
                setPreviewHtml(html);
                setShowPreview(true);
              }}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div style={{ padding: '12px 24px', borderTop: '1px solid #f0f0f0', background: '#fff' }}>
        <Space direction="vertical" style={{ width: '100%' }} size={6}>
          {/* 图片预览 */}
          {imagePreviewHtml && (
            <div dangerouslySetInnerHTML={{ __html: imagePreviewHtml }} style={{ borderBottom: '1px solid #f0f0f0', padding: '4px 0' }} />
          )}
          <Space size={8} wrap>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".jpg,.jpeg,.png,.gif,.bmp,.webp,.txt,.md,.pdf,.csv,.json,.html,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
              onChange={handleNativeFileSelect}
              style={{ display: 'none' }}
            />
            <Tooltip title="上传文件">
              <Button icon={<UploadOutlined />} size="small" onClick={() => fileInputRef.current?.click()} />
            </Tooltip>
            <Tooltip title="拍照输入">
              <Button icon={<CameraOutlined />} size="small" onClick={() => setCameraOpen(true)} />
            </Tooltip>
            {filePaths.length > 0 && (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {filePaths.length} 个文件
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
                开启后 AI 会先摘要文件再回答，关闭则直接交由 AI 处理
              </span>
            }>
              <Checkbox checked={contextEnhance}
                onChange={(e) => setContextEnhance(e.target.checked)}>
                文件摘要增强
              </Checkbox>
            </Tooltip>
            {hasHtmlInResponse && (
              <Button size="small" icon={<EyeOutlined />} onClick={extractHtmlPreview}>
                预览 HTML
              </Button>
            )}
          </Space>

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
              placeholder="输入问题 (Ctrl+Enter 发送)"
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={isStreaming}
              style={{ flex: 1 }}
            />
            {isStreaming ? (
              <Button icon={<StopOutlined />} onClick={stopStreaming} danger>
                停止
              </Button>
            ) : (
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={handleSend}
              >
                发送
              </Button>
            )}
            <Dropdown menu={moreMenu} trigger={['click']}>
              <Button icon={<ReloadOutlined />} />
            </Dropdown>
          </Space.Compact>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Button size="small" icon={<PlusOutlined />} onClick={newTopic}>
              新话题
            </Button>
            <Button size="small" icon={<HistoryOutlined />} onClick={handleOpenHistory}>
              历史记录
            </Button>
            {/* ── 用量指示器（右对齐） ── */}
            <div style={{ flex: 1, minWidth: 0 }} />
            {usage && (
              <div style={{ fontSize: 12, color: '#999', whiteSpace: 'nowrap' }}>
                {usage.remaining === -1 ? (
                  <span style={{ color: '#bbb' }}>● 管理员不受限</span>
                ) : usage.enabled ? (
                  <span>
                    <span style={{ color: usage.remaining > 5 ? '#52c41a' : usage.remaining > 0 ? '#faad14' : '#ff4d4f', marginRight: 4 }}>●</span>
                    今日 {usage.used}/{usage.max} 次
                    {usage.remaining > 0
                      ? <span style={{ marginLeft: 4, color: '#aaa' }}>剩 {usage.remaining}</span>
                      : <span style={{ marginLeft: 4, color: '#ff4d4f', fontWeight: 600 }}>已用完</span>}
                  </span>
                ) : (
                  <span style={{ color: '#bbb' }}>● 限流未启用</span>
                )}
              </div>
            )}
          </div>
        </Space>
      </div>

      {/* 历史记录侧栏（点击文件加载到对话面板） */}
      <Drawer
        title="📋 历史对话记录"
        placement="left"
        width={360}
        open={historyOpen}
        onClose={() => { setHistoryOpen(false); }}
      >
        <Spin spinning={historyLoading}>
          {historyTree.length > 0 ? (
            <Tree<TreeNode>
              treeData={historyTree}
              showLine
              onSelect={handleHistorySelect}
              titleRender={(node: TreeNode) => (
                <Space size={4}>
                  {node.isLeaf ? <FileOutlined /> : <FolderOutlined />}
                  <span style={{ fontSize: 13 }}>{node.title}</span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <Popconfirm
                      title={`确认删除${node.isLeaf ? '文件' : '整个目录'}？`}
                      onConfirm={() => handleHistoryDelete(node.key)}
                    >
                      <Button type="link" size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </span>
                </Space>
              )}
            />
          ) : (
            <Typography.Text type="secondary">暂无历史记录</Typography.Text>
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
        title="HTML 预览"
        open={showPreview}
        onCancel={() => setShowPreview(false)}
        width="90%"
        footer={null}
        destroyOnClose
      >
        <iframe
          srcDoc={previewHtml}
          style={{ width: '100%', height: '70vh', border: 'none' }}
          title="HTML Preview"
          sandbox="allow-scripts allow-same-origin"
        />
      </Modal>

      {/* 多任务选择 Modal */}
      <Modal
        title="📋 选择要提交的任务"
        open={taskSelectOpen}
        onCancel={() => setTaskSelectOpen(false)}
        footer={null}
        destroyOnClose
      >
        <Typography.Text type="secondary" style={{ marginBottom: 16, display: 'block' }}>
          检测到多个活动任务，请选择要提交到的任务：
        </Typography.Text>
        <Space direction="vertical" style={{ width: '100%' }}>
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
                    创建者: {task.creator} ｜ 已提交: {task.submissions?.length || 0} 人
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
      `}</style>
    </Layout>
  )
}

export default ChatPage
