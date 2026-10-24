"""
AI 对话 API 路由 — SSE 流式对话
"""
import asyncio
import json
import os
import time
import re
from typing import Optional, Any, Tuple, Dict

import httpx
from dashscope import Application as DashScopeApp
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel

from backend.config import ai_api_base
from backend.model_catalog import DEFAULT_CHAT_MODEL, DEFAULT_LONG_MODEL, DEFAULT_VL_MODEL
from backend.api.config_router import get_config_value
from backend.api.dependencies import get_current_user
from backend.auth import get_user_role
from backend.utils import (
    encode_image_to_base64,
    path_within,
    get_image_mime_type,
    is_image_file,
    is_document_file,
    check_file_size,
    calculate_file_hash,
    enhance_prompt_with_user_context,
    get_account_chat_history_dir,
    get_admin_chat_history_dir,
    check_user_daily_requests,
)
from backend.logger import logger
from backend.database import execute_query
from backend.prompts import apply_skills
from backend import chat_memory

router = APIRouter()


class ChatRequest(BaseModel):
    prompt: str = ""
    file_paths: list[str] = []
    session_id: Optional[str] = None
    context_enhance: bool = False
    use_agent: bool = False  # False=直连大模型(默认,响应快)；True=优先使用智能体(有APPID时)
    rag_enabled: bool = False  # 「知识」开关：开启后从试题库/课程大纲检索相关知识辅助回答


# ── 附件路径白名单（C2）──

_MAX_PROMPT_CHARS = 20000


def _allowed_file_roots(username: str) -> list[str]:
    """AI 附件允许读取的根目录: 本人临时上传目录 + 本人对话历史目录"""
    roots: list[str] = []
    if not username:
        return roots
    try:
        from backend.api.files_router import TEMP_UPLOAD_DIR
        roots.append(os.path.join(str(TEMP_UPLOAD_DIR), username))
    except Exception as e:
        logger.warning(f"临时上传目录不可用: {e}")
    try:
        roots.append(get_account_chat_history_dir(username))
    except Exception:
        pass
    return [os.path.realpath(r) for r in roots if r]


def _filter_allowed_file_paths(file_paths: list[str], username: str) -> list[str]:
    """C2: 旧实现把客户端传来的任意绝对路径直接 os.path.exists 后读取并喂给模型,
    等于任意文件读取。越界路径直接拒绝(400)而不是静默丢弃, 以免掩盖探测行为。"""
    if not file_paths:
        return []
    roots = _allowed_file_roots(username)
    kept: list[str] = []
    for fp in file_paths:
        if not fp:
            continue
        real = os.path.realpath(str(fp))
        if not any(path_within(root, real) for root in roots):
            logger.warning(f"[AI对话] 拒绝越界附件 user={username} path={str(fp)[:160]}")
            raise HTTPException(status_code=400, detail="附件路径不合法，请重新上传文件后再试")
        kept.append(real)
    return kept


# ── API Key 获取 ──

# ── API Key 缓存 ──
_API_KEY_CACHE: dict[str, tuple[float, str]] = {}  # username -> (timestamp, key)
_API_KEY_CACHE_TTL = 60  # 缓存 60 秒


def get_api_keys(username: str) -> Tuple[str, str]:
    """获取 API Key，带 60 秒缓存

    优先级：
    1. 系统环境变量 DASHSCOPE_API_KEY（最安全，适合生产部署）
    2. system_config.json 中的 dashscope_api_key（管理员在页面配置）

    注意：空 key 不会被缓存，确保环境变量在服务器启动后设置也能被及时拾取。
    """
    now = time.time()
    cached = _API_KEY_CACHE.get(username)
    if cached and (now - cached[0]) < _API_KEY_CACHE_TTL:
        # 缓存命中且非空 → 直接返回
        if cached[1]:
            return cached[1], ""
        # 缓存命中但 key 为空 → 缓存过期，重新读取
        # （避免因启动时序导致空 key 被缓存而阻塞后续请求）

    # 优先从系统环境变量读取（部署时设置，不留文件）
    key = os.environ.get("DASHSCOPE_API_KEY", "")
    # 回退到 system_config.json
    if not key:
        try:
            from backend.api.config_router import load_config
            cfg = load_config()
            key = cfg.get("dashscope_api_key", "")
        except Exception:
            pass

    if not key:
        logger.warning("API Key 未配置：请设置环境变量 DASHSCOPE_API_KEY，或由管理员在系统配置中填写")
    else:
        # 仅在 key 非空时缓存，避免空 key 污染缓存
        _API_KEY_CACHE[username] = (now, key)

    return key, ""


