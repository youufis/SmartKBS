import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Modal, Form, Input, Select, Radio, Checkbox, Segmented, Button, Space, Row, Col,
  Tag, Typography, Collapse, Tabs, Tooltip, Alert,
} from 'antd'
import { PlusOutlined, DeleteOutlined, SwapOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import apiClient from '../api/client'
import KnowledgePointSelect, { splitKps, joinKps } from './KnowledgePointSelect'
import FormulaRenderer from './FormulaRenderer'
import QuestionMediaPanel from './QuestionMediaPanel'
import { TYPE_OPTIONS } from '../constants/questionTypes'
import { closeWithDirtyGuard } from '../utils/dirtyClose'
import { message } from '../utils/feedback'
import type { QuestionInfo } from '../types'

const { TextArea } = Input
const CHOICE = new Set(['single', 'multiple'])
const TEXT_ANSWER = new Set(['short', 'fill', 'essay', 'subjective'])
const letterOf = (i: number) => String.fromCharCode(65 + i)
/** 含公式才自动展开预览：纯文字题展开只是把输入再念一遍，白占半屏 */
const hasFormula = (s: string) => /\$|\\[a-zA-Z]+|\\ce\{/.test(s || '')

export type QuestionFormMode = 'create' | 'edit'

interface Props {
  open: boolean
  mode: QuestionFormMode
  /** edit 时的原题；create 时为空 */
  question?: QuestionInfo | null
  subjectOptions: string[]
  /** 从「配图」入口打开时直接落在配图页 */
  initialTab?: 'form' | 'media'
  /** 只看不改（深链打开别人创建的题时用） */
  readOnly?: boolean
  onClose: () => void
  /** 保存成功或配图变更后通知页面刷新列表（不负责关闭弹窗） */
  onSaved: () => void
}

/**
 * 试题表单弹窗：一个组件同时承担「手动录入」与「编辑」。
 *
 * 设计要点（对应上一轮审查的结论）：
 *   - 正确答案不再手打字母：勾选项左侧的单选/复选框即答案，选项编号 A/B/C/D 只读；
 *   - 预览合并为一个可折叠块，且只有含公式时默认展开 —— 弹窗高度从 1316px 降到 ~700px；
 *   - 弹窗 centered + body 内滚动，保存按钮常驻，不再需要滚动整页才能点保存；
 *   - 配图从「弹窗套弹窗」改为同弹窗内的第二个页签，状态单向往回同步。
 */
const QuestionFormModal: React.FC<Props> = ({
  open, mode, question, subjectOptions, initialTab, readOnly = false, onClose, onSaved,
}) => {
  const { t } = useTranslation('questions')
  const { t: tc } = useTranslation('common')
  const [form] = Form.useForm()

  const watchedType = (Form.useWatch('type', form) as string) || 'single'
  const watchedSubject = (Form.useWatch('subject', form) as string) || ''
  const watchedText = (Form.useWatch('question_text', form) as string) || ''
  const watchedExplanation = (Form.useWatch('explanation', form) as string) || ''

  const [options, setOptions] = useState<string[]>(['', '', '', ''])
  const [answers, setAnswers] = useState<number[]>([])
  const [tf, setTf] = useState<'对' | '错'>('对')
  const [refAnswer, setRefAnswer] = useState('')
  const [kps, setKps] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [tab, setTab] = useState<'form' | 'media'>('form')
  const [mediaQuestion, setMediaQuestion] = useState<QuestionInfo | null>(null)
  const [previewKeys, setPreviewKeys] = useState<string[]>([])

  /** 同一道题重新渲染（列表刷新导致 question 引用变化）时不能重置正在编辑的表单 */
  const initedRef = useRef('')

  const subjectChoices = useMemo(() => {
    const set = new Set(subjectOptions)
    // 存量题的学科可能已不在配置里：先让它在下拉里显示出来，否则一保存就 400
    if (question?.subject) set.add(question.subject)
    return [...set].map((s) => ({ value: s, label: s }))
  }, [subjectOptions, question])

  useEffect(() => {
    if (!open) { initedRef.current = ''; return }
    const key = `${mode}:${question?.id ?? 'new'}`
    if (initedRef.current === key) return
    initedRef.current = key

    const q = question
    const qtype = (q?.type as string) || 'single'
    const subject = q?.subject || subjectOptions[0] || ''
    let opts: string[] = []
    let optionKeys: string[] = []
    if (q?.options && typeof q.options === 'object') {
      // 选项 key 可能不连续（旧编辑器允许删掉 C 后留下 A/B/D）：
      // 必须按"字母在 key 序列里的位置"还原答案，不能直接 charCode-65
      optionKeys = Object.keys(q.options).sort()
      opts = optionKeys.map((k) => String((q.options as Record<string, string>)[k]))
    }
    if (opts.length < 2) opts = ['', '', '', '']

    form.setFieldsValue({
      type: qtype,
      subject,
      question_text: q?.question_text || '',
      explanation: q?.explanation || '',
      difficulty: q?.difficulty || 'medium',
    })
    setOptions(opts)
    setKps(splitKps(q?.knowledge_points || ''))
    setTab(initialTab || 'form')
    setDirty(false)
    setSaving(false)
    setMediaQuestion(q || null)

    if (CHOICE.has(qtype)) {
      const letters = String(q?.correct_answer || '').toUpperCase().replace(/[^A-Z]/g, '')
      const picked = letters.split('').map((ch) => optionKeys.indexOf(ch)).filter((i) => i >= 0 && i < opts.length)
      setAnswers([...new Set(picked)])
      setTf('对')
      setRefAnswer('')
    } else if (qtype === 'true_false') {
      const a = String(q?.correct_answer || '对').trim()
      setAnswers([])
      setTf(a === '错' || a === 'F' || a.toLowerCase() === 'false' ? '错' : '对')
      setRefAnswer('')
    } else {
      setAnswers([])
      setTf('对')
      setRefAnswer(q?.correct_answer || '')
    }
    setPreviewKeys(hasFormula(q?.question_text || '') ? ['p'] : [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, question, mode, initialTab])

  const markDirty = () => setDirty(true)

  const onTypeChange = (v: string) => {
    markDirty()
    if (CHOICE.has(v)) {
      if (options.length < 2) setOptions(['', '', '', ''])
      if (v === 'single') setAnswers((a) => a.slice(0, 1))
    } else {
      setAnswers([])
    }
  }

  const setOptionAt = (i: number, v: string) => {
    markDirty()
    setOptions((o) => o.map((x, idx) => (idx === i ? v : x)))
  }
  const addOption = () => {
    if (options.length >= 10) return
    markDirty()
    setOptions((o) => [...o, ''])
  }
  const removeOption = (i: number) => {
    markDirty()
    setOptions((o) => o.filter((_, idx) => idx !== i))
    setAnswers((a) => a.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)))
  }
  const shuffleOptions = () => {
    const order = options.map((_, i) => i)
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    const remap = new Map<number, number>()
    order.forEach((oldIdx, newIdx) => remap.set(oldIdx, newIdx))
    markDirty()
    setOptions(order.map((i) => options[i]))
    setAnswers((a) => a.map((p) => remap.get(p) ?? p).sort((x, y) => x - y))
  }
  const toggleAnswer = (i: number) => {
    markDirty()
    if (watchedType === 'single') setAnswers([i])
    else setAnswers((a) => (a.includes(i) ? a.filter((x) => x !== i) : [...a, i].sort((x, y) => x - y)))
  }

  const answerText = (): string => {
    if (watchedType === 'single') return answers.length === 1 ? letterOf(answers[0]) : ''
    if (watchedType === 'multiple') return answers.length ? answers.map(letterOf).join(',') : ''
    if (watchedType === 'true_false') return tf
    return refAnswer.trim()
  }

  /** 与后端 _validate_question_state 同口径，但提示更贴界面动作 */
  const validate = (): string | null => {
    if (!String(form.getFieldValue('question_text') || '').trim()) return t('enterQuestionContent')
    if (!String(form.getFieldValue('subject') || '').trim()) return t('subjectRequired')
    if (CHOICE.has(watchedType)) {
      if (options.length < 2) return t('optionsAtLeast2')
      const emptyIdx = options.findIndex((o) => !o.trim())
      if (emptyIdx >= 0) return t('optionEmpty', { n: emptyIdx + 1 })
      if (watchedType === 'single' && answers.length !== 1) return t('singleAnswerOne')
      if (watchedType === 'multiple' && answers.length < 2) return t('multipleAnswerMin')
    }
    if (watchedType === 'true_false' && !tf) return t('answerRequired')
    if (TEXT_ANSWER.has(watchedType) && !refAnswer.trim()) return t('referenceRequired')
    return null
  }

  const save = async (keepOpen: boolean) => {
    if (saving || readOnly) return
    // 先走表单级校验，题干/学科为空时字段上直接标红（不再只弹一条 toast）
    try {
      await form.validateFields()
    } catch {
      return
    }
    const err = validate()
    if (err) { message.warning(err); return }
    setSaving(true)
    try {
      const optionsObj: Record<string, string> = {}
      if (CHOICE.has(watchedType)) {
        options.forEach((v, i) => { optionsObj[letterOf(i)] = v.trim() })
      }
      const payload: Record<string, unknown> = {
        type: watchedType,
        question_text: String(form.getFieldValue('question_text') || '').trim(),
        correct_answer: answerText(),
        explanation: String(form.getFieldValue('explanation') || ''),
        knowledge_points: joinKps(kps),
        difficulty: form.getFieldValue('difficulty') || 'medium',
      }
      const subjectNow = String(form.getFieldValue('subject') || '').trim()
      // 编辑时学科没变就不回传：存量题的学科可能已不在配置里，回传会被后端拒绝
      if (mode === 'create' || subjectNow !== (question?.subject || '')) payload.subject = subjectNow

      if (mode === 'create') {
        await apiClient.post('/api/questions/import', {
          ...payload,
          subject: subjectNow,
          options: CHOICE.has(watchedType) ? optionsObj : undefined,
          source: 'manual',
        })
        message.success(t('createQuestionSuccess'))
        onSaved()
        if (keepOpen) {
          // 连续录题：保留题型/学科/难度/知识点，只清题干与答案
          form.setFieldsValue({ question_text: '', explanation: '' })
          setOptions((o) => o.map(() => ''))
          setAnswers([]); setRefAnswer(''); setDirty(false)
        } else {
          onClose()
        }
      } else {
        const { data } = await apiClient.put(`/api/questions/${question!.id}`, {
          ...payload,
          options: CHOICE.has(watchedType) ? JSON.stringify(optionsObj) : '',
        })
        message.success(t('editSuccess'))
        ;((data as { warnings?: string[] })?.warnings || []).forEach((w) => message.warning(w, 8))
        onSaved()
        onClose()
      }
    } catch (e: any) {
      const d = e?.response?.data?.detail
      message.error(typeof d === 'string' ? d : (e?.message || t('updateFail')))
    } finally {
      setSaving(false)
    }
  }

  // 只用 dirty：antd 的 isFieldsTouched 在 setFieldsValue 初始化后会返回 true，
  // 导致"什么都没改也弹未保存确认"。dirty 只由用户交互（onValuesChange/选项操作）置位。
  const handleCancel = () => closeWithDirtyGuard(dirty, tc, onClose)

  const isChoice = CHOICE.has(watchedType)
  const isTF = watchedType === 'true_false'
  const isTextAnswer = TEXT_ANSWER.has(watchedType)

  const formPane = (
    <Form form={form} layout="vertical" disabled={readOnly} onValuesChange={markDirty}>
      {readOnly && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title={t('readOnlyNotice', { creator: question?.creator_username || question?.creator_name || '-' })}
        />
      )}
      <Row gutter={12}>
        <Col span={8}>
          <Form.Item label={t('questionType')} name="type" rules={[{ required: true }]}>
            <Select options={TYPE_OPTIONS} onChange={onTypeChange} />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item label={t('subject')} name="subject" rules={[{ required: true, message: t('subjectRequired') }]}>
            <Select options={subjectChoices} placeholder={t('subject')} showSearch optionFilterProp="label" />
          </Form.Item>
        </Col>
        <Col span={8}>
          <Form.Item label={t('difficulty')} name="difficulty">
            <Select>
              <Select.Option value="easy">{t('easy')}</Select.Option>
              <Select.Option value="medium">{t('medium')}</Select.Option>
              <Select.Option value="hard">{t('hard')}</Select.Option>
            </Select>
          </Form.Item>
        </Col>
      </Row>

      <Form.Item
        label={t('questionContent')}
        name="question_text"
        rules={[{ required: true, message: t('enterQuestionContent') }]}
        extra={t('formulaSupport')}
      >
        <TextArea rows={3} placeholder={t('enterQuestionContent')} />
      </Form.Item>

      {isChoice && (
        <Form.Item label={t('options')} required extra={t('answerPickTip')}>
          <div style={{ border: '1px solid var(--border-color-secondary)', borderRadius: 6, padding: 12, background: 'rgba(127,127,127,0.04)' }}>
            {options.map((opt, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
                <div style={{ width: 24, paddingTop: 6 }}>
                  {watchedType === 'single' ? (
                    <Radio
                      checked={answers.includes(i)}
                      disabled={readOnly}
                      onChange={() => toggleAnswer(i)}
                      aria-label={t('markAnswerOption', { letter: letterOf(i) })}
                    />
                  ) : (
                    <Checkbox
                      checked={answers.includes(i)}
                      disabled={readOnly}
                      onChange={() => toggleAnswer(i)}
                      aria-label={t('markAnswerOption', { letter: letterOf(i) })}
                    />
                  )}
                </div>
                <Tag color={answers.includes(i) ? 'green' : undefined} style={{ marginTop: 4, width: 26, textAlign: 'center', paddingInline: 0 }}>
                  {letterOf(i)}
                </Tag>
                <TextArea
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  value={opt}
                  disabled={readOnly}
                  onChange={(e) => setOptionAt(i, e.target.value)}
                  placeholder={t('optionValuePlaceholder')}
                  style={{ flex: 1 }}
                />
                <Tooltip title={t('deleteOption')}>
                  <Button
                    type="text" size="small" danger icon={<DeleteOutlined />}
                    disabled={readOnly || options.length <= 2}
                    aria-label={t('deleteOption')}
                    onClick={() => removeOption(i)}
                  />
                </Tooltip>
              </div>
            ))}
            <Space>
              <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addOption} disabled={readOnly || options.length >= 10}>
                {t('addOption')}
              </Button>
              <Button size="small" icon={<SwapOutlined />} onClick={shuffleOptions} disabled={readOnly || options.length < 2}>
                {t('shuffleOptions')}
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('currentAnswer')}: <b>{answerText() || '—'}</b>
              </Typography.Text>
            </Space>
          </div>
        </Form.Item>
      )}

      {isTF && (
        <Form.Item label={t('correctAnswer')} required>
          <Segmented
            value={tf}
            disabled={readOnly}
            onChange={(v) => { markDirty(); setTf(v as '对' | '错') }}
            options={[{ value: '对', label: t('true') }, { value: '错', label: t('false') }]}
          />
        </Form.Item>
      )}

      {isTextAnswer && (
        <Form.Item label={t('referenceAnswer')} required extra={t('referenceAnswerTip')}>
          <TextArea rows={3} value={refAnswer} disabled={readOnly} onChange={(e) => { markDirty(); setRefAnswer(e.target.value) }} />
        </Form.Item>
      )}

      <Collapse
        size="small"
        activeKey={previewKeys}
        onChange={(k) => setPreviewKeys(Array.isArray(k) ? k : [k as string])}
        items={[{
          key: 'p',
          label: <Space size={6}>{t('previewToggle')}</Space>,
          children: (
            <div style={{ fontSize: 14, lineHeight: 1.9 }}>
              <FormulaRenderer content={watchedText || t('nothingToPreview')} />
              {isChoice && options.map((o, i) => (
                o.trim() ? (
                  <div key={i} style={{ margin: '2px 0 0 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
                    <Tag color={answers.includes(i) ? 'green' : undefined}>{letterOf(i)}</Tag>
                    <FormulaRenderer content={o} inline />
                  </div>
                ) : null
              ))}
              {watchedExplanation && (
                <div style={{ marginTop: 6, color: 'var(--text-secondary)', fontSize: 13 }}>
                  <FormulaRenderer content={watchedExplanation} />
                </div>
              )}
            </div>
          ),
        }]}
        style={{ marginBottom: 16 }}
      />

      <Form.Item label={t('explanation')} name="explanation">
        <TextArea rows={2} placeholder={t('explanation')} />
      </Form.Item>

      <Form.Item label={t('knowledgePoint')}>
        <KnowledgePointSelect
          subject={watchedSubject}
          value={kps}
          disabled={readOnly}
          onChange={(v) => { markDirty(); setKps(Array.isArray(v) ? v : splitKps(v)) }}
        />
      </Form.Item>
    </Form>
  )

  return (
    <Modal
      title={
        mode === 'create'
          ? t('createQuestionTitle')
          : readOnly
            ? t('viewQuestion_', { id: question?.id })
            : t('editQuestion_', { id: question?.id })
      }
      open={open}
      onCancel={handleCancel}
      mask={{ closable: false }}
      width={860}
      centered
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(100vh - 240px)', overflowY: 'auto', paddingRight: 8 } }}
      footer={(
        <Space>
          <Button onClick={handleCancel}>{t('cancel')}</Button>
          {mode === 'create' && !readOnly && (
            <Button onClick={() => save(true)} loading={saving}>{t('saveAndContinue')}</Button>
          )}
          {!readOnly && <Button type="primary" onClick={() => save(false)} loading={saving}>{t('save')}</Button>}
        </Space>
      )}
    >
      {mode === 'edit' && mediaQuestion && !readOnly ? (
        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as 'form' | 'media')}
          items={[
            { key: 'form', label: t('tabQuestion'), children: formPane },
            {
              key: 'media',
              label: `${t('tabMedia')}${(mediaQuestion.media_files?.length || 0) > 0 ? ` (${mediaQuestion.media_files!.length})` : ''}`,
              children: (
                <QuestionMediaPanel
                  question={mediaQuestion}
                  onChanged={setMediaQuestion}
                  reloadList={onSaved}
                />
              ),
            },
          ]}
        />
      ) : formPane}
    </Modal>
  )
}

export default QuestionFormModal
