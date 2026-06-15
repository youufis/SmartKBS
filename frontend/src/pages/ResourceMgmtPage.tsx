import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Layout, Card, Space, Button, message, Tree, Modal, Typography, Dropdown, Tooltip, Input, Tabs, Tag, Empty, Segmented } from 'antd'
import { UploadOutlined, DeleteOutlined, ReloadOutlined, FileOutlined, FolderOutlined, FolderOpenOutlined, EditOutlined, SearchOutlined, AppstoreOutlined, UnorderedListOutlined, FileTextOutlined, CodeOutlined, FilePdfOutlined, FileImageOutlined, FileZipOutlined, FileUnknownOutlined } from '@ant-design/icons'
import * as resourcesApi from '../api/resources'
import apiClient from '../api/client'
import type { TreeNode } from '../types'
import { useAuthStore } from '../stores/authStore'

// 展平树节点为文件列表
function flattenTree(nodes: TreeNode[], basePath = ''): { name: string; path: string; isLeaf: boolean }[] {
  const result: { name: string; path: string; isLeaf: boolean }[] = []
  for (const node of nodes) {
    const fullPath = basePath ? `${basePath}/${node.title}` : node.title
    if (node.isLeaf) {
      result.push({ name: node.title, path: node.key || fullPath, isLeaf: true })
    }
    if (node.children) {
      result.push(...flattenTree(node.children, fullPath))
    }
  }
  return result
}

// 根据扩展名获取文件图标
function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const iconMap: Record<string, React.ReactNode> = {
    html: <FileTextOutlined style={{ color: '#e44d26' }} />,
    htm: <FileTextOutlined style={{ color: '#e44d26' }} />,
    css: <CodeOutlined style={{ color: '#264de4' }} />,
    js: <CodeOutlined style={{ color: '#f7df1e' }} />,
    ts: <CodeOutlined style={{ color: '#3178c6' }} />,
    tsx: <CodeOutlined style={{ color: '#3178c6' }} />,
    jsx: <CodeOutlined style={{ color: '#61dafb' }} />,
    py: <CodeOutlined style={{ color: '#3776ab' }} />,
    json: <CodeOutlined style={{ color: '#292929' }} />,
    md: <FileTextOutlined style={{ color: '#083fa1' }} />,
    pdf: <FilePdfOutlined style={{ color: '#f40f02' }} />,
    png: <FileImageOutlined style={{ color: '#00a98f' }} />,
    jpg: <FileImageOutlined style={{ color: '#00a98f' }} />,
    jpeg: <FileImageOutlined style={{ color: '#00a98f' }} />,
    gif: <FileImageOutlined style={{ color: '#00a98f' }} />,
    svg: <FileImageOutlined style={{ color: '#ffb13b' }} />,
    zip: <FileZipOutlined style={{ color: '#ebc441' }} />,
    rar: <FileZipOutlined style={{ color: '#ebc441' }} />,
    doc: <FileTextOutlined style={{ color: '#2b579a' }} />,
    docx: <FileTextOutlined style={{ color: '#2b579a' }} />,
    xls: <FileTextOutlined style={{ color: '#217346' }} />,
    xlsx: <FileTextOutlined style={{ color: '#217346' }} />,
    ppt: <FileTextOutlined style={{ color: '#d24726' }} />,
    pptx: <FileTextOutlined style={{ color: '#d24726' }} />,
  }
  return iconMap[ext] || <FileUnknownOutlined style={{ color: '#999' }} />
}


