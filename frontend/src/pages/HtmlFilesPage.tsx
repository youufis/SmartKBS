import React, { useState, useEffect } from 'react'
import { Layout, Card, Space, Button, Typography, message, Tabs, Tag } from 'antd'
import { ReloadOutlined, FileOutlined, ShareAltOutlined } from '@ant-design/icons'
import * as resourcesApi from '../api/resources'
import * as sharingApi from '../api/sharing'
import type { ResourceFile } from '../types'
import { useAuthStore } from '../stores/authStore'

const HtmlFilesPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const [files, setFiles] = useState<ResourceFile[]>([])
  const [receivedShares, setReceivedShares] = useState<sharingApi.ShareItem[]>([])
  const [loading, setLoading] = useState(false)

  const loadData = async () => {
    setLoading(true)
    try {
      if (isAdminOrTeacher) {
        const res = await resourcesApi.listResources()
        setFiles(res.files)
      } else {
        setFiles([])
      }
      const shareRes = await sharingApi.getReceivedShares()
      setReceivedShares(shareRes.shares.filter(s => s.resource_type === 'html'))
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [isAdminOrTeacher])

  const token = localStorage.getItem('smartkb_token') || ''

  const renderFileCard = (name: string, urlPath: string, isShared: boolean, owner?: string) => (
    <Card key={urlPath} size="small" hoverable style={{ fontSize: 14 }}>
      <Card.Meta
        avatar={<FileOutlined style={{ fontSize: 16, color: isShared ? '#1677ff' : undefined }} />}
        title={
          <a href={`/api/files/${urlPath}${token ? `?token=${encodeURIComponent(token)}` : ''}`}
            target="_blank" rel="noreferrer"
            title={name}
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', fontSize: 14 }}>
            {name}
          </a>
        }
        description={isShared && owner ? <Tag color="blue" style={{ fontSize: 11 }}>来自 {owner}</Tag> : undefined}
      />
    </Card>
  )

  const sharedItems = receivedShares.map(s => ({
    name: s.file_name,
    urlPath: s.file_path,
    owner: s.owner_username,
  }))

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 20, fontSize: 14 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={14}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>
            {isAdminOrTeacher ? '📄 资源中心' : '📄 共享资源'}
          </Typography.Title>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
        </div>

        {isAdminOrTeacher ? (
          <Tabs defaultActiveKey="mine" items={[
            {
              key: 'mine',
              label: <span><FileOutlined /> 我的资源</span>,
              children: (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                  {files.map((f) => renderFileCard(f.display_name, f.url_path || f.name, false))}
                  {files.length === 0 && <Typography.Text type="secondary">暂无资源文件</Typography.Text>}
                </div>
              ),
            },
            {
              key: 'shared',
              label: <span><ShareAltOutlined /> 共享给我的 ({sharedItems.length})</span>,
              children: (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                  {sharedItems.map((item) => renderFileCard(item.name, item.urlPath, true, item.owner))}
                  {sharedItems.length === 0 && <Typography.Text type="secondary">暂无共享资源</Typography.Text>}
                </div>
              ),
            },
          ]} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {sharedItems.map((item) => renderFileCard(item.name, item.urlPath, true, item.owner))}
            {sharedItems.length === 0 && <Typography.Text type="secondary">暂无共享资源</Typography.Text>}
          </div>
        )}
      </Space>
    </Layout>
  )
}

export default HtmlFilesPage
