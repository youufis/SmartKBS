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
      { value: 'class', label: <><BookOutlined /> 指定年级/班级</>, desc: '对选中的年级或班级的用户可见（含任教教师）' },
      { value: 'teacher', label: <><UserOutlined /> 指定教师/管理员</>, desc: '仅对选中的教师或管理员用户可见' },
      { value: 'staff', label: <><TeamOutlined /> 全体教师</>, desc: '对全体教师和管理员可见' },
    ]
    if (isAdmin) {
      opts.unshift({ value: 'all', label: <><GlobalOutlined /> 所有人</>, desc: '所有用户可见（含教师和学生）' })
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
          message.info('未做任何更改')
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
          message.success('共享范围已更新')
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
          message.success('已追加共享目标')
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
          message.success('已移除所选共享目标')
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
          message.success('共享已更新')
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
        message.success('共享成功')
      }
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
    if (!existingShare) return '确认共享'
    const changes = computeChanges
    if (!changes) return '确认共享'
    if (changes.mode === 'append') return '追加共享'
    if (changes.mode === 'remove') return '移除所选'
    if (changes.scopeChanged) return '更新共享范围'
    return '确认共享'
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
              <BookOutlined /> 选择年级：
            </Typography.Text>
            <Checkbox
              checked={gradeSelectAll}
              indeterminate={selectedGrades.length > 0 && selectedGrades.length < grades.length}
              onChange={(e) => handleGradeSelectAll(e.target.checked)}
            >
              全选年级
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
                <BookOutlined /> 选择班级（可选，不选表示整个年级）：
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
                全选班级
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
                        全选
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
            所选年级暂无班级数据
          </Typography.Text>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8, color: '#999' }}>
          提示：不选择班级表示共享给整个年级的所有班级；教师和管理员也能看到共享给其任教年级/班级的资源。
        </Typography.Text>
      </div>
    )
  }

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
              <Button type="primary" icon={<ShareAltOutlined />} onClick={handleShare} loading={loading}
                disabled={!canShare}>
                单独共享此文件
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
      <Space direction="vertical" style={{ width: '100%' }} size={16}>
        <Typography.Text ellipsis style={{ maxWidth: 520 }}>
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
          <>
            <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
              该文件已共享，可在下方追加新目标、移除现有目标，或点击「取消共享」停止共享。
            </Typography.Text>

            {/* ── 当前共享目标概览（可移除） ── */}
            <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: '10px 14px', background: '#fafafa', marginBottom: 12 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>当前共享目标</Typography.Text>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {/* 共享范围标签 */}
                <Tag color="purple" style={{ margin: 0 }}>
                  {existingShare.share_scope === 'all' ? '所有人' :
                   existingShare.share_scope === 'staff' ? '全体教师' :
                   existingShare.share_scope === 'teacher' ? '指定教师' : '指定年级/班级'}
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
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>全部用户</Typography.Text>
                )}
              </div>
              <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
                点击标签上的 × 可移除此目标
              </Typography.Text>
            </div>

            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text strong>修改共享范围</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
              可在此追加新目标、更改范围，或在上方点击 × 移除现有目标
            </Typography.Text>
          </>
        ) : (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Typography.Text strong>共享范围</Typography.Text>

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
              <Space direction="vertical" style={{ width: '100%' }} size={8}>
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
                  <UserOutlined /> 选择教师或管理员（可多选）：
                </Typography.Text>
                <Select
                  mode="multiple"
                  placeholder="搜索并选择用户"
                  value={selectedTeachers}
                  onChange={setSelectedTeachers}
                  style={{ width: '100%', marginTop: 8 }}
                  showSearch
                  filterOption={(input, option) =>
                    (option?.label as string || '').toLowerCase().includes(input.toLowerCase())
                  }
                  options={teachers.map(t => ({
                    value: t.username,
                    label: `${t.name} (${t.username}${t.role === '管理员' ? ' ·管理员' : ''})`,
                  }))}
                  tagRender={(props) => {
                    const { label, closable, onClose } = props
                    return <Tag closable={closable} onClose={onClose} style={{ margin: 2 }}>{label}</Tag>
                  }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6, color: '#999' }}>
                  选中的用户将可以看到此共享资源
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
