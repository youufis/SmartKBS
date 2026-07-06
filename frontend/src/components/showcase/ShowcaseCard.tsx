import React, { useState, useCallback } from 'react'
import { Tag, Tooltip, Popover, message } from 'antd'
import { EyeOutlined, BgColorsOutlined } from '@ant-design/icons'
import { updateShowcaseTheme } from '../../api/showcase'
import { useAuthStore } from '../../stores/authStore'
import type { ShowcaseCard as ShowcaseCardType } from '../../api/showcase'
import LikeButton from './LikeButton'

interface Props {
  card: ShowcaseCardType;
  onLikeChange: (id: number, liked: boolean, count: number) => void;
  onClick?: (card: ShowcaseCardType) => void;
  /** 主题变化回调（用于父组件同步更新 card.theme_style） */
  onThemeChange?: (id: number, newTheme: string) => void;
}

const COLOR_MAP: Record<string, string> = {
  lime: '#a0d911', green: '#52c41a', cyan: '#13c2c2',
  blue: '#1677ff', geekblue: '#2f54eb', purple: '#722ed1',
  magenta: '#eb2f96', gold: '#faad14', orange: '#fa8c16',
  volcano: '#fa541c', red: '#f5222d', default: '#d9d9d9',
}

const SUBJECT_EMOJI_MAP: Record<string, string> = {
  信息科技: '💻', 通用技术: '🔧', 人工智能: '🤖',
  信息技术: '💻', 数学: '📐', 语文: '📖', 英语: '🌍',
  物理: '⚛️', 化学: '🧪', 生物: '🧬', 历史: '📜',
  地理: '🌏', 政治: '⚖️',
}
const FALLBACK_EMOJIS = ['📚', '🔬', '🎨', '🎵', '🏛️', '🧮', '🗺️', '🔭', '⚗️', '🖥️']

const THEME_DOTS = [
  { key: 'golden',  color: '#faad14' },
  { key: 'ocean',   color: '#1677ff' },
  { key: 'forest',  color: '#52c41a' },
  { key: 'cherry',  color: '#eb2f96' },
  { key: 'aurora',  color: '#722ed1' },
  { key: 'gunset',  color: '#fa8c16' },
  { key: 'cosmic',  color: '#1a1a2e' },
  { key: 'mint',    color: '#13c2c2' },
  { key: 'flame',   color: '#f5222d' },
  { key: 'minimal', color: '#8c8c8c' },
]

function getSubjectEmoji(subject: string): string {
  if (SUBJECT_EMOJI_MAP[subject]) return SUBJECT_EMOJI_MAP[subject]
  const hash = subject.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return FALLBACK_EMOJIS[hash % FALLBACK_EMOJIS.length]
}

/** 根据积分计算星级（最多 5 星） */
function getStars(points: number): { filled: number; total: number } {
  if (points >= 800) return { filled: 5, total: 5 }
  if (points >= 400) return { filled: 4, total: 5 }
  if (points >= 200) return { filled: 3, total: 5 }
  if (points >= 80) return { filled: 2, total: 5 }
  return { filled: 1, total: 5 }
}

