"""通知类型的单一来源。

配置里存的是类型字符串列表（enabled_notification_types），而"页面能勾哪些类型"
必须与"代码真的会发哪些类型"一致 —— 两边各写一份就会漂：此前 reward_router 发的
"success" 不在页面勾选项里，白名单判为未启用，认可通知被静默丢弃。

因此：目录、默认值、勾选项都从这里来；页面通过 /api/config/meta 的
notification_types 拿目录，不再手抄。
"""
from pathlib import Path
from backend.logger import logger

# (type, 中文名, 当前代码里是否真有调用点)
# in_use=False 的保留在目录里只为了兼容历史通知流水（老通知仍要能显示分类），
# 页面会标注"暂无调用点"，避免管理员以为关了会丢东西。
CATALOG: tuple[tuple[str, str, bool], ...] = (
    ("exam", "考试通知", True),
    ("task", "作业通知", True),
    ("info", "消息通知", True),
    ("success", "认可与加分", True),
    ("score", "成绩通知", False),
    ("rollcall", "点名通知", False),
    ("share", "资源分享", False),
    ("system", "系统通知", True),
    ("care", "关怀提醒（安全类·不可关闭）", True),
)

# 迁移标记文件（放数据目录 question_media/.migration_markers/，git 已忽略、不再污染仓库根）。存在即表示这条路已经走过一次。
MIGRATION_MARKER = ".notif_types_migrated"


def marker_path(name: str) -> Path:
    """迁移标记的统一落位（title_system 等模块也 import 此函数）。"""
    from backend.config import MEDIA_ROOT
    d = MEDIA_ROOT / ".migration_markers"
    d.mkdir(parents=True, exist_ok=True)
    return d / name


def catalog() -> list[dict]:
    """供 /api/config/meta 下发：前端按它渲染勾选项。"""
    return [{"value": t, "label": name, "in_use": in_use} for t, name, in_use in CATALOG]


def all_types() -> list[str]:
    return [t for t, _, _ in CATALOG]


def migrate_enabled_types() -> bool:
    """把 success 补进存量部署的启用列表。返回是否真的改了配置。

    只用一次，靠 system_config.json 旁边的标记文件去重：
    - success 以前根本不在勾选项里，所以不存在"管理员故意关掉它"的历史，
      凡是列表里没有它的部署，都可以安全补上；
    - 补完之后管理员若再手动取消，标记文件已存在，不会再被强行打开（尊重意图）。
    """
    from backend.api.config_router import CONFIG_FILE, load_config, save_config

    if not CONFIG_FILE.exists():
        # 还没有配置文件 = 全新部署，DEFAULT_CONFIG 已含 success，无需迁移
        return False
    marker = marker_path(MIGRATION_MARKER)
    if marker.exists():
        return False

    cfg = load_config()
    current = cfg.get("enabled_notification_types")
    changed = False
    if isinstance(current, list) and "success" not in current:
        cfg["enabled_notification_types"] = list(current) + ["success"]
        save_config(cfg)
        changed = True
        logger.info("[通知] 存量配置的通知类型已补齐 success（仅此一次，之后按管理员的勾选为准）")

    try:
        marker.write_text("notification types migrated: success\n", encoding="utf-8")
    except OSError as e:
        # 标记写不下来不影响本次生效，最多下次启动再补一遍（幂等）
        logger.warning(f"[通知] 迁移标记写入失败: {e}")
    return changed


def ensure_care_enabled() -> bool:
    """把 care（关怀提醒）补进存量部署的启用列表——安全类通知不能被类型白名单静默吞掉。

    与 migrate_enabled_types 同款 marker：只在首次走过一次；管理员之后手动取消则尊重意图。
    """
    from backend.api.config_router import CONFIG_FILE, load_config, save_config

    if not CONFIG_FILE.exists():
        return False
    marker = marker_path(".notif_care_migrated")
    if marker.exists():
        return False
    cfg = load_config()
    current = cfg.get("enabled_notification_types")
    if isinstance(current, list) and "care" not in current:
        cfg["enabled_notification_types"] = list(current) + ["care"]
        save_config(cfg)
        logger.info("[notif] 关怀提醒(care)已补入启用类型；如手动关闭过请重新勾选")
    marker.write_text("done", encoding="utf-8")
    return True