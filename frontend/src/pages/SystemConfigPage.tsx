import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  Card, Tabs, Form, Input, InputNumber, Button, message, Switch,
  Spin, Typography, Divider, Space, Alert, Tag, Checkbox, Select, Tooltip,
} from 'antd'
import {
  SaveOutlined, SettingOutlined, ReloadOutlined, WarningOutlined, ExclamationCircleOutlined,
  SyncOutlined, DownloadOutlined, RollbackOutlined, SearchOutlined, DeleteOutlined, EyeOutlined,
  CheckCircleOutlined, CloseCircleOutlined, EditOutlined, DownOutlined,
} from '@ant-design/icons'
import { Modal, Timeline, Progress, Descriptions, Table } from 'antd'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'
import {
  fetchSkills, fetchSkillDetail, updateEnabledSkills, reloadSkills, updateSkillContent,
  type SkillInfo, type SkillDetail,
} from '../api/skills'
import {
  checkVersion, startUpgrade, getUpgradeStatus,
  rollback as apiRollback, getHistory, deleteHistory,
  cancelUpgrade, createBackup, ackMigrations,
  type VersionInfo, type UpgradeProgress,
} from '../api/upgrade'

const { Title, Text } = Typography

// ── 全局配置表单 ──
//
// 三级结构：分区(zone) → 小节(section) → 字段。渲染顺序就是 GLOBAL_CONFIG_FIELDS 的声明顺序，
// 新增一项只要挑一个小节加一行，左侧锚点导航、搜索、脏值统计都会自动跟上。
//
// 关于「生效方式」：所有配置都是运行时经 backend get_config_value() 读取（走 mtime 缓存），
// 保存即生效、**不需要重启服务**。只有两类需要额外说明，用 scope 标注：
//   nextRound = 下一轮后台任务生效（后台节拍到了才重读）；nextLogin = 只对新的登录会话生效。

type EffScope = 'nextRound' | 'nextLogin'

interface ConfigField {
  key: string
  labelKey: string
  descKey?: string
  type: 'text' | 'password' | 'number' | 'boolean' | 'tags' | 'roles' | 'notifications' | 'question_types' | 'multimodal_toggle'
  group: string
  required?: boolean
  placeholderKey?: string
  /** 数字单位（i18n key）：配合后端 /api/config/meta 下发的范围显示成「可填 5~3600 秒」 */
  unitKey?: string
  /** 生效方式，未标注即保存后立即生效 */
  scope?: EffScope
  /** 改动会影响安全面或难以挽回，保存前统一二次确认 */
  danger?: boolean
}

interface ConfigZone {
  id: string
  titleKey: string
  descKey: string
  sections: string[]
}

const CONFIG_ZONES: ConfigZone[] = [
  { id: 'basic', titleKey: 'zone_basic', descKey: 'zone_basic_desc', sections: ['brand', 'curriculum', 'notify', 'incentive'] },
  { id: 'ai', titleKey: 'zone_ai', descKey: 'zone_ai_desc', sections: ['credentials', 'models', 'chat', 'memory', 'grading', 'imagegen'] },
  { id: 'files', titleKey: 'zone_files', descKey: 'zone_files_desc', sections: ['upload', 'quota'] },
  { id: 'security', titleKey: 'zone_security', descKey: 'zone_security_desc', sections: ['session', 'guard', 'ratelimit'] },
  { id: 'ops', titleKey: 'zone_ops', descKey: 'zone_ops_desc', sections: ['upgrade'] },
]

const SECTION_TITLES: Record<string, string> = {
  brand: 'group_brand',
  curriculum: 'group_curriculum',
  notify: 'group_notify',
  incentive: 'group_incentive',
  credentials: 'group_credentials',
  models: 'group_models',
  chat: 'group_chat',
  memory: 'group_memory',
  grading: 'group_grading',
  imagegen: 'group_imagegen',
  upload: 'group_upload',
  quota: 'group_quota',
  session: 'group_session',
  guard: 'group_guard',
  ratelimit: 'group_ratelimit',
  upgrade: 'group_upgrade',
}

// 锚点导航与小节 DOM id 的前缀
const SECTION_DOM_ID = 'cfg-sec-'

// 生效方式 -> 徽标文案（未标注 scope 的项保存后立即生效，不加徽标）
const SCOPE_TAG_KEYS: Record<NonNullable<ConfigField['scope']>, string> = {
  nextRound: 'scopeNextRound',
  nextLogin: 'scopeNextLogin',
}

// 后端下发的校验元数据（GET /api/config/meta），前端不再自己复制一份取值范围
interface ConfigMeta {
  num_ranges: Record<string, [number, number]>
  bool_keys: string[]
  str_limits: Record<string, number>
  strlist_keys: Record<string, number>
}

// 有专属管理入口、不算「本表单漏收」的配置键
const MANAGED_ELSEWHERE_KEYS = ['enabled_skills', 'TITLE_CONFIG', 'SUBJECT_TITLE_CONFIG', 'BADGE_CONFIG']

