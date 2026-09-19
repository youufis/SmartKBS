/**
 * 班级范围文案折叠：共享/活动记录里的 target_class 常是「高一1班,高一2班,…高一13班」整串，
 * 直接塞进 Tag 会把卡片撑爆，这里统一压缩成可读短文案（完整名单交给 Tooltip）。
 */
export function compactClassScope(grade: string, raw: string): string {

  const g = String(grade || '').trim()
  const list = String(raw || '').split(/[,，、]/).map((x) => x.trim()).filter(Boolean)
  const withGrade = (c: string) => (g && !c.startsWith(g) ? `${g}${c}` : c)
  if (!list.length) return g
  if (list.length === 1) return withGrade(list[0])
  // 只认「1班 / 高一1班」这类纯班号，跨年级混排时不做区间压缩，老实列出来
  const bare = list.map((c) => (g && c.startsWith(g) ? c.slice(g.length) : c))
  if (bare.every((b) => /^[0-9]+班?$/.test(b))) {
    const arr = bare.map((b) => Number(b.replace(/[^0-9]/g, ''))).sort((a, b) => a - b)
    if (arr.every((n) => n > 0)) {
      const contiguous = arr.every((v, k) => k === 0 || v === arr[k - 1] + 1)
      if (contiguous) return `${g}${arr[0]}-${arr[arr.length - 1]}班`
      if (arr.length <= 3) return `${g}${arr.join('、')}班`
      return `${g}${arr.length}个班`
    }
  }
  const shown = list.map(withGrade)
  return shown.length <= 2 ? shown.join('、') : `${shown[0]} 等 ${shown.length} 个班`
}
