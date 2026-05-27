import React, { useState } from 'react'
import { Modal, message, Space, Typography, Button } from 'antd'
import { ShareAltOutlined, StopOutlined } from '@ant-design/icons'
import * as sharingApi from '../api/sharing'
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

const ShareDialog: React.FC<ShareDialogProps> = ({
  open, onClose, filePath, fileName, resourceType, existingShare, onSuccess,
}) => {
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'
  const [loading, setLoading] = useState(false)
  const isShared = !!existingShare

  const handleShare = async () => {
    setLoading(true)
    try {
      const body: sharingApi.ShareRequest = {
        file_path: filePath,
        file_name: fileName,
        resource_type: resourceType,
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

  return (
    <Modal
      title={<><ShareAltOutlined style={{ color: '#1677ff' }} /> {isShared ? '取消共享' : '共享资源'}</>}
      open={open}
      onCancel={onClose}
      footer={
        <Space style={{ display: 'flex', justifyContent: 'space-between' }}>
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
              <Button type="primary" icon={<ShareAltOutlined />} onClick={handleShare} loading={loading}>
                确认共享
              </Button>
            )}
          </Space>
        </Space>
      }
      width={400}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Typography.Text ellipsis style={{ maxWidth: 360 }}>
          <strong>文件：</strong>{fileName}
        </Typography.Text>

        <Typography.Text type="secondary">
          {isShared
            ? '该文件已共享，点击「取消共享」按钮可停止共享。'
            : isAdmin
              ? '管理员共享的资源将对所有用户可见。'
              : '教师共享的资源将自动对您所在班级的学生可见。'}
        </Typography.Text>
      </Space>
    </Modal>
  )
}

export default ShareDialog
