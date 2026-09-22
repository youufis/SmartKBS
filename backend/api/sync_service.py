"""
配置同步服务接口
"""
import json
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query, Request

from backend.api.dependencies import get_current_user
from backend.auth import is_admin
from backend.database import execute_insert_update, execute_query

router = APIRouter()

_geo_cache: dict[str, dict[str, Any]] = {}
_GEO_CACHE_TTL = 86400
_MAX_GEO_CACHE = 2000          # 防止匿名上报把地理缓存撑爆
_MAX_SYNC_LOGS = 5000          # 采集记录保留上限(超出丢弃最旧的)
_ONLINE_WINDOW_HOURS = 25      # 在线窗口: 心跳周期 24h + 1h 余量, 超过视为离线

# 部署机识别键: 主机名 + 来源 IP（receive_sync_report 入库前已剥掉端口）。
# 不能用 node_id —— backend/.node_id 被提交进了仓库, 所有克隆/打包出去的部署都继承了
# 同一个 id（历史上是 073b73e486174c2f）, 按 node_id 聚合会把几十台不同机器并成一行,
# 面板上于是只剩“最后一次上报的那台”。
# 按「主机名#IP」聚合才是需要的口径: 每台部署、每个出口 IP 各一行、各自判在线;
# 同一台机器换了出口 IP 会另起一行, 旧 IP 那一行随最后一次心跳超时自然转为离线。
_IDENTITY_SQL = ("COALESCE(NULLIF(hostname, ''), node_id) || '#' || "
                 "COALESCE(NULLIF(caller_ip, ''), 'no-ip')")


def _require_admin(request: Request) -> str:
    """节点信息含主机名/公网 IP/地域等, 只允许管理员查看或清理"""
    user = get_current_user(request)
    username = user.get("username", "")
    if not is_admin(username):
        raise HTTPException(status_code=403, detail="仅管理员可查看或清理节点同步信息")
    return username


def _clamp(v: Any, limit: int) -> str:
    return str(v if v is not None else "")[:limit]


def _is_public_ip(ip: str) -> bool:
    """只对形如 IPv4/IPv6 的地址做地理解析, 避免被伪造的 X-Forwarded-For 牵着打外部接口"""
    import ipaddress
    try:
        addr = ipaddress.ip_address(ip)
        return addr.is_global
    except Exception:
        return False


