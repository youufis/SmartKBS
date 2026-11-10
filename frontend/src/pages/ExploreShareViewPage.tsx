/** 探索画布 · 分享查看页（M2）：任课教师/管理员打开学生授权的只读快照 */
import React, { useEffect, useState } from 'react'
import { Button, Tag, Typography } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useIsMobile } from '../hooks/useIsMobile'
import ExploreSnapshotView from '../components/explore/ExploreSnapshotView'
import { getShare, type ShareDetail } from '../api/explore'

const { Text } = Typography

const ExploreShareViewPage: React.FC = () => {
  const { shareId } = useParams()
  const nav = useNavigate()
  const { t } = useTranslation('explore')
  const isMobile = useIsMobile()
  const [detail, setDetail] = useState<ShareDetail | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    getShare(Number(shareId))
      .then(setDetail)
      .catch((e: any) => {
        const status = e?.response?.status
        setErr(status === 403 ? t('shareErrForbidden') : status === 410 ? t('shareErrExpired') : (e?.response?.data?.detail || t('shareErrLoad')))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId])

  // 窄屏（390px）实测：标题 maxWidth 360 + 只读标签 + 右侧「谁分享的·浏览·到期」三段文本
  // 挤在同一行，右侧信息直接被顶出视口。改成允许换行、标题占满一行、信息另起一行。
  const header = (right: React.ReactNode) => (
    <div className="share-header" style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
      borderBottom: '1px solid var(--border-color, #f0f0f0)', flexShrink: 0, flexWrap: 'wrap', rowGap: 4,
    }}>
      <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => nav('/explore')} />
      <span style={{ fontWeight: 600, fontSize: 15, flex: isMobile ? '1 1 160px' : undefined, maxWidth: isMobile ? undefined : 360, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {detail ? detail.title : t('shareTitleFallback')}
      </span>
      {detail && <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t('shareReadonlyTag')}</Tag>}
      {/* 窄屏：「谁分享 · 浏览 · 到期」另起一行；桌面维持原来的行右侧 */}
      <div style={isMobile ? { flex: '1 1 100%', order: 9, fontSize: 12, color: 'var(--text-secondary, #888)', whiteSpace: 'normal' } : { fontSize: 12, color: 'var(--text-secondary, #888)' }}>
        {right}
      </div>
    </div>
  )

  if (err) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        {header(null)}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <div style={{ fontSize: 40 }}>🔒</div>
          <Text type="secondary">{err}</Text>
          <Button onClick={() => nav('/explore')}>{t('shareBack')}</Button>
        </div>
      </div>
    )
  }
  if (!detail) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        {header(null)}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary, #888)' }}>
          {t('shareLoading')}
        </div>
      </div>
    )
  }
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {header(
        <span>
          {t('shareMeta', {
            name: detail.owner_name || detail.owner_username,
            views: t('shareViews', { n: detail.view_count }),
            expire: t('shareExpireWord', { d: (detail.expires_at || '').slice(5, 10) }),
          })}
        </span>,
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ExploreSnapshotView snapshot={detail.snapshot_json} />
      </div>
    </div>
  )
}

export default ExploreShareViewPage
