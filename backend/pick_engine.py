"""抽人共用引擎（智能点名 / 课堂抽问 / 课堂闯关共用一份权重、一份台账）

背景（2026-10）：三个活动的抽人**算法**早就共用一份（`_weighted_pick`/`_apply_decay`
从 rollcall_router 导入），但**状态各存各的**：点名存 rollcall_weights/rollcall_meta，
抽问存 class_drill_sessions.weights，闯关存 class_ladder_sessions.weights。后果是
"抽问抽过两次的人，点名照样可能第三次抽到"，三处 60% 覆盖重置也各算各的。

本模块把状态收拢成一处，口径如下：

1. **作用域 = 班级**（grade + class_name），不含 teacher。
   点名旧表的键含 teacher_username，同班换老师/管理员代课就是两份权重；公平性属于
   班级，操作人只作为 ledger.teacher_username 记录在册。
2. **学生主键 = username（学号）**，姓名只做展示快照。
   旧表按姓名记账：同班同名会共用权重、互相顶记录；名册里没有学号的学生退化成
   `NAME:<姓名>` 键，宁可看见重复姓名，也不要静默丢人。
3. **一份权重、一份本轮覆盖标记、一张抽人台账**（pick_state / pick_round / pick_ledger）。
   台账一行 = 一次抽人；抽问的题目、闯关的关卡明细仍留在各自表里，台账只记"谁、何时、
   哪个活动、结果如何"，所以"共一个记录"是一处看全，而不是把三种数据搅进一张表。
4. **写并发**：抽人是"读权重→改→写回"，旧实现是整班 DELETE+INSERT 快照写回，
   两台大屏同班同时操作必丢更新。这里一条 UPDATE 只动被抽中那一行，
   整段跑在 `BEGIN IMMEDIATE` 里（拿写锁后再读权重），同班并发改为串行等待。

权重模型与旧实现逐条对齐（不改公平性口径）：初始 10，抽中 -3（保底 1），
答对 +1（封顶 10），距上次抽人 ≥2 分钟按 `elapsed*0.3` 自然回升，
本轮覆盖达 60% 自动开新一轮。
"""
from __future__ import annotations

import json
import random
import sqlite3
import time
from contextlib import contextmanager
from typing import Any

from backend import database as _database
from backend.database import execute_query_dict
from backend.score_utils import load_students
from backend.logger import logger

#: 台账里的活动标识（前端筛选与统计口径都以此为准）
ACT_ROLLCALL = "rollcall"
ACT_DRILL = "class_drill"
ACT_LADDER = "class_ladder"
ACTIVITIES = (ACT_ROLLCALL, ACT_DRILL, ACT_LADDER)
ACTIVITY_LABELS = {
    ACT_ROLLCALL: "智能点名",
    ACT_DRILL: "课堂抽问",
    ACT_LADDER: "课堂闯关",
}

#: 抽中一名学生后权重下调；答对再 +1（与旧实现一致）
WEIGHT_BASE = 10.0
WEIGHT_MIN = 1.0
WEIGHT_MAX = 10.0
PICK_PENALTY = 3.0
CORRECT_BONUS = 1.0
RECOVERY_MINUTES = 2.0
RECOVERY_RATE = 0.3
#: 本轮覆盖到这个名字比例就自动开新轮
ROUND_RESET_RATIO = 0.6

#: 台账行的"未作答"状态：抽到了但老师还没判定结果
PENDING = "pending"


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def name_key(name: str) -> str:
    """名册里没有学号的学生，用姓名造一个稳定键（绝不与真实学号撞车）。"""
    return f"NAME:{(name or '').strip()}"


def student_key(username: str, name: str) -> str:
    """记账主键：一律以学号（username）为准，缺学号才退化到姓名键。"""
    u = (username or "").strip()
    return u if u else name_key(name)


def weighted_pick(weights: dict[str, float]) -> str | None:
    """权重越高越可能被选到，保底权重 1（原 rollcall_router._weighted_pick）。"""
    names = list(weights.keys())
    if not names:
        return None
    vals = [(n, max(WEIGHT_MIN, weights[n])) for n in names]
    total = sum(w for _, w in vals)
    r = random.random() * total
    for name, w in vals:
        r -= w
        if r <= 0:
            return name
    return vals[-1][0]


