/* eslint-disable */
// @ts-nocheck
/**
 * tldraw 授权验签补齐（tl-verify）
 * ============================================================================
 * 什么时候加载：只在「明文 http 的非环回地址」这种不安全源里，浏览器不提供
 * crypto.subtle，tldraw SDK 因而跳过验签、只显示它的 "Get a license for
 * production" 按钮。此时由 utils/webcryptoVerifyShim.ts 按需 import 本模块，
 * 补上 SDK 真正需要的两个方法：
 *   crypto.subtle.importKey('spki', …, {name:'ECDSA', namedCurve:'P-256'}, …)
 *   crypto.subtle.verify({name:'ECDSA', hash:{name:'SHA-256'}}, …)
 *
 * 边界（改之前先读）：
 *   1. 只实现上面两个方法，不做签名、不做加解密；不读 cookie、不写存储、不碰 DOM。
 *   2. 只在原生 crypto.subtle 不存在时安装；已经有原生能力时一律不动。
 *   3. 补的是「平台缺的能力」，不是「绕过判定」：校验仍然是 tldraw 自己的代码在跑，
 *      签名/域名/到期/水印位全部由 SDK 自己判。造假的 key 依旧验不过 → 仍旧显示按钮。
 *   4. 加载或解析失败一律抛错，由调用方回落到原生行为（按钮 + 白板照常可用）。
 *
 * 为什么独立成按需 chunk：这里用了 BigInt，而项目主包 target 是 es2015。放进按需
 * chunk 后，只有真正需要它的那台机器才会下载；老浏览器解析失败会让 import() 直接
 * reject，调用方回落成原生行为，主包与整体的兼容下限都不受影响。
 * （曾经放在 public/ 里用 import('/tl-verify.js') 加载：生产可用，但 Vite dev 明确
 *  禁止从源码 import public 资源，会直接抛 "should not be imported from source code"。）
 *
 * 正确性由 scripts/check_tl_verify_shim.mjs 兜底：拿 Node 自带 WebCrypto 当预言机，
 * 对同一批 P-256 向量逐一对拍（含原始 r||s 与 DER 两种签名形态），并验证篡改必拒。
 */

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n

export const TL_VERIFY_SHIM_VERSION = 1

/** tldraw 5.1.1 LicenseManager 内置公钥（SDK 源码里的公开常量），只用于本文件的自检函数 */
export const TLDRAW_PUBLIC_KEY =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHJh0uUfxHtCGyerXmmatE368Hd9rI6LH9oPDQihnaCryRFWEVeOvf9U/SPbyxX74LFyJs5tYeAHq5Nc0Ax25LQ'

/* ------------------------------- SHA-256 ------------------------------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0

function sha256Digest(bytes) {
  const len = bytes.length
  const padded = new Uint8Array(((((len + 8) >> 6) + 1) << 6))
  padded.set(bytes)
  padded[len] = 0x80
  const dv = new DataView(padded.buffer)
  const bits = len * 8
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  dv.setUint32(padded.length - 4, bits >>> 0)

  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const W = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i])
  return out
}

/* --------------------------- 大整数 / 曲线运算 --------------------------- */

const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m }

function invMod(a, m = P) {
  let [old_r, r] = [mod(a, m), m]
  let [old_s, s] = [1n, 0n]
  while (r !== 0n) {
    const q = old_r / r
    ;[old_r, r] = [r, old_r - q * r]
    ;[old_s, s] = [s, old_s - q * s]
  }
  if (old_r !== 1n) throw new Error('tl-verify: 该数不可逆')
  return mod(old_s, m)
}

const INF = { X: 0n, Y: 1n, Z: 0n }

function jDouble(p) {
  if (p.Z === 0n || p.Y === 0n) return INF
  const { X, Y, Z } = p
  const Y2 = mod(Y * Y)
  const S = mod(4n * X * Y2)
  const ZZ = mod(Z * Z)
  const M = mod(3n * (X - ZZ) * (X + ZZ)) // a = -3
  const X3 = mod(M * M - 2n * S)
  const Y3 = mod(M * (S - X3) - 8n * Y2 * Y2)
  const Z3 = mod(2n * Y * Z)
  return { X: X3, Y: Y3, Z: Z3 }
}

