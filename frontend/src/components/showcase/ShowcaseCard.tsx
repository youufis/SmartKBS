import { useTranslation } from 'react-i18next'
import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Tag, Tooltip, Popover, Popconfirm, message } from 'antd'
import { EyeOutlined, BgColorsOutlined, EyeInvisibleOutlined } from '@ant-design/icons'
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
  /** 教师上/下架回调（true=重新上架）；不传则不显示该按钮 */
  onManage?: (card: ShowcaseCardType, activate: boolean) => void;
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
  // S3: 旧键 gunset 是 sunset 的拼写错误（CSS 里只有 .theme-sunset，于是这套主题点了没反应）
  { key: 'sunset',  color: '#fa8c16' },
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

/** 根据积分计算星级（最多 5 星）。
 *  断点跟的是主称号阶梯（backend/title_system.DEFAULT_TITLE_CONFIG，2026-10 重标定）：
 *  5★=Lv10(600) / 4★=Lv8(330) / 3★=Lv6(170) / 2★=Lv4(60)。
 *  旧断点 800/400/200/80 是随手写的第二份标准，改称号阈值时没人记得同步这里。 */
function getStars(points: number): { filled: number; total: number } {
  if (points >= 600) return { filled: 5, total: 5 }
  if (points >= 330) return { filled: 4, total: 5 }
  if (points >= 170) return { filled: 3, total: 5 }
  if (points >= 60) return { filled: 2, total: 5 }
  return { filled: 1, total: 5 }
}

const ShowcaseCard: React.FC<Props> = ({ card, onLikeChange, onClick, onThemeChange, onManage }) => {
  const { t } = useTranslation('dashboard')
  const user = useAuthStore((s) => s.user)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [localTheme, setLocalTheme] = useState(card.theme_style || 'golden')
  // S3: 积分数字滚动（尊重系统"减弱动态效果"）
  const [shownPoints, setShownPoints] = useState(0)
  const rafRef = useRef<number | null>(null)

  // S3: 数字滚动动画（1 秒内滚到目标值；系统开启"减弱动态效果"时直接落定）
  // 注意：钩子必须写在任何提前 return 之前，否则快照缺失时钩子顺序会变。
  const targetPoints = Number(card.snapshot_data?.total_points) || 0
  useEffect(() => {
    const target = targetPoints
    const reduce = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) { setShownPoints(target); return }
    const from = 0
    const start = performance.now()
    const dur = 900
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur)
      const eased = 1 - Math.pow(1 - p, 3)
      setShownPoints(Math.round(from + (target - from) * eased))
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [targetPoints])

  const { snapshot_data } = card
  if (!snapshot_data) return null

  const { main_title, progress, total_points } = snapshot_data
  // S1: 自动建卡的"最小快照"里徽章/学科称号是空数组，装饰性数据由 live 覆盖补齐；
  //     这里仍做兜底，避免任一缺失把整块卡片打崩。
  const badges = snapshot_data.badges || []
  const subject_titles = snapshot_data.subject_titles || []
  const themeClass = localTheme
  const stars = getStars(total_points)
  const unlockedBadges = badges.filter((b) => b.unlocked)

  /** S2: 名次是否展示由服务端一处决定（低分保护）；这里只负责呈现 */
  const showRank = card.rank_show && card.class_rank
  const rankTier = card.class_rank === 1 ? 'gold'
    : card.class_rank === 2 ? 'silver'
    : card.class_rank === 3 ? 'bronze' : 'plain'
  const nextBadge = badges.find((b) => !b.unlocked)

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
      message.success(t('scThemeUpdated'))
    } catch {
      message.error(t('scThemeUpdateFailed'))
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
      {/* S2: 已下架的卡片（教师勾选「显示已下架」时可见）—— 压暗 + 角标，避免误以为还在墙上 */}
      {card.is_active === false && (
        <div className="showcase-inactive-mask">
          <Tag color="default">{t('scTookDownTag')}</Tag>
        </div>
      )}

      {/* 教师上/下架（明确的单一动作，取代原先的「生成展示卡」批量弹窗） */}
      {onManage && user?.role !== 'student' && (
        <Popconfirm
          title={card.is_active === false ? t('scBringBackConfirm') : t('scTakeDownConfirm')}
          okText={t('confirm')}
          cancelText={t('cancel')}
          onConfirm={() => onManage(card, card.is_active === false)}
        >
          <div
            className="showcase-manage-btn"
            onClick={(e) => e.stopPropagation()}
            title={card.is_active === false ? t('scBringBack') : t('scTakeDown')}
          >
            <EyeInvisibleOutlined />
          </div>
        </Popconfirm>
      )}

      {/* 主题切换按钮（仅主人/教师可见） */}
      {isOwnerOrTeacher && (
        <Popover
          content={themeContent}
          title={t('scPickTheme')}
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
        {/* S2: 名次徽章 —— 只给"值得炫耀"的名次（服务端按策略下发 rank_show） */}
        {showRank ? (
          <span className={`showcase-rank rank-${rankTier}`}>
            {rankTier === 'gold' ? '🥇' : rankTier === 'silver' ? '🥈' : rankTier === 'bronze' ? '🥉' : '🏅'}
            {t('scClassRank', { rank: card.class_rank })}
          </span>
        ) : (Number(card.week_gain || 0) > 0 && (
          <span className="showcase-rank rank-plain">
            {t('scWeekGain', { count: card.week_gain })}
          </span>
        ))}
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
          <div className="points-number">{shownPoints.toLocaleString()}</div>
          <div className="points-label">{t('scTotalPoints')}</div>
          {/* S2: 全校名次（同样受名次策略约束） */}
          {showRank && card.school_rank ? (
            <div className="points-sub">{t('scSchoolRank', { rank: card.school_rank })}</div>
          ) : null}
        </div>

        {/* 下一级进度条 */}
        {progress?.next && (
          <div className="showcase-progress">
            <div className="progress-label">
              {t('scNextLevel')}：{progress.next.emoji} {progress.next.name}
            </div>
            <div className="progress-track">
              <div
                className="progress-bar"
                style={{ width: `${Math.min(progress.progress_percent, 100)}%` }}
              />
            </div>
            <div className="progress-text">{t('scNeedPointsUp', { count: progress.points_needed })}</div>
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
              <Tooltip title={t('scMoreBadges', { count: unlockedBadges.length - 8 })}>
                <span className="showcase-badge" style={{ fontSize: 12, fontWeight: 600 }}>+{unlockedBadges.length - 8}</span>
              </Tooltip>
            )}
          </div>
        )}

        {/* S3: 徽章激励闭环 —— 展示"下一枚即将解锁的徽章"，把静态展示变成想看下一步 */}
        {nextBadge && (
          <div className="showcase-next-badge">
            <span className="next-badge-icon">{nextBadge.icon || '🎖️'}</span>
            {t('scNextBadge', { name: nextBadge.name })}
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