async def _resolve_geo(ip: str) -> dict[str, Any]:
    """解析 IP 地理位置"""
    if not ip or ip in ("127.0.0.1", "::1", "localhost", "unknown", ""):
        return {"country": "未知", "city": "未知", "isp": ""}

    now = time.time()
    cached = _geo_cache.get(ip)
    if cached and now - cached.get("_ts", 0) < _GEO_CACHE_TTL:
        return cached

    rows = execute_query(
        "SELECT geo_data FROM geo_cache WHERE ip=? AND expires_at > datetime('now')",
        (ip,),
    )
    if rows:
        try:
            data = json.loads(rows[0][0])
            data["_ts"] = now
            _geo_cache[ip] = data
            return data
        except Exception:
            pass

    result = {"country": "未知", "city": "未知", "isp": ""}
    try:
        async with httpx.AsyncClient(timeout=4) as c:
            resp = await c.get(
                f"http://ip-api.com/json/{ip}?lang=zh-CN&fields=status,country,regionName,city,isp,lat,lon,query"
            )
            if resp.status_code == 200 and resp.json().get("status") == "success":
                d = resp.json()
                result = {
                    "country": d.get("country", ""),
                    "region": d.get("regionName", ""),
                    "city": d.get("city", ""),
                    "isp": d.get("isp", ""),
                    "lat": d.get("lat"),
                    "lon": d.get("lon"),
                    "_ts": now,
                }
                execute_insert_update(
                    "INSERT OR REPLACE INTO geo_cache (ip, geo_data, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
                    (ip, json.dumps(result)),
                )
                if len(_geo_cache) >= _MAX_GEO_CACHE:
                    for k in list(_geo_cache)[:_MAX_GEO_CACHE // 2]:
                        _geo_cache.pop(k, None)
                _geo_cache[ip] = result
    except Exception:
        pass
    return result


@router.post("/config-sync/report")
async def receive_sync_report(request: Request):
    """接收节点同步报告"""
    try:
        body = await request.json()
    except Exception:
        body = {}

    action = body.get("action", "sync")
    node_id = body.get("node_id", "")
    hostname = body.get("hostname", "")
    public_ip = body.get("public_ip", "")

    caller_ip = request.headers.get("x-forwarded-for", "")
    if caller_ip:
        caller_ip = caller_ip.split(",")[0].strip()
    else:
        caller_ip = request.client.host if request.client else "unknown"
    # 去除可能附加的端口号
    if caller_ip and caller_ip.count(':') == 1 and caller_ip.rsplit(':', 1)[1].isdigit():
        caller_ip = caller_ip.rsplit(':', 1)[0]

    geo = await _resolve_geo(caller_ip) if _is_public_ip(caller_ip) else {"country": "未知", "city": "未知", "isp": ""}

    try:
        execute_insert_update(
            """INSERT INTO config_sync_logs
               (node_id, hostname, caller_ip, public_ip,
                country, region, city, isp,
                app_version, platform_info, python_version, raw_body)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                _clamp(node_id, 64), _clamp(hostname, 128), _clamp(caller_ip, 64), _clamp(public_ip, 64),
                _clamp(geo.get("country", ""), 32), _clamp(geo.get("region", ""), 32),
                _clamp(geo.get("city", ""), 32), _clamp(geo.get("isp", ""), 64),
                _clamp(body.get("app_version", ""), 32),
                _clamp(body.get("platform", ""), 128),
                _clamp(body.get("python_version", ""), 32),
                json.dumps(body, ensure_ascii=False)[:500],
            ),
        )
        # 采集表不设上限会被匿名上报无限撑大, 这里保留最近 _MAX_SYNC_LOGS 条
        cnt = execute_query("SELECT COUNT(*) FROM config_sync_logs")
        if cnt and cnt[0][0] > _MAX_SYNC_LOGS:
            execute_insert_update(
                """DELETE FROM config_sync_logs WHERE id NOT IN (
                   SELECT id FROM config_sync_logs ORDER BY id DESC LIMIT ?)""",
                (_MAX_SYNC_LOGS,),
            )
    except Exception:
        pass

    return {"status": "ok", "config": {}, "timestamp": time.time()}


@router.get("/config-sync/nodes")
async def get_sync_nodes(request: Request, page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=200)):
    """按「部署机 + 出口 IP」汇总同步记录, 并给出各自的在线/离线状态 —— 仅管理员

    在线判定只看一件事: 该身份最后一次上报距现在是否落在 _ONLINE_WINDOW_HOURS 小时内。
    部署端心跳是 24 小时一轮(backend/config_sync.py 的 _SYNC_INTERVAL), 窗口取 24h + 1h 余量,
    避免“下一轮心跳还没到, 状态就先跳到离线”的边界闪烁。
    一律用服务端收到的 last_sync 计时, 不用客户端上报的 timestamp(部署机时钟常不准)。
    """
    _require_admin(request)
    page = max(1, page)
    offset = (page - 1) * page_size
    rows = execute_query(f"SELECT COUNT(DISTINCT {_IDENTITY_SQL}) FROM config_sync_logs")
    total = rows[0][0] if rows else 0
    # 每条心跳在表里是一行新记录, 所以取同一身份下 id 最大的一行 = 最后一次心跳;
    # COUNT(*) 还原真实心跳次数, MIN(first_sync) 作为首次上报时间, IP/地域取最后一次快照。
    rows = execute_query(
        "SELECT s.id, s.node_id, s.hostname, s.caller_ip, s.public_ip,"
        "       s.country, s.region, s.city, s.isp,"
        "       s.app_version, s.platform_info,"
        "       a.first_sync, s.last_sync, a.sync_count,"
        "       CASE WHEN s.last_sync >= datetime('now', ?, 'localtime') THEN 1 ELSE 0 END AS online,"
        "       CAST((julianday('now', 'localtime') - julianday(s.last_sync)) * 1440 AS INTEGER) AS minutes_ago"
        " FROM ("
        f"    SELECT {_IDENTITY_SQL} AS ident, MAX(id) AS max_id,"
        "           MIN(first_sync) AS first_sync, COUNT(*) AS sync_count"
        "    FROM config_sync_logs"
        "    GROUP BY ident"
        " ) a"
        " JOIN config_sync_logs s ON s.id = a.max_id"
        " ORDER BY online DESC, s.last_sync DESC"
        " LIMIT ? OFFSET ?",
        (f"-{_ONLINE_WINDOW_HOURS} hour", page_size, offset),
    )
    result = []
    for r in rows:
        result.append({
            "id": r[0],
            "node_id": r[1],
            "hostname": r[2],
            "caller_ip": r[3],
            "public_ip": r[4],
            "country": r[5],
            "region": r[6],
            "city": r[7],
            "isp": r[8],
            "app_version": r[9],
            "platform": r[10],
            "first_sync": r[11],
            "last_sync": r[12],
            "sync_count": r[13],
            "online": bool(r[14]),
            "minutes_ago": r[15],
        })
    return {"nodes": result, "total": total, "page": page, "page_size": page_size}


@router.delete("/config-sync/record/{record_id}")
async def delete_sync_record(record_id: int, request: Request):
    """删除指定单条记录 —— 仅管理员"""
    _require_admin(request)
    execute_insert_update("DELETE FROM config_sync_logs WHERE id=?", (record_id,))
    return {"status": "ok", "id": record_id}


@router.delete("/config-sync/clear")
async def clear_sync_logs(request: Request):
    """清空所有同步记录 —— 仅管理员"""
    _require_admin(request)
    execute_insert_update("DELETE FROM config_sync_logs")
    return {"status": "ok"}


@router.post("/config-sync/deduplicate")
async def deduplicate_sync_logs(request: Request):
    """节点去重：每个「主机名+IP」只保留最后一次上报记录 —— 仅管理员

    旧版按 caller_ip 分组，走花生壳/NAT 穿透时同一出口下不同机器会被并成一条（等于丢数据）；
    现在与面板同一口径，只收敛完全相同的「主机名#IP」身份的重复心跳。
    """
    _require_admin(request)
    execute_insert_update(
        "DELETE FROM config_sync_logs WHERE id NOT IN ("
        f"    SELECT MAX(id) FROM config_sync_logs GROUP BY {_IDENTITY_SQL}"
        ")",
    )
    rows = execute_query("SELECT COUNT(*) FROM config_sync_logs")
    remaining = rows[0][0] if rows else 0
    return {"status": "ok", "remaining": remaining}


@router.get("/config-sync/export")
async def export_sync_logs(request: Request):
    """导出汇总后的部署记录（与面板同一口径，每台部署每个 IP 一行）—— 仅管理员"""
    _require_admin(request)
    rows = execute_query(
        "SELECT s.id, s.node_id, s.hostname, s.caller_ip, s.public_ip,"
        "       s.country, s.region, s.city, s.isp,"
        "       s.app_version, s.platform_info, a.first_sync, s.last_sync, a.sync_count,"
        "       CASE WHEN s.last_sync >= datetime('now', ?, 'localtime') THEN 1 ELSE 0 END"
        " FROM ("
        f"    SELECT {_IDENTITY_SQL} AS ident, MAX(id) AS max_id,"
        "           MIN(first_sync) AS first_sync, COUNT(*) AS sync_count"
        "    FROM config_sync_logs"
        "    GROUP BY ident"
        " ) a"
        " JOIN config_sync_logs s ON s.id = a.max_id"
        " ORDER BY s.last_sync DESC",
        (f"-{_ONLINE_WINDOW_HOURS} hour",),
    )
    result = []
    for r in rows:
        result.append({
            "id": r[0],
            "node_id": r[1],
            "hostname": r[2],
            "caller_ip": r[3],
            "public_ip": r[4],
            "country": r[5],
            "region": r[6],
            "city": r[7],
            "isp": r[8],
            "app_version": r[9],
            "platform": r[10],
            "first_sync": r[11],
            "last_sync": r[12],
            "sync_count": r[13],
            "online": bool(r[14]),
            "time": r[12],
        })
    return {"nodes": result, "total": len(result)}


@router.get("/config-sync/summary")
async def get_sync_summary(request: Request):
    """同步统计汇总（按「主机名+IP」身份去重计数）—— 仅管理员"""
    _require_admin(request)
    rows = execute_query(f"SELECT COUNT(DISTINCT {_IDENTITY_SQL}) FROM config_sync_logs")
    total = rows[0][0] if rows else 0
    today_active = execute_query(
        f"SELECT COUNT(DISTINCT {_IDENTITY_SQL}) FROM config_sync_logs "
        "WHERE last_sync >= datetime('now', '-1 day', 'localtime')"
    )[0][0]
    week_active = execute_query(
        f"SELECT COUNT(DISTINCT {_IDENTITY_SQL}) FROM config_sync_logs "
        "WHERE last_sync >= datetime('now', '-7 day', 'localtime')"
    )[0][0]
    countries = execute_query(
        f"SELECT country, COUNT(DISTINCT {_IDENTITY_SQL}) as cnt "
        "FROM config_sync_logs GROUP BY country ORDER BY cnt DESC"
    )
    online_nodes = execute_query(
        f"SELECT COUNT(DISTINCT {_IDENTITY_SQL}) FROM config_sync_logs "
        "WHERE last_sync >= datetime('now', ?, 'localtime')",
        (f"-{_ONLINE_WINDOW_HOURS} hour",),
    )[0][0]
    return {
        "total_nodes": total,
        "online_nodes": online_nodes,
        "today_active": today_active,
        "weekly_active": week_active,
        "country_distribution": [
            {"country": c[0], "count": c[1]} for c in countries
        ],
    }
