import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Form, Input, Select, InputNumber, Row, Col, Button, Space, Divider, Typography, Tag } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import type * as examsApiTypes from '../api/exams'
const { Option } = Select

/** 组卷可选题型；显示名一律走 i18n 的 pcType_* 键，不再在这里硬编码中文标签 */
const TYPE_OPTIONS = ['single', 'multiple', 'true_false', 'short', 'fill', 'essay', 'subjective']
  .map((value) => ({ value }))

interface PaperConfigFormProps {
  subjects: string[]
  grades: string[]
  knowledgePoints: string[]
  /** 题库供给量（来自 compose-config/defaults，与组卷引擎同口径） */
  supply?: examsApiTypes.PaperSupply | null
}

/** 小计计算子组件（必须独立以遵守 Hooks 规则） */
const TypeSubtotal: React.FC<{ name: number }> = ({ name }) => {
  const { t } = useTranslation('exam')
  const count = Form.useWatch(['type_configs', name, 'count']) || 0
  const score = Form.useWatch(['type_configs', name, 'score_per_question']) || 0
  const subtotal = useMemo(() => ((count || 0) * (score || 0)).toFixed(1), [count, score])
  return (
    <Typography.Text type="secondary">
      {t('pcSubtotal')}<Typography.Text strong>{subtotal}</Typography.Text> {t('pcPoints')}
    </Typography.Text>
  )
}

