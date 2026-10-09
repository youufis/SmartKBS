"""
AI 服务封装：根据是否配置 APPID 自动选择调用模式

- 配置了 APPID → 调用百炼平台智能体应用 (DashScopeApp.call)
- 未配置 APPID → 直接调用大模型 (OpenAI 兼容接口 /chat/completions)
"""
import json
import os
import time
import concurrent.futures
from typing import Any, Optional

from backend.logger import logger
from backend.config import ai_api_base
from backend.model_catalog import DEFAULT_CHAT_MODEL

# AI 读超时统一取系统配置 AI_REQUEST_TIMEOUT（默认 300 秒）：前端各 AI 端点的
# 专属 timeout 不应被后端硬编码的 120/180 秒反向截断，三层（前端/后端/IIS）同向对齐。
def _ai_read_timeout() -> float:
    try:
        from backend.api.config_router import get_config_value
        return max(60.0, float(get_config_value("AI_REQUEST_TIMEOUT", 300)))
    except Exception:
        return 300.0


# ── 接入地址链：专属域名优先，普通域名备用（两者通用，连不上自动换）──
def _host_of(base: str) -> str:
    """日志里只留主机名，一眼看出是哪个域名连不上"""
    try:
        from urllib.parse import urlparse
        return urlparse(base).netloc or base
    except Exception:
        return base


def _base_chain(primary: str) -> list:
    """候选地址链：主用在前，其余按「专属 → 普通」顺序补上（去重）"""
    from backend.config import ai_api_bases, normalize_ai_api_base
    out = []
    try:
        chain = [primary] + list(ai_api_bases())
    except Exception:
        chain = [primary]
    for b in chain:
        try:
            nb = normalize_ai_api_base(b)
        except Exception:
            nb = str(b or "").strip().rstrip("/")
        if nb and nb not in out:
            out.append(nb)
    return out


def _is_connect_error(exc: Exception) -> bool:
    """DNS/连不上这类传输层错误才值得换域名重试；HTTP 4xx/5xx 与读超时不算"""
    if type(exc).__name__ in ("ConnectError", "ConnectTimeout", "ConnectionError"):
        return True
    text = str(exc).lower()
    return ("getaddrinfo" in text or "name or service not known" in text
            or "failed to establish a new connection" in text
            or "connection refused" in text or "nodename nor servname" in text)


def _is_fallback_error(exc: Exception) -> bool:
    """值得换下一个接入地址再试一次的错误：连接层失败 + 读超时（上游卡住不回字节）。

    ⚠️ 读超时换地址重试 = 同一条提示词可能被计费两次，所以只有"预算拆得开"
    （见 _attempt_read_timeout：必须有备用地址且调用方声明了 max_tokens）才会发生。
    """
    return _is_connect_error(exc) or _is_timeout_error(exc)


# ── 超时预算：一次卡死不许拖满整条链路 ──
# 非流式请求在模型写完之前一个字节都不会回，httpx 的 read 计时器没有"续命"机会；
# 实测 qwen3.7-flash 约 50-95 tok/s，取 20 tok/s 当保守下限估生成耗时。
_TOKENS_PER_SECOND = 20.0
_QUEUE_ALLOWANCE_SECONDS = 30.0     # 排队 + TLS 往返
_MIN_ATTEMPT_SECONDS = 60.0


class AiTimeoutError(TimeoutError):
    """连上了网关但它在预算内没返回任何内容（区别于"连不上"和 HTTP 4xx/5xx）。

    继承内置 TimeoutError：老的 `except TimeoutError` 分支照样能接住，不破坏调用方语义。

    httpx 的 ReadTimeout str() 是空串，直接拼进报错会让日志和前端都显示成空白，
    所以超时一律翻译成这个带上下文的类型再往上抛。
    """


def _is_timeout_error(exc: Exception) -> bool:
    if isinstance(exc, (AiTimeoutError, TimeoutError)):
        return True
    if type(exc).__name__ in ("ReadTimeout", "WriteTimeout", "PoolTimeout",
                              "ConnectTimeout", "TimeoutException", "Timeout"):
        return True
    try:
        import httpx
        if isinstance(exc, httpx.TimeoutException):
            return True
    except Exception:
        pass
    try:
        import requests as _rq
        if isinstance(exc, _rq.exceptions.Timeout):
            return True
    except Exception:
        pass
    return False


def ai_error_brief(exc: BaseException, max_len: int = 200) -> str:
    """把异常压成一行给前端/日志用的人话（空消息的超时类异常给出兜底文案）。"""
    text = " ".join(str(exc or "").split())
    if not text:
        text = {
            "ReadTimeout": "读取超时：AI 网关在限定时间内没有返回任何内容",
            "WriteTimeout": "写入超时：请求没能发完",
            "PoolTimeout": "连接池超时：本地并发已占满",
            "ConnectTimeout": "连接超时：连不上 AI 网关",
            "TimeoutException": "超时：AI 网关在限定时间内没有返回任何内容",
            "ConnectError": "无法连接 AI 网关",
        }.get(type(exc).__name__, type(exc).__name__)
    first = text.splitlines()[0] if text.splitlines() else text
    return first if len(first) <= max_len else first[:max_len] + "…"


