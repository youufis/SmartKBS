import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Layout, Space, Button, Typography, message, Table, Modal, Tooltip, Card, Dropdown, Drawer, List, Input, Pagination } from 'antd'
import { UploadOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined, FolderOutlined, FolderOpenOutlined, ShareAltOutlined, SearchOutlined } from '@ant-design/icons'
import { getFileIcon } from '../utils/fileIcon'
import * as sharingApi from '../api/sharing'
import ShareDialog from '../components/ShareDialog'
import apiClient from '../api/client'
import { useTranslation } from 'react-i18next'

interface DownloadFile {
  name: string
  path: string
  size: number
  mtime: string
  is_dir?: boolean
}

const DownloadsPage: React.FC = () => {
  const { t } = useTranslation('system')
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
  const [shareInherited, setShareInherited] = useState(false)
  const [myShares, setMyShares] = useState<sharingApi.ShareItem[]>([])
  const [receivedShares, setReceivedShares] = useState<sharingApi.ShareItem[]>([])
  const [sharedPage, setSharedPage] = useState(1)
  const SHARED_PAGE_SIZE = 20

  // ── 搜索 ──
  const [searchText, setSearchText] = useState('')

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchText(e.target.value)
    setSharedPage(1)
  }

  // ── 浏览共享目录 ──
  const [browseDirOpen, setBrowseDirOpen] = useState(false)
  const [browseDirInfo, setBrowseDirInfo] = useState<{ owner: string; dirPath: string; dirName: string } | null>(null)
  const [browseDirFiles, setBrowseDirFiles] = useState<DownloadFile[]>([])
  const [browseDirLoading, setBrowseDirLoading] = useState(false)
  const openBrowseDir = async (owner: string, dirPath: string, dirName: string) => {
    setBrowseDirInfo({ owner, dirPath, dirName })
    setBrowseDirOpen(true)
    setBrowseDirLoading(true)
    try {
      const { data } = await apiClient.get('/api/downloads/shared-list', {
        params: { owner, dir_path: dirPath },
      })
      if (data.error) {
        message.error(data.error)
        setBrowseDirFiles([])
      } else {
        setBrowseDirFiles(data.files || [])
      }
    } catch {
      setBrowseDirFiles([])
    } finally {
      setBrowseDirLoading(false)
    }
  }
  const loadShares = async () => {
    try {
      const res = await sharingApi.getMyShares()
      setMyShares(res.shares)
      const receivedRes = await sharingApi.getReceivedShares()
      setReceivedShares(receivedRes.shares)
    } catch { /* ignore */ }
  }

  // 检查文件/目录是否已共享（精确匹配或继承自目录共享）
  const isFileShared = (filePath: string) => {
    return myShares.some(s => {
      // 规范化路径，去掉末尾的 /
      const sp = s.file_path.replace(/\/+$/, '')
      const fp = filePath.replace(/\/+$/, '')
      return sp === fp || fp.startsWith(sp + '/')
    })
  }

  // 查找文件最相关的共享记录：优先精确匹配，其次找最近的父目录共享
  const findShareRecord = (filePath: string): { record: sharingApi.ShareItem | null; inherited: boolean } => {
    const fp = filePath.replace(/\/+$/, '')
    // 精确匹配优先
    const exact = myShares.find(s => s.file_path.replace(/\/+$/, '') === fp)
    if (exact) return { record: exact, inherited: false }
    // 按路径深度排序，找最匹配的目录共享（路径最长的前缀）
    const dirShares = myShares
      .filter(s => fp.startsWith(s.file_path.replace(/\/+$/, '') + '/'))
      .sort((a, b) => b.file_path.length - a.file_path.length)
    if (dirShares[0]) return { record: dirShares[0], inherited: true }
    return { record: null, inherited: false }
  }

  const openShare = (filePath: string, fileName: string) => {
    setShareFile({ path: filePath, name: fileName })
    const { record, inherited } = findShareRecord(filePath)
    setShareExisting(record)
    setShareInherited(inherited)
    setShareDialogOpen(true)
  }

  const isStudent = user?.role === 'student'

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      if (!isStudent) {
        const { data } = await apiClient.get('/api/downloads/list')
        setFiles(data.files || [])
        setUsage(data.usage || 0)
        setQuota(data.quota || 0)
        setUsageStr(data.usage_str || '')
        setQuotaStr(data.quota_str || '')
      }
      loadShares()
    } catch {
    } finally {
      setLoading(false)
    }
  }, [isStudent])

  const loadFilesRef = useRef(loadFiles)
  useEffect(() => { loadFilesRef.current = loadFiles })
  useEffect(() => {
    const timer = setTimeout(() => loadFilesRef.current(), 0)
    return () => clearTimeout(timer)
  }, [])

  // 上传单个文件到指定子目录
  const uploadSingleFile = async (file: File, subPath: string): Promise<string> => {
    const formData = new FormData()
    formData.append('file0', file)
    formData.append('path0', subPath)
    try {
      const token = localStorage.getItem('smartkb_token')
      const resp = await fetch('/api/downloads/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      })
      const data = await resp.json()
      if (!resp.ok) {
        return data.detail || t('requestFailed', { status: resp.status })
      }
      if (data.errors && data.errors.length > 0) {
        return data.errors[0]
      }
      return data.success ? '' : t('uploadFailed')
    } catch (err: unknown) {
      return err instanceof Error ? err.message : t('networkError')
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
    message.loading({ content: t('uploadingFiles', { count: total }), key: 'fileUpload' })
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
      message.warning(t('uploadResultWithError', { success, fail, error: errors[0] }))
    } else {
      message.success(t('uploadComplete', { count: success }))
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

    message.loading({ content: t('uploadingFiles', { count: total }), key: 'dirUpload' })

    for (let i = 0; i < total; i++) {
      const file = fileList[i]
      // 获取相对于选定目录的路径
      // webkitRelativePath 格式: "subdir/filename"
      const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
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
      message.warning(t('uploadResultWithError', { success, fail, error: errors[0] }))
    } else {
      message.success(t('uploadComplete', { count: success }))
    }
    loadFiles()
  }

  const handleDelete = (filename: string) => {
    Modal.confirm({
      title: t('confirmDelete'),
      content: t('confirmDeleteContent', { filename }),
      onOk: async () => {
        try {
          const { data } = await apiClient.post('/api/downloads/delete', { filename })
          if (data.success) {
            loadFiles()
          } else {
            message.error(data.error || t('deleteFailed'))
          }
        } catch {
        }
      },
    })
  }

  // 构造下载链接（按用户隔离）
  const buildDownloadUrl = (record: DownloadFile) => {
    // 如果 path 就是文件名本身（根目录），sep 直接使用 name
    // 如果 path 包含子目录（如 "subdir/文件.png"），则保留子目录路径
    const sep = record.path
    const baseUrl = `/api/files/${encodeURIComponent(`${username}/downloads/${sep}`)}`
    return baseUrl
  }

  const columns = [
    {
      title: t('filePath'),
      dataIndex: 'path',
      key: 'path',
      render: (path: string, record: DownloadFile) => (
        <Space>
          {record.is_dir ? <FolderOutlined style={{ color: '#faad14' }} /> : getFileIcon(record.name || path)}
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
      title: t('fileSize'),
      dataIndex: 'size',
      key: 'size',
      width: 100,
      render: (size: number, record: DownloadFile) =>
        record.is_dir ? '-' : size < 1024 ? `${size} B` : size < 1048576 ? `${(size/1024).toFixed(1)} KB` : `${(size/1048576).toFixed(1)} MB`,
    },
    {
      title: t('updateTime'),
      dataIndex: 'mtime',
      key: 'mtime',
      width: 150,
    },
    {
      title: t('actions'),
      key: 'actions',
      width: 180,
      render: (_: unknown, record: DownloadFile) => (
        <Space>
          {!record.is_dir && (
            <Tooltip title={t('download')}>
              <Button type="link" icon={<DownloadOutlined />}
                href={buildDownloadUrl(record)}
                target="_blank" />
            </Tooltip>
          )}
          <Tooltip title={record.is_dir ? t('shareDir') : (isFileShared(record.path) ? t('sharedClickManage') : t('clickToShare'))}>
            <Button type="link" size="small"
              icon={<ShareAltOutlined />}
              style={{ color: isFileShared(record.path) ? '#ff4d4f' : '#999' }}
              onClick={() => openShare(record.path, record.name)} />
          </Tooltip>
          <Tooltip title={t('delete')}>
            <Button type="link" danger icon={<DeleteOutlined />}
              onClick={() => handleDelete(record.path)} />
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>{t('fileCenter')}</Typography.Title>
          <Space>
            <Input
              placeholder={t('searchFileName')}
              prefix={<SearchOutlined />}
              value={searchText}
              onChange={handleSearchChange}
              allowClear
              style={{ width: 220 }}
            />
            <Button icon={<ReloadOutlined />} onClick={loadFiles} loading={loading}>{t('refresh')}</Button>
          </Space>
        </div>

        {!isStudent ? (
          <>
            <Card size="small">
              <Space wrap>
                <Typography.Text>{t('uploadToSubdir')}</Typography.Text>
                <Typography.Text
                  editable={{ onChange: (val) => setUploadDir(val) }}
                  style={{ fontFamily: 'monospace', background: '#f5f5f5', padding: '2px 8px', borderRadius: 4 }}
                >
                  {uploadDir || t('rootDir')}
                </Typography.Text>
                <input ref={fileInputRef} type="file" multiple onChange={handleUploadFiles} style={{ display: 'none' }} />
                <input ref={dirInputRef} type="file" multiple
                  {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
                  onChange={handleUploadDir} style={{ display: 'none' }} />
                <Dropdown.Button
                  type="primary"
                  icon={<UploadOutlined />}
                  menu={{
                    items: [
                      { key: 'dir', icon: <FolderOpenOutlined />, label: t('uploadDirBtn') },
                    ],
                    onClick: ({ key }) => {
                      if (key === 'dir') dirInputRef.current?.click();
                    },
                  }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t('uploadFileBtn')}
                </Dropdown.Button>
              </Space>
            </Card>

            <Table
              dataSource={files.filter(f => {
                if (f.name === 'index.html') return false
                if (!searchText.trim()) return true
                const kw = searchText.trim().toLowerCase()
                return f.name.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw)
              })}
              columns={columns}
              rowKey="path"
              loading={loading}
              pagination={{ pageSize: 50, size: 'small' }}
              size="small"
              footer={() => (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('storageUsed')} {usageStr}
                  {quota > 0 ? ` / ${t('quota')} ${quotaStr}（${(usage / quota * 100).toFixed(1)}%）` : ` / ${t('quota')} ${quotaStr}`}
                </Typography.Text>
              )}
            />
          </>
        ) : (
          <Typography.Text type="secondary" style={{ padding: 16, display: 'block' }}>
            {t('sharedToYou')}
          </Typography.Text>
        )}

        {/* 共享文件列表 */}
        {(() => {
          const kw = searchText.trim().toLowerCase()
          const downloadShares = receivedShares
            .filter(s => s.resource_type === 'download')
            .filter(s => !kw || (s.file_name || '').toLowerCase().includes(kw))
          // 检测是否为目录共享（file_path 不含扩展名且接收方看不到精确匹配的文件时视为目录）
          const dirShares = downloadShares.filter(s => {
            const hasExt = /\.[a-zA-Z0-9]+$/.test(s.file_path)
            return !hasExt
          })
          const fileShares = downloadShares.filter(s => !dirShares.includes(s))
          // 合并分页（目录优先，文件其次），按页码偏移
          const totalShares = dirShares.length + fileShares.length
          const skipCount = (sharedPage - 1) * SHARED_PAGE_SIZE
          const allShares: { type: string; item: sharingApi.ShareItem }[] = [
            ...dirShares.map(s => ({ type: 'dir', item: s })),
            ...fileShares.map(s => ({ type: 'file', item: s })),
          ]
          const pagedAll = allShares.slice(skipCount, skipCount + SHARED_PAGE_SIZE)
          const pagedDir = pagedAll.filter(x => x.type === 'dir').map(x => x.item)
          const pagedFile = pagedAll.filter(x => x.type === 'file').map(x => x.item)
          return downloadShares.length > 0 ? (
            <Card size="small" title={<><ShareAltOutlined style={{ color: '#ff4d4f' }} /> {t('sharedFiles')} ({downloadShares.length})</>}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                {pagedDir.map((s) => (
                  <Card key={s.id} size="small" hoverable
                    onClick={() => openBrowseDir(s.owner_username, s.file_path, s.file_name)}
                    style={{ cursor: 'pointer' }}>
                    <Card.Meta
                      avatar={<FolderOutlined style={{ color: '#faad14' }} />}
                      title={
                        <Typography.Text strong
                          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                          📁 {s.file_name}/
                        </Typography.Text>
                      }
                      description={<span style={{ fontSize: 11 }}>{t('fromUserClickBrowse', { name: s.owner_username })}</span>}
                    />
                  </Card>
                ))}
                {pagedFile.map((s) => {
                  const fullPath = s.url_path || s.file_path
                  const fileUrl = `/api/files/${fullPath}`
                  return (
                    <Card key={s.id} size="small" hoverable>
                      <Card.Meta
                        avatar={getFileIcon(fullPath)}
                        title={
                          <a href={fileUrl} target="_blank" rel="noreferrer"
                            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                            {s.file_name}
                          </a>
                        }
                        description={<span style={{ fontSize: 11 }}>{t('fromUser', { name: s.owner_username })}</span>}
                      />
                    </Card>
                  )
                })}
              </div>
              {totalShares > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                  <Pagination
                    current={sharedPage}
                    total={totalShares}
                    pageSize={SHARED_PAGE_SIZE}
                    showSizeChanger
                    showTotal={(total) => t('totalFiles', { count: total })}
                    pageSizeOptions={['10', '20', '50']}
                    onChange={(p) => setSharedPage(p)}
                  />
                </div>
              )}
            </Card>
          ) : null;
        })()}
        {!isStudent && receivedShares.filter(s => s.resource_type === 'download').length === 0 && (
          <Typography.Text type="secondary" style={{ padding: 16, display: 'block' }}>{t('noSharedFiles')}</Typography.Text>
        )}

        {/* 浏览共享目录抽屉 */}
        <Drawer
          title={<><FolderOpenOutlined style={{ color: '#faad14', marginRight: 8 }} />{browseDirInfo?.dirName || t('sharedDir')}</>}
          open={browseDirOpen}
          onClose={() => setBrowseDirOpen(false)}
          size={600}
          extra={
            <Button type="text" icon={<ReloadOutlined />} onClick={() => {
              if (browseDirInfo) openBrowseDir(browseDirInfo.owner, browseDirInfo.dirPath, browseDirInfo.dirName)
            }} loading={browseDirLoading}>{t('refresh')}</Button>
          }
        >
          {browseDirInfo && (
            <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
              {t('sharedDirFromPrefix')} <strong>{browseDirInfo.owner}</strong> {t('sharedDirFromSuffix')}
            </Typography.Text>
          )}
          {browseDirFiles.length === 0 && !browseDirLoading ? (
            <Typography.Text type="secondary">{t('noFilesInDir')}</Typography.Text>
          ) : (
            <List
              loading={browseDirLoading}
              dataSource={browseDirFiles}
              renderItem={(item) => {
                const fileUrl = browseDirInfo
                  ? `/api/files/${encodeURIComponent(`${browseDirInfo.owner}/downloads/${item.path}`)}`
                  : '#'
                return (
                  <List.Item
                    actions={[
                      <a href={fileUrl} target="_blank" rel="noreferrer">
                        <DownloadOutlined /> {t('download')}
                      </a>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={getFileIcon(item.path || item.name)}
                      title={item.name}
                      description={
                        item.size < 1024 ? `${item.size} B` :
                        item.size < 1048576 ? `${(item.size/1024).toFixed(1)} KB` :
                        `${(item.size/1048576).toFixed(1)} MB`
                      }
                    />
                  </List.Item>
                )
              }}
            />
          )}
        </Drawer>

        {/* 共享弹窗 */}
        <ShareDialog
          open={shareDialogOpen}
          onClose={() => setShareDialogOpen(false)}
          filePath={shareFile.path}
          fileName={shareFile.name}
          resourceType="download"
          existingShare={shareExisting}
          inheritedFromDir={shareInherited}
          onSuccess={loadShares}
        />
      </Space>
    </Layout>
  )
}

export default DownloadsPage
