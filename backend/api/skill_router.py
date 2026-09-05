"""
技能管理 API 路由

提供对技能文档系统的管理接口：
- GET  /api/skills          — 列出全部可用技能（登录）
- GET  /api/skills/enabled  — 获取已启用的技能名称列表（登录）
- PUT  /api/skills/enabled  — 更新已启用的技能列表（管理员）
- POST /api/skills/reload   — 重新加载技能（管理员）
- POST /api/skills/validate — 验证技能组合是否合法（登录）
- GET  /api/skills/{name}   — 获取技能详情，含原始文档（管理员）
- PUT  /api/skills/{name}   — 更新技能文档内容（管理员）

技能启用状态存储在 system_config.json 的 enabled_skills 字段中。

本轮加固说明：
- S1 读接口原先完全没有鉴权（匿名可枚举技能库内容），现统一要求登录；
      含原始文档正文的详情接口收敛为仅管理员。
- S2 输出不再携带服务器绝对路径 file_path，解析错误详情仅管理员可见。
- S3 GET /api/skills/enabled 原先被 /{name} 的路由顺序遮蔽（返回 404），
      现把字面量路径声明在通配路径之前。
- S4 写接口加上大小/结构校验，写入后解析失败自动回滚原文件，避免改坏技能库。
- S5 读路径改用惰性缓存 ensure_fresh()，不再每个请求全量重扫磁盘。
"""
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user, require_admin
from backend.logger import logger

router = APIRouter()

# S4: 技能文档正文上限（字符），防止超长请求体占用内存/写坏磁盘
MAX_SKILL_CONTENT = 200_000
# S5: 读缓存新鲜度（秒）
SKILL_CACHE_TTL = 5.0


class EnabledSkillsUpdate(BaseModel):
    """更新已启用技能列表的请求体"""
    enabled_skills: list[str]


class SkillUpdate(BaseModel):
    """更新技能文档的请求体"""
    raw_content: str


# ── 辅助函数 ──

def _get_engine():
    """获取技能引擎实例"""
    from backend.skill_engine import get_engine
    return get_engine()


def _load_global_config():
    """加载系统配置"""
    from backend.api.config_router import load_config
    return load_config()


def _save_global_config(config: dict[str, Any]):
    """保存系统配置"""
    from backend.api.config_router import save_config
    save_config(config)


def _is_admin(user: dict[str, Any] | None) -> bool:
    return bool(user) and user.get("role") == 0


def _skill_dict(engine, skill, admin: bool) -> dict[str, Any]:
    """S2: 统一的技能输出净化（不含 file_path；parse_error 仅管理员）"""
    info = engine.to_dict(skill, include_private=admin)
    info.pop("file_path", None)
    return info


# ── API 端点 ──
# 注意：所有字面量路径必须声明在通配路径 /{name} 之前，否则会被其遮蔽（S3）


@router.get("", summary="列出全部可用技能")
async def list_skills(request: Request):
    """获取所有已安装的技能文档列表（需登录，管理员额外可见解析错误详情）"""
    user = get_current_user(request)
    admin = _is_admin(user)

    engine = _get_engine()
    engine.ensure_fresh(SKILL_CACHE_TTL)
    skills = engine.list_skills()

    config = _load_global_config()
    enabled = config.get("enabled_skills", [])

    result = []
    for skill in skills:
        info = _skill_dict(engine, skill, admin)
        info["enabled"] = skill.name in enabled
        result.append(info)

    errors = engine.get_load_errors()
    return {
        "skills": result,
        "total": len(result),
        "errors": errors if admin else [],
        "error_count": len(errors),
    }


@router.get("/enabled", summary="获取已启用的技能列表")
async def get_enabled_skills(request: Request):
    """获取当前已启用的技能名称列表（需登录，无需管理员身份）"""
    user = get_current_user(request)
    admin = _is_admin(user)

    config = _load_global_config()
    enabled = config.get("enabled_skills", [])

    engine = _get_engine()
    engine.ensure_fresh(SKILL_CACHE_TTL)
    skills = engine.list_enabled(enabled)

    return {
        "enabled_skills": enabled,
        "skill_details": [_skill_dict(engine, s, admin) for s in skills],
    }


@router.put("/enabled", summary="更新已启用的技能列表")
async def update_enabled_skills(req: EnabledSkillsUpdate, request: Request):
    """更新已启用的技能列表（管理员）

    请求体: {"enabled_skills": ["quality-enhancer", "chain-of-thought"]}
    空列表表示关闭所有技能。
    """
    user = get_current_user(request)
    require_admin(user)

    # 验证所有技能都存在
    engine = _get_engine()
    engine.ensure_fresh(SKILL_CACHE_TTL)
    not_found = [n for n in req.enabled_skills if not engine.get(n)]

    if not_found:
        raise HTTPException(
            status_code=400,
            detail=f"以下技能不存在: {', '.join(not_found)}",
        )

    # 保存到 system_config.json
    config = _load_global_config()
    config["enabled_skills"] = list(req.enabled_skills)
    _save_global_config(config)

    logger.info(f"已启用技能列表更新: {req.enabled_skills}")
    return {
        "enabled_skills": req.enabled_skills,
        "message": f"已启用 {len(req.enabled_skills)} 个技能",
    }


