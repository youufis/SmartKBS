"""
RAG 检索增强生成工具
从试题库、课程大纲中检索与用户问题相关的内容
"""
import re
import json
from typing import Any, Optional

from backend.logger import logger


def retrieve_knowledge(prompt: str, username: str = "") -> str:
    """检索与用户问题相关的学科知识

    从试题库和课程大纲中检索相关内容，返回格式化的知识文本。
    """
    context_parts = []

    # 1. 从试题库检索相关题目
    questions = _search_questions(prompt)
    if questions:
        context_parts.append("【相关试题】\n" + "\n".join(questions[:5]))

    # 2. 从课程大纲检索相关知识点
    knowledge = _search_knowledge_points(prompt)
    if knowledge:
        context_parts.append("【课程知识点】\n" + "\n".join(knowledge[:5]))

    if not context_parts:
        return ""

    return "\n\n".join(context_parts)


def _search_questions(prompt: str) -> list[str]:
    """从试题库中检索与 prompt 相关的题目"""
    try:
        from backend.question_db import execute_query
        # 提取关键词
        keywords = _extract_keywords(prompt)
        if not keywords:
            return []

        results = set()
        for kw in keywords[:4]:
            like = f"%{kw}%"
            rows = execute_query(
                """SELECT question_text, correct_answer, knowledge_points, type
                   FROM question_bank
                   WHERE (question_text LIKE ? OR knowledge_points LIKE ?)
                   AND status = 'active'
                   LIMIT 8""",
                (like, like),
            )
            for r in rows:
                text = r["question_text"][:100]
                kp = r.get("knowledge_points", "") or ""
                results.add(f"- [{r['type']}] {text}（知识点：{kp}）")

        return list(results)
    except Exception as e:
        logger.warning(f"试题检索失败: {e}")
        return []


def _search_knowledge_points(prompt: str) -> list[str]:
    """从课程大纲中检索与 prompt 相关的知识点"""
    try:
        from backend.database import execute_query_dict
        keywords = _extract_keywords(prompt)
        if not keywords:
            return []

        results = set()
        for kw in keywords[:4]:
            like = f"%{kw}%"
            rows = execute_query_dict(
                """SELECT kp.name as kp_name, c.name as chapter_name,
                          co.name as course_name
                   FROM knowledge_points kp
                   JOIN chapters c ON c.id = kp.chapter_id
                   JOIN courses co ON co.id = c.course_id
                   WHERE kp.name LIKE ? OR kp.description LIKE ?
                   LIMIT 5""",
                (like, like),
            )
            for r in rows:
                results.add(f"- 【{r['course_name']}】{r['chapter_name']} → {r['kp_name']}")

        return list(results)
    except Exception as e:
        logger.warning(f"知识点检索失败: {e}")
        return []


# ── 本地检索关键词提取（V6.9 重写）──
# 旧版把整段贪心匹配当关键词（「技术的价值是什么」→ LIKE '%技术的价值是什%'），必然查空。
# 新版：按停用单字切段 + 剔除疑问/指令停用词 + 长段补 2-gram 兜底，零依赖。
_STOP_CHARS = set("的了是在和就都也很更于对从当为把被让使向以之其该此等中里只它他她您吗呢啊吧呀么没有")
_STOP_WORDS = {"什么", "怎么", "怎样", "如何", "为什么", "哪些", "哪个", "哪里", "多少",
               "是不是", "有无", "能否", "可否", "可以", "需要", "请问", "帮我", "一下",
               "以及", "还是", "或者", "然后", "进行", "使用", "通过", "关于", "对于",
               "以下", "这个", "那个", "一个", "主要", "一般", "通常", "介绍", "简述",
               "说明", "列举", "举例", "回答", "问题", "要求", "内容", "方面", "作用",
               "意义", "知识点", "请"}


