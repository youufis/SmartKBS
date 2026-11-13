/** message/notification/Modal 静态调用统一出口：委托 App.useApp() 实例（跟随主题），挂载前兜底 antd 静态 */
import { message as staticMessage, notification as staticNotification, Modal as StaticModal } from 'antd'

type MessageInstance = typeof staticMessage
type NotificationInstance = typeof staticNotification
type ModalApi = Omit<typeof StaticModal, 'warn'>

let messageHolder: MessageInstance = staticMessage
let notificationHolder: NotificationInstance = staticNotification
let modalHolder: ModalApi = StaticModal

export function bindFeedbackApis(m: MessageInstance, n: NotificationInstance, md: ModalApi) {
  messageHolder = m
  notificationHolder = n
  modalHolder = md
}

export function unbindFeedbackApis() {
  messageHolder = staticMessage
  notificationHolder = staticNotification
  modalHolder = StaticModal
}

function proxy<T extends object>(get: () => T): T {
  return new Proxy({} as T, { get: (_t, key) => (get() as Record<string | symbol, unknown>)[key] }) as T
}

export const message: MessageInstance = proxy(() => messageHolder)
export const notification: NotificationInstance = proxy(() => notificationHolder)
export const modalApi: ModalApi = proxy(() => modalHolder)
