import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation, Trans } from 'react-i18next'
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
  cancelUpgrade, createBackup,
  type VersionInfo, type UpgradeProgress,
} from '../api/upgrade'

const { Title, Text } = Typography

// ── 全局配置表单 ──

const GLOBAL_CONFIG_FIELDS = [
  // 品牌信息
  { key: 'AGENT_EDITION', labelKey: 'field_AGENT_EDITION', descKey: 'field_AGENT_EDITION_desc', type: 'text', group: 'brand' },
  { key: 'ORG_NAME', labelKey: 'field_ORG_NAME', descKey: 'field_ORG_NAME_desc', type: 'text', group: 'brand', required: false },
  // API 密钥
  { key: 'dashscope_api_key', labelKey: 'field_dashscope_api_key', descKey: 'field_dashscope_api_key_desc', type: 'password', group: 'api' },
  // 模型与应用配置
  { key: 'APPID', labelKey: 'field_APPID', descKey: 'field_APPID_desc', type: 'text', group: 'model', required: false },
  { key: 'QWEN_OPENAI_API_BASE', labelKey: 'field_QWEN_OPENAI_API_BASE', descKey: 'field_QWEN_OPENAI_API_BASE_desc', type: 'text', group: 'model' },
  { key: 'MODEL_LONG_NAME', labelKey: 'field_MODEL_LONG_NAME', descKey: 'field_MODEL_LONG_NAME_desc', type: 'text', group: 'model' },
  { key: 'MODEL_VL_NAME', labelKey: 'field_MODEL_VL_NAME', descKey: 'field_MODEL_VL_NAME_desc', type: 'text', group: 'model' },
  { key: 'MODEL_NAME', labelKey: 'field_MODEL_NAME', descKey: 'field_MODEL_NAME_desc', type: 'text', group: 'model' },
  { key: 'ENABLE_MULTIMODAL', labelKey: 'field_ENABLE_MULTIMODAL', descKey: 'field_ENABLE_MULTIMODAL_desc', type: 'multimodal_toggle', group: 'model' },
  // AI 对话权限
  { key: 'ENABLE_AI_CHAT_FOR_ROLES', labelKey: 'field_ENABLE_AI_CHAT_FOR_ROLES', descKey: 'field_ENABLE_AI_CHAT_FOR_ROLES_desc', type: 'roles', group: 'ai' },
  // 系统限制
  { key: 'MAX_DOC_SIZE_MB', labelKey: 'field_MAX_DOC_SIZE_MB', type: 'number', group: 'limit' },
  { key: 'MAX_IMAGE_SIZE_MB', labelKey: 'field_MAX_IMAGE_SIZE_MB', type: 'number', group: 'limit' },
  { key: 'JWT_EXPIRATION_HOURS', labelKey: 'field_JWT_EXPIRATION_HOURS', type: 'number', group: 'limit' },
  { key: 'ONLINE_USER_TIMEOUT_SECONDS', labelKey: 'field_ONLINE_USER_TIMEOUT_SECONDS', type: 'number', group: 'limit' },
  { key: 'ENABLE_REQUEST_LIMIT', labelKey: 'field_ENABLE_REQUEST_LIMIT', type: 'boolean', group: 'limit' },
  { key: 'MAX_ALLOWED_REQUESTS', labelKey: 'field_MAX_ALLOWED_REQUESTS', type: 'number', group: 'limit' },
  { key: 'TEACHER_DOWNLOAD_QUOTA_GB', labelKey: 'field_TEACHER_DOWNLOAD_QUOTA_GB', descKey: 'field_TEACHER_DOWNLOAD_QUOTA_GB_desc', type: 'number', group: 'limit' },
  // 课程设置
  { key: 'SUBJECTS', labelKey: 'field_SUBJECTS', descKey: 'field_SUBJECTS_desc', type: 'tags', group: 'subjects' },
  // 题型设置
  { key: 'QUESTION_TYPES', labelKey: 'field_QUESTION_TYPES', descKey: 'field_QUESTION_TYPES_desc', type: 'question_types', group: 'subjects' },
  // 消息通知
  { key: 'enabled_notification_types', labelKey: 'field_enabled_notification_types', descKey: 'field_enabled_notification_types_desc', type: 'notifications', group: 'notify' },
  // 文件类型白名单
  { key: 'IMAGE_EXTENSIONS', labelKey: 'field_IMAGE_EXTENSIONS', descKey: 'field_IMAGE_EXTENSIONS_desc', type: 'tags', group: 'filetype' },
  { key: 'DOCUMENT_EXTENSIONS', labelKey: 'field_DOCUMENT_EXTENSIONS', descKey: 'field_DOCUMENT_EXTENSIONS_desc', type: 'tags', group: 'filetype' },
  // 图片生成
  { key: 'IMAGE_GEN_ENABLED', labelKey: 'field_IMAGE_GEN_ENABLED', descKey: 'field_IMAGE_GEN_ENABLED_desc', type: 'boolean', group: 'imagegen' },
  { key: 'IMAGE_GEN_MODEL', labelKey: 'field_IMAGE_GEN_MODEL', descKey: 'field_IMAGE_GEN_MODEL_desc', type: 'text', group: 'imagegen' },
  { key: 'IMAGE_GEN_SIZE', labelKey: 'field_IMAGE_GEN_SIZE', descKey: 'field_IMAGE_GEN_SIZE_desc', type: 'text', group: 'imagegen' },
  // 闯关挑战
  { key: 'QUEST_USE_BANK', labelKey: 'field_QUEST_USE_BANK', descKey: 'field_QUEST_USE_BANK_desc', type: 'boolean', group: 'quest' },
]