def _extract_keywords(text: str) -> list[str]:
    """从查询文本提取可 LIKE 命中的关键词（实词片段，长段优先）。"""
    kws: list[str] = []
    seen: set[str] = set()

    def push(w: str) -> None:
        w = w.strip()
        if len(w) >= 2 and w not in seen:
            seen.add(w)
            kws.append(w)

    # 1) ASCII 词（Python / Excel / 3D 打印 等）
    for w in re.findall(r"[A-Za-z][A-Za-z0-9+#.-]{1,15}", text):
        push(w)

    # 2) 中文段：按停用单字切段，段内再剔除停用词
    for run in re.findall(r"[\u4e00-\u9fff]+", text):
        for frag in re.split(f"[{''.join(_STOP_CHARS)}]", run):
            if not frag:
                continue
            for sw in _STOP_WORDS:
                if frag == sw:
                    frag = ""
                    break
                if len(frag) > len(sw) and sw in frag:
                    frag = frag.replace(sw, "")
            if len(frag) < 2:
                continue
            push(frag)                    # 整段最精确，优先
            if len(frag) > 4:             # 长段补 2-gram 兜底（整段查不到时救场）
                for i in range(len(frag) - 1):
                    push(frag[i:i + 2])

    kws.sort(key=len, reverse=True)       # 长词（更具体）排前，配合调用侧截断
    return kws[:8]


# ══════════════════════════════════════════════════════════
#  V6.7 「直连 + 知识库」融合检索
#  百炼云端知识库（bailian_kb）优先，本地试题库/课程大纲兜底补充
# ══════════════════════════════════════════════════════════

_CLOUD_BUDGET = 4500   # 云端切片字符预算
_CLOUD_ENOUGH = 3      # 云端命中达到该条数即跳过本地 LIKE 检索（本地查询慢，属降级补充而非必做项）
_LOCAL_BUDGET = 1500   # 本地题库/大纲预算
_CHUNK_MAX = 900       # 单条切片截断长度


def resolve_search_query(text: str) -> str:
    """检索词收口（所有入口共用）：短提问原样；长文本提取核心关键词。

    聊天里用户常粘贴整段材料再在末尾提问——整段文本既超百炼 4500 字节限制、
    又被开头材料稀释主题，这里统一收敛成一条干净的主题检索词；
    原始长文本仍会完整进入模型的任务区，检索词只影响"查什么资料"。
    """
    t = (text or "").strip()
    if len(t) <= 300:
        return t
    kws = _extract_keywords(t)[:6]
    return " ".join(kws) if kws else t[:300]


def retrieve_knowledge_v2(prompt: str, username: str = "") -> tuple[str, list[dict]]:
    """融合检索：返回 (资料上下文文本, 云端引用列表)

    引用列表元素 {doc_name, score, title}，供前端展示来源；本地检索结果不计入引用。
    云端检索词经 resolve_search_query 收敛（聊天/业务/未来新入口一律自动受护）。
    """
    parts: list[str] = []
    references: list[dict] = []

    # 1. 百炼云端知识库（检索词收口：长文本→核心关键词）
    try:
        from backend import bailian_kb
        chunks = bailian_kb.kb_search(resolve_search_query(prompt))
    except Exception as e:
        logger.warning(f"云端知识库检索异常（忽略，走本地）: {e}")
        chunks = []
    if chunks:
        used = 0
        lines: list[str] = []
        for i, c in enumerate(chunks):
            text = c["text"][:_CHUNK_MAX]
            if used + len(text) > _CLOUD_BUDGET:
                break
            lines.append(f"〔资料{i + 1}·《{c['doc_name']}》·相关度{c['score']}〕\n{text}")
            used += len(text)
            references.append({"doc_name": c["doc_name"], "score": c["score"], "title": c["title"]})
        if lines:
            parts.append("【知识库参考资料】\n\n" + "\n\n".join(lines))

    # 2. 本地试题库 + 课程大纲（补充/降级用；云端命中足够时跳过——LIKE 查询是主要耗时）
    if len(references) >= _CLOUD_ENOUGH:
        logger.debug(f"[RAG] 云端命中 {len(references)} 条，跳过本地 LIKE 检索")
    else:
        local_parts: list[str] = []
        questions = _search_questions(prompt)
        if questions:
            local_parts.append("【相关试题】\n" + "\n".join(questions[:5]))
        knowledge = _search_knowledge_points(prompt)
        if knowledge:
            local_parts.append("【课程知识点】\n" + "\n".join(knowledge[:5]))
        if local_parts:
            parts.append(("\n\n".join(local_parts))[:_LOCAL_BUDGET])

    context = "\n\n".join(parts)[:_CLOUD_BUDGET + _LOCAL_BUDGET + 200]
    return context, references
