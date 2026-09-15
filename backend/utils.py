"""
工具函数集
从 AgentSmartKBXS.py 移植的共享工具函数
"""
import os
import time
import json
import hashlib
import re
from pathlib import Path
from typing import Optional, Any

from backend.config import (
    BASE_DIR,
    DATA_DIR,
    ROOT_DIR,
    STU_DIR,
    CHAT_HISTORY_DIR,
    DEFAULT_LOGGED_IN_NAME,
)
from backend.database import execute_query
from backend.logger import logger


# ── 目录路径解析 ──

def get_user_role_num(username: str) -> Optional[int]:
    rows = execute_query("SELECT role FROM users WHERE username=?", (username,))
    return rows[0][0] if rows else None


def _resolve_abs(path: str) -> str:
    """将相对路径解析为基于 DATA_DIR 的绝对路径"""
    if os.path.isabs(path):
        return path
    return str(DATA_DIR / path)


def get_user_base_dir(username: str) -> str:
    """获取用户工作根目录的绝对路径。学生(普通用户)在 stu/ 下，教师和管理员在根目录。"""
    if username == ROOT_DIR:
        return _resolve_abs(ROOT_DIR)
    role = get_user_role_num(username)
    if role == 2:  # 普通用户（学生）
        return _resolve_abs(os.path.join(STU_DIR, username))
    return _resolve_abs(username)


def get_account_chat_history_dir(logged_in_name: Optional[str]) -> str:
    """返回指定账号的 ChatHistory 目录的绝对路径"""
    name = logged_in_name if logged_in_name else DEFAULT_LOGGED_IN_NAME
    base = get_user_base_dir(name)
    return os.path.join(base, CHAT_HISTORY_DIR)


def get_admin_chat_history_dir() -> str:
    """返回管理员（root）下的 ChatHistory 目录的绝对路径"""
    return _resolve_abs(os.path.join(ROOT_DIR, CHAT_HISTORY_DIR))


def get_account_html_dir(logged_in_name: Optional[str]) -> str:
    """返回指定账号的 HTML 目录的绝对路径"""
    name = logged_in_name if logged_in_name else DEFAULT_LOGGED_IN_NAME
    base = get_user_base_dir(name)
    return os.path.join(base, "html")


# ── 路径安全：防止 ../ 逃逸与兄弟目录前缀误判 ──


def normalize_rel_path(rel: str) -> str:
    """把外部传入的相对路径规范成安全形态。

    规则：去掉盘符与前导 /，逐段拒绝 `..`（上级跳转）与隐藏文件（以 . 开头）。
    返回 "" 表示该路径不可安全使用，调用方应拒绝而不是"尽力清洗"。
    """
    import re as _re
    if not rel:
        return ""
    p = str(rel).replace("\\", "/")
    p = _re.sub(r"^[A-Za-z]:", "", p).lstrip("/")
    parts: list[str] = []
    for seg in p.split("/"):
        seg = seg.strip()
        if not seg or seg == ".":
            continue
        if seg == ".." or seg.startswith("."):
            return ""
        parts.append(seg)
    return "/".join(parts)


def path_within(base_dir: str, target: str) -> bool:
    """target 是否真的在 base_dir 内。

    用 realpath + 路径段比较，避免 `startswith` 把兄弟目录（如 html 与 html_bypass）
    误判为合法。
    """
    import os as _os
    try:
        b = _os.path.realpath(base_dir)
        t = _os.path.realpath(target)
    except (OSError, ValueError, TypeError):
        return False
    bs = _os.path.splitdrive(b)[1].replace("\\", "/").rstrip("/").casefold()
    ts = _os.path.splitdrive(t)[1].replace("\\", "/").rstrip("/").casefold()
    if not bs:
        return False
    return ts == bs or ts.startswith(bs + "/")


