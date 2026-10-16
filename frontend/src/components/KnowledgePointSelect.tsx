/**
 * 知识点选择器（全站统一控件）
 *
 * 形态与试题管理里那个一致：**下拉选课程知识点 + 直接打字 + 逗号/顿号分词 + 按科目联动过滤**。
 * 两个顺带解决的问题：
 *   1. 课程树此前由试题管理、课堂抽问各拉一份 —— 现在模块级缓存，只拉一次；
 *   2. 手输的名称与课程树口径不一致时，题库匹配不到、只能退化成烧 AI 生成，
 *      用下拉选（label 里带课程名）能显著提高题库命中率。
 *
 * 用法：
 *   <KnowledgePointSelect subject={subject} value={kps} onChange={setKps} />          // 多选，值为 string[]
 *   <KnowledgePointSelect multiple={false} value={kp} onChange={setKp} />             // 单选，值为 string
 *   <KnowledgePointSelect extraOptions={['三极管']} />                                 // 追加候选（不参与学科过滤）
 *
 * 分隔符：控件本身按 `,，、` 分词；`splitKps/joinKps` 额外认 `;；`（后端 split_tags
 * 还认 `/ |` 与换行，所以手输的 "A/B" 落库后同样会被后端拆成两个标签，这里不预拆，
 * 免得 TCP/IP 这类带斜杠的专有名词在界面上被切成两段）。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Select } from 'antd'
import { useTranslation } from 'react-i18next'
import apiClient from '../api/client'

export interface KpOption {
  value: string
  label: string
  subject: string
}

let _cache: KpOption[] | null = null
let _inflight: Promise<KpOption[]> | null = null

/** 把课程树摊平成"知识点"下拉项（按课程名区分，同名知识点只留一条，label 带课程名） */
export function flattenKnowledgePoints(courses: any[]): KpOption[] {
  const out: KpOption[] = []
  const seen = new Set<string>()
  const walk = (nodes: any[], courseName: string, subject: string) => {
    for (const node of nodes || []) {
      walk(node?.children || [], courseName, subject)
      for (const kp of node?.knowledge_points || []) {
        const name = String(kp?.name || '').trim()
        if (!name || seen.has(name)) continue
        seen.add(name)
        out.push({ value: name, label: `${name}（${courseName}）`, subject })
      }
    }
  }
  for (const course of courses || []) {
    walk(course?.chapters || [], String(course?.name || ''), String(course?.subject || ''))
  }
  return out
}

/** 拉课程树（模块级缓存 + 并发合并）；拿不到时返回空数组，页面仍可手动输入 */
export function loadKnowledgePoints(): Promise<KpOption[]> {
  if (_cache) return Promise.resolve(_cache)
  if (_inflight) return _inflight
  _inflight = apiClient.get('/api/curriculum/tree')
    .then(({ data }) => {
      _cache = flattenKnowledgePoints(Array.isArray(data) ? data : [])
      return _cache
    })
    .catch(() => [] as KpOption[])
    .finally(() => { _inflight = null })
  return _inflight
}

/** '算法、数据结构,程序；串' → ['算法','数据结构','程序','串']（逗号/顿号/分号都认） */
export function splitKps(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.join('、') : String(v ?? '')
  return raw.split(/[,，、;；]+/).map((x) => x.trim()).filter(Boolean)
}

/** ['算法','数据结构'] → '算法、数据结构'（与题库/课程树同一套分隔符） */
export function joinKps(v: string[] | string): string {
  return splitKps(v).join('、')
}

interface Props {
  value?: string[] | string
  onChange?: (v: string[] | string) => void
  /** 与科目联动过滤（过滤后为空自动退回全部） */
  subject?: string
  /** false = 单选（值为 string），默认多选（值为 string[]） */
  multiple?: boolean
  /**
   * 额外候选（不参与科目过滤，永远可见）。
   * 用途：题库里已存在的标签比课程树更贴合出题实际 —— 组卷向导的
   * 「知识点范围」原本只吃 compose-config/defaults 下发的本学科标签，
   * 换用本控件后把这些标签作为额外候选传进来，两边候选都不丢。
   */
  extraOptions?: (string | KpOption)[]
  allowClear?: boolean
  disabled?: boolean
  placeholder?: string
  style?: React.CSSProperties
  className?: string
}

const KnowledgePointSelect: React.FC<Props> = ({
  value, onChange, subject = '', multiple = true,
  extraOptions,
  allowClear = true, disabled = false, placeholder, style, className,
}) => {
  // 提示语统一由控件给出（common:knowledgePointHint），四处调用点不必各写一份
  const { t } = useTranslation('common')
  const [all, setAll] = useState<KpOption[]>(_cache || [])
  useEffect(() => {
    let alive = true
    loadKnowledgePoints().then((opts) => { if (alive) setAll(opts) })
    return () => { alive = false }
  }, [])

  const options = useMemo(() => {
    const filtered = subject ? all.filter((o) => o.subject === subject) : all
    const base = (filtered.length ? filtered : all).map((o) => ({ value: o.value, label: o.label }))
    const seen = new Set(base.map((o) => o.value))
    const extra = (extraOptions || [])
      .map((x) => (typeof x === 'string' ? { value: x, label: x } : { value: x.value, label: x.label || x.value }))
      .filter((o) => o.value && !seen.has(o.value))
    return [...base, ...extra]
  }, [all, subject, extraOptions])

  const arr = useMemo(() => splitKps(value), [value])

  const handle = (next: unknown) => {
    const cleaned = splitKps(next)
    onChange?.(multiple ? cleaned : (cleaned[cleaned.length - 1] || ''))
  }

  return (
    <Select
      mode="tags"
      allowClear={allowClear}
      showSearch
      optionFilterProp="label"
      disabled={disabled}
      maxTagCount={multiple ? 'responsive' : 1}
      tokenSeparators={[',', '，', '、']}
      placeholder={placeholder ?? t('knowledgePointHint')}
      options={options}
      value={arr}
      onChange={handle}
      style={style}
      className={className}
    />
  )
}

export default KnowledgePointSelect
