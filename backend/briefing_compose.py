# -*- coding: utf-8 -*-
"""教学简报：规则成文 + AI 解读。

两层职责：
  1. 规则层：把已算好的指标渲染成固定的九个板块（图表/表格/动作都由后端产出）；
  2. AI 层：只补叙述与人话总结，**不允许产生新数字**（数字白名单校验，不通过就退回规则文案）。

AI 不可用时整份报告仍可用（status=degraded），不会出现半成品。
"""
from __future__ import annotations

import json
import re
from typing import Any

from backend.briefing_service import ACTIVITY_LABELS, MIN_SAMPLE
from backend.logger import logger

PROMPT_VERSION = 1
SECTION_ORDER = [
    ("S1", "本期速览"), ("S2", "教学开展"), ("S3", "学习成效"),
    ("S4", "课堂参与"), ("S5", "任务与作业"), ("S6", "表扬与亮点"),
    ("S7", "学生成长"), ("S8", "薄弱环节"), ("S9", "下阶段建议"),
]
SOURCE_LABELS = {
    "exam": "考试", "quiz": "随堂测验", "practice": "同步练习",
    "code": "代码练习", "task": "任务",
}


def _f(v: Any, unit: str = "") -> str:
    return "—" if v is None else f"{v}{unit}"


def _activity_text(m: dict[str, Any]) -> str:
    act = m.get("activity") or {}
    if not act.get("total"):
        return "本期没有开展教学活动。"
    parts = "、".join(
        f"{ACTIVITY_LABELS.get(k, k)} {v} 项"
        for k, v in sorted((act.get("by_type") or {}).items(), key=lambda x: -x[1])
    )
    return f"本期共开展 {act['total']} 项教学活动：{parts}。"


def _learning_text(m: dict[str, Any]) -> str:
    lr = m.get("learning") or {}
    n = lr.get("samples") or 0
    if not n:
        return "本期没有产生有效得分记录。"
    if lr.get("avg_rate") is None:
        return (f"本期有效得分样本 {n} 人次，低于 {MIN_SAMPLE} 人次的最小样本要求，"
                f"按口径不计算平均得分率，仅作明细参考。")
    text = f"本期有效得分样本 {n} 人次，平均得分率 {lr['avg_rate']}%"
    if lr.get("delta") is not None:
        text += f"，较上期 {'+' if lr['delta'] >= 0 else ''}{lr['delta']}pp"
    text += f"；及格率 {_f(lr.get('pass_rate'), '%')}，优秀率 {_f(lr.get('excellent_rate'), '%')}。"
    dist = lr.get("distribution") or {}
    if dist:
        text += (f"分数段分布：优秀 {dist.get('excellent', 0)} 人次、良好 {dist.get('good', 0)} 人次、"
                 f"及格 {dist.get('pass', 0)} 人次、待合格 {dist.get('fail', 0)} 人次。")
    return text


def _participation_text(m: dict[str, Any]) -> str:
    pa = m.get("participation") or {}
    if not pa.get("participants"):
        return "本期没有学生参与课堂活动。"
    text = (f"参与学生 {pa.get('participants')} 人，参与率 {_f(pa.get('rate'), '%')}，"
            f"零参与 {pa.get('silent_count', 0)} 人。")
    return text


def _task_text(m: dict[str, Any]) -> str:
    tk = m.get("tasks") or {}
    if not tk.get("assigned"):
        return "本期没有布置任务。"
    return (f"本期布置 {tk['assigned']} 项任务，提交率 {_f(tk.get('submit_rate'), '%')}，"
            f"按时率 {_f(tk.get('on_time_rate'), '%')}，待批改 {tk.get('pending_grading', 0)} 份。")


def _praise_text(m: dict[str, Any]) -> str:
    p = m.get("praise") or {}
    if not (p.get("students") or p.get("classes")):
        return "本期数据不足以评出符合条件的表扬对象，宁缺毋滥，未硬凑名单。"
    names = "、".join(f"{s['title']} {s['name']}" for s in p["students"][:6]) or "无"
    classes = "、".join(f"{c['name']}（{c['title']}）" for c in p["classes"][:3]) or "无"
    return f"本期表扬学生：{names}；表扬班级：{classes}。"


