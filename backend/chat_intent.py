# -*- coding: utf-8 -*-
"""对话意图识别 —— 知识问答链路的「该不该检索、该不该套质量模板」闸门

背景（V8.6.1）：学生在 AI 对话里问「你是谁」「你好」「111」，链路仍然
① 无条件走知识库检索（百炼对这类问句照样返回 5 条 ≥0.5 分的教材切片），
② 无条件注入「输出质量三阶增强」等技能段，
结果一个 3 个字的问题前面压了约 4700 字资料 + 模板，模型只能围绕教材
讲「温差怎么算」，身份问题就答成了讲稿。

本模块只做两件事，且一律**保守判定**：宁可漏判（退回原行为），不可误判
（把真知识问题当闲聊而不检索）。

- is_meta_question(text)   身份/能力/寒暄/低信息量 → 命中即跳过检索与技能注入
- should_retrieve(text)    这句话是否值得查知识库
"""
import re
from typing import Optional

# ── 元问题：问的是"助手本身"，不是学科知识 ──
_META_PATTERNS: tuple[str, ...] = (
    r"你(是谁|叫(什么|啥)|的名字|名字是|叫什么名字)",
    r"你是(什么|啥)[^。，.]{0,8}(模型|ai|人工智能|机器人|助手|老师|平台|公司|开发的|做出来的)",
    r"你是(哪|这|那|哪个|那个|哪家|那家)[^。，.]{0,8}(模型|公司|家的|儿)",
    r"你是(通义|千问|文心|豆包|混元|kimi|deepseek|chatgpt|gpt|gemini|claude|llama)",
    r"你是不是(人|人类|机器人|ai|人工智能|假的|真实的)",
    r"你(用|基于|调用)的?(什么|哪个|哪款)(模型|大模型|api|接口)",
    # 能力类问句：只有"你能做什么/你会什么/你能回答哪些…"这种**问助手本身**才算元问题。
    # 用 $ 收尾而不是子串匹配，否则"你能讲解一下冒泡排序吗""你能回答什么是温差吗"
    # 这类真知识问题会被误判成闲聊，进而跳过检索——那是比答得更长更严重的错误。
    r"你(都|也|还|就)?(能|会|可以)?(做|干|回答|讲解|支持|帮|覆盖|包含|教)?(帮我|帮忙|我|你)?(什么|哪些|啥)"
    r"(方面的内容|方面|内容|事情|问题|学科|功能|能力|呢|吗|的)?[呀啊吧呢吗]*$",
    r"你(都|也|还)?有什么(功能|能力|本领|用处|用)",
    r"你(有|具备)(什么|哪些)(功能|能力|本领|技能)",
    r"你的(功能|能力|作用|范围|定位|水平)(是|有哪些|是什么|怎么样)",
    r"(自我介绍|介绍(一下|下)?(你|你自己)|你(自己)?说说你是谁)",
    r"你(和|跟|与)?\s*(chatgpt|gpt|通义|千问|文心|deepseek|kimi)\s*(比|相比|一样|一样吗|哪个|谁)",
    r"(平台|系统|助手|你)的?版本|底层模型|你是谁开发",
)

# ── 寒暄/客套/低信息量：整句等价于这些词才算（不做子串匹配）──
_GREETING_EXACT: frozenset[str] = frozenset({
    "你好", "您好", "你好呀", "你好啊", "你好吗", "哈喽", "嗨", "嘿", "hi", "hello", "hey",
    "在吗", "在不在", "有人在吗", "早上好", "中午好", "下午好", "晚上好",
    "谢谢", "多谢", "感谢", "谢谢你", "好的", "好", "行", "ok", "收到", "明白",
    "再见", "拜拜", "没事了", "不用了", "哈哈", "呵呵", "哦", "噢", "嗯",
    "测试", "test", "testing", "随便", "不知道",
})

# ── 闲聊但只需"如实说明做不到"的请求：不检索、也不套讲稿模板 ──
_OFF_PLATFORM: tuple[str, ...] = (
    r"今天(天气|气温)|天气(怎么样|如何)|现在几点|今天(几号|星期几|周几)",
    r"讲(个|一个)?笑话|说(个|一个)?笑话|来(个|段)(相声|故事)",
    r"(帮我)?(点|叫|下)(外卖|单)|发(个)?红包",
)

# 元问题允许的最大长度：超长句里的"你是谁"多半是材料内容，仍交给检索
_META_MAX_CHARS = 28

_STRIP_RE = re.compile(r"[\s\.,;:!、。，；：！??…\-\"'`（）()\[\]{}]+")
_HAS_CJK = re.compile(r"[\u4e00-\u9fff]")
_ASCII_WORD = re.compile(r"[A-Za-z][A-Za-z0-9+#.\-]{1,}")


def _normalize(text: str) -> str:
    return _STRIP_RE.sub("", str(text or "").strip().lower())


def is_meta_question(text: str) -> Optional[str]:
    """是否属于"问助手本身 / 寒暄 / 低信息量"。返回命中原因，None 表示不是元问题。"""
    norm = _normalize(text)
    if not norm:
        return "空提问"
    if len(norm) > _META_MAX_CHARS:
        return None

    if norm in _GREETING_EXACT:
        return "寒暄"
    if re.fullmatch(r"[\d一二两三四五六七八九十a-z]{1,3}", norm):
        return "低信息量"
    if not _HAS_CJK.search(norm) and not _ASCII_WORD.search(norm):
        return "低信息量"

    for rx in _META_PATTERNS:
        if re.search(rx, norm):
            return "身份/能力询问"
    for rx in _OFF_PLATFORM:
        if re.search(rx, norm):
            return "平台外请求"
    return None


def should_retrieve(text: str) -> tuple[bool, str]:
    """这句话是否值得查知识库。

    元问题一律不查；短到没有实体词的也不查（LIKE 与向量都会被"怎么""是什么"
    这类疑问词带偏，命中一堆无关切片，比不注入更糟）。
    """
    reason = is_meta_question(text)
    if reason:
        return False, f"元问题({reason})"
    norm = _normalize(text)
    if len(norm) < 2:
        return False, "过短/无实体词"
    return True, "知识提问"