def _est_generation_seconds(max_tokens) -> float:
    try:
        return _QUEUE_ALLOWANCE_SECONDS + float(max_tokens) / _TOKENS_PER_SECOND
    except (TypeError, ValueError):
        return 0.0


def _attempt_read_timeout(total: float, bases_count: int, max_tokens=None) -> list:
    """把总预算切成「每个接入地址一段」的读超时，允许专属域名卡死时换公共域名重试。

    只在两个条件同时成立时才拆：① 确实有备用地址可换；② 调用方声明了 max_tokens，
    于是这一段的长度是"估得出来的"，不会把正常生成掐死。
    各段之和恰好等于总预算；真正开跑时由 _next_attempt 按截止时间继续扣减，
    整条地址链累计等待永远 ≤ AI_REQUEST_TIMEOUT —— 前端/后端/IIS 三层对齐不破。
    """
    total = float(total or 0)
    if total <= 0:
        total = _ai_read_timeout()
    n = max(1, int(bases_count or 1))
    if n < 2 or not max_tokens:
        return [total]                       # 没备用地址 / 不知道要生成多长：行为同旧，一次跑满
    if total / n < _MIN_ATTEMPT_SECONDS:
        return [total]                       # 预算太短，拆开只会两头都失败
    per = min(total / n, max(_MIN_ATTEMPT_SECONDS, _est_generation_seconds(max_tokens)))
    return [round(per, 1)] * n


def _next_attempt(bases: list, idx: int, segments: list, deadline: float):
    """第 idx 次尝试还能不能做、给多少秒；返回 None 表示地址或预算已用尽。

    预算用 deadline（单调时钟）兜死：前一段吃掉的时间会从后一段里扣掉，
    整条地址链的累计等待永远不超过总预算 —— 前端/后端/IIS 三层对齐才不破。
    """
    if idx < 0 or idx >= len(bases):
        return None
    left = deadline - time.monotonic()
    if idx == 0:
        return max(1.0, min(segments[0], left if left > 0 else segments[0]))
    if left < _MIN_ATTEMPT_SECONDS:
        return None                     # 只剩几十秒，换地址也跑不完一段有意义的读超时
    return min(segments[min(idx, len(segments) - 1)], left)


def _split_timeout(timeout) -> tuple:
    """把 timeout 归一成 (连接秒数, 读取总预算秒数)；支持 float 与 (connect, read) 元组。"""
    if isinstance(timeout, (tuple, list)) and len(timeout) >= 2:
        return float(timeout[0]), float(timeout[1])
    t = float(timeout) if timeout else _ai_read_timeout()
    return min(30.0, t), t


def _timeout_error(exc: Exception, bases: list, segments: list) -> Exception:
    """超时统一换成带上下文的可读异常；其它异常原样返回。"""
    if not _is_timeout_error(exc):
        return exc
    hosts = " → ".join(_host_of(b) for b in bases[:len(segments)])
    budget = "/".join(f"{s:.0f}s" for s in segments)
    return AiTimeoutError(
        f"AI 网关在 {budget}（合计 {sum(segments):.0f}s）内未返回内容，已尝试：{hosts}。"
        f"多为本次输出过长或上游排队，可减少单次题量/关闭配图，或调大系统配置 AI_REQUEST_TIMEOUT"
    )


def _post_model(bases: list, payload: dict, headers: dict, timeout, stream: bool = False):
    """依次在候选地址上 POST，连接失败与读超时都换下一个；返回 (生效地址, 响应)"""
    import requests as sync_requests
    connect, total = _split_timeout(timeout)
    segments = _attempt_read_timeout(total, len(bases), payload.get("max_tokens"))
    deadline = time.monotonic() + total
    last_err = None
    for idx, base in enumerate(bases):
        seg = _next_attempt(bases, idx, segments, deadline)
        if seg is None:
            break
        try:
            resp = sync_requests.post(
                f"{base}/chat/completions", headers=headers, json=payload,
                timeout=(connect, seg), stream=stream,
            )
            if idx:
                logger.warning(f"[AI] 已回落到备用接入地址: {_host_of(base)}（前面地址连接失败或超时未返回）")
            return base, resp
        except Exception as err:
            last_err = err
            if not _is_fallback_error(err):
                raise _timeout_error(err, bases, segments) from err
            nxt = _next_attempt(bases, idx + 1, segments, deadline)
            if nxt is None:
                break
            logger.warning(
                f"[AI] {_host_of(base)} {seg:.0f}s 内未完成（{type(err).__name__}: {ai_error_brief(err)}）"
                f"，换 {_host_of(bases[idx + 1])} 再试 {nxt:.0f}s（这条提示词可能被重复计费一次）"
            )
    if last_err is not None:
        raise _timeout_error(last_err, bases, segments) from last_err
    return bases[-1], None


