# -*- coding: utf-8 -*-
"""课程章节排序修复脚本（开发机与部署机通用）

做三件事：
1. 重排 sort_order —— 按当前展示顺序，把每一组（同级章节 / 章下知识点）重新编号成
   0..n-1，消除历史拖拽留下的重复序号与断号。重复序号会让顺序看起来随机，因为查询
   是 ORDER BY sort_order, id。
2. 清理脏层级 —— parent_id 指向不存在的章节、跨课程误挂、父链成环时，按顶层处理
   （与树构建的兜底一致，但把数据本身改干净）。
3. 体检报告 —— 列出「疑似被拍平的子章节」：旧 reorder 无条件写 parent_id=NULL，会把
   一整组节打成顶级章。这类只报告不自动挂回，因为该归到哪个章需要教师确认。

用法：
    python tools/fix_curriculum_order.py              # 只体检，不写库（默认）
    python tools/fix_curriculum_order.py --apply      # 写库（单事务，失败回滚）
    python tools/fix_curriculum_order.py --course 12 --apply

部署机上建议：先不带 --apply 跑一遍看报告，确认后再加 --apply。
"""
import argparse
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backend.database as db  # noqa: E402

# 章/单元级标题 vs 节/课时级标题（"疑似被拍平"的启发式判断）
TOP_HINT = re.compile(r"(第\s*[0-9一二三四五六七八九十百]+\s*[章单元模块部分]|单元|模块)")
SUB_HINT = re.compile(r"(第\s*[0-9一二三四五六七八九十百]+\s*[节课]|课时|小节|实验|活动)")


def rows(sql, params=()):
    return list(db.execute_query_dict(sql, params) or [])


def collect(course_id):
    where, params = ("WHERE c.id = ?", (course_id,)) if course_id else ("", ())
    courses = rows(f"SELECT id, name FROM courses c {where} ORDER BY id", params)
    out = []
    for c in courses:
        chapters = rows(
            "SELECT id, parent_id, name, sort_order FROM chapters"
            " WHERE course_id=? AND status='active' ORDER BY sort_order, id", (c["id"],))
        kps = rows(
            "SELECT kp.id, kp.chapter_id, kp.name, kp.sort_order FROM knowledge_points kp"
            " JOIN chapters ch ON ch.id = kp.chapter_id"
            " WHERE ch.course_id=? AND kp.status='active' ORDER BY kp.sort_order, kp.id", (c["id"],))
        out.append((c, chapters, kps))
    return out


def effective_parent(chapter, by_id, reports, course):
    """返回修正后的 parent（0=顶层）；脏数据与成环都归到顶层并记录"""
    pid = chapter["parent_id"] or 0
    if not pid:
        return 0
    if pid == chapter["id"] or pid not in by_id:
        reports["bad_parent"].append((course["id"], course["name"], chapter["id"], chapter["name"], pid))
        return 0
    seen = {chapter["id"]}
    cur = pid
    while cur:
        if cur in seen:
            reports["cycle"].append((course["id"], course["name"], chapter["id"], chapter["name"]))
            return 0
        seen.add(cur)
        nxt = (by_id.get(cur) or {}).get("parent_id") or 0
        if nxt == cur:
            break
        cur = nxt
    return pid


def plan_for(course, chapters, kps):
    by_id = {ch["id"]: ch for ch in chapters}
    reports = {"bad_parent": [], "cycle": [], "flattened": [], "dup": []}
    parent_of = {ch["id"]: effective_parent(ch, by_id, reports, course) for ch in chapters}

    groups = defaultdict(list)
    for ch in chapters:
        groups[(ch["course_id"] if "course_id" in ch else course["id"], parent_of[ch["id"]])].append(ch)

    ch_plan = []
    for (_cid, pid), members in groups.items():
        orders = [m["sort_order"] for m in members]
        if len(set(orders)) != len(orders):
            reports["dup"].append((course["id"], course["name"], f"parent={pid}", len(orders)))
        for idx, ch in enumerate(members):
            new_parent = pid or None
            old_parent = ch["parent_id"] or None
            if ch["sort_order"] != idx or new_parent != old_parent:
                ch_plan.append((idx, new_parent, ch["id"]))

    tops = [ch for ch in chapters if not parent_of[ch["id"]]]
    has_zhang = any(TOP_HINT.search(ch["name"] or "") for ch in tops)
    if has_zhang:
        for ch in tops:
            if SUB_HINT.search(ch["name"] or "") and not TOP_HINT.search(ch["name"] or ""):
                reports["flattened"].append((course["id"], course["name"], ch["id"], ch["name"]))

    kp_groups = defaultdict(list)
    for kp in kps:
        kp_groups[kp["chapter_id"]].append(kp)
    kp_plan = []
    for _ch_id, members in kp_groups.items():
        for idx, kp in enumerate(members):
            if kp["sort_order"] != idx:
                kp_plan.append((idx, kp["id"]))
    return ch_plan, kp_plan, reports


def main():
    ap = argparse.ArgumentParser(description="课程章节排序修复")
    ap.add_argument("--apply", action="store_true", help="真正写库（默认只体检）")
    ap.add_argument("--course", type=int, default=0, help="只处理指定课程 id")
    args = ap.parse_args()

    plans, total_ch, total_kp = [], 0, 0
    all_rep = {"bad_parent": [], "cycle": [], "flattened": [], "dup": []}

    for course, chapters, kps in collect(args.course):
        if not chapters and not kps:
            continue
        ch_plan, kp_plan, reports = plan_for(course, chapters, kps)
        for key in all_rep:
            all_rep[key].extend(reports[key])
        if ch_plan or kp_plan:
            plans.append((course, ch_plan, kp_plan))
            total_ch += len(ch_plan)
            total_kp += len(kp_plan)
            print(f"课程 {course['id']} {course['name']}：章节待修 {len(ch_plan)} 项，知识点待修 {len(kp_plan)} 项")

    print("-" * 64)
    print(f"合计：章节 {total_ch} 项、知识点 {total_kp} 项需要重排")
    for key, title in (("bad_parent", "父级脏数据（按顶层处理）"),
                       ("cycle", "父链成环（断开为顶层，需人工确认层级）"),
                       ("dup", "同组重复序号（已按展示顺序重排）")):
        if all_rep[key]:
            print(f"{title}：{len(all_rep[key])} 项")
            for item in all_rep[key][:20]:
                print("   ", item)
    if all_rep["flattened"]:
        print(f"疑似被拍平的子章节：{len(all_rep['flattened'])} 项（只报告，请在页面上确认归位）")
        for item in all_rep["flattened"][:40]:
            print("   ", item)

    if not args.apply:
        print("\n体检模式（未写库）。确认报告后加 --apply 执行。")
        return
    if not total_ch and not total_kp:
        print("没有需要修复的数据。")
        return

    with db.get_transaction() as conn:
        cur = conn.cursor()
        for _course, ch_plan, kp_plan in plans:
            for sort_order, parent_id, ch_id in ch_plan:
                cur.execute("UPDATE chapters SET sort_order=?, parent_id=? WHERE id=?",
                            (sort_order, parent_id, ch_id))
            for sort_order, kp_id in kp_plan:
                cur.execute("UPDATE knowledge_points SET sort_order=? WHERE id=?",
                            (sort_order, kp_id))
    print(f"已修复：章节 {total_ch} 项、知识点 {total_kp} 项（单事务提交）")


if __name__ == "__main__":
    main()
