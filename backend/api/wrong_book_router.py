"""
错题本 API 路由
自动归集学生错题，AI 生成复习计划
"""
import json
import re
import threading
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.api.dependencies import get_current_user
from backend.question_db import execute_query, execute_query_one, execute_update
from backend.database import execute_query as user_query
from backend.logger import logger
from backend.api.chat_router import get_api_keys
from backend.api.ai_service import call_ai_async
from backend.prompts import apply_skills, build_ai_role
from backend.database import (
    execute_query as db_exec,
    execute_query_dict as db_dict,
    execute_insert_update as db_insert,
)
from backend.permission_service import (
    parse_legacy_teacher_grade_class,
    is_student_in_teacher_scope,
)
from backend.async_utils import spawn_bg

router = APIRouter()

# ── 错题本接入范围：系统配置 wrong_book_sources 决定哪些活动的答错会进错题本 ──
# 只有"题目能追溯到 question_bank"的活动才登记在这里 —— 追不到题号的活动，
# 进了错题本也取不到题干/选项/解析，给管理员一个死开关反而更困惑。
WRONG_BOOK_SOURCE_LABELS = {
    "exam": "考试",
    "practice": "同步练习",
    "quick_quiz": "随堂测验",
    "class_drill": "课堂抽问",
    "course_practice": "课程练习",
    "class_ladder": "课堂闯关",
}
ALWAYS_ON_WRONG_BOOK_SOURCES = ("exam",)   # 考试是错题本的基本盘，不提供关闭入口
WRONG_BOOK_SOURCE_DEFAULT = ["exam", "practice"]


def wrong_book_sources() -> list[str]:
    """当前生效的接入来源。考试永远在列；配置里未登记的来源直接忽略，不报错。"""
    from backend.api.config_router import get_config_value

    raw_cfg = get_config_value("wrong_book_sources", WRONG_BOOK_SOURCE_DEFAULT)
    if isinstance(raw_cfg, str):
        raw_cfg = [x.strip() for x in re.split(r"[,，、;；\s]+", raw_cfg) if x.strip()]
    items = [str(x).strip() for x in (raw_cfg or []) if str(x).strip() in WRONG_BOOK_SOURCE_LABELS]
    for s in ALWAYS_ON_WRONG_BOOK_SOURCES:
        if s not in items:
            items.append(s)
    return items


def is_wrong_book_source_enabled(source: str) -> bool:
    return (source or "").strip() in wrong_book_sources()



def _check_teacher_can_view_student(teacher_username: str, student_username: str):
    """检查教师是否有权限查看该学生的错题（使用统一权限服务）"""
    from backend.auth import is_admin
    if is_admin(teacher_username):
        return
    if not is_student_in_teacher_scope(student_username, teacher_username):
        raise HTTPException(status_code=403, detail="无权查看其他班级学生的错题")


# ═══════════════════════════════════════════════
# 访问守卫与错题读模型（W1/W2/W4/W5/W14）
# ═══════════════════════════════════════════════

# 已确认"无错题可回填"的学生, 避免每次请求重复全量扫描考试记录
_BACKFILL_SCANNED: set[str] = set()
_PRACTICE_BACKFILL_SCANNED: set[str] = set()


def _assert_can_access_student(user: dict, requested: str) -> str:
    """统一的学生数据访问守卫(W1/W2)。

    - 学生: 一律强制为本人(忽略请求参数)
    - 教师: 指定他人时必须在其任教范围内
    - 管理员(root): 不限
    """
    username = user.get("username", "")
    role = user.get("role", 2)
    requested = (requested or "").strip()
    if role == 2:
        return username
    if role == 0:
        return requested or username
    if not requested or requested == username:
        return requested or username
    _check_teacher_can_view_student(username, requested)
    return requested


def _db_write(sql: str, params: tuple = ()) -> int:
    """主库写操作并返回受影响行数。

    database.execute_query 不提交(execute_query 里的 DML 会被静默回滚),
    execute_insert_update 返回 lastrowid 而非 rowcount, 故 UPDATE 计数需自己取。
    """
    from backend.database import get_connection
    with get_connection() as conn:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.rowcount


def _to_int(v: Any) -> int | None:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _question_meta_map(qids: list) -> dict[int, dict[str, Any]]:
    """批量取题目详情。

    题库在 questions.db, wrong_book 在 smartkb.db, 不能跨库 JOIN(主库里的
    question_bank 是历史遗留的空壳表, JOIN 会静默返回全 NULL 的题干与答案)。
    注意不过滤 status: 题被软删后错题记录仍应可见(W14)。
    """
    ids = [i for i in (_to_int(q) for q in qids) if i is not None]
    if not ids:
        return {}
    ph = ",".join("?" for _ in ids)
    rows = execute_query(
        f"""SELECT id, type, question_text, options, correct_answer, explanation,
                   knowledge_points, subject, svg_content, has_svg, media_files, media_placeholders, status
            FROM question_bank WHERE id IN ({ph})""",
        tuple(ids),
    )
    return {r["id"]: r for r in rows}


def _activity_meta_map(student: str, source: str, ids: list[int]) -> dict[int, dict[str, Any]]:
    """批量取来源活动(考试/练习/随堂测验)的标题与成绩信息"""
    ids = [i for i in ids if i]
    if not ids:
        return {}
    ph = ",".join("?" for _ in ids)
    try:
        if source == "exam":
            rows = execute_query(
                f"""SELECT ea.exam_id AS rid, e.title, e.subject, ea.score, ea.total_score,
                          ea.submitted_at, ea.id AS attempt_id
                    FROM exam_attempts ea JOIN exams e ON e.id = ea.exam_id
                    WHERE ea.student_username = ? AND ea.status = 'submitted' AND ea.exam_id IN ({ph})
                    ORDER BY ea.submitted_at DESC""",
                (student, *ids),
            )
        elif source == "practice":
            rows = execute_query(
                f"""SELECT pa.session_id AS rid, ps.title, ps.subject, pa.score, pa.total_score,
                          pa.submitted_at, pa.id AS attempt_id
                    FROM practice_attempts pa JOIN practice_sessions ps ON ps.id = pa.session_id
                    WHERE pa.student_username = ? AND pa.status = 'submitted' AND pa.session_id IN ({ph})
                    ORDER BY pa.submitted_at DESC""",
                (student, *ids),
            )
        elif source == "course_practice":
            # 课程练习按知识点组织，知识点名就是这份练习的名字（知识点表在主库，别用题库连接）
            krows = db_dict(
                f"SELECT id, name, updated_at FROM knowledge_points WHERE id IN ({ph})", tuple(ids)
            ) or []
            rows = [{
                "rid": r["id"], "title": r.get("name") or "", "subject": "",
                "score": None, "total_score": None,
                "submitted_at": r.get("updated_at") or "", "attempt_id": None,
            } for r in krows]
        elif source in ("class_drill", "class_ladder"):
            # 课堂活动的会话表在主库，字段名也和考试不同，这里统一成同一套键
            table = "class_drill_sessions" if source == "class_drill" else "class_ladder_sessions"
            srows = db_dict(
                f"SELECT id, topic, subject, updated_at FROM {table} WHERE id IN ({ph})", tuple(ids)
            ) or []
            rows = [{
                "rid": r["id"], "title": r.get("topic") or "", "subject": r.get("subject") or "",
                "score": None, "total_score": None, "submitted_at": r.get("updated_at") or "",
                "attempt_id": None,
            } for r in srows]
        else:
            return {}
    except Exception as e:
        logger.warning(f"读取错题来源活动失败 ({source}): {e}")
        return {}
    out: dict[int, dict[str, Any]] = {}
    for r in rows:              # 已按时间倒序, 只保留每题最近一次
        out.setdefault(r["rid"], r)
    return out


def _backfill_wrong_book(student: str) -> int:
    """回填历史错题：考试与同步练习各扫一次（进程内记名，避免每次打开错题本都重解析答卷）。

    练习侧只补"表里还没有的题"，已有行不累加 wrong_count —— 否则回填一次就等于
    每人又多错一遍，错题次数这个指标会被自己灌爆。
    """
    if not student:
        return 0
    written = 0
    if student not in _BACKFILL_SCANNED:
        written += _backfill_exam_wrong_book(student)
    if student not in _PRACTICE_BACKFILL_SCANNED:
        written += _backfill_practice_wrong_book(student)
    return written