def safe_join(base_dir: str, *parts: str) -> str | None:
    """拼接子路径并校验落点仍在 base_dir 内；越界返回 None。"""
    import os as _os
    rel = normalize_rel_path("/".join(str(p) for p in parts if p))
    if not rel:
        return None
    candidate = _os.path.realpath(_os.path.join(base_dir, rel))
    return candidate if path_within(base_dir, candidate) else None


def like_escape(v: str) -> str:
    r"""转义 LIKE 模式中的 % 与 _ (以及转义符本身), 需配合 SQL 的 ESCAPE 反斜杠使用。

    未转义时 "100%.md" 这类文件名会当成通配符, 误伤其它行。
    """
    return str(v).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


# ── 文件类型检测 ──

def is_image_file(file_path: str) -> bool:
    from backend.api.config_router import get_config_value
    _, ext = os.path.splitext(file_path.lower())
    return ext in get_config_value("IMAGE_EXTENSIONS", ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'])


def is_document_file(file_path: str) -> bool:
    from backend.api.config_router import get_config_value
    _, ext = os.path.splitext(file_path.lower())
    return ext in get_config_value("DOCUMENT_EXTENSIONS", ['.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json', '.html', '.htm'])


def check_file_size(file_path: str, max_size_mb: int | None = None) -> bool:
    if not file_path or not os.path.exists(file_path):
        return True
    from backend.api.config_router import get_config_value
    if max_size_mb is None:
        max_size_mb = get_config_value("MAX_DOC_SIZE_MB", 10)
    file_size = os.path.getsize(file_path)
    return file_size <= max_size_mb * 1024 * 1024


def encode_image_to_base64(image_path: str) -> str:
    import base64
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def get_image_mime_type(file_path: str) -> str:
    """根据文件扩展名返回对应的图片 MIME 类型"""
    ext = os.path.splitext(file_path.lower())[1]
    mime_map = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.tiff': 'image/tiff', '.tif': 'image/tiff',
        '.webp': 'image/webp',
    }
    return mime_map.get(ext, 'image/jpeg')


def calculate_file_hash(file_path: str) -> str:
    """计算文件 MD5 哈希"""
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()


# ── 用户上下文 ──

def get_user_context_from_payload(user_payload: dict[str, Any] | None) -> dict[str, Any] | None:
    """从 JWT payload 提取用户上下文信息"""
    if not user_payload:
        return None
    username = user_payload.get("username", "")
    if not username or username == DEFAULT_LOGGED_IN_NAME:
        return None
    rows = execute_query(
        "SELECT class, name, gender FROM users WHERE username=?", (username,)
    )
    if not rows:
        return None
    class_val, name_val, gender_val = rows[0]
    return {"username": username, "class": class_val or "", "name": name_val or "", "gender": str(gender_val or "")}


def build_user_system_message(user_context: dict[str, Any] | None) -> str | None:
    """构建包含用户信息的系统消息"""
    if not user_context:
        return None
    msg = f"当前对话用户信息：\n"
    msg += f"- 用户名/学号：{user_context['username']}\n"
    if user_context.get("class"):
        msg += f"- 班级：{user_context['class']}\n"
    if user_context.get("name"):
        msg += f"- 姓名：{user_context['name']}\n"
    if user_context.get("gender"):
        msg += f"- 性别：{user_context['gender']}\n"
    msg += "\n请记住这些用户信息，在适当的时候使用，但不要每次回答都重复显示这些信息。"
    return msg


def enhance_prompt_with_user_context(prompt: str, user_payload: dict[str, Any] | None) -> str:
    """增强提示词，包含用户上下文"""
    if not prompt:
        return prompt
    user_context = get_user_context_from_payload(user_payload)
    if not user_context:
        return prompt
    system_message = build_user_system_message(user_context)
    if not system_message:
        return prompt
    return f"{system_message}\n\n用户问题：{prompt}"


# ── 教师 HTML 资源同步 ──

def ensure_teacher_html_files(username: str):
    """确保教师用户的 HTML 目录存在"""
    from backend.auth import is_teacher
    if not is_teacher(username):
        return
    html_dir = get_account_html_dir(username)
    os.makedirs(html_dir, exist_ok=True)


