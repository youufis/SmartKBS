import React, { useState, useEffect, useRef } from 'react'
import { Layout, Card, Space, Button, message, Tree, Modal, Typography, Dropdown, Tooltip, Input, Tabs } from 'antd'
import { UploadOutlined, DeleteOutlined, ReloadOutlined, FileOutlined, FolderOutlined, FolderOpenOutlined, EditOutlined } from '@ant-design/icons'
import * as resourcesApi from '../api/resources'
import apiClient from '../api/client'
import type { TreeNode } from '../types'
import { useAuthStore } from '../stores/authStore'


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
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography.Title level={4} style={{ margin: 0 }}>⚙️ 资源管理</Typography.Title>
                <Button icon={<ReloadOutlined />} onClick={loadTree} loading={loading}>刷新</Button>
              </div>
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
              {treeData.length > 0 && (
                <Card size="small" title="📁 目录结构">
                  <Tree treeData={treeData} showLine defaultExpandAll={false}
                    titleRender={(node: any) => (
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', overflow: 'hidden' }} className="resource-tree-node">
                        {node.isLeaf ? <FileOutlined /> : <FolderOutlined />}
                        <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{node.title}</span>
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
