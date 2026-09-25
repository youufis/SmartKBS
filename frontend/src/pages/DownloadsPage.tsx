/**
 * 文件中心：教师/管理员管理自己名下的共享文件，接收方（学生 / 其他教师）浏览「共享文件」
 * 接收侧统一走 ResourceBrowser（与「共享资源」同一套分类栏 + 统计条 + 网格/列表 + 偏好记忆），
 * 目录型共享（一个共享指向整个文件夹）在这里点开是浏览文件夹，单个文件点开是下载。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, Card, Dropdown, Drawer, Empty, Input, Layout, Modal, Space, Table, Tooltip, Typography, message, theme,
} from 'antd'
import {
  DeleteOutlined, DownloadOutlined, FolderOpenOutlined, FolderOutlined, ReloadOutlined,
  SearchOutlined, ShareAltOutlined, UploadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import * as sharingApi from '../api/sharing'
import apiClient from '../api/client'
import ShareDialog from '../components/ShareDialog'
import ResourceBrowser, { type BrowserItem } from '../components/ResourceBrowser'
import { getFileIcon } from '../utils/fileIcon'
import { formatBytes, getFileKind, KIND_COLOR } from '../utils/fileKind'
import { useAuthStore } from '../stores/authStore'

interface DownloadFile {
  name: string
  path: string
  size: number
  mtime: string
  is_dir?: boolean
}

/** 后端没给 is_dir 时的兜底（旧版本产物）：末段没有扩展名就按目录处理 */
const looksLikeDir = (p: string) => {
  const clean = String(p || '').replace(/\/+$/, '')
  const last = clean.split('/').pop() || ''
  return !/\.[a-zA-Z0-9]+$/.test(last)
}