def _backfill_practice_wrong_book(student: str) -> int:
    """把只存在于 practice_attempts.answers 里的历史错题补进 wrong_book。

    同步练习接入错题本之前做的练习不会自己冒出来；不回填的话，老学生的错题本
    看起来永远比实际少，而教师看不出是"没错题"还是"没回填"。
    """
    _PRACTICE_BACKFILL_SCANNED.add(student)
    try:
        attempts = execute_query(
            """SELECT session_id, answers, submitted_at FROM practice_attempts
               WHERE student_username = ? AND status = 'submitted'
               ORDER BY submitted_at DESC""",
            (student,),
        )
    except Exception as e:
        logger.warning(f"同步练习错题回填失败 ({student}): {e}")
        return 0
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    written = 0
    for a in attempts or []:
        data = a.get("answers")
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except (json.JSONDecodeError, TypeError):
                continue
        if not isinstance(data, dict):
            continue
        for qid_raw, ans in data.items():
            if not isinstance(ans, dict) or ans.get("is_correct"):
                continue
            if str(ans.get("grading") or "") == "pending":
                continue          # 主观题还没判完，不能当错题记
            qid = _to_int(qid_raw)
            if qid is None:
                continue
            if db_exec("SELECT 1 FROM wrong_book WHERE student_username=? AND question_id=? LIMIT 1",
                       (student, qid)):
                continue          # 已有行（考试记的或上次回填的）不再加次数
            meta = _question_meta_map([qid]).get(qid, {})
            when = a.get("submitted_at") or now
            try:
                db_insert(
                    """INSERT OR IGNORE INTO wrong_book
                       (student_username, question_id, source, source_id, knowledge_points, question_type,
                        status, wrong_answer, created_at, wrong_count, last_wrong_at)
                       VALUES (?, ?, 'practice', ?, ?, ?, 'pending', ?, ?, 1, ?)""",
                    (student, qid, a.get("session_id") or 0,
                     meta.get("knowledge_points", "") or "", meta.get("type", "") or "",
                     str(ans.get("student_answer", ""))[:500], when, when),
                )
                written += 1
            except Exception as e:
                logger.warning(f"同步练习错题回填单行失败 ({student} qid={qid}): {e}")
    if written:
        logger.info(f"[错题本] 同步练习历史回填 {student}: 补 {written} 行")
    return written


def _backfill_exam_wrong_book(student: str) -> int:
    """把只存在于 exam_attempts.answers 里的历史错题回填进 wrong_book(W5)。

    每人只跑一次: 表内已有记录或已确认无错题则跳过。
    """
    if student in _BACKFILL_SCANNED:
        return 0
    try:
        has = db_exec("SELECT 1 FROM wrong_book WHERE student_username=? LIMIT 1", (student,))
        if has:
            _BACKFILL_SCANNED.add(student)
            return 0
        attempts = execute_query(
            """SELECT exam_id, answers, submitted_at FROM exam_attempts
               WHERE student_username = ? AND status = 'submitted'
               ORDER BY submitted_at DESC""",
            (student,),
        )
    except Exception as e:
        logger.warning(f"错题回填失败 ({student}): {e}")
        return 0

    wrong: dict[int, tuple[str, str, int]] = {}
    for a in attempts:
        data = a.get("answers")
        if isinstance(data, str):
            try:
                data = json.loads(data)
            except (json.JSONDecodeError, TypeError):
                continue
        if not isinstance(data, dict):
            continue
        for qid_raw, ans in data.items():
            if not isinstance(ans, dict) or ans.get("is_correct", False):
                continue
            qid = _to_int(qid_raw)
            if qid is None:
                continue
            wrong.setdefault(qid, (
                str(ans.get("student_answer", ""))[:500],
                a.get("submitted_at") or "",
                a.get("exam_id") or 0,
            ))
    if not wrong:
        _BACKFILL_SCANNED.add(student)
        return 0

    meta = _question_meta_map(list(wrong.keys()))
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    inserted = 0
    for qid, (wrong_answer, when, exam_id) in wrong.items():
        m = meta.get(qid, {})
        db_insert(
            """INSERT OR IGNORE INTO wrong_book
               (student_username, question_id, source, source_id, knowledge_points, question_type,
                status, wrong_answer, created_at, wrong_count, last_wrong_at)
               VALUES (?, ?, 'exam', ?, ?, ?, 'pending', ?, ?, 1, ?)""",
            (student, qid, exam_id, m.get("knowledge_points", ""), m.get("type", ""),
             wrong_answer, when or now, when or now),
        )
        inserted += 1
    _BACKFILL_SCANNED.add(student)
    if inserted:
        logger.info(f"错题本回填: {student} 共 {inserted} 道历史错题")
    return inserted


def _collect_wrong_for_plan(student: str) -> tuple[list[dict], set, set, str]:
    """给复习计划用的错题汇总(W10: 读表 + 一次批量查题, 不再逐考试解析 JSON)"""
    _backfill_wrong_book(student)
    rows = db_dict(
        """SELECT question_id, wrong_answer, knowledge_points, question_type
           FROM wrong_book WHERE student_username = ? AND status = 'pending'
           ORDER BY COALESCE(NULLIF(last_wrong_at, ''), created_at) DESC, id DESC""",
        (student,),
    ) or []
    if not rows:
        return [], set(), set(), ""
    meta = _question_meta_map([r["question_id"] for r in rows])
    all_wrong: list[dict] = []
    kp_set: set = set()
    type_set: set = set()
    for r in rows:
        q = meta.get(r["question_id"], {})
        kp = (q.get("knowledge_points") or r.get("knowledge_points") or "未知")
        kp_set.add(kp)
        qtype = q.get("type") or r.get("question_type") or ""
        if qtype:
            type_set.add(qtype)
        all_wrong.append({
            "question": q.get("question_text") or f"(题目ID:{r['question_id']}，已不在题库)",
            "type": qtype,
            "correct": q.get("correct_answer", "") or "",
            "your_answer": r.get("wrong_answer", "") or "",
            "knowledge": kp,
        })
    subjects = {(m.get("subject") or "") for m in meta.values()} - {""}
    subject = "、".join(sorted(subjects)) if subjects else "通用"
    return all_wrong, kp_set, type_set, subject


_SOURCE_FALLBACK_TITLES = {
    "exam": "考试错题",
    "practice": "同步练习错题",
    "quiz": "随堂测验错题",
    "quick_quiz": "随堂测验错题",
    "class_drill": "课堂抽问错题",
    "course_practice": "课程练习错题",
    "class_ladder": "课堂闯关错题",
    "auto": "系统自动归集",
}


@router.get("/sources", summary="错题本接入范围（哪些活动的答错会进错题本）")
async def get_wrong_book_sources(request: Request):
    """给前端显示用：管理员在系统配置里勾了什么，页面就如实说什么。"""
    get_current_user(request)
    items = wrong_book_sources()
    return {
        "sources": items,
        "labels": WRONG_BOOK_SOURCE_LABELS,
        "always_on": list(ALWAYS_ON_WRONG_BOOK_SOURCES),
        "all_sources": list(WRONG_BOOK_SOURCE_LABELS.keys()),
    }


@router.get("/list", summary="获取错题本(以 wrong_book 表为唯一事实源)")
async def get_wrong_questions(
    request: Request,
    status: str = Query("pending", description="pending=待掌握 mastered=已掌握 all=全部"),
):
    """错题列表: 读 wrong_book 表 + 批量补题目详情, 按来源活动分组返回。

    旧实现是每次现场解析该生全部 exam_attempts JSON, 并叠加两处"知识点连坐"过滤
    (_is_kp_mastered / _is_question_mastered), 既与掌握状态表互不相干,
    又会因逐题查询在错题多时明显变慢。
    """
    user = get_current_user(request)
    target_username = _assert_can_access_student(
        user, request.query_params.get("student_username", "")
    )
    if not target_username:
        return {
            "total_wrong": 0, "exams": [], "student_username": "",
            "pending_total": 0, "mastered_total": 0, "all_total": 0,
        }

    _backfill_wrong_book(target_username)

    rows = db_dict(
        """SELECT id, question_id, source, source_id, knowledge_points, question_type,
                  status, wrong_answer, created_at, mastered_at, wrong_count, last_wrong_at
           FROM wrong_book
           WHERE student_username = ? AND (? = 'all' OR status = ?)""",
        (target_username, status, status),
    ) or []
    status_rows = db_dict(
        "SELECT status, COUNT(*) AS cnt FROM wrong_book WHERE student_username=? GROUP BY status",
        (target_username,),
    ) or []
    status_counts = {str(r["status"]): int(r["cnt"] or 0) for r in status_rows}
    mastered_total = status_counts.get("mastered", 0)
    pending_total = sum(v for k, v in status_counts.items() if k != "mastered")
    all_total = mastered_total + pending_total

    qmeta = _question_meta_map([r["question_id"] for r in rows])
    grouped: dict[tuple[str, int], list[dict]] = {}
    for r in rows:
        grouped.setdefault((r["source"] or "exam", r["source_id"] or 0), []).append(r)
    ameta = {}
    for src in {k[0] for k in grouped}:
        ameta[src] = _activity_meta_map(target_username, src, [k[1] for k in grouped if k[0] == src])

    groups: list[dict] = []
    total_wrong = 0
    for (src, sid), items in grouped.items():
        info = ameta.get(src, {}).get(sid, {})
        wrong_questions = []
        for it in sorted(items, key=lambda x: str(x.get("last_wrong_at") or x.get("created_at") or ""), reverse=True):
            q = qmeta.get(it["question_id"], {})
            options_raw = q.get("options") or ""
            options = {}
            if options_raw:
                try:
                    opts = json.loads(options_raw) if isinstance(options_raw, str) else options_raw
                    if isinstance(opts, dict):
                        options = opts
                except (json.JSONDecodeError, TypeError):
                    options = {}
            wrong_questions.append({
                "question_id": str(it["question_id"]),
                "wrong_book_id": it["id"],
                "question_text": q.get("question_text") or f"(题目ID:{it['question_id']}，已不在题库)",
                "question_type": it.get("question_type") or q.get("type") or "",
                "options": options,
                "correct_answer": q.get("correct_answer", "") or "",
                "student_answer": it.get("wrong_answer", "") or "",
                "explanation": (q.get("explanation") or "").strip(),
                "score": 0,
                "max_score": 0,
                "knowledge_points": it.get("knowledge_points") or q.get("knowledge_points") or "",
                "svg_content": q.get("svg_content", "") or "",
                "has_svg": q.get("has_svg", 0) or 0,
                "media_files": q.get("media_files", "") or "",
                "media_placeholders": q.get("media_placeholders", "") or "",
                "wrong_count": it.get("wrong_count") or 1,
                "wb_status": it.get("status"),
                "mastered_at": it.get("mastered_at"),
                "question_status": q.get("status") or "missing",
            })
        total_wrong += len(wrong_questions)
        groups.append({
            "exam_id": sid,
            "exam_title": info.get("title") or _SOURCE_FALLBACK_TITLES.get(src, "错题"),
            "exam_subject": info.get("subject") or "",
            "submitted_at": info.get("submitted_at") or (items[0].get("last_wrong_at") or items[0].get("created_at")),
            "score": info.get("score"),
            "total_score": info.get("total_score"),
            "source": src,
            "wrong_count": len(wrong_questions),
            "wrong_questions": wrong_questions,
        })

    groups.sort(key=lambda g: str(g.get("submitted_at") or ""), reverse=True)
    return {
        "total_wrong": total_wrong,
        "exams": groups,
        "mastered_total": mastered_total,
        "pending_total": pending_total,
        "all_total": all_total,
        "student_username": target_username,
    }


