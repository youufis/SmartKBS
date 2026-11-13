/**
 * 用户详情抽屉：资料 / 角色 / 账号安全 / 危险操作。
 *
 * 取代旧页面的「编辑用户」「修改密码」「删除用户」三个页签 —— 那三个页签都要求
 * 先手动输入账号、再失焦触发加载，等于让管理员背账号；而且删除没有任何二次确认。
 * 现在从列表点行进入，进来就是这个人，破坏性操作各自带确认。
 */
import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, Button, Col, Divider, Drawer, Form, Input, Modal, Popconfirm, Radio, Row, Select, Space, Spin, Tag, Typography } from 'antd'
import { message } from '../../utils/feedback'
import { DeleteOutlined, KeyOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import * as usersApi from '../../api/users'
import { useIsMobile } from '../../hooks/useIsMobile'
import { ROLE_ADMIN, ROLE_LABEL, ROLE_TEACHER } from './roles'
import { ClassInput, GradeInput, RoleSelect, ScopeTags } from './ScopeFields'

interface UserDetail {
  username: string
  class: string
  name: string
  gender: string
  role: number
  role_name: string
  grade: string
  subjects: string[]
  status?: string
  graduated_year?: string
}

interface Props {
  username: string | null
  open: boolean
  onClose: () => void
  /** 资料/角色/删除后刷新台账与统计 */
  onChanged: () => void
  isAdmin: boolean
  gradeOptions: string[]
  classOptions: Array<{ value: string; label: string }>
  subjectOptions: string[]
}

interface ApiError {
  response?: { data?: { detail?: string } }
}

const errText = (err: unknown, fallback: string): string =>
  (err as ApiError)?.response?.data?.detail || (err instanceof Error ? err.message : fallback)

const sectionTitle = (text: string, hint?: string) => (
  <div style={{ display: 'block', width: '100%' }}>
    <Typography.Text strong>{text}</Typography.Text>
    {hint && (
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{hint}</Typography.Text>
      </div>
    )}
  </div>
)

const UserDetailDrawer: React.FC<Props> = ({
  username, open, onClose, onChanged, isAdmin, gradeOptions, classOptions, subjectOptions,
}) => {
  const { t } = useTranslation('system')
  const isMobile = useIsMobile()
  const [form] = Form.useForm()
  const [pwdForm] = Form.useForm()

  const [detail, setDetail] = useState<UserDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [roleValue, setRoleValue] = useState<number>(2)
  const [pwdOpen, setPwdOpen] = useState(false)
  const [pwdSaving, setPwdSaving] = useState(false)
  const [delOpen, setDelOpen] = useState(false)
  const [delText, setDelText] = useState('')
  const [delSaving, setDelSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)

  const isTeacher = detail?.role_name === '教师'
  const isGraduated = detail?.status === 'graduated'
  // 教师可编辑学生资料（后端 E-SCOPE 允许），教师/管理员账号只有管理员能动
  const profileEditable = isAdmin || detail?.role === 2

  useEffect(() => {
    if (!open || !username) return
    let alive = true
    setLoading(true)
    setDetail(null)
    usersApi.getUserInfo(username)
      .then((d: UserDetail) => {
        if (!alive) return
        setDetail(d)
        setRoleValue(d.role)
        form.setFieldsValue({
          name: d.name || '',
          gender: d.gender === '女' ? '女' : '男',
          grade: String(d.grade || ''),
          class_val: String(d.class ?? ''),
          subjects: d.subjects || [],
        })
      })
      .catch((err) => {
        if (alive) {
          message.error(errText(err, t('loadUserDetailFailed')))
          onClose()
        }
      })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, username])  // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveProfile = async () => {
    if (!username) return
    const v = form.getFieldsValue() as Record<string, unknown>
    setSaving(true)
    try {
      const msg = await usersApi.updateUserInfo(
        username,
        String(v.class_val ?? ''),
        String(v.name ?? ''),
        v.gender === '男' ? 1 : 0,
        String(v.grade ?? ''),
        (v.subjects as string[]) || [],
      )
      message.success(msg || t('saveSuccess'))
      // 同步抽屉头部，否则改完姓名/班级后标题还挂着旧值，看着像没保存成功
      setDetail(d => (d
        ? {
          ...d,
          name: String(v.name ?? ''),
          gender: v.gender === '男' ? '男' : '女',
          grade: String(v.grade ?? ''),
          class: String(v.class_val ?? ''),
          subjects: (v.subjects as string[]) || d.subjects,
        }
        : d))
      onChanged()
    } catch (err) {
      message.error(errText(err, t('updateFailed')))
    } finally {
      setSaving(false)
    }
  }

  const handleRoleChange = async () => {
    if (!username || !detail) return
    if (roleValue === detail.role) return
    try {
      const res = await usersApi.updateUserRole(username, roleValue)
      message.success(res.message)
      setDetail({ ...detail, role: roleValue, role_name: ROLE_LABEL[roleValue] })
      onChanged()
    } catch (err) {
      message.error(errText(err, t('updateFailed')))
    }
  }

  const handleResetPwd = async () => {
    if (!username) return
    const v = await pwdForm.validateFields()
    setPwdSaving(true)
    try {
      await usersApi.changePassword(username, v.new_password)
      message.success(t('resetDone'))
      setPwdOpen(false)
      pwdForm.resetFields()
    } catch (err) {
      message.error(errText(err, t('changePasswordFailed')))
    } finally {
      setPwdSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!username) return
    if (delText.trim() !== username) { message.warning(t('usernameMismatch')); return }
    setDelSaving(true)
    try {
      const msg = await usersApi.deleteUser(username)
      message.success(msg || t('deleteAccountDone'))
      setDelOpen(false)
      onChanged()
      onClose()
    } catch (err) {
      message.error(errText(err, t('deleteFailed')))
    } finally {
      setDelSaving(false)
    }
  }

  const handleRestore = async () => {
    if (!username) return
    setRestoring(true)
    try {
      const res = await usersApi.restoreGraduatedUser(username)
      message.success(res.message || t('restoreSuccess'))
      setDetail(d => (d ? { ...d, ...({ status: 'active' } as object) } : d))
      onChanged()
    } catch (err) {
      message.error(errText(err, t('restoreFailed')))
    } finally {
      setRestoring(false)
    }
  }

  const title = detail
    ? (
      <Space orientation="vertical" size={2}>
        <Space size={8} wrap>
          <Typography.Text strong style={{ fontSize: 16 }}>{detail.name || '—'}</Typography.Text>
          <Tag color={detail.role === ROLE_ADMIN ? 'red' : detail.role === ROLE_TEACHER ? 'blue' : 'default'}>
            {detail.role_name}
          </Tag>
          {isGraduated && <Tag color="orange">{t('graduateTag')}</Tag>}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{detail.username}</Typography.Text>
      </Space>
    )
    : (username || '')

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={isMobile ? '100%' : 460}
      title={title}
      styles={{ body: { paddingTop: 12 } }}
    >
      <Spin spinning={loading}>
        {detail && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('colGradeClass')}</Typography.Text>
              <div style={{ marginTop: 4 }}><ScopeTags grade={detail.grade} cls={detail.class} max={8} /></div>
            </div>

            <Divider style={{ margin: '12px 0' }} />
            {sectionTitle(t('drawerProfile'), t('profileBlankHint'))}
            <Form form={form} layout="vertical" style={{ marginTop: 12 }} disabled={!profileEditable}>
              <Row gutter={12}>
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
                <Col span={12}>
                  <Form.Item name="grade" label={t('gradeLabel')} style={{ marginBottom: 12 }}
                    extra={isTeacher ? t('multiGradeHelp') : undefined}>
                    {isTeacher
                      ? <Input placeholder={t('gradePlaceholder')} />
                      : <GradeInput options={gradeOptions} placeholder={t('gradePlaceholder')} />}
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item name="class_val" label={t('classLabel')} style={{ marginBottom: 12 }}
                    extra={isTeacher ? t('multiClassHelp') : undefined}>
                    {isTeacher
                      ? <Input placeholder={t('classPlaceholder')} />
                      : <ClassInput options={classOptions} placeholder={t('classPlaceholder')} />}
                  </Form.Item>
                </Col>
              </Row>
              {(detail.role === ROLE_TEACHER || detail.role === ROLE_ADMIN) && (
                <Form.Item name="subjects" label={t('teachingSubjectsLabel')} style={{ marginBottom: 12 }}
                  extra={t('configSubjectsFirst')}>
                  <Select mode="multiple" allowClear placeholder={t('selectSubjectsPlaceholder')}
                    options={subjectOptions.map(s => ({ label: s, value: s }))} />
                </Form.Item>
              )}
              <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={handleSaveProfile}>
                {t('saveChanges')}
              </Button>
            </Form>

            {isAdmin && (
              <>
                <Divider style={{ margin: '20px 0 12px' }} />
                {sectionTitle(t('drawerRole'), t('roleChangeHint'))}
                <Space style={{ marginTop: 12 }} wrap>
                  <RoleSelect value={roleValue} onChange={setRoleValue} />
                  <Popconfirm
                    title={t('roleChangeConfirm')}
                    description={t('roleChangeDesc', { name: detail.name || detail.username, role: ROLE_LABEL[roleValue] })}
                    okText={t('confirm')} cancelText={t('cancel')}
                    onConfirm={handleRoleChange}
                    disabled={roleValue === detail.role}
                  >
                    <Button disabled={roleValue === detail.role}>{t('saveChanges')}</Button>
                  </Popconfirm>
                </Space>
              </>
            )}

            <Divider style={{ margin: '20px 0 12px' }} />
            {sectionTitle(t('drawerSecurity'))}
            <Space style={{ marginTop: 12 }} wrap>
              <Button icon={<KeyOutlined />} onClick={() => { pwdForm.resetFields(); setPwdOpen(true) }}>
                {t('resetPasswordTitle')}
              </Button>
              {isGraduated && (
                <Button icon={<ReloadOutlined />} loading={restoring} onClick={handleRestore}>
                  {t('restoreBtn')}
                </Button>
              )}
            </Space>

            <Divider style={{ margin: '20px 0 12px' }} />
            {sectionTitle(t('drawerDanger'), t('deleteAccountWarn'))}
            <Button danger icon={<DeleteOutlined />} style={{ marginTop: 12 }}
              onClick={() => { setDelText(''); setDelOpen(true) }}>
              {t('deleteAccount')}
            </Button>
          </div>
        )}
      </Spin>

      <Modal
        title={t('resetPasswordFor', { name: detail?.name || detail?.username || '' })}
        open={pwdOpen}
        onCancel={() => setPwdOpen(false)}
        onOk={handleResetPwd}
        okText={t('resetPasswordTitle')}
        cancelText={t('cancel')}
        confirmLoading={pwdSaving}
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item name="new_password" label={t('newPassword')} rules={[{ required: true, message: t('passwordRequired') }]}>
            <Input.Password placeholder={t('newPassword')} autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="confirm_password" label={t('confirmPassword')} dependencies={['new_password']}
            rules={[
              { required: true, message: t('passwordRequired') },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('new_password') === value) return Promise.resolve()
                  return Promise.reject(new Error(t('passwordMismatch')))
                },
              }),
            ]}>
            <Input.Password placeholder={t('confirmPassword')} autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('deleteAccountTitle')}
        open={delOpen}
        onCancel={() => setDelOpen(false)}
        onOk={handleDelete}
        okText={t('deleteAccount')}
        cancelText={t('cancel')}
        okButtonProps={{ danger: true, disabled: delText.trim() !== username }}
        confirmLoading={delSaving}
      >
        <Space orientation="vertical" style={{ width: '100%' }} size="middle">
          <Alert type="error" showIcon
            title={t('deleteAccountWarn')}
            description={t('typeUsernameToConfirm', { username: username || '' })} />
          <Input value={delText} onChange={e => setDelText(e.target.value)}
            placeholder={username || ''} autoComplete="off" />
        </Space>
      </Modal>
    </Drawer>
  )
}

export default UserDetailDrawer
