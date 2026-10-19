/**
 * 知识点关联资源卡片（课程管理 · 知识点详情面板内使用）
 *
 * 一行式卡片：图标 + 名称（超长省略，悬浮看全名）+ 类型/统计标签；
 * 右侧为教师操作区（上移 / 下移 / 解绑 / 重置作答数据）。
 * 整卡可点即打开资源，操作区 stopPropagation，避免误触。
 * 展示名会去掉 AI 产物文件名里的生成时间戳（_YYYYMMDD_HHMMSS），悬浮提示保留原全名。
 */
import React from 'react'
import { Card, Space, Tag, Tooltip, Typography, Button, Popconfirm } from 'antd'
import {
  FileOutlined, DownloadOutlined, QuestionCircleOutlined, FormOutlined,
  TeamOutlined, CheckCircleOutlined, ArrowUpOutlined, ArrowDownOutlined, DeleteOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CurriculumResource } from '../types'
import ResetActivityButton from './ResetActivityButton'

const RESOURCE_ICONS: Record<string, React.ReactNode> = {
  html: <FileOutlined />,
  download: <DownloadOutlined />,
  question: <QuestionCircleOutlined />,
  exam: <FormOutlined />,
  discussion: <TeamOutlined />,
  interaction_quiz: <FormOutlined />,
  task: <CheckCircleOutlined />,
}

const RESOURCE_LABELS: Record<string, string> = {
  html: 'resourceHtml',
  download: 'resourceDownload',
  question: 'resourceQuestion',
  exam: 'resourceExam',
  discussion: 'resourceDiscussion',
  interaction_quiz: 'resourceInteractionQuiz',
  task: 'resourceTask',
}

/** 生成时间戳片段：AI 生成的练习/播客文件名里会带 _20260616_102943 */
const TIMESTAMP_RE = /(_\d{8}_\d{6})(?=_|\.|$)/

/** 展示名：去掉时间戳与因此产生的多余下划线；命中不到就原样返回 */
function prettyResourceName(name: string): string {
  if (!name) return ''
  const cleaned = name.replace(TIMESTAMP_RE, '').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || name
}

interface KpResourceCardProps {
  resource: CurriculumResource
  isTeacherOrAdmin: boolean
  isStudent: boolean
  onOpen: (resource: CurriculumResource) => void
  onUnbind: (resource: CurriculumResource) => void
  onMove: (resource: CurriculumResource, delta: -1 | 1) => void
  canMoveUp: boolean
  canMoveDown: boolean
  moving: boolean
  onResetSuccess?: () => void
}

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8 }
const mainStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }
const bodyStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }

const KpResourceCard: React.FC<KpResourceCardProps> = ({
  resource: r, isTeacherOrAdmin, isStudent, onOpen, onUnbind, onMove,
  canMoveUp, canMoveDown, moving, onResetSuccess,
}) => {
  const { t } = useTranslation('curriculum')
  const openable = Boolean(r.resource_url)
  const displayName = prettyResourceName(r.resource_name) || `[${r.resource_type}:${r.resource_id}]`

  return (
    <Card
      size="small"
      hoverable={openable}
      style={{ cursor: openable ? 'pointer' : 'default' }}
      onClick={() => { if (openable) onOpen(r) }}
    >
      <div style={rowStyle}>
        <div style={mainStyle}>
          <span style={{ fontSize: 16 }}>{RESOURCE_ICONS[r.resource_type] || <FileOutlined />}</span>
          <div style={bodyStyle}>
            <Typography.Text
              ellipsis={{ tooltip: r.resource_name || displayName }}
              style={{ display: 'block', color: openable ? 'var(--primary-color)' : undefined }}
            >
              {displayName}
            </Typography.Text>
            <Space size={6} wrap>
              <Tag style={{ marginInlineEnd: 0 }}>{t(RESOURCE_LABELS[r.resource_type]) || r.resource_type}</Tag>
              {isTeacherOrAdmin && r.view_stats && (
                <Tooltip title={t('kpViewStatsTip')}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('viewStats', { viewers: r.view_stats.unique_viewers, views: r.view_stats.total_views })}
                  </Typography.Text>
                </Tooltip>
              )}
              {isStudent && r.viewed !== undefined && (
                <Tag color={r.viewed ? 'success' : 'default'} style={{ fontSize: 11, marginInlineEnd: 0 }}>
                  {r.viewed ? t('viewed') : t('notViewed')}
                </Tag>
              )}
            </Space>
          </div>
        </div>
        {isTeacherOrAdmin && (
          <Space size={0} style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
            <Tooltip title={t('moveUp')}>
              <Button type="text" size="small" icon={<ArrowUpOutlined />} disabled={!canMoveUp || moving} onClick={() => onMove(r, -1)} />
            </Tooltip>
            <Tooltip title={t('moveDown')}>
              <Button type="text" size="small" icon={<ArrowDownOutlined />} disabled={!canMoveDown || moving} onClick={() => onMove(r, 1)} />
            </Tooltip>
            <Popconfirm
              title={t('kpUnbindConfirm')}
              okText={t('confirm')}
              cancelText={t('cancel')}
              onConfirm={() => onUnbind(r)}
            >
              <Button type="text" size="small" danger icon={<DeleteOutlined />} title={t('rbUnbind')} />
            </Popconfirm>
            <ResetActivityButton
              activityType="course"
              activityId={r.binding_id}
              iconOnly
              stopPropagation
              onSuccess={onResetSuccess}
            />
          </Space>
        )}
      </div>
    </Card>
  )
}

export default KpResourceCard