async def _apost_model(bases: list, client, payload: dict, headers: dict, timeout):
    """_post_model 的异步版（httpx）"""
    import httpx
    connect, total = _split_timeout(timeout)
    segments = _attempt_read_timeout(total, len(bases), payload.get("max_tokens"))
    deadline = time.monotonic() + total
    last_err = None
    for idx, base in enumerate(bases):
        seg = _next_attempt(bases, idx, segments, deadline)
        if seg is None:
            break
        try:
            resp = await client.post(
                f"{base}/chat/completions", headers=headers, json=payload,
                timeout=httpx.Timeout(connect=connect, read=seg,
                                      write=min(120.0, seg), pool=min(30.0, seg)),
            )
            if idx:
                logger.warning(f"[AI] 已回落到备用接入地址: {_host_of(base)}（前面地址连接失败或超时未返回）")
            return base, resp
        except Exception as err:
            last_err = err
            if not _is_fallback_error(err):
                raise _timeout_error(err, bases, segments) from err
            nxt = _next_attempt(bases, idx + 1, segments, deadline)
            if nxt is None:
                break
            logger.warning(
                f"[AI] {_host_of(base)} {seg:.0f}s 内未完成（{type(err).__name__}: {ai_error_brief(err)}）"
                f"，换 {_host_of(bases[idx + 1])} 再试 {nxt:.0f}s（这条提示词可能被重复计费一次）"
            )
    if last_err is not None:
        raise _timeout_error(last_err, bases, segments) from last_err
    return bases[-1], None
# 限制最大 3 个并发 AI 线程，避免长时间等待的 AI 调用阻塞数据库等其他操作
_ai_thread_pool = concurrent.futures.ThreadPoolExecutor(
    max_workers=3,
    thread_name_prefix="ai_call",
)


def get_ai_config(use_agent: bool = True):
    """获取 AI 调用配置

    Args:
        use_agent: 是否优先使用智能体。True=有 APPID 时使用智能体；False=强制直接调大模型
    """
    from backend.api.config_router import get_config_value
    if use_agent:
        # V6.8 知识库接管：检索链路就绪时，原本走 APPID 智能体的全部 AI 业务
        # 统一改走「直连 + 知识库检索」（接管语义与原智能体一致：自带知识库）。
        # KB 未启用/配置不全 → 照旧走智能体；use_agent=False → 永远纯直连。
        try:
            from backend import bailian_kb
            kb_ok, _ = bailian_kb.kb_ready()
        except Exception:
            kb_ok = False
        if kb_ok:
            return {"mode": "kb_direct"}
    app_id = get_config_value("APPID", "")
    # V6.9 智能体启用闸门：填了 APPID 且勾选 AGENT_ENABLED 才算启用；
    # 知识库就绪时已在上方被 kb_direct 接管（优先级：知识库 > 智能体 > 大模型）
    if app_id and use_agent and bool(get_config_value("AGENT_ENABLED", True)):
        return {"mode": "agent", "app_id": app_id}
    return {
        "mode": "direct",
        "model": get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL),
        "api_base": ai_api_base(),
    }


def _hist_messages(history: Optional[list], prompt: str) -> list[dict]:
    """把 [{role, content}] 历史 + 当前提问 归一成 OpenAI messages 数组

    只接受 user/assistant 两种角色（丢弃客户端伪造的 system），空内容跳过，
    最后一条固定是本次提问，保证与模型 API 的角色交替要求一致。
    """
    msgs: list[dict] = []
    for item in (history or []):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "")
        content = str(item.get("content") or "").strip()
        if role in ("user", "assistant") and content:
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": prompt or ""})
    return msgs


def is_appid_configured() -> bool:
    """检查是否配置了 APPID（智能体应用 ID）"""
    from backend.api.config_router import get_config_value
    app_id = get_config_value("APPID", "")
    return bool(app_id)


# ── V6.8 「直连 + 知识库」接管：统一注入点 ──

_KB_INJECT_HEAD = (
    "【知识库参考资料】以下内容检索自教师知识库（标注了文档名与相关度）。"
    "若与当前任务相关，请优先以其为依据作答或创作，并保留任务原有的输出格式要求；"
    "与任务无关时忽略本资料。\n\n"
)


_KB_INJECT_HEAD_LOCAL = (
    "【教学参考资料】以下内容检索自平台题库与课程大纲。"
    "若与当前任务相关，请优先以其为依据作答或创作，并保留任务原有的输出格式要求；"
    "与任务无关时忽略本资料。\n\n"
)


def _kb_query_of(prompt: str, kb_query: str = "") -> str:
    """检索词选取（与任务 prompt 解耦）：显式 kb_query > 短提问原样 > 长模板提关键词。

    备课/组卷/生成HTML 等任务 prompt 动辄上万字符，直接当检索词既超接口限制
    （百炼 query≤4500 字节）又稀释语义——这里保证送进检索的永远是一条干净的查询。
    """
    q = (kb_query or "").strip()
    if q:
        return q[:1200]
    # 未显式给主题时原样下传，由 rag.resolve_search_query 统一收敛（与聊天同一策略）
    return prompt