class MasterToggleRequest(BaseModel):
    wrong_book_id: int = 0
    wrong_book_ids: list[int] = []  # 批量: 错题本页勾选多道一次标记
    status: str = "mastered"  # mastered=已掌握 pending=取消(重回待掌握)


def _apply_master_toggle(user: dict, wb_id: int, status: str) -> int:
    """切换单条错题的掌握状态, 返回实际更新行数(0 = 状态本就一致)。

    权限守卫与订正积分都收在这里, 单条与批量走同一条路径, 不会出现
    "批量绕过了教师任教范围检查" 这类偏差。
    """
    rows = db_dict("SELECT id, student_username, status FROM wrong_book WHERE id=?", (wb_id,))
    if not rows:
        raise HTTPException(status_code=404, detail="错题记录不存在")

    owner = rows[0]["student_username"]
    # W1/W2 同一守卫: 学生一律本人, 教师限任教范围, 管理员不限
    if _assert_can_access_student(user, owner) != owner:
        raise HTTPException(status_code=403, detail="无权修改其他学生的错题本")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if status == "mastered":
        updated = _db_write(
            "UPDATE wrong_book SET status='mastered', mastered_at=? WHERE id=? AND status<>'mastered'",
            (now, wb_id),
        )
        if updated:
            # 把错题真正改会是有价值的学习行为，以前在积分体系里一分不算（订正类每日上限 5 分）
            try:
                from backend.reward_engine import award_participation
                award_participation(owner, "wrong_book", str(wb_id), f"错题订正 #{wb_id}")
            except Exception as e:
                logger.warning(f"[错题本] 订正积分发放失败 {owner}: {e}")
    else:
        updated = _db_write(
            "UPDATE wrong_book SET status='pending', mastered_at=NULL WHERE id=? AND status<>'pending'",
            (wb_id,),
        )
    logger.info(f"错题手动切换掌握状态: {user.get('username')} wb={wb_id} "
                f"-> {status} (updated={updated})")
    return updated


@router.post("/master", summary="手动或批量切换错题的掌握状态")
async def toggle_wrong_mastered(req: MasterToggleRequest, request: Request):
    """学生自主控制错题本: 把某道题(或勾选的一批)标为已掌握, 或取消标记。

    与判分自动标记共用同一 status 字段: 标掌握后再次答错会由 _upsert_wrong
    自动重开为 pending, 所以手动标记不会把题永久锁死在错题本外。
    """
    user = get_current_user(request)
    if req.status not in ("mastered", "pending"):
        raise HTTPException(status_code=400, detail="status 仅支持 mastered 或 pending")

    ids: list[int] = []
    for raw in [req.wrong_book_id, *(req.wrong_book_ids or [])]:
        try:
            wid = int(raw)
        except (TypeError, ValueError):
            continue
        if wid > 0 and wid not in ids:
            ids.append(wid)
    if not ids:
        raise HTTPException(status_code=400, detail="缺少 wrong_book_id")
    if len(ids) > 200:
        raise HTTPException(status_code=400, detail="单次最多处理 200 条错题")

    updated = 0
    for wid in ids:
        updated += _apply_master_toggle(user, wid, req.status)
    return {"ok": True, "updated": updated, "wrong_book_id": ids[0],
            "wrong_book_ids": ids, "status": req.status}


@router.get("/students", summary="获取有错题记录的学生列表")
async def get_students_with_wrong(
    request: Request,
    grade: str = Query("", description="年级筛选"),
    class_name: str = Query("", description="班级筛选"),
):
    """获取有错题记录的学生列表（教师只返回自己所教班级的学生）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    # 名单以 wrong_book 为准：只做过同步练习/抽问、没交过考试的学生也必须能被选到。
    # 旧写法拿 exam_attempts 当"有错题的人"，这类学生的错题本在教师端永远打不开。
    rows = db_dict("SELECT DISTINCT student_username FROM wrong_book") or []
    usernames = [r["student_username"] for r in rows if r.get("student_username")]
    if not usernames:
        return {"students": []}

    # 构建查询条件
    conditions = ["username IN ({})".format(",".join("?" * len(usernames)))]
    params = list(usernames)

    if grade:
        conditions.append("grade = ?")
        params.append(grade)
    if class_name:
        conditions.append("class = ?")
        params.append(class_name)

    # 教师只能看自己所教班级的学生
    if role == 1:
        teacher_rows = user_query(
            "SELECT grade, class FROM users WHERE username=?", (username,)
        )
        teacher_grade = (teacher_rows[0][0] or "").strip() if teacher_rows else ""
        teacher_class = str(teacher_rows[0][1] or "").strip() if teacher_rows else ""
        grade_class_map = parse_legacy_teacher_grade_class(teacher_grade, teacher_class)

        if not grade:
            # 没有指定年级，限制在所有所教年级和班级
            grade_conditions = []
            for g, classes in grade_class_map.items():
                if classes:
                    cls_placeholders = ",".join("?" * len(classes))
                    grade_conditions.append("(grade = ? AND class IN ({}))".format(cls_placeholders))
                    params.extend([g] + classes)
                else:
                    grade_conditions.append("grade = ?")
                    params.append(g)
            if grade_conditions:
                conditions.append("(" + " OR ".join(grade_conditions) + ")")
        else:
            # 指定了年级，只限制该年级下的班级
            allowed_classes = grade_class_map.get(grade, [])
            if allowed_classes:
                cls_placeholders = ",".join("?" * len(allowed_classes))
                conditions.append("class IN ({})".format(cls_placeholders))
                params.extend(allowed_classes)

    where = " AND ".join(conditions)
    student_rows = user_query(
        f"""SELECT username, name, grade, class FROM users
           WHERE {where}
           ORDER BY grade, class""",
        tuple(params),
    )

    students = []
    for r in student_rows:
        students.append({
            "username": r[0],
            "name": r[1] or r[0],
            "grade": r[2] or "",
            "class": str(r[3] or ""),
        })
    return {"students": students}


@router.get("/grades", summary="获取有错题记录的年级列表")
async def get_grades_with_wrong(request: Request):
    """获取有错题记录的年级列表（教师只返回自己所教年级）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    # 名单以 wrong_book 为准：只做过同步练习/抽问、没交过考试的学生也必须能被选到。
    # 旧写法拿 exam_attempts 当"有错题的人"，这类学生的错题本在教师端永远打不开。
    rows = db_dict("SELECT DISTINCT student_username FROM wrong_book") or []
    usernames = [r["student_username"] for r in rows if r.get("student_username")]
    if not usernames:
        return {"grades": []}

    # 管理员看到所有年级
    if role == 0:
        placeholders = ",".join("?" * len(usernames))
        grade_rows = user_query(
            f"""SELECT DISTINCT grade FROM users
               WHERE username IN ({placeholders}) AND grade IS NOT NULL AND grade != ''
               ORDER BY grade""",
            tuple(usernames),
        )
        return {"grades": [r[0] for r in grade_rows]}

    # 教师只返回自己所教年级
    teacher_rows = user_query(
        "SELECT grade, class FROM users WHERE username=?", (username,)
    )
    teacher_grade = (teacher_rows[0][0] or "").strip() if teacher_rows else ""
    teacher_class = str(teacher_rows[0][1] or "").strip() if teacher_rows else ""
    grade_class_map = parse_legacy_teacher_grade_class(teacher_grade, teacher_class)
    teacher_grades = list(grade_class_map.keys())

    if not teacher_grades:
        return {"grades": []}

    placeholders = ",".join("?" * len(usernames))
    grade_rows = user_query(
        f"""SELECT DISTINCT grade FROM users
           WHERE username IN ({placeholders}) AND grade IS NOT NULL AND grade != ''
           AND grade IN ({','.join('?' * len(teacher_grades))})
           ORDER BY grade""",
        tuple(usernames + teacher_grades),
    )
    return {"grades": [r[0] for r in grade_rows]}


