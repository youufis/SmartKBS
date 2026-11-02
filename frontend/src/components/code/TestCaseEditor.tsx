import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, Checkbox, Empty, Input, InputNumber, Space, Tag, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { emptyTestCase, type EditableTestCase } from './constants'

const { Text } = Typography
const { TextArea } = Input

interface TestCaseEditorProps {
  value: EditableTestCase[]
  onChange: (cases: EditableTestCase[]) => void
  disabled?: boolean
}

/**
 * 测试用例编辑器：输入/期望输出用多行文本框。
 * 代码题的 stdin 经常是多行（先读 n，再读 n 个数），单行 Input 根本录不进去。
 */
const TestCaseEditor: React.FC<TestCaseEditorProps> = ({ value, onChange, disabled }) => {
  const { t } = useTranslation('practice')
  const totalScore = value.reduce((sum, c) => sum + (Number(c.score) || 0), 0)

  const update = (index: number, patch: Partial<EditableTestCase>) => {
    onChange(value.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const remove = (index: number) => {
    onChange(value.filter((_, i) => i !== index))
  }

  const add = () => {
    const sampleCount = value.filter((c) => c.is_sample).length
    onChange([...value, emptyTestCase(sampleCount < 2)])
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8, lineHeight: 1.7 }}>
        用例分值合计会自动按比例归一到 100 分，相对权重不变（例：2 / 2 / 3 会变成 29 / 29 / 42）。
        这样每道题的满分都是 100，跨题的平均分才可比。
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Space>
          <Text strong>{t('testCases')}</Text>
          <Tag>{value.length}</Tag>
          <Tag color="blue">{t('totalScoreLabel')} {totalScore}</Tag>
        </Space>
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={add} disabled={disabled}>
          {t('addTestCase')}
        </Button>
      </div>

      {value.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('noTestCasesYet')}>
          <Button type="primary" icon={<PlusOutlined />} onClick={add} disabled={disabled}>
            {t('addTestCase')}
          </Button>
        </Empty>
      ) : (
        <div style={{ maxHeight: 460, overflow: 'auto', paddingRight: 4 }}>
          {value.map((tc, index) => (
            <Card
              key={index}
              size="small"
              style={{ marginBottom: 8 }}
              title={(
                <Space size={6}>
                  <span>{t('caseN', { n: index + 1 })}</span>
                  {tc.is_sample && <Tag color="blue">{t('cpSampleTag')}</Tag>}
                </Space>
              )}
              extra={(
                <Space size={8}>
                  <Checkbox
                    checked={tc.is_sample}
                    disabled={disabled}
                    onChange={(e) => update(index, { is_sample: e.target.checked })}
                  >
                    {t('cpSampleTag')}
                  </Checkbox>
                  <Button
                    type="text" danger size="small" icon={<DeleteOutlined />}
                    disabled={disabled}
                    onClick={() => remove(index)}
                  />
                </Space>
              )}
            >
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('standardInput')}</Text>
                  <TextArea
                    rows={3}
                    value={tc.input}
                    disabled={disabled}
                    placeholder={t('inputMultilineHint')}
                    onChange={(e) => update(index, { input: e.target.value })}
                    style={{ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12, marginTop: 4 }}
                  />
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('expectedOutput')}</Text>
                  <TextArea
                    rows={3}
                    value={tc.expected}
                    disabled={disabled}
                    placeholder={t('expectedMultilineHint')}
                    onChange={(e) => update(index, { expected: e.target.value })}
                    style={{ fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12, marginTop: 4 }}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                <Input
                  value={tc.description}
                  disabled={disabled}
                  placeholder={t('testCaseDescription')}
                  onChange={(e) => update(index, { description: e.target.value })}
                  style={{ flex: 1 }}
                />
                <InputNumber
                  value={tc.score}
                  disabled={disabled}
                  min={0}
                  max={100}
                  step={0.5}
                  onChange={(v) => update(index, { score: Number(v) || 0 })}
                  addonAfter={t('scoreUnit')}
                  style={{ width: 130 }}
                />
              </div>
            </Card>
          ))}
        </div>
      )}
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
        {t('testCaseMultiHint')}
      </Text>
    </div>
  )
}

export default TestCaseEditor
