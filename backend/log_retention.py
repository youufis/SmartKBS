# -*- coding: utf-8 -*-
"""业务日志表保留策略: 启动 60s 后首跑 + 每 24h 定期清理, 防只增不删

保留窗设置偏保守(考勤视图依赖 login_logs、资源统计依赖 resource_view_logs):
- config_sync_logs  30 天
- login_logs       180 天
- resource_view_logs 365 天
- notifications     90 天(仅已读, 未读永不清理)
"""
import threading
import time as _time
from datetime import datetime, timedelta

from backend.database import get_connection
from backend.logger import logger

_ITEMS = [
    ("config_sync_logs", ("synced_at", "created_at", "timestamp", "log_time"), 30, ""),
    ("login_logs", ("login_time",), 180, ""),
    ("resource_view_logs", ("viewed_at",), 365, ""),
    ("notifications", ("created_at",), 90, "is_read=1"),
]


def _pick_col(conn, table, candidates):
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)]
    except Exception:
        return None
    for c in candidates:
        if c in cols:
            return c
    return None


def _dedupe_view_logs() -> None:
    """清理历史双写产生的「同人+同资源+同秒」重复浏览记录(保留信息最全的一条):
    优先保留带 knowledge_point/binding 上下文或非 direct 来源, 再按最小 id; 幂等安全"""
    try:
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT id, student_username, resource_type, resource_id, file_path, viewed_at,"
                " source, knowledge_point_id, binding_id FROM resource_view_logs"
            ).fetchall()
            groups: dict = {}
            for r in rows:
                key = (r[1], r[2], r[3] or 0, r[4] or "", r[5])
                groups.setdefault(key, []).append(r)
            to_delete = []
            for members in groups.values():
                if len(members) < 2:
                    continue
                def rank(m):
                    return (1 if m[7] else 0, 1 if m[8] else 0, 1 if (m[6] or "") != "direct" else 0, -m[0])
                keep = max(members, key=rank)
                to_delete.extend([m[0] for m in members if m[0] != keep[0]])
            if to_delete:
                ph = ",".join("?" * len(to_delete))
                conn.execute("DELETE FROM resource_view_logs WHERE id IN (%s)" % ph, tuple(to_delete))
                conn.commit()
                logger.info(f"[log_retention] resource_view_logs 清理历史双写重复 {len(to_delete)} 条")
    except Exception as e:
        logger.warning(f"[log_retention] 浏览日志去重失败: {e}")


def _maintain_exam_attempts() -> None:
    """考试尝试维护(X1/X4):
    - 超 24h 未完结的 in_progress/grading → expired
    - 确保"同一考试同一学生至多一条进行中"部分唯一索引存在
    """
    try:
        from backend.question_db import get_connection as _qconn
        with _qconn() as conn:
            cutoff = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
            cur = conn.execute(
                "UPDATE exam_attempts SET status='expired' WHERE status IN ('in_progress','grading') AND started_at < ?",
                (cutoff,),
            )
            if cur.rowcount:
                logger.info(f"[log_retention] exam_attempts 超期未完结尝试置为 expired: {cur.rowcount} 条")
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_ea_one_active ON exam_attempts(exam_id, student_username) "
                "WHERE status IN ('in_progress','grading')"
            )
            conn.commit()
    except Exception as e:
        logger.warning(f"[log_retention] exam_attempts 维护失败: {e}")


def _maintain_question_media() -> None:
    """题库配图磁盘治理(Q6):
    - question_media/.archived/ 里超过 30 天的归档目录物理清除(软删题目的图先归档保留 30 天以便恢复)
    - 完全找不到对应题目的孤儿目录(存在超过 30 天)一并回收
    """
    import os
    import shutil
    import time
    try:
        from backend.config import BASE_DIR
        from backend.question_db import execute_query as q_exec
        root = BASE_DIR / "question_media"
        if not root.exists():
            return
        month_ago = time.time() - 30 * 86400
        freed = 0
        removed = 0

        def _dir_size(p):
            total = 0
            for dp, _dirs, files in os.walk(p):
                for f in files:
                    try:
                        total += os.path.getsize(os.path.join(dp, f))
                    except OSError:
                        pass
            return total

        archived = root / ".archived"
        if archived.exists():
            for name in os.listdir(archived):
                p = archived / name
                try:
                    if p.is_dir() and p.stat().st_mtime < month_ago:
                        freed += _dir_size(p)
                        shutil.rmtree(p, ignore_errors=True)
                        removed += 1
                except OSError:
                    continue

        # 先收敛历史状态: 软删题若仍留着配图目录, 移入归档(新删除路径已在 delete 时归档)
        archived.mkdir(parents=True, exist_ok=True)
        soft_deleted = [str(r["id"]) for r in q_exec("SELECT id FROM question_bank WHERE status <> 'active'")]
        for sid in soft_deleted:
            p = root / sid
            try:
                if p.is_dir():
                    dst = archived / ("%s__legacy_%s" % (sid, datetime.now().strftime("%Y%m%d%H%M%S")))
                    shutil.move(str(p), str(dst))
                    freed += _dir_size(dst)
                    removed += 1
            except OSError:
                continue

        known = {str(r["id"]) for r in q_exec("SELECT id FROM question_bank")}
        for name in os.listdir(root):
            p = root / name
            try:
                if not p.is_dir() or name == ".archived":
                    continue
                if name in known:
                    continue
                if p.stat().st_mtime < month_ago:
                    freed += _dir_size(p)
                    shutil.rmtree(p, ignore_errors=True)
                    removed += 1
            except OSError:
                continue

        if removed:
            logger.info(f"[log_retention] 题库配图回收 {removed} 个目录, 释放 {round(freed / 1024, 1)} KB")
    except Exception as e:
        logger.warning(f"[log_retention] 题库配图治理失败: {e}")