def clear_api_key_cache():
    """清除 API Key 缓存（管理员更新配置后调用，使新 key 即时生效）"""
    _API_KEY_CACHE.clear()


# ── DashScope 文件上传 ──

async def upload_file_to_dashscope(file_path: str, api_key: str) -> str:
    """上传文件到 DashScope 并获取文件 ID"""
    async with httpx.AsyncClient() as client:
        with open(file_path, "rb") as f:
            files = {"file": f, "purpose": (None, "file-extract")}
            resp = await client.post(
                f'{ai_api_base()}/files',
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
            )
        if resp.status_code == 200:
            return resp.json().get("id", "")
        raise Exception(f"文件上传失败: {resp.text}")


# ── 文件摘要缓存 ──

class FileSummaryCache:
    """文件摘要缓存，带过期清理（最多保留 maxsize 条，超过 30 天自动清理）"""
    def __init__(self, maxsize: int = 100, max_age_days: int = 30):
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._maxsize = maxsize
        self._max_age = max_age_days * 86400  # 秒
        self._last_cleanup: float = 0
        self._cleanup_interval = 86400  # 每天检查一次

    def _maybe_cleanup(self):
        """定期清理过期缓存（超过 max_age 的条目）"""
        import time
        now = time.time()
        if now - self._last_cleanup < self._cleanup_interval:
            return
        self._last_cleanup = now
        cutoff = now - self._max_age
        expired = [k for k, v in self._cache.items() if v.get("mtime", 0) < cutoff]
        for k in expired:
            del self._cache[k]
        if expired:
            from backend.logger import logger
            logger.info(f"缓存清理: 移除 {len(expired)} 条过期文件摘要")

    def get(self, file_path: str, api_key: str, session_state: dict[str, Any] | None = None) -> str:
        self._maybe_cleanup()
        abs_path = os.path.abspath(file_path)
        file_hash = calculate_file_hash(abs_path)
        cached = self._cache.get(abs_path)
        if cached and cached.get("hash") == file_hash:
            return cached.get("summary", "")
        # 未命中缓存，生成摘要
        summary = self._generate_summary(abs_path, api_key)
        if summary:
            import time as _time
            self._cache[abs_path] = {"hash": file_hash, "summary": summary, "mtime": _time.time()}
            # 清理溢出
            if len(self._cache) > self._maxsize:
                oldest = min(self._cache.keys(), key=lambda k: self._cache[k]["mtime"])
                del self._cache[oldest]
        return summary

    def _generate_summary(self, abs_path: str, api_key: str) -> str:
        prompt = "请简要总结该文件的主要结论与要点，最多200字。"
        loop = asyncio.new_event_loop()
        try:
            if is_image_file(abs_path):
                result = loop.run_until_complete(self._async_image_summary(abs_path, prompt, api_key))
            elif is_document_file(abs_path):
                result = loop.run_until_complete(self._async_document_summary(abs_path, prompt, api_key))
            else:
                result = ""
            return result[:5000] if result else ""
        finally:
            loop.close()

    async def _async_document_summary(self, file_path: str, prompt: str, api_key: str) -> str:
        try:
            file_id = await upload_file_to_dashscope(file_path, api_key)
            if not file_id:
                return ""
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f'{ai_api_base()}/chat/completions',
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": get_config_value("MODEL_LONG_NAME", DEFAULT_LONG_MODEL),
                        "messages": [
                            {"role": "system", "content": "You are a helpful assistant."},
                            {"role": "system", "content": f"fileid://{file_id}"},
                            {"role": "user", "content": prompt},
                        ],
                        "stream": False,
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data["choices"][0]["message"]["content"]
        except Exception as e:
            logger.warning(f"文件摘要生成失败: {e}")
        return ""

    async def _async_image_summary(self, file_path: str, prompt: str, api_key: str) -> str:
        try:
            encoded = encode_image_to_base64(file_path)
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f'{ai_api_base()}/chat/completions',
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={
                        "model": get_config_value("MODEL_VL_NAME", DEFAULT_VL_MODEL),
                        "messages": [{
                            "role": "user",
                            "content": [
                                {"type": "image_url", "image_url": {"url": f"data:{get_image_mime_type(file_path)};base64,{encoded}"}},
                                {"type": "text", "text": prompt},
                            ]
                        }],
                        "stream": False,
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data["choices"][0]["message"]["content"]
        except Exception as e:
            logger.warning(f"图像摘要生成失败: {e}")
        return ""


file_summary_cache = FileSummaryCache()


# ── 用量查询 ──

@router.get("/usage")
async def get_usage(request: Request):
    """获取当前用户的每日用量信息"""
    # C1: 未登录一律 401(旧实现对匿名请求返回一份"看起来正常"的空用量)
    user = get_current_user(request)
    username = user["username"]
    role_val = user.get("role", 2)

    from backend.utils import get_limit_config, get_user_daily_usage

    enabled, max_req = get_limit_config()
    used = get_user_daily_usage(username)

    # 管理员不受限
    from backend.api.ai_service import is_appid_configured
    appid_configured = is_appid_configured()
    from backend import bailian_kb
    kb_ready_flag, kb_reason = bailian_kb.kb_ready()
    from backend.api.ai_service import get_ai_config
    chat_mode = {"kb_direct": "kb", "agent": "agent"}.get(get_ai_config()["mode"], "llm")

    if role_val == 0:
        multimodal_enabled = get_config_value("ENABLE_MULTIMODAL", False)
        model_name = get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL)
        return {
            "enabled": enabled, "used": 0, "max": 0, "remaining": -1,
            "multimodal_enabled": multimodal_enabled,
            "model_name": model_name,
            "appid_configured": appid_configured,
            "kb_ready": kb_ready_flag, "kb_reason": kb_reason, "chat_mode": chat_mode,
        }

    multimodal_enabled = get_config_value("ENABLE_MULTIMODAL", False)
    model_name = get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL)

    return {
        "enabled": enabled,
        "used": used,
        "max": max_req,
        "remaining": max(0, max_req - used),
        "multimodal_enabled": multimodal_enabled,
        "model_name": model_name,
        "appid_configured": appid_configured,
        "kb_ready": kb_ready_flag, "kb_reason": kb_reason, "chat_mode": chat_mode,
    }


