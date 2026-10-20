/**
 * 课堂闯关音效 —— Web Audio 合成。
 *
 * 为什么不用音频文件：仓库里没有音效素材，引入二进制资源还要考虑体积与授权；
 * 这里直接用振荡器合成几个短音（滴答/答对/答错/锦囊/开场/结算），
 * **零素材、零网络、零成本**，音色统一由参数决定，想换风格改几个频率即可。
 *
 * 使用前提：浏览器要求合成器在用户手势后启动，所以首次交互（点"开一场/抽人"）时才建 AudioContext。
 */
type Ctx = AudioContext | null

let _ctx: Ctx = null

function ac(): Ctx {
  if (typeof window === 'undefined') return null
  const AC = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
  const Ctor = AC.AudioContext || AC.webkitAudioContext
  if (!Ctor) return null
  if (!_ctx) {
    try { _ctx = new Ctor() } catch { return null }
  }
  if (_ctx && _ctx.state === 'suspended') void _ctx.resume()
  return _ctx
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.06, delay = 0): void {
  const c = ac()
  if (!c) return
  try {
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = type
    osc.frequency.value = freq
    const t0 = c.currentTime + delay
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.linearRampToValueAtTime(gain, t0 + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    osc.connect(g)
    g.connect(c.destination)
    osc.start(t0)
    osc.stop(t0 + dur + 0.03)
  } catch {
    /* 音频不可用不该影响课堂流程 */
  }
}

function seq(freqs: number[], step: number, dur: number, type: OscillatorType, gain: number): void {
  freqs.forEach((f, i) => tone(f, dur, type, gain, i * step))
}

export const ladderSound = {
  /** 开场（抽到学生） */
  start() { seq([440, 660, 880], 0.09, 0.14, 'triangle', 0.06) },
  /** 倒计时滴答（>10s） */
  tick() { tone(880, 0.05, 'square', 0.03) },
  /** 倒计时告急（<=10s） */
  urgent() { tone(1240, 0.07, 'square', 0.05) },
  /** 答对 */
  correct() { seq([660, 880, 1320], 0.08, 0.16, 'triangle', 0.07) },
  /** 答错 / 超时 */
  wrong() { seq([330, 196], 0.14, 0.30, 'sawtooth', 0.055) },
  /** 锦囊生效 */
  lifeline() { seq([520, 780], 0.07, 0.12, 'sine', 0.05) },
  /** 通关 / 结算 */
  settle() { seq([523, 659, 784, 1047], 0.12, 0.24, 'triangle', 0.06) },
}

export default ladderSound