# -*- coding: utf-8 -*-
"""AI 讲演 API：知识点 → 分页大纲 → 逐句音频 → 播放数据。

设计见 docs/ai-lessoncast/00-方案建议.md。全部接口挂在 /api/curriculum/lesson-cast 下，
与课程大纲模块同前缀家族，但独立文件以免继续撑大 curriculum_router.py（已 5000+ 行）。

路由顺序有讲究：`/meta` 必须注册在 `/{kp_id}` 之前，否则 "meta" 会被当成 int 解析并 422。
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from backend import lesson_cast_service as L
from backend.ai_task_manager import task_manager
from backend.api.ai_service import call_ai_async
from backend.api.chat_router import get_api_keys
from backend.api.dependencies import get_current_user
from backend.database import (
    execute_insert_update,
    execute_query_dict as execute_query,
    execute_query_one,
)
from backend.logger import logger

router = APIRouter()

#: 完成判定阈值：看完 80% 的页即视为学完（与方案一致）
DONE_RATIO = 0.8
#: 断点上报的最小间隔（秒），前端也会节流，这里兜底
PLAYBACK_MIN_GAP = 3


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _can_manage(user: dict[str, Any]) -> bool:
    return user.get("role", 2) in (0, 1)


def _kp_of(kp_id: int) -> dict[str, Any]:
    """取讲演要用的知识点信息（含课程/章节 id，供落库时冗余）。"""
    row = execute_query_one(
        """SELECT kp.id, kp.name, kp.description, kp.learning_objectives,
                  kp.chapter_id, c.course_id, c.name AS chapter_name,
                  co.name AS course_name, co.grade AS course_grade
           FROM knowledge_points kp
           JOIN chapters c ON c.id = kp.chapter_id
           JOIN courses co ON co.id = c.course_id
           WHERE kp.id = ?""",
        (kp_id,),
    )
    if not row:
        raise HTTPException(status_code=404, detail="知识点不存在")
    return row


def _cast_of(cast_id: int) -> dict[str, Any]:
    row = execute_query_one("SELECT * FROM lesson_casts WHERE id = ?", (cast_id,))
    if not row:
        raise HTTPException(status_code=404, detail="讲演不存在")
    return row


def _voice_brief(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "voice": entry.get("voice") or "",
        "name": entry.get("name") or "",
        "label": entry.get("label") or "",
        "gender": entry.get("gender") or "",
    }


def _safe_voices(mode: str) -> dict[str, Any]:
    """音色解析不应成为接口的失败点：TTS 关闭或目录异常时给空音色，让前端仍能渲染弹窗。"""
    try:
        return L.voices_for_mode(mode)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[cast] 音色解析失败（降级为空）: {e}")
        return {"A": {"voice": "", "name": "", "label": "", "gender": ""},
                "B": {"voice": "", "name": "", "label": "", "gender": ""}}


def _cast_payload(row: dict[str, Any], *, with_audio: bool = True) -> dict[str, Any]:
    """把库里的一行转成前端要的形状。pages 里已挂好 audio 段。"""
    try:
        pages = json.loads(row.get("pages_json") or "[]")
    except (ValueError, TypeError):
        pages = []
    try:
        segments = json.loads(row.get("segments_json") or "[]")
    except (ValueError, TypeError):
        segments = []

    if with_audio and segments:
        pages = L.audio_pages(pages, segments)
    else:
        # 没有音频时也要有 audio 字段，前端才能统一按 pages[].audio 判断
        pages = [{**{k: v for k, v in p.items() if k != "lines"},
                  "lines": p.get("lines") or [], "audio": []} for p in pages]

    return {
        "id": row["id"],
        "kp_id": row["kp_id"],
        "speaker_mode": row.get("speaker_mode") or "duo",
        "title": row.get("title") or "",
        "summary": row.get("summary") or "",
        "name_a": row.get("name_a") or "主讲",
        "name_b": row.get("name_b") or "",
        "voice_a": row.get("voice_a") or "",
        "voice_b": row.get("voice_b") or "",
        "minutes": int(row.get("minutes") or 5),
        "total_seconds": float(row.get("total_seconds") or 0),
        "status": row.get("status") or "draft",
        "version": int(row.get("version") or 1),
        "stale": bool(row.get("audio_hash")) and row.get("audio_hash") != row.get("plan_hash"),
        "pages": pages,
        "updated_at": row.get("updated_at") or "",
    }


# ══════════════════════════ 元信息 ══════════════════════════


@router.get("/meta", summary="AI 讲演元信息（总闸 / 档位 / 风格 / 音色）")
async def lesson_cast_meta(request: Request, kp_id: int | None = Query(None)):
    user = get_current_user(request)
    mode = "duo"
    voices = _safe_voices(mode)

    payload: dict[str, Any] = {
        "tts_enabled": L.tts_available(),
        "duration_options": L.duration_options(),
        "default_minutes": L.default_minutes(),
        "max_seconds": L.max_seconds(),
        "max_pages": L.max_pages(),
        "speaker_modes": ["single", "duo"],
        "voices": {"A": _voice_brief(voices["A"]),
                   "B": _voice_brief(voices.get("B") or voices["A"])},
        "can_manage": _can_manage(user),
        "has_cast": {},
    }
    if kp_id:
        rows = execute_query(
            "SELECT id, speaker_mode, status FROM lesson_casts WHERE kp_id = ?", (kp_id,))
        # 给 id 而不只是状态：前端据此直接打开"编辑已有讲演"，不用再查一次
        payload["has_cast"] = {
            r["speaker_mode"]: {"id": r["id"], "status": r["status"]} for r in rows
        }
    return payload


@router.get("/batch", summary="批量查询哪些知识点已有讲演（课程页行内播放按钮用）")
async def batch_has_cast(request: Request, kp_ids: str = Query("")):
    """一次问清楚一屏知识点的状态，避免前端为每个知识点打一个请求。

    学生只应看到已发布的；教师能看到草稿（他知道那是自己没做完的）。
    """
    user = get_current_user(request)
    ids: list[int] = []
    for part in (kp_ids or "").split(","):
        part = part.strip()
        if part.isdigit():
            v = int(part)
            if v > 0 and v not in ids:
                ids.append(v)
    if not ids:
        return {"items": {}}
    ids = ids[:300]  # 一屏不可能有 300 个知识点，多了就是误用

    where = "" if _can_manage(user) else " AND status = 'published'"
    placeholders = ",".join("?" for _ in ids)
    rows = execute_query(
        f"""SELECT id, kp_id, speaker_mode, status, minutes, total_seconds
            FROM lesson_casts WHERE kp_id IN ({placeholders}){where}""",
        tuple(ids),
    )
    items: dict[str, dict[str, Any]] = {}
    for r in rows:
        items.setdefault(str(r["kp_id"]), {})[r["speaker_mode"]] = {
            "id": r["id"],
            "status": r["status"],
            "minutes": int(r.get("minutes") or 5),
            "total_seconds": float(r.get("total_seconds") or 0),
        }
    return {"items": items}


# ══════════════════════════ 大纲 ══════════════════════════


class OutlineIn(BaseModel):
    minutes: int | None = None
    speaker_mode: str = "duo"
    description: str = ""
    voice_a: str = ""
    voice_b: str = ""


@router.post("/{kp_id}/outline", summary="生成讲演大纲（只出文字，不合成音频）")
async def create_outline(kp_id: int, body: OutlineIn, request: Request):
    """两步式的第一步。

    描述与学习目标都为空时返回 409 need_description —— 只凭名称生成 5 分钟讲稿，
    模型会自由发挥，画面看着完整但内容可能不是老师要讲的。补一句就够，不必写学习目标。
    """
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用")

    kp = _kp_of(kp_id)
    mode = L.normalize_mode(body.speaker_mode)
    minutes = L.normalize_minutes(body.minutes)

    desc = str(kp.get("description") or "").strip()
    objectives = str(kp.get("learning_objectives") or "").strip()
    given = str(body.description or "").strip()

    if not desc and not objectives and not given:
        raise HTTPException(status_code=409, detail={
            "code": "need_description",
            "message": "请先用一句话说明这个知识点讲什么",
            "kp_name": kp.get("name") or "",
        })

    # 老师补的描述写回知识点：课件/播客/教案三个功能都读这个字段，补一次全线受益
    if given and not desc:
        try:
            execute_insert_update(
                "UPDATE knowledge_points SET description = ?, updated_at = ? WHERE id = ?",
                (given[:500], _now(), kp_id),
            )
            kp["description"] = given[:500]
            logger.info(f"[cast] 回写知识点描述 kp={kp_id} user={user['username']}")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[cast] 描述回写失败（不影响生成）: {e}")

    keys = get_api_keys(user["username"])
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    voices = _safe_voices(mode)
    target_chars = L.target_chars(minutes, mode)
    target_pages = L.plan_pages(minutes)

    prompt = L.render_prompt(
        course_name=kp.get("course_name") or "",
        chapter_name=kp.get("chapter_name") or "",
        kp_name=kp.get("name") or "",
        kp_description=kp.get("description") or "",
        learning_objectives=kp.get("learning_objectives") or "",
        grade_hint=kp.get("course_grade") or "",
        target_minutes=minutes,
        target_chars=target_chars,
        target_pages=target_pages,
        speaker_mode=mode,
        voice_a_desc=podcast_voice_desc(voices["A"]),
        voice_b_desc=podcast_voice_desc(voices.get("B") or voices["A"]),
    )

    logger.info(f"[cast] 出大纲 kp={kp_id} mode={mode} {minutes}min/{target_pages} 页 "
                f"user={user['username']}")
    try:
        raw = await call_ai_async(
            prompt, api_key, json_mode=True,
            max_tokens=L.script_max_tokens(minutes),
            kb_query=f"{kp.get('course_name') or ''} {kp.get('name') or ''}",
        )
        script = L.parse_cast(raw, mode)
    except L.CastError as e:
        logger.warning(f"[cast] 大纲生成失败 kp={kp_id}: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        logger.error(f"[cast] 大纲生成异常 kp={kp_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"大纲生成失败: {str(e)[:160]}")

    v_a = str(body.voice_a or voices["A"]["voice"])
    v_b = "" if mode == "single" else str(body.voice_b or (voices.get("B") or {}).get("voice") or "")
    plan = L.plan_hash(script["pages"], v_a, v_b)

    cast_id = _upsert_outline(kp, script, mode, minutes, v_a, v_b, plan, user["username"])

    logger.info(f"[cast] 大纲完成 cast={cast_id} {len(script['pages'])} 页 "
                f"{len(script['pages']) and sum(len(p['lines']) for p in script['pages'])} 句")
    return {
        "cast_id": cast_id,
        "kp_id": kp_id,
        "kp_name": kp.get("name") or "",
        "speaker_mode": mode,
        "minutes": minutes,
        "title": script["title"],
        "summary": script["summary"],
        "name_a": script["name_a"],
        "name_b": script["name_b"],
        "pages": script["pages"],
        "key_points": script["key_points"],
        "plan_hash": plan,
        "target_chars": target_chars,
        "target_pages": target_pages,
        "voices": {"A": _voice_brief(voices["A"]),
                   "B": _voice_brief(voices.get("B") or voices["A"])},
    }


def podcast_voice_desc(entry: dict[str, Any]) -> str:
    """拼一句音色描述给提示词用（如"男声·知识讲解（龙辉焱杏）"）。"""
    gender = entry.get("gender") or ""
    style = str(entry.get("style") or "")
    name = entry.get("name") or entry.get("voice") or ""
    bits = "".join(x for x in (gender, style) if x)
    return f"{bits}（{name}）" if bits else str(name)


def _upsert_outline(kp: dict[str, Any], script: dict[str, Any], mode: str, minutes: int,
                    voice_a: str, voice_b: str, plan: str, username: str) -> int:
    """同一知识点每种风格最多一版：已有就覆盖并 version+1，不堆历史。"""
    now = _now()
    pages_json = json.dumps(script["pages"], ensure_ascii=False)
    existing = execute_query_one(
        "SELECT id FROM lesson_casts WHERE kp_id = ? AND speaker_mode = ?", (kp["id"], mode))
    if existing:
        execute_insert_update(
            """UPDATE lesson_casts
               SET version = version + 1, status = 'draft', title = ?, summary = ?,
                   name_a = ?, name_b = ?, voice_a = ?, voice_b = ?, minutes = ?,
                   pages_json = ?, plan_hash = ?, segments_json = '[]',
                   total_seconds = 0, audio_hash = '', updated_at = ?
               WHERE id = ?""",
            (script["title"], script["summary"], script["name_a"], script["name_b"],
             voice_a, voice_b, minutes, pages_json, plan, now, existing["id"]),
        )
        return int(existing["id"])

    return int(execute_insert_update(
        """INSERT INTO lesson_casts
           (kp_id, course_id, chapter_id, version, status, speaker_mode, title, summary,
            name_a, name_b, voice_a, voice_b, minutes, pages_json, segments_json,
            total_seconds, plan_hash, audio_hash, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, '', ?, ?, ?)""",
        (kp["id"], kp.get("course_id"), kp.get("chapter_id"), mode, script["title"],
         script["summary"], script["name_a"], script["name_b"], voice_a, voice_b, minutes,
         pages_json, plan, username, now, now),
    ))


@router.get("/{cast_id}/outline", summary="取讲演大纲（编辑弹窗用）")
async def get_outline(cast_id: int, request: Request):
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用")
    row = _cast_of(cast_id)
    try:
        pages = json.loads(row.get("pages_json") or "[]")
    except (ValueError, TypeError):
        pages = []
    return {
        "cast_id": row["id"],
        "kp_id": row["kp_id"],
        "speaker_mode": row.get("speaker_mode") or "duo",
        "minutes": int(row.get("minutes") or 5),
        "title": row.get("title") or "",
        "summary": row.get("summary") or "",
        "name_a": row.get("name_a") or "",
        "name_b": row.get("name_b") or "",
        "pages": pages,
        "status": row.get("status") or "draft",
        "stale": bool(row.get("audio_hash")) and row.get("audio_hash") != row.get("plan_hash"),
    }


class OutlineSaveIn(BaseModel):
    pages: list[dict[str, Any]]
    title: str = ""
    summary: str = ""


@router.put("/{cast_id}/outline", summary="保存老师改过的大纲（不合成音频）")
async def save_outline(cast_id: int, body: OutlineSaveIn, request: Request):
    """只存文字，**不撤下已发布的内容**。

    微调大纲时若把 status 退回 draft，已发布的那一版会从学生端消失 —— 老师改一句、
    学生就打不开，这是不可接受的。所以这里保留原状态，靠 `plan_hash != audio_hash`
    生成的 stale 标记驱动"内容已更新，需重新生成音频"的提示；发布会因指纹不一致被拒。

    **不允许改 speaker_mode**（结构不同，应新建一版）。
    """
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用")
    row = _cast_of(cast_id)

    pages = [p for p in body.pages if isinstance(p, dict) and p.get("lines")]
    if not pages:
        raise HTTPException(status_code=400, detail="大纲里没有可用页面")
    if len(pages) > L.max_pages():
        raise HTTPException(status_code=400, detail=f"页数超过上限 {L.max_pages()}")

    plan = L.plan_hash(pages, row.get("voice_a") or "", row.get("voice_b") or "")
    now = _now()
    execute_insert_update(
        """UPDATE lesson_casts SET pages_json = ?, plan_hash = ?, title = ?, summary = ?,
                status = CASE WHEN audio_hash = '' OR audio_hash IS NULL THEN 'draft' ELSE status END,
                updated_at = ? WHERE id = ?""",
        (json.dumps(pages, ensure_ascii=False), plan,
         (body.title or row.get("title") or "")[:40],
         (body.summary or row.get("summary") or "")[:200], now, cast_id),
    )
    return {"cast_id": cast_id, "plan_hash": plan, "pages": len(pages),
            "need_audio": plan != (row.get("audio_hash") or "")}


# ══════════════════════════ 音频合成 ══════════════════════════


@router.post("/{cast_id}/audio", summary="按大纲合成音频（异步任务）")
async def synthesize_audio(cast_id: int, request: Request):
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用")

    row = _cast_of(cast_id)
    if not L.tts_available():
        raise HTTPException(status_code=409, detail=L.disabled_detail())

    try:
        pages = json.loads(row.get("pages_json") or "[]")
    except (ValueError, TypeError):
        pages = []
    if not pages:
        raise HTTPException(status_code=400, detail="还没有大纲，请先生成大纲")

    mode = L.normalize_mode(row.get("speaker_mode"))
    voices = L.voices_for_mode(mode)
    plan = L.plan_hash(pages, row.get("voice_a") or "", row.get("voice_b") or "")

    # 大纲没变且已有音频：不重复合成（保护钱包，也让"再点一次"成为幂等操作）
    if row.get("status") in ("audio_ready", "published") and row.get("audio_hash") == plan:
        return {"task_id": "", "message": "音频已是最新，无需重新合成",
                "reused": True, "cast_id": cast_id, "seconds": float(row.get("total_seconds") or 0)}

    async def _job() -> dict[str, Any]:
        try:
            segments = await L.synthesize_segments(pages, voices)
            kept_pages, kept_segments, truncated = L.truncate_by_pages(
                pages, segments, L.max_seconds())
            total = L.total_of(kept_segments)
            # 截断后大纲实际变短：三个指纹必须一起用「截断后」的页重算，否则永远显示"音频过期"
            final_plan = L.plan_hash(kept_pages, row.get("voice_a") or "", row.get("voice_b") or "")
            execute_insert_update(
                """UPDATE lesson_casts SET pages_json = ?, segments_json = ?,
                        total_seconds = ?, plan_hash = ?, audio_hash = ?,
                        status = 'audio_ready', updated_at = ? WHERE id = ?""",
                (json.dumps(kept_pages, ensure_ascii=False),
                 json.dumps(kept_segments, ensure_ascii=False),
                 total, final_plan, final_plan, _now(), cast_id),
            )
            L.log_summary(f"cast={cast_id} 合成完成", kept_pages, kept_segments)
            return {
                "cast_id": cast_id,
                "pages": len(kept_pages),
                "segments": len(kept_segments),
                "seconds": total,
                "truncated": truncated,
                "cached": sum(1 for s in kept_segments if s.get("cached")),
            }
        except L.CastDisabled as e:
            logger.warning(f"[cast] 总闸关闭，合成中止 cast={cast_id}: {e}")
            return {"error": str(e)}
        except L.CastError as e:
            logger.warning(f"[cast] 合成失败 cast={cast_id}: {e}")
            return {"error": str(e)}
        except Exception as e:  # noqa: BLE001
            logger.error(f"[cast] 合成异常 cast={cast_id}: {e}", exc_info=True)
            return {"error": f"音频合成失败: {str(e)[:160]}"}

    task_id = await task_manager.create_task(
        description="AI 讲演音频合成", coro_factory=_job,
        dedupe_key=f"cast_audio:{cast_id}:{plan}",
    )
    return {"task_id": task_id, "message": "音频合成已开始，请稍候...", "cast_id": cast_id,
            "segments_hint": len(L.flatten_lines(pages))}


class PageRegenIn(BaseModel):
    lines: list[dict[str, str]] | None = None


def _other_pages_unchanged(pages: list[dict[str, Any]], segments: list[dict[str, Any]],
                           skip: int) -> bool:
    """除目标页外，其余页的台词是否与已合成的一致。

    单页重合成后会把这节标成"音频最新"，前提必须是"只有这一页变了"。
    不校验的话，老师同时改了两页、只点其中一页重合成，另一页会继续播旧音频却显示为最新。
    """
    old_by_page: dict[int, list[str]] = {}
    for s in segments:
        old_by_page.setdefault(int(s.get("page") or 0), []).append(str(s.get("text") or ""))
    for i, page in enumerate(pages):
        if i == skip:
            continue
        new_text = [str(ln.get("text") or "") for ln in page.get("lines") or []]
        if new_text != old_by_page.get(i, []):
            return False
    return True


@router.post("/{cast_id}/page/{page_idx}/regen", summary="单页重生成（改文案 + 只重合成该页）")
async def regen_page(cast_id: int, page_idx: int, body: PageRegenIn, request: Request):
    """只重合成这一页：既省 TTS 开销，也避免"错一个字整篇重来"。"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用")
    if not L.tts_available():
        raise HTTPException(status_code=409, detail=L.disabled_detail())

    row = _cast_of(cast_id)
    try:
        pages = json.loads(row.get("pages_json") or "[]")
        old_segments = json.loads(row.get("segments_json") or "[]")
    except (ValueError, TypeError):
        pages, old_segments = [], []
    if not (0 <= page_idx < len(pages)):
        raise HTTPException(status_code=404, detail="页不存在")
    if not old_segments:
        raise HTTPException(status_code=409, detail="这节讲演还没有音频，请先整篇合成一次")
    if not _other_pages_unchanged(pages, old_segments, page_idx):
        # 只重合成一页却把整篇标成最新，会让其它改过的页继续播旧音频——必须挡住
        raise HTTPException(status_code=409, detail="其它页也改过了，请整篇重新合成，或先撤销其它页的改动")

    if body.lines:
        cleaned = []
        for item in body.lines:
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            spk = str(item.get("speaker") or "A").upper()
            cleaned.append({"speaker": "B" if spk == "B" else "A", "text": text[:200]})
        if not cleaned:
            raise HTTPException(status_code=400, detail="该页没有可用台词")
        pages[page_idx]["lines"] = cleaned

    mode = L.normalize_mode(row.get("speaker_mode"))
    voices = L.voices_for_mode(mode)

    async def _job() -> dict[str, Any]:
        try:
            page_segments = await L.synthesize_segments([pages[page_idx]], voices)
            for seg in page_segments:
                seg["page"] = page_idx  # 单页合成时页下标是 0，换回真实下标
            try:
                old = json.loads(row.get("segments_json") or "[]")
            except (ValueError, TypeError):
                old = []
            merged = [s for s in old if s.get("page") != page_idx] + page_segments
            merged.sort(key=lambda s: (s.get("page", 0), s.get("index", 0)))
            for i, s in enumerate(merged):
                s["index"] = i
            total = L.total_of(merged)
            plan = L.plan_hash(pages, row.get("voice_a") or "", row.get("voice_b") or "")
            execute_insert_update(
                """UPDATE lesson_casts SET pages_json = ?, segments_json = ?, total_seconds = ?,
                        plan_hash = ?, audio_hash = ?, status = 'audio_ready', updated_at = ?
                   WHERE id = ?""",
                (json.dumps(pages, ensure_ascii=False), json.dumps(merged, ensure_ascii=False),
                 total, plan, plan, _now(), cast_id),
            )
            logger.info(f"[cast] 单页重合成完成 cast={cast_id} page={page_idx} "
                        f"{len(page_segments)} 句")
            return {"cast_id": cast_id, "page": page_idx, "segments": len(page_segments),
                    "seconds": total}
        except Exception as e:  # noqa: BLE001
            logger.error(f"[cast] 单页重合成失败 cast={cast_id} page={page_idx}: {e}", exc_info=True)
            return {"error": f"该页重合成失败: {str(e)[:160]}"}

    task_id = await task_manager.create_task(
        description="AI 讲演单页重合成", coro_factory=_job, dedupe_key=None)
    return {"task_id": task_id, "message": "该页正在重新合成...", "cast_id": cast_id,
            "page": page_idx}