# ── 每日请求限流（基于数据库，与日志完全解耦） ──

def get_user_daily_usage(username: str) -> int:
    """查询用户当日已使用的请求次数"""
    from backend.database import get_connection
    today = time.strftime("%Y-%m-%d")
    with get_connection() as conn:
        c = conn.cursor()
        c.execute(
            "SELECT count FROM daily_usage WHERE username = ? AND date = ?",
            (username, today),
        )
        row = c.fetchone()
        return row[0] if row else 0


def get_limit_config() -> tuple[bool, int]:
    """运行时读取限流配置（每次调用时读取，修改即时生效）"""
    from backend.api.config_router import get_config_value
    enabled = get_config_value("ENABLE_REQUEST_LIMIT", False)
    limit = get_config_value("MAX_ALLOWED_REQUESTS", 50)
    return bool(enabled), int(limit)


def check_user_daily_requests(username: str, role: int) -> tuple[bool, int | float]:
    """检查用户当日请求是否超限（仅对学生和教师生效，管理员不受限）

    使用 daily_usage 表计数。
    配置从 system_config.json 运行时读取，修改即时生效。

    Returns:
        (allowed: bool, remaining: int | float)
    """
    # 管理员不受限
    if role == 0:
        return True, float("inf")

    enabled, max_allowed = get_limit_config()
    if not enabled:
        return True, float("inf")

    from backend.database import get_connection

    today = time.strftime("%Y-%m-%d")
    with get_connection() as conn:
        c = conn.cursor()
        # 确保今日有记录
        c.execute(
            "INSERT OR IGNORE INTO daily_usage (username, date, count) VALUES (?, ?, 0)",
            (username, today),
        )
        conn.commit()

        # 先查询当前计数
        c.execute(
            "SELECT count FROM daily_usage WHERE username = ? AND date = ?",
            (username, today),
        )
        row = c.fetchone()
        current_count = row[0] if row else 0

        # 判断是否允许（等于 limit 时已用完，第 limit+1 次拒绝）
        allowed = current_count < max_allowed
        remaining = max(0, max_allowed - current_count)

        # 允许时才递增
        if allowed:
            c.execute(
                "UPDATE daily_usage SET count = count + 1 WHERE username = ? AND date = ?",
                (username, today),
            )
            conn.commit()

    return allowed, remaining


# ── AI 返回 JSON 解析（多策略鲁棒解析）──

def _fix_json_escapes(s: str) -> str:
    """把 JSON 字符串里的非法转义（常见于 LaTeX: \partial, \Delta, \alpha...）
    修复为合法的双反斜杠。仅处理不在合法转义集里的反斜杠。"""
    return re.sub(r"\\(?![\"\/bfnrutu])", r"\\\\", s)


def _strip_ctrl_chars(s: str) -> str:
    """去掉字符串里的裸控制字符（\x00-\x1f 中除 \t \n \r 之外），
    模型偶尔在 JSON 字符串值里输出裸换行/制表符导致解析失败"""
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", s)


def _close_truncated_json_array(s: str) -> str:
    """截断的 JSON 数组修复：扫描到最后一个完整的顶层数组元素，
    截到那里并补 ']'（模型输出被 max_tokens 腰斩时挽救已生成部分）"""
    depth = 0
    in_str = False
    esc = False
    last_complete = -1
    for i, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
            if depth == 1 and ch == "}":
                last_complete = i + 1
        if depth <= 0 and s[0] != "[":
            break
    if last_complete > 0:
        return s[:last_complete].rstrip().rstrip(",") + "]"
    return s


