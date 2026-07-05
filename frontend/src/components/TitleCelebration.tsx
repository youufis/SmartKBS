/**
 * 称号升级/徽章解锁庆祝弹窗组件
 * 在 AppLayout 中使用，定期检查新通知并弹出庆祝动画
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Modal, Button, Space, Typography, message } from 'antd'
import {
  TrophyOutlined, GiftOutlined, FireOutlined,
  CheckCircleFilled,
} from '@ant-design/icons'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

const { Title, Text } = Typography

interface CelebrationEvent {
  type: 'title_upgrade' | 'badge_unlock'
  title: string
  content: string
  id: number
}

// ── 彩花 CSS 动画 ──
const confettiStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: '100%',
  height: '100%',
  pointerEvents: 'none',
  zIndex: 9999,
  overflow: 'hidden',
}

const particleColors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff6b9d', '#c084fc']

const ConfettiParticle: React.FC<{ index: number }> = ({ index }) => {
  const left = Math.random() * 100
  const delay = Math.random() * 2
  const duration = 2 + Math.random() * 3
  const color = particleColors[index % particleColors.length]
  const size = 6 + Math.random() * 8

  return (
    <div
      style={{
        position: 'absolute',
        left: `${left}%`,
        top: -20,
        width: size,
        height: size * 1.5,
        background: color,
        borderRadius: Math.random() > 0.5 ? '50%' : '2px',
        animation: `titleConfettiFall ${duration}s ease-in ${delay}s infinite`,
        opacity: 0.8,
      }}
    />
  )
}

const Confetti: React.FC = () => (
  <div style={confettiStyle}>
    <style>{`
      @keyframes titleConfettiFall {
        0% { transform: translateY(-20px) rotate(0deg); opacity: 1; }
        100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
      }
    `}</style>
    {Array.from({ length: 30 }).map((_, i) => (
      <ConfettiParticle key={i} index={i} />
    ))}
  </div>
)

const TitleCelebration: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isStudent = user?.role === 'student'
  const lastCheckedRef = useRef<string>(new Date().toISOString())
  const [event, setEvent] = useState<CelebrationEvent | null>(null)
  const [showConfetti, setShowConfetti] = useState(false)

  // 检查新通知
  const checkNotifications = useCallback(async () => {
    if (!isStudent) return
    try {
      const { data } = await apiClient.get('/api/notifications', {
        params: { unread_only: true, page_size: 5 },
      })
      const notifications = data?.notifications || []
      for (const n of notifications) {
        if (n.type === 'title_upgrade' || n.type === 'badge_unlock') {
          // 只处理上次检查之后的通知
          if (n.created_at > lastCheckedRef.current || !lastCheckedRef.current) {
            setEvent({
              type: n.type,
              title: n.title || '',
              content: n.content || '',
              id: n.id,
            })
            setShowConfetti(true)
            lastCheckedRef.current = new Date().toISOString()

            // 标记为已读
            apiClient.put(`/api/notifications/${n.id}/read`).catch(() => {})
            break // 一次只弹一个
          }
        }
      }
    } catch {
      // 忽略
    }
  }, [isStudent])

  // 定期轮询（每 30 秒）
  useEffect(() => {
    if (!isStudent) return
    // 首次延迟 5 秒后再检查，给页面加载时间
    const initialTimer = setTimeout(() => {
      checkNotifications()
    }, 5000)

    const interval = setInterval(checkNotifications, 30000)
    return () => {
      clearTimeout(initialTimer)
      clearInterval(interval)
    }
  }, [isStudent, checkNotifications])

  // 关闭弹窗
  const handleClose = () => {
    setEvent(null)
    setShowConfetti(false)
  }

  // 不再有事件时不渲染
  if (!event) return null

  const isTitle = event.type === 'title_upgrade'
  const emoji = isTitle ? '🏆' : '🏅'
  const gradient = isTitle
    ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
    : 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)'

  return (
    <>
      {showConfetti && <Confetti />}
      <Modal
        open={!!event}
        onCancel={handleClose}
        footer={null}
        width={420}
        centered
        closable={false}
        mask={{ closable: true }}
      >
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          {/* 大图标 */}
          <div style={{
            fontSize: 72,
            animation: 'titleCelebrateBounce 1s ease-in-out infinite',
            marginBottom: 16,
          }}>
            {emoji}
          </div>
          <style>{`
            @keyframes titleCelebrateBounce {
              0%, 100% { transform: scale(1); }
              50% { transform: scale(1.15); }
            }
            @keyframes titleCelebrateGlow {
              0%, 100% { box-shadow: 0 0 20px rgba(102,126,234,0.3); }
              50% { box-shadow: 0 0 40px rgba(102,126,234,0.6); }
            }
          `}</style>

          {/* 标题 */}
          <Title level={3} style={{ margin: '8px 0', background: gradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            🎉 恭喜获得新{isTitle ? '称号' : '徽章'}！
          </Title>

          {/* 名称 */}
          <div style={{
            display: 'inline-block',
            padding: '8px 24px',
            borderRadius: 20,
            background: gradient,
            color: '#fff',
            fontSize: 18,
            fontWeight: 600,
            margin: '12px 0',
            animation: 'titleCelebrateGlow 2s ease-in-out infinite',
          }}>
            {event.title.replace(/[🏆🏅🎉]/g, '').trim() || event.title}
          </div>

          {/* 描述 */}
          <div style={{
            background: '#f5f5f5',
            borderRadius: 12,
            padding: '12px 16px',
            margin: '12px 0',
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
          }}>
            <Text type="secondary">{event.content}</Text>
          </div>

          {/* 按钮 */}
          <Button type="primary" size="large" onClick={handleClose}
            style={{ borderRadius: 20, paddingLeft: 32, paddingRight: 32, marginTop: 8 }}>
            <CheckCircleFilled /> 太棒了！
          </Button>
        </div>
      </Modal>
    </>
  )
}

export default TitleCelebration
