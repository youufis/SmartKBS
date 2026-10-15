/**
 * 答题草稿（localStorage）—— 同步练习 / 随堂测验共用。
 *
 * 为什么需要：这两个答题页原先只在"提交"时才有数据，刷新、误关、切页 = 全部重做。
 * 考试页（ExamTakePage）早就有一套 localStorage 草稿，但它与考试的服务端
 * draft_answers 强耦合；练习与测验的表没有草稿列，所以这里做一份**纯前端**实现：
 *   1. key 带用户名（同一台电脑多人共用不会串）；
 *   2. 写入带时间戳，读取时可判断新旧；
 *   3. 提交成功后调用方负责 clearDraft，避免"已提交还提示恢复草稿"。
 */
import { useEffect } from 'react'

export interface AnswerDraft<T> {
  answers: T
  ts: number
  /** 作答时的题目数，用于判断草稿是否还适用于当前这场（题量变了就丢弃） */
  total?: number
}

type DraftKind = 'practice' | 'quiz'

export function draftKey(kind: DraftKind, id: number | string, username?: string | null): string {
  const who = username ? `_${username}` : ''
  return `smartkb_${kind}_draft_${id}${who}`
}

export function loadDraft<T>(key: string, expectTotal?: number): AnswerDraft<T> | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const data = JSON.parse(raw) as AnswerDraft<T>
    if (!data || typeof data !== 'object' || data.answers == null) return null
    // 题量对不上（教师改过题）就丢掉，避免恢复出"多余/缺失题号"的脏草稿
    if (typeof expectTotal === 'number' && data.total != null && data.total !== expectTotal) {
      localStorage.removeItem(key)
      return null
    }
    return data
  } catch {
    return null
  }
}

export function saveDraft<T>(key: string, answers: T, total?: number): void {
  try {
    localStorage.setItem(key, JSON.stringify({ answers, ts: Date.now(), total } satisfies AnswerDraft<T>))
  } catch {
    /* 存不下（隐私模式/配额满）就当没有草稿，不影响答题 */
  }
}

export function clearDraft(key: string): void {
  try { localStorage.removeItem(key) } catch { /* 忽略 */ }
}

/** 作答内容变化时防抖落盘（enabled=false 时不写，例如已提交、草稿已被放弃） */
export function useDebouncedDraft<T>(key: string, answers: T, enabled: boolean,
                                     total?: number, delay = 800): void {
  useEffect(() => {
    if (!enabled) return
    const id = window.setTimeout(() => saveDraft(key, answers, total), delay)
    return () => window.clearTimeout(id)
  }, [key, answers, enabled, total, delay])
}

/** 校验草稿里到底答了几题（对象：值为非空字符串才算答了） */
export function countAnswered(answers: Record<string, string | number | boolean | undefined> | null): number {
  if (!answers) return 0
  return Object.values(answers).filter((v) => String(v ?? '').trim() !== '').length
}