def apply_decay(weights: dict[str, float], last_time: float | None) -> float:
    """距上次抽人 ≥2 分钟就整体回升（原 rollcall_router._apply_decay，口径不动）。"""
    if not last_time:
        return time.time()
    elapsed = (time.time() - last_time) / 60
    if elapsed >= RECOVERY_MINUTES:
        for s in weights:
            weights[s] = min(WEIGHT_MAX, weights[s] + elapsed * RECOVERY_RATE)
        return time.time()
    return last_time


@contextmanager
def _immediate():
    """写锁事务：BEGIN IMMEDIATE 先取写锁，避免"读权重→改→写回"期间的丢更新。"""
    # DB_PATH 从 database 模块动态取，不在 import 时抓副本：测试与迁移脚本都会把
    # 它指到临时库，抓了副本就会打到生产库上
    conn = sqlite3.connect(str(_database.DB_PATH), timeout=30, check_same_thread=False)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def roster(grade: str, cls: str) -> list[dict[str, str]]:
    """本班名册：[{key, username, name}]，键=学号，顺序稳定（按姓名）。"""
    students = load_students(grade) or []
    out = []
    for s in students:
        if str(s.get("class") or "") != str(cls or ""):
            continue
        username = str(s.get("username") or "").strip()
        name = str(s.get("name") or "").strip()
        if not name and not username:
            continue
        out.append({"key": student_key(username, name), "username": username, "name": name})
    out.sort(key=lambda x: (x["name"], x["username"]))
    return out


def resolve_key(grade: str, cls: str, who: str) -> str:
    """把"姓名或学号"解析成本班记账主键（各活动的旧入参都是姓名，保持不变）。"""
    who = str(who or "").strip()
    if not who:
        return ""
    for r in roster(grade, cls):
        if who in (r["key"], r["username"], r["name"]):
            return r["key"]
    # 名册里没有：能查到 username 就按学号记账，否则退回姓名键，绝不静默丢记录
    row = execute_query_dict(
        "SELECT username, name FROM users WHERE role=2 AND (username=? OR name=?) LIMIT 1",
        (who, who),
    )
    if row:
        return student_key(row[0].get("username"), row[0].get("name"))
    return name_key(who)


def identity(grade: str, cls: str, who: str) -> tuple[str, str, str]:
    """把"姓名或学号"解析成 (记账主键, 学号, 姓名)。

    三处活动原先只往记录表写姓名，同班同名会互相顶记录；这里给它们一个
    统一的补学号入口，查不到学生时也照样返回姓名键，绝不因为解析失败就丢记录。
    """
    who = str(who or "").strip()
    if not who:
        return "", "", ""
    for r in roster(grade, cls):
        if who in (r["key"], r["username"], r["name"]):
            return r["key"], r["username"], r["name"]
    row = execute_query_dict(
        "SELECT username, name FROM users WHERE role=2 AND (username=? OR name=?) LIMIT 1",
        (who, who),
    )
    if row:
        u = str(row[0].get("username") or "").strip()
        return (u or name_key(row[0].get("name") or who)), u, str(row[0].get("name") or who)
    return name_key(who), "", who


def _load_state(c, grade: str, cls: str, rows: list[dict[str, str]]) -> dict[str, Any]:
    """取本班权重（缺行的学生按初始权重补齐）与本轮状态。"""
    weights = {
        r["student_key"]: float(r["weight"] if r["weight"] is not None else WEIGHT_BASE)
        for r in c.execute(
            "SELECT student_key, weight FROM pick_state WHERE grade=? AND class_name=?",
            (grade, cls),
        ).fetchall()
    }
    meta = c.execute(
        "SELECT round_no, picked, last_time FROM pick_round WHERE grade=? AND class_name=?",
        (grade, cls),
    ).fetchone()
    round_no = int(meta["round_no"]) if meta else 1
    picked = _loads(meta["picked"], []) if meta else []
    last_time = float(meta["last_time"]) if meta and meta["last_time"] is not None else None

    for r in rows:
        weights.setdefault(r["key"], WEIGHT_BASE)
    return {"weights": weights, "round_no": round_no, "picked": picked, "last_time": last_time}