@router.get("/classes", summary="获取指定年级下有错题记录的班级列表")
async def get_classes_with_wrong(
    request: Request,
    grade: str = Query("", description="年级"),
):
    """获取指定年级下有错题记录的班级列表（教师只返回自己所教班级）"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可用")

    if not grade:
        return {"classes": []}

    # 名单以 wrong_book 为准：只做过同步练习/抽问、没交过考试的学生也必须能被选到。
    # 旧写法拿 exam_attempts 当"有错题的人"，这类学生的错题本在教师端永远打不开。
    rows = db_dict("SELECT DISTINCT student_username FROM wrong_book") or []
    usernames = [r["student_username"] for r in rows if r.get("student_username")]
    if not usernames:
        return {"classes": []}

    # 管理员看到该年级所有班级
    placeholders = ",".join("?" * len(usernames))
    params = [grade] + usernames

    if role == 0:
        class_rows = user_query(
            f"""SELECT DISTINCT class FROM users
               WHERE grade = ? AND username IN ({placeholders})
               AND class IS NOT NULL AND class != ''
               ORDER BY class""",
            tuple(params),
        )
        return {"classes": [str(r[0]) for r in class_rows]}

    # 教师只返回自己所教班级
    teacher_rows = user_query(
        "SELECT grade, class FROM users WHERE username=?", (username,)
    )
    teacher_grade = (teacher_rows[0][0] or "").strip() if teacher_rows else ""
    teacher_class = str(teacher_rows[0][1] or "").strip() if teacher_rows else ""
    grade_class_map = parse_legacy_teacher_grade_class(teacher_grade, teacher_class)
    allowed_classes = grade_class_map.get(grade, [])

    if not allowed_classes:
        return {"classes": []}

    class_placeholders = ",".join("?" * len(allowed_classes))
    class_rows = user_query(
        f"""SELECT DISTINCT class FROM users
           WHERE grade = ? AND username IN ({placeholders})
           AND class IS NOT NULL AND class != ''
           AND class IN ({class_placeholders})
           ORDER BY class""",
        tuple(params + allowed_classes),
    )
    return {"classes": [str(r[0]) for r in class_rows]}


@router.get("/review-plan", summary="AI 生成错题复习计划")
async def get_review_plan(request: Request):
    """AI 根据错题本生成个性化复习计划(异步任务)"""
    user = get_current_user(request)
    username = user["username"]
    # W2: 教师指定他人时必须在其任教范围内
    target_username = _assert_can_access_student(
        user, request.query_params.get("student_username", "")
    )

    user_rows = user_query(
        "SELECT name, grade, class FROM users WHERE username=?", (target_username,)
    )
    student_name = user_rows[0][0] if user_rows and user_rows[0][0] else target_username
    student_grade = user_rows[0][1] if user_rows else ""
    student_class = str(user_rows[0][2]) if user_rows and user_rows[0][2] is not None else ""

    all_wrong, kp_set, type_set, subject = _collect_wrong_for_plan(target_username)
    if not all_wrong:
        return {"plan": "暂无错题，继续保持！", "total_wrong": 0, "knowledge_points": [], "weak_types": []}

    max_detail = 30
    wrong_text = ""
    for i, w in enumerate(all_wrong[:max_detail], 1):
        wrong_text += f"{i}. [{w['type']}] {w['question']}\n"
        wrong_text += f"   你的答案：{w['your_answer']} | 正确答案：{w['correct']}\n"
        wrong_text += f"   知识点：{w['knowledge']}\n\n"
    if len(all_wrong) > max_detail:
        wrong_text += f"...（共 {len(all_wrong)} 道错题，以上为最近 {max_detail} 道）\n"

    type_labels = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题",
                   "fill": "填空题", "essay": "作文", "subjective": "主观题"}
    weak_types = "、".join(str(type_labels.get(t, t)) for t in type_set)

    from backend.prompts.wrong_book import WRONG_BOOK_REVIEW_PROMPT

    ai_role = build_ai_role(grade=student_grade)
    prompt = f"{ai_role}\n" + WRONG_BOOK_REVIEW_PROMPT.format(
        student_name=student_name,
        grade=student_grade,
        cls=student_class,
        total_wrong=len(all_wrong),
        knowledge_points="、".join(sorted(kp_set)[:10]),
        weak_types=weak_types,
        wrong_questions=wrong_text,
        subject=subject or "通用",
    )
    prompt = apply_skills(prompt, "wrong-book")

    keys = get_api_keys(username)
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    from backend.ai_task_manager import task_manager

    async def _do_plan() -> dict[str, Any]:
        try:
            result = await call_ai_async(prompt, api_key, use_kb=False)
            return {"plan": result}
        except Exception as e:
            logger.error(f"AI 复习计划生成失败: {e}")
            return {"error": f"生成复习计划失败: {str(e)}"}

    task_id = await task_manager.create_task(
        description=f"错题复习计划({target_username})", coro_factory=_do_plan,
        dedupe_key=f"review-plan:{target_username}", max_concurrent=4
    )

    return {
        "task_id": task_id,
        "message": "AI 复习计划已提交，请稍后查询结果",
        "total_wrong": len(all_wrong),
        "knowledge_points": list(kp_set),
        "weak_types": list(type_set),
        "student_username": target_username,
    }


@router.get("/review-plan/export", summary="导出 AI 复习计划为 Word 文档")
async def export_review_plan_docx(
    request: Request,
    student_username: str = Query("", description="学生用户名"),
):
    """导出 AI 复习计划为 Word 文档"""
    import io
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from fastapi.responses import StreamingResponse

    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    # W2: 教师导出别班学生的复习计划必须先过任教范围校验
    target_username = _assert_can_access_student(user, student_username)

    user_rows = user_query(
        "SELECT name, grade, class FROM users WHERE username=?",
        (target_username,),
    )
    student_name = user_rows[0][0] if user_rows and user_rows[0][0] else target_username
    student_grade = user_rows[0][1] if user_rows else ""
    student_class = str(user_rows[0][2]) if user_rows and user_rows[0][2] is not None else ""

    all_wrong, kp_set, type_set, plan_subject = _collect_wrong_for_plan(target_username)

    if not all_wrong:
        raise HTTPException(status_code=400, detail="暂无错题，无需生成复习计划")

    wrong_text = ""
    for i, w in enumerate(all_wrong[:15], 1):
        wrong_text += f"{i}. [{w['type']}] {w['question']}\n"
        wrong_text += f"   你的答案：{w['your_answer']} | 正确答案：{w['correct']}\n"
        wrong_text += f"   知识点：{w['knowledge']}\n\n"

    type_labels = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题",
                   "fill": "填空题", "essay": "作文", "subjective": "主观题"}
    weak_types = "、".join(str(type_labels.get(t, t)) for t in type_set)

    from backend.prompts.wrong_book import WRONG_BOOK_REVIEW_PROMPT

    subject = plan_subject or "通用"

    ai_role = build_ai_role(grade=student_grade)
    prompt = f"{ai_role}\n" + WRONG_BOOK_REVIEW_PROMPT.format(
        student_name=student_name,
        grade=student_grade,
        cls=student_class,
        total_wrong=len(all_wrong),
        knowledge_points="、".join(sorted(kp_set)[:10]),
        weak_types=weak_types,
        wrong_questions=wrong_text,
        subject=subject,
    )

    keys = get_api_keys(username)
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    try:
        plan_text = await call_ai_async(prompt, api_key, use_kb=False)
    except Exception as e:
        logger.error(f"AI 复习计划生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"生成复习计划失败: {str(e)}")

    # 生成 Word 文档
    doc = Document()
    style = doc.styles['Normal']  # type: ignore[union-attr]
    style.font.name = 'Microsoft YaHei'  # type: ignore[attr-defined]
    style.font.size = Pt(11)  # type: ignore[attr-defined]
    style.paragraph_format.line_spacing = 1.5  # type: ignore[attr-defined]

    title = doc.add_heading(f"{student_name} 的 AI 复习计划", level=1)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    info = doc.add_paragraph()
    info.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = info.add_run(f"学生：{student_name}  年级：{student_grade}  班级：{student_class}班  错题数：{len(all_wrong)} 道")
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    doc.add_paragraph()

    for line in plan_text.split('\n'):
        line = line.strip()
        if not line:
            doc.add_paragraph()
            continue
        if line.startswith('### '):
            doc.add_heading(line[4:], level=3)
        elif line.startswith('## '):
            doc.add_heading(line[3:], level=2)
        elif line.startswith('# '):
            doc.add_heading(line[2:], level=1)
        elif line.startswith('- **') and '：' in line:
            content = line.lstrip('- ')
            p = doc.add_paragraph()
            bold_end = content.find('**', 2)
            if bold_end > 0:
                run = p.add_run(content[2:bold_end])
                run.bold = True
                p.add_run(content[bold_end + 2:])
            else:
                p.add_run(content)
        elif line.startswith('- '):
            doc.add_paragraph(line[2:], style='List Bullet')
        elif any(line.startswith(f'{i}. ') for i in range(1, 10)):
            doc.add_paragraph(line, style='List Number')
        else:
            if '**' in line:
                p = doc.add_paragraph()
                parts = line.split('**')
                for i, part in enumerate(parts):
                    if part:
                        run = p.add_run(part)
                        if i % 2 == 1:
                            run.bold = True
            else:
                doc.add_paragraph(line)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)

    import urllib.parse
    safe_filename = urllib.parse.quote(f"{student_name}_复习计划.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_filename}"},
    )


# ═══════════════════════════════════════════════
# 错题记账（W6/W7/W8/W9）
# ═══════════════════════════════════════════════

def _upsert_wrong(student: str, qid: int, source: str, source_id: int,
                  kp: str, qtype: str, wrong_answer: str, when: str) -> int:
    """写入一条错题。

    唯一索引 ux_wb_student_question 保证"一人一题一行":
    - 新题: 插入 pending
    - 已 pending: 累加 wrong_count 并更新最近错误答案/时间
    - 曾 mastered 又答错: 重开为 pending(错题本不能只减不加)

    来源不漂移：巩固练习里再错一次只累加次数，不把"哪次考试错的"改写成练习。
    反过来，原本只在练习里错过的题，一旦在考试里又错，来源会升级为考试。
    """
    existing = db_exec(
        "SELECT id, status FROM wrong_book WHERE student_username=? AND question_id=?",
        (student, qid),
    )
    if existing:
        return _db_write(
            """UPDATE wrong_book
               SET status='pending', mastered_at=NULL,
                   wrong_count=COALESCE(wrong_count, 1) + 1,
                   wrong_answer=?, last_wrong_at=?,
                   source=CASE WHEN ? = 'practice' AND COALESCE(source, '') NOT IN ('', 'practice')
                               THEN source ELSE ? END,
                   source_id=CASE WHEN ? = 'practice' AND COALESCE(source, '') NOT IN ('', 'practice')
                                  THEN source_id ELSE ? END,
                   knowledge_points=CASE WHEN ? <> '' THEN ? ELSE knowledge_points END,
                   question_type=CASE WHEN ? <> '' THEN ? ELSE question_type END
               WHERE id=?""",
            (wrong_answer[:500], when, source, source, source, source_id, kp, kp, qtype, qtype, existing[0][0]),
        )
    return db_insert(
        """INSERT OR IGNORE INTO wrong_book
           (student_username, question_id, source, source_id, knowledge_points, question_type,
            status, wrong_answer, created_at, wrong_count, last_wrong_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?)""",
        (student, qid, source, source_id, kp, qtype, wrong_answer[:500], when, when),
    )


def _iter_graded(items: dict, want_correct: bool):
    """安全遍历判分结果: 跳过非数字题目 ID(W8), 返回 (qid, student_answer)"""
    out = []
    skipped = 0
    for qid_raw, ans in (items or {}).items():
        if not isinstance(ans, dict):
            skipped += 1
            continue
        if bool(ans.get("is_correct", False)) != want_correct:
            continue
        qid = _to_int(qid_raw)
        if qid is None:
            skipped += 1
            continue
        out.append((qid, str(ans.get("student_answer", "") or "")))
    return out, skipped


def record_wrong_answers(student_username: str, source_id: int, graded_answers: dict[str, Any],
                         source: str = "exam") -> int:
    """提交后把答错的题写入 wrong_book(按系统配置的接入范围放行)"""
    if not is_wrong_book_source_enabled(source):
        # 静默丢弃最难查：管理员改了配置却看不出有没有生效，这里必须留一行
        logger.info(f"[错题本] 来源 {source or '(空)'} 未在系统配置(错题本接入范围)中启用, "
                    f"跳过 {student_username} 的判分记录")
        return 0
    pairs, skipped = _iter_graded(graded_answers, want_correct=False)
    if skipped:
        logger.warning(f"错题入库跳过 {skipped} 条无效判分记录 (student={student_username})")
    if not pairs:
        return 0
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    meta = _question_meta_map([qid for qid, _ in pairs])
    written = 0
    for qid, wrong_answer in pairs:
        m = meta.get(qid, {})
        _upsert_wrong(
            student_username, qid, source, source_id or 0,
            m.get("knowledge_points", "") or "", m.get("type", "") or "",
            wrong_answer, now,
        )
        written += 1
    logger.info(f"错题入库: {student_username} +{written} 条 (source={source}, id={source_id})")
    return written


def record_single_wrong(student_username: str, question_id: Any, wrong_answer: str,
                        source: str = "quiz", source_id: int = 0) -> int:
    """单条错题入库(随堂测验等零散场景用; 题已不在题库时只记 ID)"""
    if not is_wrong_book_source_enabled(source):
        logger.info(f"[错题本] 来源 {source or '(空)'} 未启用, 跳过 {student_username} qid={question_id}")
        return 0
    qid = _to_int(question_id)
    if qid is None or not student_username:
        return 0
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    meta = _question_meta_map([qid]).get(qid, {})
    return _upsert_wrong(
        student_username, qid, source, source_id or 0,
        meta.get("knowledge_points", "") or "", meta.get("type", "") or "",
        str(wrong_answer or "")[:500], now,
    )


def mark_wrong_mastered(student_username: str, correct_answers: dict[str, Any]) -> int:
    """答对后把对应错题标为已掌握。

    W6: 旧实现还会按 knowledge_points LIKE 把同知识点的其它错题一并标掌握,
    实测"只答对 1 题"就能清空整片错题, 现改为只按题目 ID 精确标记。
    """
    pairs, _skipped = _iter_graded(correct_answers, want_correct=True)
    if not pairs:
        return 0
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    marked = 0
    for qid, _ans in pairs:
        marked += _db_write(
            """UPDATE wrong_book SET status='mastered', mastered_at=?
               WHERE student_username=? AND question_id=? AND status='pending'""",
            (now, student_username, qid),
        ) or 0
    if marked:
        logger.info(f"错题标记已掌握: {student_username} 共 {marked} 条")
    return marked


class PracticeGenerateRequest(BaseModel):
    count: int = 5
    subjects: list[str] = ["信息科技"]
    knowledge_points: str = ""
    student_username: str = ""  # 教师端指定学生

@router.post("/practice/generate", summary="错题练习—生成题目")
async def generate_wrong_practice(req: PracticeGenerateRequest, request: Request):
    """从错题本取出该生待掌握的原题作为练习(教师布置前预览用)。

    W1: 教师指定其他学生时必须在任教范围内;
    W3: 学生自己调用时不下发 correct_answer / explanation, 避免未答先知。
    """
    user = get_current_user(request)
    role = user.get("role", 2)
    target = _assert_can_access_student(user, req.student_username)
    # 旧写法把越界的题量**静默改成 5**：老师填 30 道，拿回 5 道，界面上没有任何解释。
    # 现在明确报错，让"要多少"与"给多少"永远一致。
    if req.count < 1 or req.count > 20:
        raise HTTPException(status_code=400, detail=f"题目数量范围为 1-20 道（当前 {req.count}）")

    _backfill_wrong_book(target)
    rows = db_dict(
        """SELECT question_id FROM wrong_book
           WHERE student_username = ? AND status = 'pending'
           ORDER BY COALESCE(NULLIF(last_wrong_at, ''), created_at) DESC, id DESC""",
        (target,),
    ) or []
    qids = [r["question_id"] for r in rows]
    if not qids:
        return {"questions": [], "total": 0, "message": "暂无待巩固的错题"}

    import random as _random
    picked = list(qids)
    _random.shuffle(picked)
    meta = _question_meta_map(picked)

    show_answer = role != 2
    questions = []
    for qid in picked:
        if len(questions) >= req.count:
            break
        q = meta.get(qid)
        if not q or q.get("status") != "active":
            continue        # 题已不在题库: 不出练习, 但错题本仍保留记录(W14)
        try:
            opts = json.loads(q.get("options") or "{}")
            if not isinstance(opts, dict):
                opts = {}
        except (json.JSONDecodeError, TypeError):
            opts = {}
        item = {
            "id": qid, "question_id": qid,
            "question": q.get("question_text", ""), "question_text": q.get("question_text", ""),
            "type": q.get("type", ""), "options": opts,
            "knowledge_points": q.get("knowledge_points", ""),
            "difficulty": q.get("difficulty", ""),
            "svg_content": q.get("svg_content", ""), "has_svg": q.get("has_svg", 0),
            "media_files": q.get("media_files", ""),
        }
        if show_answer:
            item["answer"] = q.get("correct_answer", "")
            item["correct_answer"] = q.get("correct_answer", "")
            item["explanation"] = q.get("explanation", "")
        else:
            item["answer"] = ""
            item["correct_answer"] = ""
            item["explanation"] = ""
        questions.append(item)

    return {
        "questions": questions,
        "total": len(questions),
        "pending_total": len(qids),
        "student_username": target,
    }


# ── 自动错题巩固：策略参数（系统配置可覆盖，键名 wrong_practice_*） ──
WRONG_PRACTICE_DEFAULTS = {"threshold": 30, "per_set": 5, "interval_days": 7, "avoid_recent_sets": 3}


def wrong_practice_policy() -> dict[str, int]:
    """读自动巩固的三个参数。配置缺失或写成负数就退回默认，不能让坏配置把机制整个关掉。"""
    from backend.api.config_router import get_config_value

    out: dict[str, int] = {}
    for key, default in WRONG_PRACTICE_DEFAULTS.items():
        try:
            val = int(get_config_value(f"wrong_practice_{key}", default))
        except (TypeError, ValueError):
            val = default
        out[key] = val if val >= 0 else default
    return out


_WRONG_PRACTICE_LOCKS: dict[str, threading.Lock] = {}
_WRONG_PRACTICE_LOCKS_GUARD = threading.Lock()


def _student_lock(student_username: str) -> threading.Lock:
    """按学生取一把锁。

    生成练习是"先查有没有挡路会话、再插入"两步，交卷结算与打开错题本同时触发时
    会双双通过检查、生成两份重复练习；SQLite 串行写救不了这个 check-then-insert。
    """
    with _WRONG_PRACTICE_LOCKS_GUARD:
        lock = _WRONG_PRACTICE_LOCKS.get(student_username)
        if lock is None:
            if len(_WRONG_PRACTICE_LOCKS) > 1024:
                _WRONG_PRACTICE_LOCKS.clear()   # 回收，避免字典随学生数无界增长
            lock = _WRONG_PRACTICE_LOCKS[student_username] = threading.Lock()
        return lock


def _target_like(student_username: str) -> str:
    return f'%"{student_username}"%'


def _days_since(ts: str) -> int:
    """时间串距今几天。解析不了当作很久以前 —— 宁可多布置一次，也别永远不布置。"""
    text = str(ts or "")
    if not text:
        return 10 ** 6
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(text[:len(fmt) + 4].strip(), fmt)
        except ValueError:
            continue
        return max(0, (datetime.now() - dt).days)
    return 10 ** 6


def _find_outstanding_wrong_practice(student_username: str, within_days: int = 7) -> int:
    """最近 within_days 天内、还没作答的错题巩固会话 id, 没有则 0。

    时间窗是必须的：旧实现只看"存在未作答会话"，学生漏做一次就永久失去自动巩固
    资格（实测有挂了 9 天没人做的会话，把 99 道待掌握错题的学生彻底挡在门外）。
    """
    cutoff = (datetime.now() - timedelta(days=max(0, within_days))).strftime("%Y-%m-%d %H:%M:%S")
    rows = execute_query(
        """SELECT ps.id FROM practice_sessions ps
           WHERE ps.source = 'wrong_book' AND ps.status = 'active'
             AND ps.target_students LIKE ? AND ps.created_at >= ?
             AND NOT EXISTS (SELECT 1 FROM practice_attempts pa
                             WHERE pa.session_id = ps.id AND pa.student_username = ?)
           ORDER BY ps.id DESC LIMIT 1""",
        (_target_like(student_username), cutoff, student_username),
    )
    return int(rows[0]["id"]) if rows else 0


def _last_wrong_practice_at(student_username: str) -> str:
    rows = execute_query(
        "SELECT MAX(created_at) AS t FROM practice_sessions"
        " WHERE source='wrong_book' AND target_students LIKE ?",
        (_target_like(student_username),),
    )
    if not rows or not rows[0]["t"]:
        return ""
    return str(rows[0]["t"])


def _expire_stale_wrong_practice(student_username: str, within_days: int) -> int:
    """把超期还没人做的巩固会话置为 ended，免得练习列表里堆一堆僵尸条目。"""
    cutoff = (datetime.now() - timedelta(days=max(0, within_days))).strftime("%Y-%m-%d %H:%M:%S")
    n = execute_update(
        """UPDATE practice_sessions SET status='ended', updated_at=?
           WHERE source='wrong_book' AND status='active' AND created_at < ?
             AND target_students LIKE ?
             AND NOT EXISTS (SELECT 1 FROM practice_attempts pa
                             WHERE pa.session_id = practice_sessions.id AND pa.student_username = ?)""",
        (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), cutoff,
         _target_like(student_username), student_username),
    )
    return int(n or 0)


def _recent_practice_question_ids(student_username: str, sets: int) -> set[int]:
    """最近 sets 组巩固练习里出过的题。

    刚做过的题马上原样再来一遍没有训练价值，只会让学生觉得错题本永远清不完。
    """
    if sets <= 0:
        return set()
    rows = execute_query(
        """SELECT psq.question_id FROM practice_session_questions psq
           JOIN practice_sessions ps ON ps.id = psq.session_id
           WHERE ps.source = 'wrong_book' AND ps.target_students LIKE ?
             AND ps.id IN (SELECT id FROM practice_sessions
                           WHERE source = 'wrong_book' AND target_students LIKE ?
                           ORDER BY id DESC LIMIT ?)""",
        (_target_like(student_username), _target_like(student_username), int(sets)),
    )
    return {int(r["question_id"]) for r in rows if r.get("question_id") is not None}


def _notify_wrong_practice(student_username: str, session_id: int, count: int) -> None:
    """布置完要出声。以前只把会话塞进练习列表，学生不点开就永远不知道（作答率 0/2）。"""
    try:
        from backend.api.notification_router import notify_users
        # 通知"类型"要在系统配置(通知类型)里启用才投得出去，站内只有 exam/info/task 常开；
        # 沿用「教师一键提醒未提交」的既有约定：type=info + source_type=practice。
        notify_users(
            [student_username], "info", "错题巩固练习已布置",
            f"你的待掌握错题较多，已为你准备 {count} 道巩固题",
            f"/practice?open={session_id}",
            source_type="practice", source_id=str(session_id),
        )
    except Exception as e:
        logger.warning(f"[错题巩固] 通知发送失败 student={student_username} session={session_id}: {e}")


def _evaluate_wrong_practice(student_username: str) -> dict[str, Any]:
    """统一判定"现在该不该给这个学生自动生成一组"，触发器与状态查询共用一份逻辑。"""
    policy = wrong_practice_policy()
    rows = db_dict(
        "SELECT COUNT(*) AS c FROM wrong_book WHERE student_username=? AND status='pending'",
        (student_username,),
    ) or []
    pending_total = int(rows[0]["c"] or 0) if rows else 0
    last_at = _last_wrong_practice_at(student_username)
    days_since = _days_since(last_at)
    outstanding = _find_outstanding_wrong_practice(student_username, policy["interval_days"])
    if pending_total <= policy["threshold"]:
        ready, reason = False, "below_threshold"
    elif outstanding:
        ready, reason = False, "outstanding"
    elif days_since < policy["interval_days"]:
        ready, reason = False, "cooldown"
    else:
        ready, reason = True, "ready"
    return {
        "policy": policy,
        "pending_total": pending_total,
        "last_created_at": last_at,
        "days_since_last": (None if not last_at else days_since),
        "outstanding_id": outstanding,
        "next_in_days": (0 if ready else max(0, policy["interval_days"] - days_since)),
        "ready": ready,
        "reason": reason,
    }


def create_wrong_book_practice(student_username: str, count: int = 5, notify: bool = True) -> int:
    """从该生待掌握错题里抽题组成一组巩固练习, 返回 session_id, 0 表示没题可出。

    题已下架(status != active)的不进练习, 但错题本仍保留记录(W14)。
    notify=False 用于学生自助场景：人就在页面上，再发一条通知纯属噪音。
    """
    import random as _random
    from backend.question_db import execute_insert as q_ins, execute_update as q_upd

    if not student_username:
        return 0
    want = max(1, min(int(count or 5), 20))
    _backfill_wrong_book(student_username)
    rows = db_dict(
        """SELECT question_id, COALESCE(wrong_count, 1) AS wc,
                  COALESCE(NULLIF(last_wrong_at, ''), created_at) AS lw
           FROM wrong_book WHERE student_username=? AND status='pending'""",
        (student_username,),
    ) or []
    rows = [r for r in rows if r.get("question_id") is not None]
    if not rows:
        return 0

    meta = _question_meta_map([r["question_id"] for r in rows])
    usable = [r for r in rows if (meta.get(r["question_id"]) or {}).get("status") == "active"]
    if not usable:
        return 0

    # 错得多的优先，错次数相同则最久没碰的优先；再避开最近几组刚出过的题。
    # 排除后不够一组就退回全集，不能因为"避开"把练习卡死。
    ranked = sorted(usable, key=lambda r: (-int(r["wc"] or 1), str(r["lw"] or "")))
    avoid = wrong_practice_policy().get("avoid_recent_sets", 3)
    recent = _recent_practice_question_ids(student_username, avoid)
    fresh = [r for r in ranked if int(r["question_id"]) not in recent]
    pool = fresh if len(fresh) >= want else ranked
    # 只在优先级最高的 want*3 里打散：既保住排序，又不至于每次都是同一批
    top = pool[:want * 3]
    _random.shuffle(top)
    selected = [int(r["question_id"]) for r in top[:want]]

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    title = f"错题巩固练习（{now[:10]}）"
    target_students_str = json.dumps([student_username], ensure_ascii=False)
    session_id = q_ins(
        """INSERT INTO practice_sessions
           (title, knowledge_points, creator_username, subject, question_count,
            total_score, target_grade, target_class, target_students, source, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,'wrong_book','active',?,?)""",
        (title, "错题巩固", "system", "", len(selected), 0, "", "", target_students_str, now, now),
    )
    # 按题量折算百分制(与手动布置同步练习同一口径, 5 题=每题 20 分)
    from backend.utils import distribute_scores
    per_scores = distribute_scores(len(selected), 100)
    total_score = 0
    for i, qid in enumerate(selected):
        q_ins(
            "INSERT INTO practice_session_questions (session_id, question_id, sort_order, score) VALUES (?,?,?,?)",
            (session_id, int(qid), i, per_scores[i]),
        )
        total_score += per_scores[i]
    q_upd("UPDATE practice_sessions SET total_score=? WHERE id=?", (total_score, session_id))
    logger.info(
        f"[错题巩固] 生成 session={session_id} 学生={student_username} "
        f"抽题={len(selected)} 待掌握错题={len(rows)} 避开最近{avoid}组"
    )
    if session_id and notify:
        _notify_wrong_practice(student_username, int(session_id), len(selected))
    return session_id or 0


def check_and_auto_generate_wrong_practice(student_username: str, threshold: int | None = None) -> int:
    """阈值与冷却都过了才生成一组错题巩固练习；每种跳过原因都写日志。

    W10: 只查 wrong_book(表已由回填保证有数据), 不再每次全量解析历史答卷 JSON;
    本函数是同步的, 调用方应通过 backend.async_utils.spawn_bg 放到后台线程执行。
    threshold 只为旧调用方/测试保留，平时留空由系统配置决定。
    """
    if not student_username:
        return 0
    # 见 _student_lock：并发触发会生成两份重复练习
    with _student_lock(student_username):
        return _check_and_auto_generate_wrong_practice(student_username, threshold)


def _check_and_auto_generate_wrong_practice(student_username: str, threshold: int | None = None) -> int:
    """check_and_auto_generate_wrong_practice 的无锁实现，调用方必须已持有该生的锁。"""
    _backfill_wrong_book(student_username)
    state = _evaluate_wrong_practice(student_username)
    if threshold is not None and state["pending_total"] <= threshold:
        state = {**state, "ready": False, "reason": "below_threshold"}
    if not state["ready"]:
        logger.info(
            f"[错题巩固] 跳过({student_username}) 原因={state['reason']} "
            f"待掌握={state['pending_total']} 阈值={state['policy']['threshold']} "
            f"未作答会话={state['outstanding_id'] or '-'} 距上一组={state['days_since_last']}"
        )
        return 0
    _expire_stale_wrong_practice(student_username, state["policy"]["interval_days"])
    session_id = create_wrong_book_practice(student_username, state["policy"]["per_set"])
    if not session_id:
        logger.info(f"[错题巩固] 跳过({student_username}) 原因=no_usable_question 待掌握={state['pending_total']}")
    return session_id


def _students_with_pending_wrong(limit: int = 200) -> list[str]:
    rows = db_dict(
        "SELECT DISTINCT student_username FROM wrong_book WHERE status='pending' LIMIT ?",
        (limit,),
    ) or []
    return [str(r["student_username"]) for r in rows if r.get("student_username")]


@router.get("/practice/auto-status", summary="错题巩固自动布置的策略与该生当前状态")
async def wrong_practice_auto_status(
    request: Request,
    student_username: str = Query("", description="学生用户名"),
):
    """给教师端看"为什么没自动布置"：阈值/每组题数/间隔 + 该生的实际判定结果。

    判定逻辑与自动触共用 `_evaluate_wrong_practice`，两边不会各说一套。
    """
    user = get_current_user(request)
    target = _assert_can_access_student(user, student_username)
    if not target:
        raise HTTPException(status_code=400, detail="请先选择学生")
    _backfill_wrong_book(target)
    state = _evaluate_wrong_practice(target)
    return {"student_username": target, **state}


@router.get("/practice/check-auto", summary="学生端检查是否需要错题巩固练习")
async def check_auto_wrong_practice(request: Request):
    """学生登录后触发: 超过阈值则后台生成巩固练习(W10: 不再在请求里做重活)"""
    user = get_current_user(request)
    username = user["username"]
    if user.get("role", 2) != 2:
        return {"message": "仅学生触发", "checked": False}

    pending_rows = db_exec(
        "SELECT COUNT(*) FROM wrong_book WHERE student_username=? AND status='pending'",
        (username,),
    )
    pending_total = pending_rows[0][0] if pending_rows else 0
    spawned = spawn_bg(check_and_auto_generate_wrong_practice, username, name=f"错题巩固练习检查({username})")
    return {
        "message": "错题巩固练习检查已提交后台" if spawned else "已同步完成检查",
        "checked": True,
        "pending_total": pending_total,
    }


@router.post("/practice/auto-trigger", summary="手动触发自动生成错题巩固练习")
async def trigger_auto_wrong_practice(request: Request):
    """教师/管理员触发错题巩固练习生成(W10: 限定任教范围 + 全部放后台执行)"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="仅教师和管理员可触发")

    try:
        body = await request.json()
    except Exception:
        body = {}
    target = (body.get("student_username") or request.query_params.get("student_username") or "").strip()
    force = bool(body.get("force"))

    if target:
        if role != 0:
            _check_teacher_can_view_student(username, target)
        if force:
            # 教师点名要一组：跳过阈值与冷却，但仍未作答的旧会话要沿用，别叠两份
            with _student_lock(target):
                state = _evaluate_wrong_practice(target)
                if state["outstanding_id"]:
                    return {"message": "该生还有一组未完成的巩固练习，已直接沿用",
                            "session_id": state["outstanding_id"], "reused": True, "dispatched": [target]}
                session_id = create_wrong_book_practice(target, state["policy"]["per_set"])
                if not session_id:
                    raise HTTPException(status_code=400, detail="没有可出的题（待掌握错题可能都已下架）")
                return {"message": f"已为 {target} 布置一组错题巩固练习",
                        "session_id": session_id, "reused": False,
                        "question_count": _practice_question_count(int(session_id)), "dispatched": [target]}
        spawn_bg(check_and_auto_generate_wrong_practice, target, name=f"错题巩固练习({target})")
        return {"message": f"已为 {target} 提交后台检查", "dispatched": [target]}

    candidates = _students_with_pending_wrong()
    if role != 0:
        allowed = [
            stu for stu in candidates
            if is_student_in_teacher_scope(stu, username)
        ]
    else:
        allowed = candidates
    for stu in allowed:
        spawn_bg(check_and_auto_generate_wrong_practice, stu, name=f"错题巩固练习({stu})")
    return {
        "message": f"已提交 {len(allowed)} 名学生的错题巩固练习检查(后台执行)",
        "dispatched": allowed[:50],
        "dispatched_total": len(allowed),
    }


