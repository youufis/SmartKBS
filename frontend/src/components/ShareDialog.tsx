import React, { useState, useEffect } from 'react'
import { Modal, message, Space, Typography, Button, Radio, Select, Divider, Tag, Checkbox } from 'antd'
import { ShareAltOutlined, StopOutlined, TeamOutlined, GlobalOutlined, BookOutlined, UserOutlined, FolderOutlined } from '@ant-design/icons'
import * as sharingApi from '../api/sharing'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

interface ShareDialogProps {
  open: boolean
  onClose: () => void
  filePath: string
  fileName: string
  resourceType: 'html' | 'download'
  existingShare?: sharingApi.ShareItem | null
  onSuccess?: () => void
  /** 是否通过目录共享继承（非精确匹配） */
  inheritedFromDir?: boolean
}

type ShareScope = 'all' | 'teacher' | 'staff' | 'class'

const ShareDialog: React.FC<ShareDialogProps> = ({
  open, onClose, filePath, fileName, resourceType, existingShare, onSuccess,
  inheritedFromDir = false,
}) => {
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'
  const isTeacher = user?.role === 'teacher'
  const [loading, setLoading] = useState(false)
  const isShared = !!existingShare

  const [scope, setScope] = useState<ShareScope>('all')
  const [selectedTeachers, setSelectedTeachers] = useState<string[]>([])
  const [selectedGrades, setSelectedGrades] = useState<string[]>([])
  const [selectedClasses, setSelectedClasses] = useState<string[]>([])
  const [teachers, setTeachers] = useState<sharingApi.UserItem[]>([])
  const [grades, setGrades] = useState<string[]>([])
  const [classOptions, setClassOptions] = useState<{ grade: string; classes: string[] }[]>([])
  // 教师：是否同时共享给班级
  const [includeMyClass, setIncludeMyClass] = useState(false)

  const parseCSV = (csv: string): string[] => csv ? csv.split(',').filter(Boolean) : []

  useEffect(() => {
    if (open) {
      if (existingShare) {
        setScope(existingShare.share_scope)
        setSelectedTeachers(parseCSV(existingShare.target_users))
        setSelectedGrades(parseCSV(existingShare.target_grade))
        setSelectedClasses(parseCSV(existingShare.target_class))
        setIncludeMyClass(existingShare.share_scope === 'class' ||
          (existingShare.share_scope === 'teacher' && !!existingShare.target_grade))
      } else {
        if (isAdmin) setScope('all')
        else if (isTeacher) { setScope('teacher'); setIncludeMyClass(true) }
        setSelectedTeachers([])
        setSelectedGrades([])
        setSelectedClasses([])
      }
      // 加载所有用户（管理员+教师）
      apiClient.get('/api/users', { params: { keyword: '' } }).then(res => {
        const allUsers: sharingApi.UserItem[] = res.data?.users || []
        setTeachers(allUsers.filter(u => u.role === '教师' || u.role === '管理员'))
      }).catch(() => {})
      apiClient.get('/api/rollcall/grades').then(res => {
        setGrades(Array.isArray(res.data) ? res.data : [])
      }).catch(() => {})
    }
  }, [open, existingShare, isAdmin, isTeacher])

  useEffect(() => {
    if (open) {
      Promise.all(grades.map(g =>
        apiClient.get('/api/rollcall/classes', { params: { grade: g } })
          .then(res => ({ grade: g, classes: Array.isArray(res.data) ? res.data : [] }))
          .catch(() => ({ grade: g, classes: [] }))
      )).then(setClassOptions)
    }
  }, [open, grades])

  const handleShare = async () => {
    setLoading(true)
    try {
      let shareScope: ShareScope = scope
      let targetUsers: string[] = []
      let targetGrades: string[] = []
      let targetClasses: string[] = []

      if (isTeacher) {
        // 教师：根据选择组合
        targetUsers = selectedTeachers
        if (includeMyClass && user?.grade) {
          shareScope = 'teacher'  // 使用 teacher 作用域同时存 target_users 和 grade/class
          targetGrades = [user.grade]
          if (user?.class) targetClasses = [user.class]
        } else if (selectedTeachers.length > 0) {
          shareScope = 'teacher'
        } else if (includeMyClass) {
          shareScope = 'class'
        }
      } else {
        // 管理员：按 radio 选择
        targetUsers = scope === 'teacher' ? selectedTeachers : []
        targetGrades = scope === 'class' ? selectedGrades : []
        targetClasses = scope === 'class' ? selectedClasses : []
      }

      const body: sharingApi.ShareRequest = {
        file_path: filePath,
        file_name: fileName,
        resource_type: resourceType,
        share_scope: shareScope,
        target_users: targetUsers,
        target_grades: targetGrades,
        target_classes: targetClasses,
      }
      await sharingApi.shareResource(body)
      message.success('共享成功')
      onSuccess?.()
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '共享失败')
    } finally {
      setLoading(false)
    }
  }

  const handleUnshare = async () => {
    if (!existingShare) return
    setLoading(true)
    try {
      await sharingApi.unshareResource(existingShare.id)
      message.success('已取消共享')
      onSuccess?.()
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || '取消失败')
    } finally {
      setLoading(false)
    }
  }

  // ── 管理员选项 ──
  const adminScopeOptions = [
    { value: 'all', label: <><GlobalOutlined /> 所有人</>, desc: '所有用户可见（含教师和学生）' },
    { value: 'staff', label: <><TeamOutlined /> 全体教师</>, desc: '仅对教师和管理员可见' },
    { value: 'teacher', label: <><UserOutlined /> 指定教师</>, desc: '仅对选中的教师用户可见' },
    { value: 'class', label: <><BookOutlined /> 指定年级/班级</>, desc: '对选中的年级或班级的学生可见' },
  ]

  const options = isAdmin ? adminScopeOptions : []

  const canShare = isTeacher
    ? (selectedTeachers.length > 0 || includeMyClass)
    : (scope !== 'class' || selectedGrades.length > 0 || selectedClasses.length > 0)

  return (
    <Modal
      title={<><ShareAltOutlined style={{ color: '#ff4d4f' }} /> {isShared ? '管理共享' : '共享资源'}</>}
      open={open}
      onCancel={onClose}
      footer={
        <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <div>
            {isShared && !inheritedFromDir && (
              <Button danger type="text" icon={<StopOutlined />} onClick={handleUnshare} loading={loading}>
                取消共享
              </Button>
            )}
          </div>
          <Space>
            <Button onClick={onClose}>关闭</Button>
            {inheritedFromDir ? (
              <>
                <Button type="primary" icon={<ShareAltOutlined />} onClick={handleShare} loading={loading}
                  disabled={!canShare}>
                  单独共享此文件
                </Button>
              </>
            ) : !isShared && (
              <Button type="primary" icon={<ShareAltOutlined />} onClick={handleShare} loading={loading}
                disabled={!canShare}>
                确认共享
              </Button>
            )}
          </Space>
        </Space>
      }
      width={520}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Typography.Text ellipsis style={{ maxWidth: 480 }}>
          <strong>文件：</strong>{fileName}
        </Typography.Text>

        {inheritedFromDir ? (
          <>
            <Typography.Text type="secondary">
              <FolderOutlined style={{ marginRight: 4 }} />
              此文件因其所在目录 <strong>{existingShare?.file_name}</strong> 被共享而自动对共享范围内的用户可见。
            </Typography.Text>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text strong>为此文件单独设置共享</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block' }}>
              单独共享将覆盖目录共享设置，可为此文件指定不同的共享范围。
            </Typography.Text>
          </>
        ) : isShared ? (
          <Typography.Text type="secondary">
            该文件已共享，可修改共享范围后重新共享，或点击「取消共享」按钮停止共享。
          </Typography.Text>
        ) : (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text strong>共享范围</Typography.Text>

            {isAdmin ? (
              <>
                <Radio.Group
                  value={scope}
                  onChange={(e) => setScope(e.target.value as ShareScope)}
                  style={{ width: '100%' }}
                >
                  <Space direction="vertical" style={{ width: '100%' }} size={8}>
                    {options.map(opt => (
                      <div key={opt.value} style={{
                        border: scope === opt.value ? '1px solid #1677ff' : '1px solid #d9d9d9',
                        borderRadius: 8, padding: '10px 14px', cursor: 'pointer',
                        background: scope === opt.value ? '#f0f5ff' : '#fff',
                      }} onClick={() => setScope(opt.value as ShareScope)}>
                        <Radio value={opt.value}>{opt.label}</Radio>
                        <div style={{ fontSize: 12, color: '#999', marginTop: 4, marginLeft: 24 }}>
                          {opt.desc}
                        </div>
                      </div>
                    ))}
                  </Space>
                </Radio.Group>

                {scope === 'teacher' && (
                  <div style={{ paddingLeft: 8 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      <UserOutlined /> 选择教师（可多选）：
                    </Typography.Text>
                    <Select
                      mode="multiple"
                      placeholder="搜索并选择教师"
                      value={selectedTeachers}
                      onChange={setSelectedTeachers}
                      style={{ width: '100%', marginTop: 8 }}
                      showSearch
                      filterOption={(input, option) =>
                        (option?.label as string || '').toLowerCase().includes(input.toLowerCase())
                      }
                      options={teachers.filter(t => t.role === '教师').map(t => ({
                        value: t.username,
                        label: `${t.name} (${t.username})`,
                      }))}
                      tagRender={(props) => {
                        const { label, closable, onClose } = props
                        return <Tag closable={closable} onClose={onClose} style={{ margin: 2 }}>{label}</Tag>
                      }}
                    />
                  </div>
                )}

                {scope === 'class' && (
                  <div style={{ paddingLeft: 8 }}>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      <BookOutlined /> 选择年级（可多选）：
                    </Typography.Text>
                    <Select
                      mode="multiple"
                      placeholder="选择年级"
                      value={selectedGrades}
                      onChange={(vals) => {
                        setSelectedGrades(vals)
                        setSelectedClasses(prev => prev.filter(c =>
                          classOptions.some(opt => vals.includes(opt.grade) && opt.classes.includes(c))
                        ))
                      }}
                      style={{ width: '100%', marginTop: 8 }}
                      options={grades.map(g => ({ value: g, label: g }))}
                    />
                    {selectedGrades.length > 0 && (
                      <>
                        <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block', marginTop: 12 }}>
                          <BookOutlined /> 选择班级（可多选）：
                        </Typography.Text>
                        <Select
                          mode="multiple"
                          placeholder="选择班级"
                          value={selectedClasses}
                          onChange={setSelectedClasses}
                          style={{ width: '100%', marginTop: 8 }}
                          options={classOptions
                            .filter(opt => selectedGrades.includes(opt.grade))
                            .flatMap(opt => opt.classes.map(c => ({ value: c, label: `${opt.grade} ${c}` })))}
                        />
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              /* ── 教师面板 ── */
              <Space direction="vertical" style={{ width: '100%' }} size={16}>
                {/* 管理员和教师多选 */}
                <div style={{
                  border: '1px solid #d9d9d9',
                  borderRadius: 8, padding: '10px 14px',
                  background: '#fff',
                }}>
                  <Space align="center" style={{ marginBottom: 8 }}>
                    <TeamOutlined style={{ color: '#1677ff' }} />
                    <Typography.Text strong>共享给管理员和教师</Typography.Text>
                  </Space>
                  <Select
                    mode="multiple"
                    placeholder="搜索并选择管理员/教师（可多选）"
                    value={selectedTeachers}
                    onChange={setSelectedTeachers}
                    style={{ width: '100%' }}
                    showSearch
                    filterOption={(input, option) =>
                      (option?.label as string || '').toLowerCase().includes(input.toLowerCase())
                    }
                    options={teachers.map(t => ({
                      value: t.username,
                      label: `${t.name} (${t.username}${t.role === '管理员' ? '·管理员' : ''})`,
                    }))}
                    tagRender={(props) => {
                      const { label, closable, onClose } = props
                      return <Tag closable={closable} onClose={onClose} style={{ margin: 2 }}>{label}</Tag>
                    }}
                  />
                </div>

                {/* 我的班级 */}
                <div style={{
                  border: includeMyClass ? '1px solid #1677ff' : '1px solid #d9d9d9',
                  borderRadius: 8, padding: '10px 14px', cursor: 'pointer',
                  background: includeMyClass ? '#f0f5ff' : '#fff',
                }} onClick={() => setIncludeMyClass(!includeMyClass)}>
                  <Checkbox checked={includeMyClass}>
                    <BookOutlined style={{ color: '#1677ff' }} /> 共享给我的班级
                  </Checkbox>
                  {includeMyClass && user?.grade && (
                    <Tag style={{ marginLeft: 8 }} color="blue">
                      {user.grade} {user.class || ''}
                    </Tag>
                  )}
                </div>
              </Space>
            )}
          </>
        )}
      </Space>
    </Modal>
  )
}

export default ShareDialog
