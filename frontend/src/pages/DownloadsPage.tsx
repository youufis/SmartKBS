import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Layout, Space, Button, Typography, message, Table, Modal, Tooltip, Card, Dropdown } from 'antd'
import { UploadOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined, FileOutlined, FolderOutlined, FolderOpenOutlined, ShareAltOutlined } from '@ant-design/icons'
import * as sharingApi from '../api/sharing'
import ShareDialog from '../components/ShareDialog'
import apiClient from '../api/client'

interface DownloadFile {
  name: string
  path: string
  size: number
  mtime: string
  is_dir?: boolean
}

const DownloadsPage: React.FC = () => {
  const user = JSON.parse(localStorage.getItem('smartkb_user') || '{}')
  const username: string = user?.username || 'root'
  const [files, setFiles] = useState<DownloadFile[]>([])
  const [loading, setLoading] = useState(false)
  const [usage, setUsage] = useState(0)
  const [quota, setQuota] = useState(0)
  const [usageStr, setUsageStr] = useState('')
  const [quotaStr, setQuotaStr] = useState('')
  const [uploadDir, setUploadDir] = useState('')
  const dirInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── 共享 ──
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [shareFile, setShareFile] = useState<{ path: string; name: string }>({ path: '', name: '' })
  const [shareExisting, setShareExisting] = useState<sharingApi.ShareItem | null>(null)
  const [myShares, setMyShares] = useState<sharingApi.ShareItem[]>([])
  const [receivedShares, setReceivedShares] = useState<sharingApi.ShareItem[]>([])
  const token = localStorage.getItem('smartkb_token') || ''

  const loadShares = async () => {
    try {
      const res = await sharingApi.getMyShares()
      setMyShares(res.shares)
      const receivedRes = await sharingApi.getReceivedShares()
      setReceivedShares(receivedRes.shares)
    } catch { /* ignore */ }
  }

  const isFileShared = (filePath: string) => {
    return myShares.some(s => s.file_path === filePath)
  }

  const openShare = (filePath: string, fileName: string) => {
    setShareFile({ path: filePath, name: fileName })
    const existing = myShares.find(s => s.file_path === filePath) || null
    setShareExisting(existing)
    setShareDialogOpen(true)
  }

  const isStudent = user?.role === 'student'

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      if (!isStudent) {
        const { data } = await apiClient.get('/downloads-api/list')
        setFiles(data.files || [])
        setUsage(data.usage || 0)
        setQuota(data.quota || 0)
        setUsageStr(data.usage_str || '')
        setQuotaStr(data.quota_str || '')
      }
      loadShares()
    } catch {
      message.error('加载文件列表失败')
    } finally {
      setLoading(false)
    }
  }, [isStudent])

  useEffect(() => { loadFiles() }, [loadFiles])

  // 上传单个文件到指定子目录
  const uploadSingleFile = async (file: File, subPath: string): Promise<string> => {
    const formData = new FormData()
    formData.append('file0', file)
    formData.append('path0', subPath)
    try {
      const token = localStorage.getItem('smartkb_token')
      const resp = await fetch('/downloads-api/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      const data = await resp.json()
      if (!resp.ok) {
        return data.detail || `请求失败 (${resp.status})`
      }
      if (data.errors && data.errors.length > 0) {
        return data.errors[0]
      }
      return data.success ? '' : '上传失败'
    } catch (err: any) {
      return err.message || '网络错误'
    }
  }

  // 上传多个文件
  const handleUploadFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return
    const basePath = uploadDir.trim().replace(/\\/g, '/')
    const total = fileList.length
    let success = 0
    let fail = 0
    message.loading({ content: `正在上传 ${total} 个文件...`, key: 'fileUpload' })
    const errors: string[] = []
    for (let i = 0; i < total; i++) {
      const err = await uploadSingleFile(fileList[i], basePath)
      if (err) {
        fail++
        errors.push(err)
      } else {
        success++
      }
    }
    e.target.value = ''
    message.destroy('fileUpload')
    if (errors.length > 0) {
      message.warning(`成功 ${success} 个，失败 ${fail} 个。错误: ${errors[0]}`)
    } else {
      message.success(`上传完成：成功 ${success} 个`)
    }
    loadFiles()
  }

  // 上传整个目录
  const handleUploadDir = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (!fileList || fileList.length === 0) return

    const basePath = uploadDir.trim().replace(/\\/g, '/')
    const total = fileList.length
    let success = 0
    let fail = 0
    const errors: string[] = []

    message.loading({ content: `正在上传 ${total} 个文件...`, key: 'dirUpload' })

    for (let i = 0; i < total; i++) {
      const file = fileList[i]
      // 获取相对于选定目录的路径
      // webkitRelativePath 格式: "subdir/filename"
      const relPath = (file as any).webkitRelativePath || file.name
      const dirParts = relPath.split('/')
      // 去掉文件名，只保留目录部分
      dirParts.pop()
      const subDir = dirParts.length > 0 ? dirParts.join('/') : ''
      // 拼接基础目录和相对子目录
      const fullSubPath = basePath ? `${basePath}/${subDir}` : subDir

      const err = await uploadSingleFile(file, fullSubPath)
      if (err) {
        fail++
        errors.push(err)
      } else {
        success++
      }
    }

    e.target.value = ''
    message.destroy('dirUpload')
    if (errors.length > 0) {
      message.warning(`成功 ${success} 个，失败 ${fail} 个。错误: ${errors[0]}`)
    } else {
      message.success(`上传完成：成功 ${success} 个`)
    }
    loadFiles()
  }

  const handleDelete = (filename: string) => {
    Modal.confirm({
      title: '确认删除',
      content: `确定删除「${filename}」？`,
      onOk: async () => {
        try {
          const { data } = await apiClient.post('/downloads-api/delete', { filename })
          if (data.success) {
            message.success('已删除')
            loadFiles()
          } else {
            message.error(data.error || '删除失败')
          }
        } catch {
          message.error('删除失败')
        }
      },
    })
  }

  // 构造下载链接（按用户隔离）
  const buildDownloadUrl = (record: DownloadFile) => {
    const dir = record.path.replace('/' + record.name, '')
    const sep = dir ? `${dir}/${record.name}` : record.name
    const token = localStorage.getItem('smartkb_token') || ''
    const baseUrl = `/api/files/${encodeURIComponent(`${username}/downloads/${sep}`)}`
    return token ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl
  }

  const columns = [
    {
      title: '文件路径',
      dataIndex: 'path',
      key: 'path',
      render: (path: string, record: DownloadFile) => (
        <Space>
          {record.is_dir ? <FolderOutlined style={{ color: '#faad14' }} /> : <FileOutlined />}
          {record.is_dir ? (
            <Typography.Text strong>{record.name}/</Typography.Text>
          ) : (
            <a href={buildDownloadUrl(record)}
               target="_blank" rel="noreferrer">
              {path}
            </a>
          )}
        </Space>
      ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      key: 'size',
      width: 100,
      render: (size: number, record: DownloadFile) =>
        record.is_dir ? '-' : size < 1024 ? `${size} B` : size < 1048576 ? `${(size/1024).toFixed(1)} KB` : `${(size/1048576).toFixed(1)} MB`,
    },
    {
      title: '更新时间',
      dataIndex: 'mtime',
      key: 'mtime',
      width: 150,
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_: any, record: DownloadFile) =>
        record.is_dir ? null : (
          <Space>
            <Tooltip title="下载">
              <Button type="link" icon={<DownloadOutlined />}
                href={buildDownloadUrl(record)}
                target="_blank" />
            </Tooltip>
            <Tooltip title={isFileShared(record.path) ? '已共享 - 点击取消共享' : '点击共享'}>
              <Button type="link" size="small"
                icon={<ShareAltOutlined />}
                style={{ color: isFileShared(record.path) ? '#1677ff' : '#999' }}
                onClick={() => openShare(record.path, record.name)} />
            </Tooltip>
            <Tooltip title="删除">
              <Button type="link" danger icon={<DeleteOutlined />}
                onClick={() => handleDelete(record.path)} />
            </Tooltip>
          </Space>
        ),
    },
  ]

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography.Title level={4} style={{ margin: 0 }}>📥 文件中心</Typography.Title>
          <Button icon={<ReloadOutlined />} onClick={loadFiles} loading={loading}>刷新</Button>
        </div>

        {!isStudent ? (
          <>
            <Card size="small">
              <Space wrap>
                <Typography.Text>上传到子目录：</Typography.Text>
                <Typography.Text
                  editable={{ onChange: (val) => setUploadDir(val) }}
                  style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: '2px 8px', borderRadius: 4 }}
                >
                  {uploadDir || '(根目录)'}
                </Typography.Text>
                <input ref={fileInputRef} type="file" multiple onChange={handleUploadFiles} style={{ display: 'none' }} />
                <input ref={dirInputRef} type="file" multiple
                  {...({ webkitdirectory: '', directory: '' } as any)}
                  onChange={handleUploadDir} style={{ display: 'none' }} />
                <Dropdown.Button
                  type="primary"
                  icon={<UploadOutlined />}
                  menu={{
                    items: [
                      { key: 'dir', icon: <FolderOpenOutlined />, label: '上传目录' },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'dir') dirInputRef.current?.click();
                    },
                  }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  上传文件
                </Dropdown.Button>
              </Space>
            </Card>

            <Table
              dataSource={files.filter(f => f.name !== 'index.html')}
              columns={columns}
              rowKey="path"
              loading={loading}
              pagination={{ pageSize: 50, size: 'small' }}
              size="small"
              footer={() => (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已用 {usageStr}
                  {quota > 0 ? ` / 配额 ${quotaStr}（${(usage / quota * 100).toFixed(1)}%）` : ` / 配额 ${quotaStr}`}
                </Typography.Text>
              )}
            />
          </>
        ) : (
          <Typography.Text type="secondary" style={{ padding: 16, display: 'block' }}>
            以下为共享给您的文件：
          </Typography.Text>
        )}

        {/* 共享文件列表 */}
        {(() => { const downloadShares = receivedShares.filter(s => s.resource_type === 'download'); return downloadShares.length > 0 ? (
          <Card size="small" title={<><ShareAltOutlined style={{ color: '#1677ff' }} /> 共享文件 ({downloadShares.length})</>}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {downloadShares.map((s) => {
                const fullPath = s.url_path || s.file_path
                const fileUrl = `/api/files/${fullPath}${token ? `?token=${encodeURIComponent(token)}` : ''}`
                return (
                  <Card key={s.id} size="small" hoverable>
                    <Card.Meta
                      avatar={<FileOutlined style={{ color: '#1677ff' }} />}
                      title={
                        <a href={fileUrl} target="_blank" rel="noreferrer"
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                          {s.file_name}
                        </a>
                      }
                      description={<span style={{ fontSize: 11 }}>来自 {s.owner_username}</span>}
                    />
                  </Card>
                )
              })}
            </div>
          </Card>
        ) : null; })()}
        {!isStudent && receivedShares.filter(s => s.resource_type === 'download').length === 0 && (
          <Typography.Text type="secondary" style={{ padding: 16, display: 'block' }}>暂无共享文件</Typography.Text>
        )}

        {/* 共享弹窗 */}
        <ShareDialog
          open={shareDialogOpen}
          onClose={() => setShareDialogOpen(false)}
          filePath={shareFile.path}
          fileName={shareFile.name}
          resourceType="download"
          existingShare={shareExisting}
          onSuccess={loadShares}
        />
      </Space>
    </Layout>
  )
}

export default DownloadsPage