def _growth_text(m: dict[str, Any]) -> str:
    g = m.get("growth") or {}
    ti = m.get("titles") or {}
    if not g.get("available"):
        return "已按学科筛选，积分与成长数据不区分学科，本期不作统计。"
    parts: list[str] = []
    if g.get("points_gained"):
        top = "、".join(f"{x['name']} {x['points']} 分" for x in (g.get("top_gainers") or [])[:3])
        parts.append(f"本期学生共获得 {g['points_gained']} 积分"
                     + (f"，积分前三：{top}" if top else ""))
    if ti.get("upgrades"):
        parts.append(f"{ti['students']} 名学生获得 {ti['upgrades']} 项平台称号/徽章晋升")
    return "；".join(parts) + "。" if parts else "本期没有积分变动记录。"


def _weak_text(m: dict[str, Any]) -> str:
    ws = m.get("weak_points") or []
    wq = m.get("weak_data_quality") or {}
    unmapped = int(wq.get("unmapped") or 0)
    if not ws:
        if unmapped:
            return (f"本期有 {unmapped} 条作答的题目尚未关联知识点，无法定位薄弱点；"
                    f"建议先在题库补齐知识点标注。")
        return "本期知识点作答样本不足，暂无法定位薄弱知识点。"
    text = "本期薄弱知识点：" + "；".join(
        f"{w['kp']} 正确率 {w['rate']}%（{w['total']} 次作答）" for w in ws[:5]
    ) + "。"
    if unmapped >= 5:
        text += f"另有 {unmapped} 条作答因题目未关联知识点，未纳入统计。"
    return text


def _rule_actions(m: dict[str, Any]) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    for w in (m.get("weak_points") or [])[:2]:
        actions.append({"text": f"针对「{w['kp']}」安排一次 10–15 分钟补救讲解",
                        "basis": f"该知识点正确率 {w['rate']}%，共 {w['total']} 次作答"})
    wq = m.get("weak_data_quality") or {}
    unmapped, answers = int(wq.get("unmapped") or 0), int(wq.get("answers") or 0)
    if unmapped >= 5 and answers and unmapped / answers >= 0.2:
        # 数据质量问题必须出现在建议里，即使 AI 换了一整套动作也要保留
        actions.append({"text": "为本次测验题目补齐知识点标注",
                        "basis": f"{unmapped}/{answers} 条作答因未关联知识点被排除在薄弱分析外",
                        "mandatory": True, "key": "kp_relabel"})
    tk = m.get("tasks") or {}
    if (tk.get("pending_grading") or 0) > 0:
        actions.append({"text": f"优先处理 {tk['pending_grading']} 份待批改作业",
                        "basis": "待批改积压会影响学生看到反馈的时效"})
    pa = m.get("participation") or {}
    if (pa.get("silent_count") or 0) > 0 and (pa.get("rate") or 0) >= 30:
        actions.append({"text": "抽查零参与学生，确认是否存在设备或账号问题",
                        "basis": f"本期 {pa['silent_count']} 人零参与，班级参与率 {pa.get('rate')}%"})
    if not actions:
        actions.append({"text": "本期数据无明显异常，按原教学计划推进",
                        "basis": "各项指标未触发预警阈值"})
    return actions


def _table_activities(m: dict[str, Any]) -> dict[str, Any] | None:
    items = (m.get("activity") or {}).get("items") or []
    if not items:
        return None
    rows = [[ACTIVITY_LABELS.get(it["type"], it["type"]), it["title"][:28],
             (it.get("created_at") or "")[:10]] for it in items[:12]]
    return {"title": "本期活动清单", "columns": ["类型", "名称", "日期"], "rows": rows}


def _chart_sources(m: dict[str, Any]) -> dict[str, Any] | None:
    src = (m.get("learning") or {}).get("by_source") or {}
    data = [{"name": SOURCE_LABELS.get(k, k), "value": v.get("avg_rate")}
            for k, v in src.items() if v.get("avg_rate") is not None]
    return {"type": "bar", "title": "各来源平均得分率", "data": data} if data else None


def _chart_weak(m: dict[str, Any]) -> dict[str, Any] | None:
    data = [{"name": w["kp"], "value": w["rate"]} for w in (m.get("weak_points") or [])[:5]]
    return {"type": "bar", "title": "薄弱知识点正确率", "data": data} if data else None


def _table_gainers(m: dict[str, Any]) -> dict[str, Any] | None:
    items = (m.get("growth") or {}).get("top_gainers") or []
    if not items:
        return None
    return {"title": "积分榜", "columns": ["学生", "班级", "积分"],
            "rows": [[x["name"], x["class"], x["points"]] for x in items]}


