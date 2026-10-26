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
import { ArrowUpOutlined, ArrowDownOutlined, DeleteOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CurriculumResource } from '../types'
import ResetActivityButton from './ResetActivityButton'
import { prettyResourceName, resourceIcon, resourceTypeLabel } from '../utils/resourceType'

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
  /** 单行紧凑形态：绑定框「已绑定」页是管理列表，一行一条才装得下（默认两行卡片给知识点面板用） */
  dense?: boolean
}

const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 8 }
const mainStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }
const bodyStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0 }

const KpResourceCard: React.FC<KpResourceCardProps> = ({
  resource: r, isTeacherOrAdmin, isStudent, onOpen, onUnbind, onMove,
  canMoveUp, canMoveDown, moving, onResetSuccess, dense,
}) => {
  const { t } = useTranslation('curriculum')
  const openable = Boolean(r.resource_url)
  const displayName = prettyResourceName(r.resource_name) || `[${r.resource_type}:${r.resource_id}]`

  const tags = (
    <>
      <Tag style={{ marginInlineEnd: 0 }}>{resourceTypeLabel(t, r.resource_type)}</Tag>
      {isTeacherOrAdmin && r.view_stats && (
        <Tooltip title={t('kpViewStatsTip')}>
          <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {t('viewStats', { viewers: r.view_stats.unique_viewers, views: r.view_stats.total_views })}
          </Typography.Text>
        </Tooltip>
      )}
      {isStudent && r.viewed !== undefined && (
        <Tag color={r.viewed ? 'success' : 'default'} style={{ fontSize: 11, marginInlineEnd: 0 }}>
          {r.viewed ? t('viewed') : t('notViewed')}
        </Tag>
      )}
    </>
  )

  const actions = isTeacherOrAdmin ? (
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
  ) : null

  // 紧凑单行：图标 | 名称（占满剩余宽度）| 类型与统计 | 操作
  if (dense) {
    return (
      <Card
        size="small"
        hoverable={openable}
        styles={{ body: { padding: '5px 10px' } }}
        style={{ cursor: openable ? 'pointer' : 'default' }}
        onClick={() => { if (openable) onOpen(r) }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 15, flexShrink: 0, color: 'var(--text-secondary)' }}>
            {resourceIcon(r.resource_type)}
          </span>
          <Typography.Text
            ellipsis={{ tooltip: r.resource_name || displayName }}
            style={{ flex: '1 1 auto', minWidth: 0, fontSize: 13, color: openable ? 'var(--primary-color)' : undefined }}
          >
            {displayName}
          </Typography.Text>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>{tags}</span>
          {actions}
        </div>
      </Card>
    )
  }

  return (
    <Card
      size="small"
      hoverable={openable}
      style={{ cursor: openable ? 'pointer' : 'default' }}
      onClick={() => { if (openable) onOpen(r) }}
    >
      <div style={rowStyle}>
        <div style={mainStyle}>
          <span style={{ fontSize: 16 }}>{resourceIcon(r.resource_type)}</span>
          <div style={bodyStyle}>
            <Typography.Text
              ellipsis={{ tooltip: r.resource_name || displayName }}
              style={{ display: 'block', color: openable ? 'var(--primary-color)' : undefined }}
            >
              {displayName}
            </Typography.Text>
            <Space size={6} wrap>{tags}</Space>
          </div>
        </div>
        {actions}
      </div>
    </Card>
  )
}

export default KpResourceCard