# ═══════════════════════════════════════════════
# 错题本增强：AI 补解析 / 学生自助巩固练习 / 导出 Word
# ═══════════════════════════════════════════════

_STATUS_LABELS = {"pending": "待掌握", "mastered": "已掌握", "all": "全部"}
_TYPE_LABELS = {"single": "单选题", "multiple": "多选题", "true_false": "判断题", "short": "简答题",
                "fill": "填空题", "essay": "作文题", "code": "编程题"}


def _options_text(raw: Any) -> str:
    """把题库 options(JSON 串或 dict) 压成一行文本, 喂模型或写进 Word 都用它。"""
    try:
        opts = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except (json.JSONDecodeError, TypeError):
        return ""
    if not isinstance(opts, dict):
        return ""
    return "；".join(f"{k}. {v}" for k, v in opts.items())


def _md_to_text(raw: Any) -> str:
    """题干与解析带 Markdown/公式记号, Word 里不渲染, 落笔前清成纯文本。"""
    text = str(raw or "")
    text = re.sub(r"`+", "", text)
    text = re.sub(r"\*\*|__|~~", "", text)
    text = re.sub(r"^\s{0,3}#{1,6}\s*", "", text, flags=re.M)
    text = text.replace("$", "")
    return text.strip()


def _letters(raw: Any) -> set[str]:
    """答案串里的选项字母集合(多选按每个字母算命中)。"""
    return {c for c in str(raw or "").upper() if c.isalpha()}


