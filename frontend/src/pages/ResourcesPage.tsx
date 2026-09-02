import React from 'react'
import { Layout, Card } from 'antd'
import { useTranslation } from 'react-i18next'

const ResourcesPage: React.FC = () => {
  const { t } = useTranslation('menu')
  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Card title={`📚 ${t('resourceCenter')}`} size="small" styles={{ body: { padding: 0 } }}>
        <iframe
          src="/api/resources/nav"
          style={{ width: '100%', height: 'calc(100vh - 200px)', border: 'none', minHeight: 500 }}
          title="Nav"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </Card>
    </Layout>
  )
}

export default ResourcesPage
