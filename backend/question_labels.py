"""题型标签统一口径：导出文档（Word/Excel）一律用中文标签，跟随系统配置 QUESTION_TYPES（含自定义题型）。

统计 API 仍返回原始 key（前端自行映射），只有"给人看的文档"走这里，避免 single/true_false 漏进附表。
"""
from __future__ import annotations

# 与 config_router.DEFAULT_CONFIG["QUESTION_TYPES"] 同口径的兜底表
DEFAULT_TYPE_LABELS = {
    "single": "单选题",
    "multiple": "多选题",
    "true_false": "判断题",
    "short": "简答题",
    "fill": "填空题",
    "essay": "作文",
    "subjective": "主观题",
}


def question_type_label(key: str | None) -> str:
    """原始题型 key → 配置标签；未登记键原样返回（不丢信息），空值返回空串。"""
    k = str(key or "").strip()
    if not k:
        return ""
    try:
        from backend.api.config_router import get_config_value
        for t in get_config_value("QUESTION_TYPES", []) or []:
            if isinstance(t, dict) and str(t.get("key") or "") == k:
                return str(t.get("label") or k)
    except Exception:  # noqa: BLE001 - 配置不可用时兜底表保证文档可读
        pass
    return DEFAULT_TYPE_LABELS.get(k, k)