class ExplanationGenerateRequest(BaseModel):
    question_ids: list[int] = []
    student_username: str = ""
    overwrite: bool = False  # 默认只补空解析, 不动老师已写好的


@router.post("/explanation/generate", summary="AI 补全错题解析（写回题库）")
async def generate_wrong_explanations(req: ExplanationGenerateRequest, request: Request):
    """给没有解析的错题生成讲解并写回 question_bank.explanation(异步任务)。

    只补空、不覆盖(与题库「AI 补标」同一口径): 老师手写的解析永远优先。
    解析落在题库而不是错题本快照上, 是因为一道题的讲解属于题本身, 不该按学生存一份;
    代价是老师改了题目解析后, 学生错题本里看到的会跟着变 —— 这是有意保持一致。
    """
    user = get_current_user(request)
    username = user["username"]
    # 学生一律本人, 教师限任教范围; 目标学生只影响"针对谁的错误答案讲"
    target = _assert_can_access_student(user, req.student_username)

    qids: list[int] = []
    for raw in req.question_ids or []:
        qid = _to_int(raw)
        if qid is not None and qid not in qids:
            qids.append(qid)
    if not qids:
        raise HTTPException(status_code=400, detail="缺少 question_ids")
    if len(qids) > 20:
        raise HTTPException(status_code=400, detail=f"单次最多补 20 道题（当前 {len(qids)}）")

    meta = _question_meta_map(qids)
    todo: list[tuple[int, dict]] = []
    missing_from_bank: list[int] = []
    for qid in qids:
        q = meta.get(qid)
        if not q:
            missing_from_bank.append(qid)
            continue
        if not req.overwrite and str(q.get("explanation") or "").strip():
            continue
        todo.append((qid, q))
    if not todo:
        return {"task_id": 0, "todo": 0, "requested": len(qids), "missing_from_bank": missing_from_bank,
                "message": "所选错题都已有解析"}

    keys = get_api_keys(username)
    api_key = keys[0] if keys and keys[0] else ""
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")

    wrong_map: dict[int, str] = {}
    if target:
        for r in db_dict("SELECT question_id, wrong_answer FROM wrong_book WHERE student_username=?",
                         (target,)) or []:
            try:
                wrong_map[int(r["question_id"])] = str(r.get("wrong_answer") or "")
            except (TypeError, ValueError):
                continue

    from backend.prompts.wrong_book import WRONG_BOOK_EXPLAIN_PROMPT
    from backend.ai_task_manager import task_manager

    overwrite = req.overwrite

    async def _do() -> dict[str, Any]:
        import asyncio
        from backend.question_db import execute_update as q_upd

        def _safe(s: Any) -> str:
            return str("" if s is None else s).replace("{", "{{").replace("}", "}}")

        sem = asyncio.Semaphore(3)

        async def _one(qid: int, q: dict) -> dict[str, Any]:
            async with sem:
                prompt = WRONG_BOOK_EXPLAIN_PROMPT.format(
                    question_text=_safe(q.get("question_text")),
                    question_type=_safe(_TYPE_LABELS.get(q.get("type"), q.get("type"))),
                    options=_safe(_options_text(q.get("options")) or "（非选择题）"),
                    correct_answer=_safe(q.get("correct_answer")),
                    student_answer=_safe(wrong_map.get(qid) or "（未记录）"),
                    knowledge_points=_safe(q.get("knowledge_points")),
                )
                prompt = apply_skills(prompt, "wrong-book")
                try:
                    text = await call_ai_async(prompt, api_key, use_kb=False)
                except Exception as e:
                    logger.warning(f"[错题本] AI 解析生成失败 qid={qid}: {e}")
                    return {"question_id": qid, "saved": False, "error": str(e)[:160]}
                text = str(text or "").strip()
                if len(text) < 10:
                    return {"question_id": qid, "saved": False, "error": "AI 未返回有效解析"}
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                if overwrite:
                    n = q_upd("UPDATE question_bank SET explanation=?, updated_at=? WHERE id=?",
                              (text[:4000], now, qid))
                else:
                    n = q_upd("""UPDATE question_bank SET explanation=?, updated_at=?
                                 WHERE id=? AND (explanation IS NULL OR TRIM(explanation)='')""",
                              (text[:4000], now, qid))
                return {"question_id": qid, "saved": bool(n)}

        raw = await asyncio.gather(*[_one(qid, q) for qid, q in todo], return_exceptions=True)
        results: list[dict[str, Any]] = []
        for i, r in enumerate(raw):
            if isinstance(r, Exception):
                logger.error(f"[错题本] AI 解析任务异常 qid={todo[i][0]}: {r}")
                results.append({"question_id": todo[i][0], "saved": False, "error": str(r)[:160]})
            else:
                results.append(r)
        saved = sum(1 for r in results if r.get("saved"))
        logger.info(f"[错题本] AI 补解析完成: {saved}/{len(todo)} 学生={target or '-'} 操作人={username}")
        return {"saved": saved, "total": len(todo), "results": results}

    task_id = await task_manager.create_task(
        description=f"错题解析补全({target or username})", coro_factory=_do,
        dedupe_key=f"wb-explain:{target or username}", max_concurrent=2,
    )
    return {"task_id": task_id, "todo": len(todo), "requested": len(qids),
            "missing_from_bank": missing_from_bank, "student_username": target}


