import { useCallback, useState } from 'react'
import { getBoard, getLadderRecords } from '../../../api/classLadder'
import type { LadderBoardRow, LadderRun } from '../../../api/classLadder'

/** 本场红榜 + 流水：读取失败不影响闯关；对局中本地实时更新当前玩家分数 */
export function useLadderBoard() {
  const [board, setBoard] = useState<LadderBoardRow[]>([])
  const [records, setRecords] = useState<LadderBoardRow[]>([])

  const refreshBoard = useCallback(async (g: string, c: string) => {
    if (!g || !c) return
    try {
      const [b, r] = await Promise.all([getBoard(g, c, 12), getLadderRecords(g, c, 30)])
      setBoard(b.rows || [])
      setRecords(r.records || [])
    } catch { /* 红榜读不到不影响闯关 */ }
  }, [])

  /** 红榜实时刷新当前玩家分数（后端红榜本就含在途局，id = run_id） */
  const patchBoard = useCallback((r: LadderRun) => {
    setBoard((prev) => prev.map((b) => (b.id === r.run_id
      ? { ...b, ladder_score: r.ladder_score, reached_level: r.reached_level, correct_count: r.correct_count, status: r.status }
      : b)))
  }, [])

  const clearBoard = useCallback(() => { setBoard([]); setRecords([]) }, [])

  return { board, records, refreshBoard, patchBoard, clearBoard }
}