def _loads(raw: Any, default):
    """容忍双重编码（点名/抽问都踩过：json 字符串又被 dumps 了一次）。"""
    if raw is None or raw == "":
        return default
    if isinstance(raw, (list, dict)):
        return raw
    try:
        val = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default
    while isinstance(val, str):
        try:
            val = json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return default
    return val if isinstance(val, (list, dict)) else default


def clean_note(raw: Any, limit: int = 24) -> str:
    """外部可传的"来源"标签：压掉换行、限长，别让它把台账列表撑破。"""
    text = " ".join(str(raw or "").split()).strip()
    return text[:limit]


def pick_next(*, grade: str, cls: str, activity: str, teacher: str = "",
              exclude: str = "", note: str = "") -> dict[str, Any] | None:
    """按班级共享权重抽一名学生，扣权重、记本轮、写台账，返回抽中者。

    exclude：本局已在台前的学生（闯关"请军师"要再抽一人，不能抽到自己）。
    本轮覆盖≥60% 或全员都抽过时自动开新一轮，与旧实现一致。
    """
    if not grade or not cls:
        return None
    note = clean_note(note)
    rows = roster(grade, cls)
    if not rows:
        return None
    by_key = {r["key"]: r for r in rows}

    with _immediate() as conn:
        c = conn.cursor()
        st = _load_state(c, grade, cls, rows)
        weights, picked = st["weights"], list(st["picked"])

        last_time = apply_decay(weights, st["last_time"])
        if len(picked) / max(1, len(rows)) >= ROUND_RESET_RATIO:
            picked = []
            st["round_no"] += 1
        available = {k: weights[k] for k in by_key if k not in picked}
        if not available:
            picked = []
            st["round_no"] += 1
            available = {k: weights[k] for k in by_key}
        if exclude:
            ex = resolve_key(grade, cls, exclude)
            if len(available) > 1 and ex in available:
                available = {k: w for k, w in available.items() if k != ex}

        key = weighted_pick(available)
        if not key:
            return None

        before = weights.get(key, WEIGHT_BASE)
        weights[key] = max(WEIGHT_MIN, before - PICK_PENALTY)
        picked.append(key)

        # 一条 UPDATE 只动被抽中那一行：整班快照写回在同班并发时会互相覆盖
        c.execute(
            "INSERT INTO pick_state (grade, class_name, student_key, student_username, student_name,"
            " weight, last_picked_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(grade, class_name, student_key) DO UPDATE SET"
            " weight=excluded.weight, student_username=excluded.student_username,"
            " student_name=excluded.student_name, last_picked_at=excluded.last_picked_at,"
            " updated_at=excluded.updated_at",
            (grade, cls, key, by_key[key]["username"], by_key[key]["name"],
             weights[key], _now(), _now()),
        )
        # 其余学生把回升后的权重落盘，保证"下一节课继续衰减"这件事不丢
        for k, w in weights.items():
            if k == key:
                continue
            r = by_key.get(k)
            if not r:
                continue
            c.execute(
                "INSERT INTO pick_state (grade, class_name, student_key, student_username,"
                " student_name, weight, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(grade, class_name, student_key) DO UPDATE SET weight=excluded.weight,"
                " student_username=excluded.student_username, student_name=excluded.student_name,"
                " updated_at=excluded.updated_at",
                (grade, cls, k, r["username"], r["name"], w, _now()),
            )
        c.execute(
            "INSERT INTO pick_round (grade, class_name, round_no, picked, last_time, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(grade, class_name) DO UPDATE SET round_no=excluded.round_no,"
            " picked=excluded.picked, last_time=excluded.last_time, updated_at=excluded.updated_at",
            (grade, cls, st["round_no"], json.dumps(picked, ensure_ascii=False),
             last_time, _now()),
        )
        c.execute(
            "INSERT INTO pick_ledger (activity, teacher_username, grade, class_name, student_key,"
            " student_username, student_name, round_no, result, points, note, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
            (activity, teacher, grade, cls, key, by_key[key]["username"], by_key[key]["name"],
             st["round_no"], PENDING, note, _now()),
        )
        pick_id = c.lastrowid

    _mirror_legacy_rollcall(grade, cls, teacher, weights, by_key, key, picked,
                            by_key[key]["name"], last_time, st["round_no"])
    logger.info(
        "[抽人] %s %s/%s → %s(%s) 权重 %.1f→%.1f 第%d轮"
        % (ACTIVITY_LABELS.get(activity, activity), grade, cls, by_key[key]["name"],
           by_key[key]["username"] or "-", before, weights[key], st["round_no"])
    )
    return {
        "name": by_key[key]["name"],
        "username": by_key[key]["username"],
        "student_key": key,
        "pick_id": pick_id,
        "weight_before": round(before, 2),
        "weight": round(weights[key], 2),
        "round_no": st["round_no"],
        "covered": len(set(picked)),
        "total": len(rows),
    }