const GLOBAL_CONFIG_FIELDS: ConfigField[] = [
  // ══ ① 基础与内容 ══
  // 品牌信息
  { key: 'AGENT_EDITION', labelKey: 'field_AGENT_EDITION', descKey: 'field_AGENT_EDITION_desc', type: 'text', group: 'brand' },
  { key: 'ORG_NAME', labelKey: 'field_ORG_NAME', descKey: 'field_ORG_NAME_desc', type: 'text', group: 'brand', required: false },
  // 课程与题型
  { key: 'SUBJECTS', labelKey: 'field_SUBJECTS', descKey: 'field_SUBJECTS_desc', type: 'tags', group: 'curriculum' },
  { key: 'QUESTION_TYPES', labelKey: 'field_QUESTION_TYPES', descKey: 'field_QUESTION_TYPES_desc', type: 'question_types', group: 'curriculum' },
  // 消息通知
  { key: 'enabled_notification_types', labelKey: 'field_enabled_notification_types', descKey: 'field_enabled_notification_types_desc', type: 'notifications', group: 'notify' },
  // 激励与闯关（后端 ENABLE_BADGES / ENABLE_SUBJECT_TITLES / QUEST_USE_BANK，此前页面看不到）
  { key: 'ENABLE_BADGES', labelKey: 'field_ENABLE_BADGES', descKey: 'field_ENABLE_BADGES_desc', type: 'boolean', group: 'incentive', required: false },
  { key: 'ENABLE_SUBJECT_TITLES', labelKey: 'field_ENABLE_SUBJECT_TITLES', descKey: 'field_ENABLE_SUBJECT_TITLES_desc', type: 'boolean', group: 'incentive', required: false },
  { key: 'QUEST_USE_BANK', labelKey: 'field_QUEST_USE_BANK', descKey: 'field_QUEST_USE_BANK_desc', type: 'boolean', group: 'incentive' },

  // ══ ② AI 与模型 ══
  // 服务接入
  { key: 'dashscope_api_key', labelKey: 'field_dashscope_api_key', descKey: 'field_dashscope_api_key_desc', type: 'password', group: 'credentials' },
  { key: 'AI_REQUEST_TIMEOUT', labelKey: 'field_AI_REQUEST_TIMEOUT', descKey: 'field_AI_REQUEST_TIMEOUT_desc', type: 'number', group: 'credentials', unitKey: 'unitSecond' },
  // 模型与端点
  { key: 'APPID', labelKey: 'field_APPID', descKey: 'field_APPID_desc', type: 'text', group: 'models', required: false },
  { key: 'QWEN_OPENAI_API_BASE', labelKey: 'field_QWEN_OPENAI_API_BASE', descKey: 'field_QWEN_OPENAI_API_BASE_desc', type: 'text', group: 'models' },
  { key: 'MODEL_NAME', labelKey: 'field_MODEL_NAME', descKey: 'field_MODEL_NAME_desc', type: 'text', group: 'models' },
  { key: 'MODEL_LONG_NAME', labelKey: 'field_MODEL_LONG_NAME', descKey: 'field_MODEL_LONG_NAME_desc', type: 'text', group: 'models' },
  { key: 'MODEL_VL_NAME', labelKey: 'field_MODEL_VL_NAME', descKey: 'field_MODEL_VL_NAME_desc', type: 'text', group: 'models' },
  { key: 'ENABLE_MULTIMODAL', labelKey: 'field_ENABLE_MULTIMODAL', descKey: 'field_ENABLE_MULTIMODAL_desc', type: 'multimodal_toggle', group: 'models' },
  // 对话权限
  { key: 'ENABLE_AI_CHAT_FOR_ROLES', labelKey: 'field_ENABLE_AI_CHAT_FOR_ROLES', descKey: 'field_ENABLE_AI_CHAT_FOR_ROLES_desc', type: 'roles', group: 'chat' },
  // 直连模式多轮记忆（backend/chat_memory.py；APPID 留空时才生效）
  { key: 'CHAT_MEMORY_ENABLED', labelKey: 'field_CHAT_MEMORY_ENABLED', descKey: 'field_CHAT_MEMORY_ENABLED_desc', type: 'boolean', group: 'memory' },
  { key: 'CHAT_MEMORY_MAX_TURNS', labelKey: 'field_CHAT_MEMORY_MAX_TURNS', descKey: 'field_CHAT_MEMORY_MAX_TURNS_desc', type: 'number', group: 'memory', required: false, unitKey: 'unitTurn' },
  { key: 'CHAT_MEMORY_TTL_MINUTES', labelKey: 'field_CHAT_MEMORY_TTL_MINUTES', descKey: 'field_CHAT_MEMORY_TTL_MINUTES_desc', type: 'number', group: 'memory', required: false, unitKey: 'unitMinute' },
  { key: 'CHAT_MEMORY_MAX_CHARS', labelKey: 'field_CHAT_MEMORY_MAX_CHARS', descKey: 'field_CHAT_MEMORY_MAX_CHARS_desc', type: 'number', group: 'memory', required: false, unitKey: 'unitChar' },
  { key: 'CHAT_MEMORY_CONTENT_MAX_CHARS', labelKey: 'field_CHAT_MEMORY_CONTENT_MAX_CHARS', descKey: 'field_CHAT_MEMORY_CONTENT_MAX_CHARS_desc', type: 'number', group: 'memory', required: false, unitKey: 'unitChar' },
  { key: 'CHAT_MEMORY_MAX_ROWS', labelKey: 'field_CHAT_MEMORY_MAX_ROWS', descKey: 'field_CHAT_MEMORY_MAX_ROWS_desc', type: 'number', group: 'memory', required: false, unitKey: 'unitRow' },
  { key: 'CHAT_MEMORY_PRUNE_INTERVAL_MINUTES', labelKey: 'field_CHAT_MEMORY_PRUNE_INTERVAL_MINUTES', descKey: 'field_CHAT_MEMORY_PRUNE_INTERVAL_MINUTES_desc', type: 'number', group: 'memory', required: false, unitKey: 'unitMinute', scope: 'nextRound' },
  // 主观题后台批量批改（backend/ai_grading.py；练习/考试/测验共用一套参数）
  { key: 'AI_GRADING_INTERVAL_SEC', labelKey: 'field_AI_GRADING_INTERVAL_SEC', descKey: 'field_AI_GRADING_INTERVAL_SEC_desc', type: 'number', group: 'grading', required: false, unitKey: 'unitSecond', scope: 'nextRound' },
  { key: 'AI_GRADING_BATCH_SIZE', labelKey: 'field_AI_GRADING_BATCH_SIZE', descKey: 'field_AI_GRADING_BATCH_SIZE_desc', type: 'number', group: 'grading', required: false, unitKey: 'unitAnswer', scope: 'nextRound' },
  { key: 'AI_GRADING_CONCURRENCY', labelKey: 'field_AI_GRADING_CONCURRENCY', descKey: 'field_AI_GRADING_CONCURRENCY_desc', type: 'number', group: 'grading', required: false, unitKey: 'unitThread', scope: 'nextRound' },
  { key: 'AI_GRADING_MAX_ITEMS_PER_ROUND', labelKey: 'field_AI_GRADING_MAX_ITEMS_PER_ROUND', descKey: 'field_AI_GRADING_MAX_ITEMS_PER_ROUND_desc', type: 'number', group: 'grading', required: false, unitKey: 'unitItem', scope: 'nextRound' },
  // 图片生成
  { key: 'IMAGE_GEN_ENABLED', labelKey: 'field_IMAGE_GEN_ENABLED', descKey: 'field_IMAGE_GEN_ENABLED_desc', type: 'boolean', group: 'imagegen' },
  { key: 'IMAGE_GEN_MODEL', labelKey: 'field_IMAGE_GEN_MODEL', descKey: 'field_IMAGE_GEN_MODEL_desc', type: 'text', group: 'imagegen' },
  { key: 'IMAGE_GEN_SIZE', labelKey: 'field_IMAGE_GEN_SIZE', descKey: 'field_IMAGE_GEN_SIZE_desc', type: 'text', group: 'imagegen' },

  // ══ ③ 文件与存储 ══
  // 上传限制与类型白名单
  { key: 'MAX_DOC_SIZE_MB', labelKey: 'field_MAX_DOC_SIZE_MB', descKey: 'field_MAX_DOC_SIZE_MB_desc', type: 'number', group: 'upload', unitKey: 'unitMB' },
  { key: 'MAX_IMAGE_SIZE_MB', labelKey: 'field_MAX_IMAGE_SIZE_MB', descKey: 'field_MAX_IMAGE_SIZE_MB_desc', type: 'number', group: 'upload', unitKey: 'unitMB' },
  { key: 'IMAGE_EXTENSIONS', labelKey: 'field_IMAGE_EXTENSIONS', descKey: 'field_IMAGE_EXTENSIONS_desc', type: 'tags', group: 'upload' },
  { key: 'DOCUMENT_EXTENSIONS', labelKey: 'field_DOCUMENT_EXTENSIONS', descKey: 'field_DOCUMENT_EXTENSIONS_desc', type: 'tags', group: 'upload' },
  // 下载配额
  { key: 'TEACHER_DOWNLOAD_QUOTA_GB', labelKey: 'field_TEACHER_DOWNLOAD_QUOTA_GB', descKey: 'field_TEACHER_DOWNLOAD_QUOTA_GB_desc', type: 'number', group: 'quota', unitKey: 'unitGB' },

  // ══ ④ 账号与安全 ══
  // 登录与会话
  { key: 'JWT_EXPIRATION_HOURS', labelKey: 'field_JWT_EXPIRATION_HOURS', descKey: 'field_JWT_EXPIRATION_HOURS_desc', type: 'number', group: 'session', unitKey: 'unitHour', scope: 'nextLogin' },
  { key: 'JWT_RENEW_THRESHOLD_MINUTES', labelKey: 'field_JWT_RENEW_THRESHOLD_MINUTES', descKey: 'field_JWT_RENEW_THRESHOLD_MINUTES_desc', type: 'number', group: 'session', unitKey: 'unitMinute' },
  { key: 'ONLINE_USER_TIMEOUT_SECONDS', labelKey: 'field_ONLINE_USER_TIMEOUT_SECONDS', descKey: 'field_ONLINE_USER_TIMEOUT_SECONDS_desc', type: 'number', group: 'session', unitKey: 'unitSecond' },
  // 爆破与 IP 防护（backend/security_guard.py，计数为内存态，重启即清）
  { key: 'ENABLE_IP_GUARD', labelKey: 'field_ENABLE_IP_GUARD', descKey: 'field_ENABLE_IP_GUARD_desc', type: 'boolean', group: 'guard', required: false, danger: true },
  { key: 'TRUST_PROXY_HEADERS', labelKey: 'field_TRUST_PROXY_HEADERS', descKey: 'field_TRUST_PROXY_HEADERS_desc', type: 'boolean', group: 'guard' },
  { key: 'LOGIN_FAIL_LIMIT', labelKey: 'field_LOGIN_FAIL_LIMIT', descKey: 'field_LOGIN_FAIL_LIMIT_desc', type: 'number', group: 'guard', unitKey: 'unitTime' },
  { key: 'LOGIN_FAIL_WINDOW_SECONDS', labelKey: 'field_LOGIN_FAIL_WINDOW_SECONDS', descKey: 'field_LOGIN_FAIL_WINDOW_SECONDS_desc', type: 'number', group: 'guard', unitKey: 'unitSecond' },
  { key: 'AUTH_FAIL_LIMIT', labelKey: 'field_AUTH_FAIL_LIMIT', descKey: 'field_AUTH_FAIL_LIMIT_desc', type: 'number', group: 'guard', unitKey: 'unitTime' },
  { key: 'AUTH_FAIL_WINDOW_SECONDS', labelKey: 'field_AUTH_FAIL_WINDOW_SECONDS', descKey: 'field_AUTH_FAIL_WINDOW_SECONDS_desc', type: 'number', group: 'guard', unitKey: 'unitSecond' },
  { key: 'AUTH_FAIL_BAN_SECONDS', labelKey: 'field_AUTH_FAIL_BAN_SECONDS', descKey: 'field_AUTH_FAIL_BAN_SECONDS_desc', type: 'number', group: 'guard', unitKey: 'unitSecond' },
  { key: 'IP_DENYLIST', labelKey: 'field_IP_DENYLIST', descKey: 'field_IP_DENYLIST_desc', type: 'tags', group: 'guard', required: false, placeholderKey: 'placeholder_ipDenylist', danger: true },
  // 流量限制
  { key: 'ENABLE_REQUEST_LIMIT', labelKey: 'field_ENABLE_REQUEST_LIMIT', descKey: 'field_ENABLE_REQUEST_LIMIT_desc', type: 'boolean', group: 'ratelimit' },
  { key: 'MAX_ALLOWED_REQUESTS', labelKey: 'field_MAX_ALLOWED_REQUESTS', descKey: 'field_MAX_ALLOWED_REQUESTS_desc', type: 'number', group: 'ratelimit', unitKey: 'unitTime' },

  // ══ ⑤ 运维与升级 ══
  { key: 'auto_pull_enabled', labelKey: 'field_auto_pull_enabled', descKey: 'field_auto_pull_enabled_desc', type: 'boolean', group: 'upgrade', danger: true },
]

