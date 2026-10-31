# -*- coding: utf-8 -*-
"""文件提交类作业：落盘、校验、取文、组包、查重

设计口径（见 docs/file-homework/00-方案建议.md）：
- 不新建活动类型，文件只是 tasks.submit_mode 的一种提交形态，所以本模块只服务 tasks；
- 服务端只读字节、绝不打开 Office：不装 LibreOffice、不跑宏、不解析 OLE；
- 取文失败/扫描件/未开多模态一律标 needs_review 转人工，绝不猜分（与 grading_rules 同一原则）；
- 抽取结果落库缓存，重批改不重抽取 —— 这是扛住「全班 40 人 × 3 文件」的成本关键。
"""
from __future__ import annotations

import hashlib
import os
import re
import zipfile
from pathlib import Path
from typing import Any, Optional

from backend.config import DATA_DIR, STU_DIR
from backend.utils import get_user_base_dir, path_within
from backend.api.config_router import get_config_value
from backend.logger import logger

# ── 默认口径（管理员可用系统配置覆盖）──
DEFAULT_MAX_FILES = 3
DEFAULT_MAX_FILE_MB = 10
DEFAULT_ALLOWED_EXTS = [
    ".docx", ".pdf", ".txt", ".md",          # 报告/作文主力
    ".xlsx", ".pptx",                         # 表格/演示
    ".jpg", ".jpeg", ".png", ".webp", ".bmp",  # 拍照/截图/作品照
]
TEXT_EXTS = {".txt", ".md", ".csv", ".json", ".html", ".htm"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tiff", ".tif", ".webp"}
OFFICE_EXTS = {".docx", ".xlsx", ".pptx"}
# 旧二进制 Office 格式：服务端无法安全解析，也极可能是宏载体 → 默认不收
LEGACY_OFFICE_EXTS = {".doc", ".ppt", ".xls"}

PER_FILE_CHARS = 8000          # 单个文件入库正文上限
PKG_STUDENT_CHARS = 1500       # 批改包里每位学生的正文预算
SCANNED_PDF_MIN_CHARS = 80     # PDF 抽取不足这个字数 → 判定为扫描件


def _cfg_int(key: str, fallback: int) -> int:
    try:
        raw = get_config_value(key, fallback)
        return int(raw) if raw not in (None, "") else fallback
    except Exception:
        return fallback


def default_allowed_exts() -> list[str]:
    raw = get_config_value("HOMEWORK_ALLOWED_EXTS", DEFAULT_ALLOWED_EXTS)
    if isinstance(raw, str):
        raw = [x for x in re.split(r"[,;、\s]+", raw) if x]
    out = []
    for one in (raw or DEFAULT_ALLOWED_EXTS):
        ext = str(one or "").strip().lower()
        if ext and not ext.startswith("."):
            ext = "." + ext
        if ext:
            out.append(ext)
    return out or list(DEFAULT_ALLOWED_EXTS)


def task_allowed_exts(task: dict) -> list[str]:
    """任务级白名单覆盖系统默认（留空=用系统默认）"""
    raw = str(task.get("allowed_exts") or "").strip()
    if not raw:
        return default_allowed_exts()
    out = []
    for one in re.split(r"[,;、\s]+", raw):
        ext = one.strip().lower()
        if ext and not ext.startswith("."):
            ext = "." + ext
        if ext:
            out.append(ext)
    return out or default_allowed_exts()


def task_max_files(task: dict) -> int:
    try:
        n = int(task.get("max_files") or 0)
    except (TypeError, ValueError):
        n = 0
    return n if n > 0 else _cfg_int("HOMEWORK_MAX_FILES", DEFAULT_MAX_FILES)


def task_max_file_mb(task: dict) -> int:
    try:
        n = int(task.get("max_file_mb") or 0)
    except (TypeError, ValueError):
        n = 0
    return n if n > 0 else _cfg_int("HOMEWORK_MAX_FILE_MB", DEFAULT_MAX_FILE_MB)


def file_kind(ext: str) -> str:
    e = (ext or "").lower()
    if e in IMAGE_EXTS:
        return "image"
    if e in {".docx", ".pdf"} or e in TEXT_EXTS:
        return "doc"
    if e == ".xlsx":
        return "sheet"
    if e == ".pptx":
        return "slides"
    return "other"


def vl_enabled() -> bool:
    """图片作业的 VL 预解读开关。

    与聊天用的 ENABLE_MULTIMODAL 分开的理由：教师布置图片作业不该被一个聊天开关
    连带影响；两处默认都为开，任一开着就能跑图。
    """
    try:
        return bool(get_config_value("HOMEWORK_ENABLE_VL", True)) or bool(
            get_config_value("ENABLE_MULTIMODAL", False))
    except Exception:
        return False


# ════════════════════════════════════════════════════════════
# 落盘与校验
# ════════════════════════════════════════════════════════════

def safe_display_name(filename: str) -> str:
    """学生原始文件名 → 可展示、可入路径的名字（保留中文，去非法字符）"""
    base = os.path.basename(str(filename or "").replace("\\", "/"))
    base = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", base).strip(" ._")
    if len(base) > 60:
        stem, ext = os.path.splitext(base)
        base = stem[:60 - len(ext)] + ext
    return base or "file"


def task_digest(task_id: str) -> str:
    return hashlib.md5(str(task_id or "").encode("utf-8")).hexdigest()[:10]


def student_homework_dir(student: str, task_id: str) -> Path:
    """作业落盘目录：学生自己的 stu/<学号>/homework/<任务指纹>/

    走 get_user_base_dir 而不是硬拼 DATA_DIR，桌面版（DATA_DIR 指向 userData）才落对地方。
    """
    base = Path(get_user_base_dir(student))
    target = base / "homework" / task_digest(task_id)
    real_root = os.path.realpath(str(base))
    real_target = os.path.realpath(str(target))
    if not path_within(real_root, real_target):
        raise ValueError(f"作业目录越界: {task_id}")
    return target


def save_upload(student: str, task_id: str, seq: int, content: bytes,
                display_name: str) -> dict[str, Any]:
    """写盘（内容寻址：同内容只存一份），返回落盘信息"""
    stem, ext = os.path.splitext(display_name)
    ext = ext.lower()
    sha = hashlib.sha256(content).hexdigest()
    d = student_homework_dir(student, task_id)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"seq{seq}_{sha[:12]}{ext}"
    if not path.exists():
        with open(path, "wb") as f:
            f.write(content)
    return {
        "abs_path": str(path),
        "stored_path": _rel_to_data(path),
        "sha256": sha,
        "ext": ext,
        "size": len(content),
        "kind": file_kind(ext),
    }


def _rel_to_data(path: Path) -> str:
    """存相对 DATA_DIR 的路径，桌面版迁移目录后仍能找到"""
    try:
        return os.path.relpath(str(path), str(DATA_DIR)).replace("\\", "/")
    except ValueError:
        return str(path).replace("\\", "/")


def resolve_stored(stored_path: str) -> Optional[Path]:
    """相对路径 → 绝对路径，并断言仍在 DATA_DIR 内（防库里被写入逃逸路径）"""
    if not stored_path:
        return None
    p = Path(stored_path)
    if not p.is_absolute():
        p = DATA_DIR / stored_path
    real = os.path.realpath(str(p))
    if not path_within(str(DATA_DIR), real):
        return None
    return Path(real) if os.path.isfile(real) else None


def sniff_ok(ext: str, content: bytes) -> bool:
    """扩展名之外再做内容嗅探：改了后缀的 exe / 空文件 / 伪装图片一律拦下"""
    if not content:
        return False
    head = content[:8]
    if ext in OFFICE_EXTS:
        # docx/xlsx/pptx 都是 zip(OOXML)，魔数必须是 PK\x03\x04
        return head[:2] == b"PK" and len(content) > 100
    if ext == ".pdf":
        return head[:4] == b"%PDF"
    if ext in IMAGE_EXTS:
        try:
            import io
            from PIL import Image
            Image.open(io.BytesIO(content)).verify()
            return True
        except Exception:
            return False
    if ext in LEGACY_OFFICE_EXTS:
        return False          # 旧二进制格式：可能是宏载体，不收
    if ext in TEXT_EXTS:
        return _decode_text(content) is not None
    return True


def _decode_text(content: bytes) -> Optional[str]:
    """UTF-8（含 BOM）→ GBK 逐级回退，都失败返回 None"""
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk"):
        try:
            return content.decode(enc)
        except (UnicodeDecodeError, TypeError):
            continue
    return None


# ════════════════════════════════════════════════════════════
# 取文
# ════════════════════════════════════════════════════════════

def extract_text(abs_path: str, ext: str) -> tuple[str, str, int]:
    """本地取文。返回 (extract_status, text, chars)

    status: ok | empty | scanned | failed | image（图片交给 VL，不在这里处理）
    """
    ext = (ext or "").lower()
    try:
        if ext in IMAGE_EXTS:
            return "image", "", 0
        if ext == ".docx":
            text = _from_docx(abs_path)
        elif ext == ".pdf":
            text = _from_pdf(abs_path)
            if len(text.strip()) < SCANNED_PDF_MIN_CHARS:
                return "scanned", text.strip()[:PER_FILE_CHARS], len(text.strip())
        elif ext == ".xlsx":
            text = _from_xlsx(abs_path)
        elif ext == ".pptx":
            text = _from_pptx(abs_path)
        elif ext in TEXT_EXTS:
            raw = _decode_text(Path(abs_path).read_bytes())
            text = (raw or "").strip()
        else:
            return "failed", "", 0
    except Exception as e:
        logger.warning(f"[作业取文] 失败 {os.path.basename(abs_path)}: {e}")
        return "failed", "", 0

    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        return "empty", "", 0
    return "ok", text[:PER_FILE_CHARS], len(text)


def _from_docx(path: str) -> str:
    """正文段落 + 表格；按文档顺序尽量保留标题层级"""
    from docx import Document
    doc = Document(path)
    out: list[str] = []
    for para in doc.paragraphs:
        txt = (para.text or "").strip()
        if not txt:
            continue
        style = (para.style.name if para.style is not None else "") or ""
        m = re.match(r"Heading (\d)", style)
        out.append(("#" * int(m.group(1)) + " " + txt) if m else txt)
    for ti, table in enumerate(doc.tables, 1):
        rows: list[str] = []
        for row in table.rows[:50]:
            cells = [c.text.strip().replace("\n", " ") for c in row.cells]
            if any(cells):
                rows.append(" | ".join(cells))
        if rows:
            out.append(f"[表格{ti}]\n" + "\n".join(rows))
    return "\n\n".join(out)


def _from_pdf(path: str) -> str:
    from PyPDF2 import PdfReader
    reader = PdfReader(path)
    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")       # 只解"空密码"（很多 PDF 设了空所有者密码）
        except Exception:
            return ""
    parts = []
    for page in reader.pages[:40]:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            parts.append("")
    return "\n\n".join(parts)


def _from_xlsx(path: str) -> str:
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    out = []
    for ws in wb.worksheets[:6]:
        lines = [f"[工作表 {ws.title}]"]
        for r_i, row in enumerate(ws.iter_rows(values_only=True)):
            if r_i >= 30:
                lines.append("…（仅取前 30 行）")
                break
            cells = [("" if v is None else str(v)).strip() for v in row][:20]
            if any(cells):
                lines.append(" | ".join(cells))
        out.append("\n".join(lines))
    wb.close()
    return "\n\n".join(out)


_A_T_RE = re.compile(r"<a:t>(.*?)</a:t>", re.S)


def _from_pptx(path: str) -> str:
    """无需 python-pptx：直接解 OOXML，按幻灯片序号抓 <a:t> 文本"""
    out = []
    with zipfile.ZipFile(path) as zf:
        names = [n for n in zf.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)]
        names.sort(key=lambda n: int(re.search(r"slide(\d+)\.xml", n).group(1)))
        for idx, n in enumerate(names[:40], 1):
            xml = zf.read(n).decode("utf-8", "ignore")
            texts = [re.sub(r"\s+", " ", t).strip() for t in _A_T_RE.findall(xml)]
            texts = [t for t in texts if t]
            if texts:
                out.append(f"第{idx}页: " + " / ".join(texts))
    return "\n\n".join(out)