@router.post("/{cast_id}/publish", summary="发布讲演（学生可见）")
async def publish_cast(cast_id: int, request: Request):
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用")
    row = _cast_of(cast_id)
    if not row.get("audio_hash"):
        raise HTTPException(status_code=409, detail="还没有音频，请先合成音频再发布")
    if row.get("audio_hash") != row.get("plan_hash"):
        raise HTTPException(status_code=409,
                            detail="大纲改过但音频还是旧的，请重新合成后再发布")
    execute_insert_update(
        "UPDATE lesson_casts SET status = 'published', updated_at = ? WHERE id = ?",
        (_now(), cast_id))
    logger.info(f"[cast] 已发布 cast={cast_id} kp={row['kp_id']} user={user['username']}")
    return {"cast_id": cast_id, "status": "published"}


# ══════════════════════════ 读取 ══════════════════════════


def _pick_cast(kp_id: int, mode: str, *, include_draft: bool) -> tuple[dict[str, Any] | None, bool]:
    """按风格取讲演；指定风格没有就回退另一版。返回 (row, fallback)。"""
    where = "" if include_draft else " AND status = 'published'"
    row = execute_query_one(
        f"SELECT * FROM lesson_casts WHERE kp_id = ? AND speaker_mode = ?{where}",
        (kp_id, mode))
    if row:
        return row, False
    other = "single" if mode == "duo" else "duo"
    row = execute_query_one(
        f"SELECT * FROM lesson_casts WHERE kp_id = ? AND speaker_mode = ?{where}",
        (kp_id, other))
    return (row, True) if row else (None, False)