// tags 类字段的键：保存时统一把逗号分隔字符串转回数组（留空 -> []，允许清空）
const TAG_FIELD_KEYS = GLOBAL_CONFIG_FIELDS.filter((f) => f.type === 'tags').map((f) => f.key)

// 后端配置 -> 表单值：tags 转逗号串、题型转多行 key:label，并补齐两个"配置文件里可能没写"的默认值
// （否则老部署一保存就把它们顺手改掉了）。对已经是表单值的对象再调一次是幂等的。
const toFormValues = (raw: Record<string, unknown>): Record<string, unknown> => {
  const v = { ...raw }
  for (const key of TAG_FIELD_KEYS) {
    if (Array.isArray(v[key])) v[key] = (v[key] as string[]).join(',')
  }
  if (Array.isArray(v['QUESTION_TYPES'])) {
    v['QUESTION_TYPES'] = (v['QUESTION_TYPES'] as { key: string; label: string }[])
      .map((item) => `${item.key}:${item.label}`)
      .join('\n')
  }
  if (!v['enabled_notification_types']) v['enabled_notification_types'] = ['exam', 'system']
  if (typeof v['auto_pull_enabled'] !== 'boolean') v['auto_pull_enabled'] = true
  return v
}

// 表单值 -> 后端提交值：tags 逗号串转数组、题型多行文本转 [{key,label}]
const toApiValues = (raw: Record<string, unknown>): Record<string, unknown> => {
  const v = { ...raw }
  for (const key of TAG_FIELD_KEYS) {
    if (typeof v[key] === 'string') {
      // 分隔符与后端 _STRLIST_KEYS 的容错保持一致（中/英逗号、顿号、分号）；
      // 不按空格拆，避免把「AI 基础」这类含空格的科目名切断
      v[key] = (v[key] as string).split(/[,，、;；]+/).map((item) => item.trim()).filter(Boolean)
    }
  }
  if (typeof v['QUESTION_TYPES'] === 'string') {
    v['QUESTION_TYPES'] = (v['QUESTION_TYPES'] as string)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [k, ...rest] = line.split(':')
        return { key: k.trim(), label: rest.join(':').trim() || k.trim() }
      })
  }
  return v
}

// 脏值对比用的归一化：数组按逗号串、布尔转 0/1、空值统一成空串
const normVal = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return ''
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (Array.isArray(v)) return v.join(',')
  return String(v)
}

// ═══════════════════════════════════════════════
//  技能管理 Tab 组件（必须定义在组件外部，避免渲染时重复创建）
// ═══════════════════════════════════════════════

const TYPE_COLORS: Record<string, string> = {
  core: 'blue',
  domain: 'green',
  adapter: 'purple',
}

