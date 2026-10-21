/** 取选项的作答键：单选是字母（A/B/C/D…），判断/其他退回序号字母。 */
export function optionKey(opt: string, idx: number, questionType: string): string {
  if (questionType === 'true_false') return String(opt || '').trim()
  const matched = String(opt || '').trim().match(/^([A-Ha-h])[.、．]/)
  return matched ? matched[1].toUpperCase() : String.fromCharCode(65 + idx)
}

/** 选项去掉 "A. " 前缀后的展示文本（前缀由圆标显示） */
export function optionText(opt: string, questionType: string): string {
  const s = String(opt || '').trim()
  if (questionType === 'true_false') return s
  return s.length > 2 && ['.', '、', '．'].includes(s[1]) ? s.slice(2).trim() : s
}

/** 班级 chip 文案：班名已含年级前缀时不再重复拼年级（避免「高一高一1班」） */
export function classChipLabel(s: { grade: string; class: string }): string {
  return s.class.startsWith(s.grade) ? s.class : `${s.grade}${s.class}`
}