@router.get("/{kp_id}/casts", summary="该知识点已有哪些版本（换个讲法用）")
async def list_casts(kp_id: int, request: Request):
    user = get_current_user(request)
    include_draft = _can_manage(user)
    where = "" if include_draft else " AND status = 'published'"
    rows = execute_query(
        f"""SELECT id, speaker_mode, status, minutes, total_seconds, updated_at, version
            FROM lesson_casts WHERE kp_id = ?{where}
            ORDER BY speaker_mode""",
        (kp_id,))
    return {"kp_id": kp_id, "casts": rows}


@router.get("/{kp_id}", summary="取知识点讲演（学生/教师共用）")
async def get_cast(kp_id: int, request: Request, mode: str = Query("duo"),
                   include_draft: int = Query(0)):
    user = get_current_user(request)
    # 草稿只给教师看；学生永远只能拿到 published
    allow_draft = bool(include_draft) and _can_manage(user)
    row, fallback = _pick_cast(kp_id, L.normalize_mode(mode), include_draft=allow_draft)
    if not row:
        return {"exists": False, "kp_id": kp_id, "mode": L.normalize_mode(mode),
                "available_modes": []}

    available = execute_query(
        "SELECT speaker_mode FROM lesson_casts WHERE kp_id = ? AND status = 'published'",
        (kp_id,))
    return {
        "exists": True,
        "kp_id": kp_id,
        "mode": row.get("speaker_mode"),
        "fallback": fallback,
        "available_modes": [r["speaker_mode"] for r in available],
        "cast": _cast_payload(row),
        "playback": _get_playback(kp_id, user["username"]),
    }


