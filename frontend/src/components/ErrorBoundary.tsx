import i18n from '../i18n'
import React from 'react'
import { Button, Result } from 'antd'

interface Props {
  children: React.ReactNode
  fallback?: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * 全局错误边界组件
 * 捕获子组件树中任何未处理的渲染异常，防止整个 SPA 白屏
 */
class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] 捕获到渲染异常:', error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          background: '#f5f5f5',
          padding: 24,
        }}>
          <Result
            status="error"
            title={i18n.t('common:ebTitle')}
            subTitle={
              <span style={{ color: '#999', fontSize: 13 }}>
                {i18n.t('common:ebDesc')}
                {this.state.error && (
                  <details style={{ marginTop: 8, textAlign: 'left', maxWidth: 500 }}>
                    <summary style={{ cursor: 'pointer', color: '#1677ff' }}>{i18n.t('common:ebDetails')}</summary>
                    <pre style={{
                      fontSize: 12,
                      color: '#ff4d4f',
                      background: '#fff2f0',
                      padding: 8,
                      borderRadius: 4,
                      marginTop: 4,
                      overflow: 'auto',
                      maxHeight: 200,
                    }}>
                      {this.state.error.message}
                      {'\n'}
                      {this.state.error.stack}
                    </pre>
                  </details>
                )}
              </span>
            }
            extra={[
              <Button key="retry" type="primary" onClick={this.handleReset}>
                {i18n.t('common:ebRetry')}
              </Button>,
              <Button key="reload" onClick={this.handleReload}>
                {i18n.t('common:ebRefresh')}
              </Button>,
            ]}
          />
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