@router.post("/reload", summary="重新加载技能")
async def reload_skills(request: Request):
    """重新扫描技能目录并加载所有技能文档（管理员）"""
    user = get_current_user(request)
    require_admin(user)

    engine = _get_engine()
    engine.clear_cache()
    count = engine.load_all()
    errors = engine.get_load_errors()

    return {
        "loaded": count,
        "errors": errors,
        "message": f"成功加载 {count} 个技能" + (f"，{len(errors)} 个失败" if errors else ""),
    }


@router.post("/validate", summary="验证技能组合")
async def validate_skills(req: EnabledSkillsUpdate, request: Request):
    """验证给定的技能组合是否合法（依赖检查、冲突检查）（需登录）"""
    get_current_user(request)
    engine = _get_engine()
    engine.ensure_fresh(SKILL_CACHE_TTL)
    return engine.validate(req.enabled_skills)


@router.get("/{name}", summary="获取技能详情（管理员）")
async def get_skill_detail(name: str, request: Request):
    """获取单个技能的详细信息，包含原始文档内容

    S1: 详情含技能 Prompt 原文（属平台内部资产），收敛为仅管理员可读。
    """
    user = get_current_user(request)
    require_admin(user)

    engine = _get_engine()
    engine.ensure_fresh(SKILL_CACHE_TTL)
    skill = engine.get(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"技能不存在: {name}")

    # 读取原始文件内容（file_path 只来自引擎扫描结果，不接受用户输入）
    raw_content = ""
    try:
        fpath = Path(skill.file_path)
        if fpath.exists():
            raw_content = fpath.read_text(encoding="utf-8")
    except Exception as e:
        logger.warning(f"读取技能文件失败: {e}")

    config = _load_global_config()
    enabled = config.get("enabled_skills", [])

    detail = _skill_dict(engine, skill, admin=True)
    detail["enabled"] = skill.name in enabled
    detail["raw_content"] = raw_content

    return detail


@router.put("/{name}", summary="更新技能文档内容")
async def update_skill_content(name: str, req: SkillUpdate, request: Request):
    """更新单个技能文档的原始内容（管理员）

    S4: 写入前校验长度与 YAML 前件；写入后重新加载，若解析失败或技能"消失"
    （改了 name 字段导致 key 变化）则自动回滚原内容，避免把技能库改坏。
    """
    user = get_current_user(request)
    require_admin(user)

    content = req.raw_content or ""
    if not content.strip():
        raise HTTPException(status_code=400, detail="技能内容不能为空")
    if len(content) > MAX_SKILL_CONTENT:
        raise HTTPException(
            status_code=400,
            detail=f"技能内容过长（{len(content)} 字符，上限 {MAX_SKILL_CONTENT} 字符）",
        )

    from backend.skill_engine import _parse_yaml_frontmatter
    _yaml, _body, yaml_error = _parse_yaml_frontmatter(content)
    if yaml_error:
        raise HTTPException(status_code=400, detail=f"YAML 前件校验未通过: {yaml_error}")
    if not str(_yaml.get("name") or "").strip():
        raise HTTPException(status_code=400, detail="YAML 前件缺少 name 字段，保存后技能将无法被引用")

    engine = _get_engine()
    engine.ensure_fresh(SKILL_CACHE_TTL)
    skill = engine.get(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"技能不存在: {name}")

    fpath = Path(skill.file_path)
    try:
        original = fpath.read_text(encoding="utf-8") if fpath.exists() else None
    except Exception as e:
        logger.error(f"读取技能原文件失败: {e}")
        raise HTTPException(status_code=500, detail=f"读取原文件失败: {str(e)}")

    try:
        fpath.write_text(content, encoding="utf-8")
    except Exception as e:
        logger.error(f"写入技能文件失败: {e}")
        raise HTTPException(status_code=500, detail=f"写入文件失败: {str(e)}")

    # 重新加载并校验；失败则回滚
    engine.clear_cache()
    engine.load_all()
    updated = engine.get(name)
    problem = None
    if updated is None:
        problem = "保存后技能无法按原名称加载（请检查 YAML 中的 name 字段是否被改动）"
    elif updated.parse_error:
        problem = f"保存后解析失败: {updated.parse_error}"

    if problem:
        rolled_back = False
        try:
            if original is not None:
                fpath.write_text(original, encoding="utf-8")
                engine.clear_cache()
                engine.load_all()
                rolled_back = True
        except Exception as e:
            logger.error(f"技能 {name} 回滚失败: {e}")
        logger.warning(f"技能 {name} 更新被拒绝: {problem}（{'已' if rolled_back else '未能'}回滚）")
        raise HTTPException(
            status_code=400,
            detail=("内容校验未通过，已恢复原文件。" if rolled_back else "内容校验未通过，且回滚失败，请人工检查。") + problem,
        )

    logger.info(f"技能 {name} 已更新（管理员 {user['username']}）")
    return {
        "message": f"技能「{updated.display_name}」已更新",
        "parse_error": None,
    }