def _practice_question_count(session_id: int) -> int:
    """一组练习实际有几道题。practice_* 表在 questions.db, 别用主库连接去查。"""
    rows = execute_query("SELECT COUNT(*) AS cnt FROM practice_session_questions WHERE session_id=?",
                         (session_id,))
    return int(rows[0]["cnt"]) if rows else 0


@router.post("/practice/self", summary="学生自助生成或继续错题巩固练习")
async def self_wrong_practice(request: Request):
    """学生点「错题巩固」: 有未作答的一组就直接给回去, 没有就现抽一组。

    以前学生端这个按钮只弹一句提示(后端能力全在教师侧), 现在补上自助入口;
    题量上限 10 道, 避免一次抽太多把练习做成考试。
    """
    user = get_current_user(request)
    if user.get("role", 2) != 2:
        raise HTTPException(status_code=403, detail="仅学生可自助生成练习")
    username = user["username"]
    try:
        body = await request.json()
    except Exception:
        body = {}
    count = _to_int(body.get("count")) or 5
    count = max(1, min(count, 10))

    with _student_lock(username):
        outstanding = _find_outstanding_wrong_practice(
            username, wrong_practice_policy()["interval_days"])
        if outstanding:
            return {"session_id": outstanding, "reused": True,
                    "question_count": _practice_question_count(outstanding),
                    "message": "已有一组未完成的错题巩固练习"}
        session_id = create_wrong_book_practice(username, count, notify=False)
    if not session_id:
        raise HTTPException(status_code=400, detail="暂无可用于巩固的错题（可能都已掌握，或题目已下架）")
    n = _practice_question_count(session_id)
    return {"session_id": session_id, "reused": False, "question_count": n,
            "message": f"已生成 {n} 道错题巩固练习"}


