"""
SmartKB 国际化支持模块
- 从 JSON 文件加载翻译
- 提供 T() 函数用于后端消息翻译
- 支持按 Accept-Language 请求头选择语言
"""
import json
import os
from pathlib import Path
from typing import Optional

_LOCALE_DIR = Path(__file__).resolve().parent / "locales"

# 缓存已加载的翻译
_translations: dict[str, dict[str, str]] = {}

# 支持的语言
SUPPORTED_LANGUAGES = ["zh-CN", "en"]

# 默认语言
_DEFAULT_LANG = "zh-CN"


def _load_translations(lang: str) -> dict[str, str]:
    """加载指定语言的翻译文件"""
    if lang in _translations:
        return _translations[lang]

    lang_dir = _LOCALE_DIR / lang
    if not lang_dir.exists():
        return {}

    merged: dict[str, str] = {}
    if lang_dir.is_dir():
        for json_file in sorted(lang_dir.glob("*.json")):
            try:
                data = json.loads(json_file.read_text(encoding="utf-8"))
                _flatten_dict(merged, data, prefix=json_file.stem)
            except Exception:
                pass

    _translations[lang] = merged
    return merged


def _flatten_dict(result: dict, d: dict, prefix: str = "") -> None:
    """将嵌套字典展平为点分隔键（如 'common.app.name'）"""
    for key, value in d.items():
        full_key = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            _flatten_dict(result, value, prefix=full_key)
        else:
            result[full_key] = str(value)


def get_translation(key: str, lang: Optional[str] = None, **kwargs) -> str:
    """
    获取翻译文本

    Args:
        key: 翻译键，如 'common.app.name'
        lang: 目标语言代码，默认使用 _DEFAULT_LANG
        **kwargs: 格式化参数

    Returns:
        翻译后的文本，未找到则返回键名
    """
    lang = lang or _DEFAULT_LANG
    translations = _load_translations(lang)

    # 先精确查找
    text = translations.get(key)

    # 如果未找到，回退到默认语言
    if text is None and lang != _DEFAULT_LANG:
        translations = _load_translations(_DEFAULT_LANG)
        text = translations.get(key)

    # 仍未找到，返回键名
    if text is None:
        return key

    # 格式化
    if kwargs:
        try:
            return text.format(**kwargs)
        except KeyError:
            return text

    return text


# 简短别名
T = get_translation


def get_language_from_accept_header(accept_language: Optional[str]) -> str:
    """从 Accept-Language 请求头解析语言"""
    if not accept_language:
        return _DEFAULT_LANG

    # 按 q 值排序的语言列表（简化处理，只取第一个）
    for part in accept_language.split(","):
        lang = part.strip().split(";")[0].strip()
        # 匹配支持的语言
        for supported in SUPPORTED_LANGUAGES:
            if lang.startswith(supported.split("-")[0]):
                return supported

    return _DEFAULT_LANG


def resolve_lang_from_request(request) -> str:
    """从 FastAPI Request 对象中获取语言"""
    accept = request.headers.get("Accept-Language")
    return get_language_from_accept_header(accept)
