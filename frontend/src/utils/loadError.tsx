/**
 * 主数据加载失败的统一出口（B7）。
 *
 * 页面里大量 `catch { /* ignore *\/ }` 的问题不是「不该静默」，而是**用户看不出为什么是空的**：
 * 网络抖一下、接口 500，列表就永久空白，只能靠刷新碰运气。
 * 这里给一个带节流的重试提示：同一个位置 60 秒内只提示一次，避免轮询页面刷屏。
 *
 * 次要数据（下拉选项、埋点、剪贴板降级、localStorage 隐私模式）继续静默，
 * 但建议改成 swallowLoadError() 留一行 console.warn，排查时不至于毫无线索。
 */
import { Button, notification } from 'antd'
import i18n from '../i18n'

const THROTTLE_MS = 60_000
const lastShown = new Map<string, number>()

function detailOf(err: unknown): string {
  const anyErr = err as { response?: { data?: { detail?: string } }; message?: string }
  return anyErr?.response?.data?.detail || anyErr?.message || i18n.t('common:loadFailedDesc')
}

/** 主数据加载失败：提示 + 重试按钮（同 key 60 秒内只弹一次） */
export function reportLoadError(err: unknown, opts: { key: string; retry?: () => void }): void {
  const now = Date.now()
  const prev = lastShown.get(opts.key) || 0
  if (now - prev < THROTTLE_MS) return
  lastShown.set(opts.key, now)
  notification.error({
    key: `load-${opts.key}`,
    message: i18n.t('common:loadFailedTitle'),
    description: detailOf(err),
    duration: 6,
    btn: opts.retry ? (
      <Button size="small" type="primary" onClick={opts.retry}>
        {i18n.t('common:retryLoad')}
      </Button>
    ) : undefined,
  })
}

/** 次要数据失败：不打扰用户，但留一行日志线索 */
export function swallowLoadError(what: string, err?: unknown): void {
  console.warn(`[load] ${what} 失败（已忽略）`, err)
}
