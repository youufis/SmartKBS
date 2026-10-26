/**
 * 知识点详情面板（课程管理右侧）
 *
 * 两种承载形态：
 *   - variant="card"（默认）：宽屏时作为右栏内联卡片（带标题 + 收起按钮）；
 *   - variant="plain"：窄屏时塞进右侧 Drawer 里，标题/关闭交给 Drawer，本体只出内容。
 *
 * 内容：操作条（编辑 / 挂接 / AI 练习 / AI 工具；学生为进度按钮）、知识点说明、
 * 学习目标、难度与时长标签、关联资源列表（含排序 / 解绑 / 重置）。
 *
 * 操作条放在内容顶部而不是 Card.extra：窄栏时 extra 会折到标题下方并左对齐，
 * 看起来像排版坏了；放在内容里换行始终整齐。
 *
 * 关联资源列表**不自带滚动条**：宽屏时本面板在 <Content overflow:auto> 的右栏里、
 * 窄屏时在 Drawer 里，外层已经在滚；再套一层内滚就是双滚动条打架（滚轮卡在子列表）。
 * 条数多时教师端改为折叠 + 「展开全部」，学生端一律全量显示（不能藏学习材料）。
 */
import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Space, Tag, Tooltip, Typography, Button, Dropdown, Empty, message } from 'antd'
import {
  NodeIndexOutlined, SettingOutlined, FormOutlined, BulbOutlined, DownOutlined,
  CheckCircleOutlined, ClockCircleOutlined, PlusOutlined, EditOutlined, CloseOutlined,
  RobotOutlined, FileOutlined, SoundOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { KnowledgePoint, CurriculumResource } from '../types'
import * as curriculumApi from '../api/curriculum'
import KpResourceCard from './KpResourceCard'

const DIFFICULTY_COLORS: Record<string, string> = { easy: 'green', medium: 'gold', hard: 'red' }
const DIFFICULTY_LABELS: Record<string, string> = {
  easy: 'difficultyEasy', medium: 'difficultyMedium', hard: 'difficultyHard',
}
const STATUS_LABELS: Record<string, string> = {
  not_started: 'statusNotStarted', in_progress: 'statusInProgress', completed: 'statusCompleted',
}
const STATUS_COLORS: Record<string, string> = {
  not_started: 'default', in_progress: 'processing', completed: 'success',
}

const fieldLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12, marginBottom: 2 }

interface KpDetailPanelProps {
  kp: KnowledgePoint
  resources: CurriculumResource[]
  loading: boolean
  isTeacherOrAdmin: boolean
  isStudent: boolean
  lessonPlanLoading?: boolean
  podcastDisabled?: boolean
  /** card = 自带标题与收起按钮的内联卡片；plain = 只出内容，交给外层 Drawer */
  variant?: 'card' | 'plain'
  onClose: () => void
  onEdit: (kp: KnowledgePoint) => void
  onLink: (kp: KnowledgePoint) => void
  onAiPractice: (kpId: number) => void
  onAiTool: (key: string) => void
  onProgress: (kpId: number, status: string) => void
  onManageBindings: () => void
  onResourcesChanged: () => void
}

/** 教师端关联资源超过几条先折叠（约一屏高度，再多就该去「管理绑定资源」里看） */
const RES_COLLAPSE_AT = 6

