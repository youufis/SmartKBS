import { Button, Popconfirm, Select, Space, Switch, Tooltip, Typography } from 'antd'
import { DatabaseOutlined, RobotOutlined, RocketOutlined, SettingOutlined, SoundOutlined, MutedOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { LadderConfig, LadderSession } from '../../../api/classLadder'
import KnowledgePointSelect from '../../../components/KnowledgePointSelect'
import type { LadderSetupApi } from '../hooks/useLadderSetup'

const { Text } = Typography

interface Props {
  setup: LadderSetupApi
  config: LadderConfig | null
  session: LadderSession | null
  activeSkin: string
  onSkinChange: (v: string) => void
  soundOn: boolean
  soundAvailable: boolean
  onToggleSound: () => void
  setupOpen: boolean
  onToggleSetup: () => void
}

/** 开场设置行：对局中自动收起，只留皮肤/声音/AI/结束与展开入口 */
export default function LadderSetupBar(p: Props) {
  const { t } = useTranslation('classLadder')
  const { setup, config, session, setupOpen } = p
  return (
    <div className="cl-setup">
      {setupOpen && (<>
        <Select placeholder={t('selectGradePlaceholder')} value={setup.grade || undefined} onChange={setup.handleGradeChange}
          style={{ width: 118 }} options={setup.grades.map((g) => ({ label: g, value: g }))} />
        <Select placeholder={t('selectClassPlaceholder')} value={setup.cls || undefined} onChange={setup.handleClassChange}
          style={{ width: 130 }} disabled={!setup.grade} options={setup.classes.map((c) => ({ label: c, value: c }))} />

        <Select placeholder={t('subjectPlaceholder')} value={setup.subject || undefined} allowClear
          onChange={(v) => { setup.setSubject(v || ''); setup.setCourseKp('') }}
          style={{ width: 118 }} options={setup.subjects.map((s) => ({ label: s, value: s }))} />
        <KnowledgePointSelect multiple={false} subject={setup.subject} value={setup.courseKp}
          onChange={(v) => setup.setCourseKp(String(v || ''))} style={{ width: 200 }} />

        <Select value={setup.questionType} onChange={setup.setQuestionType} style={{ width: 116 }}
          options={(config?.question_types || [{ value: 'single', label: t('qtSingle') }]).map((o) => ({
            label: o.value === 'true_false' ? t('qtTrueFalse') : t('qtSingle'), value: o.value,
          }))} />
        <Select value={setup.timeLimit} onChange={setup.setTimeLimit} style={{ width: 116 }}
          options={[...(config?.time_limits || [60, 90, 120]).map((n) => ({ label: t('secondUnit', { n }), value: n })),
            { label: t('timeLimitNone'), value: 0 }]} />
        <Select value={setup.poolSize} onChange={setup.setPoolSize} style={{ width: 108 }}
          options={[15, 30, 45].map((n) => ({ label: t('poolSizeUnit', { n }), value: n }))} />
      </>)}

      <Button size="small" type="text" className="cl-setup-toggle" icon={<SettingOutlined />}
        onClick={p.onToggleSetup}>{setupOpen ? t('setupCollapse') : t('setupExpand')}</Button>

      <Select value={p.activeSkin} onChange={p.onSkinChange} style={{ width: 132 }}
        options={(config?.skins || []).map((s) => ({
          label: `${s.light ? '☀ ' : '🌙 '}${t(`skinNames.${s.value}`, { defaultValue: s.label })}`, value: s.value,
        }))} />

      {/* 一个声音总开关：音效（WebAudio 合成）与抽中念名一起控制 */}
      <Tooltip title={!p.soundAvailable ? t('soundDisabledByAdmin') : (p.soundOn ? t('soundOnHint') : t('soundOffHint'))}>
        <Button size="small" disabled={!p.soundAvailable}
          icon={p.soundOn && p.soundAvailable ? <SoundOutlined /> : <MutedOutlined />}
          onClick={p.onToggleSound} />
      </Tooltip>
      <Tooltip title={config && !config.ai_enabled ? t('aiDisabledByAdmin') : t('aiSwitchHint')}>
        <Space size={6}>
          <Switch checked={setup.allowAi} disabled={!config?.ai_enabled} onChange={setup.setAllowAi} size="small" />
          <Text type={config?.ai_enabled ? undefined : 'secondary'} style={{ fontSize: 13 }}>
            <RobotOutlined /> {t('aiSwitch')}
          </Text>
        </Space>
      </Tooltip>
      {setupOpen && (<>
        <Button type="primary" icon={<RocketOutlined />} loading={setup.opening} disabled={!setup.ready} onClick={setup.doOpenSession}>
          {session ? t('resetSession') : t('startSession')}
        </Button>
        <Button icon={<DatabaseOutlined />} loading={setup.building} disabled={!session} onClick={() => void setup.doBuildPool()}>
          {setup.building && setup.poolProgress
            ? t('poolProgress', { done: setup.poolProgress.done, total: setup.poolProgress.total })
            : (session?.pool?.total ? t('rebuildPool') : t('buildPool'))}
        </Button>
      </>)}

      <Popconfirm title={t('confirmEnd')} disabled={!session} onConfirm={() => setup.doEndSession()}>
        <Button danger disabled={!session}>{t('endSession')}</Button>
      </Popconfirm>
    </div>
  )
}
