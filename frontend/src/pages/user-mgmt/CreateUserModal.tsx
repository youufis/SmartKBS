/**
 * 新建用户弹窗（原「添加用户」页签）。
 * 学生方向用年级/班级下拉（可手输新值），避免手敲 "1,2,3|4,5" 这种语法写错班级。
 */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Col, Form, Input, Modal, Radio, Row, Select, message } from 'antd'
import * as usersApi from '../../api/users'
import { ROLE_ADMIN, ROLE_STUDENT, ROLE_TEACHER } from './roles'
import { ClassInput, GradeInput, RoleSelect } from './ScopeFields'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
  isAdmin: boolean
  gradeOptions: string[]
  classOptions: Array<{ value: string; label: string }>
  subjectOptions: string[]
}

interface ApiError {
  response?: { data?: { detail?: string } }
}

const CreateUserModal: React.FC<Props> = ({
  open, onClose, onCreated, isAdmin, gradeOptions, classOptions, subjectOptions,
}) => {
  const { t } = useTranslation('system')
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const roleValue: number = Form.useWatch('role', form) ?? ROLE_STUDENT
  const isTeacherRole = roleValue === ROLE_TEACHER || roleValue === ROLE_ADMIN

  useEffect(() => {
    if (open) form.resetFields()
  }, [open, form])

  const handleSubmit = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      const msg = await usersApi.registerUser({
        username: String(v.username || '').trim(),
        password: String(v.password || ''),
        class_val: String(v.class_val || ''),
        name: String(v.name || ''),
        gender: v.gender === '女' ? 0 : 1,
        role: Number(v.role ?? ROLE_STUDENT),
        grade: String(v.grade || ''),
        subjects: (v.subjects as string[]) || [],
      })
      message.success(msg)
      onCreated()
      onClose()
    } catch (err) {
      message.error((err as ApiError)?.response?.data?.detail || t('registerFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={t('createUser')}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={saving}
      okText={t('register')}
      cancelText={t('cancel')}
      width={560}
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 260px)', overflowY: 'auto', paddingTop: 8 } }}
    >
      <Form form={form} layout="vertical" initialValues={{ gender: '男', role: ROLE_STUDENT }}>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="username" label={t('usernameLabel')} rules={[{ required: true }]}>
              <Input placeholder={t('usernamePlaceholder')} autoComplete="off" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="password" label={t('passwordLabel')} rules={[{ required: true }]}>
              <Input.Password placeholder={t('passwordPlaceholder')} autoComplete="new-password" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="name" label={t('nameLabel')} style={{ marginBottom: 12 }}>
              <Input placeholder={t('namePlaceholder')} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="gender" label={t('genderLabel')} style={{ marginBottom: 12 }}>
              <Radio.Group options={[{ label: t('male'), value: '男' }, { label: t('female'), value: '女' }]} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="role" label={t('roleLabel')} style={{ marginBottom: 12 }}>
          <RoleSelect disabled={!isAdmin} style={{ width: '100%' }} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="grade" label={t('gradeLabel')}
              extra={isTeacherRole ? t('multiGradeHelp') : undefined}
              rules={isTeacherRole ? [{ required: true, message: t('gradeLabel') }] : undefined}
              style={{ marginBottom: 12 }}>
              {isTeacherRole
                ? <Input placeholder={t('gradePlaceholder')} />
                : <GradeInput options={gradeOptions} placeholder={t('gradePlaceholder')} />}
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="class_val" label={t('classLabel')}
              extra={isTeacherRole ? t('multiClassHelp') : undefined}
              style={{ marginBottom: 12 }}>
              {isTeacherRole
                ? <Input placeholder={t('classPlaceholder')} />
                : <ClassInput options={classOptions} placeholder={t('classPlaceholder')} />}
            </Form.Item>
          </Col>
        </Row>
        {isTeacherRole && (
          <Form.Item name="subjects" label={t('teachingSubjectsLabel')} extra={t('configSubjectsFirst')} style={{ marginBottom: 0 }}>
            <Select mode="multiple" allowClear placeholder={t('selectSubjectsPlaceholder')}
              options={subjectOptions.map(s => ({ label: s, value: s }))} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}

export default CreateUserModal
