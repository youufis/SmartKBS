// 测验（随堂测验）选项字母口径 —— P0-4：字母=位置（A/B/C…），与选项内容解耦。
// 历史数据里选项文本常自带 "A. " 前缀（旧编辑器默认值），显示时剥掉再挂位置字母，避免双字母；
// 老答案（取选项首字符，如"光"）在编辑回填时映射回位置字母。

/** 第 i 个选项的位置字母 */
export const optionLetter = (i: number): string => String.fromCharCode(65 + i)

/** 剥掉选项文本自带的 "A. / B、/ c." 式字母前缀（只剥一层，正文里的点号不动） */
export const stripOptionPrefix = (text: unknown): string => {
  const s = String(text ?? '')
  const m = s.match(/^[A-Za-z][.、)）]\s*([\s\S]*)$/)
  return m ? m[1] : s
}

/** 选项显示文本：位置字母 + 净文本 */
export const optionLabel = (text: unknown, i: number): string =>
  `${optionLetter(i)}. ${stripOptionPrefix(text)}`

/**
 * 答案值 → 位置字母串（多选按集合）。
 * 已是合法字母直接用；老写法（选项首字符，如"光"）映射到该选项的位置字母；
 * 判断题的"对/错"原样返回（判分端有统一归一）。
 */
export const coerceAnswerToLetters = (value: unknown, options: unknown): string => {
  const raw = String(value ?? '').trim()
  if (!raw || !Array.isArray(options) || !options.length) return raw
  const keys = options.map((_, i) => optionLetter(i))
  const isLetters = (v: string) => v.length > 0 && [...v].every(ch => keys.includes(ch))
  if (isLetters(raw.toUpperCase())) return raw.toUpperCase().split('').sort().join(',')
  if (raw === '对' || raw === '错') return raw
  const firstMap = new Map<string, string>()
  options.forEach((opt, i) => {
    const fc = String(opt ?? '').trim().slice(0, 1).toUpperCase()
    if (fc && !firstMap.has(fc)) firstMap.set(fc, keys[i])
  })
  const out: string[] = []
  for (const ch of raw.toUpperCase()) {
    if (keys.includes(ch)) out.push(ch)
    else if (firstMap.has(ch)) out.push(firstMap.get(ch)!)
    else return raw
  }
  // 编辑器多选答案键用逗号分隔（checkbox value 数组按 ',' 拆），这里必须对齐
  return [...new Set(out)].sort().join(',')
}