def _check_question_references() -> None:
    """引用一致性巡检(Q3): 只记录告警不自动改数据, 便于及时发现"题目已删但仍被考试/练习引用" """
    try:
        from backend.question_db import execute_query as q_exec
        bad_exam = q_exec(
            """SELECT DISTINCT eq.exam_id, e.title AS exam_title, eq.question_id
               FROM exam_questions eq
               JOIN exams e ON e.id = eq.exam_id
               JOIN question_bank qb ON qb.id = eq.question_id
               WHERE qb.status <> 'active'"""
        )
        bad_practice = q_exec(
            """SELECT DISTINCT psq.session_id, ps.title AS session_title, psq.question_id
               FROM practice_session_questions psq
               JOIN practice_sessions ps ON ps.id = psq.session_id
               JOIN question_bank qb ON qb.id = psq.question_id
               WHERE qb.status <> 'active'"""
        )
        for r in bad_exam:
            logger.warning(
                f"[log_retention] 数据一致性: 考试「{r['exam_title']}」(id={r['exam_id']}) "
                f"仍引用已删除题目 id={r['question_id']}, 该题会在组卷/答卷中被跳过"
            )
        for r in bad_practice:
            logger.warning(
                f"[log_retention] 数据一致性: 练习「{r['session_title']}」(id={r['session_id']}) "
                f"仍引用已删除题目 id={r['question_id']}"
            )
    except Exception as e:
        logger.warning(f"[log_retention] 引用一致性巡检失败: {e}")


def _reconcile_points_and_badges() -> None:
    """R6/R10 日常维护:
    - student_total_points 与 activity_rewards 对账(删活动会删奖励流水但没人重算汇总, 排行榜会长期虚高)
    - 对近 7 天有积分变动的学生做一次全量徽章检测(事件驱动的增量兜底)
    """
    try:
        from backend.reward_engine import reconcile_student_totals
        res = reconcile_student_totals(auto_fix=True)
        if res.get("mismatch") or res.get("orphan"):
            logger.info(
                f"[log_retention] 积分对账: 校正 {res['mismatch']} 人, 清理无流水汇总 {res['orphan']} 人 "
                f"(共检查 {res['checked']}), 样例={res['samples'][:3]}"
            )
    except Exception as e:
        logger.warning(f"[log_retention] 积分对账失败: {e}")

    try:
        from backend.database import execute_query as dbq
        from backend.title_system import check_and_unlock_badges
        rows = dbq(
            """SELECT DISTINCT student_username FROM activity_rewards
               WHERE created_at >= datetime('now', '-7 day')"""
        ) or []
        students = [r[0] for r in rows if r[0]]
        unlocked = 0
        for stu in students[:800]:          # 单次上限, 避免凌晨任务跑太久
            try:
                if check_and_unlock_badges(stu):
                    unlocked += 1
            except Exception:
                continue
        if students:
            logger.info(f"[log_retention] 徽章兜底检测完成: {len(students)} 人, 新解锁 {unlocked} 人")
    except Exception as e:
        logger.warning(f"[log_retention] 徽章兜底检测失败: {e}")


def purge_once() -> None:
    _dedupe_view_logs()
    _maintain_exam_attempts()
    _maintain_question_media()
    _check_question_references()
    _reconcile_points_and_badges()
    for table, cands, days, extra in _ITEMS:
        try:
            with get_connection() as conn:
                col = _pick_col(conn, table, cands)
                if not col:
                    continue
                cutoff = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
                sql = "DELETE FROM %s WHERE %s < ?" % (table, col)
                if extra:
                    sql += " AND " + extra
                cur = conn.execute(sql, (cutoff,))
                conn.commit()
                if cur.rowcount:
                    logger.info(f"[log_retention] {table} 清理 {cur.rowcount} 条过期记录(保留 {days} 天)")
        except Exception as e:
            logger.warning(f"[log_retention] {table} 清理失败: {e}")


def start() -> None:
    """启动后台守护线程(不阻塞服务启动)"""
    def _loop():
        _time.sleep(60)
        purge_once()
        while True:
            _time.sleep(24 * 3600)
            purge_once()

    threading.Thread(target=_loop, daemon=True, name="log-retention").start()
