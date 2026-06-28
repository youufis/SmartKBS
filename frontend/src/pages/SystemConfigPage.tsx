import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Tabs, Form, Input, InputNumber, Button, message, Switch,
  Spin, Typography, Divider, Space, Alert, Tag, Checkbox,
} from 'antd'
import {
  SaveOutlined, SettingOutlined, ReloadOutlined, WarningOutlined, ExclamationCircleOutlined,
  SyncOutlined, DownloadOutlined, RollbackOutlined, SearchOutlined, DeleteOutlined, EyeOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
} from '@ant-design/icons'
import { Modal, Timeline, Progress, Descriptions, Table } from 'antd'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import {
  checkVersion, startUpgrade, getUpgradeStatus,
  rollback as apiRollback, getHistory, deleteHistory,
  cancelUpgrade,
  type VersionInfo, type UpgradeProgress,
} from '../api/upgrade'

const { Title, Text } = Typography

// ── 全局配置表单 ──

const GLOBAL_CONFIG_FIELDS = [
  // 品牌信息
  { key: 'AGENT_EDITION', label: '平台版本', type: 'text', group: 'brand',
    desc: '显示在登录页面 "智慧教学平台-" 之后的版本名称，留空则只显示"智慧教学平台"。例如可设为"数学版"、"生物版"等' },
  { key: 'ORG_NAME', label: '单位名称', type: 'text', group: 'brand', required: false,
    desc: '显示在登录页面和界面顶部的单位/学校名称，为空则不显示' },
  // API 密钥
  { key: 'dashscope_api_key', label: 'DashScope API Key', type: 'password', group: 'api',
    desc: '全局兜底密钥，用户未配置时使用。如已设置环境变量 DASHSCOPE_API_KEY 则优先使用，此处可不填' },
  // 模型与应用配置
  { key: 'APPID', label: 'APPID', type: 'text', group: 'model', required: false,
    desc: '【可选】留空则直接调用大模型（使用下方「默认对话模型」）；填写后调用百炼智能体应用。注意：APPID 必须与上方的 DASHSCOPE_API_KEY 归属于同一个阿里云账号，否则无法调用。创建路径：百炼 → 应用中心 → 我的应用 → 创建智能体应用 → 复制 APPID' },
  { key: 'QWEN_OPENAI_API_BASE', label: 'API 基础地址', type: 'text', group: 'model',
    desc: 'DashScope API 调用地址，通常无需修改' },
  { key: 'MODEL_LONG_NAME', label: '长文本模型', type: 'text', group: 'model',
    desc: '用于长文档处理的模型名称，如 qwen-long' },
  { key: 'MODEL_VL_NAME', label: '视觉模型', type: 'text', group: 'model',
    desc: '用于图像理解的模型名称，如 qwen3-vl-plus' },
  { key: 'MODEL_NAME', label: '默认对话模型', type: 'text', group: 'model',
    desc: '推荐: deepseek-v4-flash、qwen3.5-flash 等' },
  { key: 'ENABLE_MULTIMODAL', label: '多模态', type: 'multimodal_toggle', group: 'model',
    desc: '开启后对话中发送图片时使用多模态格式（图片+文本同时输入）。请确认模型是支持多模态，勾选后将视为多模态模型处理' },
  // AI 对话权限
  { key: 'ENABLE_AI_CHAT_FOR_ROLES', label: 'AI 对话权限', type: 'roles', group: 'ai',
    desc: '选择可使用 AI 对话的角色（管理员始终可用）' },
  // 系统限制
  { key: 'MAX_DOC_SIZE_MB', label: '文档大小限制 (MB)', type: 'number', group: 'limit' },
  { key: 'MAX_IMAGE_SIZE_MB', label: '图片大小限制 (MB)', type: 'number', group: 'limit' },
  { key: 'JWT_EXPIRATION_HOURS', label: 'Token 有效期 (小时)', type: 'number', group: 'limit' },
  { key: 'ONLINE_USER_TIMEOUT_SECONDS', label: '在线超时 (秒)', type: 'number', group: 'limit' },
  { key: 'ENABLE_REQUEST_LIMIT', label: '启用请求频率限制', type: 'boolean', group: 'limit' },
  { key: 'MAX_ALLOWED_REQUESTS', label: '每日最大请求数', type: 'number', group: 'limit' },
  { key: 'TEACHER_DOWNLOAD_QUOTA_GB', label: '教师下载配额 (GB)', type: 'number', group: 'limit',
    desc: '每位教师下载中心的最大存储空间' },
  // 课程设置
  { key: 'SUBJECTS', label: '课程名称列表', type: 'tags', group: 'subjects',
    desc: '系统中使用的课程名称，多个用逗号分隔（示例：数学,语文,英语）。修改后需重启服务生效' },
  // 题型设置
  { key: 'QUESTION_TYPES', label: '试题题型列表', type: 'question_types', group: 'subjects',
    desc: '每行一个题型，格式为 "key:标签"，如 single:单选题。增删改后刷新页面即可生效，无需重启' },
  // 消息通知
  { key: 'enabled_notification_types', label: '启用的通知类型', type: 'notifications', group: 'notify',
    desc: '关闭的通知类型将不会推送给任何用户' },
  // 文件类型白名单
  { key: 'IMAGE_EXTENSIONS', label: '图片文件扩展名', type: 'tags', group: 'filetype',
    desc: '允许上传的图片格式，多个用逗号分隔，如 .jpg,.jpeg,.png' },
  { key: 'DOCUMENT_EXTENSIONS', label: '文档文件扩展名', type: 'tags', group: 'filetype',
    desc: '允许上传的文档格式，多个用逗号分隔，如 .txt,.md,.pdf' },
  // 图片生成
  { key: 'IMAGE_GEN_ENABLED', label: '启用AI生图功能', type: 'boolean', group: 'imagegen',
    desc: '关闭后试题的图片占位符不会自动调用生图模型，仅保留占位符描述' },
  { key: 'IMAGE_GEN_MODEL', label: '生图模型', type: 'text', group: 'imagegen',
    desc: '通义万相：wanx2.1-t2i-turbo(快速,0.02元/张) / wanx2.1-t2i-plus(高清,0.08元/张)' },
  { key: 'IMAGE_GEN_SIZE', label: '生图尺寸', type: 'text', group: 'imagegen',
    desc: 'DashScope格式：1024*1024(方形) / 720*1280(竖屏) / 1280*720(横屏)' },
  // 闯关挑战
  { key: 'QUEST_USE_BANK', label: '闯关出题模式', type: 'boolean', group: 'quest',
    desc: '🟢 开启（ON）→ 题库出题模式，从闯关题库中随机抽题\n🔴 关闭（OFF）→ AI 出题模式，由 AI 即时生成百科题目' },
]