function jAdd(p, q) {
  if (p.Z === 0n) return q
  if (q.Z === 0n) return p
  const z1z1 = mod(p.Z * p.Z)
  const z2z2 = mod(q.Z * q.Z)
  const u1 = mod(p.X * z2z2)
  const u2 = mod(q.X * z1z1)
  const s1 = mod(p.Y * q.Z * z2z2)
  const s2 = mod(q.Y * p.Z * z1z1)
  if (u1 === u2) return s1 === s2 ? jDouble(p) : INF
  const H = mod(u2 - u1)
  const R = mod(s2 - s1)
  const H2 = mod(H * H)
  const H3 = mod(H * H2)
  const X3 = mod(R * R - H3 - 2n * u1 * H2)
  const Y3 = mod(R * (u1 * H2 - X3) - s1 * H3)
  const Z3 = mod(H * p.Z * q.Z)
  return { X: X3, Y: Y3, Z: Z3 }
}

function jMul(p, k) {
  let e = mod(k, N)
  let acc = INF
  let add = p
  while (e > 0n) {
    if (e & 1n) acc = jAdd(acc, add)
    add = jDouble(add)
    e >>= 1n
  }
  return acc
}

function toAffine(p) {
  if (p.Z === 0n) throw new Error('tl-verify: 无穷远点')
  const zi = invMod(p.Z, P)
  const zi2 = mod(zi * zi)
  return { x: mod(p.X * zi2), y: mod(p.Y * zi2 * zi) }
}

const G = { X: GX, Y: GY, Z: 1n }

function onCurve(pt) {
  return mod(pt.y * pt.y) === mod(pt.x * pt.x * pt.x - 3n * pt.x + B)
}

/* ------------------------------- DER / 编码 ------------------------------ */

function toBytes(v) {
  if (v instanceof Uint8Array) return v
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  throw new Error('tl-verify: 需要二进制数据')
}

function b64ToBytes(b64) {
  const s = String(b64).replace(/\s+/g, '')
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const beToBig = (bytes) => {
  let v = 0n
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i])
  return v
}

function readDer(buf, pos) {
  if (pos + 2 > buf.length) throw new Error('tl-verify: DER 越界')
  const tag = buf[pos++]
  let len = buf[pos++]
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4) throw new Error('tl-verify: DER 长度非法')
    len = 0
    for (let i = 0; i < n; i++) {
      if (pos >= buf.length) throw new Error('tl-verify: DER 越界')
      len = len * 256 + buf[pos++]
    }
  }
  if (pos + len > buf.length) throw new Error('tl-verify: DER 越界')
  return { tag, start: pos, len, end: pos + len }
}

function derToRS(buf) {
  const seq = readDer(buf, 0)
  if (seq.tag !== 0x30 || seq.end !== buf.length) throw new Error('tl-verify: 签名不是 DER SEQUENCE')
  const r0 = readDer(buf, seq.start)
  if (r0.tag !== 0x02) throw new Error('tl-verify: 签名缺 r')
  const s0 = readDer(buf, r0.end)
  if (s0.tag !== 0x02 || s0.end !== seq.end) throw new Error('tl-verify: 签名缺 s')
  const intOf = (o) => {
    let i = o.start
    while (i < o.end - 1 && buf[i] === 0) i++
    return beToBig(buf.subarray(i, o.end))
  }
  return { r: intOf(r0), s: intOf(s0) }
}

/** 同时接受 DER 和 WebCrypto 的原始 r||s（64 字节）两种形态 */
function parseSignature(bytes) {
  if (bytes.length === 64) {
    return { r: beToBig(bytes.subarray(0, 32)), s: beToBig(bytes.subarray(32, 64)) }
  }
  return derToRS(bytes)
}

/** SubjectPublicKeyInfo（spki）→ 未压缩点 */
function spkiToPoint(buf) {
  const seq = readDer(buf, 0)
  if (seq.tag !== 0x30 || seq.end !== buf.length) throw new Error('tl-verify: 公钥不是 SPKI SEQUENCE')
  const alg = readDer(buf, seq.start)
  if (alg.tag !== 0x30) throw new Error('tl-verify: 公钥缺 AlgorithmIdentifier')
  const bits = readDer(buf, alg.end)
  if (bits.tag !== 0x03 || bits.end !== seq.end) throw new Error('tl-verify: 公钥缺 BIT STRING')
  if (bits.len !== 66 || buf[bits.start] !== 0x00) throw new Error('tl-verify: 公钥位串长度异常')
  const raw = buf.subarray(bits.start + 1, bits.end)
  if (raw.length !== 65 || raw[0] !== 0x04) throw new Error('tl-verify: 只支持未压缩 P-256 公钥')
  const pt = { x: beToBig(raw.subarray(1, 33)), y: beToBig(raw.subarray(33, 65)) }
  if (!onCurve(pt)) throw new Error('tl-verify: 公钥不在 P-256 曲线上')
  return pt
}

