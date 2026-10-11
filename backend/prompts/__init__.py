"""
统一 Prompt 管理
集中管理所有 AI 调用使用的 Prompt 模板，便于维护和版本管理
"""
from typing import Optional

from backend.permission_service import _infer_stage


def build_ai_role(
    subject: str = "",
    grade: str = "",
    role_type: str = "teacher",
    style: str = "",
    subjects: Optional[list[str]] = None,
) -> str:
    """动态构建 AI 角色描述，去除所有硬编码的学科和学段

    根据学科名称和年级名称自动组合角色描述：
    - build_ai_role("数学", "高一")       → "你是一位高中数学教师"
    - build_ai_role("英语", "三年级")     → "你是一位小学英语教师"
    - build_ai_role("物理")               → "你是一位物理教师"
    - build_ai_role(grade="初一")         → "你是一位初中学科教师"
    - build_ai_role()                     → "你是一位学科教师"
    - build_ai_role(subjects=["数学","物理"], grade="高一")
                                         → "你一位高中数学、物理教师"

    Args:
        subject:  单学科名称（兼容旧调用，与 subjects 二选一）
        grade:    年级名称（如"高一"、"三年级"，用于推断学段）
        role_type: "teacher" | "expert" | "assistant"
        style:    额外风格描述，如"严谨的"、"经验丰富的"
        subjects: 多学科列表（优先使用，代替 subject 参数）

    Returns:
        动态角色描述字符串
    """
    # 1. 推断学段（小学/初中/高中）
    stage = _infer_stage(grade) if grade else ""

    # 2. 构建角色前缀
    if role_type == "expert":
        base = "你是一位经验丰富的"
    elif role_type == "assistant":
        base = "你是一位"
    else:
        base = "你是一位"

    # 3. 插入风格修饰
    if style:
        base += style

    # 4. 确定学科文本（优先多学科，其次单学科，最后通用）
    if subjects:
        subject_text = "、".join(s for s in subjects if s)
    elif subject:
        subject_text = subject
    else:
        subject_text = ""

    # 5. 动态组合学段和学科
    parts = [base]
    if stage:
        parts.append(stage)
    if subject_text:
        parts.append(subject_text)
    else:
        parts.append("学科")
    parts.append("教师")

    return "".join(parts)


# ═══════════════════════════════════════════════
# 技能系统集成
# ═══════════════════════════════════════════════

def build_prompt_with_skills(
    base_prompt: str,
    skill_names: Optional[list[str]] = None,
    context: Optional[dict] = None,
    enabled_names: Optional[list[str]] = None,
) -> str:
    """将技能增强段注入基础 Prompt

    这是技能系统的统一入口。所有异常都被吞掉，确保不影响主流程。

    Args:
        base_prompt: 原始的 Prompt 文本
        skill_names: 要应用的技能名称列表（None 或空列表 = 无增强）
        context: 上下文信息（如场景、学科等），传给技能引擎
        enabled_names: 全局已启用技能列表（None=不检查启用状态）

    Returns:
        注入技能后的 Prompt（出错时返回原始 base_prompt）
    """
    if not skill_names:
        return base_prompt

    try:
        from backend.skill_engine import build_skill_prompt_segment

        segment = build_skill_prompt_segment(
            skill_names=skill_names,
            context=context,
            enabled_names=enabled_names,
        )
        if not segment:
            return base_prompt

        # 技能增强段注入到基础 Prompt 之前
        return f"{segment}\n\n---\n\n{base_prompt}"
    except Exception as e:
        from backend.logger import logger
        logger.error(
            f"技能注入失败，已降级为原始 Prompt: {e}", exc_info=True
        )
        return base_prompt


def resolve_scene_skills(scene_type: str, enabled: list[str], scene_map: dict) -> list[str]:
    """场景×技能映射：按 skill_scene_map 声明过滤某场景实际生效的技能列表。

    - 场景未出现在映射中 → 原样返回（与无映射时行为完全一致）
    - include: 仅保留列表内技能（取交集，保持原顺序）
    - exclude: 在 include 之后再剔除列表内技能
    """
    if not isinstance(scene_map, dict) or not scene_map:
        return list(enabled)
    rule = scene_map.get(scene_type)
    if not isinstance(rule, dict):
        return list(enabled)
    eff = list(enabled)
    inc = rule.get("include")
    if isinstance(inc, list) and inc:
        inc_set = {str(x) for x in inc}
        eff = [n for n in eff if n in inc_set]
    exc = rule.get("exclude")
    if isinstance(exc, list) and exc:
        exc_set = {str(x) for x in exc}
        eff = [n for n in eff if n not in exc_set]
    return eff


# ═══════════════════════════════════════════════
# 技能段：外显护栏 + 场景合成（V8.6.1）
# ═══════════════════════════════════════════════