const DownloadsPage: React.FC = () => {
  const { t } = useTranslation('system')
  const { token } = theme.useToken()
  const user = useAuthStore((s) => s.user)
  const username = user?.username || ''
  const isStudent = user?.role === 'student'

  // ── 我的文件（教师/管理员） ──
  const [files, setFiles] = useState<DownloadFile[]>([])
  const [loading, setLoading] = useState(false)
  const [usage, setUsage] = useState(0)
  const [quota, setQuota] = useState(0)
  const [usageStr, setUsageStr] = useState('')
  const [quotaStr, setQuotaStr] = useState('')
  const [uploadDir, setUploadDir] = useState('')
  const dirInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [ownPage, setOwnPage] = useState(1)
  const [ownPageSize, setOwnPageSize] = useState(50)

  // ── 共享 ──
  const [shareDialogOpen, setShareDialogOpen] = useState(false)
  const [shareFile, setShareFile] = useState<{ path: string; name: string }>({ path: '', name: '' })
  const [shareExisting, setShareExisting] = useState<sharingApi.ShareItem | null>(null)
  const [shareInherited, setShareInherited] = useState(false)
  const [myShares, setMyShares] = useState<sharingApi.ShareItem[]>([])
  const [receivedShares, setReceivedShares] = useState<sharingApi.ShareItem[]>([])

  // ── 搜索（只作用于「我的文件」表格，接收侧的搜索由 ResourceBrowser 自管） ──
  const [searchText, setSearchText] = useState('')
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchText(e.target.value)
    setOwnPage(1)
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
        // 目录被删 / 共享被撤时给个明确提示，别让抽屉空着让人以为没文件
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
      const [myRes, receivedRes] = await Promise.all([
        sharingApi.getMyShares(),
        sharingApi.getReceivedShares(),
      ])
      setMyShares(myRes.shares)
      setReceivedShares(receivedRes.shares.filter((s) => s.resource_type === 'download'))
    } catch { /* 忽略：保留上一次结果，页面仍可手动刷新重试 */ }
  }

  // 检查文件/目录是否已共享（精确匹配或继承自目录共享）
  const isFileShared = (filePath: string) => {
    return myShares.some((s) => {
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
    const exact = myShares.find((s) => s.file_path.replace(/\/+$/, '') === fp)
    if (exact) return { record: exact, inherited: false }
    // 按路径深度排序，找最匹配的目录共享（路径最长的前缀）
    const dirShares = myShares
      .filter((s) => fp.startsWith(s.file_path.replace(/\/+$/, '') + '/'))
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

  const loadData = useCallback(async () => {
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
      await loadShares()
    } catch {
      // 单条失败不阻断整体流程
    } finally {
      setLoading(false)
    }
  }, [isStudent])

  const loadFilesRef = useRef(loadData)
  useEffect(() => { loadFilesRef.current = loadData })
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
    loadData()
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
    loadData()
  }

  const handleDelete = (filename: string) => {
    Modal.confirm({
      title: t('confirmDelete'),
      content: t('confirmDeleteContent', { filename }),
      onOk: async () => {
        try {
          const { data } = await apiClient.post('/api/downloads/delete', { filename })
          if (data.success) {
            loadData()
          } else {
            message.error(data.error || t('deleteFailed'))
          }
        } catch {
          // 删除失败已由接口返回提示，这里不再重复弹窗
        }
      },
    })
  }

  // 构造下载链接（按用户隔离）
  const buildDownloadUrl = (record: DownloadFile) => {
    // 如果 path 就是文件名本身（根目录），sep 直接使用 name
    // 如果 path 包含子目录（如 "subdir/文件.png"），则保留子目录路径
    const sep = record.path
    return `/api/files/${encodeURIComponent(`${username}/downloads/${sep}`)}`
  }

  // ── 接收侧：条目映射 ──
  const browserItems = useMemo<BrowserItem[]>(() => receivedShares.map((s) => {
    const isDir = typeof s.is_dir === 'boolean'
      ? s.is_dir
      : looksLikeDir(s.file_path)
    const size = formatBytes(s.total_size || 0)
    return {
      id: s.id,
      name: s.file_name,
      urlPath: s.url_path || s.file_path,
      filePath: s.file_path,
      resourceType: 'download',
      entryType: isDir ? ('dir' as const) : ('file' as const),
      sub: isDir
        ? ((s.file_count || 0) > 0 ? t('dirStat', { count: s.file_count, size }) : undefined)
        : ((s.total_size || 0) > 0 ? size : undefined),
      ownerUsername: s.owner_username,
      ownerName: s.owner_name,
      ownerRole: s.owner_role,
      shareScope: s.share_scope,
      targetGrade: s.target_grade,
      targetClass: s.target_class,
      createdAt: s.created_at,
      viewedAt: s.viewed_at,
      viewCount: s.view_count,
      courseName: s.course_name,
      kpName: s.kp_name,
      bindingCount: s.binding_count,
    }
  }), [receivedShares, t])

  /** 自己名下也有同一份文件时，「再共享给学生」才有意义（否则会把别人目录里的路径当成自己的文件共享） */
  const ownPathSet = useMemo(
    () => new Set(files.map((f) => f.path.replace(/\/+$/, ''))),
    [files],
  )

  const openItem = (it: BrowserItem) => {
    if (it.entryType === 'dir') {
      void openBrowseDir(it.ownerUsername, it.filePath, it.name)
      return
    }
    // 学生点开文件时后端 serve_static_file 会记浏览日志（含目录型共享的归属），无需前端再埋点
    window.open(`/api/files/${it.urlPath}`, '_blank', 'noopener')
  }

  const columns = [
    {
      title: t('filePath'),
      dataIndex: 'path',
      key: 'path',
      render: (path: string, record: DownloadFile) => (
        <Space>
          {record.is_dir
            ? <FolderOutlined style={{ color: KIND_COLOR.dir }} />
            : getFileIcon(record.name || path)}
          {record.is_dir ? (
            <Typography.Text strong>{record.name}/</Typography.Text>
          ) : (
            <a href={buildDownloadUrl(record)} target="_blank" rel="noreferrer">
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
      width: 110,
      render: (size: number, record: DownloadFile) => (record.is_dir ? '-' : formatBytes(size)),
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
              style={{ color: isFileShared(record.path) ? token.colorError : token.colorTextDescription }}
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

  const ownShown = files.filter((f) => {
    if (f.name === 'index.html') return false
    if (!searchText.trim()) return true
    const kw = searchText.trim().toLowerCase()
    return f.name.toLowerCase().includes(kw) || f.path.toLowerCase().includes(kw)
  })

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: token.colorBgContainer, borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>
            {isStudent ? t('sharedFiles') : t('fileCenter')}
          </Typography.Title>
          <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>{t('refresh')}</Button>
        </div>

        {!isStudent && (
          <>
            <Card size="small">
              <Space wrap>
                <Typography.Text>{t('uploadToSubdir')}</Typography.Text>
                <Typography.Text
                  editable={{ onChange: (val) => setUploadDir(val) }}
                  style={{ fontFamily: 'monospace', background: token.colorFillTertiary, padding: '2px 8px', borderRadius: 4 }}
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

            <Card
              size="small"
              title={<Space size={6}><FolderOutlined style={{ color: KIND_COLOR.dir }} />{t('myFiles')}</Space>}
              extra={(
                <Input
                  placeholder={t('searchFileName')}
                  prefix={<SearchOutlined style={{ color: token.colorTextDescription }} />}
                  value={searchText}
                  onChange={handleSearchChange}
                  allowClear
                  size="small"
                  style={{ width: 220 }}
                />
              )}
              styles={{ body: { padding: '0 8px 8px' } }}
            >
              <Table
                dataSource={ownShown}
                columns={columns}
                rowKey="path"
                loading={loading}
                size="small"
                pagination={{
                  current: ownPage,
                  pageSize: ownPageSize,
                  size: 'small',
                  showSizeChanger: true,
                  pageSizeOptions: ['20', '50', '100'],
                  showTotal: (n) => t('totalFiles', { count: n }),
                  onChange: (p, ps) => {
                    if (ps !== ownPageSize) { setOwnPageSize(ps); setOwnPage(1) } else { setOwnPage(p) }
                  },
                }}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description={<Typography.Text type="secondary">{searchText.trim() ? t('noMatchFiles') : t('noOwnFiles')}</Typography.Text>}
                    />
                  ),
                }}
                footer={() => (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('storageUsed')} {usageStr}
                    {quota > 0 ? ` / ${t('quota')} ${quotaStr}（${(usage / quota * 100).toFixed(1)}%）` : ` / ${t('quota')} ${quotaStr}`}
                  </Typography.Text>
                )}
              />
            </Card>
          </>
        )}

        {/* ── 共享给我的文件（学生端 = 「共享文件」标签页本体） ── */}
        <Card
          size="small"
          title={<Space size={6}><ShareAltOutlined style={{ color: token.colorPrimary }} />{t('receivedFiles')}</Space>}
          extra={(
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('totalFiles', { count: browserItems.length })}
            </Typography.Text>
          )}
        >
          <ResourceBrowser
            variant="files"
            mode={isStudent ? 'student' : 'teacher'}
            items={browserItems}
            loading={loading}
            onOpen={openItem}
            onReshare={isStudent ? undefined : (it) => openShare(it.filePath, it.name)}
            canReshare={(it) => ownPathSet.has(it.filePath.replace(/\/+$/, ''))}
            onRefresh={loadData}
          />
        </Card>

        {/* 浏览共享目录抽屉 */}
        {browseDirInfo && (
          <Drawer
            title={<><FolderOpenOutlined style={{ color: KIND_COLOR.dir, marginRight: 8 }} />{browseDirInfo.dirName || t('sharedDir')}</>}
            open={browseDirOpen}
            onClose={() => setBrowseDirOpen(false)}
            size={600}
            extra={(
              <Button type="text" icon={<ReloadOutlined />} onClick={() => {
                void openBrowseDir(browseDirInfo.owner, browseDirInfo.dirPath, browseDirInfo.dirName)
              }} loading={browseDirLoading}>{t('refresh')}</Button>
            )}
          >
            <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
              {t('sharedDirFromPrefix')} <strong>{browseDirInfo.owner}</strong> {t('sharedDirFromSuffix')}
            </Typography.Text>
            {browseDirFiles.length === 0 && !browseDirLoading ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={(
                <Typography.Text type="secondary">{t('noFilesInDir')}</Typography.Text>
              )} />
            ) : (
              <div style={{ border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 8, overflow: 'hidden' }}>
                {browseDirFiles.map((item, idx) => {
                  const fileUrl = `/api/files/${encodeURIComponent(`${browseDirInfo.owner}/downloads/${item.path}`)}`
                  const kind = getFileKind(item.path || item.name)
                  return (
                    <div
                      key={item.path}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', minWidth: 0,
                        background: idx % 2 ? token.colorFillQuaternary : 'transparent',
                        borderBottom: idx === browseDirFiles.length - 1 ? 'none' : `1px solid ${token.colorBorderSecondary}`,
                      }}
                    >
                      <span style={{ flexShrink: 0, color: KIND_COLOR[kind] }}>{getFileIcon(item.path || item.name, { fontSize: 16 })}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Typography.Text style={{ fontSize: 13 }} ellipsis>{item.name}</Typography.Text>
                        <div>
                          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                            {formatBytes(item.size)}{item.mtime ? ` · ${item.mtime}` : ''}
                          </Typography.Text>
                        </div>
                      </div>
                      <Button size="small" type="primary" ghost icon={<DownloadOutlined />} href={fileUrl} target="_blank" rel="noreferrer">
                        {t('download')}
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </Drawer>
        )}

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