# ── SSE 流式对话 ──

@router.post("/stream")
async def chat_stream(req: ChatRequest, request: Request):
    """SSE 流式对话端点"""
    # C1: 旧实现取 request.state.user, 为 None 时回退 DEFAULT_LOGGED_IN_NAME("root"),
    #     导致未登录访客即可消耗学校 API Key, 并以 root 名义记账/发积分
    user = get_current_user(request)
    username = user["username"]
    role_val = user.get("role", 2)

    if not req.prompt and not req.file_paths:
        raise HTTPException(status_code=400, detail="提示词或文件不能为空")
    if len(req.prompt) > _MAX_PROMPT_CHARS:
        raise HTTPException(status_code=400, detail=f"提问内容过长（限 {_MAX_PROMPT_CHARS} 字）")
    # C2: 附件路径限定在本人上传/历史目录内
    req.file_paths = _filter_allowed_file_paths(req.file_paths, username)

    # AI 对话权限检查（管理员 role=0 始终可用，教师和学生按配置决定）
    if role_val != 0:
        allowed_roles = get_config_value("ENABLE_AI_CHAT_FOR_ROLES", [1, 2])
        if role_val not in allowed_roles:
            role_name = "教师" if role_val == 1 else "学生"
            return StreamingResponse(
                _error_stream(f"AI 对话功能已对{role_name}关闭，请联系管理员开启"),
                media_type="text/event-stream"
            )

    # 请求限流（仅对学生和教师生效）
    allowed, remaining = check_user_daily_requests(username, role_val)
    if not allowed:
        from backend.utils import get_limit_config
        _, max_req = get_limit_config()
        return StreamingResponse(_error_stream(f"今日请求次数已达上限 ({max_req}次)"), media_type="text/event-stream")

    dashscope_api_key, _ = get_api_keys(username)

    # 积分奖励改到生成器里、回答真正产出之后才发（见下方 _award_chat_turn）：
    # 原来这里在校验 API Key 之前就发分，Key 没配、请求被错误流直接挡掉的对话也照拿 2 分，
    # 学生连刷 5 次失败请求就能吃满当日 10 分上限。
    if not dashscope_api_key:
        return StreamingResponse(
            _error_stream("API Key 未配置 | 请管理员在「系统配置」中填写 DashScope API Key，或设置环境变量 DASHSCOPE_API_KEY"),
            media_type="text/event-stream"
        )

    # 用 StreaminingResponse 包装同步生成器（FastAPI 自动在线程池运行）
    return StreamingResponse(
        _chat_event_generator(
            prompt=req.prompt, file_paths=req.file_paths,
            session_id=req.session_id, username=username,
            user_payload=user,
            dashscope_api_key=dashscope_api_key,
            context_enhance=req.context_enhance,
            use_agent=req.use_agent,
            rag_enabled=req.rag_enabled,
            memory_prompt=req.prompt,
            award_chat_title="AI 对话",
        ),
        media_type="text/event-stream",
    )


