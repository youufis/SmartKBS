"""
技能引擎 (Skill Engine)

核心职责：
1. 扫描 skills/ 目录加载所有 .skill.md 文件
2. 解析 YAML 前件 + Markdown 正文
3. 根据场景组合多个技能为 Prompt 增强段
4. 处理技能冲突、优先级和依赖
5. 支持热加载（开发环境）

设计原则：
- 零侵入：任何加载/解析失败都不影响主流程
- 可回退：关闭全部技能 = 系统行为不变
- 可观测：每步操作都有日志
"""

import os
import re
import json
import time
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ── 技能文档目录 ──
# 优先使用环境变量，默认相对于 backend 目录
DEFAULT_SKILL_DIR = Path(__file__).resolve().parent / "skills"


# ═══════════════════════════════════════════════
# 数据结构
# ═══════════════════════════════════════════════

@dataclass
class ComposeConfig:
    """技能组合配置"""
    priority: int = 50           # 优先级（数值越高越优先）
    position: str = "prefix"     # 注入位置：prefix=基础 Prompt 前, suffix=后
    requires: list[str] = field(default_factory=list)   # 前置依赖技能
    conflicts_with: list[str] = field(default_factory=list)  # 冲突技能


@dataclass
class SkillDoc:
    """解析后的技能文档"""
    name: str
    version: str
    display_name: str
    description: str
    type: str                    # core / domain / adapter
    tags: list[str]
    compatible_with: list[str]   # 兼容场景列表
    compose: ComposeConfig
    sections: dict[str, str]     # Markdown 章节标题 → 内容
    raw_yaml: dict               # 原始 YAML 数据
    file_path: str               # 源文件路径
    file_mtime: float            # 文件修改时间戳
    parse_error: Optional[str] = None  # 解析错误信息


# ═══════════════════════════════════════════════
# YAML 解析（轻量级，不依赖 PyYAML）
# ═══════════════════════════════════════════════

def _parse_yaml_frontmatter(text: str) -> tuple[dict[str, Any], str, Optional[str]]:
    """解析 YAML 前件和 Markdown 正文

    支持标准的 --- 包裹的 YAML 前件。
    如果解析失败，返回 (空字典, 全文, 错误信息)。

    Returns:
        (yaml_dict, markdown_body, error)
    """
    text = text.strip()
    if not text.startswith("---"):
        return {}, text, "缺少 YAML 前件（不以 --- 开头）"

    # 查找第二个 ---
    end_idx = text.find("---", 3)
    if end_idx == -1:
        return {}, text, "YAML 前件未闭合（缺少结尾 ---）"

    yaml_text = text[3:end_idx].strip()
    markdown_body = text[end_idx + 3:].strip()

    # 逐行解析简单的 YAML（仅支持 skill.md 需要的子集）
    yaml_dict = {}
    error = None
    current_key = None
    current_list = None
    list_indent = -1

    for line in yaml_text.split("\n"):
        # 忽略空行和注释
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        # 检测列表项
        list_match = re.match(r"^(\s+)-\s+(.+)$", line)
        if list_match:
            indent = len(list_match.group(1))
            value = list_match.group(2).strip()
            if current_key and indent > list_indent:
                if current_list is not None:
                    current_list.append(value)
                else:
                    current_list = [value]
                    yaml_dict[current_key] = current_list
                    list_indent = indent
            else:
                # 新列表开始
                current_list = [value]
                # 找前面的 key
                for k, v in list(yaml_dict.items()):
                    if isinstance(v, list) and v is not current_list:
                        current_list = None
                continue
        else:
            current_list = None
            list_indent = -1

        # 检测 key: value
        kv_match = re.match(r"^(\w[\w_-]*)\s*:\s*(.*)$", line)
        if kv_match:
            current_key = kv_match.group(1)
            raw_value = kv_match.group(2).strip()

            # 处理引号
            if raw_value.startswith('"') and raw_value.endswith('"'):
                raw_value = raw_value[1:-1]
            elif raw_value.startswith("'") and raw_value.endswith("'"):
                raw_value = raw_value[1:-1]

            # 处理嵌套结构（优先）
            nested_match = re.match(r"^\{(\w[\w_-]*)\s*:\s*(.+)\}$", line)
            if nested_match:
                # 简单嵌套对象
                pass

            # 尝试 JSON 解析（用于复杂值）
            if raw_value and raw_value[0] in ("[", "{"):
                try:
                    yaml_dict[current_key] = json.loads(raw_value)
                    continue
                except json.JSONDecodeError:
                    pass

            # 布尔值
            if raw_value.lower() in ("true", "yes"):
                yaml_dict[current_key] = True
            elif raw_value.lower() in ("false", "no"):
                yaml_dict[current_key] = False
            # 数字
            elif raw_value.isdigit():
                yaml_dict[current_key] = int(raw_value)
            elif re.match(r"^\d+\.\d+$", raw_value):
                yaml_dict[current_key] = float(raw_value)
            elif raw_value == "" or raw_value is None:
                yaml_dict[current_key] = ""
            else:
                yaml_dict[current_key] = raw_value

            # 处理内联列表
            if isinstance(yaml_dict.get(current_key), str):
                v = yaml_dict[current_key]
                if v.startswith("[") and v.endswith("]"):
                    try:
                        yaml_dict[current_key] = json.loads(v)
                    except json.JSONDecodeError:
                        yaml_dict[current_key] = [x.strip().strip("'\"") for x in v[1:-1].split(",") if x.strip()]

        # 检测多行字符串（缩进内容）
        elif current_key and stripped and not line.startswith(" "):
            # 新 key 开始，之前的 key 可能是多行
            pass

    # 后处理：修正列表的缩进识别
    # 递归处理嵌套字典
    _deep_parse(yaml_dict)

    return yaml_dict, markdown_body, error


