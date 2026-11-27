// 测验编辑器「从题库选题」（P1-8）：勾选题库题目 → 映射成测验题目结构加入卷。
// 与练习的 prefer_bank 口径对称：测验不再只能手打/AI 整卷生成。
// 判断题答案统一成"对/错"；单选/多选答案统一成位置字母（选项字典按键序展开）。
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Input, Modal, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import apiClient from '../api/client'
import { reportLoadError } from '../utils/loadError'
import FormulaRenderer from './FormulaRenderer'
import useSubjectOptions from '../hooks/useSubjectOptions'
import { optionLetter, stripOptionPrefix } from '../utils/quizOptions'

const { Text } = Typography

interface BankQuestion {
  id: number
  type: string
  question_text: string
  options?: Record<string, string> | string[] | null
  correct_answer: string
  explanation?: string
  difficulty?: string
  subject?: string
  knowledge_points?: string
  svg_content?: string
  has_svg?: number
  media_files?: any[]
}

export interface PickedQuestion {
  type: 'single' | 'multiple' | 'true_false'
  question: string
  options: string[]
  answer: string
  score: number
  explanation: string
  svg_content?: string
  has_svg?: number
  media_files?: any[]
}

const TRUE_WORDS = ['对', '正确', '是', '√', 'true', 't', 'yes', 'y']

/** 题库行 → 测验题目；返回 null 表示题型不支持（简答/填空不进测验，产品口径：测验=客观题快答） */
function mapBankToQuiz(q: BankQuestion): PickedQuestion | null {
  const type = q.type === 'multiple' ? 'multiple' : q.type === 'true_false' ? 'true_false' : q.type === 'single' ? 'single' : null
  if (!type) return null
  let options: string[] = []
  if (Array.isArray(q.options)) options = q.options.map(o => stripOptionPrefix(o))
  else if (q.options && typeof q.options === 'object') {
    const keys = Object.keys(q.options).sort()
    options = keys.map(k => stripOptionPrefix(q.options![k as keyof typeof q.options]))
  }
  let answer = String(q.correct_answer ?? '').trim()
  if (type === 'true_false') {
    const low = answer.toLowerCase()
    answer = (TRUE_WORDS.includes(answer) || TRUE_WORDS.includes(low) || low === 'a') ? '对' : '错'
  } else {
    // 单选/多选：字母化（兼容 "A"/"AC"/"A,C"/下标）
    const nKeys = Math.max(options.length, 1)
    const valid = (v: string) => /^[A-J]$/.test(v)
    const raw = answer.toUpperCase().replace(/[,，、\s]/g, '')
    if (/^\d$/.test(raw)) {
      // 下标答案（0 基）
      const i = Number(raw)
      answer = i >= 0 && i < nKeys ? optionLetter(i) : ''
    } else if (raw.split('').every(valid)) {
      // 自查二轮：必须逗号分隔——编辑器多选答案键 value 用 split(',') 拆，
      // "AC" 会被当成一个长度为 2 的 token 过滤掉 → 答案不选中、保存校验误报
      answer = [...new Set(raw.split('').filter(valid))].sort().join(',')
    }
  }
  return {
    type,
    question: q.question_text || '',
    options,
    answer,
    score: 1,
    explanation: q.explanation || '',
    svg_content: q.svg_content || undefined,
    has_svg: q.has_svg || undefined,
    media_files: Array.isArray(q.media_files) && q.media_files.length ? q.media_files : undefined,
  }
}

