import React from 'react'
import { Tabs, Card } from 'antd'
import { FileOutlined, DownloadOutlined, FolderOutlined } from '@ant-design/icons'
import { useAuthStore } from '../stores/authStore'
import HtmlFilesPage from './HtmlFilesPage'
import DownloadsPage from './DownloadsPage'
import ResourceMgmtPage from './ResourceMgmtPage'

const SharedCenterPage: React.FC = () => {
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
              label: <span><FileOutlined /> 资源浏览</span>,
              children: <HtmlFilesPage />,
            },
            {
              key: 'manage',
              label: <span><FolderOutlined /> 资源管理</span>,
              children: <ResourceMgmtPage />,
            },
            {
              key: 'downloads',
              label: <span><DownloadOutlined /> 文件中心</span>,
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
            label: <span><FileOutlined /> 共享资源</span>,
            children: <HtmlFilesPage />,
          },
          {
            key: 'downloads',
            label: <span><DownloadOutlined /> 共享文件</span>,
            children: <DownloadsPage />,
          },
        ]}
      />
    </Card>
  )
}

export default SharedCenterPage
