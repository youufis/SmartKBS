import React, { useState, useEffect } from 'react'
import { Layout, Card, Space, Button, Typography, message } from 'antd'
import { ReloadOutlined, FileOutlined } from '@ant-design/icons'
import * as resourcesApi from '../api/resources'
import type { ResourceFile } from '../types'

// 子目录名 → 中文标题映射
const CATEGORY_MAP: Record<string, string> = {
  gt: '通用技术',
  it: '信息技术',
  ai: '人工智能通识',
  puzzle: 'PUZZLE益智',
  AIGK: '课堂互动',
  downloads: '下载中心',
}

const ResourceCategoryPage: React.FC<{ subdir: string; title?: string }> = ({ subdir, title }) => {
  const displayTitle = title || CATEGORY_MAP[subdir] || subdir
  const [files, setFiles] = useState<ResourceFile[]>([])
  const [loading, setLoading] = useState(false)

  const loadData = async () => {
    setLoading(true)
    try {
      const res = await resourcesApi.listResources()
      // 筛选出属于该子目录的文件（url_path 以 root/html/{subdir}/ 开头）
      const filtered = res.files.filter((f: ResourceFile) =>
        f.url_path?.startsWith(`root/html/${subdir}/`)
      )
      // 也包含子目录下 index.html 但不显示目录本身
      setFiles(filtered)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadData() }, [subdir])

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>📂 {displayTitle}</Typography.Title>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {files.map((f) => {
            const token = localStorage.getItem('smartkb_token') || ''
            const fileUrl = `/api/files/${f.url_path || f.name}${token ? `?token=${encodeURIComponent(token)}` : ''}`
            return (
            <Card key={f.path} size="small" hoverable style={{ width: 280 }}>
              <Card.Meta
                avatar={<FileOutlined />}
                title={
                  <a href={fileUrl} target="_blank" rel="noreferrer"
                    style={{ wordBreak: 'break-all', whiteSpace: 'normal' }}>
                    {f.display_name}
                  </a>
                }
              />
            </Card>
            )
          })}
          {files.length === 0 && <Typography.Text type="secondary">暂无文件</Typography.Text>}
        </div>
      </Space>
    </Layout>
  )
}

export default ResourceCategoryPage
