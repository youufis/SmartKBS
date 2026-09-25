import React from 'react'
import { Tabs, Card } from 'antd'
import { FileOutlined, DownloadOutlined, FolderOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '../stores/authStore'
import HtmlFilesPage from './HtmlFilesPage'
import DownloadsPage from './DownloadsPage'
import ResourceMgmtPage from './ResourceMgmtPage'

/** 教师/管理员：资源浏览 · 资源管理 · 文件中心；学生：共享资源 · 共享文件 */
const TEACHER_TABS = ['browse', 'manage', 'downloads']
const STUDENT_TABS = ['html', 'downloads']

/** ?tab= 的历史写法与两种角色的键位统一映射（任务清单/通知里的深链靠它落到正确标签页） */
const TAB_ALIAS: Record<string, string> = {
  browse: 'browse', manage: 'manage', downloads: 'downloads', html: 'html',
  files: 'downloads', resources: 'html', shared: 'html',
}

const SharedCenterPage: React.FC = () => {
  const { t } = useTranslation('common')
  const user = useAuthStore((s) => s.user)
  const isTeacherOrAdmin = user?.role === 'admin' || user?.role === 'teacher'
  const allowed = isTeacherOrAdmin ? TEACHER_TABS : STUDENT_TABS

  // 标签页写进地址栏：刷新/分享链接/从待办点进来都停在原来那一页
  const [sp, setSp] = useSearchParams()
  const requested = TAB_ALIAS[sp.get('tab') || ''] || ''
  const activeKey = allowed.includes(requested) ? requested : allowed[0]
  const setActiveKey = (key: string) => {
    const next = new URLSearchParams(sp)
    next.set('tab', key)
    setSp(next, { replace: true })
  }

  if (isTeacherOrAdmin) {
    return (
      <Card style={{ borderRadius: 8 }}>
        <Tabs
          activeKey={activeKey}
          onChange={setActiveKey}
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
        activeKey={activeKey}
        onChange={setActiveKey}
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
