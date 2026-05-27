import React, { useState, useEffect } from 'react'
import { Modal, message, Space, Typography, Button, Radio, Select, Divider } from 'antd'
import { ShareAltOutlined, StopOutlined, TeamOutlined, GlobalOutlined, BookOutlined } from '@ant-design/icons'
import * as sharingApi from '../api/sharing'
import apiClient from '../api/client'
import { useAuthStore } from '../stores/authStore'

interface ShareDialogProps {
  open: boolean
  onClose: () => void
  filePath: string
  fileName: string
  resourceType: 'html' | 'download'
  /** 编辑已有共享时传入 */
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

  // 共享范围状态
  const [scope, setScope] = useState<ShareScope>('all')
  const [targetGrade, setTargetGrade] = useState('')
  const [targetClass, setTargetClass] = useState('')
  const [grades, setGrades] = useState<string[]>([])
  const [classes, setClasses] = useState<string[]>([])

  // 打开时初始化
  useEffect(() => {
    if (open) {
      if (existingShare) {
        setScope(existingShare.share_scope)
        setTargetGrade(existingShare.target_grade)
        setTargetClass(existingShare.target_class)
      } else {
        // 默认选项
        if (isAdmin) {
          setScope('all')
        } else if (isTeacher) {
          setScope('staff')
        }
        setTargetGrade('')
        setTargetClass('')
      }
      // 加载年级列表
      apiClient.get('/api/rollcall/grades').then(res => {
        setGrades(Array.isArray(res.data) ? res.data : [])
      }).catch(() => {})
    }
  }, [open, existingShare, isAdmin, isTeacher])

  // 选择年级时加载班级
  useEffect(() => {
    if (targetGrade) {
      apiClient.get('/api/rollcall/classes', { params: { grade: targetGrade } }).then(res => {
        setClasses(Array.isArray(res.data) ? res.data : [])
      }).catch(() => setClasses([]))
    } else {
      setClasses([])
    }
    setTargetClass('')
  }, [targetGrade])

  const handleShare = async () => {
    setLoading(true)
    try {
      const body: sharingApi.ShareRequest = {
        file_path: filePath,
        file_name: fileName,
        resource_type: resourceType,
        share_scope: scope,
        target_grade: scope === 'class' ? targetGrade : '',
        target_class: scope === 'class' ? targetClass : '',
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
    { value: 'all', label: <><GlobalOutlined /> 所有人</>, desc: '所有用户（管理员、教师、学生）可见' },
    { value: 'teacher', label: <><TeamOutlined /> 教师</>, desc: '仅对教师可见' },
    { value: 'class', label: <><BookOutlined /> 指定年级/班级</>, desc: '对指定年级或班级的学生可见' },
  ]

  // ── 教师选项 ──
  const teacherScopeOptions = [
    { value: 'staff', label: <><TeamOutlined /> 管理员和教师</>, desc: '仅对管理员和教师可见' },
    { value: 'class', label: <><BookOutlined /> 我的班级</>, desc: '自动共享给自己班级的学生' },
  ]

  const options = isAdmin ? adminScopeOptions : teacherScopeOptions

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
                disabled={scope === 'class' && !targetGrade}>
                确认共享
              </Button>
            )}
          </Space>
        </Space>
      }
      width={480}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Typography.Text ellipsis style={{ maxWidth: 440 }}>
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
              onChange={(e) => setScope(e.target.value)}
              style={{ width: '100%' }}
            >
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                {options.map(opt => (
                  <div key={opt.value} style={{
                    border: scope === opt.value ? '1px solid #1677ff' : '1px solid #d9d9d9',
                    borderRadius: 8, padding: '10px 14px', cursor: 'pointer',
                    background: scope === opt.value ? '#f0f5ff' : '#fff',
                  }} onClick={() => setScope(opt.value)}>
                    <Radio value={opt.value}>{opt.label}</Radio>
                    <div style={{ fontSize: 12, color: '#999', marginTop: 4, marginLeft: 24 }}>
                      {opt.desc}
                    </div>
                  </div>
                ))}
              </Space>
            </Radio.Group>

            {scope === 'class' && (
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>选择年级/班级：</Typography.Text>
                <Space>
                  <Select
                    placeholder="选择年级"
                    value={targetGrade || undefined}
                    onChange={setTargetGrade}
                    style={{ width: 160 }}
                    options={grades.map(g => ({ value: g, label: g }))}
                  />
                  {targetGrade && (
                    <Select
                      placeholder="选择班级（可选）"
                      value={targetClass || undefined}
                      onChange={setTargetClass}
                      style={{ width: 160 }}
                      allowClear
                      options={classes.map(c => ({ value: c, label: c }))}
                    />
                  )}
                </Space>
              </Space>
            )}
          </>
        )}
      </Space>
    </Modal>
  )
}

export default ShareDialog