def _mirror_legacy_rollcall(grade, cls, teacher, weights, by_key, key, picked,
                            name, last_time, round_no) -> None:
    """把本班权重/本轮回写进点名旧表，让点名管理的旧视图继续有数。

    引擎才是权威；这两张表只保留给 `/rollcall/admin/sessions`（按 rollcall_weights
    统计班级人数）与 `/admin/detail` 的历史展示，避免一次性改动四个页面。
    """
    if not teacher:
        return
    try:
        with _immediate() as conn:
            c = conn.cursor()
            picked_names = [by_key[k]["name"] for k in picked if k in by_key]
            # 旧表按姓名建键，同名两人只能合并成一行：取**最小权重**（谁最可能被抽过就按谁记），
            # 宁可让旧视图少抽一次，也不要显示成"这俩人都没被抽过"
            by_name: dict[str, float] = {}
            for k, w in weights.items():
                r = by_key.get(k)
                if r:
                    by_name[r["name"]] = min(by_name.get(r["name"], w), w)
            for name, w in by_name.items():
                c.execute(
                    "INSERT INTO rollcall_weights (teacher_username, grade, class_name, student_name, weight)"
                    " VALUES (?, ?, ?, ?, ?)"
                    " ON CONFLICT(teacher_username, grade, class_name, student_name)"
                    " DO UPDATE SET weight=excluded.weight",
                    (teacher, grade, cls, name, w),
                )
            c.execute(
                "INSERT INTO rollcall_meta (teacher_username, grade, class_name, last_time,"
                " picked_in_round, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))"
                " ON CONFLICT(teacher_username, grade, class_name) DO UPDATE SET"
                " last_time=excluded.last_time, picked_in_round=excluded.picked_in_round,"
                " updated_at=excluded.updated_at",
                (teacher, grade, cls, last_time, json.dumps(picked_names, ensure_ascii=False)),
            )
    except Exception as e:   # 镜像失败不能拖垮抽人本体
        logger.warning(f"[抽人] 点名旧表镜像失败 {grade}/{cls}: {e}")


def bonus_for_correct(*, grade: str, cls: str, student: str = "",
                     student_key: str = "") -> None:
    """答回来加权重（封顶 10）：点名标对、抽问答对、闯关过关共用这一处。

    `student_key` 优先：同班两个同名学生时，按姓名反查会加到错的人头上，
    调用方手里有台账行（pick_id / ref 指针）就一定把 key 传进来。
    """
    key = student_key or resolve_key(grade, cls, student)
    if not key:
        return
    with _immediate() as conn:
        c = conn.cursor()
        row = c.execute(
            "SELECT weight FROM pick_state WHERE grade=? AND class_name=? AND student_key=?",
            (grade, cls, key),
        ).fetchone()
        w = min(WEIGHT_MAX, (float(row["weight"]) if row else WEIGHT_BASE) + CORRECT_BONUS)
        r = next((x for x in roster(grade, cls) if x["key"] == key),
             {"username": "", "name": student})
        c.execute(
            "INSERT INTO pick_state (grade, class_name, student_key, student_username, student_name,"
            " weight, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(grade, class_name, student_key) DO UPDATE SET weight=excluded.weight,"
            " student_username=excluded.student_username, student_name=excluded.student_name,"
            " updated_at=excluded.updated_at",
            (grade, cls, key, r["username"], r["name"], w, _now()),
        )