def _augment_with_kb(prompt: str, kb_query: str = "") -> str:
    """kb_direct 模式：检索知识库并把资料前置到任务 prompt。

    检索失败/无命中时原样返回（等同纯直连），绝不抛异常阻塞业务。
    """
    try:
        from backend.rag import retrieve_knowledge_v2
        context, _refs = retrieve_knowledge_v2(_kb_query_of(prompt, kb_query))
    except Exception as e:
        logger.warning(f"[KB] 接管模式检索失败，退回纯直连: {e}")
        return prompt
    if not context:
        return prompt
    # 注入头按实际来源措辞：云端命中用「知识库资料」头，纯本地兜底用通用头
    head = _KB_INJECT_HEAD if "【知识库参考资料】" in context else _KB_INJECT_HEAD_LOCAL
    return f"{head}{context}\n\n———\n【当前任务】\n{prompt}"


# ── 非流式调用（同步，返回完整文本） ──

def call_ai_sync(prompt: str, api_key: str, history: Optional[list] = None,
                 max_tokens: Optional[int] = None, json_mode: bool = False,
                 use_kb: bool = True, kb_query: str = "") -> str:
    """同步调用 AI，返回完整响应文本（history 仅在直连分支生效）"""
    if not api_key or not api_key.strip():
        raise ValueError("API Key 为空，请在系统配置中设置 API Key")

    cfg = get_ai_config()
    # use_kb=False：数据驱动型任务（推荐/批改/分析等）跳过知识库接管，走纯直连，
    # 并同步关闭思考链——这类任务无需深度推理，开着会把 6 秒的活拖成 60 秒、前端超时。
    if not use_kb:
        cfg = get_ai_config(use_agent=False)
    os.environ["DASHSCOPE_API_KEY"] = api_key

    if cfg["mode"] == "agent":
        return _call_agent_sync(prompt, api_key, cfg["app_id"])
    elif cfg["mode"] == "kb_direct":
        prompt = _augment_with_kb(prompt, kb_query)
        d = get_ai_config(use_agent=False)
        # 接管链路默认关思考链：出题/简答类任务提速数倍（原智能体也无深度思考，行为对齐）
        return _call_model_sync(prompt, api_key, d["model"], d["api_base"], history=history,
                                max_tokens=max_tokens, enable_thinking=False, json_mode=json_mode)
    else:
        return _call_model_sync(prompt, api_key, cfg["model"], cfg["api_base"], history=history,
                                max_tokens=max_tokens, json_mode=json_mode,
                                enable_thinking=False if not use_kb else None)


async def call_ai_sync_with_timeout(prompt: str, api_key: str, timeout: Optional[float] = None,
                                    history: Optional[list] = None,
                                    max_tokens: Optional[int] = None,
                                    json_mode: bool = False,
                                    use_kb: bool = True, kb_query: str = "") -> str:
    """带超时的异步 AI 调用，将同步调用放到专用线程池中执行"""
    import asyncio
    loop = asyncio.get_running_loop()
    if timeout is None:
        timeout = _ai_read_timeout()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(_ai_thread_pool, call_ai_sync, prompt, api_key, history, max_tokens, json_mode, use_kb, kb_query),
            timeout=timeout,
        )
        return result
    except asyncio.TimeoutError:
        logger.error(f"AI 请求超时（{timeout}秒）: prompt={prompt[:200]}")
        raise TimeoutError(f"AI 请求超时（超过{timeout}秒），请稍后重试或简化描述")
    except Exception as e:
        logger.error(f"AI 请求失败: {e}")
        raise


def _call_agent_sync(prompt: str, api_key: str, app_id: str) -> str:
    """调用百炼智能体应用（同步）"""
    from dashscope import Application as DashScopeApp
    try:
        messages = [{"role": "user", "content": prompt}]
        response = DashScopeApp.call(
            app_id=app_id,
            messages=messages,
            stream=False,
            headers={"X-DashScope-OssResourceResolve": "enable"},
        )
        # 尝试多种方式提取响应文本
        text = None
        output = getattr(response, "output", None)
        if output is not None:
            if isinstance(output, str):
                text = output
            elif hasattr(output, "get"):
                text = output.get("text", None) or getattr(output, "text", None)
            else:
                text = getattr(output, "text", None)
        if not text:
            try:
                text = getattr(response, "text", None)
            except (KeyError, AttributeError, TypeError):
                pass
        if not text:
            try:
                if isinstance(response, dict):
                    out = response.get("output", {})
                    if isinstance(out, dict):
                        text = out.get("text", "")
            except (KeyError, TypeError):
                pass
        if text:
            return str(text)
        logger.warning(f"智能体返回为空，降级到直接调模型 (app_id={app_id})")
    except Exception as e:
        logger.warning(f"智能体调用失败 (app_id={app_id}): {e}，降级到直接调模型")

    # 降级：直接调大模型
    from backend.api.config_router import get_config_value
    model = get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL)
    api_base = ai_api_base()
    return _call_model_sync(prompt, api_key, model, api_base)