const SkillManagePanel: React.FC = () => {
  const { t } = useTranslation('system')

  // 通过 i18n 翻译技能标签，键名格式: tag_xxx
  // 未找到时返回原始 tag（不会显示 "tag_xxx"）
  const tTag = (tag: string): string => {
    const key = `tag_${tag}`
    const translated = t(key)
    return translated !== key ? translated : tag
  }

  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null)
  const [detailVisible, setDetailVisible] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [savingContent, setSavingContent] = useState(false)

  const loadSkills = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      const data = await fetchSkills()
      setSkills(data.skills)
      if (data.errors && data.errors.length > 0) {
        setErrorMsg(data.errors.join('; '))
      }
    } catch (e: any) {
      message.error(t('loadFailed') + ': ' + (e?.response?.data?.detail || e.message))
    }
    setLoading(false)
  }, [t])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  // 切换单个技能启用状态
  const toggleSkill = async (name: string, currentEnabled: boolean) => {
    setSaving(true)
    try {
      const newList = currentEnabled
        ? skills.filter(s => s.name !== name).map(s => s.name)
        : [...skills.filter(s => s.enabled).map(s => s.name), name]
      await updateEnabledSkills(newList)
      message.success(t('skillToggled'))
      loadSkills()
    } catch (e: any) {
      message.error(t('saveFailed') + ': ' + (e?.response?.data?.detail || e.message))
    }
    setSaving(false)
  }

  // 查看技能详情
  const showDetail = async (name: string) => {
    try {
      const detail = await fetchSkillDetail(name)
      setSelectedSkill(detail)
      setDetailVisible(true)
    } catch (e: any) {
      message.error(t('loadFailed') + ': ' + (e?.response?.data?.detail || e.message))
    }
  }

  // 重新加载
  const handleReload = async () => {
    setLoading(true)
    try {
      const result = await reloadSkills()
      message.success(result.message)
      loadSkills()
    } catch (e: any) {
      message.error(t('reloadFailed') + ': ' + (e?.response?.data?.detail || e.message))
    }
  }

  // 全选/取消全选
  const allEnabled = skills.length > 0 && skills.every(s => s.enabled)
  const handleToggleAll = async () => {
    setSaving(true)
    try {
      const newList = allEnabled ? [] : filtered.map(s => s.name)
      await updateEnabledSkills(newList)
      message.success(allEnabled ? t('skillAllDisabled') : t('skillAllEnabled'))
      loadSkills()
    } catch (e: any) {
      message.error(t('saveFailed') + ': ' + (e?.response?.data?.detail || e.message))
    }
    setSaving(false)
  }

  // 分页重置（搜索/筛选时回到第一页）
  const handleSearchChange = (val: string) => {
    setSearchText(val)
    setPage(1)
  }
  const handleTypeChange = (val: string) => {
    setTypeFilter(val)
    setPage(1)
  }

  // 筛选
  const filtered = skills.filter(s => {
    if (typeFilter !== 'all' && s.type !== typeFilter) return false
    if (searchText) {
      const q = searchText.toLowerCase()
      return s.name.toLowerCase().includes(q) ||
        s.display_name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some(t => t.toLowerCase().includes(q))
    }
    return true
  })

  const typeCount = skills.reduce((acc, s) => {
    acc[s.type] = (acc[s.type] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  return (
    <div>
      {/* 工具栏 */}
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Input.Search
          placeholder={t('skillSearch')}
          value={searchText}
          onChange={e => handleSearchChange(e.target.value)}
          style={{ width: 260 }}
          allowClear
        />
        <Select
          value={typeFilter}
          onChange={handleTypeChange}
          style={{ width: 150 }}
          options={[
            { value: 'all', label: t('skillAllTypes') + ` (${skills.length})` },
            { value: 'core', label: `${t('skillCoreType')} (${typeCount.core || 0})` },
            { value: 'domain', label: `${t('skillDomainType')} (${typeCount.domain || 0})` },
            { value: 'adapter', label: `${t('skillAdapterType')} (${typeCount.adapter || 0})` },
          ]}
        />
        <Button icon={<ReloadOutlined />} onClick={handleReload} loading={loading}>
          {t('reload')}
        </Button>
        <Divider type="vertical" />
        <Space>
          <Text type="secondary">{t('skillToggleAll')}</Text>
          <Switch
            checked={allEnabled}
            onChange={handleToggleAll}
            loading={saving}
          />
        </Space>
        {errorMsg && (
          <Alert type="warning" showIcon message={errorMsg} style={{ margin: 0, flex: 1 }} />
        )}
      </div>

      {/* 技能列表 */}
      <Spin spinning={loading}>
        <Table
          dataSource={filtered.slice((page - 1) * pageSize, page * pageSize)}
          rowKey="name"
          pagination={{
            current: page,
            pageSize: pageSize,
            total: filtered.length,
            onChange: (p, ps) => { setPage(p); setPageSize(ps) },
            showSizeChanger: true,
            pageSizeOptions: ['10', '20', '50'],
            showTotal: (total) => t('skillTotal', { count: total }),
          }}
          size="small"
          columns={[
            {
              title: t('skillName'),
              dataIndex: 'display_name',
              key: 'name',
              width: 180,
              render: (_: string, record: SkillInfo) => (
                <Space>
                  <Tag color={TYPE_COLORS[record.type] || 'default'} style={{ fontSize: 11 }}>
                    {record.type}
                  </Tag>
                  <Text strong>{record.display_name}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>v{record.version}</Text>
                </Space>
              ),
            },
            {
              title: t('skillDescription'),
              dataIndex: 'description',
              key: 'desc',
              ellipsis: true,
            },
            {
              title: t('skillTags'),
              dataIndex: 'tags',
              key: 'tags',
              width: 180,
              render: (tags: string[]) => (
                <Space size={4} wrap>
                  {tags.slice(0, 3).map(t => <Tag key={t} style={{ fontSize: 11 }}>{tTag(t)}</Tag>)}
                </Space>
              ),
            },
            {
              title: t('skillStatus'),
              dataIndex: 'enabled',
              key: 'enabled',
              width: 100,
              render: (enabled: boolean) => (
                enabled
                  ? <Tag color="success" icon={<CheckCircleOutlined />}>{t('skillEnabled')}</Tag>
                  : <Tag color="default" icon={<CloseCircleOutlined />}>{t('skillDisabled')}</Tag>
              ),
            },
            {
              title: t('skillAction'),
              key: 'action',
              width: 160,
              render: (_: any, record: SkillInfo) => (
                <Space>
                  <Switch
                    checked={record.enabled}
                    onChange={() => toggleSkill(record.name, record.enabled)}
                    loading={saving}
                    size="small"
                  />
                  <Button type="link" size="small" onClick={() => showDetail(record.name)}>
                    <EditOutlined /> {t('skillViewEdit')}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Spin>

      {/* 技能详情弹窗 */}
      <Modal
        title={selectedSkill ? `${selectedSkill.display_name} v${selectedSkill.version}` : ''}
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={null}
        width={800}
      >
        {selectedSkill && (
          <div>
            <Descriptions column={2} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label={t('skillName')} span={2}>
                <Tag color={TYPE_COLORS[selectedSkill.type]}>{selectedSkill.type}</Tag>
                {selectedSkill.display_name}
              </Descriptions.Item>
              <Descriptions.Item label={t('version')}>{selectedSkill.version}</Descriptions.Item>
              <Descriptions.Item label={t('skillStatus')}>
                {selectedSkill.enabled
                  ? <Tag color="success">{t('skillEnabled')}</Tag>
                  : <Tag color="default">{t('skillDisabled')}</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label={t('skillDescription')} span={2}>
                {selectedSkill.description}
              </Descriptions.Item>
              <Descriptions.Item label={t('skillTags')} span={2}>
                {selectedSkill.tags.map(t => <Tag key={t}>{tTag(t)}</Tag>)}
              </Descriptions.Item>
              <Descriptions.Item label={t('compatibleWith')} span={2}>
                {selectedSkill.compatible_with.length > 0
                  ? selectedSkill.compatible_with.join(', ')
                  : t('all')}
              </Descriptions.Item>
              <Descriptions.Item label={t('priority')}>{selectedSkill.priority}</Descriptions.Item>
              <Descriptions.Item label={t('requires')}>
                {selectedSkill.requires.length > 0 ? selectedSkill.requires.join(', ') : '-'}
              </Descriptions.Item>
            </Descriptions>

            {/* 编辑/查看模式切换 */}
            <Space style={{ marginBottom: 12 }}>
              {editing ? (
                <>
                  <Button type="primary" icon={<SaveOutlined />} loading={savingContent}
                    onClick={async () => {
                      if (!selectedSkill) return
                      setSavingContent(true)
                      try {
                        const result = await updateSkillContent(selectedSkill.name, editContent)
                        if (result.parse_error) {
                          message.warning(t('skillSavedWithError') + ': ' + result.parse_error)
                        } else {
                          message.success(result.message)
                        }
                        setEditing(false)
                        showDetail(selectedSkill.name)
                      } catch (e: any) {
                        message.error(t('saveFailed') + ': ' + (e?.response?.data?.detail || e.message))
                      }
                      setSavingContent(false)
                    }}
                  >
                    {t('save')}
                  </Button>
                  <Button onClick={() => { setEditing(false); setEditContent('') }}>
                    {t('cancel')}
                  </Button>
                </>
              ) : (
                <Button icon={<EditOutlined />} onClick={() => {
                  setEditContent(selectedSkill?.raw_content || '')
                  setEditing(true)
                }}>
                  {t('edit')}
                </Button>
              )}
            </Space>

            {/* 原始文档内容 */}
            {selectedSkill.parse_error && (
              <Alert type="warning" showIcon message={t('skillParseError')} description={selectedSkill.parse_error} style={{ marginBottom: 16 }} />
            )}
            {selectedSkill.raw_content && (
              editing ? (
                <Input.TextArea
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  rows={20}
                  style={{ fontFamily: 'monospace', fontSize: 13 }}
                />
              ) : (
                <>
                  <Text strong>{t('skillRawContent')}</Text>
                  <pre style={{
                    marginTop: 8,
                    padding: 12,
                    background: '#f5f5f5',
                    borderRadius: 6,
                    fontSize: 13,
                    maxHeight: 400,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    border: '1px solid #e8e8e8',
                  }}>
                    {selectedSkill.raw_content}
                  </pre>
                </>
              )
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

// ═══════════════════════════════════════════════
//  升级管理 Tab 组件（必须定义在组件外部，避免渲染时重复创建）
// ═══════════════════════════════════════════════

const UpgradePanel: React.FC = () => {
  const { t } = useTranslation('system')
  const [verInfo, setVerInfo] = useState<VersionInfo | null>(null)
  const [verLoading, setVerLoading] = useState(true) // 初始为 true，首次挂载即加载
  const [upgrading, setUpgrading] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  const [upgradeProg, setUpgradeProg] = useState<UpgradeProgress | null>(null)
  const [histList, setHistList] = useState<any[]>([])
  const [histTotal, setHistTotal] = useState(0)
  const [histPage, setHistPage] = useState(1)
  const [histPageSize, setHistPageSize] = useState(10)
  const pollRef = useRef<number | undefined>(undefined)
  const [restarting, setRestarting] = useState(false)  // 服务重启中标记
  const [acking, setAcking] = useState('')             // 正在确认迁移的记录 task_id

  const loadVersion = useCallback(async () => {
    setVerLoading(true)
    try {
      const info = await checkVersion()
      setVerInfo(info)
    } catch (e: any) {
      message.error(t('versionCheckFailed') + ': ' + (e?.response?.data?.detail || e.message))
    }
    setVerLoading(false)
  }, [t])

  const loadHistory = useCallback(async (page = 1, pageSize = 10) => {
    try {
      const res = await getHistory(page, pageSize)
      setHistList(res.history || [])
      setHistTotal(res.total)
      setHistPage(res.page)
    } catch { /* ignore */ }
  }, [])

  const handleUpgrade = () => {
    const isPrefetched = verInfo?.prefetched
    Modal.confirm({
      title: t('confirmUpgrade'),
      icon: <WarningOutlined />,
      content: (
        <div>
          {isPrefetched && (
            <Alert type="success" showIcon icon={<DownloadOutlined />}
              message={t('upgradeCodeCached')}
              description={t('upgradeCodeCachedDesc')}
              style={{ marginBottom: 12 }}
            />
          )}
          <p>{t('upgradeStepsTitle')}</p>
          <ol>
            <li>{isPrefetched ? t('upgradeStep1Cached') : t('upgradeStep1Download')}</li>
            <li>{t('upgradeStep2')}</li>
            <li>{t('upgradeStep3')}</li>
            <li>{t('upgradeStep4')}</li>
          </ol>
          <p>{t('upgradeAutoRecover')}</p>
        </div>
      ),
      okText: t('confirmUpgradeOk'),
      cancelText: t('cancel'),
      onOk: async () => {
        try {
          await startUpgrade()
          setUpgrading(true)
          setRestarting(false)
          pollRef.current = setInterval(async () => {
            try {
              const st = await getUpgradeStatus()
              // 服务恢复后重置重启标记（使用函数式更新避免闭包陷阱）
              setRestarting(false)
              setUpgradeProg(st)
              if (!st.running) {
                clearInterval(pollRef.current)
                setUpgrading(false)
                if (st.error) {
                  message.error(t('upgradeFailed') + ': ' + st.error)
                } else {
                  message.success(t('upgradeSuccess'))
                }
                loadHistory()
              }
            } catch {
              // 服务重启中，HTTP 请求会暂时失败
              // 首次进入断连状态时提示用户
              setRestarting(true)
            }
          }, 2000)
        } catch (e: any) {
          message.error(t('upgradeStartFailed') + ': ' + (e?.response?.data?.detail || e.message))
        }
      },
    })
  }

  const handleRollback = () => {
    Modal.confirm({
      title: t('confirmRollback'),
      icon: <ExclamationCircleOutlined />,
      content: (
        <div>
          <div style={{ background: '#fff2f0', border: '1px solid #ffccc7', borderRadius: 6, padding: '12px 16px', marginBottom: 12 }}>
            <Text strong style={{ color: '#cf1322' }}>{t('rollbackStepsTitle')}</Text>
            <ol style={{ margin: '8px 0 0 0', paddingLeft: 20, color: '#555' }}>
              <li>{t('rollbackStep1')}</li>
              <li>{t('rollbackStep2')}</li>
            </ol>
          </div>
          <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 6, padding: '12px 16px' }}>
            <Text strong style={{ color: '#d48806' }}>{t('rollbackNoteTitle')}</Text>
            <ul style={{ margin: '8px 0 0 0', paddingLeft: 20, color: '#555' }}>
              <li><Trans i18nKey="rollbackNote1">回滚仅恢复代码文件，<strong>数据库和用户数据不受影响</strong></Trans></li>
              <li>{t('rollbackNote2')}</li>
              <li>{t('rollbackNote3')}</li>
            </ul>
          </div>
        </div>
      ),
      okText: t('confirmRollbackOk'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        try {
          await apiRollback()
          message.success(t('rollbackSuccess'))
          loadHistory()
          loadVersion()
        } catch (e: any) {
          message.error(t('rollbackFailed') + ': ' + (e?.response?.data?.detail || e.message))
        }
      },
    })
  }

  const handleBackup = () => {
    Modal.confirm({
      title: t('confirmBackup'),
      icon: <ExclamationCircleOutlined />,
      content: t('backupContent'),
      okText: t('backupOk'),
      cancelText: t('cancel'),
      onOk: async () => {
        setBackingUp(true)
        try {
          const res = await createBackup()
          message.success(t('backupSuccess', { version: res.version }))
          loadHistory()
        } catch (e: any) {
          message.error(t('backupFailed') + ': ' + (e?.response?.data?.detail || e.message))
        }
        setBackingUp(false)
      },
    })
  }

  useEffect(() => {
    const init = async () => {
      try {
        const info = await checkVersion()
        setVerInfo(info)
      } catch (e: any) {
        message.error(t('versionCheckFailed') + ': ' + (e?.response?.data?.detail || e.message))
      }
      try {
        const res = await getHistory()
        setHistList(res.history || [])
        setHistTotal(res.total)
        setHistPage(res.page)
      } catch { /* ignore */ }
      setVerLoading(false)
    }
    init()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [t])

  const handleDeleteHistory = (task_id: string) => {
    Modal.confirm({
      title: t('confirmDeleteHistory'),
      icon: <ExclamationCircleOutlined />,
      content: t('confirmDeleteHistoryContent'),
      okText: t('confirmUpgradeOk'),
      okType: 'danger',
      cancelText: t('cancel'),
      onOk: async () => {
        try {
          await deleteHistory(task_id)
          message.success(t('upgradeDeleteSuccess'))
          loadHistory(histPage, histPageSize)
        } catch (e: any) {
          message.error(t('upgradeDeleteFailed') + ': ' + (e?.response?.data?.detail || e.message))
        }
      },
    })
  }

  const handleAckMigrations = async (task_id: string) => {
    setAcking(task_id)
    try {
      await ackMigrations(task_id)
      message.success(t('ackMigrationsSuccess'))
      loadHistory(histPage, histPageSize)
    } catch (e: any) {
      message.error(t('ackMigrationsFailed') + ': ' + (e?.response?.data?.detail || e.message))
    } finally {
      setAcking('')
    }
  }

  // 对账收口成成功、但数据库迁移没确认跑完的记录：确认之前一直挂在页面上
  const pendingMigrationChecks = histList.filter(
    (r: any) => r?.migrations_unverified && !r?.migrations_ack,
  )

  return (
    <Spin spinning={verLoading}>
      {/* Git 环境问题警告 */}
      {verInfo && (!verInfo.git_available || verInfo.git_issues.length > 0) && (
        <Alert
          type="error"
          showIcon
          message={t('gitEnvError')}
          description={
            <div>
              {!verInfo.git_available ? (
                <span>
                  {t('gitNotFound')}<br />
                  <a href={verInfo.git_download_url} target="_blank" rel="noopener noreferrer" style={{ fontWeight: 'bold' }}>
                    {t('downloadGit')}
                  </a>
                  &nbsp;{t('gitInstallNote')}
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
            <Descriptions.Item label={t('currentVersion')}>
              <Tag color="blue">{verInfo.current_version}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('latestVersionLabel')}>
              <Tag color={verInfo.has_update ? 'green' : 'default'}>{verInfo.latest_version}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('status')}>
              {verInfo.has_update
                ? <Tag color="green">📥 {verInfo.latest_version !== verInfo.current_version
                    ? t('newVersionAvailable', { version: verInfo.latest_version })
                    : t('newCommitsAvailable', { count: verInfo.behind_commits })} {t('behindCommits', { count: verInfo.behind_commits })}</Tag>
                : <Tag>{t('upToDate')}</Tag>}
              {verInfo.prefetched && (
                <Tag color="cyan" style={{ marginLeft: 8 }}>{t('codePrecached')}</Tag>
              )}
            </Descriptions.Item>
            {verInfo.release_date && (
              <Descriptions.Item label={t('releaseDate')}>{verInfo.release_date}</Descriptions.Item>
            )}
          </Descriptions>

          {/* 更新日志 */}
          {verInfo.changelog && verInfo.changelog.length > 0 && (
            <>
              <Divider />
              <Title level={5}>{t('changelogTitle')}</Title>
              <Timeline items={verInfo.changelog.map((c: string) => ({ content: c }))} />
            </>
          )}

          <Divider />
          <Space>
            <Button icon={<SearchOutlined />} onClick={loadVersion}>
              {t('checkUpdate')}
            </Button>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              disabled={!verInfo?.has_update || upgrading || !verInfo?.git_available}
              loading={upgrading}
              title={
                !verInfo?.git_available ? t('installGitFirst')
                : verInfo?.prefetched ? t('codePrecachedTitle')
                : ''
              }
              onClick={handleUpgrade}
            >
              {upgrading ? t('upgrading') : verInfo?.prefetched ? t('quickUpgrade') : t('incrementalUpgrade')}
            </Button>
            <Button icon={<RollbackOutlined />} onClick={handleRollback} disabled={!verInfo?.git_available}>
              {t('rollback')}
            </Button>
            <Button icon={<SaveOutlined />} onClick={handleBackup} loading={backingUp} disabled={!verInfo?.git_available}>
              {t('createBackup')}
            </Button>
          </Space>
        </Card>
      )}

      {/* 升级进度 */}
      {(upgradeProg && upgradeProg.running) && (
        <Card title={t('upgradeProgress')} style={{ marginBottom: 16 }}
          extra={
            <Button size="small" danger
              onClick={async () => {
                try {
                  await cancelUpgrade()
                  message.warning(t('cancelSuccess'))
                  setUpgrading(false)
                  setUpgradeProg(null)
                  setRestarting(false)
                  if (pollRef.current) clearInterval(pollRef.current)
                  loadVersion()
                  loadHistory()
                } catch (e: any) {
                  message.error(t('cancelFailed') + ': ' + (e?.response?.data?.detail || e.message))
                }
              }}
            >
              {t('cancelUpgradeBtn')}
            </Button>
          }
        >
          <Progress percent={Math.max(0, upgradeProg.progress)} />
          <p style={{ marginTop: 8 }}>{upgradeProg.message}</p>
          {restarting && (
            <Alert
              type="warning"
              showIcon
              icon={<SyncOutlined spin />}
              message={t('waitingServiceRecovery')}
              description={t('serviceUnavailable')}
              style={{ marginTop: 8, marginBottom: 8 }}
            />
          )}
          <p style={{ fontSize: 12, color: '#999' }}>
            {restarting ? t('waitingServiceHint') : t('noResponseHint')}
          </p>
          {upgradeProg.error && (
            <Alert type="error" message={upgradeProg.error} showIcon style={{ marginTop: 8 }} />
          )}
        </Card>
      )}

      {/* 升级被打断、按版本收口的记录：数据库迁移核实之前一直提醒 */}
      {pendingMigrationChecks.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message={t('migrationsUnverifiedTitle')}
          description={
            <div>
              <p style={{ marginBottom: 8 }}>{t('migrationsUnverifiedDesc')}</p>
              {pendingMigrationChecks.map((r: any) => (
                <div key={r.task_id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  gap: 12, marginBottom: 6,
                }}>
                  <span style={{ fontSize: 13 }}>
                    {r.timestamp} ｜ {r.from_version} → {r.to_version}
                    {r.stage_reached ? ` ｜ ${t('stageReached')}: ${r.stage_reached}` : ''}
                  </span>
                  <Button size="small" loading={acking === r.task_id}
                    onClick={() => handleAckMigrations(r.task_id)}
                  >
                    {t('ackMigrations')}
                  </Button>
                </div>
              ))}
            </div>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {/* 升级历史 */}
      <Card title={t('upgradeHistory')}>
        <Table
          dataSource={histList}
          columns={[
            { title: t('timestamp'), dataIndex: 'timestamp', key: 'ts', width: 170 },
            {
              title: t('versionChange'), key: 'ver',
              render: (_: any, r: any) => `${r.from_version || '-'} → ${r.to_version || '-'}`,
            },
            { title: t('executor'), dataIndex: 'admin', key: 'admin', width: 90 },
            { title: t('sourceIP'), dataIndex: 'client_ip', key: 'client_ip', width: 130,
              render: (ip: string) => ip ? <Tag>{ip}</Tag> : '-' },
            { title: t('status'), dataIndex: 'status', key: 'status', width: 120,
              render: (s: string, r: any) => {
                const map: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
                  success: { color: 'green', icon: <CheckCircleOutlined />, label: t('statusSuccess') },
                  failed: { color: 'red', icon: <CloseCircleOutlined />, label: t('statusFailed') },
                  rolled_back: { color: 'orange', icon: <RollbackOutlined />, label: t('statusRolledBack') },
                  // 自动同步同样会真的改变运行版本，历史里必须看得见；
                  // in_progress/interrupted 用于识别「升级被进程重启打断」这种半截现场
                  auto_synced: { color: 'blue', icon: <SyncOutlined />, label: t('statusAutoSynced') },
                  in_progress: { color: 'processing', icon: <SyncOutlined spin />, label: t('statusInProgress') },
                  interrupted: { color: 'volcano', icon: <WarningOutlined />, label: t('statusInterrupted') },
                }
                const item = map[s] || { color: 'default', icon: null, label: s }
                // 代码到位但数据库迁移未确认的记录，不能算干净的绿色成功
                const unverified = s === 'success' && r?.migrations_unverified && !r?.migrations_ack
                const tag = unverified
                  ? <Tag color="gold" icon={<ExclamationCircleOutlined />}>{t('statusSuccessUnverified')}</Tag>
                  : <Tag color={item.color} icon={item.icon}>{item.label}</Tag>
                // 被对账收口的记录要能解释"凭什么判成成功/中断"（note 由后端给出）
                return r?.note ? <Tooltip title={r.note}>{tag}</Tooltip> : tag
              },
            },
            {
              title: t('actions'), key: 'action', width: 90,
              render: (_: any, r: any) => (
                <Space size={0}>
                  <Button type="link" size="small"
                    icon={<EyeOutlined />}
                    onClick={() => {
                      const fileList = r.changed_files
                      const isError = r.status === 'failed' && r.error
                      Modal.info({
                        title: t('upgradeDetailTitle', { from: r.from_version || '', to: r.to_version || '' }),
                        width: 560,
                        content: (
                          <div style={{ marginTop: 8 }}>
                            <p style={{ color: '#888', marginBottom: 8 }}>
                              {t('executor')}：{r.admin} ｜ {t('sourceIP')}：{r.client_ip || t('unknown')} ｜ {t('timestamp')}：{r.timestamp}
                            </p>
                            {r.commits !== undefined && (
                              <p style={{ color: '#888', marginBottom: 12 }}>
                                {t('commitsCount', { count: r.commits })}
                              </p>
                            )}
                            {r.note && (
                              <div style={{
                                background: '#e6f4ff', border: '1px solid #91caff',
                                borderRadius: 6, padding: '10px 14px', marginBottom: 12,
                                fontSize: 13, color: '#0958d9', whiteSpace: 'pre-wrap',
                              }}>
                                {r.note}
                              </div>
                            )}
                            {r.reconciled_from && (!fileList || fileList.length === 0) && (
                              <p style={{ color: '#888', fontSize: 12, marginBottom: 12 }}>
                                {t('reconciledDetailMissing')}
                              </p>
                            )}
                            {isError && (
                              <div style={{
                                background: '#fff2f0', border: '1px solid #ffccc7',
                                borderRadius: 6, padding: '12px 16px', marginBottom: 12,
                              }}>
                                <Text strong style={{ color: '#cf1322' }}>{t('errorInfo')}</Text>
                                <pre style={{
                                  marginTop: 8, marginBottom: 0, whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word', fontSize: 13,
                                  fontFamily: 'monospace', color: '#555',
                                }}>{r.error}</pre>
                              </div>
                            )}
                            {fileList && fileList.length > 0 ? (
                              <div>
                                <div style={{ fontWeight: 600, marginBottom: 8 }}>
                                  {t('changedFiles', { count: fileList.length })}
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
                            ) : null}
                          </div>
                        ),
                        okText: t('close'),
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
            showTotal: (total) => t('totalRecords', { count: total }),
          }}
          size="small"
          rowKey="task_id"
          locale={{ emptyText: t('noUpgradeHistory') }}
        />
      </Card>
    </Spin>
  )
}

const SystemConfigPage: React.FC = () => {
  const { t } = useTranslation('system')
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const [activeTab, setActiveTab] = useState('global')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [apikeyStatus, setApikeyStatus] = useState<{ status: string; source: string; hint: string; configured: boolean } | null>(null)
  const [form] = Form.useForm()
  const [query, setQuery] = useState('')                // 顶部搜索关键词
  const [activeSec, setActiveSec] = useState('')        // 锚点导航当前高亮的小节
  const [dirty, setDirty] = useState<string[]>([])      // 与已加载值不同的配置键
  const loadedRef = useRef<Record<string, unknown>>({}) // 上次加载/保存后的表单快照（脏值对比 + 放弃修改）
  const [meta, setMeta] = useState<ConfigMeta | null>(null)        // 后端校验元数据（取值范围/长度上限）
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ memory: true }) // 收起的小节
  const [advOpen, setAdvOpen] = useState(false)                     // 「未收录配置键」兜底面板

  // ── 加载 API Key 状态 ──
  const loadApikeyStatus = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/api/config/apikey-status')
      setApikeyStatus(data)
    } catch {
      // 忽略，非关键信息
    }
  }, [])

  // ── 加载后端校验元数据（只为加范围提示，失败不影响配置读写） ──
  const loadMeta = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/api/config/meta')
      setMeta(data)
    } catch {
      // 忽略
    }
  }, [])

  // ── 把配置灌进表单并记下快照（快照用于脏值统计与「放弃修改」） ──
  const applyConfig = useCallback((raw: Record<string, unknown>) => {
    const formValues = toFormValues(raw)
    loadedRef.current = formValues
    setDirty([])
    form.setFieldsValue(formValues)
  }, [form])

  // ── 加载全局配置 ──
  const loadConfig = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/config')
      setConfig(data)
      applyConfig(data)
      loadApikeyStatus()
    } catch {
      message.error(t('loadConfigFailed'))
    } finally {
      setLoading(false)
    }
  }, [t, applyConfig, loadApikeyStatus])

  // ── 逐项比对快照，统计"几项未保存" ──
  const handleValuesChange = useCallback(() => {
    const cur = form.getFieldsValue() as Record<string, unknown>
    setDirty(
      GLOBAL_CONFIG_FIELDS
        .filter((f) => normVal(cur[f.key]) !== normVal(loadedRef.current[f.key]))
        .map((f) => f.key),
    )
  }, [form])

  // ── 放弃未保存的修改（回到上次加载/保存的值） ──
  const handleDiscard = () => {
    applyConfig(loadedRef.current)
    message.success(t('discardDone'))
  }

  // ── 锚点跳转 ──
  const scrollToSection = (sec: string) => {
    setCollapsed((prev) => (prev[sec] ? { ...prev, [sec]: false } : prev))
    setActiveSec(sec)
    // 等展开的这一帧渲染完再定位，否则测到的是收起后的高度
    window.setTimeout(() => {
      document.getElementById(SECTION_DOM_ID + sec)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  // ── 提交 ──
  const submitConfig = async (values: Record<string, unknown>) => {
    setSaving(true)
    try {
      await apiClient.put('/api/config', { config: values })
      message.success(t('configSavedMsg'))
      await loadConfig()
    } catch (err: unknown) {
      const e = err as { response?: { data?: { detail?: string } }; message?: string }
      message.error(t('saveFailed') + ': ' + (e?.response?.data?.detail || e?.message || t('unknownError')))
    } finally {
      setSaving(false)
    }
  }

  // ── 保存全局配置 ──
  const handleSave = async () => {
    let values: Record<string, unknown>
    try {
      await form.validateFields()
      // 用 getFieldsValue 而不是 validateFields 的返回值，确保未被改动的字段也一并提交
      values = toApiValues(form.getFieldsValue() as Record<string, unknown>)
    } catch {
      return // 表单校验未通过，错误已就地标红
    }
    // 涉及安全面/难以回退的项（关防护、改 IP 黑名单、开自动同步）改动后要求二次确认
    const risky = GLOBAL_CONFIG_FIELDS.filter((f) => f.danger && dirty.includes(f.key))
    if (risky.length) {
      Modal.confirm({
        title: t('dangerConfirmTitle'),
        icon: <ExclamationCircleOutlined />,
        content: (
          <div>
            <div style={{ marginBottom: 6 }}>{t('dangerConfirmHint')}</div>
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {risky.map((f) => (
                <li key={f.key}>{t(f.labelKey)}</li>
              ))}
            </ul>
          </div>
        ),
        okText: t('saveConfig'),
        okType: 'danger',
        cancelText: t('cancel'),
        onOk: () => submitConfig(values),
      })
      return
    }
    submitConfig(values)
  }

  useEffect(() => {
    if (user?.role !== 'admin') return
    loadConfig()
    loadMeta()
  }, [user?.role, loadConfig, loadMeta])

  // 滚动时高亮左侧导航当前小节（IntersectionObserver 不依赖外层滚动容器的实现细节）
  useEffect(() => {
    if (activeTab !== 'global' || loading) return
    const els = GLOBAL_CONFIG_FIELDS
      .map((f) => document.getElementById(SECTION_DOM_ID + f.group))
      .filter((el): el is HTMLDivElement => !!el)
    if (!els.length) return
    const tops = new Map<string, number>()
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) tops.set(en.target.id, en.boundingClientRect.top)
        else tops.delete(en.target.id)
      })
      let best = ''
      let bestTop = Number.POSITIVE_INFINITY
      tops.forEach((top, id) => {
        if (top < bestTop) { bestTop = top; best = id }
      })
      if (best) setActiveSec(best.slice(SECTION_DOM_ID.length))
    }, { rootMargin: '-100px 0px -55% 0px', threshold: 0 })
    els.forEach((el) => io.observe(el))
    return () => io.disconnect()
  }, [activeTab, loading, query])

  // 非管理员重定向到 AI 对话
  if (user?.role !== 'admin') {
    navigate('/chat', { replace: true })
    return null
  }

  // ── 搜索过滤：键名 / 名称 / 说明 任一命中即保留，小节与分区随之收缩 ──
  const q = query.trim().toLowerCase()
  const fieldHit = (f: ConfigField) =>
    !q ||
    f.key.toLowerCase().includes(q) ||
    t(f.labelKey).toLowerCase().includes(q) ||
    (f.descKey ? t(f.descKey).toLowerCase().includes(q) : false)
  const fieldsOf = (section: string) => GLOBAL_CONFIG_FIELDS.filter((f) => f.group === section && fieldHit(f))
  const visibleZones = CONFIG_ZONES
    .map((z) => ({ ...z, sections: z.sections.filter((sec) => fieldsOf(sec).length > 0) }))
    .filter((z) => z.sections.length > 0)
  const hitCount = visibleZones.reduce(
    (n, z) => n + z.sections.reduce((m, sec) => m + fieldsOf(sec).length, 0),
    0,
  )

  // 后端返回的配置键里，本表单没收录、也没有专属管理入口的那些（正常应为空）
  const knownKeys = new Set(GLOBAL_CONFIG_FIELDS.map((f) => f.key))
  const unknownKeys = Object.keys(config).filter((k) => !knownKeys.has(k) && !MANAGED_ELSEWHERE_KEYS.includes(k))

  // ── 全局配置表单各小节 ──
  const renderGroup = (group: string) => {
    const fields = fieldsOf(group)
    if (!fields.length) return null
    // 搜索时一律展开，保证命中的项不会被折叠藏住
    const isOpen = !!q || !collapsed[group]
    const secDirty = fields.filter((f) => dirty.includes(f.key)).length
    const getLabel = (field: ConfigField) => t(field.labelKey)
    // 数字项把后端 _NUM_RANGES 的范围直接标在说明里，避免"填了才被拒"
    const getDesc = (field: ConfigField) => {
      const base = field.descKey ? t(field.descKey) : undefined
      const range = field.type === 'number' ? meta?.num_ranges?.[field.key] : undefined
      if (!range) return base
      const hint = t('rangeHint', { lo: range[0], hi: range[1], unit: field.unitKey ? t(field.unitKey) : '' })
      return base ? base + hint : hint
    }
    // 非即时生效的项挂个徽标，免得以为改了没反应
    const getLabelNode = (field: ConfigField) => (field.scope ? (
      <Space size={4}>
        <span>{getLabel(field)}</span>
        <Tag color="orange" style={{ fontSize: 11, lineHeight: '18px', marginInlineEnd: 0 }}>
          {t(SCOPE_TAG_KEYS[field.scope])}
        </Tag>
      </Space>
    ) : getLabel(field))
    const getRule = (field: ConfigField) =>
      field.required !== false ? [{ required: true, message: t('pleaseInput', { label: getLabel(field) }) }] : undefined
    return (
      <div key={group} id={SECTION_DOM_ID + group} style={{ marginBottom: 32, scrollMarginTop: 8 }}>
        <Title
          level={5}
          style={{ marginTop: 0, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setCollapsed((prev) => ({ ...prev, [group]: isOpen }))}
        >
          <DownOutlined
            style={{ fontSize: 10, marginRight: 8, color: 'var(--text-tertiary)', transition: 'transform .2s', transform: isOpen ? 'none' : 'rotate(-90deg)' }}
          />
          {t(SECTION_TITLES[group])}
          {q ? (
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>({fields.length})</Text>
          ) : null}
          {!isOpen ? (
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 400, marginLeft: 6 }}>
              {t('sectionCollapsed', { n: fields.length })}
            </Text>
          ) : null}
          {secDirty ? (
            <Tag color="blue" style={{ fontSize: 11, lineHeight: '18px', marginLeft: 6 }}>
              {t('secUnsaved', { n: secDirty })}
            </Tag>
          ) : null}
        </Title>
        {/* 折叠只藏视觉、不卸载组件：Form.Item 一旦卸载，提交时这些项的值就丢了 */}
        <div style={{ display: isOpen ? 'grid' : 'none', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: 16, paddingTop: isOpen ? 12 : 0, borderTop: isOpen ? '1px solid var(--border-color)' : 'none' }}>
          {fields.map((field) => (
            <div key={field.key}>
              {field.type === 'boolean' ? (
                <Form.Item
                  name={field.key}
                  label={getLabelNode(field)}
                  valuePropName="checked"
                  extra={getDesc(field)}
                >
                  <Switch />
                </Form.Item>
              ) : field.type === 'number' ? (
                <Form.Item
                  name={field.key}
                  label={getLabelNode(field)}
                  rules={[{ required: true, message: t('pleaseInput', { label: getLabel(field) }) }]}
                  extra={getDesc(field)}
                >
                  <InputNumber
                    style={{ width: '100%' }}
                    min={meta?.num_ranges?.[field.key]?.[0] ?? 0}
                    max={meta?.num_ranges?.[field.key]?.[1]}
                    step={1}
                  />
                </Form.Item>
              ) : field.type === 'password' ? (
                <Form.Item
                  name={field.key}
                  label={
                    <Space size={4}>
                      <span>{getLabel(field)}</span>
                      {field.key === 'dashscope_api_key' && apikeyStatus && (
                        apikeyStatus.status === 'env' ? (
                          <Tag color="green" style={{ fontSize: 11, lineHeight: '18px', marginLeft: 4 }}>
                            {t('envVarTag')}
                          </Tag>
                        ) : apikeyStatus.status === 'config' ? (
                          <Tag color="blue" style={{ fontSize: 11, lineHeight: '18px', marginLeft: 4 }}>
                            {t('configTag')}
                          </Tag>
                        ) : (
                          <Tag color="red" style={{ fontSize: 11, lineHeight: '18px', marginLeft: 4 }}>
                            {t('notConfiguredTag')}
                          </Tag>
                        )
                      )}
                    </Space>
                  }
                  extra={getDesc(field)}
                >
                  <Input.Password placeholder={apikeyStatus?.configured ? t('placeholder_notCover') : t('placeholder_enterApiKey')} />
                </Form.Item>
              ) : field.type === 'tags' ? (
                <Form.Item
                  name={field.key}
                  label={getLabelNode(field)}
                  // 必填与否交给字段声明（IP 黑名单要能留空 = 不拦任何人），别再硬编码 required
                  rules={getRule(field)}
                  extra={getDesc(field)}
                  getValueFromEvent={(e) => e.target.value}
                >
                  <Input placeholder={field.placeholderKey ? t(field.placeholderKey) : t('placeholder_extensions')} />
                </Form.Item>
              ) : field.type === 'question_types' ? (
                <Form.Item
                  name={field.key}
                  label={getLabelNode(field)}
                  rules={[{ required: true, message: t('pleaseInput', { label: getLabel(field) }) }]}
                  extra={getDesc(field)}
                  getValueFromEvent={(e) => e.target.value}
                >
                  <Input.TextArea rows={7} placeholder={t('placeholder_questionTypes')} />
                </Form.Item>
              ) : field.type === 'roles' ? (
                <Form.Item
                  name={field.key}
                  label={getLabelNode(field)}
                  extra={getDesc(field)}
                >
                  <Checkbox.Group>
                    <Checkbox value={1}>{t('teacher')}</Checkbox>
                    <Checkbox value={2}>{t('student')}</Checkbox>
                  </Checkbox.Group>
                </Form.Item>
              ) : field.type === 'notifications' ? (
                <Form.Item
                  name={field.key}
                  label={getLabelNode(field)}
                  extra={getDesc(field)}
                >
                  <Checkbox.Group>
                    <Checkbox value="exam">{t('notifExam')}</Checkbox>
                    <Checkbox value="share">{t('notifShare')}</Checkbox>
                    <Checkbox value="score">{t('notifScore')}</Checkbox>
                    <Checkbox value="task">{t('notifTask')}</Checkbox>
                    <Checkbox value="rollcall">{t('notifRollcall')}</Checkbox>
                    <Checkbox value="system">{t('notifSystem')}</Checkbox>
                    <Checkbox value="info">{t('notifInfo')}</Checkbox>
                  </Checkbox.Group>
                </Form.Item>
              ) : field.type === 'multimodal_toggle' ? (
                <Form.Item
                  name={field.key}
                  label={getLabelNode(field)}
                  valuePropName="checked"
                  extra={getDesc(field)}
                >
                  <Checkbox>
                    {t('multimodalCheckbox')}
                  </Checkbox>
                </Form.Item>
              ) : (
                <Form.Item
                  name={field.key}
                  label={getLabelNode(field)}
                  rules={getRule(field)}
                  extra={field.key === 'AGENT_EDITION' ? t('agentEditionExtra') : getDesc(field)}
                >
                  {field.key === 'AGENT_EDITION' ? (
                    <Input placeholder={t('placeholder_agentEdition')} maxLength={meta?.str_limits?.[field.key]} />
                  ) : (
                    <Input maxLength={meta?.str_limits?.[field.key]} />
                  )}
                </Form.Item>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ── 一个分区（zone）= 大标题 + 其下若干小节 ──
  const renderZone = (zone: ConfigZone) => (
    <div key={zone.id} style={{ marginBottom: 40 }}>
      <div>
        <Title level={4} style={{ margin: 0 }}>{t(zone.titleKey)}</Title>
        <Text type="secondary" style={{ fontSize: 12 }}>{t(zone.descKey)}</Text>
      </div>
      <Divider style={{ margin: '10px 0 20px' }} />
      {zone.sections.map(renderGroup)}
    </div>
  )

  return (
    <Card style={{ borderRadius: 8 }}>
      <Space style={{ marginBottom: 16 }}>
        <SettingOutlined style={{ fontSize: 24, color: '#1677ff' }} />
        <Title level={4} style={{ margin: 0 }}>{t('systemConfig')}</Title>
        </Space>

        {apikeyStatus && !apikeyStatus.configured && (
          <Alert
            message={t('apiKeyNotConfigured')}
            description={
              <span>
                {apikeyStatus.hint}。{t('apiKeyHint')}
                {user?.role === 'admin' && t('apiKeyEnvHint')}
              </span>
            }
            type="warning"
            showIcon
            icon={<WarningOutlined />}
            style={{ marginBottom: 16 }}
            action={
              <Button size="small" onClick={() => setActiveTab('global')}>
                {t('goConfig')}
              </Button>
            }
          />
        )}

        <Tabs activeKey={activeTab} onChange={setActiveTab}>
          {/* ── 系统配置 Tab ── */}
          <Tabs.TabPane
            tab={<span><SettingOutlined /> {t('systemConfig')}</span>}
            key="global"
          >
            <Spin spinning={loading}>
              {/* 搜索：按名称 / 键名 / 说明过滤，没有命中的小节与分区自动收起 */}
              <Space style={{ marginBottom: 12 }} wrap>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder={t('searchConfig')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ width: 320 }}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {q
                    ? t('matchedN', { n: hitCount, total: GLOBAL_CONFIG_FIELDS.length })
                    : t('totalSections', { sections: CONFIG_ZONES.length, fields: GLOBAL_CONFIG_FIELDS.length })}
                </Text>
              </Space>

              <Form
                form={form}
                layout="vertical"
                onValuesChange={handleValuesChange}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24 }}>
                  {/* 左侧锚点导航：点击定位，滚动时自动高亮当前小节 */}
                  <div style={{ position: 'sticky', top: 0, flex: '0 0 178px', width: 178, maxHeight: 'calc(100vh - 220px)', overflowY: 'auto', paddingTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 11 }}>{t('navTitle')}</Text>
                    {visibleZones.map((zone) => (
                      <div key={zone.id} style={{ marginTop: 8 }}>
                        <div
                          onClick={() => scrollToSection(zone.sections[0])}
                          style={{ fontSize: 12, fontWeight: 600, cursor: 'pointer', marginBottom: 2, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                        >
                          {t(zone.titleKey)}
                        </div>
                        {zone.sections.map((sec) => (
                          <div
                            key={sec}
                            onClick={() => scrollToSection(sec)}
                            style={{
                              fontSize: 12,
                              lineHeight: '22px',
                              padding: '0 8px',
                              cursor: 'pointer',
                              borderRadius: 4,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              color: activeSec === sec ? 'var(--primary-color)' : 'var(--text-secondary)',
                              background: activeSec === sec ? 'color-mix(in srgb, var(--primary-color) 10%, transparent)' : 'transparent',
                              fontWeight: activeSec === sec ? 600 : 400,
                            }}
                          >
                            {t(SECTION_TITLES[sec])}
                          </div>
                        ))}
                      </div>
                    ))}
                    {!visibleZones.length && (
                      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 8 }}>{t('noMatch')}</div>
                    )}
                  </div>

                  <div style={{ flex: 1, minWidth: 0, maxWidth: 960 }}>
                    {visibleZones.map(renderZone)}
                    {/* 兜底：后端有、但本表单没给表单项的配置键 —— 防止再出现"改了页面上看不到的参数" */}
                    {!q && (
                      <div style={{ marginTop: 8, borderTop: '1px dashed var(--border-color-secondary)', paddingTop: 10 }}>
                        <div
                          onClick={() => setAdvOpen((v) => !v)}
                          style={{ cursor: 'pointer', userSelect: 'none', fontSize: 12 }}
                        >
                          <DownOutlined
                            style={{ fontSize: 10, marginRight: 8, color: 'var(--text-tertiary)', transition: 'transform .2s', transform: advOpen ? 'none' : 'rotate(-90deg)' }}
                          />
                          {unknownKeys.length
                            ? <Text type="warning">{t('unknownKeys', { n: unknownKeys.length })}</Text>
                            : <Text type="secondary">{t('unknownKeysOk', { n: GLOBAL_CONFIG_FIELDS.length })}</Text>}
                        </div>
                        {advOpen && (
                          <div style={{ marginTop: 6 }}>
                            <Text type="secondary" style={{ fontSize: 12 }}>{t('unknownKeysHint')}</Text>
                            {unknownKeys.length > 0 && (
                              <pre style={{ fontSize: 12, margin: '6px 0 0', padding: 8, borderRadius: 4, background: 'var(--bg-layout)', maxHeight: 200, overflow: 'auto' }}>
                                {unknownKeys.map((k) => `${k} = ${JSON.stringify(config[k])}`).join('\n')}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* 底部常驻操作栏：改了几项、保存、放弃修改、重新加载 */}
                <div
                  style={{
                    position: 'sticky', bottom: 0, zIndex: 20, marginTop: 8, padding: '10px 0',
                    background: 'var(--bg-container)', borderTop: '1px solid var(--border-color-secondary)',
                    display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  }}
                >
                  <Tag color={dirty.length ? 'orange' : 'default'} style={{ marginInlineEnd: 0 }}>
                    {dirty.length ? t('unsavedCount', { n: dirty.length }) : t('noChanges')}
                  </Tag>
                  <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty.length} onClick={handleSave}>
                    {t('saveConfig')}
                  </Button>
                  <Button icon={<RollbackOutlined />} disabled={!dirty.length} onClick={handleDiscard}>
                    {t('discard')}
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={loadConfig}>
                    {t('reload')}
                  </Button>
                  <Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>{t('effectNote')}</Text>
                </div>
              </Form>
            </Spin>
          </Tabs.TabPane>

          {/* ── 技能管理 Tab ── */}
          <Tabs.TabPane
            tab={<span><SettingOutlined /> {t('skillManagement')}</span>}
            key="skills"
          >
            <SkillManagePanel />
          </Tabs.TabPane>

          {/* ── 缓存管理 Tab ── */}
          <Tabs.TabPane
            tab={<span><ReloadOutlined /> {t('cacheManagement')}</span>}
            key="cache"
          >
            <Card title={t('clearTempFiles')}>
              <Text style={{ display: 'block', marginBottom: 16 }}>
                {t('tempFileDesc')}
              </Text>
              <Space orientation="vertical" style={{ width: '100%' }}>
                <Alert
                  message={t('cleanupWarning')}
                  type="warning"
                  showIcon
                />
                <Button
                  danger
                  type="primary"
                  icon={<ReloadOutlined />}
                  onClick={() => {
                    Modal.confirm({
                      title: t('confirmCleanup'),
                      icon: <ExclamationCircleOutlined />,
                      content: t('confirmCleanupContent'),
                      okText: t('confirmCleanupOk'),
                      okType: 'danger',
                      cancelText: t('cancel'),
                      onOk: async () => {
                        try {
                          await apiClient.delete('/api/files/cleanup-temp', { params: { all: true } })
                          message.success(t('cleanupSuccess'))
                        } catch (e: unknown) {
                          const err = e as { response?: { data?: { detail?: string } }; message?: string }
                          message.error(t('cleanupFailed') + ': ' + (err?.response?.data?.detail || err?.message || t('unknownError')))
                        }
                      },
                    })
                  }}
                >
                  {t('cleanAllCache')}
                </Button>
              </Space>
            </Card>
          </Tabs.TabPane>

          {/* ── 版本管理 Tab ── */}
          <Tabs.TabPane
            tab={<span><SyncOutlined /> {t('version')}</span>}
            key="upgrade"
          >
            <UpgradePanel />
          </Tabs.TabPane>

        </Tabs>
    </Card>
  )
}

export default SystemConfigPage