def _deep_parse(d: dict):
    """递归解析 YAML 中的嵌套字典"""
    for k, v in list(d.items()):
        if isinstance(v, str) and v.startswith("{") and v.endswith("}"):
            try:
                d[k] = json.loads(v)
            except json.JSONDecodeError:
                pass


def _parse_sections(markdown: str) -> dict[str, str]:
    """将 Markdown 正文按 ## 标题拆分为章节

    Returns:
        {章节标题: 章节内容}
    """
    sections = {}
    # 匹配 ## 标题（跳过 ### 等）
    pattern = re.compile(r"^##\s+(.+)$", re.MULTILINE)
    parts = pattern.split(markdown)

    if not parts:
        return {"": markdown}

    # parts[0] 是 ## 标题之前的内容（通常是 Overview）
    if parts[0].strip():
        sections["_overview"] = parts[0].strip()

    for i in range(1, len(parts), 2):
        if i + 1 < len(parts):
            title = parts[i].strip()
            content = parts[i + 1].strip()
            sections[title] = content

    return sections


# ═══════════════════════════════════════════════
# 技能引擎核心
# ═══════════════════════════════════════════════

class SkillEngine:
    """技能引擎（单例模式）"""

    _instance: Optional["SkillEngine"] = None
    _CACHE_TTL = 300  # 缓存有效期 5 分钟

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self._skills: dict[str, SkillDoc] = {}       # name → SkillDoc
        self._skill_dir: Path = DEFAULT_SKILL_DIR
        self._loaded_at: float = 0
        self._load_errors: list[str] = []             # 加载过程中的错误
        logger.info(f"技能引擎初始化，技能目录: {self._skill_dir}")

    # ── 公开 API ──

    def load_all(self, skill_dir: Optional[str] = None) -> int:
        """加载所有技能文档

        Args:
            skill_dir: 技能目录路径，默认使用 DEFAULT_SKILL_DIR

        Returns:
            成功加载的技能数量
        """
        if skill_dir:
            self._skill_dir = Path(skill_dir)

        if not self._skill_dir.exists():
            logger.warning(f"技能目录不存在: {self._skill_dir}")
            return 0

        self._skills = {}
        self._load_errors = []
        count = 0

        # 递归搜索所有 .skill.md 文件
        skill_files = sorted(self._skill_dir.rglob("*.skill.md"))
        if not skill_files:
            logger.info(f"技能目录中未找到 .skill.md 文件: {self._skill_dir}")
            return 0

        for fpath in skill_files:
            doc = self._load_single(fpath)
            if doc and not doc.parse_error:
                if doc.name in self._skills:
                    logger.warning(f"技能名称重复: {doc.name} (已存在: {self._skills[doc.name].file_path}, 跳过: {fpath})")
                    continue
                self._skills[doc.name] = doc
                count += 1
            elif doc:
                self._load_errors.append(f"{fpath.name}: {doc.parse_error}")

        self._loaded_at = time.time()
        logger.info(f"技能引擎加载完成: {count} 个技能成功, {len(self._load_errors)} 个失败")
        for err in self._load_errors:
            logger.warning(f"技能加载失败: {err}")

        return count

    def get(self, name: str) -> Optional[SkillDoc]:
        """获取指定技能文档"""
        self._ensure_loaded()
        return self._skills.get(name)

    def list_skills(self, tag: Optional[str] = None,
                     skill_type: Optional[str] = None,
                     compatible: Optional[str] = None) -> list[SkillDoc]:
        """列出技能，可按标签/类型/兼容场景过滤"""
        self._ensure_loaded()
        results = []
        for skill in self._skills.values():
            if tag and tag not in skill.tags:
                continue
            if skill_type and skill.type != skill_type:
                continue
            if compatible and compatible not in skill.compatible_with:
                continue
            results.append(skill)
        return sorted(results, key=lambda s: s.compose.priority, reverse=True)

    def list_enabled(self, enabled_names: list[str]) -> list[SkillDoc]:
        """列出已启用的技能（按优先级排序）"""
        self._ensure_loaded()
        results = []
        for name in enabled_names:
            skill = self._skills.get(name)
            if skill:
                results.append(skill)
            else:
                logger.warning(f"启用的技能不存在: {name}")
        return sorted(results, key=lambda s: s.compose.priority, reverse=True)

    def compose(self, skill_names: list[str],
                context: Optional[dict] = None,
                enabled_names: Optional[list[str]] = None) -> str:
        """将多个技能组合为 Prompt 增强段

        Args:
            skill_names: 请求的技能列表
            context: 上下文信息（场景、学科等）
            enabled_names: 全局已启用技能列表（None=不检查启用状态）

        Returns:
            组合后的 Prompt 增强段（为空字符串表示无需增强）
        """
        if not skill_names:
            return ""

        self._ensure_loaded()

        # 解析可用技能
        available = []
        scene_type = (context or {}).get("type", "")
        for name in skill_names:
            skill = self._skills.get(name)
            if not skill:
                logger.debug(f"技能不存在: {name}，跳过")
                continue
            if enabled_names is not None and name not in enabled_names:
                logger.debug(f"技能未启用: {name}，跳过")
                continue
            # 按兼容场景过滤：compatible_with 为空表示兼容所有场景
            if scene_type and skill.compatible_with and scene_type not in skill.compatible_with:
                logger.debug(f"技能 {name} 不兼容场景 {scene_type}，跳过")
                continue
            available.append(skill)

        if not available:
            return ""

        # 按优先级排序
        available.sort(key=lambda s: s.compose.priority, reverse=True)

        # 检查依赖
        resolved = self._resolve_dependencies(available)
        if not resolved:
            return ""

        # 检查冲突
        resolved = self._filter_conflicts(resolved)

        # 构建增强段
        segments = []
        for skill in resolved:
            segment = self._build_skill_segment(skill, context)
            if segment:
                segments.append(segment)

        if not segments:
            return ""

        return "\n\n".join(segments)

    def validate(self, skill_names: list[str]) -> dict[str, Any]:
        """验证技能组合是否合法

        Returns:
            {"valid": bool, "errors": [str], "warnings": [str]}
        """
        self._ensure_loaded()
        result = {"valid": True, "errors": [], "warnings": []}

        if not skill_names:
            return result

        skills = []
        for name in skill_names:
            skill = self._skills.get(name)
            if not skill:
                result["errors"].append(f"技能不存在: {name}")
            else:
                skills.append(skill)

        # 检查依赖
        for skill in skills:
            for req in skill.compose.requires:
                if req not in skill_names:
                    result["warnings"].append(
                        f"技能 {skill.name} 需要前置技能 {req}，但未在列表中"
                    )

        # 检查冲突
        for i, s1 in enumerate(skills):
            for s2 in skills[i + 1:]:
                if s2.name in s1.compose.conflicts_with:
                    result["warnings"].append(
                        f"技能 {s1.name} 与 {s2.name} 存在冲突"
                    )

        if result["errors"]:
            result["valid"] = False
        return result

    def get_load_errors(self) -> list[str]:
        """获取加载错误列表"""
        return self._load_errors.copy()

    def clear_cache(self):
        """清空缓存，下次访问时重新加载"""
        self._loaded_at = 0

    # ── 内部方法 ──

    def _ensure_loaded(self):
        """确保技能已加载（惰性加载）"""
        if not self._skills:
            self.load_all()

    def _load_single(self, fpath: Path) -> Optional[SkillDoc]:
        """加载单个技能文档"""
        try:
            mtime = fpath.stat().st_mtime
            content = fpath.read_text(encoding="utf-8")
        except Exception as e:
            logger.error(f"读取技能文件失败: {fpath} - {e}")
            return None

        # 解析 YAML 前件
        yaml_dict, markdown_body, yaml_error = _parse_yaml_frontmatter(content)

        if yaml_error:
            # 创建带错误的 Document
            return SkillDoc(
                name=fpath.stem,
                version="0.0.0",
                display_name=fpath.stem,
                description="",
                type="unknown",
                tags=[],
                compatible_with=[],
                compose=ComposeConfig(),
                sections={},
                raw_yaml=yaml_dict,
                file_path=str(fpath),
                file_mtime=mtime,
                parse_error=yaml_error,
            )

        # 提取 compose 配置
        compose_config = ComposeConfig()
        compose_raw = yaml_dict.get("compose", {})
        if isinstance(compose_raw, dict):
            compose_config.priority = compose_raw.get("priority", 50)
            compose_config.position = compose_raw.get("position", "prefix")
            compose_config.requires = compose_raw.get("requires", [])
            compose_config.conflicts_with = compose_raw.get("conflicts_with", [])

        # 提取兼容场景
        compatible = yaml_dict.get("compatible_with", [])
        if isinstance(compatible, str):
            compatible = [compatible]

        # 提取标签
        tags = yaml_dict.get("tags", [])
        if isinstance(tags, str):
            tags = [tags]

        # 解析 Markdown 章节
        sections = _parse_sections(markdown_body)

        return SkillDoc(
            name=yaml_dict.get("name", fpath.stem),
            version=str(yaml_dict.get("version", "0.0.0")),
            display_name=yaml_dict.get("display_name", yaml_dict.get("name", fpath.stem)),
            description=yaml_dict.get("description", ""),
            type=yaml_dict.get("type", "unknown"),
            tags=tags,
            compatible_with=compatible,
            compose=compose_config,
            sections=sections,
            raw_yaml=yaml_dict,
            file_path=str(fpath),
            file_mtime=mtime,
        )

    def _resolve_dependencies(self, skills: list[SkillDoc]) -> list[SkillDoc]:
        """解析技能依赖，确保前置技能存在"""
        available_names = {s.name for s in skills}
        result = list(skills)

        for skill in skills:
            for req in skill.compose.requires:
                if req not in available_names:
                    logger.warning(
                        f"技能 {skill.name} 依赖 {req}，但当前组合中不存在"
                    )
        return result

    def _filter_conflicts(self, skills: list[SkillDoc]) -> list[SkillDoc]:
        """过滤冲突技能（保留优先级高的）"""
        result = list(skills)
        removed = set()

        for i, s1 in enumerate(skills):
            for s2 in skills[i + 1:]:
                if s2.name in s1.compose.conflicts_with:
                    # 保留优先级高的
                    if s1.compose.priority >= s2.compose.priority:
                        removed.add(s2.name)
                        logger.debug(f"技能冲突: {s2.name} 与 {s1.name} 冲突，已移除 {s2.name}")
                    else:
                        removed.add(s1.name)
                        logger.debug(f"技能冲突: {s1.name} 与 {s2.name} 冲突，已移除 {s1.name}")

        return [s for s in result if s.name not in removed]

    def _get_section(self, skill: SkillDoc, prefix: str) -> str:
        """用前缀匹配获取章节内容（兼容中文备注）"""
        for key, content in skill.sections.items():
            if key.startswith(prefix):
                return content
        return ""

    def _build_skill_segment(self, skill: SkillDoc,
                              context: Optional[dict] = None) -> str:
        """构建单个技能的 Prompt 增强段"""
        parts = [f"<!-- {skill.display_name} v{skill.version} -->"]

        # 添加 Overview
        overview = self._get_section(skill, "_overview")
        if overview:
            parts.append(overview)

        # 添加核心章节（按顺序）
        chapter_map = [
            ("Phase 1:", "## 阶段一：深度分析"),
            ("Phase 2:", "## 阶段二：结构化输出"),
            ("Phase 3:", "## 阶段三：自我审查"),
            ("Quality Constraints", "## 质量约束"),
        ]

        for prefix, heading in chapter_map:
            content = self._get_section(skill, prefix)
            if content:
                parts.append(f"{heading}\n\n{content}")

        # 添加 Instructions 章节（通用兜底）
        instructions = self._get_section(skill, "Instructions")
        if instructions:
            parts.append(f"## 指令\n\n{instructions}")

        return "\n\n".join(parts)

    def to_dict(self, skill: SkillDoc) -> dict[str, Any]:
        """将技能文档转为字典（用于 API 输出）"""
        return {
            "name": skill.name,
            "version": skill.version,
            "display_name": skill.display_name,
            "description": skill.description,
            "type": skill.type,
            "tags": skill.tags,
            "compatible_with": skill.compatible_with,
            "priority": skill.compose.priority,
            "requires": skill.compose.requires,
            "conflicts_with": skill.compose.conflicts_with,
            "sections": list(skill.sections.keys()),
            "file_path": skill.file_path,
            "parse_error": skill.parse_error,
        }


# ═══════════════════════════════════════════════
# 便捷函数（供外部调用）
# ═══════════════════════════════════════════════

_engine: Optional[SkillEngine] = None


def get_engine() -> SkillEngine:
    """获取技能引擎单例"""
    global _engine
    if _engine is None:
        _engine = SkillEngine()
    return _engine


def build_skill_prompt_segment(
    skill_names: list[str],
    context: Optional[dict] = None,
    enabled_names: Optional[list[str]] = None,
) -> str:
    """快捷方式：构建技能 Prompt 增强段

    这是外部调用的主要入口。所有异常都被吞掉，确保不影响主流程。

    Args:
        skill_names: 请求的技能名称列表
        context: 上下文信息字典
        enabled_names: 已启用的技能名称列表（None=不检查）

    Returns:
        增强段文本（出错时返回空字符串）
    """
    try:
        engine = get_engine()
        return engine.compose(
            skill_names=skill_names,
            context=context,
            enabled_names=enabled_names,
        )
    except Exception as e:
        logger.error(f"构建技能增强段失败: {e}", exc_info=True)
        return ""