def _chat_event_generator(
    prompt: str, file_paths: list[str], session_id: Optional[str],
    username: str, user_payload: dict[str, Any] | None,
    dashscope_api_key: str, context_enhance: bool,
    use_agent: bool = True,
    rag_enabled: bool = False,
    memory_prompt: Optional[str] = None,
    scene: str = "chat",
    award_chat_title: str = "",
):
    """SSE 事件生成器（同步）

    memory_prompt: 写进会话记忆的"用户原句"。学伴/助手会把人设与画像拼进 prompt，
    用它传入原始提问，避免把这些前缀反复带进后续轮次上下文。
    """
    def _award_chat_turn() -> None:
        """回答真正产出后才计一次对话分；非学生账号由引擎守卫自动挡掉"""
        if not award_chat_title:
            return
        try:
            import datetime as _dt
            from backend.reward_engine import award_participation
            award_participation(username, "chat",
                                f"{username}_{_dt.datetime.now().strftime('%Y%m%d%H%M%S')}",
                                award_chat_title)
        except Exception as e:
            logger.debug(f"[chat] 对话积分发放失败 {username}: {e}")

    # ── V6.9 全局模式裁决：聊天链路不再接受客户端开关控制，只认系统配置 ──
    # 优先级 知识库(kb_direct) > 智能体(agent) > 大模型(direct)，与后台 19 处业务同源裁决。
    # 客户端传入的 use_agent / rag_enabled 一律忽略（旧版桌面端兼容不报错）。
    from backend.api.ai_service import get_ai_config as _mode_cfg
    _mode = _mode_cfg()["mode"]
    use_agent = (_mode == "agent")
    rag_enabled = (_mode == "kb_direct")

    try:
        # ── V8.6.1 对话分层组稿 ──
        # 只接管 scene=="chat"（知识问答）：身份、回答要求、技能段、参考资料一律进
        # system，用户原话单独成一条 user 消息；学伴/教学助手/白板仍走原有
        # "人设拼进 prompt" 的路径，避免连带改动它们的画像与多轮上下文口径。
        from backend import chat_prompts
        layered = scene == "chat" and bool(get_config_value("CHAT_IDENTITY_GUARD_ENABLED", True))
        meta_reason: Optional[str] = None
        may_retrieve, may_skill = True, True
        system_text = ""
        kb_context = ""
        if layered:
            meta_reason, may_retrieve, may_skill = chat_prompts.decide_turn(
                prompt, bool(get_config_value("CHAT_META_GUARD_ENABLED", True)))
            enhanced_prompt = prompt or ""
        else:
            enhanced_prompt = enhance_prompt_with_user_context(prompt, user_payload)
        valid_file_paths = [fp for fp in file_paths if fp and os.path.exists(fp)]

        # ── V6.7 RAG 增强：由「知识」开关(rag_enabled)控制 ──
        chat_kb_takeover = False  # 知识开关+云端就绪：本次走「直连+知识库」，可关思考链提速
        # 云端知识库就绪时走「直连 + 百炼知识库」：强制直连（不走 APPID 智能体，
        # 避免与其自带云端知识库双重注入），检索切片注入 prompt 并下发 references 事件；
        # 未就绪/失败时退回原本地题库+大纲检索，绝不阻塞对话。
        if rag_enabled:
            try:
                from backend import bailian_kb
                kb_ok, _kb_reason = bailian_kb.kb_ready()
                chat_kb_takeover = bool(kb_ok)
                if kb_ok and use_agent:
                    use_agent = False

                # V8.6.1 检索闸门：「你是谁 / 你好 / 111」这类元问题不查知识库。
                # 百炼对这种问句照样返回 top_k 条过线切片（实测 refs=5、2585 字），
                # 压在 3 个字的提问前面，模型只能围绕教材把身份问题答成讲稿。
                skip_reason = "" if may_retrieve else (
                    f"元问题({meta_reason})" if meta_reason else "过短/无实体词")
                if skip_reason:
                    logger.info(f"[RAG] 跳过知识检索 (user={username}): {skip_reason}")
                else:
                    from backend.rag import retrieve_knowledge, retrieve_knowledge_v2
                    if kb_ok:
                        rag_context, kb_hit_refs = retrieve_knowledge_v2(prompt, username)
                    else:
                        rag_context, kb_hit_refs = retrieve_knowledge(prompt, username), []
                    logger.info(f"[RAG] 知识检索已执行 (user={username}, cloud={'on' if kb_ok else 'off'}, "
                                f"refs={len(kb_hit_refs)}, context_len={len(rag_context or '')})")
                    if kb_hit_refs:
                        yield f"data: {json.dumps({'type': 'references', 'items': kb_hit_refs}, ensure_ascii=False)}\n\n"
                    if rag_context:
                        if layered:
                            # 资料进 system（带使用规则），提问不再被资料淹没
                            kb_context = rag_context
                        else:
                            from backend.prompts import build_ai_role
                            from backend.permission_service import get_teacher_subjects
                            from backend.auth import get_user_role
                            # 教师/管理员：使用其任教学科；学生：使用通用角色
                            user_role = get_user_role(username)
                            teacher_subjects = get_teacher_subjects(username) if user_role in (0, 1) else []
                            ai_role = build_ai_role(subjects=teacher_subjects) if teacher_subjects else build_ai_role()
                            if "【知识库参考资料】" in rag_context:
                                system_role = (f"{ai_role}请优先依据【知识库参考资料】作答，引用资料内容时可注明《文档名》；"
                                               f"资料未覆盖的部分可结合学科常识补充，但不得与资料矛盾；资料与问题无关时忽略资料。")
                                context_block = f"以下是从教师知识库中检索到的资料：\n\n{rag_context}"
                            elif "【相关试题】" in rag_context or "【课程知识点】" in rag_context:
                                system_role = f"{ai_role}请用你的学科知识回答用户的问题。"
                                context_block = f"以下是数据库中检索到的相关教学资源，请参考这些内容回答：\n\n{rag_context}"
                            else:
                                system_role = f"{ai_role}请用你的学科知识回答用户的问题。"
                                context_block = rag_context
                            enhanced_prompt = f"{system_role}\n\n{context_block}\n\n用户问题：{enhanced_prompt}"
            except Exception as e:
                logger.warning(f"RAG 检索失败: {e}")

        # ── 判断是否启用多模态 ──
        multimodal_enabled = get_config_value("ENABLE_MULTIMODAL", False)
        image_files = [fp for fp in valid_file_paths if is_image_file(fp)]
        _summaries_generated = False

        if context_enhance and valid_file_paths:
            summaries = []
            for fp in valid_file_paths:
                s = file_summary_cache.get(fp, dashscope_api_key, user_payload)
                if s:
                    summaries.append(f"文件 {os.path.basename(fp)} 摘要：\n{s.strip()}")
            if summaries:
                enhanced_prompt = ("\n\n".join(summaries) + "\n\n" + enhanced_prompt).strip()
                _summaries_generated = True

        # ── 技能注入 ──
        # 知识问答：技能段作为"工作方式"放进 system，并且元问题一律不注入
        # （「输出质量三阶增强」这类结构化模板正是把"你是谁"写成讲稿的另一半原因）。
        # 其余场景（学伴/教学助手）沿用把技能段前置拼进任务正文的老口径，
        # 但按各自的 scene 取映射：白板 AI 有自己的注入点、不经这里，故不受影响。
        skill_segment = ""
        skill_in_system = False
        if layered:
            # 元问题（may_skill=False）一律不注入：一句"你是谁"不需要质量模板，
            # 注入了反而会被当成答案骨架抄出来。
            if may_skill:
                seg_mode = str(get_config_value("CHAT_SKILL_SEGMENT_MODE", "system") or "system").strip().lower()
                if seg_mode == "system":
                    from backend.prompts import build_skills_segment
                    skill_segment = build_skills_segment("chat")
                    skill_in_system = bool(skill_segment)
                if not skill_in_system:
                    enhanced_prompt = apply_skills(enhanced_prompt, "chat")
        else:
            enhanced_prompt = apply_skills(enhanced_prompt, scene or "chat")

        if layered:
            system_text, user_text = chat_prompts.compose_chat_turn(
                enhanced_prompt,
                username=username, user_payload=user_payload,
                kb_context=kb_context, skill_segment=skill_segment,
                meta_reason=meta_reason,
            )
            # 附件摘要/文件分支仍需要一个"含身份"的单条文本，这里给智能体与
            # 多模态路径准备合并版（它们各自的 messages 结构不支持独立 system）。
            merged_prompt = f"{system_text}\n\n【用户的问题】\n{user_text}"
            if meta_reason:
                skill_state = "跳过(元问题)"
            else:
                skill_state = "system" if skill_in_system else "正文前置(inline)"
            logger.info(f"[对话组稿] user={username} 分层=on meta={meta_reason or '-'} "
                        f"技能段={skill_state} system={len(system_text)}字 user={len(user_text)}字 "
                        f"资料={len(kb_context)}字")
        else:
            user_text = enhanced_prompt
            merged_prompt = enhanced_prompt
            system_text = ""

        # ── 直连模式多轮记忆 ──
        # APPID 留空（或本次强制直连）时，百炼侧没有 session 记忆，这里由平台自己
        # 带上最近若干轮问答；智能体分支不受影响，仍使用百炼返回的 session_id。
        # mem_active 必须同时管住"读"和"写"：管理员关掉开关后，前端可能仍持有
        # 上一阶段拿到的 d_ 会话号，若只按前缀判断就会继续往表里写。
        mem_key, mem_history, mem_active = session_id, None, False
        try:
            from backend.api.ai_service import get_ai_config
            if chat_memory.enabled() and get_ai_config(use_agent=use_agent)["mode"] in ("direct", "kb_direct"):
                mem_key = chat_memory.ensure_session(username, session_id)
                mem_active = True
                hist = chat_memory.get_history(mem_key, username)
                if hist:
                    mem_history = hist
                    logger.info(f"[对话记忆] scene={scene} user={username} 带上 {len(hist)} 条历史")
                    # V8.6.1：同一会话里重复提问，模型会逐字复读上一轮（实测 True）。
                    # 带一条"换个角度"的指令，让第二问有价值而不是复制粘贴。
                    if layered and chat_prompts.is_repeat_question(prompt, hist):
                        system_text = f"{system_text}\n\n{chat_prompts.REPEAT_HINT}"
                        logger.info(f"[对话组稿] user={username} 检测到重复提问，追加换角度指令")
        except Exception as e:
            mem_active = False
            logger.warning(f"[对话记忆] 上下文加载失败，按单轮继续: {e}")

        if multimodal_enabled and image_files:
            model = get_config_value("MODEL_NAME", DEFAULT_CHAT_MODEL)
            api_base = ai_api_base()
            from backend.api.ai_service import call_multimodal_stream

            # 如果摘要已由视觉模型生成文字描述，多模态模型无需再看原图
            image_files_for_mm = [] if _summaries_generated else image_files

            full_text = ""
            _prev = ""
            for chunk in call_multimodal_stream(
                prompt=merged_prompt,
                api_key=dashscope_api_key,
                model=model,
                api_base=api_base,
                image_paths=image_files_for_mm,
            ):
                _full = chunk["text"]
                inc = _full[len(_prev):] if _full.startswith(_prev) else _full
                _prev = _full
                full_text = _full
                if inc:
                    yield f"data: {json.dumps({'type': 'delta', 'content': inc}, ensure_ascii=False)}\n\n"

            # 多模态处理完图片后，继续处理剩余的非图片文件（文档等）
            non_image_files = [fp for fp in valid_file_paths if fp not in image_files]
            if non_image_files:
                _sep = "\n\n"
                for fp in non_image_files:
                    if is_document_file(fp):
                        doc_content = ""
                        _prev2 = ""
                        yield f"data: {json.dumps({'type': 'delta', 'content': _sep}, ensure_ascii=False)}\n\n"
                        for chunk in _agent_chat_document_stream(fp, merged_prompt, dashscope_api_key):
                            doc_content = chunk['text']
                            inc2 = doc_content[len(_prev2):] if doc_content.startswith(_prev2) else doc_content
                            _prev2 = doc_content
                            if inc2:
                                yield f"data: {json.dumps({'type': 'delta', 'content': inc2}, ensure_ascii=False)}\n\n"
                        full_text += _sep + doc_content
                    else:
                        # 本协议对前端是「增量帧」（chatStore/companionStore 会 += 累加），
                        # 这里只能发新增片段，发累计全文会直接导致回复重复叠加。
                        # 协议对前端是「增量帧」（chatStore/companionStore 会 += 累加），
                        # 这里只能发新增片段，发累计全文会直接导致回复重复叠加。
                        err = f'不支持的文件类型: {fp}'
                        yield f"data: {json.dumps({'type': 'delta', 'content': _sep + err}, ensure_ascii=False)}\n\n"
                        full_text += _sep + err

            _award_chat_turn()
            yield f"data: {json.dumps({'type': 'done', 'session_id': session_id or ''})}\n\n"
            return

        if not valid_file_paths:
            _prev = ""
            _final_text = ""
            _finish_status = "ok"
            try:
                for chunk in _agent_chat_stream(user_text, mem_key, dashscope_api_key, username,
                                                use_agent=use_agent, history=mem_history,
                                                # 元问题与知识库接管都关思考链：闲聊不必烧 2000 隐藏 token
                                                enable_thinking=False if (chat_kb_takeover or meta_reason) else None,
                                                system=system_text or None,
                                                max_tokens=_meta_max_tokens(meta_reason)):
                    _full = chunk["text"]
                    # 增量推送：仅发送相对上一帧的新增片段（回退切换等场景下前缀不匹配时整段补发）
                    inc = _full[len(_prev):] if _full.startswith(_prev) else _full
                    _prev = _full
                    _final_text = _full
                    if inc:
                        yield f"data: {json.dumps({'type': 'delta', 'content': inc}, ensure_ascii=False)}\n\n"
                    session_id = chunk.get("session_id") or (mem_key if mem_active else session_id)
            except GeneratorExit:
                _finish_status = "aborted"
                raise
            finally:
                _remember_turn(mem_key if mem_active else None, username,
                               memory_prompt or prompt, _final_text, scene, _finish_status)
            _award_chat_turn()
            yield f"data: {json.dumps({'type': 'done', 'session_id': session_id or ''})}\n\n"
            return

        # 累积所有文件输出仅用于内部记录；对前端必须逐帧发增量（前端 onDelta 是 += 追加）
        combined = ""
        for i, fp in enumerate(valid_file_paths):
            if len(valid_file_paths) > 1:
                header = f'--- 文件 {i+1}/{len(valid_file_paths)} ---\n\n'
                combined += header
                yield f"data: {json.dumps({'type': 'delta', 'content': header}, ensure_ascii=False)}\n\n"
            if is_image_file(fp):
                content = ""
                _prev3 = ""
                for chunk in _agent_chat_image_stream(fp, merged_prompt, dashscope_api_key):
                    _f3 = chunk['text']
                    inc3 = _f3[len(_prev3):] if _f3.startswith(_prev3) else _f3
                    _prev3 = _f3
                    content = _f3
                    if inc3:
                        yield f"data: {json.dumps({'type': 'delta', 'content': inc3}, ensure_ascii=False)}\n\n"
                combined += content
            elif is_document_file(fp):
                content = ""
                _prev3 = ""
                for chunk in _agent_chat_document_stream(fp, merged_prompt, dashscope_api_key):
                    _f3 = chunk['text']
                    inc3 = _f3[len(_prev3):] if _f3.startswith(_prev3) else _f3
                    _prev3 = _f3
                    content = _f3
                    if inc3:
                        yield f"data: {json.dumps({'type': 'delta', 'content': inc3}, ensure_ascii=False)}\n\n"
                combined += content
            else:
                err = f'不支持的文件类型: {fp}'
                combined += err
                yield f"data: {json.dumps({'type': 'delta', 'content': err}, ensure_ascii=False)}\n\n"
        _award_chat_turn()
        yield f"data: {json.dumps({'type': 'done', 'session_id': session_id or ''})}\n\n"

    except Exception as e:
        logger.error(f"对话流式生成失败: {e}")
        yield f"data: {json.dumps({'type': 'error', 'content': f'对话生成失败：{str(e)}'})}\n\n"