def _target_row(c, grade: str, cls: str, activity: str, name: str,
                pick_id: int | None = None):
    """找出这次判定要回填的那一行台账，找不到返回 None。

    优先级：调用方给的 pick_id > 本班该活动最近一条待作答（姓名或学号对得上）。
    存量 24 个 AI 生成的互动答题页面只回传姓名，同班两个"张三"时拿姓名去名册猜
    学号会记到错的人头上 —— 台账行里存着当初抽中者的学号，所以一律以它为准。
    """
    if pick_id:
        return c.execute(
            "SELECT id, student_key, student_username, student_name FROM pick_ledger WHERE id=?",
            (int(pick_id),),
        ).fetchone()
    return c.execute(
        "SELECT id, student_key, student_username, student_name FROM pick_ledger"
        " WHERE grade=? AND class_name=? AND activity=? AND result=?"
        "   AND (student_name=? OR student_username=?)"
        " ORDER BY id DESC LIMIT 1",
        (grade, cls, activity, PENDING, name, name),
    ).fetchone()


def resolve_pick(grade: str, cls: str, activity: str, student: str,
                 pick_id: int | None = None) -> dict[str, str]:
    """查"这次判定对应哪一次抽人"，返回 {student_key, student_username, student_name}。

    与 finish() 共用 _target_row，所以调用方可以在**写积分之前**就先拿到人 ——
    答对 +1 的权重、点名历史里的学号，都记到同一个学生身上。
    """
    name = str(student or "").strip()
    if not name:
        return {"student_key": "", "student_username": "", "student_name": ""}
    with _immediate() as conn:
        row = _target_row(conn.cursor(), grade, cls, activity, name, pick_id)
    if row:
        return {"student_key": str(row["student_key"] or ""),
                "student_username": str(row["student_username"] or ""),
                "student_name": str(row["student_name"] or name)}
    key, uname, dname = identity(grade, cls, name)
    return {"student_key": key, "student_username": uname, "student_name": dname}

def finish(*, grade: str, cls: str, activity: str, student: str, result: str,
           points: int = 0, pick_id: int | None = None,
           ref_table: str = "", ref_id: int | None = None, note: str = "",
           teacher: str = "") -> dict[str, Any]:
    """把一次抽人的结果回填到台账，返回 {"updated": 行数, "student_key": 权威学号键}。

    回填对象按三档优先级确定，且一律以台账行自带的人为准：
      1. 调用方给了 pick_id（点名页 / 抽问页 / AI 互动答题新模板都会回传）；
      2. 没给就找"本班该活动最近一条待作答、姓名或学号对得上"的行 ——
         存量 24 个 AI 生成的互动答题页面只回传姓名，同班两个"张三"时拿姓名去
         名册猜学号会把结果记到错的人头上，而台账行存着当初抽中者的学号；
      3. 都没有（键盘流没抽人就直接标结果）才补记一行。
    把 student_key 回给调用方，是为了让"答对 +1 权重"加到同一个人身上。
    """
    name = str(student or "").strip()
    if not name:
        return {"updated": 0, "student_key": ""}
    note = " ".join(str(note or "").split())[:60]
    with _immediate() as conn:
        c = conn.cursor()
        target = _target_row(c, grade, cls, activity, name, pick_id)
        if target:
            key = str(target["student_key"] or "") or resolve_key(grade, cls, name)
            cur = c.execute(
                "UPDATE pick_ledger SET result=?, points=?, ref_table=?, ref_id=?,"
                " student_username=?, student_name=?,"
                " teacher_username=CASE WHEN teacher_username='' THEN ? ELSE teacher_username END"
                " WHERE id=?",
                (result, points, ref_table, ref_id or 0,
                 target["student_username"] or "", target["student_name"] or name, teacher,
                 int(target["id"])),
            )
            if cur.rowcount:
                return {"updated": int(cur.rowcount), "student_key": key}

        key = resolve_key(grade, cls, name)
        r = next((x for x in roster(grade, cls) if x["key"] == key),
                 {"username": "", "name": name})
        c.execute(
            "INSERT INTO pick_ledger (activity, teacher_username, grade, class_name, student_key,"
            " student_username, student_name, result, points, ref_table, ref_id, note, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (activity, teacher, grade, cls, key, r["username"], r["name"], result, points,
             ref_table, ref_id or 0, note, _now()),
        )
        return {"updated": 1, "student_key": key}