def _auto_close_json(s: str) -> str:
    """对截断的 JSON 做结构补全: 关闭未结束的字符串, 删掉悬空的
    "key": / 尾逗号, 按括号栈补全 }/]。用于挽救 max_tokens 腰斩的输出。"""
    stack: list[str] = []
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
    t = s
    if in_str:
        t += '"'
    t = t.rstrip()
    # 去掉悬空的 "key": 或结尾逗号
    t = re.sub(r'"[^"]*"\s*:\s*$', "", t).rstrip()
    t = re.sub(r"[,:]\s*$", "", t).rstrip()
    closers = "".join("}" if c == "{" else "]" for c in reversed(stack))
    return t + closers


def _loads_json_repair(candidate: str):
    """json.loads 一组递进式修复；全部失败返回 None"""
    if not candidate:
        return None
    variants = []
    base = candidate.strip()
    variants.append(base)
    variants.append(_strip_ctrl_chars(base))
    variants.append(_fix_json_escapes(base))
    variants.append(_fix_json_escapes(_strip_ctrl_chars(base)))
    # 裸换行常被模型塞进字符串值里 → 换成空格再试
    variants.append(base.replace("\n", " ").replace("\r", " "))
    if base[:1] in ("[", "{"):
        t = _close_truncated_json_array(base) if base.startswith("[") else base
        variants.append(t)
        variants.append(_fix_json_escapes(_strip_ctrl_chars(t)))
        # 通用结构补全(对象/数组/字符串/键值对任意位置截断)
        ac = _auto_close_json(_fix_json_escapes(_strip_ctrl_chars(base)))
        variants.append(ac)
        variants.append(_fix_json_escapes(base))
    for v in variants:
        if not v:
            continue
        try:
            return json.loads(v)
        except json.JSONDecodeError:
            try:
                return json.loads(re.sub(r",\s*([}\]])", r"\1", v))
            except json.JSONDecodeError:
                continue
    return None


def extract_json_from_text(text: str) -> dict | list | None:
    """从 AI 返回文本中鲁棒地提取 JSON 对象或数组

    支持：
    - 直接解析（标准 JSON）
    - ```json ``` / ``` ``` 代码块内提取
    - 最外层 {…} 或 […] 截取
    - 自动修复尾部逗号

    Args:
        text: AI 返回的原始文本

    Returns:
        解析成功的 Python 对象（dict 或 list），失败返回 None
    """
    if not text or not text.strip():
        return None

    text = text.strip()

    # ── 策略1: 直接解析（含非法转义/控制字符/截断数组的递进修复）──
    parsed = _loads_json_repair(text)
    if parsed is not None:
        return parsed

    # ── 策略2: 从 ```json ``` / ``` ``` 代码块提取（逐块尝试修复解析）──
    blocks = re.findall(r'```(?:json|JSON)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if not blocks:
        # 未闭合的代码围栏（输出被截断时开头有 ```json 但没有结尾）
        m_open = re.search(r'```(?:json|JSON)?\s*\n?([\s\S]*)$', text)
        if m_open:
            blocks = [m_open.group(1)]
    for block in blocks:
        parsed = _loads_json_repair(block)
        if parsed is not None:
            return parsed

    # ── 策略2.5: 无围栏时, 从第一个 [ 到文本末尾抢救被截断的数组 ──
    arr_head = text.find("[")
    if arr_head != -1 and (text.find("{") == -1 or arr_head < text.find("{")):
        parsed = _loads_json_repair(text[arr_head:])
        if parsed is not None:
            return parsed

    # ── 策略3: 从最外层 JSON 对象或数组截取 ──
    # 先尝试找 {…} 对象
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        json_str = text[start:end + 1]
        # 清理残留的 markdown 标记
        json_str = json_str.replace("```json", "").replace("```", "").strip()
        parsed = _loads_json_repair(json_str)
        if parsed is not None:
            return parsed

    # 再尝试找 […] 数组
    start = text.find('[')
    end = text.rfind(']')
    if start != -1 and end != -1 and end > start:
        json_str = text[start:end + 1]
        json_str = json_str.replace("```json", "").replace("```", "").strip()
        parsed = _loads_json_repair(json_str)
        if parsed is not None:
            return parsed

    return None