# 直连失败时 _call_model_stream 会把错误文案当正文吐出来，这类内容不进记忆
_AI_ERROR_PREFIXES = ("AI 调用失败", "网络连接错误", "图像处理失败", "对话生成失败", "❌")


def _remember_turn(session_id: Optional[str], username: str, user_text: str,
                   ai_text: str, scene: str = "chat", status: str = "ok") -> None:
    """把本轮问答写入会话记忆；报错文本/空内容/非本模块会话一律跳过"""
    if not chat_memory.is_direct_session(session_id):
        return
    try:
        user_text = str(user_text or "").strip()
        ai_text = str(ai_text or "").strip()
        if not user_text or not ai_text:
            return
        if any(ai_text.startswith(p) for p in _AI_ERROR_PREFIXES):
            return
        partial = status == "aborted"
        if partial and len(ai_text) < 40:
            return  # 太短的半截没有引用价值
        chat_memory.append_turn(str(session_id), username, "user", user_text, scene)
        chat_memory.append_turn(str(session_id), username, "assistant", ai_text, scene, partial=partial)
    except Exception as e:
        logger.warning(f"[对话记忆] 落库失败(不影响本次回答): {e}")


def _meta_max_tokens(meta_reason: Optional[str]) -> Optional[int]:
    """元问题（身份/寒暄/低信息量）限制输出长度，避免一句话被扩成教案"""
    if not meta_reason:
        return None
    try:
        return int(get_config_value("CHAT_META_MAX_TOKENS", 600) or 600)
    except (TypeError, ValueError):
        return 600


