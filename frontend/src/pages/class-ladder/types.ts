import type { LadderRun, LadderResultItem } from '../../api/classLadder'

/** 单关揭晓态 */
export interface LadderReveal { correct: boolean; answer: string; score: number }

/** 生效中的锦囊（服务端下发的三件套） */
export interface LadderLifeline { type: string; name: string; discount: number }

/** 锦囊结果弹窗（远程连线建议 / 投票分布） */
export interface LadderLfModal { type: string; advice?: string; votes?: Record<string, number> }

/** 现场表决：选项 -> 举手人数 */
export type LadderVotePanel = Record<string, number>

/** 本局结算 */
export interface LadderResult { run: LadderRun; detail: LadderResultItem[] }