@router.get("/export", summary="导出错题本为 Word 文档（含作答对照与解析）")
async def export_wrong_book_docx(request: Request, status: str = Query("pending")):
    """按来源分组导出错题: 题干 / 选项 / 我的选择 / 正确答案 / 解析 / 知识点。

    直接复用 /list 的组装结果, 保证"页面上看到的"和"导出来的"永远是同一份。
    """
    import io as _io
    import urllib.parse
    from docx import Document
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from fastapi.responses import StreamingResponse

    user = get_current_user(request)
    target = _assert_can_access_student(user, request.query_params.get("student_username", ""))
    if not target:
        raise HTTPException(status_code=400, detail="请先选择学生")

    payload = await get_wrong_questions(request, status)
    exams = payload.get("exams") or []
    if not exams:
        raise HTTPException(status_code=400, detail="没有可导出的错题")

    urows = user_query("SELECT name, grade, class FROM users WHERE username=?", (target,))
    student_name = (urows[0][0] or target) if urows else target
    student_grade = (urows[0][1] or "") if urows else ""
    student_class = str(urows[0][2] or "") if urows else ""
    status_label = _STATUS_LABELS.get(status, status)

    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal.font.size = Pt(11)
    normal.paragraph_format.line_spacing = 1.4

    heading = doc.add_heading(f"{student_name} 的错题本（{status_label}）", level=1)
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER
    info = doc.add_paragraph()
    info.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = info.add_run(
        f"年级：{student_grade}  班级：{student_class}班  错题：{payload.get('total_wrong', 0)} 道"
        f"  来源：{len(exams)} 场  导出时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}"
    )
    run.font.size = Pt(10)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)

    seq = 0
    for gi, exam in enumerate(exams, 1):
        doc.add_heading(f"{gi}. {exam.get('exam_title') or '错题来源'}", level=2)
        bits = [str(x) for x in [
            exam.get("exam_subject") or "",
            f"{exam.get('wrong_count', len(exam.get('wrong_questions') or []))} 道错题",
            (f"得分 {exam.get('score')}/{exam.get('total_score')}"
             if exam.get("score") is not None and exam.get("total_score") else ""),
            str(exam.get("submitted_at") or "")[:10],
        ] if x]
        if bits:
            meta = doc.add_paragraph("  ·  ".join(bits))
            meta.runs[0].font.color.rgb = RGBColor(0x88, 0x88, 0x88)

        for q in exam.get("wrong_questions") or []:
            seq += 1
            qtype = _TYPE_LABELS.get(q.get("question_type"), q.get("question_type") or "题目")
            doc.add_heading(f"第 {seq} 题（{qtype}）", level=3)
            doc.add_paragraph(_md_to_text(q.get("question_text")))

            opts = q.get("options") or {}
            right_letters = _letters(q.get("correct_answer"))
            mine_letters = _letters(q.get("student_answer"))
            if opts:
                for key, val in opts.items():
                    marks = []
                    if str(key).upper() in right_letters:
                        marks.append("正确答案")
                    if str(key).upper() in mine_letters:
                        marks.append("你的选择")
                    p = doc.add_paragraph(f"{key}. {_md_to_text(val)}")
                    if marks:
                        r = p.add_run(f"  【{'、'.join(marks)}】")
                        r.bold = True
                        r.font.color.rgb = (RGBColor(0x1E, 0x87, 0x41) if "正确答案" in marks
                                            else RGBColor(0xC0, 0x39, 0x2B))
            else:
                doc.add_paragraph(f"我的作答：{_md_to_text(q.get('student_answer')) or '（未作答）'}")
                doc.add_paragraph(f"参考答案：{_md_to_text(q.get('correct_answer')) or '—'}")

            line = doc.add_paragraph()
            line.add_run("你的选择：").bold = True
            line.add_run(f"{q.get('student_answer') or '（未作答）'}    ")
            line.add_run("正确答案：").bold = True
            line.add_run(str(q.get("correct_answer") or "—"))

            exp = _md_to_text(q.get("explanation"))
            p = doc.add_paragraph()
            if exp:
                p.add_run("解析：").bold = True
                p.add_run(exp)
            else:
                r = p.add_run("解析：（题库暂无，可在错题本页点「AI 补全解析」生成）")
                r.font.color.rgb = RGBColor(0x99, 0x99, 0x99)

            if q.get("knowledge_points"):
                kp = doc.add_paragraph()
                kp.add_run("知识点：").bold = True
                kp.add_run(str(q.get("knowledge_points")))

    buf = _io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    filename = urllib.parse.quote(f"{student_name}_错题本_{status_label}.docx")
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )
