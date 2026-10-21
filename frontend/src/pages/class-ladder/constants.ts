/** 皮肤 / 音效 / 播报偏好记本地（与页面其它偏好分开记） */
export const SKIN_PREF_KEY = 'class_ladder_skin'
export const SOUND_PREF_KEY = 'class_ladder_sound_on'

/** 每套皮肤的强调色 a2（与 ladder.css 的 --cl-a2 对齐），用作局部主题主色 */
export const SKIN_ACCENT: Record<string, string> = {
  star: '#4fc3f7', cyber: '#ff2d95', academy: '#4a90ff', classic: '#e0a800',
  cloud: '#2f6bff', sunrise: '#e8590c', mint: '#0b7285',
}

/** 锦囊 i18n 键（含大屏新增的现场表决 / 请军师） */
export const LF_I18N: Record<string, string> = {
  remove_one: 'lifelineRemoveOne', phone_friend: 'lifelinePhoneFriend',
  audience_vote: 'lifelineAudienceVote', class_vote: 'lifelineClassVote', helper: 'lifelineHelper',
}

/** 锦囊图标 */
export const LF_ICON: Record<string, string> = {
  remove_one: '🎯', phone_friend: '📞', audience_vote: '👥', class_vote: '🙋', helper: '🤝',
}

/** 通关彩带颜色 */
export const CONFETTI_COLORS = ['#ffd54f', '#4fc3f7', '#7c4dff', '#52c41a', '#ff8a80', '#ffe9a8']
