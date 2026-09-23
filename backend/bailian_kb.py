"""百炼知识库检索（知识检索服务 / Knowledge Studio）

「直连 + 知识库」模式的检索端：调用百炼业务空间的知识检索接口拿切片，
由 backend/rag.py 融合成本地资料上下文后注入 prompt，生成仍走直连大模型通道。

配置（system_config.json，config_router 有校验）：
- KB_ENABLED     总开关。关闭时聊天页「知识」勾选只走本地题库/大纲检索
- KB_API_BASE    业务空间专属域名，如 https://llm-xxx.cn-beijing.maas.aliyuncs.com
                 （必须与 dashscope_api_key 属同一业务空间；也可填完整检索 URL）
- KB_AGENT_ID    知识检索服务 ID（aid-xxx，控制台"知识服务→知识检索"发布后获得）
- KB_TOP_K       召回切片数（1~20）
- KB_MIN_SCORE   相关度阈值（0.01~1.00），低分切片丢弃
- KB_TIMEOUT_MS  检索超时（毫秒）。超时/失败静默降级，绝不阻塞对话

接口文档：https://help.aliyun.com/zh/model-studio/knowledgesearch
"""
from typing import Any, Optional

from backend.logger import logger

_SEARCH_PATH = "/api/v1/indices/knowledge/search"


def _get_cfg() -> dict[str, Any]:
    from backend.api.config_router import get_config_value
    return {
        "enabled": bool(get_config_value("KB_ENABLED", False)),
        "base": str(get_config_value("KB_API_BASE", "") or "").strip().rstrip("/"),
        "agent_id": str(get_config_value("KB_AGENT_ID", "") or "").strip(),
        "top_k": int(get_config_value("KB_TOP_K", 5) or 5),
        "min_score": float(get_config_value("KB_MIN_SCORE", 0.5) or 0.5),
        "timeout_ms": int(get_config_value("KB_TIMEOUT_MS", 5000) or 5000),
    }


def resolve_api_key() -> str:
    """与对话链路一致的 Key 解析：环境变量优先，回退系统配置"""
    import os
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        try:
            from backend.api.config_router import load_config
            key = load_config().get("dashscope_api_key", "")
        except Exception:
            pass
    return key


def _search_url(base: str) -> str:
    """宽容三种填法：裸域名 / 带 /compatible-mode/v1 后缀 / 完整检索 URL"""
    if base.endswith(_SEARCH_PATH):
        return base
    for suffix in ("/compatible-mode/v1", "/api/v1"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base + _SEARCH_PATH


def kb_ready() -> tuple[bool, str]:
    """知识库链路是否就绪。返回 (ready, 未就绪原因)——原因供前端 tooltip 直接展示"""
    cfg = _get_cfg()
    if not cfg["enabled"]:
        return False, "系统配置未启用知识库"
    if not cfg["base"]:
        return False, "未填写业务空间专属域名"
    if not cfg["agent_id"]:
        return False, "未填写知识检索服务 ID"
    if not cfg["agent_id"].startswith("aid-"):
        return False, "检索服务 ID 格式应为 aid- 开头"
    if not cfg["base"].startswith("https://"):
        return False, "专属域名应为 https:// 开头"
    return True, ""


def kb_search(query: str, api_key: Optional[str] = None) -> list[dict[str, Any]]:
    """检索百炼知识库。返回 [{text, score, doc_name, title}]；任何异常返回空列表（调用方降级）"""
    cfg = _get_cfg()
    if not cfg["enabled"]:
        return []
    key = api_key or resolve_api_key()
    if not key or not cfg["base"] or not cfg["agent_id"]:
        return []
    import httpx
    try:
        resp = httpx.post(
            _search_url(cfg["base"]),
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"agent_id": cfg["agent_id"], "query": query},
            timeout=cfg["timeout_ms"] / 1000.0,
        )
        data = resp.json() if resp.status_code == 200 else {}
        if not data.get("success"):
            logger.warning(
                f"[KB] 检索失败 http={resp.status_code} code={data.get('code')} "
                f"msg={data.get('message')} req={data.get('request_id')}"
            )
            return []
        nodes = (data.get("data") or {}).get("nodes") or []
        chunks: list[dict[str, Any]] = []
        for n in nodes[: cfg["top_k"]]:
            score = float(n.get("score") or 0.0)
            if score < cfg["min_score"]:
                continue
            meta = n.get("metadata") or {}
            text = str(n.get("text") or meta.get("content") or "").strip()
            if not text:
                continue
            chunks.append({
                "text": text,
                "score": round(score, 3),
                "doc_name": str(meta.get("doc_name") or "知识库文档"),
                "title": str(meta.get("hier_title") or meta.get("title") or ""),
            })
        logger.info(f"[KB] 检索命中 {len(chunks)}/{len(nodes)} 条 "
                    f"(query={query[:40]}…, min_score={cfg['min_score']})")
        return chunks
    except httpx.TimeoutException:
        logger.warning(f"[KB] 检索超时（{cfg['timeout_ms']}ms），降级本地检索")
        return []
    except Exception as e:
        logger.warning(f"[KB] 检索异常，降级本地检索: {e}")
        return []


def test_kb(query: str = "技术的价值") -> dict[str, Any]:
    """配置页「测试检索」按钮：返回连通性自检结果（不抛异常）"""
    ready, reason = kb_ready()
    if not ready:
        return {"ok": False, "error": reason}
    if not resolve_api_key():
        return {"ok": False, "error": "API Key 未配置（环境变量与系统配置均为空）"}
    import time
    t0 = time.time()
    chunks = kb_search(query)
    cost = int((time.time() - t0) * 1000)
    if not chunks:
        return {"ok": False, "error": "检索无结果：请核对专属域名/检索服务 ID 与 API Key 是否同属一个业务空间，"
                                       "以及知识库中是否有相关内容（详见后端日志 [KB]）"}
    return {
        "ok": True,
        "total": len(chunks),
        "cost_ms": cost,
        "sample": [{"doc_name": c["doc_name"], "score": c["score"]} for c in chunks[:3]],
    }
