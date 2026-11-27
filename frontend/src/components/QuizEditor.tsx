import React, { useState, useEffect, useMemo } from 'react'
import { Modal, Form, Input, Button, Space, Select, Radio, Checkbox, Typography, Divider, Tag, Empty, Popconfirm, InputNumber, Switch } from 'antd'
import { message } from '../utils/feedback'
import { PlusOutlined, DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined, SearchOutlined } from '@ant-design/icons'
import FormulaRenderer from './FormulaRenderer'
import ActivityScopeSelector from './ActivityScopeSelector'
import { useTranslation } from 'react-i18next'
import type { ActivityScopeValue } from './ActivityScopeSelector'
import { distributeScores } from '../utils/score'
import useSubjectOptions from '../hooks/useSubjectOptions'
import KnowledgePointSelect from './KnowledgePointSelect'
import QuizBankPicker from './QuizBankPicker'
import { optionLetter, stripOptionPrefix, coerceAnswerToLetters } from '../utils/quizOptions'

const { Text } = Typography
const { TextArea } = Input

interface Question {
  id: string
  type: 'single' | 'multiple' | 'true_false'
  question: string
  options: string[]
  answer: string
  score: number
  explanation: string
  // P1-8: 题库选题带入的配图/媒体（手动出题不填）
  svg_content?: string
  has_svg?: number
  media_files?: any[]
}

interface QuizEditorProps {
  open: boolean
  onCancel: () => void
  onSave: (title: string, description: string, questions: Question[],
           scope?: ActivityScopeValue, subject?: string, knowledgePoints?: string[],
           publish?: boolean) => Promise<void>
  initialTitle?: string
  initialDescription?: string
  initialQuestions?: Question[]
  // P1-5: 编辑模式（零答卷测验改题目）；编辑时不显示"发布/草稿"双按钮
  editing?: boolean
  initialSubject?: string
  initialKps?: string[]
  // 自查修复：编辑态必须回填原目标范围，否则保存会把"指定年级/班级"重置回任教班级
  initialScope?: ActivityScopeValue
}

const generateId = () => Math.random().toString(36).substring(2, 10)

// P0-4: 选项文本不再自带 "A. " 前缀 —— 字母由位置生成，
// 旧写法会让答题页取 opt.charAt(0) 当答案键（首字符相同即串答案），也导致编辑器"A | A. 选项A"双字母。
const defaultOptions = {
  single: ['选项A', '选项B', '选项C', '选项D'],
  multiple: ['选项A', '选项B', '选项C', '选项D'],
  true_false: ['对', '错'],
}

