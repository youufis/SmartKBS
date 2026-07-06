import React, { useCallback, useRef } from 'react'
import { HeartOutlined, HeartFilled } from '@ant-design/icons'
import { message } from 'antd'
import { toggleLike } from '../../api/showcase'
import { useAuthStore } from '../../stores/authStore'

interface Props {
  showcaseId: number;
  liked: boolean;
  count: number;
  onLikeChange: (liked: boolean, count: number) => void;
}

const PARTICLE_EMOJIS = ['❤️', '⭐', '✨', '💫', '🌟', '🎉']

const LikeButton: React.FC<Props> = ({ showcaseId, liked, count, onLikeChange }) => {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn)
  const btnRef = useRef<HTMLButtonElement>(null)

  const spawnParticles = useCallback((x: number, y: number) => {
    const container = document.body
    for (let i = 0; i < 8; i++) {
      const el = document.createElement('div')
      el.className = 'like-particle'
      el.textContent = PARTICLE_EMOJIS[Math.floor(Math.random() * PARTICLE_EMOJIS.length)]
      const angle = (Math.PI * 2 * i) / 8
      const dist = 40 + Math.random() * 30
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.style.setProperty('--dx', `${Math.cos(angle) * dist}px`)
      el.style.setProperty('--dy', `${Math.sin(angle) * dist}px`)
      container.appendChild(el)
      setTimeout(() => el.remove(), 700)
    }
  }, [])

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!isLoggedIn) {
      message.warning('请先登录')
      return
    }
    try {
      const res = await toggleLike(showcaseId)
      onLikeChange(res.action === 'liked', res.count)
      if (res.action === 'liked' && btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect()
        spawnParticles(rect.left + rect.width / 2, rect.top + rect.height / 2)
      }
    } catch {
      message.error('操作失败')
    }
  }, [showcaseId, isLoggedIn, onLikeChange, spawnParticles])

  return (
    <button
      ref={btnRef}
      className={`like-btn ${liked ? 'liked' : ''}`}
      onClick={handleClick}
    >
      {liked ? <HeartFilled /> : <HeartOutlined />}
      <span>{count}</span>
    </button>
  )
}

export default LikeButton