const KpDetailPanel: React.FC<KpDetailPanelProps> = ({
  kp, resources, loading, isTeacherOrAdmin, isStudent, lessonPlanLoading, podcastDisabled,
  variant = 'card',
  onClose, onEdit, onLink, onAiPractice, onAiTool, onProgress, onManageBindings, onResourcesChanged,
}) => {
  const { t } = useTranslation('curriculum')
  const navigate = useNavigate()
  const [movingId, setMovingId] = useState<number | null>(null)
  const [resExpanded, setResExpanded] = useState(false)
  // 换知识点要回到折叠态：否则上一个知识点展开的状态会被带过来
  useEffect(() => { setResExpanded(false) }, [kp.id])
  // 学生端不折叠：关联资源就是他要学的材料，藏起来等于少留作业
  const resCollapsed = isTeacherOrAdmin && !resExpanded && resources.length > RES_COLLAPSE_AT
  const shownResources = resCollapsed ? resources.slice(0, RES_COLLAPSE_AT) : resources

  // 打开资源：文件类开新标签；站内活动（考试/讨论/测验/任务）走 SPA 路由，避免跳出课程页
  const openResource = (r: CurriculumResource) => {
    if (!r.resource_url) return
    const isFileType = r.resource_type === 'html' || r.resource_type === 'download'
    if (isStudent && isFileType) {
      import('../api/tracking').then((mod) => {
        mod.logResourceView({
          resource_type: r.resource_type,
          // 浏览留痕表按数字主键存，这里只有 html/download 会进来
          resource_id: Number(r.resource_id),
          knowledge_point_id: kp.id,
          binding_id: r.binding_id,
          source: 'curriculum',
          file_path: r.resource_url.replace('/api/files/', ''),
        })
      }).catch(() => { /* 统计失败不影响打开 */ })
    }
    if (isFileType) {
      window.open(r.resource_url, '_blank', 'noopener')
    } else {
      navigate(r.resource_url)
    }
  }

  const unbindResource = async (r: CurriculumResource) => {
    try {
      await curriculumApi.unbindResource(r.binding_id)
      message.success(t('rbUnbindSuccess'))
      onResourcesChanged()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || t('rbUnbindFailed'))
    }
  }

  const moveResource = async (r: CurriculumResource, delta: -1 | 1) => {
    const idx = resources.findIndex((x) => x.binding_id === r.binding_id)
    const target = idx + delta
    if (idx < 0 || target < 0 || target >= resources.length) return
    const next = [...resources]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    setMovingId(r.binding_id)
    try {
      await curriculumApi.reorderBindings(next.map((x, i) => ({ binding_id: x.binding_id, sort_order: i })))
      message.success(t('sortUpdated'))
      onResourcesChanged()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail || t('updateFailed'))
    } finally {
      setMovingId(null)
    }
  }

  const aiToolItems = [
    { key: 'lesson-plan', icon: <RobotOutlined />, label: t('aiLessonPlan'), disabled: lessonPlanLoading },
    { key: 'recommend', icon: <RobotOutlined />, label: t('aiRecommend') },
    { key: 'courseware', icon: <FileOutlined />, label: t('aiCourseware') },
    {
      key: 'podcast',
      icon: <SoundOutlined />,
      label: podcastDisabled ? `${t('aiPodcast')}（${t('podcastTtsOffShort')}）` : t('aiPodcast'),
      disabled: podcastDisabled,
    },
  ]

  const body = (
    <>
      {/* ── 操作条 ── */}
      <Space wrap size={4} style={{ marginBottom: 16 }}>
        {isTeacherOrAdmin && (
          <>
            <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(kp)}>{t('edit')}</Button>
            <Tooltip title={t('kpLinkTip')}>
              <Button size="small" icon={<SettingOutlined />} onClick={() => onLink(kp)}>{t('kpLink')}</Button>
            </Tooltip>
            <Tooltip title={t('aiGeneratePractice')}>
              <Button size="small" icon={<FormOutlined />} onClick={() => onAiPractice(kp.id)}>{t('aiPractice')}</Button>
            </Tooltip>
            <Dropdown trigger={['click']} menu={{ onClick: ({ key }) => onAiTool(key), items: aiToolItems }}>
              <Button size="small" icon={<BulbOutlined />}>
                {t('aiTools')} <DownOutlined />
              </Button>
            </Dropdown>
          </>
        )}
        {isStudent && (
          <>
            {kp.progress_status !== 'completed' && (
              <Button type="primary" size="small" icon={<CheckCircleOutlined />} onClick={() => onProgress(kp.id, 'completed')}>
                {t('cyMarkDone')}
              </Button>
            )}
            {kp.progress_status === 'not_started' && (
              <Button size="small" icon={<ClockCircleOutlined />} onClick={() => onProgress(kp.id, 'in_progress')}>
                {t('cyStartLearn')}
              </Button>
            )}
          </>
        )}
      </Space>

      {/* ── 说明 / 学习目标（统一带标签，层级一致） ── */}
      {kp.description && (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={fieldLabelStyle}>{t('kpDescription')}</Typography.Text>
          <Typography.Paragraph style={{ marginBottom: 0 }}>{kp.description}</Typography.Paragraph>
        </div>
      )}
      {kp.learning_objectives && (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={fieldLabelStyle}>{t('learningObjectives')}</Typography.Text>
          <Typography.Paragraph style={{ marginBottom: 0 }}>{kp.learning_objectives}</Typography.Paragraph>
        </div>
      )}

      {/* ── 元信息标签 ── */}
      <Space wrap size={6}>
        <Tag color={DIFFICULTY_COLORS[kp.difficulty]}>{t(DIFFICULTY_LABELS[kp.difficulty]) || kp.difficulty}</Tag>
        {kp.estimated_minutes > 0 && (
          <Tag icon={<ClockCircleOutlined />}>{t('kpMinutes', { minutes: kp.estimated_minutes })}</Tag>
        )}
        {isStudent && kp.progress_status && (
          <Tag color={STATUS_COLORS[kp.progress_status]}>{t(STATUS_LABELS[kp.progress_status])}</Tag>
        )}
      </Space>

      {/* ── 关联资源 ── */}
      <Typography.Title level={5} style={{ marginTop: 16, marginBottom: 8 }}>
        {t('relatedResources')}
        {resources.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400, marginInlineStart: 8 }}>
            {t('kpRelatedCount', { count: resources.length })}
          </Typography.Text>
        )}
      </Typography.Title>

      {resources.length === 0 ? (
        isTeacherOrAdmin ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('kpNoResources')} style={{ margin: '8px 0' }}>
            <Button type="primary" ghost size="small" icon={<PlusOutlined />} onClick={onManageBindings}>
              {t('manageBindResources')}
            </Button>
          </Empty>
        ) : (
          <Typography.Text type="secondary">{t('noRelatedResources')}</Typography.Text>
        )
      ) : (
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          {shownResources.map((r, idx) => (
            <KpResourceCard
              key={r.binding_id}
              resource={r}
              isTeacherOrAdmin={isTeacherOrAdmin}
              isStudent={isStudent}
              onOpen={openResource}
              onUnbind={unbindResource}
              onMove={moveResource}
              canMoveUp={idx > 0}
              canMoveDown={idx < resources.length - 1}
              moving={movingId === r.binding_id}
              onResetSuccess={onResourcesChanged}
            />
          ))}
          {isTeacherOrAdmin && resources.length > RES_COLLAPSE_AT && (
            <Button
              type="link" block size="small"
              style={{ padding: 0, height: 'auto' }}
              onClick={() => setResExpanded((v) => !v)}
            >
              {resExpanded
                ? t('kpResCollapse')
                : t('kpResExpand', { shown: RES_COLLAPSE_AT, count: resources.length })}
            </Button>
          )}
        </Space>
      )}

      {isTeacherOrAdmin && resources.length > 0 && (
        <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 12 }} onClick={onManageBindings}>
          {t('manageBindResources')}
        </Button>
      )}
    </>
  )

  if (variant === 'plain') return <>{body}</>

  return (
    <Card
      title={
        <Space size={6}>
          <NodeIndexOutlined />
          <span title={kp.name}>{kp.name}</span>
        </Space>
      }
      loading={loading}
      extra={
        <Tooltip title={t('close')}>
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
      }
    >
      {body}
    </Card>
  )
}

export default KpDetailPanel