const QuizEditor: React.FC<QuizEditorProps> = ({
  open, onCancel, onSave,
  initialTitle = '', initialDescription = '', initialQuestions,
  editing = false, initialSubject = '', initialKps,
  initialScope,
}) => {
  const { t } = useTranslation('interaction')
  const { subjects, defaultSubject } = useSubjectOptions()      // 学科（与 AI 建测验同一份清单）
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [subject, setSubject] = useState('')
  const [kps, setKps] = useState<string[]>([])   // 知识点（多选，落库后可按知识点统计）
  const [questions, setQuestions] = useState<Question[]>(initialQuestions || [])
  const [saving, setSaving] = useState(false)
  const [bankOpen, setBankOpen] = useState(false)
  // R2(Step B): 默认由系统把总分均摊成 100(与同步练习/考试同一口径); 教师改过任一题分值即转手动
  const [autoScore, setAutoScore] = useState(true)
  const [scope, setScope] = useState<ActivityScopeValue>({
    target_scope: 'teacher_classes',
    target_grade: '',
    target_class: '',
    target_users: '',
  })

  useEffect(() => {
    if (open) {
      setTitle(initialTitle)
      setDescription(initialDescription)
      setSubject(initialSubject)
      setKps(initialKps || [])
      setQuestions(initialQuestions || [])
      // 自查二轮：编辑态不能硬置"自动均摊"——手动配过 30/70 的卷子重开会被
      // 显示成 50/50，保存即静默覆盖。按原分值推导：全 1 分(老卷)或恰好等于
      // 均摊值 → 自动；否则视为教师手动配过 → 手动。
      const qs0 = initialQuestions || []
      if (qs0.length === 0) {
        setAutoScore(true)
      } else {
        const dist = distributeScores(qs0.length, 100)
        const allOne = qs0.every(x => Math.abs((Number(x.score) || 1) - 1) < 1e-9)
        const matchesAuto = qs0.every((x, i2) => Math.abs((Number(x.score) || 0) - dist[i2]) < 1e-9)
        setAutoScore(allOne || matchesAuto)
      }
      setScope(initialScope || { target_scope: 'teacher_classes', target_grade: '', target_class: '', target_users: '' })
    }
  }, [open, initialTitle, initialDescription, initialQuestions, initialSubject, initialKps, initialScope])

  // 学科默认取第一个（与 AI 建测验弹窗一致）：留空太容易漏填，落库就是空学科。
  // 编辑模式已带原学科（initialSubject），不兜底覆盖。
  useEffect(() => {
    if (open && !editing && !subject && subjects.length > 0) setSubject(defaultSubject || subjects[0])
  }, [open, subjects, subject, editing])

  /** 自动模式下的每题分值(合计恒为 100); 手动模式用题目自身的 score */
  const autoScores = useMemo(() => distributeScores(questions.length, 100), [questions.length])
  const effectiveScore = (q: Question, i: number) => (autoScore ? (autoScores[i] ?? 1) : q.score)

  const addQuestion = (type: 'single' | 'multiple' | 'true_false') => {
    const newQ: Question = {
      id: generateId(),
      type,
      question: '',
      options: [...defaultOptions[type]],
      answer: '',
      score: 1,
      explanation: '',
    }
    setQuestions([...questions, newQ])
  }

  const removeQuestion = (id: string) => {
    setQuestions(questions.filter(q => q.id !== id))
  }

  const moveQuestion = (index: number, direction: 'up' | 'down') => {
    const newQs = [...questions]
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= newQs.length) return
    ;[newQs[index], newQs[target]] = [newQs[target], newQs[index]]
    setQuestions(newQs)
  }

  const updateQuestion = (id: string, field: keyof Question, value: any) => {
    setQuestions(questions.map(q => {
      if (q.id !== id) return q
      const updated = { ...q, [field]: value }
      // 切换题型时重置选项和答案
      if (field === 'type') {
        updated.options = [...defaultOptions[value as 'single' | 'multiple' | 'true_false']]
        updated.answer = ''
      }
      return updated
    }))
  }

  const updateOption = (qId: string, optIndex: number, value: string) => {
    setQuestions(questions.map(q => {
      if (q.id !== qId) return q
      const newOpts = [...q.options]
      newOpts[optIndex] = value
      return { ...q, options: newOpts }
    }))
  }

  const addOption = (qId: string) => {
    setQuestions(questions.map(q => {
      if (q.id !== qId) return q
      const prefix = String.fromCharCode(65 + q.options.length) // A, B, C, ...
      return { ...q, options: [...q.options, t('qeNewOption', { letter: prefix, n: q.options.length + 1 })] }
    }))
  }

  const removeOption = (qId: string, optIndex: number) => {
    setQuestions(questions.map(q => {
      if (q.id !== qId) return q
      const newOpts = q.options.filter((_, i) => i !== optIndex)
      return { ...q, options: newOpts, answer: '' }
    }))
  }

  // publish=false → 存为草稿（学生看不到），回列表里用「发布」开关放出去
  const handleSave = async (publish = true) => {
    if (!title.trim()) { message.warning(t('enterQuizTitle')); return }
    if (questions.length === 0) { message.warning(t('addAtLeastOneQuestion')); return }

    // 校验每道题
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      if (!(q.question || '').trim()) {
        message.warning(t('questionContentRequired', { n: i + 1 }))
        return
      }
      if (q.type !== 'true_false' && q.options.length < 2) {
        message.warning(t('questionNeedOptions', { n: i + 1 }))
        return
      }
      if (!q.answer) {
        message.warning(t('setCorrectAnswer', { n: i + 1 }))
        return
      }
      // P0-4: 答案键=位置字母（A/B/C…），与选项内容彻底解耦；
      // 回填的老卷答案若是"选项首字符"写法，先归一再校验。
      const validLetters = q.options.map((_, oi) => optionLetter(oi))
      if (q.type === 'multiple') {
        const answerLetters = q.answer.split(',').map(a => a.trim().toUpperCase())
        for (const letter of answerLetters) {
          if (!validLetters.includes(letter)) {
            message.warning(t('multiChoiceInvalid', { n: i + 1, letter }))
            return
          }
        }
      }
      if (q.type === 'single') {
        const letter = q.answer.toUpperCase()
        if (!validLetters.includes(letter)) {
          message.warning(t('singleChoiceInvalid', { n: i + 1, letter }))
          return
        }
      }
    }

    setSaving(true)
    try {
      // 自动模式: 把均摊后的分值显式写进题目(后端据此判定"已配过分值"不再覆盖)。
      // P0-4: 选项文本剥掉可能残留的 "A. " 前缀；答案统一为位置字母。
      const payload = questions.map((q, i) => ({
        ...q,
        score: effectiveScore(q, i),
        options: q.type === 'true_false' ? q.options : q.options.map(o => stripOptionPrefix(o)),
        answer: q.type === 'true_false'
          ? q.answer
          : coerceAnswerToLetters(q.answer, q.options.map(o => stripOptionPrefix(o))),
      }))
      await onSave(title, description, payload, scope, subject, kps, publish)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal mask={{ closable: false }}
      title={<Text strong style={{ fontSize: 18 }}>{editing ? '✏️' : '📝'} {t(editing ? 'ipEditQuiz' : 'createQuiz')}</Text>}
      open={open}
      onCancel={onCancel}
      footer={editing ? [
        <Button key="cancel" onClick={onCancel}>{t('cancel')}</Button>,
        <Button key="update" type="primary" loading={saving} onClick={() => handleSave(true)}>
          {t('qeSaveChanges')}
        </Button>,
      ] : [
        <Button key="cancel" onClick={onCancel}>{t('cancel')}</Button>,
        // P2-11: 测验建完基本就是要发的 —— 「保存并发布」升为主按钮，
        // 「存为草稿」降为次要（原设计 primary 在草稿，重点反了）
        <Button key="save" loading={saving} onClick={() => handleSave(false)}>
          {t('saveDraft')}
        </Button>,
        <Button key="publish" type="primary" loading={saving} onClick={() => handleSave(true)}>
          {t('publishNow')}
        </Button>,
      ]}
      width="min(800px, 94vw)"
      style={{ top: 20 }}
    >
      {/* 基本信息 */}
      <div style={{ marginBottom: 16 }}>
        <Form layout="vertical">
          <Form.Item label={t('quizTitle')} required>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('quizTitlePlaceholder')}
            />
          </Form.Item>
          <Form.Item label={t('descriptionOptional')}>
            <Input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('qeDescPh')}
            />
          </Form.Item>
          {/* 学科：与 AI 建测验弹窗一致 —— 落库后测验列表与活动监控的"学科"列才显示得出来 */}
          <Form.Item label={t('subject')}>
            <Select
              allowClear
              value={subject || undefined}
              onChange={(v) => setSubject(v || '')}
              placeholder={t('subject')}
              options={subjects.map(s => ({ value: s, label: s }))}
            />
          </Form.Item>
          {/* 知识点：与试题管理同款控件（下拉选课程知识点 + 手输），学科联动过滤 */}
          <Form.Item label={t('knowledgePoint')}>
            <KnowledgePointSelect subject={subject} value={kps}
              onChange={(v) => setKps(Array.isArray(v) ? v : [])} />
          </Form.Item>
        </Form>
      </div>

      {/* 目标范围 */}
      <div style={{ marginBottom: 16 }}>
        <ActivityScopeSelector value={scope} onChange={setScope} />
      </div>

      <Divider />

      {/* 添加题目按钮 */}
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ fontSize: 15 }}>{t('questionList')}</Text>
        {/* R2(Step B): 满分口径与同步练习/考试对齐 —— 默认均摊 100, 教师可逐题改分 */}
        <div style={{ marginTop: 6 }}>
          <Space size={8} wrap>
            <Switch size="small" checked={autoScore} onChange={setAutoScore} />
            <Text style={{ fontSize: 12 }}>{t('qeAutoScore')}</Text>
            {autoScore && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {t('qeScoreTotal', { total: 100, n: questions.length })}
              </Text>
            )}
          </Space>
        </div>
        <div style={{ marginTop: 8 }}>
          <Space wrap>
            <Button icon={<PlusOutlined />} type="primary" onClick={() => addQuestion('single')}>
              {t('addSingleChoice')}
            </Button>
            <Button size="small" icon={<PlusOutlined />} onClick={() => addQuestion('multiple')}>
              {t('addMultipleChoice')}
            </Button>
            <Button size="small" icon={<PlusOutlined />} onClick={() => addQuestion('true_false')}>
              {t('addTrueFalse')}
            </Button>
            {/* P1-8: 测验手动建题此前只能纯手打 —— 与练习的题库优先口径对称，直接勾选题库题目 */}
            <Button size="small" icon={<SearchOutlined />} onClick={() => setBankOpen(true)}>
              {t('bankPick')}
            </Button>
          </Space>
        </div>
        <QuizBankPicker open={bankOpen} defaultSubject={subject}
          onCancel={() => setBankOpen(false)}
          onPick={(qs) => {
            setQuestions(prev => [...prev, ...qs.map(q => ({ ...q, id: generateId() }))])
            setBankOpen(false)
            message.success(t('bankAddedN', { count: qs.length }))
          }} />
      </div>

      {/* 题目列表 */}
      {questions.length === 0 ? (
        <Empty description={t('clickToAddQuestion')} />
      ) : (
        questions.map((q, index) => (
          <div
            key={q.id}
            style={{
              marginBottom: 16,
              padding: 16,
              borderRadius: 8,
              border: '1px solid var(--border-color-secondary)',
              background: 'var(--bg-layout)',
            }}
          >
            {/* 题号 + 题型 + 操作 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Space>
                <Text strong style={{ fontSize: 15 }}>{t('qeQuestionNo', { no: index + 1 })}</Text>
                <Select
                  value={q.type}
                  onChange={v => updateQuestion(q.id, 'type', v)}
                  size="small"
                  style={{ width: 90 }}
                >
                  <Select.Option value="single">{t('quizSingleChoice')}</Select.Option>
                  <Select.Option value="multiple">{t('quizMultipleChoice')}</Select.Option>
                  <Select.Option value="true_false">{t('trueFalse')}</Select.Option>
                </Select>
                {/* R2: 每题分值(默认自动均摊成合计 100, 改过即转手动) */}
                <Text type="secondary" style={{ fontSize: 12 }}>{t('qeScore')}</Text>
                <InputNumber size="small" min={1} max={100} style={{ width: 64 }}
                  value={effectiveScore(q, index)}
                  disabled={autoScore}
                  onChange={(v) => { setAutoScore(false); updateQuestion(q.id, 'score', Number(v) || 1) }}
                />
              </Space>
              <Space>
                <Button size="small" icon={<ArrowUpOutlined />}
                  disabled={index === 0} onClick={() => moveQuestion(index, 'up')} />
                <Button size="small" icon={<ArrowDownOutlined />}
                  disabled={index === questions.length - 1} onClick={() => moveQuestion(index, 'down')} />
                <Popconfirm title={t('deleteQuestionConfirm')} onConfirm={() => removeQuestion(q.id)}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            </div>

            {/* 题目内容 */}
            <TextArea
              value={q.question}
              onChange={e => updateQuestion(q.id, 'question', e.target.value)}
              placeholder={t('questionContentPlaceholder')}
              rows={2}
              style={{ marginBottom: 4 }}
            />
            {(q.question || '').trim() && (
              <div style={{
                marginBottom: 12, padding: '4px 8px',
                borderRadius: 4, background: 'var(--bg-container)',
                border: '1px dashed var(--border-color-secondary)', fontSize: 13, color: 'var(--text-tertiary)',
              }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('qePreview')}</Text>
                <FormulaRenderer content={q.question} />
              </div>
            )}

            {/* 选项编辑 */}
            {q.type !== 'true_false' ? (
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('qeOptionsLbl')}</Text>
                {q.options.map((opt, oi) => (
                  <div key={oi} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    {/* P2-10: addonBefore 已弃用（控制台 error），且与文本里的 "A." 叠加成双字母。
                        字母=位置的纯文本标签，输入框只放选项内容。 */}
                    <Text strong style={{ width: 20, textAlign: 'center', flexShrink: 0 }}>{optionLetter(oi)}</Text>
                    <Input
                      value={opt}
                      onChange={e => updateOption(q.id, oi, e.target.value)}
                      style={{ flex: 1 }}
                      size="small"
                    />
                    {q.options.length > 2 && (
                      <Button size="small" type="text" danger
                        icon={<DeleteOutlined />}
                        onClick={() => removeOption(q.id, oi)}
                      />
                    )}
                  </div>
                ))}
                <Button size="small" type="dashed" icon={<PlusOutlined />}
                  onClick={() => addOption(q.id)} style={{ marginTop: 6 }}>
                  {t('addOption')}
                </Button>
              </div>
            ) : (
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('qeOptionsLbl')}</Text>
                <div style={{ marginTop: 4 }}>
                  <Tag>{t('judgeTrue')}</Tag>
                  <Tag>{t('judgeFalse')}</Tag>
                </div>
              </div>
            )}

            {/* 正确答案 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{t('correctAnswerColon')}</Text>
              {q.type === 'single' && (
                <Radio.Group
                  value={q.answer}
                  onChange={e => updateQuestion(q.id, 'answer', e.target.value)}
                >
                  {q.options.map((opt, oi) => (
                    <Radio key={oi} value={optionLetter(oi)}>
                      {optionLetter(oi)}. {stripOptionPrefix(opt)}
                    </Radio>
                  ))}
                </Radio.Group>
              )}
              {q.type === 'multiple' && (
                <Checkbox.Group
                  value={q.answer ? q.answer.split(',').map(s => s.trim().toUpperCase()).filter(s => s.length === 1) : []}
                  onChange={vals => updateQuestion(q.id, 'answer', vals.sort().join(','))}
                >
                  {q.options.map((opt, oi) => (
                    <Checkbox key={oi} value={optionLetter(oi)}>
                      {optionLetter(oi)}. {stripOptionPrefix(opt)}
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              )}
              {q.type === 'true_false' && (
                <Radio.Group
                  value={q.answer}
                  onChange={e => updateQuestion(q.id, 'answer', e.target.value)}
                >
                  <Radio value="对">{t('judgeTrue')}</Radio>
                  <Radio value="错">{t('judgeFalse')}</Radio>
                </Radio.Group>
              )}
            </div>

            {/* 解析 */}
            <div style={{ marginTop: 8 }}>
              <Input
                value={q.explanation}
                onChange={e => updateQuestion(q.id, 'explanation', e.target.value)}
                placeholder={t('explanationPlaceholder')}
                size="small"
              />
              {(q.explanation || '').trim() && (
                <div style={{
                  marginTop: 4, padding: '4px 8px',
                  borderRadius: 4, background: 'var(--bg-container)',
                  border: '1px dashed var(--border-color-secondary)', fontSize: 13, color: 'var(--text-tertiary)',
                }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('qePreview')}</Text>
                  <FormulaRenderer content={q.explanation} />
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </Modal>
  )
}

export default QuizEditor
export type { Question }