const ResourceMgmtPage: React.FC = () => {
  const user = useAuthStore((s: { user: { role: string } | null }) => s.user)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)

  const loadTree = async () => {
    setLoading(true)
    try {
      const res = await resourcesApi.getResourceTree()
      setTreeData(res.tree)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTree() }, [])

  // 上传单文件/多文件
  const uploadFiles = async (fileList: FileList | File[], basePath = '') => {
    const total = fileList.length
    const formData = new FormData()
    for (let i = 0; i < total; i++) {
      const file = fileList[i]
      formData.append(`file${i}`, file, file.name)
      // 子目录路径
      const relPath = (file as any).webkitRelativePath || ''
      const dirPath = relPath ? relPath.substring(0, relPath.lastIndexOf('/')) : basePath
      formData.append(`path${i}`, dirPath)
    }
    try {
      const { data } = await apiClient.post('/api/resources/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      if (data.errors?.length > 0) {
        message.warning(`${data.message}，${data.errors.length} 个错误`)
      } else {
        message.success(data.message || `成功上传 ${total} 个文件`)
      }
      loadTree()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '上传失败')
    }
  }

  // 选择文件上传
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return
    uploadFiles(e.target.files)
    e.target.value = ''
  }

  // 选择目录上传
  const handleDirSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return
    uploadFiles(e.target.files)
    e.target.value = ''
  }

  const handleDelete = (path: string) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定删除此文件/目录？',
      onOk: async () => {
        try {
          const msg = await resourcesApi.deleteResource(path)
          message.success(msg)
          loadTree()
        } catch (err: any) {
          message.error(err?.response?.data?.detail || '删除失败')
        }
      },
    })
  }

  // ── 重命名 ──
  const [renameModal, setRenameModal] = useState(false)
  const [renamePath, setRenamePath] = useState('')
  const [renameOld, setRenameOld] = useState('')
  const [renameNew, setRenameNew] = useState('')

  const handleRename = async () => {
    if (!renameNew.trim()) { message.warning('名称不能为空'); return }
    try {
      const msg = await resourcesApi.renameResource(renamePath, renameNew.trim())
      message.success(msg)
      setRenameModal(false)
      loadTree()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '重命名失败')
    }
  }

  const openRename = (path: string, oldName: string) => {
    setRenamePath(path)
    setRenameOld(oldName)
    setRenameNew(oldName)
    setRenameModal(true)
  }

  // ── 视图切换 & 搜索 ──
  const [viewMode, setViewMode] = useState<'tree' | 'grid'>('tree')
  const [searchText, setSearchText] = useState('')

  // 展平所有文件用于 grid 视图
  const allFiles = useMemo(() => {
    const files = flattenTree(treeData)
    if (!searchText.trim()) return files
    const kw = searchText.trim().toLowerCase()
    return files.filter(f => f.name.toLowerCase().includes(kw))
  }, [treeData, searchText])

  // 搜索过滤后的树节点
  const filteredTree = useMemo(() => {
    if (!searchText.trim()) return treeData
    const kw = searchText.trim().toLowerCase()

    function filterNode(node: TreeNode): TreeNode | null {
      const match = node.title.toLowerCase().includes(kw)
      const filteredChildren = node.children
        ?.map(filterNode)
        .filter(Boolean) as TreeNode[] | undefined

      if (match || (filteredChildren && filteredChildren.length > 0)) {
        return { ...node, children: filteredChildren || node.children }
      }
      return null
    }

    return treeData.map(filterNode).filter(Boolean) as TreeNode[]
  }, [treeData, searchText])

  if (!isAdminOrTeacher) {
    return (
      <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, padding: 24 }}>
        <Typography.Text type="secondary">仅管理员和教师可访问资源管理</Typography.Text>
      </Layout>
    )
  }

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Tabs defaultActiveKey="files" items={[
        {
          key: 'files',
          label: <Space><FolderOutlined />文件管理</Space>,
          children: (
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {/* 顶部栏：标题 + 搜索 + 视图切换 + 刷新 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <Typography.Title level={4} style={{ margin: 0 }}>⚙️ 资源管理</Typography.Title>
                <Space wrap>
                  <Input
                    placeholder="搜索文件/目录..."
                    prefix={<SearchOutlined />}
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    allowClear
                    style={{ width: 220 }}
                  />
                  <Segmented
                    value={viewMode}
                    onChange={(v) => setViewMode(v as 'tree' | 'grid')}
                    options={[
                      { value: 'tree', icon: <UnorderedListOutlined /> },
                      { value: 'grid', icon: <AppstoreOutlined /> },
                    ]}
                  />
                  <Button icon={<ReloadOutlined />} onClick={loadTree} loading={loading}>刷新</Button>
                </Space>
              </div>

              {/* 上传区域 */}
              <Card size="small">
                <Space wrap>
                  <input ref={fileInputRef} type="file" multiple
                    onChange={handleFileSelect} style={{ display: 'none' }} />
                  <input ref={dirInputRef} type="file" multiple
                    {...({ webkitdirectory: '', directory: '' } as any)}
                    onChange={handleDirSelect} style={{ display: 'none' }} />
                  <Dropdown.Button type="primary" icon={<UploadOutlined />}
                    menu={{
                      items: [{ key: 'dir', icon: <FolderOpenOutlined />, label: '上传目录' }],
                      onClick: ({ key }) => { if (key === 'dir') dirInputRef.current?.click() },
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >上传文件</Dropdown.Button>
                </Space>
              </Card>

              {/* 搜索结果提示 */}
              {searchText.trim() && (
                <Typography.Text type="secondary">
                  搜索 &quot;{searchText.trim()}&quot; 共 {viewMode === 'tree'
                    ? filteredTree.reduce((n, node) => n + (node.children?.length || 0) + 1, 0)
                    : allFiles.length} 个结果
                </Typography.Text>
              )}

              {/* 树视图 */}
              {viewMode === 'tree' && (
                filteredTree.length > 0 ? (
                  <Card size="small" title="📁 目录结构">
                    <Tree treeData={filteredTree} showLine defaultExpandAll={!!searchText.trim()}
                      titleRender={(node: any) => (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', overflow: 'hidden' }} className="resource-tree-node">
                          {node.isLeaf ? getFileIcon(node.title) : <FolderOutlined />}
                          <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{node.title}</span>
                          {node.isLeaf && node.size && (
                            <Tag style={{ marginLeft: 4, lineHeight: '18px', fontSize: 11, border: 'none' }}>
                              {node.size < 1024 ? `${node.size}B` : node.size < 1048576 ? `${(node.size / 1024).toFixed(1)}KB` : `${(node.size / 1048576).toFixed(1)}MB`}
                            </Tag>
                          )}
                          <span onClick={(e) => e.stopPropagation()} className="resource-tree-actions" style={{ flexShrink: 0, whiteSpace: 'nowrap', opacity: 0, transition: 'opacity 0.2s' }}>
                            <Tooltip title="重命名">
                              <Button type="link" size="small" icon={<EditOutlined />}
                                onClick={() => openRename(node.key, node.title)} />
                            </Tooltip>
                            <Tooltip title="删除">
                              <Button type="link" size="small" danger icon={<DeleteOutlined />}
                                onClick={() => handleDelete(node.key)} />
                            </Tooltip>
                          </span>
                        </div>
                      )}
                    />
                  </Card>
                ) : (
                  <Empty description={searchText ? '未找到匹配的文件' : '暂无文件'} />
                )
              )}

              {/* 网格视图 */}
              {viewMode === 'grid' && (
                allFiles.length > 0 ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                    {allFiles.map((file) => (
                      <Card
                        key={file.path}
                        size="small"
                        hoverable
                        styles={{ body: { padding: 16, textAlign: 'center' as const } }}
                        actions={[
                          <Tooltip title="重命名" key="rename">
                            <EditOutlined onClick={() => openRename(file.path, file.name)} />
                          </Tooltip>,
                          <Tooltip title="删除" key="delete">
                            <DeleteOutlined style={{ color: '#ff4d4f' }} onClick={() => handleDelete(file.path)} />
                          </Tooltip>,
                        ]}
                      >
                        <div style={{ fontSize: 36, lineHeight: 1, marginBottom: 8 }}>
                          {getFileIcon(file.name)}
                        </div>
                        <Tooltip title={file.name}>
                          <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {file.name}
                          </div>
                        </Tooltip>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Empty description={searchText ? '未找到匹配的文件' : '暂无文件'} />
                )
              )}
            </Space>
          ),
        },
      ]} />

      {/* 重命名弹窗 */}
      <Modal title="重命名" open={renameModal}
        onOk={handleRename} onCancel={() => setRenameModal(false)}
        okText="确认" cancelText="取消">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">原名称：{renameOld}</Typography.Text>
          <Input value={renameNew} onChange={(e) => setRenameNew(e.target.value)}
            onPressEnter={handleRename} placeholder="输入新名称" />
        </Space>
      </Modal>

      <style>{`
        .guide-markdown-content h1 { font-size: 1.6em; margin-top: 1.2em; margin-bottom: 0.5em; padding-bottom: 0.3em; border-bottom: 1px solid #eee; }
        .guide-markdown-content h2 { font-size: 1.35em; margin-top: 1.2em; margin-bottom: 0.5em; }
        .guide-markdown-content h3 { font-size: 1.15em; margin-top: 1em; }
        .guide-markdown-content p { line-height: 1.8; margin-bottom: 0.8em; color: #333; }
        .guide-markdown-content code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; color: #d63384; }
        .guide-markdown-content pre { background: #1e1e1e; color: #d4d4d4; padding: 16px; border-radius: 6px; overflow-x: auto; margin: 12px 0; }
        .guide-markdown-content pre code { background: none; color: inherit; padding: 0; font-size: 0.88em; }
        .guide-markdown-content table { border-collapse: collapse; width: 100%; margin: 12px 0; }
        .guide-markdown-content th, .guide-markdown-content td { border: 1px solid #e0e0e0; padding: 8px 12px; text-align: left; }
        .guide-markdown-content th { background: #fafafa; font-weight: 600; }
        .guide-markdown-content ul, .guide-markdown-content ol { line-height: 1.8; padding-left: 2em; margin-bottom: 0.8em; }
        .guide-markdown-content blockquote { border-left: 4px solid #8b5cf6; padding: 8px 16px; margin: 12px 0; background: #f8f6ff; color: #555; }
        .guide-markdown-content hr { border: none; border-top: 1px solid #eee; margin: 1.5em 0; }
        .guide-markdown-content img { max-width: 100%; }
        .resource-tree-node:hover .resource-tree-actions {
          opacity: 1 !important;
        }
      `}</style>
    </Layout>
  )
}

export default ResourceMgmtPage
