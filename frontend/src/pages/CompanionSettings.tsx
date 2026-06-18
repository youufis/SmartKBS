import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Typography, Switch, Input, Button, Space,
  message, Spin, Tag, Alert, Radio, Row, Col, Divider,
} from 'antd'
import { ArrowLeftOutlined, ReloadOutlined, CheckOutlined } from '@ant-design/icons'
import { useCompanionStore } from '../stores/companionStore'

const { Title, Text, Paragraph } = Typography

const AVATAR_MAP: Record<string, string> = {
  encouraging: '🌟',
  rigorous: '📐',
  humorous: '😄',
}

const PREVIEW_TEXT: Record<string, string> = {
  encouraging: '🌟 太棒了！这道题全对，继续加油！我相信你下次能做得更好 💪',
  rigorous: '📐 这道题考察的是进制转换的位权法，我们一步步来分析… 首先，你需要确认基数…',
  humorous: '😄 哎呀，进制转换又翻车了？看来它跟你过不去呀，今天必拿下它！来，先记住这个口诀…',
}

const CompanionSettings: React.FC = () => {
  const navigate = useNavigate()
  const { config, loadConfig, loadProfile, updateConfig, refreshProfile, profile } = useCompanionStore()

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [personality, setPersonality] = useState('encouraging')
  const [companionName, setCompanionName] = useState('小智')

  useEffect(() => {
    setLoading(true)
    Promise.all([loadConfig(), loadProfile()]).finally(() => setLoading(false))
  }, [loadConfig, loadProfile])

  useEffect(() => {
    if (config) {
      setEnabled(config.enabled ?? true)
      setPersonality(config.personality || 'encouraging')
      setCompanionName(config.companion_name || '小智')
    }
  }, [config])

  const hasChanges = personality !== (config?.personality || 'encouraging') || companionName !== (config?.companion_name || '小智')

  const handleSave = async () => {
    if (!companionName.trim() || companionName.trim().length > 10) {
      message.warning('学伴名称限 1-10 个字符')
      return
    }
    setSaving(true)
    try {
      await updateConfig({ enabled, personality, companion_name: companionName.trim() })
      message.success('学伴配置已保存 🎉')
    } catch (e: any) {
      message.error(e?.response?.data?.detail || e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleRefresh = async () => {
    try {
      await refreshProfile()
      message.success('学习画像已刷新')
    } catch {
      message.error('刷新失败')
    }
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spin size="large" tip="加载中..." />
      </div>
    )
  }

  return (
    <div style={{ maxWidth: '100%', margin: '0 auto', padding: '16px' }}>
      {/* ── 顶部导航 ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/chat?companion=1')}>
          返回
        </Button>
        <Divider type="vertical" />
        <span style={{ fontSize: 20 }}>🧠</span>
        <Title level={4} style={{ margin: 0 }}>AI 学伴设置</Title>
      </div>

      <Row gutter={[16, 16]}>
        {/* ═══ 左栏：设置项 ═══ */}
        <Col xs={24} md={14}>
          {/* ── 启用开关 ── */}
          <Card size="small" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <Text strong>启用 AI 学伴</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  开启后，智答页面将切换到学伴模式
                </Text>
              </div>
              <Switch checked={enabled} onChange={setEnabled} checkedChildren="开启" unCheckedChildren="关闭" />
            </div>
          </Card>

          {/* ── 学伴名称 ── */}
          <Card size="small" style={{ marginBottom: 16 }}>
            <Text strong>学伴名称</Text>
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>1-10 个字符</Text>
            <Input
              value={companionName}
              onChange={(e) => setCompanionName(e.target.value)}
              maxLength={10} showCount
              style={{ marginTop: 8 }}
              prefix="🧠" placeholder="小智"
            />
          </Card>

          {/* ── 学伴人格 ── */}
          <Card size="small" style={{ marginBottom: 16 }}>
            <Text strong>学伴人格</Text>
            <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>不同人格有不同的对话风格</Text>
            <div style={{ marginTop: 10 }}>
              <Radio.Group value={personality} onChange={(e) => setPersonality(e.target.value)} style={{ width: '100%' }}>
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  {[
                    { value: 'encouraging', emoji: '🎉', label: '鼓励型', desc: '「加油，你是最棒的！」温暖热情，充满正能量' },
                    { value: 'rigorous', emoji: '📐', label: '严谨型', desc: '「这道题我们来一步步分析」严谨细致，逻辑清晰' },
                    { value: 'humorous', emoji: '😄', label: '幽默型', desc: '「今天又翻车了？来，必拿下！」风趣幽默' },
                  ].map((p) => (
                    <Radio
                      key={p.value} value={p.value}
                      style={{
                        display: 'flex', alignItems: 'center', padding: '10px 14px', width: '100%',
                        borderRadius: 10,
                        border: personality === p.value ? '2px solid #667eea' : '1px solid #f0f0f0',
                        background: personality === p.value ? '#f5f0ff' : '#fff',
                        transition: 'all 0.2s',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
                        <span style={{ fontSize: 24 }}>{p.emoji}</span>
                        <div>
                          <Text strong style={{ fontSize: 14 }}>{p.label}</Text>
                          <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>{p.desc}</Paragraph>
                        </div>
                      </div>
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </div>
          </Card>

          {/* ── 人格实时预览 ── */}
          <Card
            size="small"
            style={{
              marginBottom: 16,
              background: 'linear-gradient(135deg, #faf8ff, #f0f4ff)',
              border: '1px solid #e0daf5',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <Text strong style={{ color: '#5b4fa0' }}>👁️ 人格预览</Text>
              {hasChanges && <Text type="warning" style={{ fontSize: 11 }}>⚡ 有未保存的更改</Text>}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: 'linear-gradient(135deg, #667eea, #764ba2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22, flexShrink: 0,
                boxShadow: '0 2px 8px rgba(102,126,234,0.3)',
              }}>
                {AVATAR_MAP[personality] || '🧠'}
              </div>
              <div style={{
                flex: 1, padding: '10px 14px', borderRadius: '16px 16px 16px 4px',
                background: '#fff', border: '1px solid #e8ecf4',
                boxShadow: '0 2px 8px rgba(102,126,234,0.08)',
                fontSize: 13, lineHeight: 1.6, color: '#333',
              }}>
                {PREVIEW_TEXT[personality]}
              </div>
            </div>
          </Card>

          {/* ── 操作按钮 ── */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Button
              type="primary" onClick={handleSave} loading={saving}
              icon={<CheckOutlined />} size="large"
              style={hasChanges ? { background: 'linear-gradient(135deg, #667eea, #764ba2)', borderColor: 'transparent' } : {}}
            >
              保存设置
            </Button>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh} size="large">
              刷新画像
            </Button>
          </div>
        </Col>

        {/* ═══ 右栏：画像预览 ═══ */}
        <Col xs={24} md={10}>
          <Card
            title={<span style={{ fontSize: 14 }}>📊 当前学习画像</span>}
            size="small"
            style={{
              background: 'linear-gradient(180deg, #faf8ff, #fff)',
              border: '1px solid #e0daf5',
              position: 'sticky', top: 16,
            }}
          >
            {profile ? (
              <>
                {/* 称号与积分 */}
                <div style={{ textAlign: 'center', marginBottom: 16 }}>
                  <span style={{ fontSize: 40 }}>{profile.titles?.main === '初窥门径' ? '🥚' : '🏆'}</span>
                  <div style={{ fontWeight: 600, fontSize: 16, marginTop: 4 }}>{profile.titles?.main || '初窥门径'}</div>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 4 }}>
                    <Tag color="orange">⭐ {profile.total_points || 0} 积分</Tag>
                    {profile.streak_days > 0 && <Tag color="red">🔥 {profile.streak_days} 天</Tag>}
                  </div>
                </div>

                <Divider style={{ margin: '8px 0' }} />

                {/* 薄弱知识点 */}
                {profile.weakness && profile.weakness.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <Text type="danger" style={{ fontSize: 12, fontWeight: 600 }}>⚠️ 薄弱知识点</Text>
                    <div style={{ marginTop: 4 }}>
                      {profile.weakness.slice(0, 3).map((w, i) => (
                        <div key={i} style={{
                          fontSize: 12, padding: '4px 8px', marginTop: 4,
                          background: '#fff2f0', borderRadius: 6,
                        }}>
                          {w.kp} <Tag color="error" style={{ fontSize: 10 }}>错{w.wrong_count}次</Tag>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 考试趋势 */}
                {profile.recent_exams && profile.recent_exams.count > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <Text style={{ fontSize: 12, fontWeight: 600 }}>📈 考试趋势</Text>
                    <div style={{ marginTop: 4, fontSize: 13 }}>
                      平均分 <Text strong>{profile.recent_exams.avg}</Text>
                      <span style={{ marginLeft: 8 }}>
                        {profile.recent_exams.trend === '上升' ? '📈' : profile.recent_exams.trend === '下降' ? '📉' : '➡️'}
                        <Text style={{ color: profile.recent_exams.trend === '上升' ? '#52c41a' : profile.recent_exams.trend === '下降' ? '#ff4d4f' : '#999' }}>
                          {profile.recent_exams.trend}
                        </Text>
                      </span>
                    </div>
                  </div>
                )}

                {/* 里程碑 */}
                {profile.milestones && profile.milestones.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <Text style={{ fontSize: 12, fontWeight: 600 }}>🏅 近期成就</Text>
                    {profile.milestones.slice(0, 2).map((m, i) => (
                      <div key={i} style={{ fontSize: 12, marginTop: 4, color: '#666' }}>• {m}</div>
                    ))}
                  </div>
                )}

                {/* 学习建议 */}
                {profile.recommendation && (
                  <Alert
                    type="info"
                    showIcon
                    message="💡 小智建议"
                    description={profile.recommendation}
                    style={{ fontSize: 12 }}
                  />
                )}
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '24px 0', color: '#999' }}>
                <Spin size="small" />
                <div style={{ marginTop: 8 }}>暂无画像数据</div>
              </div>
            )}
          </Card>
        </Col>
      </Row>
    </div>
  )
}

export default CompanionSettings
