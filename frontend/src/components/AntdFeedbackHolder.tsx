import React, { useEffect } from 'react'
import { App } from 'antd'
import { bindFeedbackApis, unbindFeedbackApis } from '../utils/feedback'

/** 把 App.useApp() 实例注入 feedback 代理：静态调用点（message.error / Modal.confirm 等）随之跟随主题 */
const AntdFeedbackHolder: React.FC = () => {
  const { message, notification, modal } = App.useApp()
  useEffect(() => {
    bindFeedbackApis(message, notification, modal)
    return unbindFeedbackApis
  }, [message, notification, modal])
  return null
}

export default AntdFeedbackHolder