# ══════════════════════════ 播放进度 ══════════════════════════


class PlaybackIn(BaseModel):
    kp_id: int
    cast_id: int
    page_idx: int = 0
    seg_idx: int = 0
    pos: float = 0
    done_pages: list[int] = []


def _get_playback(kp_id: int, username: str) -> dict[str, Any] | None:
    row = execute_query_one(
        "SELECT * FROM cast_playback WHERE kp_id = ? AND username = ?", (kp_id, username))
    if not row:
        return None
    try:
        done = json.loads(row.get("done_pages") or "[]")
    except (ValueError, TypeError):
        done = []
    return {"cast_id": row["cast_id"], "page_idx": int(row.get("page_idx") or 0),
            "seg_idx": int(row.get("seg_idx") or 0), "pos": float(row.get("pos") or 0),
            "done_pages": done}


@router.put("/progress", summary="上报播放进度（前端 5s 节流）")
async def save_progress(body: PlaybackIn, request: Request):
    """断点与完成度：写 cast_playback；页完成 ≥80% 时回写 learning_progress。

    注意：**不设练习门禁**。这里只记录状态用于展示与统计，不拦截任何跳转。
    """
    user = get_current_user(request)
    username = user["username"]
    now = _now()

    execute_insert_update(
        """INSERT INTO cast_playback
           (kp_id, username, cast_id, page_idx, seg_idx, pos, done_pages, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(kp_id, username) DO UPDATE SET
             cast_id = excluded.cast_id, page_idx = excluded.page_idx,
             seg_idx = excluded.seg_idx, pos = excluded.pos,
             done_pages = excluded.done_pages, updated_at = excluded.updated_at""",
        (body.kp_id, username, body.cast_id, max(0, body.page_idx), max(0, body.seg_idx),
         max(0.0, float(body.pos)), json.dumps(sorted(set(body.done_pages))), now),
    )

    # 完成度 → learning_progress（只对学生，且只升不降）
    total_pages = 0
    row = execute_query_one("SELECT pages_json FROM lesson_casts WHERE id = ?", (body.cast_id,))
    if row:
        try:
            total_pages = len(json.loads(row.get("pages_json") or "[]"))
        except (ValueError, TypeError):
            total_pages = 0

    completed = False
    if (user.get("role") == 2 and total_pages > 0
            and len(set(body.done_pages)) / total_pages >= DONE_RATIO):
        completed = _mark_kp_completed(username, body.kp_id)

    return {"ok": True, "completed": completed, "total_pages": total_pages}


