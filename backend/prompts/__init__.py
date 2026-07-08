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
        import logging
        logging.getLogger(__name__).error(
            f"技能注入失败，已降级为原始 Prompt: {e}", exc_info=True
        )
        return base_prompt


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
        from backend.api.config_router import get_config_value
        enabled = get_config_value("enabled_skills", [])
        return build_prompt_with_skills(
            base_prompt=base_prompt,
            skill_names=enabled,
            context={"type": scene_type},
            enabled_names=enabled,
        )
    except Exception:
        return base_prompt