def _call_model_sync(prompt: str, api_key: str, model: str, api_base: str,
                     enable_thinking: Optional[bool] = None,
                     history: Optional[list] = None,
                     max_tokens: Optional[int] = None,
                     json_mode: bool = False) -> str:
    """直接调用大模型（同步，OpenAI 兼容接口）

    enable_thinking=None 保持现状（由模型默认决定）；传 False 关闭思考链。
    实测（qwen3.7-flash，2026-09-12）：摘要/简报这类无需推理的任务，默认思考会产出
    2257/2388 的隐藏 reasoning tokens，单次调用 24.3s；关掉后 2.6s，正文质量无明显差异。
    """
    import requests as sync_requests
    # 构建消息内容（兼容 content 字符串和数组两种格式）
    content = prompt if prompt else ""
    # 带历史时直接走多轮 messages（一次请求，不做 str/array 双格式轮询）
    messages = _hist_messages(history, content) if history else [{"role": "user", "content": content}]
    fmts = ["hist"] if history else ["str", "array"]
    last_error = None
    payload: dict = {}
    for fmt in fmts:
        t0 = time.monotonic()
        if fmt == "array":
            # 部分 DashScope 模型要求 content 为数组格式
            messages = [{"role": "user", "content": [{"type": "text", "text": content}]}]
        try:
            payload = {
                "model": model,
                "messages": messages,
                "stream": False,
            }
            if max_tokens:
                payload["max_tokens"] = int(max_tokens)
            if enable_thinking is not None and "qwen" in model.lower():
                payload["enable_thinking"] = bool(enable_thinking)
            if json_mode:
                payload["response_format"] = {"type": "json_object"}
            _base, resp = _post_model(
                _base_chain(api_base), payload,
                {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                (30, _ai_read_timeout()),  # 连接30秒；读取对齐 AI_REQUEST_TIMEOUT
            )
            if resp.status_code == 200:
                data = resp.json()
                _ch = (data.get("choices") or [{}])[0]
                content_out = (_ch.get("message") or {}).get("content") or ""
                _u = data.get("usage") or {}
                _finish = _ch.get("finish_reason") or "-"
                logger.info(f"_call_model_sync response: model={model}, len={len(content_out)}, finish={_finish}, "
                            f"prompt_tokens={_u.get('prompt_tokens', '-')}, "
                            f"completion_tokens={_u.get('completion_tokens', '-')}, "
                            f"turns={len(messages)}, head={content_out[:200]}")
                if _finish == "length":
                    logger.warning(
                        "AI 输出被 max_tokens=%s 截断（len=%d）：结果可能不完整，请调大 max_tokens 或缩小单次生成量",
                        payload.get("max_tokens", "默认"), len(content_out),
                    )
                return content_out
            # 400 错误可能是格式问题，尝试下一种格式
            if resp.status_code == 400:
                last_error = resp.text[:300]
                continue
            logger.error(f"大模型调用失败: status={resp.status_code}, {resp.text[:300]}")
            raise Exception(f"AI 调用失败 (HTTP {resp.status_code})")
        except Exception as e:
            logger.error(
                f"大模型调用异常: {ai_error_brief(e)} | model={model} 地址={_host_of(api_base)}"
                f" 等待={time.monotonic() - t0:.1f}s prompt={len(content)}字"
                f" max_tokens={payload.get('max_tokens', '默认(服务商上限)')}"
            )
            raise
    # 两种格式都失败
    raise Exception(f"AI 调用失败: {last_error}")


def call_ai_sync_direct(prompt: str, api_key: str,
                        enable_thinking: Optional[bool] = None,
                        json_mode: bool = False) -> str:
    """强制直接调用大模型（绕过智能体），用于知识闯关等不需要 APPID 的场景

    enable_thinking=False 可关闭思考链 —— 摘要、简报、改写这类无需推理的任务能省 10 倍等待。
    """
    if not api_key or not api_key.strip():
        raise ValueError("API Key 为空，请在系统配置中设置 API Key")

    from backend.api.config_router import get_config_value
    model = get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL)
    api_base = ai_api_base()
    logger.info(f"call_ai_sync_direct: model={model}, prompt_len={len(prompt)}, "
                f"thinking={'默认' if enable_thinking is None else enable_thinking}, "
                f"prompt_head={prompt[:120]}")
    return _call_model_sync(prompt, api_key, model, api_base, enable_thinking=enable_thinking, json_mode=json_mode)


# ── 流式调用（返回事件生成器） ──

