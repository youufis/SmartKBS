import React, { useState, useEffect } from 'react'
import { Modal, message, Space, Typography, Button, Radio, Select, Divider, Tag } from 'antd'
import { ShareAltOutlined, StopOutlined, TeamOutlined, GlobalOutlined, BookOutlined, UserOutlined } from '@ant-design/icons'
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
}

type ShareScope = 'all' | 'teacher' | 'staff' | 'class'

const ShareDialog: React.FC<ShareDialogProps> = ({
  open, onClose, filePath, fileName, resourceType, existingShare, onSuccess,
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

  // 从逗号分隔字符串解析数组
  const parseCSV = (csv: string): string[] => csv ? csv.split(',').filter(Boolean) : []

  // 打开时初始化
  useEffect(() => {
    if (open) {
      if (existingShare) {
        setScope(existingShare.share_scope)
        setSelectedTeachers(parseCSV(existingShare.target_users))
        setSelectedGrades(parseCSV(existingShare.target_grade))
        setSelectedClasses(parseCSV(existingShare.target_class))
      } else {
        if (isAdmin) setScope('all')
        else if (isTeacher) setScope('staff')
        setSelectedTeachers([])
        setSelectedGrades([])
        setSelectedClasses([])
      }
      // 加载教师列表
      apiClient.get('/api/users', { params: { keyword: '' } }).then(res => {
        const allUsers: sharingApi.UserItem[] = res.data?.users || []
        setTeachers(allUsers.filter(u => u.role === '教师'))
      }).catch(() => {})
      // 加载年级列表
      apiClient.get('/api/rollcall/grades').then(res => {
        setGrades(Array.isArray(res.data) ? res.data : [])
      }).catch(() => {})
    }
  }, [open, existingShare, isAdmin, isTeacher])

  // 加载所有班级（按年级分组）
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
      const body: sharingApi.ShareRequest = {
        file_path: filePath,
        file_name: fileName,
        resource_type: resourceType,
        share_scope: scope,
        target_users: scope === 'teacher' ? selectedTeachers : [],
        target_grades: scope === 'class' ? selectedGrades : [],
        target_classes: scope === 'class' ? selectedClasses : [],
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
    { value: 'all', label: <><GlobalOutlined /> 所有人</>, desc: '所有用户可见' },
    { value: 'teacher', label: <><TeamOutlined /> 指定教师</>, desc: '仅对选中的教师用户可见' },
    { value: 'class', label: <><BookOutlined /> 指定年级/班级</>, desc: '对选中的年级或班级的学生可见' },
  ]

  // ── 教师选项 ──
  const teacherScopeOptions = [
    { value: 'staff', label: <><TeamOutlined /> 管理员和教师</>, desc: '仅对管理员和教师可见' },
    { value: 'class', label: <><BookOutlined /> 我的班级</>, desc: '自动共享给自己班级的学生' },
  ]

  const options = isAdmin ? adminScopeOptions : teacherScopeOptions

  const canShare = scope !== 'class' || selectedGrades.length > 0 || selectedClasses.length > 0

  return (
    <Modal
      title={<><ShareAltOutlined style={{ color: '#1677ff' }} /> {isShared ? '管理共享' : '共享资源'}</>}
      open={open}
      onCancel={onClose}
      footer={
        <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <div>
            {isShared && (
              <Button danger type="text" icon={<StopOutlined />} onClick={handleUnshare} loading={loading}>
                取消共享
              </Button>
            )}
          </div>
          <Space>
            <Button onClick={onClose}>关闭</Button>
            {!isShared && (
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

        {isShared ? (
          <Typography.Text type="secondary">
            该文件已共享，可修改共享范围后重新共享，或点击「取消共享」按钮停止共享。
          </Typography.Text>
        ) : (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text strong>共享范围</Typography.Text>
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

            {scope === 'teacher' && isAdmin && (
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
                  options={teachers.map(t => ({
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
                {isAdmin ? (
                  <>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      <BookOutlined /> 选择年级（可多选）：
                    </Typography.Text>
                    <Select
                      mode="multiple"
                      placeholder="选择年级"
                      value={selectedGrades}
                      onChange={(vals) => {
                        setSelectedGrades(vals)
                        // 清除不属于选中年级的班级
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
                  </>
                ) : (
                  // 教师只能看到自己的班级
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                    将自动共享给您的班级学生。
                    {user?.grade && <Tag style={{ marginLeft: 8 }}>{user.grade} {user.class}</Tag>}
                  </Typography.Text>
                )}
              </div>
            )}
          </>
        )}
      </Space>
    </Modal>
  )
}

export default ShareDialog
