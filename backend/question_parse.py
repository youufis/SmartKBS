# -*- coding: utf-8 -*-
"""AI 题目 JSON 的统一解析：快速三策略 → 8.2 容错层 → 题干选项剥离。

为什么单独成模块
----------------
课堂抽问 / 随堂测验 / 同步练习 / 课堂闯关此前各写一份解析，强度差异很大：
课堂四功能用的是「extract_json_from_text + list/dict」的简版，模型返回只要多一句
客套话、一个尾逗号或一处截断，整批就 0 道；试题管理那份有快速三策略 + ai_json 8.2
容错层 + 题干内嵌选项剥离 + 失败原文留档，成功率高得多。同一份模型输出不该因为
入口不同而一半能解析、一半不能 —— 本模块就是那份最完整实现的唯一副本。

用法：
    from backend.question_parse import parse_question_array
    questions = parse_question_array(text, scene="class_drill")

调用方拿到的是**原样 dict 列表**（字段未归一）；缺答案/越界/选项不足等业务校验
仍由各入口或 question_factory 负责，本模块只解决「把 JSON 从模型输出里抠出来」。
"""
from __future__ import annotations

import json
import re
from typing import Any

from backend.logger import logger


def parse_question_array(text: str, *, scene: str = "question") -> list[dict[str, Any]]:
    """解析 AI 返回的 JSON 试题列表，失败时走容错层兜底。

    兜底层处理：客套话包裹、fence 代码块、尾逗号、非法转义、截断补齐；
    全部失败时原文留档 LogFiles/ai_raw 便于复盘；
    解析成功后剥离误写进题干的选项（strip 只在证据充分时动手，不会误伤）。

    scene 只用于日志与留档文件名，方便定位是哪个入口的模型输出格式漂了。
    """
    from backend import ai_json

    questions = _fast_parse(text)
    if not questions:
        # 兜底①：utils 的「从 [ 到文本末尾抢救被截断的数组」对硬截断最长用
        # （实测整批只剩前半截时它能救回已闭合的条目，8.2 层在这里反而救不回）。
        questions = _salvage_via_extract(text)
    if not questions:
        # 兜底②：ai_json 的 8.2 容错层（客套话/尾逗号/非法转义/截断补齐）
        got, meta = ai_json.extract_json_array2(text, salvage=True)
        if got:
            logger.info(f"[AI题解析] 容错层兜底成功 scene={scene} "
                        f"salvaged={meta.get('salvaged')}，共 {len(got)} 条")
            questions = got
        elif (text or "").strip():
            raw_path = ai_json.dump_failed_raw(scene, text)
            logger.error(f"[AI题解析] 全部策略失败 scene={scene}"
                         f"（原文留档: {raw_path}）前200字: {text[:200]}")

    out: list[dict[str, Any]] = []
    for q in questions or []:
        if not isinstance(q, dict):
            # 数组里混进 null / 字符串时直接丢弃：下游按 dict 取字段，
            # 放过去只会在 persist 或渲染处炸得更晚、更难定位。
            continue
        q, changed, why = ai_json.strip_options_from_stem(q)
        if changed:
            logger.info(f"[AI题解析] 已剥离题干内嵌选项 scene={scene}（{why}）")
        out.append(repair_question_math(q))
    return out


#: 这些字段的值是代码/标记/路径，反斜杠有别的语义，一律不碰
_CODE_KEYS = {"svg_code", "svg", "html", "htm", "css", "js", "script", "code",
              "url", "image_url", "path", "file", "filename", "base64", "data"}


def repair_questions(items: Any) -> Any:
    """题目 dict 列表统一过一遍公式还原 + 裸命令补 $。

    parse_question_array 内部已经调用；**不走那个函数的入口必须显式过一遍**
    （组卷 paper_compose、课堂闯关/同步练习补全 curriculum_router、单题兜底
    practice_router），否则同一份模型输出会因为入口不同而一半修好一半带病入库。
    """
    if isinstance(items, list):
        return [repair_question_math(q) for q in items]
    return repair_question_math(items)


def repair_question_math(node: Any) -> Any:
    """把一道题里所有文字字段被 JSON 转义吃掉的 LaTeX 命令还原，并给裸写的命令补 $ 定界符。

    必须放在解析这一步：损坏发生在 json.loads 里（``\\frac`` 的 ``\\f`` 是合法
    JSON 转义 → 换页符 + "rac"），等到前端渲染时反斜杠早就没了，只能靠这里补回。
    """
    from backend.math_text import repair_math_text, wrap_bare_math

    if isinstance(node, str):
        return wrap_bare_math(repair_math_text(node))
    if isinstance(node, list):
        return [repair_question_math(v) for v in node]
    if isinstance(node, dict):
        return {k: (v if isinstance(k, str) and k.strip().lower() in _CODE_KEYS
                    else repair_question_math(v)) for k, v in node.items()}
    return node


def _fast_parse(text: str) -> list[dict[str, Any]]:
    """快速路径：直接解析 / ```json 代码块 / 最外层 []，失败交给容错层。"""
    text = (text or "").strip()
    if not text:
        return []

    # 策略1：直接解析
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        elif isinstance(data, dict) and isinstance(data.get("questions"), list):
            return data["questions"]
    except json.JSONDecodeError:
        pass

    # 策略2：从 ```json ``` 代码块提取
    match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if match:
        try:
            data = json.loads(match.group(1))
            if isinstance(data, list):
                return data
            elif isinstance(data, dict) and isinstance(data.get("questions"), list):
                return data["questions"]
        except json.JSONDecodeError:
            pass

    # 策略3：从最外层 [ 到 ] 提取 JSON 数组
    start = text.find("[")
    end = text.rfind("]")
    if start != -1 and end != -1 and end > start:
        json_str = text[start:end + 1]
        json_str = json_str.replace("```json", "").replace("```", "").strip()
        try:
            data = json.loads(json_str)
            if isinstance(data, list):
                return data
            elif isinstance(data, dict) and isinstance(data.get("questions"), list):
                return data["questions"]
        except json.JSONDecodeError as e:
            # 这里失败不算终局：外层还有 utils 截断抢救与 8.2 容错层。
            # 用 debug 记，避免「兜底能救回」的正常情况刷 ERROR 堆栈；真全失败时
            # 外层会统一打一条 error 并存原文（见 parse_question_array）。
            logger.debug(f"JSON 快速解析失败（将走兜底）: {e}, 前200字: {text[:200]}")
            return []

    return []


def _salvage_via_extract(text: str) -> list[dict[str, Any]]:
    """用 utils.extract_json_from_text 兜底 —— 它擅长抢救被截断的数组。

    课堂系旧实现一直用它，硬截断（只剩前半截、后半条字段写了一半）时比 ai_json
    的 8.2 层更能救回已闭合的条目；合并进统一解析后不让这块能力退化。
    """
    try:
        from backend.utils import extract_json_from_text
        got = extract_json_from_text(text)
    except Exception as e:  # 兜底本身失败不该影响主流程
        logger.debug(f"[AI题解析] utils 兜底异常: {e}")
        return []
    if isinstance(got, list):
        return got
    if isinstance(got, dict):
        inner = got.get("questions")
        if isinstance(inner, list):
            return inner
        if "question" in got:      # 模型只回单个题目对象
            return [got]
    return []
