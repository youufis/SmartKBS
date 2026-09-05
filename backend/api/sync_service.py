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
    """返回所有同步记录（分页）—— 仅管理员"""
    _require_admin(request)
    page = max(1, page)
    offset = (page - 1) * page_size
    rows = execute_query("SELECT COUNT(*) FROM config_sync_logs")
    total = rows[0][0] if rows else 0
    rows = execute_query("""
        SELECT id, node_id, hostname, caller_ip, public_ip,
               country, region, city, isp,
               app_version, platform_info, first_sync, last_sync, sync_count
        FROM config_sync_logs
        ORDER BY first_sync DESC
        LIMIT ? OFFSET ?
    """, (page_size, offset))
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
    """IP 去重：相同 IP（不含端口）只保留最新一条记录 —— 仅管理员"""
    _require_admin(request)
    execute_insert_update(
        """DELETE FROM config_sync_logs WHERE id NOT IN (
            SELECT MAX(id) FROM config_sync_logs
            GROUP BY CASE WHEN INSTR(caller_ip, ':') > 0
                     THEN SUBSTR(caller_ip, 1, INSTR(caller_ip, ':') - 1)
                     ELSE caller_ip END
        )"""
    )
    rows = execute_query("SELECT COUNT(*) FROM config_sync_logs")
    remaining = rows[0][0] if rows else 0
    return {"status": "ok", "remaining": remaining}


@router.get("/config-sync/export")
async def export_sync_logs(request: Request):
    """导出所有同步记录为 JSON —— 仅管理员"""
    _require_admin(request)
    rows = execute_query("""
        SELECT id, node_id, hostname, caller_ip, public_ip,
               country, region, city, isp,
               app_version, platform_info, first_sync
        FROM config_sync_logs
        ORDER BY first_sync DESC
    """)
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
            "time": r[11],
        })
    return {"nodes": result, "total": len(result)}


@router.get("/config-sync/summary")
async def get_sync_summary(request: Request):
    """同步统计汇总 —— 仅管理员"""
    _require_admin(request)
    rows = execute_query("SELECT COUNT(DISTINCT node_id) FROM config_sync_logs")
    total = rows[0][0] if rows else 0
    today_active = execute_query(
        "SELECT COUNT(DISTINCT node_id) FROM config_sync_logs "
        "WHERE last_sync >= datetime('now', '-1 day', 'localtime')"
    )[0][0]
    week_active = execute_query(
        "SELECT COUNT(DISTINCT node_id) FROM config_sync_logs "
        "WHERE last_sync >= datetime('now', '-7 day', 'localtime')"
    )[0][0]
    countries = execute_query(
        "SELECT country, COUNT(DISTINCT node_id) as cnt "
        "FROM config_sync_logs GROUP BY country ORDER BY cnt DESC"
    )
    return {
        "total_nodes": total,
        "today_active": today_active,
        "weekly_active": week_active,
        "country_distribution": [
            {"country": c[0], "count": c[1]} for c in countries
        ],
    }
