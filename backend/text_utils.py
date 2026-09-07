# -*- coding: utf-8 -*-
"""进界面之前的统一文本出口

铃铛、通知中心、积分流水、重置弹窗这些都是**纯文本**渲染（不跑 markdown），
而活动标题 / 学生提问这类数据本身可能带 markdown 或 {占位符} 样貌。
所以：先剥语法，再按长度裁剪，顺序不能反——反过来就会把 ** 或 {} 截成半截漏到界面上。
"""
from __future__ import annotations

import re
from typing import Any

_MD_LINK = re.compile(r"\[([^\]]*)\]\(([^)]*)\)")   # [文案](链接) -> 文案
_MD_CODES = re.compile(r"[`*_~]")                        # 强调/行内代码/删除线
_MD_SHARP = re.compile(r"^\s*#{1,6}\s*", re.MULTILINE)  # 标题井号
_MD_BRACE = re.compile(r"[{}]")                          # i18n 占位符样貌，绝不能进界面
_MD_WS = re.compile(r"\s+")


def plain_text(raw: Any) -> str:
    """剥掉 markdown 语法与花括号，只留可读文字（幂等）"""
    t = str(raw or "")
    t = _MD_LINK.sub(r"\1", t)
    t = _MD_SHARP.sub("", t)
    t = _MD_CODES.sub("", t)
    t = _MD_BRACE.sub("", t)
    return _MD_WS.sub(" ", t).strip()


# 活动名称沿用同一个实现（历史名字，语义就是"给人看的标题"）
plain_title = plain_text


def clip(raw: Any, limit: int = 50) -> str:
    """安全截断：先 plain 再裁剪，因此任何前缀都不含 markdown/占位符残渣"""
    t = plain_text(raw)
    if limit > 0 and len(t) > limit:
        return t[:limit].rstrip() + "…"
    return t