def finish_by_ref(*, ref_table: str, ref_id: int, result: str, points: int = 0,
                  note: str = "") -> dict[str, Any]:
    """按明细指针回填台账（闯关结算用它：局记录里本来就有学生，不必再拿姓名反查）。"""
    if not ref_table or not ref_id:
        return 0
    with _immediate() as conn:
        c = conn.cursor()
        hit = c.execute(
            "SELECT id, note FROM pick_ledger WHERE ref_table=? AND ref_id=?"
            " ORDER BY (result=?) DESC, id DESC LIMIT 1",
            (ref_table, int(ref_id), PENDING),
        ).fetchone()
        if not hit:
            return {"updated": 0}
        # SQLite 的 UPDATE 不支持 ORDER BY/LIMIT（那是 MySQL 方言），一律先选 id 再按 id 改
        cur = c.execute(
            "UPDATE pick_ledger SET result=?, points=?, note=?"
            " WHERE id=?",
            (result, points, (hit["note"] or note), hit["id"]),
        )
        return {"updated": int(cur.rowcount)}


def attach_ref(*, pick_id: int | None = None, ref_table: str = "", ref_id: int | None = None) -> None:
    """把台账行与活动明细（题目/关卡）挂钩，记录页能一键跳到原始详情。"""
    if not pick_id:
        return
    with _immediate() as conn:
        conn.execute(
            "UPDATE pick_ledger SET ref_table=?, ref_id=? WHERE id=?",
            (ref_table, ref_id or 0, int(pick_id)),
        )


def stats(*, grade: str, cls: str) -> dict[str, Any]:
    """本班公平度概览：本轮已抽人数、名单人数、轮次、权重快照（按姓名，供旧界面显示）。"""
    rows = roster(grade, cls)
    by_key = {r["key"]: r for r in rows}
    # 只读，绝不能走 _immediate()：BEGIN IMMEDIATE 会为一次查询抢写锁，
    # 结果是页面刷新把正在进行的抽人堵住（点名页每 5 秒刷一次就是自锁）
    weight_rows = execute_query_dict(
        "SELECT student_key, weight FROM pick_state WHERE grade=? AND class_name=?", (grade, cls))
    weights = {r["student_key"]: float(r["weight"] or WEIGHT_BASE) for r in weight_rows}
    for r in rows:
        weights.setdefault(r["key"], WEIGHT_BASE)
    meta = execute_query_dict(
        "SELECT round_no, picked, last_time FROM pick_round WHERE grade=? AND class_name=?",
        (grade, cls))
    st = {
        "weights": weights,
        "round_no": int(meta[0]["round_no"]) if meta else 1,
        "picked": _loads(meta[0]["picked"], []) if meta else [],
    }
    return {
        "covered": len(set(st["picked"])),
        "total": len(rows),
        "round_no": st["round_no"],
        "picked": list(st["picked"]),
        "picked_names": [by_key[k]["name"] for k in st["picked"] if k in by_key],
        "weights": {by_key[k]["name"]: round(v, 2) for k, v in st["weights"].items() if k in by_key},
    }