const GROUP_LABELS: Record<string, string> = {
  brand: 'group_brand',
  api: 'group_api',
  model: 'group_model',
  ai: 'group_ai',
  subjects: 'group_subjects',
  limit: 'group_limit',
  notify: 'group_notify',
  filetype: 'group_filetype',
  imagegen: 'group_imagegen',
  quest: 'group_quest',
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

          {/* 不兼容变更警告 */}
          {verInfo.breaking_changes && verInfo.breaking_changes.length > 0 && (
            <Alert
              type="warning"
              message={t('breakingChanges')}
              description={verInfo.breaking_changes.join('；')}
              showIcon
              style={{ marginTop: 16 }}
            />
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
              render: (s: string) => {
                const map: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
                  success: { color: 'green', icon: <CheckCircleOutlined />, label: t('statusSuccess') },
                  failed: { color: 'red', icon: <CloseCircleOutlined />, label: t('statusFailed') },
                  rolled_back: { color: 'orange', icon: <RollbackOutlined />, label: t('statusRolledBack') },
                }
                const item = map[s] || { color: 'default', icon: null, label: s }
                return <Tag color={item.color} icon={item.icon}>{item.label}</Tag>
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
      message.error(t('loadConfigFailed'))
    } finally {
      setLoading(false)
    }
  }, [t, form, loadApikeyStatus])

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
      message.success(t('configSavedMsg'))
      loadConfig()
    } catch (err: unknown) {
      const e = err as { errorFields?: unknown; response?: { data?: { detail?: string } }; message?: string }
      if (e?.errorFields) return // 表单校验未通过
      message.error(t('saveFailed') + ': ' + (e?.response?.data?.detail || e?.message || t('unknownError')))
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
          formValues['enabled_notification_types'] = ['exam', 'system']
        }
        form.setFieldsValue(formValues)
        loadApikeyStatus()
      } catch {
        message.error(t('loadConfigFailed'))
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [t, user, form, loadApikeyStatus])

  // 非管理员重定向到 AI 对话
  if (user?.role !== 'admin') {
    navigate('/chat', { replace: true })
    return null
  }

  // ── 全局配置表单各分组 ──
  const renderGroup = (group: string) => {
    const fields = GLOBAL_CONFIG_FIELDS.filter((f) => f.group === group)
    const getLabel = (field: typeof GLOBAL_CONFIG_FIELDS[number]) => t(field.labelKey)
    const getDesc = (field: typeof GLOBAL_CONFIG_FIELDS[number]) => field.descKey ? t(field.descKey) : undefined
    const getRule = (field: typeof GLOBAL_CONFIG_FIELDS[number]) =>
      field.required !== false ? [{ required: true, message: t('pleaseInput', { label: getLabel(field) }) }] : undefined
    return (
      <div key={group} style={{ marginBottom: 32 }}>
        <Title level={5}>{t(GROUP_LABELS[group])}</Title>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: 16 }}>
          {fields.map((field) => (
            <div key={field.key}>
              {field.type === 'boolean' ? (
                <Form.Item
                  name={field.key}
                  label={getLabel(field)}
                  valuePropName="checked"
                  extra={getDesc(field)}
                >
                  <Switch />
                </Form.Item>
              ) : field.type === 'number' ? (
                <Form.Item
                  name={field.key}
                  label={getLabel(field)}
                  rules={[{ required: true, message: t('pleaseInput', { label: getLabel(field) }) }]}
                >
                  <InputNumber style={{ width: '100%' }} min={0} />
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
                  label={getLabel(field)}
                  rules={[{ required: true, message: t('pleaseInput', { label: getLabel(field) }) }]}
                  extra={getDesc(field)}
                  getValueFromEvent={(e) => e.target.value}
                >
                  <Input placeholder={t('placeholder_extensions')} />
                </Form.Item>
              ) : field.type === 'question_types' ? (
                <Form.Item
                  name={field.key}
                  label={getLabel(field)}
                  rules={[{ required: true, message: t('pleaseInput', { label: getLabel(field) }) }]}
                  extra={getDesc(field)}
                  getValueFromEvent={(e) => e.target.value}
                >
                  <Input.TextArea rows={7} placeholder={t('placeholder_questionTypes')} />
                </Form.Item>
              ) : field.type === 'roles' ? (
                <Form.Item
                  name={field.key}
                  label={getLabel(field)}
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
                  label={getLabel(field)}
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
                  label={getLabel(field)}
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
                  label={getLabel(field)}
                  rules={getRule(field)}
                  extra={field.key === 'AGENT_EDITION' ? t('agentEditionExtra') : getDesc(field)}
                >
                  {field.key === 'AGENT_EDITION' ? (
                    <Input placeholder={t('placeholder_agentEdition')} />
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
          {/* ── 全局配置 Tab ── */}
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

          <Tabs.TabPane
            tab={<span><SettingOutlined /> {t('systemConfig')}</span>}
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
                    {t('saveConfig')}
                  </Button>
                  <Button icon={<ReloadOutlined />} onClick={loadConfig}>
                    {t('reload')}
                  </Button>
                </Space>
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary">
                    {t('restartNote')}
                  </Text>
                </div>
              </Form>
            </Spin>
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