const PaperConfigForm: React.FC<PaperConfigFormProps> = ({
  subjects,
  grades,
  knowledgePoints,
  supply,
}) => {
  const { t } = useTranslation('exam')
  // 配置合计与目标总分都在本组件就地算。旧写法由父组件回传合计再写回"设定总分"
  // 那个输入框（还留了一个从未使用的回调 prop），于是老师改任一题型，
  // 自己填的目标总分就被静默覆盖成配置合计。
  const configs = Form.useWatch('type_configs', undefined) as
    { type?: string; count?: number; score_per_question?: number }[] | undefined
  const targetScore = Form.useWatch('total_score', undefined) as number | undefined
  const configTotal = useMemo(
    () => (configs || []).reduce((s, c) => s + (Number(c?.count) || 0) * (Number(c?.score_per_question) || 0), 0),
    [configs],
  )
  const totalScore = Number(targetScore) || 0
  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={16}>
      {/* 基本信息 */}
      <CardSection title={t('pcBasic')}>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item label={t('pcSchool')} name="school_name">
              <Input placeholder={t('pcSchoolPh')} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item label={t('pcSemester')} name="semester">
              <Input placeholder={t('pcSemesterPh')} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label={t('pcSubject')} name="subject">
              <Select placeholder={t('pcSubjectPh')}>
                {subjects.map((s) => (
                  <Option key={s} value={s}>
                    {s}
                  </Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={t('pcGrade')} name="target_grade">
              <Select
                placeholder={t('pcGradePh')}
                allowClear
                mode="multiple"
                maxTagCount={2}
              >
                {grades.map((g) => (
                  <Option key={g} value={g}>{g}</Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={t('pcDuration')} name="duration">
              <InputNumber min={1} max={180} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
      </CardSection>

      {/* 题型配置 */}
      <CardSection title={t('pcTypeCfg')} subtitle={t('pcTypeCfgSub')}>
        {supply && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
            {t('pcSupply', { total: supply.pool_size, writes: (supply.subject_writes || []).join(' / ') || supply.subject })}
            {supply.already_in_paper > 0 && t('pcSupplyExcluded', { n: supply.already_in_paper })}
          </Typography.Text>
        )}
        <Form.List name="type_configs">
          {(fields, { add, remove }) => (
            <>
              {fields.map(({ key, name, ...restField }) => (
                <Row key={key} gutter={12} align="middle" style={{ marginBottom: 8 }}>
                  <Col span={5}>
                    <Form.Item {...restField} name={[name, 'type']} rules={[{ required: true, message: t('pcPickType') }]}>
                      <Select placeholder={t('pcPickType')}>
                        {TYPE_OPTIONS.map((opt) => (
                          <Option key={opt.value} value={opt.value}>
                            {t('pcType_' + opt.value)}
                          </Option>
                        ))}
                      </Select>
                    </Form.Item>
                  </Col>
                  <Col span={4}>
                    <Form.Item {...restField} name={[name, 'count']} rules={[{ required: true, message: t('pcCountReq') }]}>
                      <InputNumber min={0} max={100} style={{ width: '100%' }} placeholder={t('pcCountPh')} />
                    </Form.Item>
                  </Col>
                  <Col span={5}>
                    <Form.Item {...restField} name={[name, 'score_per_question']} rules={[{ required: true, message: t('pcScoreReq') }]}>
                      <InputNumber min={0.5} max={100} step={0.5} style={{ width: '100%' }} placeholder={t('pcScorePh')} />
                    </Form.Item>
                  </Col>
                  <Col span={6}>
                    <Space size={6} wrap>
                      <TypeSubtotal name={name} />
                      <TypeAvail name={name} supply={supply} />
                    </Space>
                  </Col>
                  <Col span={4}>
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => remove(name)}
                      disabled={fields.length <= 1}
                    />
                  </Col>
                </Row>
              ))}
              <Form.Item>
                <Button type="dashed" onClick={() => add({ type: undefined, count: 0, score_per_question: 5 })} block icon={<PlusOutlined />}>
                  {t('pcAddType')}
                </Button>
              </Form.Item>
            </>
          )}
        </Form.List>

        <Divider />
        <Row justify="space-between" align="middle">
          <Col>
            <Space wrap>
              <Typography.Text strong>{t('pcCfgTotal')}</Typography.Text>
              <Typography.Text style={{ fontSize: 18, fontWeight: 600, color: '#1677ff' }}>
                {configTotal.toFixed(1)}
              </Typography.Text>
              <Typography.Text type="secondary">{t('pcPoints')}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                / {t('pcTargetTotal')} {totalScore.toFixed(1)}
              </Typography.Text>
            </Space>
          </Col>
          <Col>
            <Form.Item name="total_score" label={t('pcSetTotal')} style={{ margin: 0 }}
              tooltip={t('pcSetTotalTip')}>
              <InputNumber min={1} max={1000} style={{ width: 120 }} />
            </Form.Item>
          </Col>
        </Row>
        {totalScore > 0 && Math.abs(configTotal - totalScore) > 0.05 && (
          <Typography.Text type="warning" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            ⚠️ {t('pcConflictHint', { config: configTotal.toFixed(1), target: totalScore.toFixed(1) })}
          </Typography.Text>
        )}
      </CardSection>

      {/* 难度分布 */}
      <CardSection title={t('pcDifficulty')}>
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item label={t('pcEasy')} name="difficulty_easy_ratio">
              <InputNumber min={0} max={100} formatter={(v) => `${v}%`} parser={(v) => Number(v?.replace('%', '') || 0) as any} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={t('pcMedium')} name="difficulty_medium_ratio">
              <InputNumber min={0} max={100} formatter={(v) => `${v}%`} parser={(v) => Number(v?.replace('%', '') || 0) as any} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item label={t('pcHard')} name="difficulty_hard_ratio">
              <InputNumber min={0} max={100} formatter={(v) => `${v}%`} parser={(v) => Number(v?.replace('%', '') || 0) as any} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t('pcRatioHint')}
        </Typography.Text>
      </CardSection>

      {/* 知识点范围 */}
      <CardSection title={t('pcKpScope')} subtitle={t('pcKpScopeSub')}>
        <Form.Item name="knowledge_points">
          <Select
            mode="multiple"
            placeholder={t('pcKpPh')}
            allowClear
            maxTagCount={8}
            style={{ width: '100%' }}
            showSearch
            filterOption={(input, option) =>
              (option?.value as string)?.toLowerCase().includes(input.toLowerCase())
            }
          >
            {knowledgePoints.map((kp) => (
              <Option key={kp} value={kp}>
                {kp}
              </Option>
            ))}
          </Select>
        </Form.Item>
      </CardSection>

      {/* 高级选项 */}
      <CardSection title={t('pcAdvanced')}>
        <Row gutter={16}>
          <Col span={12}>
            <Form.Item name="replace_existing" label={t('pcReplaceLbl')} valuePropName="checked">
              <Select>
                <Option value={false}>{t('pcKeepAppend')}</Option>
                <Option value={true}>{t('pcReplaceAll')}</Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="use_ai" label={t('pcAiPickLbl')} valuePropName="checked">
              <Select>
                <Option value={true}>{t('pcAiOn')}</Option>
                <Option value={false}>{t('pcAiOff')}</Option>
              </Select>
            </Form.Item>
          </Col>
        </Row>
      </CardSection>
    </Space>
  )
}

/** 该题型的题库供给量：配得比可选题还多就标红，别等组完才在说明里发现缺题 */
const TypeAvail: React.FC<{
  name: number
  supply?: examsApiTypes.PaperSupply | null
}> = ({ name, supply }) => {
  const { t } = useTranslation('exam')
  const type = Form.useWatch(['type_configs', name, 'type'], undefined) as string | undefined
  const count = Number(Form.useWatch(['type_configs', name, 'count'], undefined) || 0)
  if (!supply || !type) return null
  const avail = supply.available_by_type?.[type] ?? 0
  if (!avail) {
    return <Tag color="error">{t('pcAvailNone')}</Tag>
  }
  if (count > avail) {
    return <Tag color="error">{t('pcAvailShort', { want: count, avail })}</Tag>
  }
  return <Tag color="default">{t('pcAvailOf', { n: avail })}</Tag>
}


/** 带标题和可选副标题的卡片样式区块 */
const CardSection: React.FC<{
  title: string
  subtitle?: string
  children: React.ReactNode
}> = ({ title, subtitle, children }) => (
  <div
    style={{
      padding: '16px',
      background: 'var(--bg-layout)',
      borderRadius: 8,
      border: '1px solid var(--border-color)',
    }}
  >
    <div style={{ marginBottom: 12 }}>
      <Typography.Text strong style={{ fontSize: 15 }}>
        {title}
      </Typography.Text>
      {subtitle && (
        <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
          {subtitle}
        </Typography.Text>
      )}
    </div>
    {children}
  </div>
)

export default PaperConfigForm
