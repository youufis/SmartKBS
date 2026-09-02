import { useTranslation } from 'react-i18next'
import React from 'react'
import { Modal, Tag, Typography, Divider, Descriptions } from 'antd'
import { EyeOutlined } from '@ant-design/icons'
import type { ShowcaseCard } from '../../api/showcase'
import LikeButton from './LikeButton'

const { Text } = Typography

const COLOR_MAP: Record<string, string> = {
  lime: '#a0d911', green: '#52c41a', cyan: '#13c2c2',
  blue: '#1677ff', geekblue: '#2f54eb', purple: '#722ed1',
  magenta: '#eb2f96', gold: '#faad14', orange: '#fa8c16',
  volcano: '#fa541c', red: '#f5222d', default: '#d9d9d9',
}

interface Props {
  card: ShowcaseCard | null;
  open: boolean;
  onClose: () => void;
  onLikeChange: (id: number, liked: boolean, count: number) => void;
}

const ShowcasePreviewModal: React.FC<Props> = ({ card, open, onClose, onLikeChange }) => {
  const { t } = useTranslation('dashboard')
  if (!card) return null
  const { snapshot_data } = card
  if (!snapshot_data) return null

  const { main_title, progress, subject_titles, badges, total_points } = snapshot_data
  const color = COLOR_MAP[main_title.color] || '#d9d9d9'
  const unlockedBadges = badges.filter((b) => b.unlocked)

  return (
    <Modal
      title={
        <span style={{ fontSize: 18 }}>
          {main_title.emoji} {card.student_name} · {t('scHonorArchive')}
        </span>
      }
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
    >
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <Tag color={main_title.color !== 'default' ? main_title.color : undefined}
          style={{ fontSize: 16, padding: '4px 16px', borderRadius: 12 }}>
          Lv.{main_title.level} {main_title.emoji} {main_title.name}
        </Tag>
        <div style={{ marginTop: 4, color: '#888', fontSize: 13 }}>
          {card.grade} · {card.class_name || card.snapshot_data?.student_info?.class}
        </div>
      </div>

      <Descriptions column={2} size="small" bordered>
        <Descriptions.Item label={t('scTotalPoints')} span={2}>
          <span style={{ fontSize: 24, fontWeight: 700, color }}>{total_points.toLocaleString()}</span>
          <span style={{ marginLeft: 8, color: '#999' }}>{t('scPointsUnit')}</span>
        </Descriptions.Item>
        {progress?.next && (
          <Descriptions.Item label={t('scNextLevel')} span={2}>
            {progress.next.emoji} {progress.next.name}{t('scNeedPoints', { count: progress.points_needed })}
          </Descriptions.Item>
        )}
        <Descriptions.Item label={t('scBadges')} span={2}>
          {unlockedBadges.length > 0 ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {unlockedBadges.map((b) => (
                <Tag key={b.badge_id} style={{ fontSize: 13, padding: '2px 8px' }}>
                  {b.icon} {b.name}
                </Tag>
              ))}
            </div>
          ) : (
            <Text type="secondary">{t('scNone')}</Text>
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('scSubjectTitles')} span={2}>
          {subject_titles?.length > 0 ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {subject_titles.map((st) => (
                <Tag key={st.subject} color={st.color !== 'default' ? st.color : undefined}>
                  {st.emoji || '📚'} Lv.{st.level} {st.name}
                </Tag>
              ))}
            </div>
          ) : (
            <Text type="secondary">{t('scNone')}</Text>
          )}
        </Descriptions.Item>
      </Descriptions>

      <Divider />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <LikeButton
          showcaseId={card.id}
          liked={card.liked}
          count={card.like_count}
          onLikeChange={(liked, count) => onLikeChange(card.id, liked, count)}
        />
        <span style={{ color: '#888' }}>
          <EyeOutlined style={{ marginRight: 4 }} />
          {t('scViews', { count: card.view_count })}
        </span>
      </div>
    </Modal>
  )
}

export default ShowcasePreviewModal
