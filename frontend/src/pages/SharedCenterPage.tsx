import React from 'react'
import { Tabs, Card } from 'antd'
import { FileOutlined, DownloadOutlined, FolderOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import HtmlFilesPage from './HtmlFilesPage'
import DownloadsPage from './DownloadsPage'
import ResourceMgmtPage from './ResourceMgmtPage'

const SharedCenterPage: React.FC = () => {
  const { t } = useTranslation('common')
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'

  if (isTeacherOrAdmin) {
    return (
      <Card style={{ borderRadius: 8 }}>
        <Tabs
          defaultActiveKey="browse"
          items={[
            {
              key: 'browse',
              label: <span><FileOutlined /> {t('resourceBrowse')}</span>,
              children: <HtmlFilesPage />,
            },
            {
              key: 'manage',
              label: <span><FolderOutlined /> {t('resourceManage')}</span>,
              children: <ResourceMgmtPage />,
            },
            {
              key: 'downloads',
              label: <span><DownloadOutlined /> {t('fileCenter')}</span>,
              children: <DownloadsPage />,
            },
          ]}
        />
      </Card>
    )
  }

  return (
    <Card style={{ borderRadius: 8 }}>
      <Tabs
        defaultActiveKey="html"
        items={[
          {
            key: 'html',
            label: <span><FileOutlined /> {t('sharedResources')}</span>,
            children: <HtmlFilesPage />,
          },
          {
            key: 'downloads',
            label: <span><DownloadOutlined /> {t('sharedFiles')}</span>,
            children: <DownloadsPage />,
          },
        ]}
      />
    </Card>
  )
}

export default SharedCenterPage
