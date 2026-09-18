/**
 * 积分模块：活动类型 / 奖励类型 名称的本地化
 *
 * 后端在 `activity_type`、`reward_type` 之外还会附带 `activity_type_name`、`reward_type_name`
 * （`backend/reward_engine.py` 里写死的中文名，通知、导出、日志仍在使用）。
 * 界面语言由前端决定，所以这里一律先用**键名**查前端词典，三级回退：
 *   词典命中 -> 按界面语言显示；词典缺项 -> 回退后端中文名；连中文名也没有 -> 回退原始键名。
 * 这样任何新增类型都不会把 `reward.activityType.xxx` 这种键名漏到界面上。
 *
 * 词典位置：`locales/{zh-CN,en}/score.json` 的 `reward.activityType.*` / `reward.rewardType.*`
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

/** 奖励类型 -> Tag 配色（学生明细、积分管理、成长档案共用，避免三处各写一份） */
export const REWARD_TAG_COLORS: Record<string, string> = {
  participation: 'default',
  excellent: 'success',
  good: 'processing',
  pass: 'warning',
  penalty: 'error',
  refund: 'blue',
}

export function useRewardLabels() {
  const { t } = useTranslation('score')

  /** 活动类型名，如 quiz -> 随堂测验 / In-class Quiz */
  const actLabel = useCallback(
    (type?: string, backendName?: string) => {
      if (!type) return backendName || ''
      return t(`reward.activityType.${type}`, { defaultValue: '' }) || backendName || type
    },
    [t],
  )

  /** 奖励类型名，如 excellent -> 优秀奖励 / Excellent Bonus */
  const rewardTypeLabel = useCallback(
    (type?: string, backendName?: string) => {
      if (!type) return backendName || ''
      return t(`reward.rewardType.${type}`, { defaultValue: '' }) || backendName || type
    },
    [t],
  )

  return { actLabel, rewardTypeLabel }
}