def _mark_kp_completed(username: str, kp_id: int) -> bool:
    """把知识点置为已完成；首次完成发一次奖励（与课程页 /progress/{kp_id} 同口径）。"""
    old = execute_query_one(
        "SELECT id, status FROM learning_progress WHERE student_username=? AND knowledge_point_id=?",
        (username, kp_id))
    if old and old["status"] == "completed":
        return False

    now = _now()
    if old:
        execute_insert_update(
            "UPDATE learning_progress SET status='completed', completed_at=?, updated_at=? WHERE id=?",
            (now, now, old["id"]))
    else:
        execute_insert_update(
            """INSERT INTO learning_progress
               (student_username, knowledge_point_id, status, score, completed_at, updated_at)
               VALUES (?, ?, 'completed', 0, ?, ?)""",
            (username, kp_id, now, now))

    try:
        from backend.reward_engine import award_participation
        kp = execute_query_one("SELECT name FROM knowledge_points WHERE id=?", (kp_id,))
        title = kp["name"] if kp else f"知识点#{kp_id}"
        award_participation(username, "learning", str(kp_id), title)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"[cast] 完成奖励发放失败（不影响进度）: {e}")
    return True


@router.get("/progress/{kp_id}", summary="取播放断点")
async def read_progress(kp_id: int, request: Request):
    user = get_current_user(request)
    return {"kp_id": kp_id, "playback": _get_playback(kp_id, user["username"])}