# ════════════════════════════════════════════════════════════
# 图片预解读（VL）
# ════════════════════════════════════════════════════════════

VL_IMAGE_PROMPT = """下面是学生提交的作业图片（可能是手写稿、作品照片或屏幕截图）。
请按三部分输出，只描述图片里真实存在的内容，不要评价好坏、不要补写看不见的内容：

【逐字转录】把图中文字尽量原样转录（手写按可辨认内容转录，无法确认的字用 □）
【内容概述】3-6 句说明这份材料呈现了什么、做成了什么
【要点】3-6 条，每条一句话"""


def _is_model_missing(err: str) -> bool:
    """模型名在当前端点上不存在（而不是鉴权失败、超时）"""
    low = (err or "").lower()
    return "404" in low or "model_not_found" in low or "model not exist" in low


def vl_digest_images(image_paths: list[str], api_key: str, extra_hint: str = "") -> tuple[str, str]:
    """一张/多张图片 → VL 结构化摘要。返回 (status, text)；status ∈ ok|failed|skipped"""
    if not image_paths:
        return "skipped", ""
    if not api_key:
        return "failed", ""
    from backend.api.ai_service import call_multimodal_sync
    from backend.model_catalog import VL_MODELS, resolve_vl_model
    from backend.config import ai_api_base

    configured = resolve_vl_model(get_config_value("MODEL_VL_NAME", ""))
    # 配置值优先，其后是清单里其余实测可用的模型。配置里填了一个已下线的名字时自动换下一个 ——
    # 否则一个名字写错，整批作业图片都会被判成"无法解析"，学生直接吃 0 分。
    candidates = [configured] + [m["id"] for m in VL_MODELS if m["id"] != configured]
    prompt = VL_IMAGE_PROMPT + (f"\n\n补充背景：{extra_hint}" if extra_hint else "")
    for model in candidates:
        try:
            text = call_multimodal_sync(prompt, api_key, model, ai_api_base(), image_paths)
        except Exception as e:
            msg = str(e)
            logger.warning(f"[作业VL] 模型 {model} 调用失败: {msg}")
            # 只有"模型不存在"才值得换名字；鉴权失败/网络超时换模型也是同样结果，直接放弃
            if not _is_model_missing(msg):
                return "failed", ""
            continue
        text = (text or "").strip()
        if text:
            if model != configured:
                logger.warning(
                    f"[作业VL] 配置的视觉模型 {configured} 不可用，已回退到 {model}，建议在系统配置里改正")
            return "ok", text[:PER_FILE_CHARS]
    return "failed", ""