const ShowcaseCard: React.FC<Props> = ({ card, onLikeChange, onClick, onThemeChange }) => {
  const user = useAuthStore((s) => s.user)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [localTheme, setLocalTheme] = useState(card.theme_style || 'golden')

  const { snapshot_data } = card
  if (!snapshot_data) return null

  const { main_title, progress, subject_titles, badges, total_points } = snapshot_data
  const themeClass = localTheme
  const stars = getStars(total_points)
  const unlockedBadges = badges.filter((b) => b.unlocked)

  const isOwnerOrTeacher = user?.username === card.student_username
    || user?.role === 'admin' || user?.role === 'teacher'

  const handleLikeChange = (liked: boolean, count: number) => {
    onLikeChange(card.id, liked, count)
  }

  const handleThemeSelect = useCallback(async (key: string) => {
    if (key === localTheme) { setPopoverOpen(false); return }
    try {
      await updateShowcaseTheme(card.id, key)
      setLocalTheme(key)
      onThemeChange?.(card.id, key)
      message.success('主题已更新')
    } catch {
      message.error('主题更新失败')
    }
    setPopoverOpen(false)
  }, [card.id, localTheme, onThemeChange])

  const themeContent = (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', width: 220 }}>
      {THEME_DOTS.map((t) => (
        <Tooltip key={t.key} title={t.key}>
          <div
            onClick={() => handleThemeSelect(t.key)}
            style={{
              width: 32, height: 32, borderRadius: 8, cursor: 'pointer',
              background: t.color,
              border: t.key === localTheme ? '3px solid #fff' : '1px solid rgba(0,0,0,0.08)',
              boxShadow: t.key === localTheme
                ? `0 0 0 2px ${t.color}`
                : '0 1px 3px rgba(0,0,0,0.1)',
              transition: 'all 0.15s ease',
            }}
          />
        </Tooltip>
      ))}
    </div>
  )

  return (
    <div
      className={`showcase-card theme-${themeClass}`}
      onClick={() => onClick?.(card)}
      style={{ cursor: onClick ? 'pointer' : 'default', position: 'relative' }}
    >
      {/* 主题切换按钮（仅主人/教师可见） */}
      {isOwnerOrTeacher && (
        <Popover
          content={themeContent}
          title="选择卡片主题"
          trigger="click"
          open={popoverOpen}
          onOpenChange={setPopoverOpen}
          placement="bottomRight"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', top: 8, right: 8, zIndex: 2,
              width: 28, height: 28, borderRadius: 8,
              background: 'rgba(255,255,255,0.85)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', fontSize: 14,
              boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
            }}
          >
            <BgColorsOutlined />
          </div>
        </Popover>
      )}

      {/* 称号横幅 */}
      <div className="showcase-card-banner">
        <span className="banner-emoji">{main_title.emoji}</span>
        Lv.{main_title.level} {main_title.name}
        <span className="banner-level"> · {main_title.desc}</span>
      </div>

      {/* 学生信息 */}
      <div className="showcase-card-body">
        <div className="showcase-card-header">
          <div className="student-name">{card.student_name}</div>
          <div className="student-class">{card.grade} · {card.class_name || card.snapshot_data?.student_info?.class}</div>
        </div>

        {/* 积分星级 */}
        <div className="showcase-points">
          <div className="stars">
            {'⭐'.repeat(stars.filled)}
            {'☆'.repeat(stars.total - stars.filled)}
          </div>
          <div className="points-number">{total_points.toLocaleString()}</div>
          <div className="points-label">总积分</div>
        </div>

        {/* 下一级进度条 */}
        {progress?.next && (
          <div className="showcase-progress">
            <div className="progress-label">
              下一级：{progress.next.emoji} {progress.next.name}
            </div>
            <div className="progress-track">
              <div
                className="progress-bar"
                style={{ width: `${Math.min(progress.progress_percent, 100)}%` }}
              />
            </div>
            <div className="progress-text">还需 {progress.points_needed} 分升级</div>
          </div>
        )}

        {/* 徽章墙 */}
        {unlockedBadges.length > 0 && (
          <div className="showcase-badges">
            {unlockedBadges.slice(0, 8).map((b) => (
              <Tooltip key={b.badge_id} title={b.name}>
                <span className="showcase-badge glowing">{b.icon}</span>
              </Tooltip>
            ))}
            {unlockedBadges.length > 8 && (
              <Tooltip title={`还有 ${unlockedBadges.length - 8} 枚徽章`}>
                <span className="showcase-badge" style={{ fontSize: 12, fontWeight: 600 }}>+{unlockedBadges.length - 8}</span>
              </Tooltip>
            )}
          </div>
        )}

        {/* 学科称号 */}
        {subject_titles && subject_titles.length > 0 && (
          <div className="showcase-subject-titles">
            {subject_titles.slice(0, 4).map((st) => (
              <span key={st.subject} className="showcase-subject-tag">
                {getSubjectEmoji(st.subject)} {st.name}
              </span>
            ))}
          </div>
        )}

        {/* 互动栏 */}
        <div className="showcase-card-footer">
          <LikeButton
            showcaseId={card.id}
            liked={card.liked}
            count={card.like_count}
            onLikeChange={handleLikeChange}
          />
          <span className="showcase-stat">
            <EyeOutlined /> {card.view_count}
          </span>
        </div>
      </div>
    </div>
  )
}

export default ShowcaseCard
