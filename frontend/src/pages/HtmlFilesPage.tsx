import React, { useState, useEffect } from 'react'
import { Layout, Card, Space, Button, Typography, message } from 'antd'
import { ReloadOutlined, FileOutlined } from '@ant-design/icons'
import * as resourcesApi from '../api/resources'
import type { ResourceFile } from '../types'

const HtmlFilesPage: React.FC = () => {
  const [files, setFiles] = useState<ResourceFile[]>([])
  const [loading, setLoading] = useState(false)

  const loadData = async () => {
    setLoading(true)
    try {
      const res = await resourcesApi.listResources()
      setFiles(res.files)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [])

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 20, fontSize: 14 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={14}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>📄 资源中心</Typography.Title>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {files.map((f) => {
            const token = localStorage.getItem('smartkb_token') || ''
            const fileUrl = `/api/files/${f.url_path || f.name}${token ? `?token=${encodeURIComponent(token)}` : ''}`
            return (
            <Card key={f.path} size="small" hoverable style={{ fontSize: 14 }}>
              <Card.Meta
                avatar={<FileOutlined style={{ fontSize: 16 }} />}
                title={
                  <a href={fileUrl} target="_blank" rel="noreferrer"
                    title={f.display_name}
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', fontSize: 14 }}>
                    {f.display_name}
                  </a>
                }
              />
            </Card>
            )
          })}
          {files.length === 0 && <Typography.Text type="secondary">暂无资源文件</Typography.Text>}
        </div>
      </Space>
    </Layout>
  )
}

export default HtmlFilesPage
