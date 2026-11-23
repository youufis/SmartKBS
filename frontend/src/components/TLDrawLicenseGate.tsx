/**
 * 白板授权闸门 —— tldraw 的 key 解析、说明页与配置页状态标签
 *
 * 为什么要有这个文件：tldraw 在未授权/域名不符/key 过期时，会在 5 秒后把画布整体替换成
 * 空白 div（SDK 的 LicenseGate）。老师上课点开白板看到一片空白，既不像"配置问题"也没法
 * 排查。所以三个画布组件在挂载 <Tldraw> 之前先过这道闸：能判定会空白的，直接渲染自有说明页。
 *
 * 这里只决定"挂不挂载我们的 UI"，不干预 SDK 的水印与校验 —— 后者是 tldraw license 明令禁止的。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Form, Space, Tag, Tooltip } from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import {
  fetchTLDrawRuntimeKey,
  parseTLDrawLicenseKey,
  resetTLDrawRuntimeCache,
  tlHostsLicensed,
  type TLBlockReason,
} from '../constants/tldrawLicense'
import {
  ensureTLVerifyCapability,
  tlVerifyCapability,
  type TLVerifyCapability,
} from '../utils/webcryptoVerifyShim'

const REASON_KEYS: Record<TLBlockReason, string> = {
  'no-key': 'tlBlockedReasonNoKey',
  'invalid-key': 'tlBlockedReasonInvalidKey',
  expired: 'tlBlockedReasonExpired',
  'host-not-licensed': 'tlBlockedReasonHost',
}

/** 说明页：替代"5 秒后空白"的失败形态 */
export const TLDrawLicenseBlocked: React.FC<{ reasons: TLBlockReason[]; onRecheck?: () => void }> = ({ reasons, onRecheck }) => {
  const { t } = useTranslation()
  const isAdmin = useAuthStore((s) => s.user)?.role === 'admin'
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, background: 'var(--bg-layout, #f5f5f5)',
    }}>
      <Alert
        type="warning"
        showIcon
        style={{ maxWidth: 620 }}
        message={t('tlBlockedTitle')}
        description={
          <Space direction="vertical" size={4} style={{ display: 'flex' }}>
            <div>{t('tlBlockedDesc')}</div>
            {(reasons.length ? reasons : ['no-key' as TLBlockReason]).map((r) => (
              <div key={r}>· {t(REASON_KEYS[r])}</div>
            ))}
            <div style={{ marginTop: 6, color: 'var(--text-tertiary, #888)', fontSize: 12 }}>
              {isAdmin ? t('tlBlockedHintAdmin') : t('tlBlockedHintStudent')}
            </div>
          </Space>
        }
        action={onRecheck ? <Button size="small" icon={<SyncOutlined />} onClick={onRecheck}>{t('tlBlockedRetry')}</Button> : undefined}
      />
    </div>
  )
}

const SOURCE_KEYS: Record<string, string> = {
  draft: 'tlLicenseSourceDraft',
  runtime: 'tlLicenseSourceRuntime',
  none: 'tlLicenseStatusNone',
}

const CAP_KEYS: Record<TLVerifyCapability, string> = {
  native: 'tlLicenseCapNative',
  shim: 'tlLicenseCapShim',
  none: 'tlLicenseCapNone',
}

/**
 * 配置页里贴在字段标题旁的状态标签：当前生效的是哪来的 key、什么类型、还剩几天、
 * 域名在不在授权范围内、这台机器上 SDK 能不能真的验签。draft（表单里还没保存的值）优先显示。
 */
export const TLDrawLicenseStatus: React.FC = () => {
  const { t } = useTranslation('system')
  const draft = (Form.useWatch('TL_LICENSE_KEY') as string | undefined) ?? ''
  const [saved, setSaved] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [cap, setCap] = useState<TLVerifyCapability>(() => tlVerifyCapability())

  const load = useCallback(() => {
    setChecking(true)
    resetTLDrawRuntimeCache()
    fetchTLDrawRuntimeKey().then(async (k) => {
      setSaved(k)
      // 只有真的填了 key 才去加载 tl-verify.js：留空的部署行为与旧版完全一致
      setCap(k.trim() ? await ensureTLVerifyCapability() : tlVerifyCapability())
      setChecking(false)
    })
  }, [])

  useEffect(() => { load() }, [load])

  const savedTrim = (saved ?? '').trim()
  const draftTrim = draft.trim()
  const effective = draftTrim || savedTrim
  const source = draftTrim ? 'draft' : savedTrim ? 'runtime' : 'none'
  const info = effective ? parseTLDrawLicenseKey(effective) : null

  if (checking) return <Tag style={{ marginInlineStart: 4 }}>{t('tlLicenseChecking')}</Tag>
  const capTag = <Tag color={cap === 'none' ? 'orange' : 'green'}>{t(CAP_KEYS[cap])}</Tag>
  if (source === 'none') return <Space size={4} style={{ marginInlineStart: 4 }}><Tag>{t('tlLicenseStatusNone')}</Tag>{capTag}</Space>
  if (!info) {
    return (
      <Space size={4} style={{ marginInlineStart: 4 }}>
        <Tag color="red">{t('tlLicenseStatusInvalid')}</Tag>
        {capTag}
      </Space>
    )
  }
  const hostOk = info.hosts.includes('*') || tlHostsLicensed(info.hosts, location.hostname)
  return (
    <Space size={4} style={{ marginInlineStart: 4, flexWrap: 'wrap' }}>
      <Tag color="blue">{t(SOURCE_KEYS[source])}</Tag>
      <Tag>{info.kinds.join('+') || 'license'}</Tag>
      {info.expired ? (
        <Tag color="red">{t('tlLicenseStatusExpired', { date: info.expiry })}</Tag>
      ) : info.daysLeft <= 21 ? (
        <Tag color="orange">{t('tlLicenseStatusDays', { n: info.daysLeft, date: info.expiry })}</Tag>
      ) : (
        <Tooltip title={t('tlLicenseStatusExpiresOn', { date: info.expiry })}>
          <Tag color="green">{info.expiry}</Tag>
        </Tooltip>
      )}
      {!hostOk ? (
        <Tooltip title={info.hosts.join(', ')}>
          <Tag color="red">{t('tlLicenseStatusHostMismatch')}</Tag>
        </Tooltip>
      ) : null}
      {capTag}
      <Button size="small" type="text" icon={<SyncOutlined />} onClick={load} aria-label={t('tlLicenseRefresh')} />
    </Space>
  )
}
