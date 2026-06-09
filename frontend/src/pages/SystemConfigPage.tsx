import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Tabs, Form, Input, InputNumber, Button, message, Switch,
  Spin, Typography, Divider, Space, Alert, Tag, Checkbox,
} from 'antd'
import {
  SaveOutlined, SettingOutlined, ReloadOutlined, WarningOutlined, ExclamationCircleOutlined,
} from '@ant-design/icons'
import { Modal } from 'antd'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

// ── 全局配置表单 ──

const GLOBAL_CONFIG_FIELDS = [
  // 品牌信息
  { key: 'AGENT_EDITION', label: '平台版本', type: 'text', group: 'brand',
    desc: '显示在登录页面 "智慧教学平台-" 之后的版本名称，如 "高中信通版"、"高中数学版"等' },
  { key: 'ORG_NAME', label: '单位名称', type: 'text', group: 'brand', required: false,
    desc: '显示在登录页面和界面顶部的单位/学校名称，为空则不显示' },
  // API 密钥
  { key: 'dashscope_api_key', label: 'DashScope API Key', type: 'password', group: 'api',
    desc: '全局兜底密钥，用户未配置时使用。如已设置环境变量 DASHSCOPE_API_KEY 则优先使用，此处可不填' },
  // 模型与应用配置
  { key: 'APPID', label: 'APPID', type: 'text', group: 'model', required: false,
    desc: '【可选】留空则直接调用大模型（使用下方「默认对话模型」）；填写后调用百炼智能体应用。创建路径：百炼 → 应用中心 → 我的应用 → 创建智能体应用 → 复制 APPID' },
  { key: 'QWEN_OPENAI_API_BASE', label: 'API 基础地址', type: 'text', group: 'model',
    desc: 'DashScope API 调用地址，通常无需修改' },
  { key: 'MODEL_LONG_NAME', label: '长文本模型', type: 'text', group: 'model',
    desc: '用于长文档处理的模型名称，如 qwen-long' },
  { key: 'MODEL_VL_NAME', label: '视觉模型', type: 'text', group: 'model',
    desc: '用于图像理解的模型名称，如 qwen3-vl-flash' },
  { key: 'MODEL_NAME', label: '默认对话模型', type: 'text', group: 'model',
    desc: '未配置 APPID 时使用的对话模型，如 deepseek-v4-flash、qwen-plus 等' },
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
    desc: '系统中使用的课程名称，多个用逗号分隔，如 信息科技,通用技术。修改后需重启服务生效' },
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
      // 将 Tags 输入框的逗号分隔字符串转回数组
      for (const key of ['IMAGE_EXTENSIONS', 'DOCUMENT_EXTENSIONS', 'SUBJECTS']) {
        if (typeof allValues[key] === 'string') {
          allValues[key] = allValues[key].split(',').map((s: string) => s.trim()).filter(Boolean)
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
              ) : (
                <Form.Item
                  name={field.key}
                  label={field.label}
                  rules={field.required !== false ? [{ required: true, message: `请输入${field.label}` }] : undefined}
                  extra={field.key === 'AGENT_EDITION' ? '填写版本名称即可，系统会自动拼接为完整名称（如 "智慧教学平台-高中信通版"）' : field.desc}
                >
                  {field.key === 'AGENT_EDITION' ? (
                    <Input placeholder="例如：高中信通版" />
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
                {['brand', 'api', 'model', 'ai', 'subjects', 'limit', 'notify', 'filetype', 'imagegen'].map(renderGroup)}

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

        </Tabs>
      </Card>

    </div>
  )
}

export default SystemConfigPage