# ════════════════════════════════════════════════════════════
# 批改包与查重
# ════════════════════════════════════════════════════════════

DEFAULT_RUBRIC: list[dict[str, Any]] = [
    {"name": "内容切题", "max": 40},
    {"name": "结构表达", "max": 30},
    {"name": "规范完整", "max": 20},
    {"name": "创意亮点", "max": 10},
]


def rubric_of(task: dict) -> list[dict[str, Any]]:
    """教师没配就用默认四维；配了则按 total_score 归一，保证维度分之和 = 满分"""
    import json as _json
    raw = str(task.get("rubric") or "").strip()
    dims: list[dict[str, Any]] = []
    if raw:
        try:
            data = _json.loads(raw)
        except _json.JSONDecodeError:
            data = None
        if isinstance(data, list):
            for one in data[:8]:
                if isinstance(one, dict) and str(one.get("name") or "").strip():
                    try:
                        mx = float(one.get("max") or 0)
                    except (TypeError, ValueError):
                        mx = 0.0
                    dims.append({"name": str(one["name"]).strip()[:20], "max": max(0.0, mx)})
    if not dims:
        dims = [dict(d) for d in DEFAULT_RUBRIC]
    total = float(task.get("total_score") or 100)
    s = sum(d["max"] for d in dims)
    if s > 0 and total > 0 and abs(s - total) > 0.01:
        k = total / s
        for d in dims:
            d["max"] = round(d["max"] * k, 1)
    return dims