/* -------------------------------- 验签 --------------------------------- */

export function verifySignature(signature, data, point) {
  const { r, s } = parseSignature(toBytes(signature))
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false
  const e = beToBig(sha256Digest(toBytes(data)))
  const w = invMod(s, N)
  const u1 = mod(e * w, N)
  const u2 = mod(r * w, N)
  const sum = jAdd(jMul(G, u1), jMul({ X: point.x, Y: point.y, Z: 1n }, u2))
  if (sum.Z === 0n) return false
  return mod(toAffine(sum).x, N) === r
}

/** 诊断/自检用：按 tldraw 的 key 形态（tldraw-<日期>/<payload>.<签名>）验签 */
export function verifyLicenseSignature(licenseKey, publicKeyBase64) {
  const [left, sigB64] = String(licenseKey).trim().split('.')
  if (!left || !sigB64) return false
  // 前缀本身不参与验签（tldraw 只对 payload 签名），所以按第一个 '/' 切，payload 里允许出现 '/'
  const slash = left.indexOf('/')
  const payloadB64 = slash >= 0 ? left.slice(slash + 1) : ''
  if (!payloadB64) return false
  try {
    return verifySignature(b64ToBytes(sigB64), b64ToBytes(payloadB64), spkiToPoint(b64ToBytes(publicKeyBase64)))
  } catch {
    return false
  }
}

export function verifyTLDrawLicenseKey(licenseKey) {
  try {
    return verifyLicenseSignature(licenseKey, TLDRAW_PUBLIC_KEY)
  } catch {
    return false
  }
}

/* ------------------------------ 安装补齐 ------------------------------- */

export function hasNativeVerify() {
  return !!(globalThis.crypto && globalThis.crypto.subtle)
}

/**
 * 只在原生 crypto.subtle 缺失时安装。返回 true = 本次由我们补上。
 * 完全不碰 DOM / 样式 / 全局事件，除 crypto.subtle 一个属性外不改任何东西。
 */
export function installVerifyShim() {
  const c = globalThis.crypto
  if (!c || typeof c !== 'object') return false
  if (c.subtle) return false
  const subtle = {
    async importKey(format, keyData, algorithm, extractable, usages) {
      if (String(format).toLowerCase() !== 'spki') throw new Error('tl-verify: 只支持 spki 格式')
      const alg = algorithm || {}
      if (String(alg.name).toUpperCase() !== 'ECDSA') throw new Error('tl-verify: 只支持 ECDSA')
      if (String(alg.namedCurve) !== 'P-256') throw new Error('tl-verify: 只支持 P-256')
      if (!Array.isArray(usages) || !usages.includes('verify')) throw new Error('tl-verify: 只支持 verify 用途')
      return Object.freeze({
        __tlVerifyPoint: spkiToPoint(toBytes(keyData)),
        type: 'public',
        extractable: false,
        algorithm: { name: 'ECDSA', namedCurve: 'P-256' },
        usages: Object.freeze(['verify']),
      })
    },
    async verify(algorithm, key, signature, data) {
      const alg = algorithm || {}
      if (String(alg.name).toUpperCase() !== 'ECDSA') throw new Error('tl-verify: 只支持 ECDSA')
      if (alg.hash && String(alg.hash.name).toUpperCase() !== 'SHA-256') throw new Error('tl-verify: 只支持 SHA-256')
      if (!key || !key.__tlVerifyPoint) throw new Error('tl-verify: 未知的密钥句柄')
      return verifySignature(signature, data, key.__tlVerifyPoint)
    },
  }
  try {
    Object.defineProperty(c, 'subtle', { value: subtle, configurable: true, enumerable: false, writable: true })
  } catch {
    return false
  }
  return globalThis.crypto.subtle === subtle
}

