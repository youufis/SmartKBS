/**
 * AI 运行状态（模型接入 + 知识库选用）—— 教师端统一状态胶囊的唯一数据源。
 *
 * 口径全部来自服务端 /api/config/ai-runtime：它读的是 get_ai_config() 与
 * llm_provider.effective_engine()，与真实调用链同源。前端不排优先级、不猜引擎，
 * 免得又漂一次（历史上 usage.engine 只看 AI_MODE 档位，本地地址没填时仍报 local）。
 */
import apiClient from './client'

export type AiEngine = 'cloud' | 'local' | 'hybrid'
export type AiMode = 'cloud' | 'hybrid' | 'local'
export type KbEffective = 'cloud' | 'local' | 'llm'

export interface AiRuntimeModel {
  /** 配置档位（系统配置 AI_MODE） */
  mode: AiMode
  /** 实际应答者；mode≠cloud 但没填本地地址时会回落成 cloud，并由 config_conflict 标出 */
  engine: AiEngine
  provider: 'dashscope' | 'ollama'
  /** 当前真正会送进请求的对话模型名 */
  active: string
  cloud: { chat: string; long: string; vl: string }
  local: { chat: string; long: string; vl: string; base: string }
  /** 混合档本地应答失败时的兜底模型名（空串表示不适用） */
  hybrid_fallback: string
  config_conflict: boolean
  multimodal: boolean
}

export interface AiRuntimeKb {
  chain: 'kb_direct' | 'kb_local' | 'direct'
  effective: KbEffective
  /** 本地（完全离线）档主动旁路云端检索 —— 设计如此，不是故障 */
  bypassed: boolean
  /** 仅当某一路"已启用但未就绪"把链路压到更低一级时为 true */
  degraded: boolean
  reasons: string[]
  cloud: {
    enabled: boolean
    ready: boolean
    reason: string
    /** 已掩码：aid-32ce…9896 */
    agent_id: string
    endpoint_host: string
    top_k: number
    min_score: number
  }
  local: {
    enabled: boolean
    ready: boolean
    docs: number
    chunks: number
    vec_docs: number
    embed_provider: string
    embed_model: string
    dual_index: boolean
  }
}

export interface AiRuntime {
  version: number
  generated_at: number
  /** full=教师/管理员，masked=学生（只有档位与链路，没有模型名与文档数） */
  detail: 'full' | 'masked'
  model: AiRuntimeModel
  kb: AiRuntimeKb
}

export async function getAiRuntime(): Promise<AiRuntime> {
  const { data } = await apiClient.get<AiRuntime>('/api/config/ai-runtime')
  return data
}