def build_rule_sections(m: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    """纯规则版报告：AI 不可用时的兜底，也是 AI 解读的骨架。"""
    lr = m.get("learning") or {}
    headline = _activity_text(m)
    if lr.get("avg_rate") is not None:
        headline += f"平均得分率 {lr['avg_rate']}%"
        if lr.get("delta") is not None:
            headline += f"（环比 {'+' if lr['delta'] >= 0 else ''}{lr['delta']}pp）"
        headline += "。"
    else:
        headline += "本期得分样本不足，暂不计算平均得分率。"

    secs: dict[str, dict[str, Any]] = {
        "S1": {"key": "S1", "title": "本期速览", "severity": "info",
               "narrative": "本期关键事实如下。",
               "bullets": [f["text"] for f in (m.get("facts") or [])][:5],
               "charts": [], "tables": [], "actions": []},
        "S2": {"key": "S2", "title": "教学开展", "severity": "info",
               "narrative": _activity_text(m), "bullets": [], "charts": [],
               "tables": [t for t in [_table_activities(m)] if t], "actions": []},
        "S3": {"key": "S3", "title": "学习成效", "severity": "info",
               "narrative": _learning_text(m), "bullets": [], "charts": [],
               "tables": [], "actions": []},
        "S4": {"key": "S4", "title": "课堂参与", "severity": "warning"
               if (m.get("participation") or {}).get("rate", 100) is not None
               and ((m.get("participation") or {}).get("rate") or 0) < 50 else "info",
               "narrative": _participation_text(m), "bullets": [], "charts": [],
               "tables": [], "actions": []},
        "S5": {"key": "S5", "title": "任务与作业", "severity": "info",
               "narrative": _task_text(m), "bullets": [], "charts": [], "tables": [], "actions": []},
        "S6": {"key": "S6", "title": "表扬与亮点", "severity": "good",
               "narrative": _praise_text(m), "bullets": [], "charts": [], "tables": [], "actions": []},
        "S7": {"key": "S7", "title": "学生成长", "severity": "info",
               "narrative": _growth_text(m), "bullets": [], "charts": [],
               "tables": [t for t in [_table_gainers(m)] if t], "actions": []},
        "S8": {"key": "S8", "title": "薄弱环节", "severity": "warning" if m.get("weak_points") else "info",
               "narrative": _weak_text(m), "bullets": [], "charts": [], "tables": [], "actions": []},
        "S9": {"key": "S9", "title": "下阶段建议", "severity": "info",
               "narrative": "以下建议均由本期数据触发，按影响面排序。", "bullets": [], "charts": [],
               "tables": [], "actions": _rule_actions(m)},
    }
    chart = _chart_sources(m)
    if chart:
        secs["S3"]["charts"].append(chart)
    trend = m.get("trend") or {}
    if trend.get("points"):
        secs["S3"]["charts"].insert(0, {
            "type": "line",
            "title": "周期内得分率走势" if trend.get("granularity") == "week" else "月度得分率走势",
            "data": trend["points"],
        })
    weak_chart = _chart_weak(m)
    if weak_chart:
        secs["S8"]["charts"].append(weak_chart)

    p = m.get("praise") or {}
    ti = m.get("titles") or {}
    if ti.get("recent"):
        secs["S7"]["bullets"] = [
            f"{x['name']}（{x['class']}）获得{x['type']}「{x['title']}」"
            for x in ti["recent"][:5]
        ]
    if p.get("students"):
        secs["S6"]["bullets"] = [f"{s['title']}：{s['name']}（{s['class']}）— {s['reason']}"
                                 for s in p["students"]]
    if p.get("classes"):
        secs["S6"]["bullets"] += [f"{c['title']}：{c['name']} — {c['reason']}"
                                  for c in p["classes"]]
    if p.get("vacant"):
        secs["S6"]["bullets"].append("本期空缺：" + "、".join(v["title"] for v in p["vacant"][:6]))

    sections = [secs[k] for k, _ in SECTION_ORDER]
    return headline, sections


# ── AI 解读 ───────────────────────────────────────────────────

BRIEFING_PROMPT = """你是中学教研室的资深数据分析师，正在为一位教师撰写{period_label}的教学简报解读。

## 硬约束
1. 只能使用下面「事实清单」与「指标」中出现的数字；**不得推算、估计、编造任何新数字**。
2. 不要复述全部数据，只做归因、对比和判断；语气客观、具体，不说空话。
   缺失数据请写"数据不足"，不要写 null / N/A / NaN。
3. 每条建议必须对应一条数据依据。
4. 只输出 JSON，不要代码块、不要解释。

## 事实清单
{facts}

## 指标摘要
{metrics}

## 范围
{scope}

## 输出 JSON 结构
{{
  "headline": "一句话总结本期（不超过 40 字，可含数字，但必须来自上面）",
  "summary": ["3-5 条本期要点，每条不超过 30 字"],
  "narratives": {{
    "S2": "教学开展解读，40-80 字",
    "S3": "学习成效解读，80-140 字，指出变化与原因",
    "S4": "课堂参与解读，40-80 字",
    "S5": "任务作业解读，30-60 字",
    "S7": "学生成长解读，40-80 字",
    "S8": "薄弱环节解读，60-100 字，指出最需要补的知识点",
    "S9": "下阶段教学建议，80-140 字，落到可执行动作"
  }},
  "actions": [{{"text": "动作，20 字内", "basis": "依据，含数字"}}]
}}
"""


def build_prompt(m: dict[str, Any], scope: dict[str, Any], period: dict[str, Any]) -> str:
    facts = "\n".join(f"- {f['text']}" for f in (m.get("facts") or [])) or "无"
    lr = m.get("learning") or {}
    pa = m.get("participation") or {}
    tk = m.get("tasks") or {}
    summary = {
        "活动数": (m.get("activity") or {}).get("total"),
        "得分样本": lr.get("samples"),
        "平均得分率": lr.get("avg_rate"),
        "环比pp": lr.get("delta"),
        "及格率": lr.get("pass_rate"),
        "优秀率": lr.get("excellent_rate"),
        "参与人数": pa.get("participants"),
        "参与率": pa.get("rate"),
        "零参与": pa.get("silent_count"),
        "任务提交率": tk.get("submit_rate"),
        "待批改": tk.get("pending_grading"),
        "薄弱知识点": [w["kp"] for w in (m.get("weak_points") or [])[:3]],
        "表扬": [f"{s['title']} {s['name']}" for s in (m.get("praise") or {}).get("students", [])],
    }
    return BRIEFING_PROMPT.format(
        period_label=period.get("label", ""),
        facts=facts,
        metrics=json.dumps(summary, ensure_ascii=False, indent=1),
        scope=f"{scope.get('filter_label', '')}（{scope.get('total_students', 0)} 名学生）",
    )


_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def _all_numbers(obj: Any, out: set[str]) -> None:
    if isinstance(obj, bool) or obj is None:
        return
    if isinstance(obj, (int, float)):
        out.add(str(int(obj)) if float(obj).is_integer() else f"{float(obj):.1f}")
        out.add(f"{float(obj):g}")
    elif isinstance(obj, str):
        for x in _NUM_RE.findall(obj):
            out.add(x)
    elif isinstance(obj, dict):
        for v in obj.values():
            _all_numbers(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            _all_numbers(v, out)


def _allowed_numbers(m: dict[str, Any]) -> set[str]:
    """只允许「事实要点 + 顶层 KPI」里的数字。

    不能把整个 metrics 递归进来：by_source.samples 里的 5 会让"本周 5 项活动"
    这种编造数字蒙混过关。按字段点名比整体放开更稳。
    """
    out: set[str] = set()
    _all_numbers(m.get("facts"), out)
    _all_numbers((m.get("period") or {}).get("label"), out)

    lr = m.get("learning") or {}
    pa = m.get("participation") or {}
    tk = m.get("tasks") or {}
    gr = m.get("growth") or {}
    act = m.get("activity") or {}
    pr = m.get("praise") or {}
    picked = {
        "activity": {"total": act.get("total"), "by_type": act.get("by_type")},
        "learning": {k: lr.get(k) for k in
                     ("samples", "avg_rate", "pass_rate", "excellent_rate", "delta")},
        "participation": {k: pa.get(k) for k in ("participants", "rate", "silent_count")},
        "tasks": {k: tk.get(k) for k in ("assigned", "submitted", "submit_rate", "late",
                                         "on_time_rate", "pending_grading")},
        "growth": {"points_gained": gr.get("points_gained")},
        "praise": {"students": len(pr.get("students") or []), "classes": len(pr.get("classes") or [])},
    }
    _all_numbers(picked, out)
    _all_numbers(lr.get("distribution"), out)
    _all_numbers(m.get("weak_points"), out)
    sc = m.get("scope") or {}
    # 「覆盖 15 个班 / 859 名学生」属于范围事实，允许 AI 引用
    _all_numbers({"students": sc.get("total_students"),
                  "classes": len(sc.get("classes") or [])}, out)
    for y in range(2024, 2031):     # 年份
        out.add(str(y))
    return out


# “第 3 名 / 前 5”属于名次，不是数据事实，不参与数字白名单比对
_RANK_RE = re.compile(r"(第|前)\s*\d+")


def _numbers_ok(text: str, allowed: set[str], tolerance: int = 2) -> bool:
    cleaned = _RANK_RE.sub("第X", text or "")
    nums = _NUM_RE.findall(cleaned)
    bad = [n for n in nums if n not in allowed and n.rstrip("0").rstrip(".") not in allowed]
    return len(bad) <= tolerance


_PREFIX_RE = re.compile(r"^(教学开展|学习成效|课堂参与|任务作业|学生成长|薄弱环节|下阶段教学建议|下阶段建议|表扬与亮点)解读[：:]\s*")


def _clean_text(text: str) -> str:
    """去掉 AI 的"XX解读："前缀与 null/[] 这类机器残留。"""
    t = _PREFIX_RE.sub("", text.strip())
    for bad in ("null", "None", "NaN", "N/A"):
        t = t.replace(bad, "数据不足")
    t = re.sub(r"\[\s*\]", "暂无", t)
    return t.strip()





def apply_ai(m: dict[str, Any], sections: list[dict[str, Any]], payload: dict[str, Any]) -> tuple[str, list[dict[str, Any]], int]:
    """把 AI 叙述合并进规则骨架。返回 (headline, sections, 被丢弃的段落数)。"""
    allowed = _allowed_numbers(m)
    rejected = 0
    by_key = {s["key"]: s for s in sections}

    headline = payload.get("headline")
    out_head = None
    if isinstance(headline, str) and headline.strip() and _numbers_ok(headline, allowed, tolerance=0):
        out_head = _clean_text(headline)[:80]

    summary = payload.get("summary")
    if isinstance(summary, list):
        bullets = [_clean_text(str(x)) for x in summary
                   if str(x).strip() and _numbers_ok(str(x), allowed, tolerance=0)]
        if bullets:
            by_key["S1"]["bullets"] = bullets[:5]

    narratives = payload.get("narratives") or {}
    if isinstance(narratives, dict):
        for key, text in narratives.items():
            sec = by_key.get(str(key).upper())
            if not sec or not isinstance(text, str) or not text.strip():
                continue
            if _numbers_ok(text, allowed, tolerance=0):
                sec["narrative"] = _clean_text(text)[:600]
            else:
                rejected += 1

    actions = payload.get("actions")
    if isinstance(actions, list):
        valid = []
        for a in actions[:6]:
            if not isinstance(a, dict):
                continue
            text = str(a.get("text") or "").strip()
            basis = str(a.get("basis") or "").strip()
            if text and _numbers_ok(f"{text}{basis}", allowed, tolerance=1):
                valid.append({"text": text[:40], "basis": basis[:80]})
        if valid:
            # 保留规则层标记为 mandatory 的动作（如数据质量问题），避免被 AI 整套覆盖
            kept = {a.get("text") for a in valid}
            covered_kp = any("知识点" in f"{a.get('text','')}{a.get('basis','')}" for a in valid)
            for act in by_key["S9"]["actions"]:
                if not act.get("mandatory") or act.get("text") in kept:
                    continue
                if act.get("key") == "kp_relabel" and covered_kp:
                    continue    # AI 已经提到知识点，避免重复两条近义动作
                valid.append(act)
            by_key["S9"]["actions"] = valid[:6]

    return (out_head or ""), sections, rejected


def parse_ai_json(text: str) -> dict[str, Any] | None:
    raw = (text or "").strip()
    if not raw:
        return None
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", raw).strip()
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", raw)
        if not m:
            return None
        try:
            data = json.loads(m.group(0))
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            logger.warning("[briefing] AI 返回无法解析为 JSON")
            return None


# ── 导出 ──────────────────────────────────────────────────────

def sections_to_markdown(headline: str, sections: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    if headline:
        lines.append(f"**{headline}**")
        lines.append("")
    for sec in sections:
        lines.append(f"## {sec.get('title', '')}")
        if sec.get("narrative"):
            lines.append(sec["narrative"])
        for b in sec.get("bullets") or []:
            lines.append(f"- {b}")
        for tb in sec.get("tables") or []:
            cols = tb.get("columns") or []
            if not cols:
                continue
            lines.append("")
            lines.append("| " + " | ".join(str(c) for c in cols) + " |")
            lines.append("|" + "|".join("---" for _ in cols) + "|")
            for row in (tb.get("rows") or [])[:50]:
                lines.append("| " + " | ".join(str(x) for x in row) + " |")
            lines.append("")
        for a in sec.get("actions") or []:
            lines.append(f"- [ ] {a.get('text')}（依据：{a.get('basis')}）")
        lines.append("")
    return "\n".join(lines).strip()
