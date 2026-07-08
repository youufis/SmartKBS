"""
技能管理 API 路由

提供对技能文档系统的管理接口：
- GET  /api/skills          — 列出全部可用技能
- GET  /api/skills/{name}   — 获取技能详情
- POST /api/skills/reload   — 重新加载技能
- GET  /api/skills/enabled  — 获取已启用的技能名称列表
- PUT  /api/skills/enabled  — 更新已启用的技能列表
- GET  /api/skills/validate — 验证技能组合是否合法

技能启用状态存储在 system_config.json 的 enabled_skills 字段中。
"""
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user, require_admin
from backend.logger import logger

router = APIRouter()


class EnabledSkillsUpdate(BaseModel):
    """更新已启用技能列表的请求体"""
    enabled_skills: list[str]


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


# ── API 端点 ──


@router.get("", summary="列出全部可用技能")
async def list_skills(request: Request):
    """获取所有已安装的技能文档列表（不验证管理员身份）"""
    engine = _get_engine()
    engine.load_all()
    skills = engine.list_skills()

    # 获取启用状态
    config = _load_global_config()
    enabled = config.get("enabled_skills", [])

    result = []
    for skill in skills:
        info = engine.to_dict(skill)
        info["enabled"] = skill.name in enabled
        result.append(info)

    return {
        "skills": result,
        "total": len(result),
        "errors": engine.get_load_errors(),
    }


@router.get("/{name}", summary="获取技能详情")
async def get_skill_detail(name: str, request: Request):
    """获取单个技能的详细信息，包含原始文档内容"""
    engine = _get_engine()
    engine.load_all()
    skill = engine.get(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"技能不存在: {name}")

    # 读取原始文件内容
    raw_content = ""
    try:
        from pathlib import Path
        fpath = Path(skill.file_path)
        if fpath.exists():
            raw_content = fpath.read_text(encoding="utf-8")
    except Exception as e:
        logger.warning(f"读取技能文件失败: {skill.file_path} - {e}")

    # 获取启用状态
    config = _load_global_config()
    enabled = config.get("enabled_skills", [])

    detail = engine.to_dict(skill)
    detail["enabled"] = skill.name in enabled
    detail["raw_content"] = raw_content

    return detail


@router.post("/reload", summary="重新加载技能")
async def reload_skills(request: Request):
    """重新扫描技能目录并加载所有技能文档"""
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


@router.get("/enabled", summary="获取已启用的技能列表")
async def get_enabled_skills(request: Request):
    """获取当前已启用的技能名称列表（公开接口，无需管理员身份）"""
    config = _load_global_config()
    enabled = config.get("enabled_skills", [])

    engine = _get_engine()
    engine.load_all()
    skills = engine.list_enabled(enabled)

    return {
        "enabled_skills": enabled,
        "skill_details": [engine.to_dict(s) for s in skills],
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
    engine.load_all()
    not_found = []
    for name in req.enabled_skills:
        if not engine.get(name):
            not_found.append(name)

    if not_found:
        raise HTTPException(
            status_code=400,
            detail=f"以下技能不存在: {', '.join(not_found)}",
        )

    # 保存到 system_config.json
    config = _load_global_config()
    config["enabled_skills"] = req.enabled_skills
    _save_global_config(config)

    logger.info(f"已启用技能列表更新: {req.enabled_skills}")
    return {
        "enabled_skills": req.enabled_skills,
        "message": f"已启用 {len(req.enabled_skills)} 个技能",
    }


@router.post("/validate", summary="验证技能组合")
async def validate_skills(req: EnabledSkillsUpdate, request: Request):
    """验证给定的技能组合是否合法（依赖检查、冲突检查）"""
    engine = _get_engine()
    engine.load_all()
    result = engine.validate(req.enabled_skills)
    return result
