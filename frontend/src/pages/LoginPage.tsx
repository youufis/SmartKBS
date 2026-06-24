import React, { useState, useEffect } from 'react'
import { Form, Input, Button, Typography, message, Row, Col } from 'antd'
import {
  UserOutlined, LockOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { getOnlineCount } from '../api/auth'
import apiClient from '../api/client'
import ThemeSwitcher from '../components/ThemeSwitcher'

const { Text, Title, Paragraph } = Typography

// ── 教育名言（每次随机选一条） ──
const QUOTES = [
  // 中国古代教育智慧
  { text: '学而不思则罔，思而不学则殆。', author: '孔子' },
  { text: '知之者不如好之者，好之者不如乐之者。', author: '孔子' },
  { text: '温故而知新，可以为师矣。', author: '孔子' },
  { text: '学而时习之，不亦说乎？', author: '孔子' },
  { text: '三人行，必有我师焉。择其善者而从之，其不善者而改之。', author: '孔子' },
  { text: '有教无类。', author: '孔子' },
  { text: '因材施教。', author: '孔子' },
  { text: '不愤不启，不悱不发。', author: '孔子' },
  { text: '敏而好学，不耻下问。', author: '孔子' },
  { text: '学而不厌，诲人不倦。', author: '孔子' },
  { text: '授人以鱼不如授人以渔。', author: '《老子》' },
  { text: '千里之行，始于足下。', author: '《老子》' },
  { text: '青，取之于蓝而青于蓝。', author: '荀子' },
  { text: '不积跬步，无以至千里；不积小流，无以成江海。', author: '荀子' },
  { text: '学不可以已。', author: '荀子' },
  { text: '玉不琢，不成器；人不学，不知道。', author: '《礼记》' },
  { text: '教学相长也。', author: '《礼记》' },
  { text: '师者，所以传道受业解惑也。', author: '韩愈' },
  { text: '业精于勤，荒于嬉；行成于思，毁于随。', author: '韩愈' },
  { text: '书山有路勤为径，学海无涯苦作舟。', author: '韩愈' },
  { text: '黑发不知勤学早，白首方悔读书迟。', author: '颜真卿' },
  { text: '纸上得来终觉浅，绝知此事要躬行。', author: '陆游' },
  { text: '问渠那得清如许？为有源头活水来。', author: '朱熹' },
  { text: '读书百遍，其义自见。', author: '陈寿' },
  { text: '路漫漫其修远兮，吾将上下而求索。', author: '屈原' },
  { text: '博学之，审问之，慎思之，明辨之，笃行之。', author: '《中庸》' },
  { text: '业精于勤荒于嬉，行成于思毁于随。', author: '韩愈' },
  { text: '少壮不努力，老大徒伤悲。', author: '《长歌行》' },
  { text: '宝剑锋从磨砺出，梅花香自苦寒来。', author: '《警世贤文》' },
  { text: '立志宜思真品格，读书须尽苦功夫。', author: '阮元' },

  // 西方教育哲理
  { text: '教育不是注满一桶水，而是点燃一把火。', author: '叶芝' },
  { text: '教育的根是苦的，但果实是甜的。', author: '亚里士多德' },
  { text: '教育是点燃火焰，而非填满容器。', author: '苏格拉底' },
  { text: '教育是一个灵魂唤醒另一个灵魂。', author: '雅斯贝尔斯' },
  { text: '我听见了就忘了，我看见了就记住了，我做了就理解了。', author: '蒙台梭利' },
  { text: '教育的目的在于使人能够继续教育自己。', author: '杜威' },
  { text: '教育不是为生活做准备，教育就是生活本身。', author: '杜威' },
  { text: '每个孩子都是一颗种子，只是花期不同。', author: '蒙台梭利' },
  { text: '教育的艺术不在于传授本领，而在于激励、唤醒和鼓舞。', author: '第斯多惠' },
  { text: '一个教师的影响是永恒的；他永远不知道这影响会止于何处。', author: '亨利·亚当斯' },
  { text: '教育是获得知识的阶梯，但智慧才是最终的目的。', author: '柏拉图' },
  { text: '学习的本质不在于记住，而在于理解和创造。', author: '皮亚杰' },
  { text: '教育是引导学生探索未知，而非灌输已知。', author: '卢梭' },
  { text: '最重要的教育方法是鼓励学生去实际行动。', author: '爱因斯坦' },
  { text: '想象力比知识更重要。', author: '爱因斯坦' },
  { text: '教育就是当一个人把在学校所学全部忘光之后剩下的东西。', author: '爱因斯坦' },
  { text: '不要用爬树的能力来衡量一条鱼——每个人都是天才。', author: '爱因斯坦' },
  { text: '教育的最高目标是培养有独立思考能力的人。', author: '康德' },
  { text: '教育是一种影响，是最广泛的、最深刻的影响。', author: '赫尔巴特' },
  { text: '教学的艺术就是使学生喜欢你所教的东西。', author: '卢梭' },

  // 中国现代教育理念
  { text: '捧着一颗心来，不带半根草去。', author: '陶行知' },
  { text: '千教万教，教人求真；千学万学，学做真人。', author: '陶行知' },
  { text: '生活即教育，社会即学校，教学做合一。', author: '陶行知' },
  { text: '行是知之始，知是行之成。', author: '陶行知' },
  { text: '没有爱就没有教育。', author: '陶行知' },
  { text: '教育的本质是唤醒，是激发，是点燃。', author: '陶行知' },
  { text: '教师的职务是"千教万教，教人求真"；学生的职务是"千学万学，学做真人"。', author: '陶行知' },
  { text: '世界上没有才能的人是没有的。问题在于教育者要去发现每一位学生的禀赋、兴趣和特长。', author: '苏霍姆林斯基' },
  { text: '教育技巧的全部奥秘就在于如何爱护学生。', author: '苏霍姆林斯基' },
  { text: '让学生体验到一种自己在亲身参与掌握知识的情感，乃是唤起少年特有的对知识的兴趣的重要条件。', author: '苏霍姆林斯基' },

  // 原创 / 现代教育格言
  { text: '每个学生都是独特的，教育的艺术在于发现并点亮他们的光芒。' },
  { text: '学习不是知识的积累，而是思维的变革。' },
  { text: '教育的使命是让每一个生命都绽放光彩。' },
  { text: '好的教育不是注满一桶水，而是点燃一把火。' },
  { text: '知识改变命运，教育成就未来。' },
  { text: '教育的本质是让人成为更好的自己。' },
  { text: '教育是通向未来的钥匙，学习是打开这扇门的行动。' },
  { text: '每一个孩子都是一颗星星，教育者的责任是让他们闪耀。' },
  { text: '教育是用生命影响生命，用心灵唤醒心灵。' },
  { text: '最好的教育是让学生发现自己、成为自己、超越自己。' },
  { text: '学习是一生的事业，教育是终身的陪伴。' },
  { text: '真正的教育是教会学生如何思考，而不是思考什么。' },
  { text: '教育的魅力在于它能让平凡变得非凡，让可能变成现实。' },
  { text: '课堂是有限的，但学习的边界是无限的。' },
  { text: '每一次认真的学习，都是对未来的投资。' },
  { text: '教育不仅改变一个人的命运，更改变一个民族的未来。' },
  { text: '知识的海洋无边无际，教育是指引方向的灯塔。' },
  { text: '教育是点亮心灵的火炬，知识是照亮前路的光芒。' },
  { text: '学习的意义不在于获得答案，而在于提出更好的问题。' },
  { text: '教育的最终目的是培养自由、独立、有责任感的灵魂。' },
]

const LoginPage: React.FC = () => {
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const [loading, setLoading] = useState(false)
  const [onlineCount, setOnlineCount] = useState(0)
  const [agentName, setAgentName] = useState('智慧教学平台-高中信通版')
  const [orgName, setOrgName] = useState('')

  // 随机选一条名言（仅在组件挂载时确定）
  const [quote] = useState(() => QUOTES[Math.floor(Math.random() * QUOTES.length)])

  // 获取公开配置（品牌信息）
  useEffect(() => {
    apiClient.get('/api/config/public').then(({ data }) => {
      if (data.AGENT_NAME) setAgentName(data.AGENT_NAME)
      if (data.ORG_NAME) setOrgName(data.ORG_NAME)
    }).catch(() => {})
    // 检查是否有异地登录被踢出的提示
    const kickoutMsg = localStorage.getItem('smartkb_kickout_msg')
    if (kickoutMsg) {
      message.warning(kickoutMsg)
      localStorage.removeItem('smartkb_kickout_msg')
    }
  }, [])

  useEffect(() => {
    getOnlineCount().then(setOnlineCount).catch(() => {})
    const timer = setInterval(() => getOnlineCount().then(setOnlineCount).catch(() => {}), 15000)
    return () => clearInterval(timer)
  }, [])

  const handleLogin = async (values: { username: string; password: string }) => {
    setLoading(true)
    try {
      await login(values.username, values.password)
      message.success('登录成功')
      navigate('/dashboard')
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err.message || '登录失败'
      message.error(detail)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', position: 'relative', overflow: 'hidden' }}>
      {/* ── 全屏渐变背景 ── */}
      <div style={{
        position: 'fixed', inset: 0,
        background: `linear-gradient(135deg, var(--login-gradient-start) 0%, var(--login-gradient-end) 100%)`,
        zIndex: 0,
      }} />

      {/* ── 浮动装饰圆 ── */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
        {[
          { size: 320, top: '8%', left: '-4%', delay: 0, duration: 20 },
          { size: 220, top: '55%', left: '12%', delay: 3, duration: 25 },
          { size: 260, top: '3%', right: '28%', delay: 6, duration: 22 },
          { size: 160, bottom: '15%', right: '8%', delay: 2, duration: 18 },
          { size: 190, top: '35%', right: '38%', delay: 8, duration: 28 },
        ].map((c, i) => (
          <div key={i} style={{
            position: 'absolute',
            width: c.size, height: c.size,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.06)',
            top: c.top, left: c.left, right: c.right, bottom: c.bottom,
            animation: `loginFloat ${c.duration}s ease-in-out ${c.delay}s infinite alternate`,
          }} />
        ))}
      </div>
      <style>{`
        @keyframes loginFloat {
          0% { transform: translate(0, 0) scale(1); }
          100% { transform: translate(30px, -40px) scale(1.1); }
        }
        @keyframes loginFadeIn {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .login-card-wrap { animation: loginFadeIn 0.7s ease-out; }
      `}</style>

      {/* ── 右上角主题切换 ── */}
      <div style={{
        position: 'fixed', top: 16, right: 20, zIndex: 200,
        background: 'rgba(255,255,255,0.15)',
        backdropFilter: 'blur(8px)',
        borderRadius: 8,
        padding: '2px 4px',
      }}>
        <ThemeSwitcher />
      </div>

      {/* ── 主内容 ── */}
      <Row
        justify="center"
        align="middle"
        style={{ minHeight: '100vh', position: 'relative', zIndex: 1, padding: 20 }}
      >
        <Col xs={24} sm={22} md={14} lg={10} xl={9} xxl={8} className="login-card-wrap">
          {/* 玻璃卡片容器 */}
          <div style={{
            borderRadius: 20,
            overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.08)',
            background: 'var(--bg-container)',
          }}>

            {/* ── 登录面板 ── */}
            <div style={{
              padding: '32px 36px 36px',
              background: 'var(--bg-container)',
            }}>
              {/* 品牌标识 */}
              <div style={{ textAlign: 'center', marginBottom: 28 }}>
                <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 4 }}>🤖</div>
                <Title level={3} style={{ margin: 0, color: 'var(--primary-color)', fontWeight: 700 }}>
                  SmartKB
                </Title>
                <Text style={{ color: 'var(--text-secondary)', fontSize: 13, display: 'block', marginTop: 2 }}>
                  {agentName}
                </Text>
                {orgName && (
                  <Text style={{ color: 'var(--text-tertiary)', fontSize: 12, display: 'block', marginTop: 2 }}>
                    {orgName}
                  </Text>
                )}
              </div>

              {/* 在线人数 */}
              <div style={{
                textAlign: 'center',
                marginBottom: 20,
                fontSize: 12,
                color: onlineCount > 0 ? 'var(--success-color)' : 'var(--text-tertiary)',
              }}>
                🟢 当前在线: {onlineCount} 人
              </div>

              {/* 名言 */}
              <div style={{
                marginBottom: 20,
                padding: '14px 18px',
                background: 'var(--bg-layout)',
                borderRadius: 10,
                textAlign: 'center',
              }}>
                <Paragraph style={{
                  color: 'var(--text-secondary)', fontSize: 13, fontWeight: 400,
                  fontStyle: 'italic', lineHeight: 1.7, margin: 0,
                }}>
                  「{quote.text}」
                </Paragraph>
                {quote.author && (
                  <Text style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 2, display: 'block' }}>
                    —— {quote.author}
                  </Text>
                )}
              </div>

              {/* 登录表单 */}
              <Form onFinish={handleLogin} layout="vertical" size="large">
                <Form.Item
                  name="username"
                  rules={[{ required: true, message: '请输入用户名' }]}
                  style={{ marginBottom: 20 }}
                >
                  <Input
                    prefix={<UserOutlined style={{ color: 'var(--text-tertiary)' }} />}
                    placeholder="用户名或姓名"
                    style={{ borderRadius: 10 }}
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  rules={[{ required: true, message: '请输入密码' }]}
                  style={{ marginBottom: 28 }}
                >
                  <Input.Password
                    prefix={<LockOutlined style={{ color: 'var(--text-tertiary)' }} />}
                    placeholder="密码"
                    style={{ borderRadius: 10 }}
                  />
                </Form.Item>
                <Form.Item style={{ marginBottom: 0 }}>
                  <Button
                    type="primary"
                    htmlType="submit"
                    block
                    loading={loading}
                    size="large"
                    style={{ borderRadius: 10, height: 48, fontSize: 16 }}
                  >
                    登 录
                  </Button>
                </Form.Item>
              </Form>

              {/* 版权 */}
              <div style={{ textAlign: 'center', marginTop: 24, fontSize: 12, color: 'var(--footer-text)' }}>
                © 2026 UNET. All rights reserved.
              </div>
            </div>
          </div>
        </Col>
      </Row>
    </div>
  )
}

export default LoginPage