_SKILL_SEGMENT_GUARD_HEAD = (
    "【工作方式（仅供内部遵循，禁止外显）】\n"
    "下列要点是你组织答案时的内在标准，不是答案模板。"
    "严禁把这些小标题、条目、编号或勾选符号（- [ ] / - [x]）原样写进回答，"
    "也不要宣称\"我已完成深度分析/自我审查\"。"
)


# 对话场景的技能白名单兜底（V8.6.1）。
# 老部署的 system_config.json 里已有 skill_scene_map 但没有 chat/companion 条目，
# load_config 是浅合并（文件里的键整体覆盖默认值），只改 DEFAULT_CONFIG 管不到它们；
# 这里在代码侧再兜一层：没有显式规则时，对话场景绝不回灌
# 「输出质量三阶增强 / 分步推理 / 可视化表达」这类会把寒暄写成讲稿的模板技能。
# 管理员在「系统配置 → 技能管理 → 场景映射」里显式写出 chat/companion 规则即可覆盖本兜底。
_DIALOGUE_SCENE_DEFAULT: dict[str, list[str]] = {
    "chat": ["chat-conversation", "language-control", "safety-guard", "example-driven"],
    "companion": ["chat-conversation", "language-control", "safety-guard", "socratic-tutor"],
}


def resolve_dialogue_fallback(scene_type: str, enabled: list[str], scene_map: dict) -> tuple[list[str], bool]:
    """返回 (生效技能列表, 是否用了兜底白名单)。显式配置了该场景就完全听配置的。"""
    rule = (scene_map or {}).get(scene_type)
    if isinstance(rule, dict):
        return resolve_scene_skills(scene_type, enabled, scene_map), False
    allow = _DIALOGUE_SCENE_DEFAULT.get(scene_type)
    if not allow:
        return list(enabled), False
    ordered = [n for n in allow if n in set(enabled)]
    return ordered, True


def compose_scene_segment(scene_type: str) -> tuple[str, list[str]]:
    """按场景合成技能段（带禁止外显前言），返回 (段文本, 实际注入的技能名)。

    供两条链路复用：
    - apply_skills()：老场景，段文本前置拼进任务 prompt（行为不变，只多了护栏）
    - chat_router：对话场景，段文本放进 system，不再与用户原话混在一条消息里
    """
    from backend.api.config_router import get_config_value
    from backend.skill_engine import build_skill_prompt_segment, get_engine

    enabled = get_config_value("enabled_skills", [])
    scene_map = get_config_value("skill_scene_map", {})
    effective, used_fallback = resolve_dialogue_fallback(scene_type, enabled, scene_map)
    if not effective:
        return "", []
    if used_fallback:
        from backend.logger import logger
        logger.info(f"技能场景映射未配置 {scene_type}，启用对话白名单兜底: {effective}")

    raw = build_skill_prompt_segment(
        skill_names=effective,
        context={"type": scene_type},
        enabled_names=enabled,
    )
    if not raw:
        return "", []

    eng = get_engine()
    fired = [n for n in effective
             if (lambda s: bool(s) and f"<!-- {s.display_name} v" in raw)(eng.get(n))]
    guarded = f"{_SKILL_SEGMENT_GUARD_HEAD}\n\n{raw}"
    return guarded, (fired or effective)


def build_skills_segment(scene_type: str) -> str:
    """只取某场景的技能段文本（不拼任务正文），并记录一次使用统计。异常返回空串。

    对话链路（V8.6.1）用它把技能段放进 system，而不是拼进用户正文；
    统计口径与 apply_skills 一致：记"实际注入"的技能。
    """
    try:
        guarded, fired = compose_scene_segment(scene_type)
        if guarded:
            try:
                from backend import skill_stats
                skill_stats.record_usage(scene_type, fired, len(guarded))
            except Exception:
                pass
        return guarded
    except Exception:
        return ""


def apply_skills(base_prompt: str, scene_type: str) -> str:
    """一键注入：读取已启用的技能并按场景过滤后注入到 Prompt

    这是各个 Router 中使用的便捷接口。自动处理所有异常。

    Args:
        base_prompt: 原始的 Prompt 文本
        scene_type: 场景类型（如 "exam"、"quiz"、"code-review" 等）

    Returns:
        注入技能后的 Prompt（出错时返回原始 base_prompt）
    """
    try:
        guarded, fired = compose_scene_segment(scene_type)
        if not guarded:
            return base_prompt
        out = f"{guarded}\n\n---\n\n{base_prompt}"
        try:  # C: 使用统计(内部自带 try/except, 失败静默, 不影响主流程)
            from backend import skill_stats
            skill_stats.record_usage(scene_type, fired, len(out) - len(base_prompt))
        except Exception:
            pass
        return out
    except Exception:
        return base_prompt