def call_ai_stream(prompt: str, api_key: str, session_id: Optional[str] = None,
                   use_agent: bool = True, history: Optional[list] = None,
                   enable_thinking: Optional[bool] = None,
                   use_kb: bool = True, kb_query: str = ""):
    """流式调用 AI，返回 (text_generator, get_session_id)

    Args:
        use_agent: 是否优先使用智能体。True=有 APPID 时使用智能体；False=强制直接调大模型
    """
    cfg = get_ai_config(use_agent=use_agent)
    if not use_kb:
        cfg = get_ai_config(use_agent=False)
    os.environ["DASHSCOPE_API_KEY"] = api_key

    if cfg["mode"] == "agent":
        return _call_agent_stream(prompt, api_key, cfg["app_id"], session_id)
    elif cfg["mode"] == "kb_direct":
        prompt = _augment_with_kb(prompt, kb_query)
        d = get_ai_config(use_agent=False)
        return _call_model_stream(prompt, api_key, d["model"], d["api_base"], history=history,
                                  enable_thinking=False if enable_thinking is None else enable_thinking)
    else:
        return _call_model_stream(prompt, api_key, cfg["model"], cfg["api_base"], history=history,
                                  enable_thinking=False if not use_kb else enable_thinking)


def _call_agent_stream(prompt: str, api_key: str, app_id: str,
                       session_id: Optional[str] = None):
    """调用百炼智能体应用（流式），返回生成器，yield {"text": str, "session_id": str}"""
    from dashscope import Application as DashScopeApp
    messages = [{"role": "user", "content": prompt}]
    call_params = {
        "app_id": app_id,
        "messages": messages,
        "stream": True,
        "incremental_output": True,
        "headers": {"X-DashScope-OssResourceResolve": "enable"},
    }
    if session_id:
        call_params["session_id"] = session_id

    try:
        response = DashScopeApp.call(**call_params)
        new_session_id = session_id
        has_output = False
        accumulated_text = ""
        for chunk in response:
            output = getattr(chunk, "output", None)
            if output:
                sid = getattr(output, "session_id", None)
                if sid:
                    new_session_id = sid
                text = getattr(output, "text", None)
                if text:
                    has_output = True
                    accumulated_text += text
                    yield {"text": accumulated_text, "session_id": new_session_id}
        # 智能体返回空文本时降级
        if not has_output:
            logger.warning(f"智能体流式返回为空，降级到直接调模型 (app_id={app_id})")
            from backend.api.config_router import get_config_value
            model = get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL)
            api_base = ai_api_base()
            for chunk in _call_model_stream(prompt, api_key, model, api_base):
                yield chunk
    except Exception as e:
        logger.error(f"智能体流式调用失败: {e}，降级到直接调模型")
        from backend.api.config_router import get_config_value
        model = get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL)
        api_base = ai_api_base()
        for chunk in _call_model_stream(prompt, api_key, model, api_base):
            yield chunk


