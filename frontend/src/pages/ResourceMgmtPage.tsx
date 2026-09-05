import React, { useState, useEffect, useRef, useMemo } from 'react'
import { Layout, Card, Space, Button, message, Tree, Modal, Typography, Dropdown, Tooltip, Input, Tabs, Tag, Empty, Segmented, Select, Radio, Switch, Pagination } from 'antd'
import { UploadOutlined, DeleteOutlined, ReloadOutlined, FolderOutlined, FolderOpenOutlined, EditOutlined, SearchOutlined, AppstoreOutlined, UnorderedListOutlined, BulbOutlined, LoadingOutlined, EyeOutlined } from '@ant-design/icons'
import * as resourcesApi from '../api/resources'
import apiClient from '../api/client'
import type { TreeNode } from '../types'
import { getFileIcon } from '../utils/fileIcon'
import { useAuthStore } from '../stores/authStore'
import { useTranslation } from 'react-i18next'

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


const ResourceMgmtPage: React.FC = () => {
  const { t } = useTranslation('common')
  const user = useAuthStore((s: { user: { role: string; username: string } | null }) => s.user)
  const isAdminOrTeacher = user?.role === 'admin' || user?.role === 'teacher'
  const username = user?.username || ''
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
      message.error(t('loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const res = await resourcesApi.getResourceTree()
        setTreeData(res.tree)
      } catch {
        message.error(t('loadFailed'))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

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
        message.warning(t('resource.uploadErrors', { msg: data.message, count: data.errors.length }))
      } else {
        message.success(data.message || t('resource.uploadSuccess', { count: total }))
      }
      loadTree()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('uploadFailed'))
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
      title: t('resource.confirmDeleteTitle'),
      content: t('resource.confirmDeleteContent'),
      onOk: async () => {
        try {
          const msg = await resourcesApi.deleteResource(path)
          message.success(msg)
          loadTree()
        } catch (err: any) {
          message.error(err?.response?.data?.detail || t('deleteFailed'))
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
    if (!renameNew.trim()) { message.warning(t('nameRequired')); return }
    try {
      const msg = await resourcesApi.renameResource(renamePath, renameNew.trim())
      message.success(msg)
      setRenameModal(false)
      loadTree()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('renameFailed'))
    }
  }

  const openRename = (path: string, oldName: string) => {
    setRenamePath(path)
    setRenameOld(oldName)
    setRenameNew(oldName)
    setRenameModal(true)
  }

  // ── AI 生成 HTML ──
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiGenType, setAiGenType] = useState<'animation' | 'quiz' | 'practice' | 'custom' | 'interactive'>('animation')
  const [aiTopic, setAiTopic] = useState('')
  const [aiSubject, setAiSubject] = useState('')
  const [aiGrade, setAiGrade] = useState('')
  const [aiCustomPrompt, setAiCustomPrompt] = useState('')
  const [aiWorking, setAiWorking] = useState(false)  // 生成+保存中
  const [aiDone, setAiDone] = useState<{ fileUrl: string; fileName: string } | null>(null)
  // ── 主题选择 ──
  const [aiThemes, setAiThemes] = useState<resourcesApi.AiTheme[]>([])
  const [aiTheme, setAiTheme] = useState('')
  // ── 学科/年级动态选项 ──
  const [aiSubjectOptions, setAiSubjectOptions] = useState<string[]>([])
  const [aiGradeOptions, setAiGradeOptions] = useState<string[]>([])
  // ── 交互式实验专用状态 ──
  const [aiExpCategory, setAiExpCategory] = useState<string>('algorithm')
  // ── 配图增强开关 ──
  const [enableMediaGen, setEnableMediaGen] = useState(true)

  // 打开弹窗时加载学科、年级、主题
  useEffect(() => {
    if (!aiModalOpen) return
    apiClient.get('/api/config/subjects').then(({ data }) => {
      if (data?.subjects?.length > 0) setAiSubjectOptions(data.subjects)
    }).catch(() => {})
    apiClient.get('/api/scores/my-grades').then(({ data }) => {
      // 返回格式: string[]，如 ["高一", "高二"]
      if (Array.isArray(data) && data.length > 0) {
        setAiGradeOptions(data)
      }
    }).catch(() => {})
    // 加载当前类型的主题
    resourcesApi.getAiThemes(aiGenType).then(themes => {
      setAiThemes(themes)
      if (themes.length > 0) setAiTheme(themes[0].id)
    }).catch(() => {})
  }, [aiModalOpen, aiGenType])

  // 切换类型时加载主题
  const handleAiTypeChange = (type: 'animation' | 'quiz' | 'practice' | 'custom' | 'interactive') => {
    setAiGenType(type)
    resourcesApi.getAiThemes(type).then(themes => {
      setAiThemes(themes)
      if (themes.length > 0) setAiTheme(themes[0].id)
    }).catch(() => {})
  }

  // ── AI 生成+保存（一步完成）──
  const handleAiGenerate = async () => {
    setAiWorking(true)
    setAiDone(null)
    try {
      // 构建通用参数
      const params: resourcesApi.AiPreviewParams = {
        type: aiGenType,
        topic: aiTopic,
        subject: aiSubject || undefined,
        grade: aiGrade || undefined,
        custom_prompt: aiGenType === 'custom' || aiGenType === 'interactive' ? aiCustomPrompt : undefined,
        theme: aiTheme || undefined,
        enable_media: enableMediaGen,
      }
      if (aiGenType === 'interactive') {
        params.experiment_params = {
          实验分类: resourcesApi.EXPERIMENT_CATEGORIES.find(c => c.value === aiExpCategory)?.label || aiExpCategory,
          参数要求: aiCustomPrompt,
        }
      }

      // 交互式/复杂资源 → 异步生成（默认单文件，AI 自动决定是否拆分为多文件）
      if (aiGenType === 'interactive' || aiGenType === 'custom') {
        // 启动异步任务
        const task = await resourcesApi.aiGenerateAsync(params)
        const startTime = Date.now()
        const maxWaitMs = 20 * 60 * 1000  // 最多等 20 分钟
        let lastStage = ''

        message.loading({
          content: t('rmGeneratingPhase'),
          key: 'ai_async', duration: 0,
        })

        // 轮询任务状态
        let taskResult: resourcesApi.AsyncGenResult
        while (true) {
          await new Promise(r => setTimeout(r, 3000))  // 每 3 秒轮询
          taskResult = await resourcesApi.getAiTaskStatus(task.task_id)

          // 显示进展阶段
          const elapsed = Math.round((Date.now() - startTime) / 1000)
          const stage = taskResult.status === 'running'
            ? elapsed < 60
              ? t('resource.stage1')
              : elapsed < 180
                ? t('resource.stage2')
                : t('resource.stage3')
            : ''
          if (stage && stage !== lastStage) {
            lastStage = stage
            message.loading({
              content: t('resource.waitingStage', { stage, minutes: Math.round(elapsed / 60) }),
              key: 'ai_async', duration: 0,
            })
          }

          if (taskResult.status === 'completed' || taskResult.status === 'failed') break

          // 超时保护：超过 20 分钟强制终止
          if (Date.now() - startTime > maxWaitMs) {
            message.destroy('ai_async')
            message.error(t('genTimeout'))
            return
          }
        }
        message.destroy('ai_async')

        // 检查错误（兼容 status='failed' 和 result.error 两种情况）
        const errMsg = taskResult.error || taskResult.result?.error
        if (taskResult.status === 'failed' || errMsg) {
          message.error(errMsg || t('aiGenerateFailed'))
          return
        }

        const saved = taskResult.result?.saved
        if (!saved) {
          message.error(t('genResultError'))
          return
        }

        // 显示结果
        if (saved.is_subdir) {
          const fileUrl = `/api/files/${saved.url_path}`
          setAiDone({ fileUrl, fileName: saved.main_entry || 'index.html' })
          message.success(t('resource.generatedWithCount', { count: saved.file_count, dir: saved.dir_name }))
        } else {
          const fileUrl = `/api/files/${saved.url_path}`
          setAiDone({ fileUrl, fileName: saved.file_name || '' })
          message.success(t('resource.generatedSuccess'))
        }
        loadTree()
        return
      }

      // 简单资源 → 同步生成（原有逻辑）
      const genResult = await resourcesApi.aiPreviewHtml(params)
      if (!genResult.html_content || genResult.html_content.length < 50) {
          message.error(t('aiContentEmpty'))
        return
      }
      if (genResult.db_saved && genResult.db_saved > 0) {
        message.success(t('resource.questionsSaved', { count: genResult.db_saved }))
      }
      // 尝试解析多文件格式保存
      const fileName = genResult.suggested_name.replace(/\.html$/i, '')
      const saveResult = await resourcesApi.aiSaveMultiHtml(
        genResult.html_content, fileName, genResult.html_content,
      )
      if (saveResult.is_subdir) {
        const fileUrl = `/api/files/${saveResult.url_path}`
        setAiDone({ fileUrl, fileName: saveResult.main_entry || 'index.html' })
        message.success(t('resource.generatedWithCount', { count: saveResult.file_count, dir: saveResult.dir_name }))
      } else {
        const fileUrl = `/api/files/${saveResult.url_path}`
        setAiDone({ fileUrl, fileName: saveResult.file_name || fileName })
        message.success(t('resource.generatedSuccess'))
      }
      loadTree()
    } catch (err: any) {
      console.error('[AI生成+保存] 失败', err)
      message.destroy('ai_async')
      const status = err?.response?.status
      const detail = err?.response?.data?.detail || ''
      if (status === 400 && detail.includes('API Key')) {
        message.error(t('apiKeyNotConfigured'))
      } else if (status === 504) {
        message.error(t('aiGenTimeout'))
      } else if (status === 502) {
        message.error(t('aiServiceFailed') + ': ' + (detail.replace('AI 生成失败: ', '') || t('retryLater')))
      } else if (status === 401) {
        message.error(t('sessionExpired'))
      } else if (detail) {
        message.error('⚠️ ' + detail)
      } else {
        message.error(t('requestFailed'))
      }
    } finally {
      setAiWorking(false)
    }
  }

  // ── 视图切换 & 搜索 ──
  const [viewMode, setViewMode] = useState<'tree' | 'grid'>('tree')
  const [searchText, setSearchText] = useState('')
  const [gridPage, setGridPage] = useState(1)
  const GRID_PAGE_SIZE = 30

  // 搜索时重置分页
  useEffect(() => {
    setGridPage(1)
  }, [searchText])

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
        <Typography.Text type="secondary">{t('resource.accessDenied')}</Typography.Text>
      </Layout>
    )
  }

  return (
    <Layout style={{ height: 'calc(100vh - 112px)', background: '#fff', borderRadius: 8, overflow: 'auto', padding: 24 }}>
      <Tabs defaultActiveKey="files" items={[
        {
          key: 'files',
          label: <Space><FolderOutlined />{t('resource.fileManagement')}</Space>,
          children: (
            <Space orientation="vertical" style={{ width: '100%' }} size={16}>
              {/* 顶部栏：标题 + 搜索 + 视图切换 + 刷新 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <Typography.Title level={4} style={{ margin: 0 }}>{t('resource.title')}</Typography.Title>
                <Space wrap>
                  <Input
                    placeholder={t('resource.searchPlaceholder')}
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
                  <Button icon={<ReloadOutlined />} onClick={loadTree} loading={loading}>{t('refresh')}</Button>
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
                      items: [{ key: 'dir', icon: <FolderOpenOutlined />, label: t('resource.uploadDir') }],
                      onClick: ({ key }) => { if (key === 'dir') dirInputRef.current?.click() },
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >{t('resource.uploadFiles')}</Dropdown.Button>
                  <Button type="primary" ghost icon={<BulbOutlined />}
                    onClick={() => { setAiModalOpen(true); setAiDone(null); }}>
                    {t('resource.aiGenerate')}
                  </Button>
                </Space>
              </Card>

              {/* 搜索结果提示 */}
              {searchText.trim() && (
                <Typography.Text type="secondary">
                  {t('resource.searchResult', { keyword: searchText.trim(), count: viewMode === 'tree' ? filteredTree.reduce((n, node) => n + (node.children?.length || 0) + 1, 0) : allFiles.length })}
                </Typography.Text>
              )}

              {/* 树视图 */}
              {viewMode === 'tree' && (
                filteredTree.length > 0 ? (
                  <Card size="small" title={t('resource.dirStructure')}>
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
                            <Tooltip title={t('resource.rename')}>
                              <Button type="link" size="small" icon={<EditOutlined />}
                                onClick={() => openRename(node.key, node.title)} />
                            </Tooltip>
                            <Tooltip title={t('resource.delete')}>
                              <Button type="link" size="small" danger icon={<DeleteOutlined />}
                                onClick={() => handleDelete(node.key)} />
                            </Tooltip>
                          </span>
                        </div>
                      )}
                      onSelect={(keys: any, info: any) => {
                        if (info?.node?.isLeaf) {
                          const path = info.node.key || info.node.title
                          window.open(`/api/files/${username}/html/${path}`, '_blank')
                        }
                      }}
                    />
                  </Card>
                ) : (
                  <Empty description={searchText ? t('resource.noMatch') : t('resource.noFiles')} />
                )
              )}

              {/* 网格视图 */}
              {viewMode === 'grid' && (
                allFiles.length > 0 ? (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                      {allFiles.slice((gridPage - 1) * GRID_PAGE_SIZE, gridPage * GRID_PAGE_SIZE).map((file) => (
                        <Card
                          key={file.path}
                          onClick={() => window.open(`/api/files/${username}/html/${file.path}`, '_blank')}
                          size="small"
                          hoverable
                          styles={{ body: { padding: 16, textAlign: 'center' as const } }}
                          actions={[
                            <Tooltip title={t('resource.rename')} key="rename">
                              <EditOutlined onClick={() => openRename(file.path, file.name)} />
                            </Tooltip>,
                            <Tooltip title={t('resource.delete')} key="delete">
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
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
                      <Pagination
                        current={gridPage}
                        total={allFiles.length}
                        pageSize={GRID_PAGE_SIZE}
                        showSizeChanger
                        showTotal={(total) => t('resource.totalFiles', { count: total })}
                        pageSizeOptions={['10', '20', '30', '50']}
                        onChange={(p) => setGridPage(p)}
                      />
                    </div>
                  </>
                ) : (
                  <Empty description={searchText ? t('resource.noMatch') : t('resource.noFiles')} />
                )
              )}
            </Space>
          ),
        },
      ]} />

      {/* ── AI 生成 HTML 弹窗 ── */}
      <Modal title={t('resource.aiModalTitle')} open={aiModalOpen}
        onCancel={() => setAiModalOpen(false)}
        width={640}
        footer={null}
        destroyOnHidden>
        <Space orientation="vertical" style={{ width: '100%' }} size={16}>
          {/* 类型选择 */}
          <div>
            <Typography.Text strong style={{ marginBottom: 8, display: 'block' }}>{t('resource.resourceType')}</Typography.Text>
              <Radio.Group value={aiGenType} onChange={(e) => handleAiTypeChange(e.target.value)}
              className="ai-gen-type-group">
              <Radio.Button value="animation">{t('resource.typeAnimation')}</Radio.Button>
              <Radio.Button value="quiz">{t('resource.typeQuiz')}</Radio.Button>
              <Radio.Button value="practice">{t('resource.typePractice')}</Radio.Button>
              <Radio.Button value="interactive">{t('resource.typeInteractive')}</Radio.Button>
              <Radio.Button value="custom">{t('resource.typeCustom')}</Radio.Button>
            </Radio.Group>
          </div>

          {/* 交互式实验 - 实验分类选择 */}
          {aiGenType === 'interactive' && (
            <>
              <div>
                <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>
                  {t('resource.expCategory')} <span style={{ color: '#ff4d4f' }}>*</span>
                </Typography.Text>
                <Select
                  value={aiExpCategory}
                  onChange={(v) => setAiExpCategory(v)}
                  style={{ width: '100%' }}
                  placeholder={t('resource.expCategoryPlaceholder')}
                  options={resourcesApi.EXPERIMENT_CATEGORIES.map(cat => ({
                    value: cat.value,
                    label: `${cat.label} — ${cat.desc}`,
                  }))}
                />
              </div>
              <div>
                <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>
                  {t('resource.expTopic')} <span style={{ color: '#ff4d4f' }}>*</span>
                </Typography.Text>
                <Input
                  placeholder={t('resource.expTopicPlaceholder')}
                  value={aiTopic}
                  onChange={(e) => setAiTopic(e.target.value)}
                />
              </div>
              <div>
                <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>
                  {t('resource.expCustomReq')} <span style={{ color: '#888', fontWeight: 400 }}>{t('resource.expCustomReqOptional')}</span>
                </Typography.Text>
                <Input.TextArea
                  rows={3}
                  placeholder={t('resource.expCustomReqPlaceholder')}
                  value={aiCustomPrompt}
                  onChange={(e) => setAiCustomPrompt(e.target.value)}
                />
              </div>
            </>
          )}

          {/* 知识点/主题（非交互式且非自定义） */}
          {aiGenType !== 'custom' && aiGenType !== 'interactive' ? (
            <div>
              <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>
                {t('resource.topicLabel')} <span style={{ color: '#ff4d4f' }}>*</span>
                </Typography.Text>
              <Input
                placeholder={t('resource.topicPlaceholder')}
                value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
              />
            </div>
          ) : null}

          {/* 自定义 HTML */}
          {aiGenType === 'custom' ? (
            <div>
              <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>
                {t('resource.customReqLabel')} <span style={{ color: '#ff4d4f' }}>*</span>
              </Typography.Text>
              <Input.TextArea
                rows={5}
                placeholder={t('resource.customReqPlaceholder')}
                value={aiCustomPrompt}
                onChange={(e) => setAiCustomPrompt(e.target.value)}
              />
            </div>
          ) : null}

          {/* 学科 & 年级 */}
          <Space>
            <div>
              <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>{t('resource.subjectLabel')}</Typography.Text>
              <Select
                value={aiSubject || undefined}
                onChange={(v) => setAiSubject(v || '')}
                allowClear
                placeholder={t('resource.subjectPlaceholder')}
                style={{ width: 180 }}
                loading={aiSubjectOptions.length === 0}
                options={aiSubjectOptions.map(s => ({ value: s, label: s }))}
              />
            </div>
            <div>
              <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>{t('resource.gradeLabel')}</Typography.Text>
              <Select
                value={aiGrade || undefined}
                onChange={(v) => setAiGrade(v || '')}
                allowClear
                placeholder={t('resource.gradePlaceholder')}
                style={{ width: 140 }}
                loading={aiGradeOptions.length === 0}
                options={aiGradeOptions.map(g => ({ value: g, label: g }))}
              />
            </div>
          </Space>

          {/* 主题选择 */}
          {aiThemes.length > 0 && (
            <div>
              <Typography.Text strong style={{ marginBottom: 4, display: 'block' }}>{t('resource.themeLabel')}</Typography.Text>
              <Select
                value={aiTheme || undefined}
                onChange={(v) => setAiTheme(v || '')}
                style={{ width: '100%' }}
                placeholder={t('resource.themePlaceholder')}
                options={aiThemes.map(t => ({
                  value: t.id,
                  label: `${t.icon} ${t.name} — ${t.desc}`,
                }))}
              />
            </div>
          )}

          {/* ── 配图增强开关 ── */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', background: '#f6f8fa', borderRadius: 8, border: '1px solid #e8ecf0' }}>
            <div>
              <Typography.Text strong style={{ fontSize: 13 }}>{t('resource.autoMediaLabel')}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                {t('resource.autoMediaDesc')}
              </Typography.Text>
            </div>
            <Switch checked={enableMediaGen} onChange={setEnableMediaGen} size="small" />
          </div>

          {/* 生成按钮 / 完成状态 */}
          {aiDone ? (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <Typography.Text type="success" style={{ fontSize: 16, display: 'block', marginBottom: 8 }}>
                {t('resource.generatedSuccess')}
              </Typography.Text>
              {aiDone.fileName && aiDone.fileName !== 'index.html' && (
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 16 }}>
                  {t('resource.fileLabel')}{aiDone.fileName}
                </Typography.Text>
              )}
              <Button type="primary" size="large" icon={<EyeOutlined />}
                href={aiDone.fileUrl} target="_blank" rel="noopener noreferrer"
                style={{ marginBottom: 12 }}>
                {t('resource.openPreview')}
              </Button>
              <br />
              <Button onClick={() => { setAiModalOpen(false); setAiDone(null) }}>
                {t('resource.finish')}
              </Button>
            </div>
          ) : (
            <Button type="primary" block size="large"
              icon={aiWorking ? <LoadingOutlined /> : <BulbOutlined />}
              loading={aiWorking}
              disabled={aiWorking || (aiGenType === 'custom' ? !aiCustomPrompt : aiGenType === 'interactive' ? !aiTopic : !aiTopic)}
              onClick={handleAiGenerate}
            >
              {aiWorking ? t('resource.generating') : t('resource.generateAndSave')}
            </Button>
          )}
        </Space>
      </Modal>

      {/* 重命名弹窗 */}
      <Modal title={t('resource.renameModalTitle')} open={renameModal}
        onOk={handleRename} onCancel={() => setRenameModal(false)}
        okText={t('resource.renameOk')} cancelText={t('resource.renameCancel')}>
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">{t('resource.renameOriginalName')}{renameOld}</Typography.Text>
          <Input value={renameNew} onChange={(e) => setRenameNew(e.target.value)}
            onPressEnter={handleRename} placeholder={t('resource.renamePlaceholder')} />
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
        .ai-gen-type-group .ant-radio-button-wrapper {
          flex: 1;
          text-align: center;
          height: 48px;
          line-height: 48px;
          padding: 0 8px;
          white-space: nowrap;
        }
        .ai-gen-type-group {
          display: flex;
          width: 100%;
          gap: 8px;
        }
        .ai-gen-type-group .ant-radio-button-wrapper:not(:first-child)::before {
          display: none !important;
        }
      `}</style>
    </Layout>
  )
}

export default ResourceMgmtPage