def _agent_chat_stream(prompt: str, session_id: Optional[str], api_key: str, username: str = "",
                        use_agent: bool = True, history: Optional[list] = None,
                        enable_thinking: Optional[bool] = None,
                        system: Optional[str] = None, max_tokens: Optional[int] = None):
    """AI 流式对话（同步生成器）- 支持智能体/直接调大模型双模式（history 仅直连生效）

    system: V8.6.1 身份/规则段，直连模式走独立 system 角色；智能体模式由
    ai_service 内联到问题前（百炼 Application 的 messages 不收 system）。
    """
    from backend.api.ai_service import call_ai_stream

    try:
        for chunk in call_ai_stream(prompt, api_key, session_id, use_agent=use_agent, history=history,
                                    enable_thinking=enable_thinking,
                                    system=system, max_tokens=max_tokens):
            yield chunk
    except Exception as e:
        logger.error(f"AI chat error: {e}")
        yield {"text": "网络连接错误：请检查您的网络连接或稍后重试！", "session_id": session_id}


def _agent_chat_document_stream(file_path: str, prompt: str, api_key: str):
    """文档问答流式（同步）"""
    import requests as sync_requests
    try:
        # 使用同步 requests 上传文件
        with open(file_path, "rb") as f:
            file_resp = sync_requests.post(
                f'{ai_api_base()}/files',
                headers={"Authorization": f"Bearer {api_key}"},
                files={"file": f, "purpose": (None, "file-extract")},
            )
        if file_resp.status_code != 200:
            yield {"text": "文件上传失败"}
            return
        file_id = file_resp.json().get("id", "")

        payload = {
            "model": get_config_value("MODEL_LONG_NAME", DEFAULT_LONG_MODEL),
            "messages": [
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "system", "content": f"fileid://{file_id}"},
                {"role": "user", "content": prompt},
            ],
            "stream": True,
        }

        resp = sync_requests.post(
            f'{ai_api_base()}/chat/completions',
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=300,
        )
        if resp.status_code != 200:
            yield {"text": "文档处理失败"}
            return

        full_text = ""
        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8") if isinstance(line, bytes) else line
            if decoded.startswith("data:"):  # type: ignore[arg-type]
                data_str = decoded[5:]  # type: ignore[union-attr]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and data["choices"]:
                        delta = data["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            full_text += content
                            yield {"text": full_text}
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        logger.error(f"文档处理失败: {e}")
        yield {"text": f"文档处理失败: {str(e)}"}


def _agent_chat_image_stream(file_path: str, prompt: str, api_key: str):
    """图像理解流式（同步）"""
    import requests as sync_requests
    try:
        encoded_image = encode_image_to_base64(file_path)
        model_name = get_config_value("MODEL_VL_NAME", DEFAULT_VL_MODEL)
        payload = {
            "model": model_name,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{get_image_mime_type(file_path)};base64,{encoded_image}"}},
                    {"type": "text", "text": prompt},
                ]
            }],
            "stream": True,
        }
        resp = sync_requests.post(
            f'{ai_api_base()}/chat/completions',
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            stream=True,
            timeout=300,
        )
        if resp.status_code != 200:
            logger.warning(f"图像API返回非200状态: {resp.status_code} - {resp.text[:300]}")
            yield {"text": "图像处理失败"}
            return

        full_text = ""
        for line in resp.iter_lines():
            if not line:
                continue
            decoded = line.decode("utf-8") if isinstance(line, bytes) else line
            if decoded.startswith("data:"):  # type: ignore[arg-type]
                data_str = decoded[5:]  # type: ignore[union-attr]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    if "choices" in data and data["choices"]:
                        delta = data["choices"][0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            full_text += content
                            yield {"text": full_text}
                except json.JSONDecodeError:
                    continue
    except Exception as e:
        logger.error(f"图像处理失败: {e}")
        yield {"text": f"图像处理失败: {str(e)}"}


async def _error_stream(message: str):
    """错误消息流"""
    yield f"data: {json.dumps({'type': 'error', 'content': message})}\n\n"
    yield f"data: {json.dumps({'type': 'done', 'session_id': ''})}\n\n"


@router.post("/new-topic")
async def new_topic(request: Request):
    """新话题（清空当前会话）

    前端带 session_id 时顺手把该会话的直连记忆立即删掉（不带也不影响：
    记忆最长由 TTL + 后台 prune 兜底清除）。
    """
    sid, username = "", ""
    try:
        body = await request.json()
        sid = str((body or {}).get("session_id") or "")
    except Exception:
        sid = ""
    try:
        username = get_current_user(request)["username"]
    except Exception:
        username = ""
    cleared = chat_memory.reset_session(sid, username) if (sid and username) else 0
    return {"message": "新话题已创建", "session_id": None, "cleared_turns": cleared}