def _call_model_stream(prompt: str, api_key: str, model: str, api_base: str,
                       history: Optional[list] = None,
                       enable_thinking: Optional[bool] = None):
    """直接调用大模型（流式，OpenAI 兼容接口），yield {"text": str, "session_id": None}"""
    import requests as sync_requests
    content = prompt if prompt else ""
    # 带历史时直接走多轮 messages；否则先试字符串格式，失败再降级数组格式
    fmts = ["hist"] if history else ["str", "array"]
    for fmt in fmts:
        if fmt == "hist":
            messages = _hist_messages(history, content)
        elif fmt == "str":
            messages = [{"role": "user", "content": content}]
        else:
            messages = [{"role": "user", "content": [{"type": "text", "text": content}]}]
        try:
            payload = {
                "model": model,
                "messages": messages,
                "stream": True,
            }
            if enable_thinking is not None and "qwen" in model.lower():
                # 仅 qwen 系列支持 enable_thinking；其他模型传了会被网关拒 400
                payload["enable_thinking"] = bool(enable_thinking)
            _base, resp = _post_model(
                _base_chain(api_base), payload,
                {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                _ai_read_timeout(), stream=True,
            )
            if resp.status_code == 400 and json_mode:
                logger.warning("AI 网关拒绝 response_format=json_object，降级为普通调用重试")
                return _call_model_sync(prompt, api_key, model, api_base,
                                        enable_thinking=enable_thinking, history=history,
                                        max_tokens=max_tokens, json_mode=False)
            if resp.status_code == 400 and fmt == "str":
                continue  # 尝试数组格式
            if resp.status_code != 200:
                logger.error(f"大模型流式调用失败: status={resp.status_code}")
                yield {"text": f"AI 调用失败 (HTTP {resp.status_code})", "session_id": None}
                return

            accumulated_text = ""
            for line in resp.iter_lines():
                if not line:
                    continue
                decoded = line.decode("utf-8") if isinstance(line, bytes) else line
                if decoded.startswith("data:"):  # type: ignore[arg-type]
                    data_str = decoded[5:].strip()  # type: ignore[union-attr]
                    if data_str == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                        if "choices" in data and data["choices"]:
                            delta = data["choices"][0].get("delta", {})
                            chunk_text = delta.get("content", "")
                            if chunk_text:
                                accumulated_text += chunk_text
                                yield {"text": accumulated_text, "session_id": None}
                    except json.JSONDecodeError:
                        continue
            break  # 成功后跳出格式轮询，避免重复请求
        except Exception as e:
            logger.error(f"大模型流式调用异常: {e}")
            yield {"text": f"网络连接错误：{str(e)}", "session_id": None}


# ── 异步调用（非流式，使用 httpx） ──

async def call_ai_async(prompt: str, api_key: str, history: Optional[list] = None,
                        max_tokens: Optional[int] = None, json_mode: bool = False,
                        use_kb: bool = True, kb_query: str = "") -> str:
    """异步调用 AI，返回完整响应文本（不阻塞工作线程）。

    max_tokens：题目/课件这类长输出必须显式给，否则走服务商默认上限会被静默截断；
    json_mode：要求模型只回 JSON 对象（部分网关不支持，_call_model_async 里会自动降级）。
    """
    if not api_key or not api_key.strip():
        raise ValueError("API Key 为空，请在系统配置中设置 API Key")

    cfg = get_ai_config()
    if not use_kb:
        cfg = get_ai_config(use_agent=False)
    os.environ["DASHSCOPE_API_KEY"] = api_key
    if cfg["mode"] == "agent":
        return await _call_agent_async(prompt, api_key, cfg["app_id"])
    elif cfg["mode"] == "kb_direct":
        import asyncio
        loop = asyncio.get_running_loop()
        prompt = await loop.run_in_executor(_ai_thread_pool, _augment_with_kb, prompt, kb_query)
        d = get_ai_config(use_agent=False)
        return await _call_model_async(prompt, api_key, d["model"], d["api_base"], history=history,
                                       max_tokens=max_tokens, json_mode=json_mode,
                                       enable_thinking=False)
    else:
        return await _call_model_async(prompt, api_key, cfg["model"], cfg["api_base"], history=history,
                                       max_tokens=max_tokens, json_mode=json_mode,
                                       enable_thinking=False if not use_kb else None)


async def _call_agent_async(prompt: str, api_key: str, app_id: str) -> str:
    """调用百炼智能体应用（使用 DashScope SDK，与同步版一致）"""
    import asyncio
    import concurrent.futures

    loop = asyncio.get_event_loop()
    executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        return await loop.run_in_executor(
            executor, _call_agent_sync, prompt, api_key, app_id
        )
    except Exception as e:
        logger.error(f"智能体异步调用失败 (app_id={app_id}): {e}，降级到直接调模型")
        from backend.api.config_router import get_config_value
        model = get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL)
        api_base = ai_api_base()
        return await _call_model_async(prompt, api_key, model, api_base)
    finally:
        executor.shutdown(wait=False)