def render_rubric(dims: list[dict[str, Any]]) -> str:
    return "、".join(f"{d['name']} {d['max']:g}分" for d in dims)


def clip(text: str, budget: int) -> str:
    """按预算裁剪：头 2/3 + 尾 1/3，中间标注省略，避免长文只看到开头就打分"""
    t = (text or "").strip()
    if len(t) <= budget:
        return t
    head = int(budget * 2 / 3)
    tail = budget - head
    return (t[:head] + "\n…（中间省略，原文共 %d 字）…\n" % len(t) + t[-tail:])


# ── 作业要求的排版归一 ──────────────────────────────────────
# AI 起草经常把"提交物/硬性规范/要求点/评分侧重"写成一大段不断行的话（也可能整段只给一两个换行）；
# 教师自己粘贴的文字也常只有单个换行。这里按小节标记与序号做一次确定性的重排，
# 让要求框里至少能分段、能列出条目，而不是糊成一片。
_REQ_MARKERS = (
    "学习目标：", "提交物：", "提交要求：", "硬性规范：", "格式要求：", "可检验要求点：",
    "要求点：", "制作提示：", "提交方式：", "注意事项：", "评分维度：", "评分侧重：",
    "对话方式：", "评分标准：",
)
# 长标记排在前面，避免"可检验要求点："被短标记"要求点："从中间拆开
_MARKER_RE = re.compile("|".join(re.escape(m) for m in sorted(_REQ_MARKERS, key=len, reverse=True)))
# "1.5 倍行距"、"3-5 个" 里的点号不是序号：序号后面不能紧跟数字
_REQ_NUM_RE = re.compile(r"(?<![\d.、])(\d{1,2})[\.、](?!\d)[ \t]*")


