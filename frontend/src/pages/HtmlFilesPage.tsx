import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Layout, Card, Space, Button, Typography, message, Tabs, Tag, Tooltip, Pagination, Modal, Input, Popconfirm } from 'antd'
import { ReloadOutlined, FileOutlined, ShareAltOutlined, FolderOutlined, PlusOutlined, DeleteOutlined, EditOutlined, InboxOutlined, MinusCircleOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons'
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

  // ── 分页状态 ──
  const PAGE_SIZE = 24
  const [groupPages, setGroupPages] = useState<Record<string, number>>({})
  const [sharedPage, setSharedPage] = useState(1)

  const getGroupPage = (groupId: number | null) => {
    const key = groupId === null ? '__ungrouped__' : `g${groupId}`
    return groupPages[key] || 1
  }

  const setGroupPage = (groupId: number | null, page: number) => {
    const key = groupId === null ? '__ungrouped__' : `g${groupId}`
    setGroupPages(prev => ({ ...prev, [key]: page }))
  }

  // ── 搜索 ──
  const [searchText, setSearchText] = useState('')

  // 搜索时重置分页
  useEffect(() => {
    setSharedPage(1)
  }, [searchText])

  // ── 分组状态 ──
  const [groups, setGroups] = useState<resourcesApi.ResourceGroup[]>([])
  const [activeGroup, setActiveGroup] = useState<number | null>(() => {
    const saved = localStorage.getItem('resource_active_group')
    return saved ? parseInt(saved, 10) : null
  })
  const [groupModalOpen, setGroupModalOpen] = useState(false)
  const [groupModalTitle, setGroupModalTitle] = useState('')
  const [editingGroup, setEditingGroup] = useState<resourcesApi.ResourceGroup | null>(null)
  const [groupInput, setGroupInput] = useState('')
  const [dragOverGroup, setDragOverGroup] = useState<number | null>(null) // 资源拖入：存 group_id
  const [groupCollapsed, setGroupCollapsed] = useState(false) // 分组列表折叠

  // ── 拖拽状态 ──
  const [draggedFile, setDraggedFile] = useState<string | null>(null)
  const dragGroupIndexRef = useRef<number | null>(null) // 分组拖拽：源位置 index
  const dragGroupTargetRef = useRef<number | null>(null) // 分组拖拽：目标位置 index
  const dragGroupsRef = useRef<resourcesApi.ResourceGroup[]>([]) // 拖拽中的分组顺序

  // 初始化 ref
  useEffect(() => {
    dragGroupsRef.current = groups
  }, [groups])

  // 记住当前分组
  useEffect(() => {
    if (activeGroup === null) {
      localStorage.removeItem('resource_active_group')
    } else {
      localStorage.setItem('resource_active_group', String(activeGroup))
    }
  }, [activeGroup])

  const loadData = async () => {
    setLoading(true)
    try {
      if (isAdminOrTeacher) {
        const [res, shareRes, myRes, groupsRes] = await Promise.all([
          resourcesApi.listResources(),
          sharingApi.getReceivedShares(),
          sharingApi.getMyShares(),
          resourcesApi.listGroups(),
        ])
        setFiles(res.files)
        setMyShares(myRes.shares)
        setReceivedShares(shareRes.shares.filter(s => s.resource_type === 'html'))
        setGroups(groupsRes.groups)
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

  const isFileShared = (nodeKey: string) => myShares.some(s => s.file_path === nodeKey)

  const openShare = (filePath: string, fileName: string) => {
    setShareFile({ path: filePath, name: fileName })
    setShareExisting(myShares.find(s => s.file_path === filePath) || null)
    setShareDialogOpen(true)
  }

  // ── 获取所有已分组的文件路径集合 ──
  const getAllGroupedPaths = useCallback((): Set<string> => {
    const paths = new Set<string>()
    groups.forEach(g => g.files.forEach(fp => paths.add(fp)))
    return paths
  }, [groups])

  // ── 获取某个分组的文件路径集合 ──
  const getGroupFilePaths = useCallback((groupId: number): Set<string> => {
    const g = groups.find(gr => gr.id === groupId)
    return new Set(g?.files || [])
  }, [groups])

  // ── 根据当前分组过滤文件 ──
  const groupedPaths = getAllGroupedPaths()
  const kw = searchText.trim().toLowerCase()
  const filteredFiles = (activeGroup === null
    ? files.filter(f => !groupedPaths.has(f.url_path || f.name))  // 全部 = 未分组的
    : files.filter(f => getGroupFilePaths(activeGroup).has(f.url_path || f.name))
  ).filter(f => !kw || (f.display_name || f.name).toLowerCase().includes(kw))

  // ── 分组管理 ──
  const openCreateGroup = () => {
    setEditingGroup(null)
    setGroupModalTitle('新建分组')
    setGroupInput('')
    setGroupModalOpen(true)
  }

  const openRenameGroup = (g: resourcesApi.ResourceGroup) => {
    setEditingGroup(g)
    setGroupModalTitle('重命名分组')
    setGroupInput(g.group_name)
    setGroupModalOpen(true)
  }

  const handleGroupSubmit = async () => {
    const name = groupInput.trim()
    if (!name) { message.warning('请输入分组名称'); return }
    try {
      if (editingGroup) {
        await resourcesApi.renameGroup(editingGroup.id, name)
        message.success('分组已重命名')
      } else {
        await resourcesApi.createGroup(name)
        message.success('分组已创建')
      }
      setGroupModalOpen(false)
      await loadData()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      message.error(err?.response?.data?.detail || err?.message || '操作失败')
    }
  }

  const handleDeleteGroup = async (g: resourcesApi.ResourceGroup) => {
    try {
      await resourcesApi.deleteGroup(g.id)
      message.success('分组已删除')
      if (activeGroup === g.id) setActiveGroup(null)
      await loadData()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      message.error(err?.response?.data?.detail || err?.message || '删除失败')
    }
  }

  // ── 拖拽处理 ──
  const handleDragStart = (e: React.DragEvent, filePath: string) => {
    setDraggedFile(filePath)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', filePath)
  }

  const handleDragOver = (e: React.DragEvent, groupId: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverGroup(groupId)
  }

  const handleDragLeave = () => {
    setDragOverGroup(null)
  }

  const handleDrop = async (e: React.DragEvent, groupId: number) => {
    e.preventDefault()
    setDragOverGroup(null)
    const filePath = e.dataTransfer.getData('text/plain') || draggedFile
    if (!filePath) return

    try {
      // 先检查是否已在分组中
      const g = groups.find(gr => gr.id === groupId)
      if (g?.files.includes(filePath)) {
        message.info('该资源已在此分组中')
        return
      }
      await resourcesApi.addToGroup(groupId, filePath)
      message.success('已添加到分组')
      await loadData()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      message.error(err?.response?.data?.detail || err?.message || '添加失败')
    }
    setDraggedFile(null)
  }

  const handleRemoveFromGroup = async (filePath: string) => {
    if (activeGroup === null) return
    try {
      await resourcesApi.removeFromGroup(activeGroup, filePath)
      message.success('已从分组移除')
      await loadData()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string }
      message.error(err?.response?.data?.detail || err?.message || '移除失败')
    }
  }

  // ── 分组拖拽排序 ──
  const handleGroupDragStart = (e: React.DragEvent, index: number) => {
    dragGroupIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', 'group-drag')
    console.log('🔵 group drag start:', index)
  }

  const handleGroupDrop = async (e: React.DragEvent, targetIdx: number) => {
    e.preventDefault()
    const fromIdx = dragGroupIndexRef.current
    console.log('🟢 group drop: from=', fromIdx, 'to=', targetIdx)
    dragGroupIndexRef.current = null
    if (fromIdx === null || fromIdx === targetIdx) return

    const arr = [...dragGroupsRef.current]
    const [moved] = arr.splice(fromIdx, 1)
    arr.splice(targetIdx, 0, moved)
    setGroups(arr)
    dragGroupsRef.current = arr

    const groupIds = arr.map(g => g.id)
    try {
      await resourcesApi.reorderGroups(groupIds)
    } catch {
      await loadData()
    }
  }

  const isStudent = user?.role === 'student'

  const handleOpenResource = (urlPath: string, name: string, owner?: string, resourceId?: number) => {
    // 学生查看时记录追踪事件
    if (isStudent) {
      import('../api/tracking').then(mod => {
        mod.logResourceView({
          resource_type: name.endsWith('.html') || name.endsWith('.htm') ? 'html' : 'download',
          resource_id: resourceId || 0,
          source: 'sharing',
          file_path: urlPath,
          owner_username: owner || '',
        });
      });
    }
    window.open(`/api/files/${urlPath}`, '_blank');
  }

  const renderFileCard = (name: string, urlPath: string, isShared: boolean, owner?: string, showShareBtn = false, showGroupActions = false, resourceId?: number) => (
    <Card
      key={urlPath}
      size="small"
      hoverable
      draggable
      onDragStart={(e) => handleDragStart(e, urlPath)}
      style={{ fontSize: 14, cursor: 'pointer' }}
      className="resource-file-card"
      onClick={() => {
        if (isShared) {
          handleOpenResource(urlPath, name, owner, resourceId)
        } else {
          window.open(`/api/files/${urlPath}`, '_blank')
        }
      }}
    >
      <Card.Meta
        avatar={<FileOutlined style={{ fontSize: 16, color: isShared ? '#ff4d4f' : undefined }} />}
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, fontSize: 14, color: isShared ? '#1677ff' : undefined }}>
              {name}
            </span>
            {showShareBtn && (
              <Tooltip title={isFileShared(urlPath) ? '已共享 - 点击取消共享' : '点击共享'}>
                <ShareAltOutlined
                  style={{ color: isFileShared(urlPath) ? '#ff4d4f' : '#999', cursor: 'pointer', fontSize: 14, flexShrink: 0 }}
                  onClick={(e) => { e.preventDefault(); openShare(urlPath, name); }}
                />
              </Tooltip>
            )}
            {showGroupActions && activeGroup !== null && (
              <Tooltip title="移出分组">
                <MinusCircleOutlined
                  style={{ color: '#999', cursor: 'pointer', fontSize: 13, flexShrink: 0, opacity: 0, transition: 'opacity 0.2s' }}
                  className="resource-card-remove-btn"
                  onClick={(e) => { e.preventDefault(); handleRemoveFromGroup(urlPath); }}
                />
              </Tooltip>
            )}
          </div>
        }
        description={
          <Space size={4}>
            {isShared && owner ? <Tag color="blue" style={{ fontSize: 11 }}>来自 {owner}</Tag> : null}
          </Space>
        }
      />
    </Card>
  )

  const sharedItems = receivedShares
    .filter(s => !kw || (s.file_name || '').toLowerCase().includes(kw))
    .map(s => ({
      id: s.id,
      name: s.file_name,
      urlPath: s.url_path || s.file_path,
      owner: s.owner_username,
    }))

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 20, fontSize: 14 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={14}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Typography.Title level={5} style={{ margin: 0, fontSize: 18 }}>
            {isAdminOrTeacher ? '📄 资源中心' : '📄 共享资源'}
          </Typography.Title>
          <Space>
            <Input
              placeholder="搜索资源名称..."
              prefix={<SearchOutlined />}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
              style={{ width: 220 }}
            />
            <Button icon={<ReloadOutlined />} onClick={loadData} loading={loading}>刷新</Button>
          </Space>
        </div>

        {isAdminOrTeacher ? (
          <Tabs defaultActiveKey="mine" onChange={() => { setGroupPages({}); setSharedPage(1); setActiveGroup(null); }} items={[
            {
              key: 'mine',
              label: <span><FileOutlined /> 我的资源</span>,
              children: (
                <div style={{ display: 'flex', gap: 16 }}>
                  {/* 左侧分组列表 */}
                  <div style={{ width: groupCollapsed ? 40 : 200, flexShrink: 0, transition: 'width 0.3s' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      {!groupCollapsed && <Typography.Text strong style={{ fontSize: 13 }}>资源分组</Typography.Text>}
                      <Space size={2}>
                        {!groupCollapsed && <Button type="link" size="small" icon={<PlusOutlined />} onClick={openCreateGroup} />}
                        <Button type="text" size="small"
                          icon={groupCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                          onClick={() => setGroupCollapsed(!groupCollapsed)}
                          title={groupCollapsed ? '展开分组' : '折叠分组'}
                        />
                      </Space>
                    </div>
                    {!groupCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div
                        onClick={() => setActiveGroup(null)}
                        onDragOver={(e) => { e.preventDefault(); setDragOverGroup(-1); }}
                        onDragLeave={handleDragLeave}
                        onDrop={(e) => {
                          e.preventDefault(); setDragOverGroup(null);
                          // 分组拖拽到未分组，忽略
                          if (dragGroupIndexRef.current !== null) { dragGroupIndexRef.current = null; return }
                          const fp = e.dataTransfer.getData('text/plain') || draggedFile;
                          if (fp) { message.info('资源已在全部列表中'); setDraggedFile(null); }
                        }}
                        style={{
                          padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                          background: activeGroup === null ? '#e6f4ff' : 'transparent',
                          color: activeGroup === null ? '#1677ff' : '#333',
                          border: dragOverGroup === -1 ? '2px dashed #1677ff' : '2px solid transparent',
                          transition: 'all 0.2s',
                        }}
                      >
                          <InboxOutlined style={{ marginRight: 6 }} />未分组 ({files.filter(f => !getAllGroupedPaths().has(f.url_path || f.name)).length})
                      </div>
                      {groups.map((g, idx) => (
                        <div
                          key={g.id}
                          draggable
                          onClick={() => setActiveGroup(g.id)}
                          onDragStart={(e) => handleGroupDragStart(e, idx)}
                          onDragOver={(e) => {
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            // 如果是分组拖拽（ref不为null），记录目标位置
                            if (dragGroupIndexRef.current !== null) {
                              dragGroupTargetRef.current = idx
                            } else {
                              // 否则是资源拖入
                              handleDragOver(e, g.id)
                            }
                          }}
                          onDragLeave={() => setDragOverGroup(null)}
                          onDrop={(e) => {
                            e.preventDefault()
                            setDragOverGroup(null)
                            // 如果是分组拖拽，走排序
                            if (dragGroupIndexRef.current !== null) {
                              handleGroupDrop(e, idx)
                            } else {
                              // 否则是资源拖入
                              handleDrop(e, g.id)
                            }
                          }}
                          onDragEnd={() => { dragGroupIndexRef.current = null }}
                          className="resource-group-item"
                          style={{
                            padding: '6px 10px', borderRadius: 6, cursor: 'grab', fontSize: 13,
                            background: activeGroup === g.id ? '#e6f4ff'
                              : dragOverGroup === g.id ? '#f0f5ff'
                              : 'transparent',
                            color: activeGroup === g.id ? '#1677ff' : '#333',
                            border: dragOverGroup === g.id ? '2px dashed #1677ff' : '2px solid transparent',
                            transition: 'all 0.2s',
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          }}
                        >
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            <FolderOutlined style={{ marginRight: 6 }} />{g.group_name} ({g.files.length})
                          </span>
                          <span onClick={(e) => e.stopPropagation()} className="resource-group-actions" style={{ flexShrink: 0, display: 'flex', gap: 2, opacity: 0, transition: 'opacity 0.2s' }}>
                            <Tooltip title="重命名">
                              <EditOutlined style={{ fontSize: 11, cursor: 'pointer', color: '#999' }}
                                onClick={() => openRenameGroup(g)} />
                            </Tooltip>
                            <Popconfirm title="确认删除此分组？资源文件不会被删除" onConfirm={() => handleDeleteGroup(g)}>
                              <DeleteOutlined style={{ fontSize: 11, cursor: 'pointer', color: '#999' }} />
                            </Popconfirm>
                          </span>
                        </div>
                      ))}
                      {groups.length === 0 && (
                        <Typography.Text type="secondary" style={{ fontSize: 12, padding: '8px 10px' }}>
                          暂无分组，点击 + 创建
                        </Typography.Text>
                      )}
                    </div>
                    )}
                  </div>

                  {/* 右侧资源卡片 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
                      {(() => {
                        const currentPage = getGroupPage(activeGroup)
                        return filteredFiles.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((f) =>
                          renderFileCard(f.display_name, f.url_path || f.name, false, undefined, true, true)
                        )
                      })()}
                      {filteredFiles.length === 0 && (
                        <Typography.Text type="secondary">
                          {activeGroup !== null ? '该分组暂无资源，拖动资源到左侧分组名称上即可归类' : '暂无资源文件'}
                        </Typography.Text>
                      )}
                    </div>
                    {(() => {
                      const currentPage = getGroupPage(activeGroup)
                      return (
                        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                          <Pagination
                            current={currentPage}
                            total={filteredFiles.length}
                            pageSize={PAGE_SIZE}
                            onChange={(p) => setGroupPage(activeGroup, p)}
                            showSizeChanger
                            showTotal={(t) => `共 ${t} 个资源`}
                            pageSizeOptions={['10', '20', '50']}
                          />
                        </div>
                      )
                    })()}
                  </div>
                </div>
              ),
            },
            {
              key: 'shared',
              label: <span><ShareAltOutlined /> 共享给我的 ({sharedItems.length})</span>,
              children: (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                      {sharedItems.slice((sharedPage - 1) * PAGE_SIZE, sharedPage * PAGE_SIZE).map((item) => renderFileCard(item.name, item.urlPath, true, item.owner, false, false, item.id))}
                    {sharedItems.length === 0 && <Typography.Text type="secondary">暂无共享资源</Typography.Text>}
                  </div>
                  {sharedItems.length > PAGE_SIZE && (
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                      <Pagination
                        current={sharedPage}
                        total={sharedItems.length}
                        pageSize={PAGE_SIZE}
                        onChange={(p) => setSharedPage(p)}
                        showSizeChanger={false}
                        showTotal={(t) => `共 ${t} 个资源`}
                      />
                    </div>
                  )}
                </>
              ),
            },
          ]} />
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
              {sharedItems.slice((sharedPage - 1) * PAGE_SIZE, sharedPage * PAGE_SIZE).map((item) => renderFileCard(item.name, item.urlPath, true, item.owner, false, false, item.id))}
              {sharedItems.length === 0 && <Typography.Text type="secondary">暂无共享资源</Typography.Text>}
            </div>
            {sharedItems.length > PAGE_SIZE && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                <Pagination
                  current={sharedPage}
                  total={sharedItems.length}
                  pageSize={PAGE_SIZE}
                  showSizeChanger
                  showTotal={(t) => `共 ${t} 个资源`}
                  pageSizeOptions={['10', '20', '50']}
                  onChange={(p) => setSharedPage(p)}
                />
              </div>
            )}
          </>
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

        {/* 新建/重命名分组弹窗 */}
        <Modal
          title={groupModalTitle}
          open={groupModalOpen}
          onOk={handleGroupSubmit}
          onCancel={() => setGroupModalOpen(false)}
          okText="确认"
          cancelText="取消"
        >
          <Input
            value={groupInput}
            onChange={(e) => setGroupInput(e.target.value)}
            onPressEnter={handleGroupSubmit}
            placeholder="请输入分组名称"
            autoFocus
          />
        </Modal>
      </Space>

      <style>{`
        .resource-file-card:hover {
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .resource-file-card:hover .resource-card-remove-btn {
          opacity: 1 !important;
        }
        .resource-file-card:active {
          cursor: grabbing !important;
        }
        .resource-group-item:hover .resource-group-actions {
          opacity: 1 !important;
        }
      `}</style>
    </Layout>
  )
}

export default HtmlFilesPage
