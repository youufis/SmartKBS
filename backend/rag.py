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
        for kw in keywords[:3]:
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
        for kw in keywords[:3]:
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


def _extract_keywords(text: str) -> list[str]:
    """从文本中提取关键词"""
    # 去除常见停用词
    stop_words = {"的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
                  "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
                  "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
                  "们", "什么", "怎么", "如何", "为什么", "请问", "请", "吗", "呢",
                  "啊", "吧", "嗯", "哦", "呀", "嘛"}

    # 用正则提取中文字词（2-6个字）
    words = re.findall(r'[\u4e00-\u9fff]{2,6}', text)
    # 过滤停用词
    words = [w for w in words if w not in stop_words and len(w) >= 2]
    # 去重并限制数量
    seen = set()
    unique = []
    for w in words:
        if w not in seen:
            seen.add(w)
            unique.append(w)
    return unique[:8]