def new_round(*, grade: str, cls: str, teacher: str = "") -> int:
    """手动换一轮（抽问/闯关"重新开始"、点名"重置本轮"）：只清本轮覆盖标记，不动权重。

    旧实现是"清空会话权重"，共享之后必须区分：抹掉权重等于把别的活动攒的公平性也清了。
    """
    with _immediate() as conn:
        c = conn.cursor()
        row = c.execute(
            "SELECT round_no FROM pick_round WHERE grade=? AND class_name=?", (grade, cls),
        ).fetchone()
        nxt = int(row["round_no"]) + 1 if row else 1
        c.execute(
            "INSERT INTO pick_round (grade, class_name, round_no, picked, last_time, updated_at)"
            " VALUES (?, ?, ?, '[]', ?, datetime('now','localtime'))"
            " ON CONFLICT(grade, class_name) DO UPDATE SET round_no=excluded.round_no,"
            " picked='[]', updated_at=excluded.updated_at",
            (grade, cls, nxt, time.time()),
        )
    if teacher:
        try:
            with _immediate() as conn:
                conn.execute(
                    "UPDATE rollcall_meta SET picked_in_round='[]', updated_at=datetime('now','localtime')"
                    " WHERE teacher_username=? AND grade=? AND class_name=?",
                    (teacher, grade, cls),
                )
        except Exception as e:
            logger.warning(f"[抽人] 点名旧表本轮镜像失败 {grade}/{cls}: {e}")
    return nxt


def reset_class(*, grade: str, cls: str, teacher: str = "") -> int:
    """把本班权重复位（点名管理"重置会话"）。

    删行即可：名册里缺行的学生按初始权重 10 处理；台账与点名历史是历史数据，一律不删。
    顺带开新一轮，让"重置"后的第一次抽人从干净的本轮覆盖标记开始。
    """
    rows = roster(grade, cls)
    with _immediate() as conn:
        n = conn.execute(
            "DELETE FROM pick_state WHERE grade=? AND class_name=?", (grade, cls),
        ).rowcount
    new_round(grade=grade, cls=cls, teacher=teacher)
    return int(n or 0) or len(rows)



def purge_student(username: str) -> int:
    """删除账号时清理抽人相关数据：权重行、本轮占用、台账行。

    台账一并删是**与既有口径对齐**：users_router 删账号本来就会删掉 rollcall_history
    里这个学生的记录；留着只会让"抽人记录"里出现查无此人的幽灵。
    返回删掉的权重行数，供日志核对。
    """
    username = str(username or "").strip()
    if not username:
        return 0
    with _immediate() as conn:
        c = conn.cursor()
        rows = c.execute(
            "SELECT grade, class_name FROM pick_state WHERE student_username=?", (username,),
        ).fetchall()
        n = c.execute("DELETE FROM pick_state WHERE student_username=?", (username,)).rowcount
        for r in rows:
            meta = c.execute("SELECT picked FROM pick_round WHERE grade=? AND class_name=?",
                             (r["grade"], r["class_name"])).fetchone()
            if not meta:
                continue
            picked = [k for k in _loads(meta["picked"], []) if k != username]
            c.execute("UPDATE pick_round SET picked=?, updated_at=datetime('now','localtime')"
                      " WHERE grade=? AND class_name=?",
                      (json.dumps(picked, ensure_ascii=False), r["grade"], r["class_name"]))
        c.execute("DELETE FROM pick_ledger WHERE student_username=?", (username,))
    logger.info(f"[抽人] 账号 {username} 已清理共享数据：权重 {n} 行")
    return int(n or 0)

def forget_student(*, grade: str, cls: str, student: str) -> None:
    """学生删除/转班时清掉他的权重与本轮标记（台账保留，历史不销毁）。"""
    key = resolve_key(grade, cls, student)
    if not key:
        return
    with _immediate() as conn:
        c = conn.cursor()
        c.execute(
            "DELETE FROM pick_state WHERE grade=? AND class_name=? AND student_key=?",
            (grade, cls, key),
        )
        row = c.execute(
            "SELECT picked FROM pick_round WHERE grade=? AND class_name=?", (grade, cls),
        ).fetchone()
        if row:
            picked = [k for k in _loads(row["picked"], []) if k != key]
            c.execute(
                "UPDATE pick_round SET picked=?, updated_at=datetime('now','localtime')"
                " WHERE grade=? AND class_name=?",
                (json.dumps(picked, ensure_ascii=False), grade, cls),
            )