def format_requirement(text: str) -> str:
    """把一段"没有换行"的作业要求重排成分段 + 逐条的 Markdown。

    AI 起草常把「提交物/硬性规范/要求点/评分侧重」写成一大段不断行的话，教师粘贴的文字也常
    只有单个换行；要求框里糊成一片就没法看。这里做一次确定性重排 —— 只在原文几乎没有换行
    时才动手（已经排好版的一字不改，避免把教师的版式弄乱），且保留句末标点。
    """
    raw = str(text or "")
    if not raw.strip():
        return raw
    out = re.sub(r"\r\n?", "\n", raw)
    if out.count("\n") >= 3:
        return re.sub(r"\n{3,}", "\n\n", out).strip()

    # 1) 小节标记前断行（标记已独占行首的不动；句号等标点原样留在上一行末尾）
    src = out
    out = _MARKER_RE.sub(
        lambda m: ("" if (m.start() == 0 or src[:m.start()].endswith("\n")) else "\n\n") + m.group(0),
        src)

    # 2) 条目序号前断行："…；1. xxx；2. yyy" → 每条一行
    src = out
    out = _REQ_NUM_RE.sub(
        lambda m: ("" if (m.start() == 0 or src[:m.start()].endswith("\n")) else "\n")
        + m.group(1) + ". ", src)

    # 3) 分号后接"必须/需/请/至少…"这类硬性条款时另起一行（老师写要求的习惯）
    out = re.sub(r"；(?=\s*(?:必须|需要|需|请|要求|不得|禁止|至少|至多|文末|图中))", "；\n", out)

    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def similarity_pairs(items: dict[str, str], threshold: float = 0.8,
                     min_chars: int = 60) -> list[dict[str, Any]]:
    """同班正文两两比对（字 3-gram Jaccard）。只标旗不扣分，40 人 ~780 对，纯内存毫秒级"""
    import itertools
    grams: dict[str, set] = {}
    for who, txt in items.items():
        norm = re.sub(r"\s+", "", str(txt or ""))
        if len(norm) < min_chars:
            continue
        grams[who] = {norm[i:i + 3] for i in range(len(norm) - 2)}
    out = []
    for a, b in itertools.combinations(sorted(grams), 2):
        ga, gb = grams[a], grams[b]
        inter = len(ga & gb)
        union = len(ga | gb) or 1
        ratio = inter / union
        if ratio >= threshold:
            out.append({"a": a, "b": b, "ratio": round(ratio, 3)})
    out.sort(key=lambda x: -x["ratio"])
    return out[:50]