async def _call_model_async(prompt: str, api_key: str, model: str, api_base: str,
                            history: Optional[list] = None,
                            max_tokens: Optional[int] = None, json_mode: bool = False,
                            enable_thinking: Optional[bool] = None) -> str:
    """异步直接调用大模型（OpenAI 兼容接口）"""
    import httpx

    content = prompt if prompt else ""
    fmts = ["hist"] if history else ["str", "array"]
    last_error = None
    payload: dict = {}
    for fmt in fmts:
        t0 = time.monotonic()
        if fmt == "hist":
            messages = _hist_messages(history, content)
        elif fmt == "str":
            messages = [{"role": "user", "content": content}]
        else:
            messages = [{"role": "user", "content": [{"type": "text", "text": content}]}]
        try:
            payload = {
                "model": model,
                "messages": messages,
                "stream": False,
            }
            if max_tokens:
                payload["max_tokens"] = int(max_tokens)
            if json_mode:
                payload["response_format"] = {"type": "json_object"}
            if enable_thinking is not None and "qwen" in model.lower():
                payload["enable_thinking"] = bool(enable_thinking)
            async with httpx.AsyncClient(timeout=_ai_read_timeout()) as client:
                _base, resp = await _apost_model(
                    _base_chain(api_base), client, payload,
                    {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    _ai_read_timeout(),
                )
                if resp.status_code == 200:
                    data = resp.json()
                    choice = (data.get("choices") or [{}])[0]
                    content_out = (choice.get("message") or {}).get("content") or ""
                    usage = data.get("usage") or {}
                    finish = choice.get("finish_reason") or ""
                    logger.info(
                        "AI 响应: model=%s len=%d finish=%s prompt_tokens=%s completion_tokens=%s head=%r",
                        model, len(content_out), finish or "-",
                        usage.get("prompt_tokens", "-"), usage.get("completion_tokens", "-"),
                        content_out[:160],
                    )
                    if finish == "length":
                        logger.warning(
                            "AI 输出被 max_tokens=%s 截断（len=%d），结果可能不完整：请调大 max_tokens 或减少单次题量",
                            payload.get("max_tokens", "默认"), len(content_out),
                        )
                    return content_out
                # 网关不支持 response_format 时降级重试，避免整条链路因参数被拒
                if resp.status_code == 400 and json_mode:
                    logger.warning("AI 网关拒绝 response_format=json_object，降级为普通模式重试: %s", resp.text[:200])
                    json_mode = False
                    payload.pop("response_format", None)
                    _base, resp = await _apost_model(
                        [_base], client, payload,
                        {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                        _ai_read_timeout(),
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        choice = (data.get("choices") or [{}])[0]
                        content_out = (choice.get("message") or {}).get("content") or ""
                        logger.info("AI 响应(降级后): model=%s len=%d finish=%s head=%r",
                                    model, len(content_out), choice.get("finish_reason") or "-", content_out[:160])
                        return content_out
                if resp.status_code == 400:
                    last_error = resp.text[:300]
                    continue
                logger.error(f"大模型异步调用失败: status={resp.status_code}, {resp.text[:300]}")
                raise Exception(f"AI 调用失败 (HTTP {resp.status_code})")
        except Exception as e:
            logger.error(
                f"大模型异步调用异常: {ai_error_brief(e)} | model={model} 地址={_host_of(api_base)}"
                f" 等待={time.monotonic() - t0:.1f}s prompt={len(content)}字"
                f" max_tokens={payload.get('max_tokens', '默认(服务商上限)')}"
            )
            raise
    raise Exception(f"AI 调用失败: {last_error}")


# ═══════════════════════════════════════════════════════════════
# 多模态调用（图片+文本混合输入，OpenAI 兼容格式）
# ═══════════════════════════════════════════════════════════════


def is_multimodal_model(model_name: str) -> bool:
    """判断是否为多模态模式（由用户在系统配置中手动勾选决定）"""
    try:
        from backend.api.config_router import get_config_value
        return bool(get_config_value("ENABLE_MULTIMODAL", False))
    except Exception:
        return False


def _build_multimodal_content(
    prompt: str,
    image_paths: list[str] | None = None,
) -> list[dict[str, Any]]:
    """构建多模态 messages 的 content 数组（OpenAI 兼容格式）"""
    content = []

    # 添加图片（本地文件 → base64 data URI）
    if image_paths:
        for img_path in image_paths:
            if not img_path or not os.path.exists(img_path):
                continue
            try:
                mime = _get_multimodal_mime(img_path)
                with open(img_path, "rb") as f:
                    import base64
                    b64 = base64.b64encode(f.read()).decode("utf-8")
                content.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"}
                })
            except Exception as e:
                logger.warning(f"图片编码失败 {img_path}: {e}")

    # 添加文本（放在最后）
    content.append({"type": "text", "text": prompt})

    return content


def _get_multimodal_mime(file_path: str) -> str:
    """根据文件扩展名返回 MIME 类型"""
    ext = os.path.splitext(file_path.lower())[1]
    mime_map = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.bmp': 'image/bmp', '.tiff': 'image/tiff',
        '.tif': 'image/tiff', '.webp': 'image/webp',
    }
    return mime_map.get(ext, 'image/jpeg')


def call_multimodal_stream(
    prompt: str,
    api_key: str,
    model: str,
    api_base: str,
    image_paths: list[str] | None = None,
):
    """多模态流式调用（OpenAI 兼容接口），yield {"text": str, "session_id": None}

    支持图片+文本同时输入，适用于带视觉能力的对话模型（见系统配置「模型与端点」）。
    """
    import requests as sync_requests

    content = _build_multimodal_content(prompt, image_paths)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": True,
    }

    try:
        resp = sync_requests.post(
            f"{api_base}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=_ai_read_timeout(),
        )
        if resp.status_code != 200:
            logger.error(f"多模态流式调用失败: status={resp.status_code}, {resp.text[:300]}")
            yield {"text": f"AI 调用失败 (HTTP {resp.status_code})", "session_id": None}
            return

        full_text = ""
        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8") if isinstance(line, bytes) else line
            if decoded.startswith("data:"):  # type: ignore[arg-type]
                data_str = decoded[5:].strip()  # type: ignore[union-attr]
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and data["choices"]:
                        delta = data["choices"][0].get("delta", {})
                        content_piece = delta.get("content", "")
                        if content_piece:
                            full_text += content_piece
                            yield {"text": full_text, "session_id": None}
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        logger.error(f"多模态流式调用异常: {e}")
        yield {"text": f"网络连接错误：{str(e)}", "session_id": None}


def call_multimodal_sync(
    prompt: str,
    api_key: str,
    model: str,
    api_base: str,
    image_paths: list[str] | None = None,
) -> str:
    """多模态同步调用（OpenAI 兼容接口），返回完整文本"""
    import requests as sync_requests

    content = _build_multimodal_content(prompt, image_paths)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "stream": False,
    }

    try:
        resp = sync_requests.post(
            f"{api_base}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=(30, _ai_read_timeout()),
        )
        if resp.status_code == 200:
            data = resp.json()
            return data["choices"][0]["message"]["content"]
        logger.error(f"多模态同步调用失败: status={resp.status_code}, {resp.text[:300]}")
        raise Exception(f"AI 多模态调用失败 (HTTP {resp.status_code})")
    except Exception as e:
        logger.error(f"多模态同步调用异常: {e}")
        raise