const GROUP_LABELS: Record<string, string> = {
  brand: '🏷️ 品牌信息',
  api: '🔑 API 密钥',
  model: '🤖 模型与应用配置',
  ai: '💬 AI 对话设置',
  subjects: '📚 课程设置',
  limit: '⚙️ 系统限制',
  notify: '🔔 消息通知',
  filetype: '📁 文件类型白名单',
  imagegen: '🎨 图片生成',
  quest: '⚡ 闯关挑战',
}

const SystemConfigPage: React.FC = () => {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const [activeTab, setActiveTab] = useState('global')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [apikeyStatus, setApikeyStatus] = useState<{ status: string; source: string; hint: string; configured: boolean } | null>(null)
  const [form] = Form.useForm()

  // ── 加载 API Key 状态 ──
  const loadApikeyStatus = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/api/config/apikey-status')
      setApikeyStatus(data)
    } catch {
      // 忽略，非关键信息
    }
  }, [])

  // ── 加载全局配置 ──
  const loadConfig = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/config')
      setConfig(data)
      // 将数组字段转为逗号分隔字符串供 Tags 输入框展示
      const formValues = { ...data }
      for (const key of ['IMAGE_EXTENSIONS', 'DOCUMENT_EXTENSIONS']) {
        if (Array.isArray(formValues[key])) {
          formValues[key] = formValues[key].join(',')
        }
      }
      // 题型数组 [{key,label}] → 多行文本 key:label
      if (Array.isArray(formValues['QUESTION_TYPES'])) {
        formValues['QUESTION_TYPES'] = formValues['QUESTION_TYPES']
          .map((t: { key: string; label: string }) => `${t.key}:${t.label}`)
          .join('\n')
      }
      form.setFieldsValue(formValues)
      // 同时刷新 API Key 状态
      loadApikeyStatus()
    } catch {
      message.error('加载系统配置失败')
    } finally {
      setLoading(false)
    }
  }, [form, loadApikeyStatus])

  // ── 保存全局配置 ──
  const handleSave = async () => {
    try {
      await form.validateFields()
      setSaving(true)
      // 使用 getFieldsValue 确保所有字段（包括空值）都被提交
      const allValues = form.getFieldsValue()
      // 将 Tags 输入框的逗号分隔字符串转回数组（支持中英文逗号）
      for (const key of ['IMAGE_EXTENSIONS', 'DOCUMENT_EXTENSIONS', 'SUBJECTS']) {
        if (typeof allValues[key] === 'string') {
          allValues[key] = allValues[key].replace(/，/g, ',').split(',').map((s: string) => s.trim()).filter(Boolean)
        }
      }
      // 题型多行文本 key:label → [{key,label}]
      if (typeof allValues['QUESTION_TYPES'] === 'string') {
        allValues['QUESTION_TYPES'] = allValues['QUESTION_TYPES']
          .split('\n')
          .map((line: string) => line.trim())
          .filter(Boolean)
          .map((line: string) => {
            const [k, ...rest] = line.split(':')
            return { key: k.trim(), label: rest.join(':').trim() || k.trim() }
          })
      }
      await apiClient.put('/api/config', { config: allValues })
      message.success('系统配置已保存（部分配置需重启服务生效）')
      loadConfig()
    } catch (err: unknown) {
      const e = err as { errorFields?: unknown; response?: { data?: { detail?: string } }; message?: string }
      if (e?.errorFields) return // 表单校验未通过
      message.error('保存失败: ' + (e?.response?.data?.detail || e?.message || '未知错误'))
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (user?.role !== 'admin') return

    const init = async () => {
      setLoading(true)
      try {
        const { data } = await apiClient.get('/api/config')
        setConfig(data)
        const formValues = { ...data }
        for (const key of ['IMAGE_EXTENSIONS', 'DOCUMENT_EXTENSIONS', 'SUBJECTS']) {
          if (Array.isArray(formValues[key])) {
            formValues[key] = formValues[key].join(',')
          }
        }
        if (Array.isArray(formValues['QUESTION_TYPES'])) {
          formValues['QUESTION_TYPES'] = formValues['QUESTION_TYPES']
            .map((t: { key: string; label: string }) => `${t.key}:${t.label}`)
            .join('\n')
        }
        if (!formValues['enabled_notification_types']) {
          formValues['enabled_notification_types'] = ['exam']
        }
        form.setFieldsValue(formValues)
        loadApikeyStatus()
      } catch {
        message.error('加载系统配置失败')
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [user, form, loadApikeyStatus])

  // 非管理员重定向到 AI 对话
  if (user?.role !== 'admin') {
    navigate('/chat', { replace: true })
    return null
  }

  // ── 全局配置表单各分组 ──
  const renderGroup = (group: string) => {
    const fields = GLOBAL_CONFIG_FIELDS.filter((f) => f.group === group)
    return (
      <div key={group} style={{ marginBottom: 32 }}>
        <Title level={5}>{GROUP_LABELS[group]}</Title>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: 16 }}>
          {fields.map((field) => (
            <div key={field.key}>
              {field.type === 'boolean' ? (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  valuePropName="checked"
                  extra={field.desc}
                >
                  <Switch />
                </Form.Item>
              ) : field.type === 'number' ? (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  rules={[{ required: true, message: `请输入${field.label}` }]}
                >
                  <InputNumber style={{ width: '100%' }} min={0} />
                </Form.Item>
              ) : field.type === 'password' ? (
                <Form.Item
                  name={field.key}
                  label={
                    <Space size={4}>
                      <span>{field.label}</span>
                      {field.key === 'dashscope_api_key' && apikeyStatus && (
                        apikeyStatus.status === 'env' ? (
                          <Tag color="green" style={{ fontSize: 11, lineHeight: '18px', marginLeft: 4 }}>
                            ✅ 环境变量
                          </Tag>
                        ) : apikeyStatus.status === 'config' ? (
                          <Tag color="blue" style={{ fontSize: 11, lineHeight: '18px', marginLeft: 4 }}>
                            📋 系统配置
                          </Tag>
                        ) : (
                          <Tag color="red" style={{ fontSize: 11, lineHeight: '18px', marginLeft: 4 }}>
                            ❌ 未配置
                          </Tag>
                        )
                      )}
                    </Space>
                  }
                  extra={field.desc}
                >
                  <Input.Password placeholder={apikeyStatus?.configured ? '留空则不覆盖已有值' : '请输入 API Key'} />
                </Form.Item>
              ) : field.type === 'tags' ? (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  rules={[{ required: true, message: `请输入${field.label}` }]}
                  extra={field.desc}
                  getValueFromEvent={(e) => e.target.value}
                >
                  <Input placeholder="多个扩展名用逗号分隔，如 .jpg,.png" />
                </Form.Item>
              ) : field.type === 'question_types' ? (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  rules={[{ required: true, message: `请输入${field.label}` }]}
                  extra={field.desc}
                  getValueFromEvent={(e) => e.target.value}
                >
                  <Input.TextArea rows={7} placeholder={'格式：每行一个 "key:标签"\nsingle:单选题\nmultiple:多选题\ntrue_false:判断题\nshort:简答题\nfill:填空题\nessay:作文\nsubjective:主观题'} />
                </Form.Item>
              ) : field.type === 'roles' ? (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  extra={field.desc}
                >
                  <Checkbox.Group>
                    <Checkbox value={1}>教师</Checkbox>
                    <Checkbox value={2}>学生</Checkbox>
                  </Checkbox.Group>
                </Form.Item>
              ) : field.type === 'notifications' ? (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  extra={field.desc}
                >
                  <Checkbox.Group>
                    <Checkbox value="exam">📝 考试通知</Checkbox>
                    <Checkbox value="share">📤 资源共享通知</Checkbox>
                    <Checkbox value="score">🏆 积分变动通知</Checkbox>
                    <Checkbox value="task">✅ 任务提交通知</Checkbox>
                    <Checkbox value="rollcall">📋 点名通知</Checkbox>
                    <Checkbox value="info">ℹ️ 系统信息通知</Checkbox>
                  </Checkbox.Group>
                </Form.Item>
              ) : field.type === 'multimodal_toggle' ? (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  valuePropName="checked"
                  extra={field.desc}
                >
                  <Checkbox>
                    启用多模态对话（支持图片+文本同时输入）
                  </Checkbox>
                </Form.Item>
              ) : (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  rules={field.required !== false ? [{ required: true, message: `请输入${field.label}` }] : undefined}
                  extra={field.key === 'AGENT_EDITION' ? '填写版本名称即可，系统会自动拼接为完整名称（如 "数学版"、"生物版"），留空则只显示"智慧教学平台"' : field.desc}
                >
                  {field.key === 'AGENT_EDITION' ? (
                    <Input placeholder="例如：通用版" />
                  ) : (
                    <Input />
                  )}
                </Form.Item>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ═══════════════════════════════════════════════
  //  升级管理 Tab 组件
  // ═══════════════════════════════════════════════

  const UpgradePanel: React.FC = () => {
    const [verInfo, setVerInfo] = useState<VersionInfo | null>(null)
    const [verLoading, setVerLoading] = useState(false)
    const [upgrading, setUpgrading] = useState(false)
    const [upgradeProg, setUpgradeProg] = useState<UpgradeProgress | null>(null)
    const [histList, setHistList] = useState<any[]>([])
    const [histTotal, setHistTotal] = useState(0)
    const [histPage, setHistPage] = useState(1)
    const [histPageSize, setHistPageSize] = useState(10)
    const pollRef = useRef<number | undefined>(undefined)

    const loadVersion = useCallback(async () => {
      setVerLoading(true)
      try {
        const info = await checkVersion()
        setVerInfo(info)
      } catch (e: any) {
        message.error('版本检测失败: ' + (e?.response?.data?.detail || e.message))
      }
      setVerLoading(false)
    }, [])

    const loadHistory = useCallback(async (page = 1, pageSize = 10) => {
      try {
        const res = await getHistory(page, pageSize)
        setHistList(res.history || [])
        setHistTotal(res.total)
        setHistPage(res.page)
      } catch { /* ignore */ }
    }, [])

    const handleUpgrade = () => {
      Modal.confirm({
        title: '确认执行增量升级?',
        icon: <WarningOutlined />,
        content: (
          <div>
            <p>升级过程将自动完成以下步骤：</p>
            <ol>
              <li>从 GitHub 增量拉取最新代码（仅传输差异）</li>
              <li>同步到 origin/master</li>
              <li>执行数据库迁移</li>
              <li>增量安装 Python 依赖</li>
              <li>重启服务（短暂离线后自动恢复）</li>
            </ol>
            <p style={{ color: 'red' }}>⚠️ 升级期间系统可能短暂不可用（通常 1-3 分钟）</p>
            <p>💡 回滚机制：升级失败自动通过 git reflog 回滚，无需手动备份</p>
          </div>
        ),
        okText: '确认升级',
        cancelText: '取消',
        onOk: async () => {
          try {
            const { task_id } = await startUpgrade()
            setUpgrading(true)
            pollRef.current = setInterval(async () => {
              try {
                const st = await getUpgradeStatus()
                setUpgradeProg(st)
                if (!st.running) {
                  clearInterval(pollRef.current)
                  setUpgrading(false)
                  if (st.error) {
                    message.error('升级失败: ' + st.error)
                  } else {
                    message.success('🎉 升级完成！请刷新页面')
                  }
                  loadHistory()
                }
              } catch {
                // 服务重启中，HTTP 请求会暂时失败，静默等待重试
              }
            }, 2000)
          } catch (e: any) {
            message.error('启动升级失败: ' + (e?.response?.data?.detail || e.message))
          }
        },
      })
    }

    const handleRollback = () => {
      Modal.confirm({
        title: '确认回滚到升级前状态?',
        icon: <ExclamationCircleOutlined />,
        content: '将使用最近的备份恢复代码和数据，并重启服务。此操作可撤销一次不成功的升级。',
        okText: '确认回滚',
        okType: 'danger',
        cancelText: '取消',
        onOk: async () => {
          try {
            await apiRollback()
            message.success('回滚完成，请刷新页面')
            loadHistory()
          } catch (e: any) {
            message.error('回滚失败: ' + (e?.response?.data?.detail || e.message))
          }
        },
      })
    }

    useEffect(() => {
      loadVersion()
      loadHistory()
      return () => { if (pollRef.current) clearInterval(pollRef.current) }
    }, [loadVersion, loadHistory])

    const handleDeleteHistory = (task_id: string) => {
      Modal.confirm({
        title: '确认删除该条升级记录?',
        icon: <ExclamationCircleOutlined />,
        content: '删除后不可恢复。',
        okText: '确认删除',
        okType: 'danger',
        cancelText: '取消',
        onOk: async () => {
          try {
            await deleteHistory(task_id)
            message.success('已删除')
            loadHistory(histPage, histPageSize)
          } catch (e: any) {
            message.error('删除失败: ' + (e?.response?.data?.detail || e.message))
          }
        },
      })
    }

    return (
      <Spin spinning={verLoading}>
        {/* Git 环境问题警告 */}
        {verInfo && (!verInfo.git_available || verInfo.git_issues.length > 0) && (
          <Alert
            type="error"
            showIcon
            message="🛠️ Git 环境异常，无法在线升级"
            description={
              <div>
                {!verInfo.git_available ? (
                  <span>
                    未检测到 Git 命令。请安装 Git 后重试。<br />
                    <a href={verInfo.git_download_url} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 'bold' }}>
                      点击下载 Git for Windows ⏬
                    </a>
                    &nbsp;（安装后需回收 IIS 应用池使 PATH 生效）
                  </span>
                ) : (
                  <div>
                    {verInfo.git_issues.map((issue, i) => (
                      <div key={i} style={{ whiteSpace: 'pre-wrap', marginBottom: i < verInfo.git_issues.length - 1 ? 12 : 0 }}>
                        {issue.split('\n').map((line, j) => <div key={j}>{line || '\u00a0'}</div>)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            }
            style={{ marginBottom: 16 }}
          />
        )}
        {/* 版本信息 */}
        {verInfo && (
          <Card style={{ marginBottom: 16 }}>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label="当前版本">
                <Tag color="blue">{verInfo.current_version}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="最新版本">
                <Tag color={verInfo.has_update ? 'green' : 'default'}>{verInfo.latest_version}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                {verInfo.has_update
                  ? <Tag color="green">📥 {verInfo.latest_version !== verInfo.current_version
                      ? `新版本 ${verInfo.latest_version} 可用`
                      : `有 ${verInfo.behind_commits} 个新提交可更新`}（落后 {verInfo.behind_commits} 个提交）</Tag>
                  : <Tag>✅ 已是最新版本</Tag>}
              </Descriptions.Item>
              {verInfo.release_date && (
                <Descriptions.Item label="发布日期">{verInfo.release_date}</Descriptions.Item>
              )}
            </Descriptions>

            {/* 更新日志 */}
            {verInfo.changelog && verInfo.changelog.length > 0 && (
              <>
                <Divider />
                <Title level={5}>📋 更新日志</Title>
                <Timeline items={verInfo.changelog.map((c: string) => ({ children: c }))} />
              </>
            )}

            {/* 不兼容变更警告 */}
            {verInfo.breaking_changes && verInfo.breaking_changes.length > 0 && (
              <Alert
                type="warning"
                message="⚠️ 不兼容变更"
                description={verInfo.breaking_changes.join('；')}
                showIcon
                style={{ marginTop: 16 }}
              />
            )}

            <Divider />
            <Space>
              <Button icon={<SearchOutlined />} onClick={loadVersion}>
                检测更新
              </Button>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                disabled={!verInfo?.has_update || upgrading || !verInfo?.git_available}
                loading={upgrading}
                title={!verInfo?.git_available ? '请先安装 Git' : ''}
                onClick={handleUpgrade}
              >
                {upgrading ? '升级中...' : '📥 增量升级'}
              </Button>
              <Button icon={<RollbackOutlined />} onClick={handleRollback} disabled={!verInfo?.git_available}>
                回滚
              </Button>
            </Space>
          </Card>
        )}

        {/* 升级进度 */}
        {(upgradeProg && upgradeProg.running) && (
          <Card title="🔄 升级进度" style={{ marginBottom: 16 }}
            extra={
              <Button size="small" danger
                onClick={async () => {
                  try {
                    await cancelUpgrade()
                    message.warning('升级已取消')
                    setUpgrading(false)
                    setUpgradeProg(null)
                    if (pollRef.current) clearInterval(pollRef.current)
                    loadVersion()
                    loadHistory()
                  } catch (e: any) {
                    message.error('取消失败: ' + (e?.response?.data?.detail || e.message))
                  }
                }}
              >
                取消升级
              </Button>
            }
          >
            <Progress percent={Math.max(0, upgradeProg.progress)} />
            <p style={{ marginTop: 8 }}>{upgradeProg.message}</p>
            <p style={{ fontSize: 12, color: '#999' }}>如长时间无响应可点击右上角「取消升级」</p>
            {upgradeProg.error && (
              <Alert type="error" message={upgradeProg.error} showIcon style={{ marginTop: 8 }} />
            )}
          </Card>
        )}

        {/* 升级历史 */}
        <Card title="📜 升级历史">
          <Table
            dataSource={histList}
            columns={[
              { title: '时间', dataIndex: 'timestamp', key: 'ts', width: 170 },
              {
                title: '版本变化', key: 'ver',
                render: (_: any, r: any) => `${r.from_version || '-'} → ${r.to_version || '-'}`,
              },
              { title: '执行人', dataIndex: 'admin', key: 'admin', width: 100 },
              {
                title: '状态', dataIndex: 'status', key: 'status', width: 120,
                render: (s: string) => {
                  const map: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
                    success: { color: 'green', icon: <CheckCircleOutlined />, label: '成功' },
                    failed: { color: 'red', icon: <CloseCircleOutlined />, label: '失败' },
                    rolled_back: { color: 'orange', icon: <RollbackOutlined />, label: '已回滚' },
                  }
                  const item = map[s] || { color: 'default', icon: null, label: s }
                  return <Tag color={item.color} icon={item.icon}>{item.label}</Tag>
                },
              },
              { title: '错误', dataIndex: 'error', key: 'error', ellipsis: true },
              {
                title: '操作', key: 'action', width: 90,
                render: (_: any, r: any) => (
                  <Space size={0}>
                    <Button type="link" size="small"
                      icon={<EyeOutlined />}
                      onClick={() => {
                        const fileList = r.changed_files
                        Modal.info({
                          title: `📋 升级详情 — ${r.from_version || ''} → ${r.to_version || ''}`,
                          width: 560,
                          content: (
                            <div style={{ marginTop: 8 }}>
                              <p style={{ color: '#888', marginBottom: 8 }}>
                                执行人：{r.admin} ｜ 时间：{r.timestamp}
                              </p>
                              {r.commits !== undefined && (
                                <p style={{ color: '#888', marginBottom: 12 }}>
                                  提交数：{r.commits}
                                </p>
                              )}
                              {fileList && fileList.length > 0 ? (
                                <div>
                                  <div style={{ fontWeight: 600, marginBottom: 8 }}>
                                    📄 变更文件（{fileList.length} 个）
                                  </div>
                                  <div style={{
                                    maxHeight: 300, overflow: 'auto',
                                    background: '#f6f8fa', borderRadius: 6, padding: '8px 12px',
                                    fontSize: 13, fontFamily: 'monospace',
                                  }}>
                                    {fileList.map((f: string, i: number) => (
                                      <div key={i} style={{ lineHeight: '24px' }}>{f}</div>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <p style={{ color: '#999', marginTop: 12 }}>本次升级无详细更新日志</p>
                              )}
                            </div>
                          ),
                          okText: '关闭',
                        })
                      }}
                    />
                    <Button type="link" size="small" danger
                      icon={<DeleteOutlined />}
                      onClick={() => handleDeleteHistory(r.task_id)}
                    />
                  </Space>
                ),
              },
            ]}
            pagination={{
              current: histPage,
              pageSize: histPageSize,
              total: histTotal,
              showSizeChanger: true,
              pageSizeOptions: ['5', '10', '20', '50'],
              onChange: (p, ps) => {
                setHistPage(p)
                setHistPageSize(ps)
                loadHistory(p, ps)
              },
              showTotal: (t) => `共 ${t} 条`,
            }}
            size="small"
            rowKey="task_id"
            locale={{ emptyText: '暂无升级记录' }}
          />
        </Card>
      </Spin>
    )
  }

  return (
    <div>
      <Card>
        <Space style={{ marginBottom: 16 }}>
          <SettingOutlined style={{ fontSize: 24, color: '#1677ff' }} />
          <Title level={4} style={{ margin: 0 }}>系统配置</Title>
        </Space>

        {apikeyStatus && !apikeyStatus.configured && (
          <Alert
            message="API Key 未配置"
            description={
              <span>
                {apikeyStatus.hint}。配置后 AI 对话功能方可正常使用。
                {user?.role === 'admin' && ' 也可在服务器设置环境变量 DASHSCOPE_API_KEY 以全局生效。'}
              </span>
            }
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={() => setActiveTab('global')}>
                去配置
              </Button>
            }
          />
        )}

        <Tabs activeKey={activeTab} onChange={setActiveTab}>
          {/* ── 全局配置 Tab ── */}
          {/* ── 缓存管理 Tab ── */}
          <Tabs.TabPane
            tab={<span><ReloadOutlined /> 缓存管理</span>}
            key="cache"
          >
            <Card title="清理临时文件">
              <Text style={{ display: 'block', marginBottom: 16 }}>
                临时文件是用户上传的图片和文档在服务器上生成的缓存，
                包括 AI 对话中上传的文件。清理后不会影响系统运行，
                但正在进行的对话中引用的文件可能需要重新上传。
              </Text>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Alert
                  message="此操作将删除所有用户上传的临时文件，不可恢复！"
                  type="warning"
                  showIcon
                />
                <Button
                  danger
                  type="primary"
                  icon={<ReloadOutlined />}
                  onClick={() => {
                    Modal.confirm({
                      title: '确认清理所有临时缓存？',
                      icon: <ExclamationCircleOutlined />,
                      content: '所有用户上传的临时文件将被永久删除，此操作不可恢复！',
                      okText: '确认清理',
                      okType: 'danger',
                      cancelText: '取消',
                      onOk: async () => {
                        try {
                          await apiClient.delete('/api/files/cleanup-temp', { params: { all: true } })
                          message.success('所有临时缓存已清理')
                        } catch (e: unknown) {
                          const err = e as { response?: { data?: { detail?: string } }; message?: string }
                          message.error('清理失败: ' + (err?.response?.data?.detail || err?.message || '未知错误'))
                        }
                      },
                    })
                  }}
                >
                  清理所有缓存
                </Button>
              </Space>
            </Card>
          </Tabs.TabPane>

          <Tabs.TabPane
            tab={<span><SettingOutlined /> 全局配置</span>}
            key="global"
          >
            <Spin spinning={loading}>
              <Form
                form={form}
                layout="vertical"
                initialValues={config}
                style={{ maxWidth: 900 }}
              >
                {['brand', 'api', 'model', 'ai', 'subjects', 'limit', 'notify', 'filetype', 'imagegen', 'quest'].map(renderGroup)}

                <Divider />
                <Space>
                  <Button
                    type="primary"
                    icon={<SaveOutlined />}
                    loading={saving}
                    onClick={handleSave}
                  >
                    保存配置
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={loadConfig}>
                    重新加载
                  </Button>
                </Space>
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary">
                    ⚠️ 部分配置项（如 APPID、模型名称）需重启服务方可生效
                  </Text>
                </div>
              </Form>
            </Spin>
          </Tabs.TabPane>

          {/* ── 版本管理 Tab ── */}
          <Tabs.TabPane
            tab={<span><SyncOutlined /> 版本管理</span>}
            key="upgrade"
          >
            <UpgradePanel />
          </Tabs.TabPane>

        </Tabs>
      </Card>

    </div>
  )
}

export default SystemConfigPage
