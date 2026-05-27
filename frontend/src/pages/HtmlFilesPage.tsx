import React, { useState, useEffect } from 'react'
import { Layout, Card, Space, Button, Typography, message, Tabs, Tag, Tooltip } from 'antd'
import { ReloadOutlined, FileOutlined, ShareAltOutlined } from '@ant-design/icons'
import * as resourcesApi from '../api/resources'
import * as sharingApi from '../api/sharing'
import type { ResourceFile } from '../types'
import { useAuthStore } from '../stores/authStore'
import ShareDialog from '../components/ShareDialog'

const HtmlFilesPage: React.FC = () => {
  const user = useAuthStore((s) => s.user)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const [files, setFiles] = useState<ResourceFile[]>([])
  const [receivedShares, setReceivedShares] = useState<sharingApi.ShareItem[]>([])
  const [myShares, setMyShares] = useState<sharingApi.ShareItem[]>([])
  const [loading, setLoading] = useState(false)

  // ── 共享弹窗状态 ──
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [shareFile, setShareFile] = useState<{ path: string; name: string }>({ path: '', name: '' })
  const [shareExisting, setShareExisting] = useState<sharingApi.ShareItem | null>(null)

  const loadData = async () => {
    setLoading(true)
    try {
      if (isAdminOrTeacher) {
        const [res, shareRes, myRes] = await Promise.all([
          resourcesApi.listResources(),
          sharingApi.getReceivedShares(),
          sharingApi.getMyShares(),
        ])
        setFiles(res.files)
        setMyShares(myRes.shares)
        setReceivedShares(shareRes.shares.filter(s => s.resource_type === 'html'))
      } else {
        setFiles([])
        const shareRes = await sharingApi.getReceivedShares()
        setReceivedShares(shareRes.shares.filter(s => s.resource_type === 'html'))
      }
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [isAdminOrTeacher])

  const token = localStorage.getItem('smartkb_token') || ''

  const isFileShared = (nodeKey: string) => myShares.some(s => s.file_path === nodeKey)

  const openShare = (filePath: string, fileName: string) => {
    setShareFile({ path: filePath, name: fileName })
    setShareExisting(myShares.find(s => s.file_path === filePath) || null)
    setShareDialogOpen(true)
  }

  const renderFileCard = (name: string, urlPath: string, isShared: boolean, owner?: string, showShareBtn = false) => (
    <Card key={urlPath} size="small" hoverable style={{ fontSize: 14 }}>
      <Card.Meta
        avatar={<FileOutlined style={{ fontSize: 16, color: isShared ? '#1677ff' : undefined }} />}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
            <a href={`/api/files/${urlPath}${token ? `?token=${encodeURIComponent(token)}` : ''}`}
              target="_blank" rel="noreferrer"
              title={name}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, fontSize: 14 }}>
              {name}
            </a>
            {showShareBtn && (
              <Tooltip title={isFileShared(urlPath) ? '已共享 - 点击取消共享' : '点击共享'}>
                <ShareAltOutlined
                  style={{ color: isFileShared(urlPath) ? '#1677ff' : '#999', cursor: 'pointer', fontSize: 14, flexShrink: 0 }}
                  onClick={(e) => { e.preventDefault(); openShare(urlPath, name); }}
                />
              </Tooltip>
            )}
          </div>
        }
        description={isShared && owner ? <Tag color="blue" style={{ fontSize: 11 }}>来自 {owner}</Tag> : undefined}
      />
    </Card>
  )

  const sharedItems = receivedShares.map(s => ({
    name: s.file_name,
    urlPath: s.url_path || s.file_path,
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
                  {files.map((f) => renderFileCard(f.display_name, f.url_path || f.name, false, undefined, true))}
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

        {/* 共享弹窗 */}
        <ShareDialog
          open={shareDialogOpen}
          onClose={() => setShareDialogOpen(false)}
          filePath={shareFile.path}
          fileName={shareFile.name}
          resourceType="html"
          existingShare={shareExisting}
          onSuccess={loadData}
        />
      </Space>
    </Layout>
  )
}

export default HtmlFilesPage