const QuizBankPicker: React.FC<{
  open: boolean
  defaultSubject?: string
  onCancel: () => void
  onPick: (qs: PickedQuestion[]) => void
}> = ({ open, defaultSubject = '', onCancel, onPick }) => {
  const { t } = useTranslation('interaction')
  const { subjects } = useSubjectOptions()
  const [subject, setSubject] = useState('')
  const [type, setType] = useState<'all' | 'single' | 'multiple' | 'true_false'>('all')
  const [kw, setKw] = useState('')
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState<BankQuestion[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<React.Key[]>([])
  // 缓存的是题库原始行（onOk 时才映射成测验题目），变量名如实反映内容
  const [rowMap, setRowMap] = useState<Record<string, BankQuestion>>({})

  useEffect(() => {
    if (open) {
      setSubject(defaultSubject || '')
      setType('all'); setKw(''); setPage(1); setSelected([]); setRowMap({})
    }
  }, [open, defaultSubject])

  const load = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const { data } = await apiClient.get('/api/questions', {
        params: {
          subject: subject || undefined,
          type: type === 'all' ? undefined : type,
          keyword: kw.trim() || undefined,
          status: 'active', page, page_size: 20,
        },
      })
      setRows(data.questions || [])
      setTotal(data.total || 0)
    } catch (err) {
      reportLoadError(err, { key: 'quizBankPicker.load' })
    } finally { setLoading(false) }
  }, [open, subject, type, kw, page])

  useEffect(() => { void load() }, [load])

  const onSelect = (keys: React.Key[], info: any[]) => {
    setSelected(keys)
    const map: Record<string, BankQuestion> = { ...rowMap }
    // preserveSelectedRowKeys 跨页时 selectedRows 可能含 undefined 槽位（antd 已知行为）
    info.forEach((r: any) => { if (r && r.id != null) map[String(r.id)] = r })
    const keep = new Set(keys.map(String))
    Object.keys(map).forEach(k => { if (!keep.has(k)) delete map[k] })
    setRowMap(map)
  }

  const columns = useMemo(() => [
    {
      title: t('qmColType'), dataIndex: 'type', key: 'type', width: 84,
      render: (v: string) => <Tag>{t(v === 'multiple' ? 'multiple' : v === 'true_false' ? 'trueFalse' : 'single')}</Tag>,
    },
    {
      title: t('bankColStem'), dataIndex: 'question_text', key: 'q',
      render: (v: string) => (
        <Tooltip title={<div style={{ maxWidth: 420 }}><FormulaRenderer content={v} /></div>}>
          <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            <FormulaRenderer content={v} />
          </div>
        </Tooltip>
      ),
    },
    {
      title: t('bankColAnswer'), dataIndex: 'correct_answer', key: 'a', width: 88, ellipsis: true,
    },
    {
      title: t('bankColKp'), dataIndex: 'knowledge_points', key: 'kp', width: 140, ellipsis: true,
    },
  ], [t])

  return (
    <Modal title={t('bankPickTitle')} open={open} onCancel={onCancel}
      width="min(860px, 94vw)"
      okText={t('bankAddN', { count: selected.length })}
      okButtonProps={{ disabled: selected.length === 0 }}
      onOk={() => {
        // 关键：pickedMap 缓存的是题库原始行，这里才映射成测验题目结构；
        // 不支持的题型（简答/填空等）直接跳过并提示，避免 undefined 字段流进编辑器炸渲染
        const raw = selected.map(k => rowMap[String(k)]).filter(Boolean)
        const mapped = raw.map(mapBankToQuiz).filter((q): q is PickedQuestion => !!q)
        const skipped = raw.length - mapped.length
        if (!mapped.length) { return }
        if (skipped > 0) message.warning(t('bankSkippedN', { count: skipped }))
        onPick(mapped)
      }}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder={t('subject')} style={{ width: 140 }}
          value={subject || undefined}
          onChange={(v) => { setSubject(v || ''); setPage(1) }}
          options={subjects.map(s => ({ value: s, label: s }))} />
        <Segmented value={type} onChange={(v) => { setType(v as any); setPage(1) }}
          options={[
            { value: 'all', label: t('bankTypeAll') },
            { value: 'single', label: t('single') },
            { value: 'multiple', label: t('multiple') },
            { value: 'true_false', label: t('trueFalse') },
          ]} />
        <Input allowClear prefix={<SearchOutlined />} style={{ width: 220 }}
          placeholder={t('bankSearchPh')} value={kw}
          onChange={(e) => { setKw(e.target.value) }} onPressEnter={() => setPage(1)} />
        <Text type="secondary" style={{ fontSize: 12 }}>{t('bankTotalN', { count: total })}</Text>
      </Space>
      <Table rowKey="id" size="small" loading={loading}
        dataSource={rows} columns={columns as any}
        rowSelection={{ type: 'checkbox', selectedRowKeys: selected, preserveSelectedRowKeys: true,
          onChange: (keys: React.Key[], rows: any[]) => onSelect(keys, rows) }}
        locale={{ emptyText: t('bankEmpty') }}
        pagination={{ current: page, pageSize: 20, total, size: 'small',
          showTotal: (num: number) => t('bankTotalN', { count: num }),
          onChange: (p) => setPage(p) }} />
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>{t('bankPickHint')}</Text>
    </Modal>
  )
}

export default QuizBankPicker
