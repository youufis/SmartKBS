import React, { useState, useEffect } from 'react'
import { Modal, Form, Radio, Select, message, Space, Typography } from 'antd'
import { ShareAltOutlined } from '@ant-design/icons'
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

const GRADE_OPTIONS = ['高一', '高二', '高三']
const CLASS_OPTIONS = Array.from({ length: 20 }, (_, i) => `${i + 1}班`)

const ShareDialog: React.FC<ShareDialogProps> = ({
  open, onClose, filePath, fileName, resourceType, existingShare, onSuccess,
}) => {
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      if (existingShare) {
        form.setFieldsValue({
          share_scope: existingShare.share_scope,
          target_grade: existingShare.target_grade || undefined,
          target_class: existingShare.target_class || undefined,
        })
      } else {
        form.setFieldsValue({
          share_scope: isAdmin ? 'all' : 'class',
          target_grade: undefined,
          target_class: undefined,
        })
      }
    }
  }, [open, existingShare, isAdmin, form])

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)
      const body: sharingApi.ShareRequest = {
        file_path: filePath,
        file_name: fileName,
        resource_type: resourceType,
        share_scope: values.share_scope,
        target_grade: values.target_grade || '',
        target_class: values.target_class || '',
      }
      await sharingApi.shareResource(body)
      message.success('共享成功')
      onSuccess?.()
      onClose()
    } catch (err: any) {
      if (err?.errorFields) return // validation error
      message.error(err?.response?.data?.detail || '共享失败')
    } finally {
      setLoading(false)
    }
  }

  const scope = Form.useWatch('share_scope', form)

  return (
    <Modal
      title={<><ShareAltOutlined style={{ color: '#1677ff' }} /> 共享资源</>}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={loading}
      okText="确认共享"
      cancelText="取消"
      width={480}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Typography.Text ellipsis style={{ maxWidth: 420 }}>
          <strong>文件：</strong>{fileName}
        </Typography.Text>

        <Form form={form} layout="vertical" initialValues={{ share_scope: isAdmin ? 'all' : 'class' }}>
          <Form.Item name="share_scope" label="共享范围" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio value="all">
                {isAdmin ? '所有人可见' : '所有人可见'}
                {isAdmin && <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>（管理员）</Typography.Text>}
              </Radio>
              <Radio value="class">
                指定年级/班级可见
                {!isAdmin && <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>（教师）</Typography.Text>}
              </Radio>
            </Radio.Group>
          </Form.Item>

          {scope === 'class' && (
            <>
              <Form.Item name="target_grade" label="目标年级" rules={[{ required: true, message: '请选择年级' }]}>
                <Select placeholder="选择年级" options={GRADE_OPTIONS.map(g => ({ label: g, value: g }))} />
              </Form.Item>
              <Form.Item name="target_class" label="目标班级（可选，不选则整个年级可见）">
                <Select
                  placeholder="选择班级（留空则全部班级）"
                  allowClear
                  options={CLASS_OPTIONS.map(c => ({ label: c, value: c }))}
                />
              </Form.Item>
            </>
          )}
        </Form>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {isAdmin
            ? '管理员共享的资源默认对所有用户可见。'
            : '教师共享的资源仅对指定年级/班级的学生可见，管理员和教师均可看到。'}
        </Typography.Text>
      </Space>
    </Modal>
  )
}

export default ShareDialog
