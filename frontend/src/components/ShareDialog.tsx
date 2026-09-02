import { useTranslation } from 'react-i18next'
import React, { useState, useEffect, useMemo } from 'react'
import { Modal, message, Space, Typography, Button, Radio, Select, Divider, Tag, Checkbox } from 'antd'
import {
  ShareAltOutlined, StopOutlined, TeamOutlined, GlobalOutlined,
  BookOutlined, UserOutlined, FolderOutlined, CheckCircleFilled,
} from '@ant-design/icons'
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

interface GradeClassInfo {
  grade: string
  classes: string[]
}

const ShareDialog: React.FC<ShareDialogProps> = ({
  open, onClose, filePath, fileName, resourceType, existingShare, onSuccess,
  inheritedFromDir = false,
}) => {
  const { t } = useTranslation('common')
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
  const [classOptions, setClassOptions] = useState<GradeClassInfo[]>([])

  // 全选状态
  const [gradeSelectAll, setGradeSelectAll] = useState(false)
  const [classSelectAll, setClassSelectAll] = useState(false)

  const parseCSV = (csv: string): string[] => csv ? csv.split(',').filter(Boolean) : []

  // ── 可用范围选项 ──
  const scopeOptions = useMemo(() => {
    const opts: { value: ShareScope; label: React.ReactNode; desc: string }[] = [
      { value: 'class', label: <><BookOutlined /> {t('sdScopeClass')}</>, desc: t('sdScopeClassDesc') },
      { value: 'teacher', label: <><UserOutlined /> {t('sdScopeTeacher')}</>, desc: t('sdScopeTeacherDesc') },
      { value: 'staff', label: <><TeamOutlined /> {t('sdScopeStaff')}</>, desc: t('sdScopeStaffDesc') },
    ]
    if (isAdmin) {
      opts.unshift({ value: 'all', label: <><GlobalOutlined /> {t('sdScopeAll')}</>, desc: t('sdScopeAllDesc') })
    }
    return opts
  }, [isAdmin])

  // ── 加载基础数据 ──
  useEffect(() => {
    if (open) {
      // 从 existingShare 恢复状态
      if (existingShare) {
        setScope(existingShare.share_scope)
        setSelectedTeachers(parseCSV(existingShare.target_users))
        setSelectedGrades(parseCSV(existingShare.target_grade))
        setSelectedClasses(parseCSV(existingShare.target_class))
      } else {
        setScope(isAdmin ? 'all' : 'class')
        setSelectedTeachers([])
        setSelectedGrades([])
        setSelectedClasses([])
        setGradeSelectAll(false)
        setClassSelectAll(false)
      }

      // 加载教师/管理员列表
      apiClient.get('/api/users', { params: { keyword: '' } }).then(res => {
        const allUsers: sharingApi.UserItem[] = res.data?.users || []
        setTeachers(allUsers.filter(u => u.role === '教师' || u.role === '管理员'))
      }).catch(() => {})

      // 加载年级列表
      apiClient.get('/api/rollcall/grades').then(res => {
        const gs: string[] = Array.isArray(res.data) ? res.data : []
        setGrades(gs)
        // 非管理员（教师）默认选中全部年级
        if (!isAdmin && !existingShare && gs.length > 0) {
          setSelectedGrades([...gs])
          setGradeSelectAll(true)
        }
      }).catch(() => {})
    }
  }, [open, existingShare, isAdmin, isTeacher])

  // ── 加载班级列表 ──
  useEffect(() => {
    if (open && grades.length > 0) {
      Promise.all(grades.map(g =>
        apiClient.get('/api/rollcall/classes', { params: { grade: g } })
          .then(res => ({ grade: g, classes: Array.isArray(res.data) ? res.data : [] }))
          .catch(() => ({ grade: g, classes: [] }))
      )).then(setClassOptions)
    }
  }, [open, grades])

  // ── 保持 selectAll 状态与选中值同步 ──
  useEffect(() => {
    if (grades.length > 0) {
      setGradeSelectAll(selectedGrades.length === grades.length && grades.length > 0)
    }
  }, [selectedGrades, grades])

  useEffect(() => {
    const allClasses = classOptions
      .filter(opt => selectedGrades.includes(opt.grade))
      .flatMap(opt => opt.classes)
    setClassSelectAll(allClasses.length > 0 && allClasses.every(c => selectedClasses.includes(c)))
  }, [selectedClasses, selectedGrades, classOptions])

  // ── 全选/取消全选 年级 ──
  const handleGradeSelectAll = (checked: boolean) => {
    setGradeSelectAll(checked)
    if (checked) {
      setSelectedGrades([...grades])
    } else {
      setSelectedGrades([])
      setSelectedClasses([])
      setClassSelectAll(false)
    }
  }

  // ── 年级选择变化 ──
  const handleGradeChange = (vals: string[]) => {
    setSelectedGrades(vals)
    // 清除不在已选年级中的班级
    setSelectedClasses(prev => prev.filter(c =>
      classOptions.some(opt => vals.includes(opt.grade) && opt.classes.includes(c))
    ))
    setGradeSelectAll(vals.length === grades.length && grades.length > 0)
    // 如果班级全选状态维持需要重新计算
    if (vals.length === 0) {
      setClassSelectAll(false)
    } else {
      // 重新计算班级全选
      const allClasses = classOptions
        .filter(opt => vals.includes(opt.grade))
        .flatMap(opt => opt.classes)
      setClassSelectAll(
        allClasses.length > 0 &&
        allClasses.every(c => selectedClasses.includes(c))
      )
    }
  }

  // ── 班级全选/取消 ──
  const handleClassSelectAll = (checked: boolean) => {
    setClassSelectAll(checked)
    if (checked) {
      const allClasses = classOptions
        .filter(opt => selectedGrades.includes(opt.grade))
        .flatMap(opt => opt.classes)
      setSelectedClasses(allClasses)
    } else {
      setSelectedClasses([])
    }
  }

  // ── 班级选择变化 ──
  const handleClassChange = (vals: string[]) => {
    setSelectedClasses(vals)
    const allClasses = classOptions
      .filter(opt => selectedGrades.includes(opt.grade))
      .flatMap(opt => opt.classes)
    setClassSelectAll(allClasses.length > 0 && allClasses.every(c => vals.includes(c)))
  }

  // ── 确认共享（自动判断追加/移除/覆盖） ──
  const handleShare = async () => {
    setLoading(true)
    try {
      if (existingShare) {
        // ── 编辑已有共享：根据变更类型选择模式 ──
        const changes = computeChanges
        if (!changes) {
          message.info(t('sdNoChange'))
          setLoading(false)
          return
        }

        if (changes.scopeChanged) {
          // 范围变了 → 覆盖模式
          await sharingApi.shareResource({
            file_path: filePath,
            file_name: fileName,
            resource_type: resourceType,
            share_scope: scope,
            target_users: scope === 'teacher' ? selectedTeachers : [],
            target_grades: scope === 'class' ? selectedGrades : [],
            target_classes: scope === 'class' ? selectedClasses : [],
            mode: 'replace',
          })
          message.success(t('sdScopeUpdated'))
        } else if (changes.mode === 'append') {
          // 纯追加
          await sharingApi.shareResource({
            file_path: filePath,
            file_name: fileName,
            resource_type: resourceType,
            share_scope: scope,
            target_users: changes.addUsers,
            target_grades: changes.addGrades,
            target_classes: changes.addClasses,
            mode: 'append',
          })
          message.success(t('sdAppended'))
        } else if (changes.mode === 'remove') {
          // 纯移除
          await sharingApi.shareResource({
            file_path: filePath,
            file_name: fileName,
            resource_type: resourceType,
            share_scope: scope,
            target_users: changes.removeUsers,
            target_grades: changes.removeGrades,
            target_classes: changes.removeClasses,
            mode: 'remove',
          })
          message.success(t('sdRemovedTargets'))
        } else {
          // 混合变更（既有追加又有移除）→ 用 replace 发送完整状态
          await sharingApi.shareResource({
            file_path: filePath,
            file_name: fileName,
            resource_type: resourceType,
            share_scope: scope,
            target_users: scope === 'teacher' ? selectedTeachers : [],
            target_grades: scope === 'class' ? selectedGrades : [],
            target_classes: scope === 'class' ? selectedClasses : [],
            mode: 'replace',
          })
          message.success(t('sdUpdated'))
        }
      } else {
        // ── 新建共享 ──
        await sharingApi.shareResource({
          file_path: filePath,
          file_name: fileName,
          resource_type: resourceType,
          share_scope: scope,
          target_users: scope === 'teacher' ? selectedTeachers : [],
          target_grades: scope === 'class' ? selectedGrades : [],
          target_classes: scope === 'class' ? selectedClasses : [],
          mode: 'replace',
        })
        message.success(t('sdSuccess'))
      }
      onSuccess?.()
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('sdFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleUnshare = async () => {
    if (!existingShare) return
    setLoading(true)
    try {
      await sharingApi.unshareResource(existingShare.id)
      message.success(t('sdUnshared'))
      onSuccess?.()
      onClose()
    } catch (err: any) {
      message.error(err?.response?.data?.detail || t('sdUnshareFailed'))
    } finally {
      setLoading(false)
    }
  }

  // ── 计算需要追加/移除的目标（用于编辑已有共享时优化请求） ──
  const computeChanges = useMemo(() => {
    if (!existingShare) return null
    const origUsers = parseCSV(existingShare.target_users)
    const origGrades = parseCSV(existingShare.target_grade)
    const origClasses = parseCSV(existingShare.target_class)

    const newUsers = selectedTeachers
    const newGrades = selectedGrades
    const newClasses = selectedClasses

    const addUsers = newUsers.filter(u => !origUsers.includes(u))
    const removeUsers = origUsers.filter(u => !newUsers.includes(u))
    const addGrades = newGrades.filter(g => !origGrades.includes(g))
    const removeGrades = origGrades.filter(g => !newGrades.includes(g))
    const addClasses = newClasses.filter(c => !origClasses.includes(c))
    const removeClasses = origClasses.filter(c => !newClasses.includes(c))
    const scopeChanged = scope !== existingShare.share_scope

    // 判断操作类型
    let mode: 'replace' | 'append' | 'remove' = 'replace'
    if (!scopeChanged && addUsers.length === 0 && addGrades.length === 0 && addClasses.length === 0
        && (removeUsers.length > 0 || removeGrades.length > 0 || removeClasses.length > 0)) {
      mode = 'remove'
    } else if (!scopeChanged && (addUsers.length > 0 || addGrades.length > 0 || addClasses.length > 0)
               && removeUsers.length === 0 && removeGrades.length === 0 && removeClasses.length === 0) {
      mode = 'append'
    }

    return { addUsers, removeUsers, addGrades, removeGrades, addClasses, removeClasses, mode, scopeChanged }
  }, [existingShare, selectedTeachers, selectedGrades, selectedClasses, scope])

  // ── 验证是否可以共享 ──
  const canShare = useMemo(() => {
    if (scope === 'teacher') return selectedTeachers.length > 0
    if (scope === 'class') return selectedGrades.length > 0
    return true // 'all' 和 'staff' 无需额外选择
  }, [scope, selectedTeachers, selectedGrades])

  // ── 确定共享按钮文案 ──
  const shareButtonText = useMemo(() => {
    if (!existingShare) return t('sdConfirm')
    const changes = computeChanges
    if (!changes) return t('sdConfirm')
    if (changes.mode === 'append') return t('sdAppend')
    if (changes.mode === 'remove') return t('sdRemoveSel')
    if (changes.scopeChanged) return t('sdUpdateScope')
    return t('sdConfirm')
  }, [existingShare, computeChanges])

  // ── 渲染年级/班级选择器（带全选） ──
  const renderGradeClassSelector = () => {
    // 按年级分组的班级数据
    const gradeClassData = classOptions
      .filter(opt => opt.classes.length > 0)

    return (
      <div style={{ paddingLeft: 8 }}>
        {/* 年级全选 + 列表 */}
        <div style={{ marginBottom: 12 }}>
          <Space style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between' }}>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              <BookOutlined /> {t('sdPickGrades')}
            </Typography.Text>
            <Checkbox
              checked={gradeSelectAll}
              indeterminate={selectedGrades.length > 0 && selectedGrades.length < grades.length}
              onChange={(e) => handleGradeSelectAll(e.target.checked)}
            >
              {t('sdAllGradesSel')}
            </Checkbox>
          </Space>
          <Checkbox.Group
            value={selectedGrades}
            onChange={handleGradeChange}
            style={{ width: '100%', display: 'flex', flexWrap: 'wrap', gap: 8 }}
          >
            {grades.map(g => (
              <div
                key={g}
                style={{
                  border: selectedGrades.includes(g) ? '1px solid #1677ff' : '1px solid #d9d9d9',
                  borderRadius: 6, padding: '4px 12px',
                  background: selectedGrades.includes(g) ? '#f0f5ff' : '#fff',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  const newVals = selectedGrades.includes(g)
                    ? selectedGrades.filter(v => v !== g)
                    : [...selectedGrades, g]
                  handleGradeChange(newVals)
                }}
              >
                <Checkbox value={g}>{g}</Checkbox>
              </div>
            ))}
          </Checkbox.Group>
        </div>

        {/* 班级选择（按年级分组） */}
        {selectedGrades.length > 0 && gradeClassData.length > 0 && (
          <div
            style={{
              border: '1px solid #e8e8e8',
              borderRadius: 8, padding: '12px',
              background: '#fafafa',
            }}
          >
            <Space style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                <BookOutlined /> {t('sdPickClasses')}
              </Typography.Text>
              <Checkbox
                checked={classSelectAll}
                indeterminate={
                  selectedClasses.length > 0 &&
                  selectedClasses.length <
                    classOptions.filter(opt => selectedGrades.includes(opt.grade))
                      .flatMap(opt => opt.classes).length
                }
                onChange={(e) => handleClassSelectAll(e.target.checked)}
              >
                {t('sdAllClassesSel')}
              </Checkbox>
            </Space>

            {gradeClassData
              .filter(opt => selectedGrades.includes(opt.grade))
              .map(({ grade, classes }) => {
                const gradeSelectedClasses = selectedClasses.filter(c => classes.includes(c))
                const allSelected = gradeSelectedClasses.length === classes.length
                const indeterminate = gradeSelectedClasses.length > 0 && !allSelected

                return (
                  <div key={grade} style={{ marginBottom: 8, padding: '6px 8px', background: '#fff', borderRadius: 6, border: '1px solid #f0f0f0' }}>
                    <Space style={{ marginBottom: 4 }}>
                      <Typography.Text strong style={{ fontSize: 12, color: '#666' }}>{grade}</Typography.Text>
                      <Checkbox
                        checked={allSelected}
                        indeterminate={indeterminate}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedClasses(prev => [...new Set([...prev, ...classes])])
                          } else {
                            setSelectedClasses(prev => prev.filter(c => !classes.includes(c)))
                          }
                        }}
                        style={{ fontSize: 11 }}
                      >
                        {t('sdSelectAll')}
                      </Checkbox>
                      {allSelected && <CheckCircleFilled style={{ color: '#52c41a', fontSize: 12 }} />}
                    </Space>
                    <Checkbox.Group
                      value={selectedClasses}
                      onChange={handleClassChange}
                      style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
                    >
                      {classes.map(c => (
                        <Tag
                          key={c}
                          color={selectedClasses.includes(c) ? 'blue' : 'default'}
                          style={{ cursor: 'pointer', margin: 0, userSelect: 'none' }}
                          onClick={() => {
                            const newVals = selectedClasses.includes(c)
                              ? selectedClasses.filter(v => v !== c)
                              : [...selectedClasses, c]
                            handleClassChange(newVals)
                          }}
                        >
                          {c}
                        </Tag>
                      ))}
                    </Checkbox.Group>
                  </div>
                )
              })}
          </div>
        )}

        {/* 空状态提示 */}
        {selectedGrades.length > 0 && gradeClassData.length === 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
            {t('sdNoClasses')}
          </Typography.Text>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8, color: '#999' }}>
          {t('sdClassHint')}
        </Typography.Text>
      </div>
    )
  }

  return (
    <Modal
      title={<><ShareAltOutlined style={{ color: '#ff4d4f' }} /> {isShared ? t('sdManage') : t('sdShareRes')}</>}
      open={open}
      onCancel={onClose}
      footer={
        <Space style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <div>
            {isShared && !inheritedFromDir && (
              <Button danger type="text" icon={<StopOutlined />} onClick={handleUnshare} loading={loading}>
                {t('sdUnshare')}
              </Button>
            )}
          </div>
          <Space>
            <Button onClick={onClose}>{t('sdClose')}</Button>
            {inheritedFromDir ? (
              <Button type="primary" icon={<ShareAltOutlined />} onClick={handleShare} loading={loading}
                disabled={!canShare}>
                {t('sdShareSelf')}
              </Button>
            ) : (
              <Button type="primary" icon={<ShareAltOutlined />} onClick={handleShare} loading={loading}
                disabled={!canShare}>
                {shareButtonText}
              </Button>
            )}
          </Space>
        </Space>
      }
      width={560}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size={16}>
        <Typography.Text ellipsis style={{ maxWidth: 520 }}>
          <strong>{t('sdFileLabel')}</strong>{fileName}
        </Typography.Text>

        {inheritedFromDir ? (
          <>
            <Typography.Text type="secondary">
              <FolderOutlined style={{ marginRight: 4 }} />
              {t('sdInheritA')} <strong>{existingShare?.file_name}</strong> {t('sdInheritB')}
            </Typography.Text>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text strong>{t('sdOwnSettings')}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block' }}>
              {t('sdOwnHint')}
            </Typography.Text>
          </>
        ) : isShared ? (
          <>
            <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              {t('sdAlreadyShared')}
            </Typography.Text>

            {/* ── 当前共享目标概览（可移除） ── */}
            <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: '10px 14px', background: '#fafafa', marginBottom: 12 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>{t('sdCurrentTargets')}</Typography.Text>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {/* 共享范围标签 */}
                <Tag color="purple" style={{ margin: 0 }}>
                  {existingShare.share_scope === 'all' ? t('sdScopeAll') :
                   existingShare.share_scope === 'staff' ? t('sdScopeStaff') :
                   existingShare.share_scope === 'teacher' ? t('sdScopeTeacher') : t('sdScopeClass')}
                </Tag>

                {/* 目标用户 */}
                {parseCSV(existingShare.target_users).map(u => {
                  const teacher = teachers.find(t => t.username === u)
                  return (
                    <Tag
                      key={`u:${u}`}
                      closable
                      onClose={() => {
                        setSelectedTeachers(prev => prev.filter(t => t !== u))
                      }}
                      color="blue"
                      style={{ margin: 0 }}
                    >
                      <UserOutlined /> {teacher ? `${teacher.name}(${u})` : u}
                    </Tag>
                  )
                })}

                {/* 目标年级 */}
                {parseCSV(existingShare.target_grade).map(g => (
                  <Tag
                    key={`g:${g}`}
                    closable
                    onClose={() => {
                      setSelectedGrades(prev => prev.filter(v => v !== g))
                    }}
                    color="green"
                    style={{ margin: 0 }}
                  >
                    <BookOutlined /> {g}
                  </Tag>
                ))}

                {/* 目标班级 */}
                {parseCSV(existingShare.target_class).map(c => (
                  <Tag
                    key={`c:${c}`}
                    closable
                    onClose={() => {
                      setSelectedClasses(prev => prev.filter(v => v !== c))
                    }}
                    color="cyan"
                    style={{ margin: 0 }}
                  >
                    {c}
                  </Tag>
                ))}

                {!existingShare.target_users && !existingShare.target_grade && !existingShare.target_class && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('sdAllUsers')}</Typography.Text>
                )}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
                {t('sdRemoveHint')}
              </Typography.Text>
            </div>

            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text strong>{t('sdModifyScope')}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
              {t('sdModifyHint')}
            </Typography.Text>
          </>
        ) : (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text strong>{t('sdScopeLabel')}</Typography.Text>

            {/* ── 统一范围选择 Radio ── */}
            <Radio.Group
              value={scope}
              onChange={(e) => {
                const newScope = e.target.value as ShareScope
                setScope(newScope)
                // 切到 class 时默认填充可用年级
                if (newScope === 'class' && selectedGrades.length === 0 && grades.length > 0) {
                  setSelectedGrades([...grades])
                  setGradeSelectAll(true)
                }
              }}
              style={{ width: '100%' }}
            >
              <Space orientation="vertical" style={{ width: '100%' }} size={8}>
                {scopeOptions.map(opt => {
                  const disabled = isTeacher && opt.value === 'all'
                  return (
                    <div
                      key={opt.value}
                      style={{
                        border: scope === opt.value ? '1px solid #1677ff' : '1px solid #d9d9d9',
                        borderRadius: 8, padding: '10px 14px', cursor: disabled ? 'not-allowed' : 'pointer',
                        background: scope === opt.value ? '#f0f5ff' : '#fff',
                        opacity: disabled ? 0.5 : 1,
                      }}
                      onClick={() => {
                        if (!disabled) setScope(opt.value as ShareScope)
                      }}
                    >
                      <Radio value={opt.value} disabled={disabled}>{opt.label}</Radio>
                      <div style={{ fontSize: 12, color: '#999', marginTop: 4, marginLeft: 24 }}>
                        {opt.desc}
                      </div>
                    </div>
                  )
                })}
              </Space>
            </Radio.Group>

            {/* ── 指定教师/管理员（teacher 范围） ── */}
            {scope === 'teacher' && (
              <div style={{ paddingLeft: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  <UserOutlined /> {t('sdPickUsers')}
                </Typography.Text>
                <Select
                  mode="multiple"
                  placeholder={t('sdUserPh')}
                  value={selectedTeachers}
                  onChange={setSelectedTeachers}
                  style={{ width: '100%', marginTop: 8 }}
                  showSearch
                  filterOption={(input, option) =>
                    (option?.label as string || '').toLowerCase().includes(input.toLowerCase())
                  }
                  options={teachers.map((u) => ({
                    value: u.username,
                    label: `${u.name} (${u.username}${u.role === '管理员' ? ' ·' + t('sdAdminTag') : ''})`,
                  }))}
                  tagRender={(props) => {
                    const { label, closable, onClose } = props
                    return <Tag closable={closable} onClose={onClose} style={{ margin: 2 }}>{label}</Tag>
                  }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6, color: '#999' }}>
                  {t('sdSelectedVisible')}
                </Typography.Text>
              </div>
            )}

            {/* ── 指定年级/班级（class 范围） ── */}
            {scope === 'class' && renderGradeClassSelector()}
          </>
        )}
      </Space>
    </Modal>
  )
}

export default ShareDialog
