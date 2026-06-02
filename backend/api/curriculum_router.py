"""
课程大纲 API 路由
课程 → 章/节 → 知识点 四级树形结构管理
支持资源绑定、学习进度追踪
"""
import json
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from backend.database import execute_query_dict as execute_query, execute_insert_update, get_connection
from backend.question_db import execute_query as q_execute_query
from backend.api.dependencies import get_current_user
from backend.auth import is_admin, is_teacher
from backend.logger import logger
from backend.api.chat_router import get_api_keys

router = APIRouter()


# ═══════════════════════════════════════════════════════════
# Pydantic 请求/响应模型
# ═══════════════════════════════════════════════════════════

class CourseCreate(BaseModel):
    name: str
    code: str = ""
    description: str = ""
    grade: str = ""
    cover_image: str = ""
    sort_order: int = 0

class CourseUpdate(BaseModel):
    name: str | None = None
    code: str | None = None
    description: str | None = None
    grade: str | None = None
    cover_image: str | None = None
    sort_order: int | None = None
    status: str | None = None

class ChapterCreate(BaseModel):
    course_id: int
    parent_id: int | None = None
    name: str
    description: str = ""
    sort_order: int = 0

class ChapterUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    parent_id: int | None = None
    sort_order: int | None = None
    status: str | None = None

class KnowledgePointCreate(BaseModel):
    chapter_id: int
    name: str
    description: str = ""
    learning_objectives: str = ""
    difficulty: str = "medium"
    estimated_minutes: int = 0
    sort_order: int = 0

class KnowledgePointUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    learning_objectives: str | None = None
    difficulty: str | None = None
    estimated_minutes: int | None = None
    sort_order: int | None = None
    status: str | None = None

class BindingCreate(BaseModel):
    knowledge_point_id: int
    resource_type: str
    resource_id: int
    sort_order: int = 0

class ProgressUpdate(BaseModel):
    status: str = "in_progress"  # not_started | in_progress | completed
    score: float | None = None


# ═══════════════════════════════════════════════════════════
# 辅助函数
# ═══════════════════════════════════════════════════════════

def _can_manage(user: dict) -> bool:
    """检查是否有管理权限（教师/管理员）"""
    role = user.get("role", 2)
    return role in (0, 1)


def _check_resource_ownership(resource_type: str, resource_id: int, username: str) -> bool:
    """校验指定资源是否属于该用户"""
    try:
        if resource_type in ("html", "download"):
            row = execute_query_one(
                "SELECT 1 FROM shared_resources WHERE id=? AND owner_username=?",
                (resource_id, username),
            )
            return row is not None
        elif resource_type == "exam":
            row = q_execute_query(
                "SELECT 1 FROM exams WHERE id=? AND creator_username=?",
                (resource_id, username),
            )
            return len(row) > 0
        elif resource_type == "discussion":
            row = execute_query_one(
                "SELECT 1 FROM discussions WHERE id=? AND creator_username=?",
                (resource_id, username),
            )
            return row is not None
        elif resource_type == "interaction_quiz":
            row = execute_query_one(
                "SELECT 1 FROM interaction_quizzes WHERE id=? AND creator_username=?",
                (resource_id, username),
            )
            return row is not None
        elif resource_type == "task":
            row = execute_query_one(
                "SELECT 1 FROM tasks WHERE id=? AND creator_username=?",
                (str(resource_id), username),
            )
            return row is not None
    except Exception:
        pass
    return False


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _build_course_tree(course_id: int) -> list[dict]:
    """构建课程的完整章节-知识点树（批量查询优化版）

    优化说明：将 N+1 次递归查询合并为 2 次批量查询，
    在内存中用字典组装树结构，大幅减少 SQL 查询次数。
    """
    # 1) 一次性查询该课程所有章节
    all_chapters = execute_query(
        """SELECT * FROM chapters
           WHERE course_id=? AND status='active'
           ORDER BY sort_order, id""",
        (course_id,),
    )
    # 2) 一次性查询该课程所有知识点
    all_kps = execute_query(
        """SELECT kp.* FROM knowledge_points kp
           JOIN chapters ch ON ch.id = kp.chapter_id
           WHERE ch.course_id=? AND kp.status='active'
           ORDER BY kp.sort_order, kp.id""",
        (course_id,),
    )

    # 2.5) 批量查询所有知识点的资源绑定数量
    kp_ids = [kp["id"] for kp in all_kps]
    resource_count_map: dict[int, int] = {}
    if kp_ids:
        placeholders = ",".join("?" for _ in kp_ids)
        counts = execute_query(
            f"SELECT knowledge_point_id, COUNT(*) as cnt FROM curriculum_bindings WHERE knowledge_point_id IN ({placeholders}) GROUP BY knowledge_point_id",
            tuple(kp_ids),
        )
        for row in counts:
            resource_count_map[row["knowledge_point_id"]] = row["cnt"]

    # 3) 构建 parent_id → 章节列表 的映射
    children_map: dict[int, list[dict]] = {}
    for ch in all_chapters:
        pid = ch["parent_id"] or 0  # 顶层用 0 表示
        children_map.setdefault(pid, []).append(ch)

    # 4) 构建 chapter_id → 知识点列表 的映射
    kp_map: dict[int, list[dict]] = {}
    for kp in all_kps:
        kp_map.setdefault(kp["chapter_id"], []).append(kp)

    # 5) 递归组装树
    def _build_node(ch: dict) -> dict:
        node = dict(ch)
        # 子章节
        node["children"] = [_build_node(c) for c in children_map.get(ch["id"], [])]
        # 知识点
        kps = kp_map.get(ch["id"], [])
        for kp in kps:
            kp["resource_count"] = resource_count_map.get(kp["id"], 0)
        node["knowledge_points"] = kps
        return node

    return [_build_node(ch) for ch in children_map.get(0, [])]


def _inject_progress(kps: list[dict], username: str):
    """为学生注入学习进度状态"""
    if not kps:
        return
    kp_ids = [kp["id"] for kp in kps]
    placeholders = ",".join("?" for _ in kp_ids)
    rows = execute_query(
        f"SELECT knowledge_point_id, status, score FROM learning_progress WHERE student_username=? AND knowledge_point_id IN ({placeholders})",
        (username, *kp_ids),
    )
    progress_map = {r["knowledge_point_id"]: r for r in rows}
    for kp in kps:
        p = progress_map.get(kp["id"])
        if p:
            kp["progress_status"] = p["status"]
            kp["progress_score"] = p["score"]
        else:
            kp["progress_status"] = "not_started"
            kp["progress_score"] = 0


def _get_resource_info(resource_type: str, resource_id: int) -> dict:
    """根据资源类型和 ID 获取资源名称和访问路径"""
    result = {"name": "", "url": ""}
    try:
        if resource_type in ("html", "download"):
            rows = execute_query(
                "SELECT file_name, file_path FROM shared_resources WHERE id=? AND resource_type=?",
                (resource_id, resource_type),
            )
            if rows:
                result["name"] = rows[0]["file_name"]
                result["url"] = "/api/files/" + rows[0]["file_path"].lstrip("/")
        elif resource_type == "question":
            rows = q_execute_query(
                "SELECT question_text FROM question_bank WHERE id=? AND status='active'",
                (resource_id,),
            )
            if rows:
                text = rows[0]["question_text"]
                result["name"] = text[:60] + ("..." if len(text) > 60 else "")
                result["url"] = f"/questions?highlight={resource_id}"
        elif resource_type == "exam":
            rows = q_execute_query(
                "SELECT title FROM exams WHERE id=?",
                (resource_id,),
            )
            if rows:
                result["name"] = rows[0]["title"]
                result["url"] = f"/exam?highlight={resource_id}"
        elif resource_type == "discussion":
            rows = execute_query(
                "SELECT title FROM discussions WHERE id=?",
                (resource_id,),
            )
            if rows:
                result["name"] = rows[0]["title"]
                result["url"] = f"/discussion?highlight={resource_id}"
        elif resource_type == "interaction_quiz":
            rows = execute_query(
                "SELECT title FROM interaction_quizzes WHERE id=?",
                (resource_id,),
            )
            if rows:
                result["name"] = rows[0]["title"]
                result["url"] = f"/interaction?highlight={resource_id}"
        elif resource_type == "task":
            rows = execute_query(
                "SELECT name FROM tasks WHERE id=?",
                (str(resource_id),),
            )
            if rows:
                result["name"] = rows[0]["name"]
                result["url"] = f"/tasks?highlight={resource_id}"
    except Exception:
        pass
    if not result["name"]:
        result["name"] = f"[{resource_type}:{resource_id}]"
    return result


# ═══════════════════════════════════════════════════════════
# AI 辅助生成课程结构
# ═══════════════════════════════════════════════════════════

class AIGenerateRequest(BaseModel):
    """AI 生成课程请求"""
    content: str = ""           # 文本内容
    subject: str = "信息技术"    # 科目
    grade: str = "高一"          # 年级
    course_name: str = ""       # 课程名称（留空由 AI 推断）
    auto_save: bool = False     # 是否自动保存到数据库

@router.post("/ai-generate", summary="AI 辅助生成课程结构")
async def ai_generate_curriculum(req: AIGenerateRequest, request: Request):
    """上传教学内容文本，AI 自动提取课程→章节→知识点结构"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    if not req.content.strip():
        raise HTTPException(status_code=400, detail="请输入教学内容文本")

    # 获取 API Key（复用 chat_router 的缓存逻辑）
    api_key, _ = get_api_keys(user["username"])
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请在系统配置中设置")

    # 构造 Prompt
    course_hint = f"课程名称：{req.course_name}" if req.course_name else "请根据内容推断课程名称"
    prompt = f"""你是教学大纲设计师。将以下教学内容提取为 JSON 大纲。

【三条铁律】
1. 结构: 章→节→知识点，知识点只放在节下
2. ⚠️ 知识点名称绝不能与节名相同
3. 每个节至少拆出 1~2 个知识点

科目：{req.subject}，年级：{req.grade}，{course_hint}

✅ 正确: 节="机器学习基础" → 知识点=["监督学习算法","模型评估方法"]
❌ 禁止: 节="机器学习基础" → 知识点=["机器学习基础"]  ← 完全重复！

输出格式：
{{"course_name":"...","chapters":[{{"name":"章","children":[
  {{"name":"节","knowledge_points":[{{"name":"知识点","difficulty":"easy","estimated_minutes":20}}]}}
]}}]}}

内容：
{req.content[:8000]}"""

    try:
        from backend.api.ai_service import call_ai_sync
        ai_response = call_ai_sync(prompt, api_key)
    except Exception as e:
        logger.error(f"AI 生成课程失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 调用失败: {str(e)}")

    # 解析 AI 返回的 JSON
    result = _parse_ai_json(ai_response)
    if not result:
        raise HTTPException(status_code=500, detail="AI 返回格式异常，无法解析为课程结构")

    # 后处理：修正 AI 输出的不合格知识点（同名、缺失等）
    _fix_kp_names(result)

    # 自动保存
    if req.auto_save:
        saved = _save_ai_result(result, req.subject, req.grade, user["username"])
        result["saved"] = saved

    return result


@router.post("/ai-generate-from-file", summary="上传文档 AI 生成课程结构")
async def ai_generate_from_file(request: Request):
    """上传文档文件（txt/md/pdf/docx），AI 自动提取课程→章节→知识点结构"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    # 获取 API Key
    api_key, _ = get_api_keys(user["username"])
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请在系统配置中设置")

    # 解析 multipart 表单
    form = await request.form()
    file = form.get("file")
    subject = form.get("subject", "信息技术")
    grade = form.get("grade", "高一")
    course_name = form.get("course_name", "")
    auto_save = form.get("auto_save", "false") == "true"

    if not file or not hasattr(file, "filename") or not file.filename:
        raise HTTPException(status_code=400, detail="请上传文件")

    # 读取文件内容
    content_bytes = await file.read()
    filename = file.filename.lower()

    # 提取文本（按扩展名处理）
    text_content = ""
    if filename.endswith(".txt") or filename.endswith(".md"):
        text_content = content_bytes.decode("utf-8", errors="replace")
    elif filename.endswith(".pdf"):
        try:
            import io
            import PyPDF2
            reader = PyPDF2.PdfReader(io.BytesIO(content_bytes))
            text_content = "\n".join(page.extract_text() for page in reader.pages)
        except ImportError:
            # 无 PyPDF2 时尝试 pdfminer
            try:
                import io
                from pdfminer.high_level import extract_text as pdf_extract
                text_content = pdf_extract(io.BytesIO(content_bytes))
            except ImportError:
                raise HTTPException(status_code=400, detail="缺少 PDF 解析库，请安装 PyPDF2")
    elif filename.endswith(".docx"):
        try:
            import io
            from docx import Document
            doc = Document(io.BytesIO(content_bytes))
            text_content = "\n".join(p.text for p in doc.paragraphs)
        except ImportError:
            raise HTTPException(status_code=400, detail="缺少 DOCX 解析库，请安装 python-docx")
    else:
        raise HTTPException(status_code=400, detail=f"不支持的文件类型: {filename}，支持 txt/md/pdf/docx")

    if not text_content.strip():
        raise HTTPException(status_code=400, detail="文件内容为空或无法提取文本")

    if len(text_content) > 20000:
        text_content = text_content[:20000] + "\n\n[内容已截断，仅处理前 20000 字符]"

    # 构造 Prompt
    course_hint = f"课程名称：{course_name}" if course_name else "请根据内容推断课程名称"
    prompt = f"""你是教学大纲设计师。将文件「{filename}」中的教学内容提取为 JSON 大纲。

【三条铁律】
1. 结构: 章→节→知识点，知识点只放在节下
2. ⚠️ 知识点名称绝不能与节名相同
3. 每个节至少拆出 1~2 个知识点

科目：{subject}，年级：{grade}，{course_hint}

✅ 正确: 节="机器学习基础" → 知识点=["监督学习算法","模型评估方法"]
❌ 禁止: 节="机器学习基础" → 知识点=["机器学习基础"]  ← 完全重复！

输出格式：
{{"course_name":"...","chapters":[{{"name":"章","children":[
  {{"name":"节","knowledge_points":[{{"name":"知识点","difficulty":"easy","estimated_minutes":20}}]}}
]}}]}}

内容：
{text_content}"""

    try:
        from backend.api.ai_service import call_ai_sync
        ai_response = call_ai_sync(prompt, api_key)
    except Exception as e:
        logger.error(f"AI 文件生成课程失败: {e}")
        raise HTTPException(status_code=500, detail=f"AI 调用失败: {str(e)}")

    # 解析 AI 返回的 JSON
    result = _parse_ai_json(ai_response)
    if not result:
        raise HTTPException(status_code=500, detail="AI 返回格式异常，无法解析为课程结构")

    # 后处理：修正 AI 输出的不合格知识点（同名、缺失等）
    _fix_kp_names(result)

    # 自动保存
    if auto_save:
        saved = _save_ai_result(result, subject, grade, user["username"])
        result["saved"] = saved

    result["source_file"] = filename
    return result


def _parse_ai_json(text: str) -> dict | None:
    """从 AI 返回文本中提取 JSON"""
    # 尝试直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 尝试从 ```json ``` 代码块中提取
    import re
    match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # 尝试从 { 到 } 提取最外层 JSON
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass

    return None


def _save_ai_result(result: dict, subject: str, grade: str, username: str) -> dict:
    """将 AI 生成的结构保存到数据库"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    saved = {"course_id": None, "chapters": 0, "knowledge_points": 0}

    # 1. 创建课程
    course_name = result.get("course_name", f"{subject}课程")
    course_code = result.get("course_code", "")
    course_desc = result.get("course_description", f"AI 自动生成的{subject}课程大纲")

    course_id = execute_insert_update(
        """INSERT INTO courses (name, code, description, grade, sort_order, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 'active', ?, ?)""",
        (course_name, course_code, course_desc, grade, now, now),
    )
    saved["course_id"] = course_id

    # 2. 创建章节和知识点
    chapters = result.get("chapters", [])
    for ch_idx, ch in enumerate(chapters):
        ch_id = execute_insert_update(
            """INSERT INTO chapters (course_id, parent_id, name, description, sort_order, status, created_at, updated_at)
               VALUES (?, NULL, ?, ?, ?, 'active', ?, ?)""",
            (course_id, ch.get("name", ""), ch.get("description", ""), ch_idx, now, now),
        )
        saved["chapters"] += 1

        # 子章节（节）
        children = ch.get("children", [])
        top_kps = ch.get("knowledge_points", [])

        # 后处理：如果章既有子节又有章级知识点，将章级知识点合并到子节中
        # 确保知识点不会与节平级（用户期望的结构）
        if top_kps and children:
            for kp in top_kps:
                kp_name = kp.get("name", "")
                # 查找同名节
                matched = [s for s in children if s.get("name", "").strip() == kp_name.strip()]
                if matched:
                    # 追加到同名节的 knowledge_points 中
                    matched[0].setdefault("knowledge_points", []).append(kp)
                else:
                    # 以知识点名称创建新节，将知识点放入其中
                    children.append({
                        "name": kp_name,
                        "description": kp.get("description", ""),
                        "knowledge_points": [kp],
                    })
            ch["knowledge_points"] = []  # 清空章级知识点，避免重复

        for sec_idx, sec in enumerate(children):
            sec_id = execute_insert_update(
                """INSERT INTO chapters (course_id, parent_id, name, description, sort_order, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'active', ?, ?)""",
                (course_id, ch_id, sec.get("name", ""), sec.get("description", ""), sec_idx, now, now),
            )
            saved["chapters"] += 1

            # 该节下专属的知识点
            for kp_idx, kp in enumerate(sec.get("knowledge_points", [])):
                _insert_kp(sec_id, kp, kp_idx, now)
                saved["knowledge_points"] += 1

        # 只有章完全没有子节时，知识点才挂在章下
        if top_kps and not children:
            for kp_idx, kp in enumerate(top_kps):
                _insert_kp(ch_id, kp, kp_idx, now)
                saved["knowledge_points"] += 1

    logger.info(f"AI 生成课程已保存: {course_name} (id={course_id}), {saved}")
    return saved


def _insert_kp(chapter_id: int, kp: dict, sort_order: int, now: str):
    """插入单个知识点"""
    execute_insert_update(
        """INSERT INTO knowledge_points (chapter_id, name, description, learning_objectives, difficulty, estimated_minutes, sort_order, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)""",
        (
            chapter_id,
            kp.get("name", ""),
            kp.get("description", ""),
            kp.get("learning_objectives", ""),
            kp.get("difficulty", "medium"),
            kp.get("estimated_minutes", 30),
            sort_order,
            now,
            now,
        ),
    )


# ═══════════════════════════════════════════════════════════
# AI 结果后处理：修正不合格的知识点
# ═══════════════════════════════════════════════════════════

def _fix_kp_names(result: dict):
    """修正 AI 返回结果中知识点名称不合格的情况"""
    for ch in result.get("chapters", []):
        for sec in ch.get("children", []):
            kps = sec.get("knowledge_points", [])
            sec_name = sec.get("name", "").strip()

            # 修正1: 知识点名与节名相同时，自动生成更具体的名称
            # 修正2: 知识点数量太少时，补充默认知识点
            new_kps = []
            for kp in kps:
                kp_name = kp.get("name", "").strip()
                if kp_name == sec_name:
                    # 根据节名自动拆解知识点
                    generated = _split_section_to_kps(sec_name, kp)
                    new_kps.extend(generated)
                else:
                    new_kps.append(kp)

            # 如果处理后仍然没有知识点，生成默认知识点
            if not new_kps and sec_name:
                new_kps.append({
                    "name": f"{sec_name}概述",
                    "description": sec.get("description", ""),
                    "learning_objectives": f"掌握{sec_name}的基本概念",
                    "difficulty": "medium",
                    "estimated_minutes": 25,
                })

            sec["knowledge_points"] = new_kps


def _split_section_to_kps(sec_name: str, original_kp: dict) -> list[dict]:
    """将节名拆解为多个具体的知识点名称"""
    difficulty = original_kp.get("difficulty", "medium")
    minutes = original_kp.get("estimated_minutes", 30)
    desc = original_kp.get("description", "")
    obj = original_kp.get("learning_objectives", "")

    # 尝试从节名中提取子知识点
    # 1) 包含"与"的：拆分为左右两部分
    if "与" in sec_name:
        parts = sec_name.split("与", 1)
        return [
            {
                "name": parts[0].strip(),
                "description": desc,
                "learning_objectives": obj or f"理解{parts[0].strip()}",
                "difficulty": difficulty,
                "estimated_minutes": max(minutes // 2, 15),
            },
            {
                "name": parts[1].strip(),
                "description": desc,
                "learning_objectives": obj or f"掌握{parts[1].strip()}",
                "difficulty": difficulty,
                "estimated_minutes": max(minutes - minutes // 2, 15),
            },
        ]

    # 2) 其他：生成"概述/核心概念/应用实践"等通用知识点
    return [
        {
            "name": f"{sec_name}基本概念",
            "description": desc,
            "learning_objectives": obj or f"理解{sec_name}的基本概念",
            "difficulty": "easy",
            "estimated_minutes": max(minutes // 2, 15),
        },
        {
            "name": f"{sec_name}核心原理",
            "description": desc,
            "learning_objectives": obj or f"掌握{sec_name}的核心原理",
            "difficulty": difficulty,
            "estimated_minutes": max(minutes - minutes // 2, 15),
        },
    ]


# ═══════════════════════════════════════════════════════════
# 完整树查询（核心端点）
# ═══════════════════════════════════════════════════════════

@router.get("/tree", summary="获取全部课程完整树形结构")
async def get_curriculum_tree(request: Request):
    """返回课程→章→节→知识点的完整嵌套结构，学生视图会注入学习进度"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)
    user_grade = user.get("grade", "")

    # 查询课程列表（学生按年级匹配）
    if role == 2 and user_grade:
        grades = [g.strip() for g in user_grade.split("|")]
        conditions = []
        params = []
        for g in grades:
            conditions.append("grade LIKE ?")
            params.append(f"%{g}%")
        where = " OR ".join(conditions)
        courses = execute_query(
            f"SELECT * FROM courses WHERE status='active' AND ({where}) ORDER BY sort_order, id",
            tuple(params),
        )
    else:
        courses = execute_query(
            "SELECT * FROM courses WHERE status='active' ORDER BY sort_order, id",
        )

    result = []
    for course in courses:
        course_dict = dict(course)
        course_dict["chapters"] = _build_course_tree(course["id"])

        # 为所有知识点注入进度（学生视图）
        if role == 2:
            all_kps = []
            def _collect_kps(nodes):
                for node in nodes:
                    _collect_kps(node.get("children", []))
                    all_kps.extend(node.get("knowledge_points", []))
            _collect_kps(course_dict["chapters"])
            _inject_progress(all_kps, username)

            # 计算进度统计
            total = len(all_kps)
            completed = sum(1 for kp in all_kps if kp.get("progress_status") == "completed")
            course_dict["progress"] = {"total": total, "completed": completed}

        result.append(course_dict)

    return result


# ═══════════════════════════════════════════════════════════
# 课程 CRUD
# ═══════════════════════════════════════════════════════════

@router.get("/courses", summary="获取课程列表")
async def list_courses(
    request: Request,
    grade: str = Query(None, description="筛选年级"),
    status: str = Query(None, description="筛选状态"),
):
    """获取课程列表，支持按年级和状态筛选"""
    user = get_current_user(request)
    conditions = []
    params = []

    if grade:
        conditions.append("grade LIKE ?")
        params.append(f"%{grade}%")
    if status:
        conditions.append("status = ?")
        params.append(status)

    where = " AND ".join(conditions) if conditions else "1=1"
    rows = execute_query(
        f"SELECT * FROM courses WHERE {where} ORDER BY sort_order, id",
        tuple(params),
    )
    return {"courses": rows, "total": len(rows)}


@router.get("/courses/{course_id}", summary="获取课程详情（含树结构）")
async def get_course(course_id: int, request: Request):
    """获取课程信息及完整的章节-知识点树"""
    user = get_current_user(request)
    course = execute_query_one("SELECT * FROM courses WHERE id=?", (course_id,))
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")

    course_dict = dict(course)
    course_dict["chapters"] = _build_course_tree(course_id)

    # 学生注入进度
    if user.get("role") == 2:
        all_kps = []
        def _collect_kps(nodes):
            for node in nodes:
                _collect_kps(node.get("children", []))
                all_kps.extend(node.get("knowledge_points", []))
        _collect_kps(course_dict["chapters"])
        _inject_progress(all_kps, user["username"])
        total = len(all_kps)
        completed = sum(1 for kp in all_kps if kp.get("progress_status") == "completed")
        course_dict["progress"] = {"total": total, "completed": completed}

    return course_dict


@router.post("/courses", summary="创建课程")
async def create_course(req: CourseCreate, request: Request):
    """创建新课程（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    if not req.name.strip():
        raise HTTPException(status_code=400, detail="请输入课程名称")

    now = _now()
    course_id = execute_insert_update(
        """INSERT INTO courses (name, code, description, grade, cover_image, sort_order, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)""",
        (req.name, req.code, req.description, req.grade, req.cover_image, req.sort_order, now, now),
    )
    logger.info(f"用户 {user['username']} 创建课程: {req.name} (id={course_id})")
    return {"message": f"课程「{req.name}」创建成功", "course_id": course_id}


@router.put("/courses/{course_id}", summary="更新课程")
async def update_course(course_id: int, req: CourseUpdate, request: Request):
    """更新课程信息（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    course = execute_query_one("SELECT * FROM courses WHERE id=?", (course_id,))
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")

    updates = {}
    for field in ["name", "code", "description", "grade", "cover_image", "sort_order", "status"]:
        val = getattr(req, field, None)
        if val is not None:
            updates[field] = val

    if not updates:
        return {"message": "无更新内容"}

    now = _now()
    updates["updated_at"] = now
    set_clause = ", ".join(f"{k}=?" for k in updates)
    params = list(updates.values()) + [course_id]
    execute_insert_update(
        f"UPDATE courses SET {set_clause} WHERE id=?", tuple(params),
    )
    logger.info(f"用户 {user['username']} 更新课程 id={course_id}")
    return {"message": "课程更新成功"}


@router.delete("/courses/{course_id}", summary="删除课程（软删除）")
async def delete_course(course_id: int, request: Request):
    """删除课程（管理员）—— 将课程及所有子节点设为 inactive"""
    user = get_current_user(request)
    if not is_admin(user.get("username", "")):
        raise HTTPException(status_code=403, detail="权限不足：需要管理员权限")

    course = execute_query_one("SELECT * FROM courses WHERE id=?", (course_id,))
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")

    now = _now()
    execute_insert_update(
        "UPDATE courses SET status='inactive', updated_at=? WHERE id=?", (now, course_id),
    )
    # 级联下线所有关联的章节和知识点
    chapter_ids = execute_query(
        "SELECT id FROM chapters WHERE course_id=?", (course_id,),
    )
    for ch in chapter_ids:
        execute_insert_update(
            "UPDATE chapters SET status='inactive', updated_at=? WHERE id=?", (now, ch["id"]),
        )
        execute_insert_update(
            "UPDATE knowledge_points SET status='inactive', updated_at=? WHERE chapter_id=?",
            (now, ch["id"]),
        )

    logger.info(f"管理员 {user['username']} 删除课程 id={course_id}")
    return {"message": f"课程「{course['name']}」已删除"}


# ═══════════════════════════════════════════════════════════
# 章节 CRUD
# ═══════════════════════════════════════════════════════════

@router.get("/chapters/{chapter_id}", summary="获取章节详情")
async def get_chapter(chapter_id: int, request: Request):
    """获取章节信息（含子章节和知识点）"""
    get_current_user(request)
    ch = execute_query_one("SELECT * FROM chapters WHERE id=?", (chapter_id,))
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    return _build_chapter_node(ch)


@router.post("/chapters", summary="创建章节")
async def create_chapter(req: ChapterCreate, request: Request):
    """创建章节（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="请输入章节名称")

    # 校验课程存在
    course = execute_query_one("SELECT id FROM courses WHERE id=?", (req.course_id,))
    if not course:
        raise HTTPException(status_code=404, detail="课程不存在")

    # 校验父章节存在（如果有）
    if req.parent_id:
        parent = execute_query_one("SELECT id FROM chapters WHERE id=?", (req.parent_id,))
        if not parent:
            raise HTTPException(status_code=404, detail="父章节不存在")

    now = _now()
    chapter_id = execute_insert_update(
        """INSERT INTO chapters (course_id, parent_id, name, description, sort_order, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)""",
        (req.course_id, req.parent_id, req.name, req.description, req.sort_order, now, now),
    )
    logger.info(f"用户 {user['username']} 创建章节: {req.name} (id={chapter_id})")
    return {"message": f"章节「{req.name}」创建成功", "chapter_id": chapter_id}


@router.put("/chapters/{chapter_id}", summary="更新章节")
async def update_chapter(chapter_id: int, req: ChapterUpdate, request: Request):
    """更新章节信息（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    ch = execute_query_one("SELECT * FROM chapters WHERE id=?", (chapter_id,))
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")

    updates = {}
    for field in ["name", "description", "parent_id", "sort_order", "status"]:
        val = getattr(req, field, None)
        if val is not None:
            updates[field] = val

    if not updates:
        return {"message": "无更新内容"}

    now = _now()
    updates["updated_at"] = now
    set_clause = ", ".join(f"{k}=?" for k in updates)
    params = list(updates.values()) + [chapter_id]
    execute_insert_update(
        f"UPDATE chapters SET {set_clause} WHERE id=?", tuple(params),
    )
    logger.info(f"用户 {user['username']} 更新章节 id={chapter_id}")
    return {"message": "章节更新成功"}


@router.delete("/chapters/{chapter_id}", summary="删除章节（软删除）")
async def delete_chapter(chapter_id: int, request: Request):
    """删除章节（教师/管理员）—— 级联下线子章节和知识点"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    ch = execute_query_one("SELECT * FROM chapters WHERE id=?", (chapter_id,))
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")

    now = _now()
    # 级联下线所有子章节
    children = execute_query(
        "SELECT id FROM chapters WHERE parent_id=?", (chapter_id,),
    )
    for child in children:
        execute_insert_update(
            "UPDATE chapters SET status='inactive', updated_at=? WHERE id=?", (now, child["id"]),
        )
        execute_insert_update(
            "UPDATE knowledge_points SET status='inactive', updated_at=? WHERE chapter_id=?",
            (now, child["id"]),
        )
    # 下线当前章节的知识点
    execute_insert_update(
        "UPDATE knowledge_points SET status='inactive', updated_at=? WHERE chapter_id=?",
        (now, chapter_id),
    )
    # 下线当前章节
    execute_insert_update(
        "UPDATE chapters SET status='inactive', updated_at=? WHERE id=?", (now, chapter_id),
    )
    logger.info(f"用户 {user['username']} 删除章节 id={chapter_id}")
    return {"message": "章节已删除"}


# ═══════════════════════════════════════════════════════════
# 知识点 CRUD
# ═══════════════════════════════════════════════════════════

@router.get("/knowledge-points/{kp_id}", summary="获取知识点详情")
async def get_knowledge_point(kp_id: int, request: Request):
    """获取知识点详情（含绑定的资源列表）"""
    user = get_current_user(request)
    kp = execute_query_one("SELECT * FROM knowledge_points WHERE id=?", (kp_id,))
    if not kp:
        raise HTTPException(status_code=404, detail="知识点不存在")

    kp_dict = dict(kp)

    # 获取绑定的资源
    bindings = execute_query(
        """SELECT cb.* FROM curriculum_bindings cb
           WHERE cb.knowledge_point_id=? ORDER BY cb.sort_order, cb.id""",
        (kp_id,),
    )
    resources = []
    for b in bindings:
        info = _get_resource_info(b["resource_type"], b["resource_id"])
        resources.append({
            "binding_id": b["id"],
            "resource_type": b["resource_type"],
            "resource_id": b["resource_id"],
            "resource_name": info["name"],
            "resource_url": info["url"],
            "sort_order": b["sort_order"],
            "created_at": b["created_at"],
        })
    kp_dict["resources"] = resources

    # 学生注入进度
    if user.get("role") == 2:
        progress = execute_query_one(
            "SELECT status, score FROM learning_progress WHERE student_username=? AND knowledge_point_id=?",
            (user["username"], kp_id),
        )
        if progress:
            kp_dict["progress_status"] = progress["status"]
            kp_dict["progress_score"] = progress["score"]
        else:
            kp_dict["progress_status"] = "not_started"
            kp_dict["progress_score"] = 0

    return kp_dict


@router.post("/knowledge-points", summary="创建知识点")
async def create_knowledge_point(req: KnowledgePointCreate, request: Request):
    """创建知识点（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")
    if not req.name.strip():
        raise HTTPException(status_code=400, detail="请输入知识点名称")

    # 校验章节存在
    ch = execute_query_one("SELECT id FROM chapters WHERE id=?", (req.chapter_id,))
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")

    now = _now()
    kp_id = execute_insert_update(
        """INSERT INTO knowledge_points (chapter_id, name, description, learning_objectives, difficulty, estimated_minutes, sort_order, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)""",
        (req.chapter_id, req.name, req.description, req.learning_objectives,
         req.difficulty, req.estimated_minutes, req.sort_order, now, now),
    )
    logger.info(f"用户 {user['username']} 创建知识点: {req.name} (id={kp_id})")
    return {"message": f"知识点「{req.name}」创建成功", "kp_id": kp_id}


@router.put("/knowledge-points/{kp_id}", summary="更新知识点")
async def update_knowledge_point(kp_id: int, req: KnowledgePointUpdate, request: Request):
    """更新知识点信息（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    kp = execute_query_one("SELECT * FROM knowledge_points WHERE id=?", (kp_id,))
    if not kp:
        raise HTTPException(status_code=404, detail="知识点不存在")

    updates = {}
    for field in ["name", "description", "learning_objectives", "difficulty", "estimated_minutes", "sort_order", "status"]:
        val = getattr(req, field, None)
        if val is not None:
            updates[field] = val

    if not updates:
        return {"message": "无更新内容"}

    now = _now()
    updates["updated_at"] = now
    set_clause = ", ".join(f"{k}=?" for k in updates)
    params = list(updates.values()) + [kp_id]
    execute_insert_update(
        f"UPDATE knowledge_points SET {set_clause} WHERE id=?", tuple(params),
    )
    logger.info(f"用户 {user['username']} 更新知识点 id={kp_id}")
    return {"message": "知识点更新成功"}


@router.delete("/knowledge-points/{kp_id}", summary="删除知识点（软删除）")
async def delete_knowledge_point(kp_id: int, request: Request):
    """删除知识点（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    kp = execute_query_one("SELECT * FROM knowledge_points WHERE id=?", (kp_id,))
    if not kp:
        raise HTTPException(status_code=404, detail="知识点不存在")

    now = _now()
    execute_insert_update(
        "UPDATE knowledge_points SET status='inactive', updated_at=? WHERE id=?", (now, kp_id),
    )
    logger.info(f"用户 {user['username']} 删除知识点 id={kp_id}")
    return {"message": "知识点已删除"}


# ═══════════════════════════════════════════════════════════
# 资源绑定
# ═══════════════════════════════════════════════════════════

@router.get("/knowledge-points/{kp_id}/resources", summary="获取知识点绑定的资源列表")
async def get_kp_resources(kp_id: int, request: Request):
    """获取指定知识点下绑定的所有资源"""
    get_current_user(request)
    kp = execute_query_one("SELECT id FROM knowledge_points WHERE id=?", (kp_id,))
    if not kp:
        raise HTTPException(status_code=404, detail="知识点不存在")

    bindings = execute_query(
        """SELECT cb.* FROM curriculum_bindings cb
           WHERE cb.knowledge_point_id=? ORDER BY cb.sort_order, cb.id""",
        (kp_id,),
    )
    resources = []
    for b in bindings:
        info = _get_resource_info(b["resource_type"], b["resource_id"])
        resources.append({
            "binding_id": b["id"],
            "knowledge_point_id": b["knowledge_point_id"],
            "resource_type": b["resource_type"],
            "resource_id": b["resource_id"],
            "resource_name": info["name"],
            "resource_url": info["url"],
            "sort_order": b["sort_order"],
            "created_at": b["created_at"],
        })
    return {"resources": resources, "total": len(resources)}


@router.post("/bindings", summary="绑定资源到知识点")
async def create_binding(req: BindingCreate, request: Request):
    """将已有资源绑定到知识点（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    # 校验知识点存在
    kp = execute_query_one("SELECT id FROM knowledge_points WHERE id=?", (req.knowledge_point_id,))
    if not kp:
        raise HTTPException(status_code=404, detail="知识点不存在")

    valid_types = {"html", "download", "exam", "discussion", "interaction_quiz", "task"}
    if req.resource_type not in valid_types:
        raise HTTPException(status_code=400, detail=f"无效的资源类型，可选: {', '.join(sorted(valid_types))}")

    # 校验资源所有权：教师只能绑定自己的资源
    username = user["username"]
    ownership_ok = _check_resource_ownership(req.resource_type, req.resource_id, username)
    if not ownership_ok:
        logger.warning(f"用户 {username} 尝试绑定非自己的资源 {req.resource_type}:{req.resource_id}")
        raise HTTPException(status_code=403, detail="只能绑定自己的资源")

    # 检查是否已绑定
    existing = execute_query_one(
        "SELECT id FROM curriculum_bindings WHERE knowledge_point_id=? AND resource_type=? AND resource_id=?",
        (req.knowledge_point_id, req.resource_type, req.resource_id),
    )
    if existing:
        raise HTTPException(status_code=409, detail="该资源已绑定到此知识点")

    now = _now()
    binding_id = execute_insert_update(
        """INSERT INTO curriculum_bindings (knowledge_point_id, resource_type, resource_id, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (req.knowledge_point_id, req.resource_type, req.resource_id, req.sort_order, now),
    )
    logger.info(f"用户 {user['username']} 绑定资源 {req.resource_type}:{req.resource_id} 到知识点 {req.knowledge_point_id}")
    return {"message": "资源绑定成功", "binding_id": binding_id}


@router.delete("/bindings/{binding_id}", summary="解绑资源")
async def delete_binding(binding_id: int, request: Request):
    """从知识点解绑资源（教师/管理员）"""
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    binding = execute_query_one("SELECT * FROM curriculum_bindings WHERE id=?", (binding_id,))
    if not binding:
        raise HTTPException(status_code=404, detail="绑定记录不存在")

    execute_insert_update("DELETE FROM curriculum_bindings WHERE id=?", (binding_id,))
    logger.info(f"用户 {user['username']} 解绑资源 binding_id={binding_id}")
    return {"message": "资源已解绑"}


@router.get("/bindings/available", summary="获取可绑定的候选资源")
async def get_available_resources(
    request: Request,
    resource_type: str = Query(..., description="资源类型"),
    keyword: str = Query("", description="搜索关键词"),
    kp_id: int = Query(None, description="知识点 ID（排除已绑定的）"),
):
    """获取指定类型的可选资源列表（用于绑定界面选择，仅返回当前教师自己的资源）"""
    user = get_current_user(request)
    username = user["username"]

    valid_types = {"html", "download", "exam", "discussion", "interaction_quiz", "task"}
    if resource_type not in valid_types:
        raise HTTPException(status_code=400, detail=f"无效的资源类型")

    results = []

    try:
        if resource_type == "html":
            sql = "SELECT id, file_name as name FROM shared_resources WHERE resource_type='html' AND owner_username=?"
            params = [username]
            if keyword:
                sql += " AND file_name LIKE ?"
                params.append(f"%{keyword}%")
            sql += " ORDER BY id DESC LIMIT 200"
            results = execute_query(sql, tuple(params))

        elif resource_type == "download":
            sql = "SELECT id, file_name as name FROM shared_resources WHERE resource_type='download' AND owner_username=?"
            params = [username]
            if keyword:
                sql += " AND file_name LIKE ?"
                params.append(f"%{keyword}%")
            sql += " ORDER BY id DESC LIMIT 200"
            results = execute_query(sql, tuple(params))

        elif resource_type == "exam":
            sql = "SELECT id, title as name FROM exams WHERE status='published' AND creator_username=?"
            params = [username]
            if keyword:
                sql += " AND title LIKE ?"
                params.append(f"%{keyword}%")
            sql += " ORDER BY id DESC LIMIT 200"
            results = q_execute_query(sql, tuple(params))

        elif resource_type == "discussion":
            sql = "SELECT id, title as name FROM discussions WHERE (status='pending' OR status='active') AND creator_username=?"
            params = [username]
            if keyword:
                sql += " AND title LIKE ?"
                params.append(f"%{keyword}%")
            sql += " ORDER BY id DESC LIMIT 200"
            results = execute_query(sql, tuple(params))

        elif resource_type == "interaction_quiz":
            sql = "SELECT id, title as name FROM interaction_quizzes WHERE status='active' AND creator_username=?"
            params = [username]
            if keyword:
                sql += " AND title LIKE ?"
                params.append(f"%{keyword}%")
            sql += " ORDER BY id DESC LIMIT 200"
            results = execute_query(sql, tuple(params))

        elif resource_type == "task":
            sql = "SELECT id, name FROM tasks WHERE status='active' AND creator_username=?"
            params = [username]
            if keyword:
                sql += " AND name LIKE ?"
                params.append(f"%{keyword}%")
            sql += " ORDER BY id DESC LIMIT 200"
            results = execute_query(sql, tuple(params))
    except Exception as e:
        logger.warning(f"查询候选资源失败 (type={resource_type}): {e}")

    # 排除已绑定到该知识点的资源
    if kp_id and results:
        bound = execute_query(
            "SELECT resource_id FROM curriculum_bindings WHERE knowledge_point_id=? AND resource_type=?",
            (kp_id, resource_type),
        )
        bound_ids = set(r["resource_id"] for r in bound)
        results = [r for r in results if r["id"] not in bound_ids]

    return {"resources": results, "total": len(results)}


# ═══════════════════════════════════════════════════════════
# 节点排序（拖动）
# ═══════════════════════════════════════════════════════════

class ReorderItem(BaseModel):
    """排序项"""
    type: str  # "chapter" | "knowledge_point"
    id: int
    sort_order: int
    parent_id: int | None = None   # 章节新父级ID（None=顶层）
    chapter_id: int | None = None  # 知识点新所属章节ID

class ReorderRequest(BaseModel):
    """拖动排序请求"""
    items: list[ReorderItem]

@router.put("/reorder", summary="拖动排序章节/知识点")
async def reorder_nodes(req: ReorderRequest, request: Request):
    """拖动树节点后批量更新 sort_order（教师/管理员）
    支持同级排序和跨层级拖动（改变 parent_id / chapter_id）
    """
    user = get_current_user(request)
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="权限不足")

    if not req.items:
        raise HTTPException(status_code=400, detail="排序列表为空")

    now = _now()
    updated = {"chapters": 0, "knowledge_points": 0}

    for item in req.items:
        if item.type == "chapter":
            if item.parent_id is not None:
                execute_insert_update(
                    "UPDATE chapters SET sort_order=?, parent_id=?, updated_at=? WHERE id=?",
                    (item.sort_order, item.parent_id if item.parent_id > 0 else None, now, item.id),
                )
            else:
                execute_insert_update(
                    "UPDATE chapters SET sort_order=?, updated_at=? WHERE id=?",
                    (item.sort_order, now, item.id),
                )
            updated["chapters"] += 1
        elif item.type == "knowledge_point":
            if item.chapter_id is not None:
                execute_insert_update(
                    "UPDATE knowledge_points SET sort_order=?, chapter_id=?, updated_at=? WHERE id=?",
                    (item.sort_order, item.chapter_id, now, item.id),
                )
            else:
                execute_insert_update(
                    "UPDATE knowledge_points SET sort_order=?, updated_at=? WHERE id=?",
                    (item.sort_order, now, item.id),
                )
            updated["knowledge_points"] += 1

    logger.info(f"用户 {user['username']} 拖动排序: {updated}")
    return {"message": "排序已更新", "updated": updated}


# ═══════════════════════════════════════════════════════════
# 学习进度
# ═══════════════════════════════════════════════════════════

@router.get("/progress", summary="学生查看自己的学习进度")
async def get_my_progress(request: Request):
    """获取当前学生的全部学习进度"""
    user = get_current_user(request)
    if user.get("role") != 2:
        raise HTTPException(status_code=403, detail="仅学生可查看学习进度")

    rows = execute_query(
        """SELECT lp.*, kp.name as knowledge_point_name, kp.chapter_id,
                  ch.name as chapter_name, ch.course_id,
                  c.name as course_name
           FROM learning_progress lp
           JOIN knowledge_points kp ON kp.id = lp.knowledge_point_id
           JOIN chapters ch ON ch.id = kp.chapter_id
           JOIN courses c ON c.id = ch.course_id
           WHERE lp.student_username=?
           ORDER BY lp.updated_at DESC""",
        (user["username"],),
    )
    return {"progress": rows, "total": len(rows)}


@router.put("/progress/{kp_id}", summary="更新知识点学习状态")
async def update_progress(kp_id: int, req: ProgressUpdate, request: Request):
    """学生更新单个知识点的学习状态"""
    user = get_current_user(request)
    if user.get("role") != 2:
        raise HTTPException(status_code=403, detail="仅学生可更新学习进度")

    if req.status not in ("not_started", "in_progress", "completed"):
        raise HTTPException(status_code=400, detail="无效的状态值")

    kp = execute_query_one("SELECT id FROM knowledge_points WHERE id=?", (kp_id,))
    if not kp:
        raise HTTPException(status_code=404, detail="知识点不存在")

    now = _now()
    existing = execute_query_one(
        "SELECT id FROM learning_progress WHERE student_username=? AND knowledge_point_id=?",
        (user["username"], kp_id),
    )

    if existing:
        completed_at = now if req.status == "completed" else None
        if req.score is not None:
            execute_insert_update(
                "UPDATE learning_progress SET status=?, score=?, completed_at=?, updated_at=? WHERE id=?",
                (req.status, req.score, completed_at, now, existing["id"]),
            )
        else:
            execute_insert_update(
                "UPDATE learning_progress SET status=?, completed_at=?, updated_at=? WHERE id=?",
                (req.status, completed_at, now, existing["id"]),
            )
    else:
        completed_at = now if req.status == "completed" else None
        score = req.score or 0
        execute_insert_update(
            """INSERT INTO learning_progress (student_username, knowledge_point_id, status, score, completed_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (user["username"], kp_id, req.status, score, completed_at, now),
        )

    return {"message": "学习进度已更新"}


@router.get("/progress/stats", summary="课程维度进度统计")
async def get_progress_stats(request: Request, course_id: int = Query(None)):
    """获取当前学生在各课程上的进度统计"""
    user = get_current_user(request)
    if user.get("role") != 2:
        raise HTTPException(status_code=403, detail="仅学生可查看")

    if course_id:
        # 统计指定课程
        kp_rows = execute_query(
            """SELECT kp.id FROM knowledge_points kp
               JOIN chapters ch ON ch.id = kp.chapter_id
               WHERE ch.course_id=? AND kp.status='active'""",
            (course_id,),
        )
        total = len(kp_rows)
        kp_ids = [r["id"] for r in kp_rows]
        if kp_ids:
            placeholders = ",".join("?" for _ in kp_ids)
            completed = execute_query(
                f"SELECT COUNT(*) as cnt FROM learning_progress WHERE student_username=? AND knowledge_point_id IN ({placeholders}) AND status='completed'",
                (user["username"], *kp_ids),
            )
            done = completed[0]["cnt"] if completed else 0
        else:
            done = 0
        return {"course_id": course_id, "total": total, "completed": done, "rate": round(done / total * 100, 1) if total else 0}
    else:
        # 统计所有课程
        courses = execute_query("SELECT id, name FROM courses WHERE status='active'")
        stats = []
        for c in courses:
            kp_rows = execute_query(
                """SELECT kp.id FROM knowledge_points kp
                   JOIN chapters ch ON ch.id = kp.chapter_id
                   WHERE ch.course_id=? AND kp.status='active'""",
                (c["id"],),
            )
            total = len(kp_rows)
            if total == 0:
                continue
            kp_ids = [r["id"] for r in kp_rows]
            placeholders = ",".join("?" for _ in kp_ids)
            completed = execute_query(
                f"SELECT COUNT(*) as cnt FROM learning_progress WHERE student_username=? AND knowledge_point_id IN ({placeholders}) AND status='completed'",
                (user["username"], *kp_ids),
            )
            done = completed[0]["cnt"] if completed else 0
            stats.append({
                "course_id": c["id"],
                "course_name": c["name"],
                "total": total,
                "completed": done,
                "rate": round(done / total * 100, 1),
            })
        return {"stats": stats}


@router.get("/progress/overview", summary="班级进度总览（教师用）")
async def get_class_progress_overview(
    request: Request,
    course_id: int = Query(None, description="课程 ID"),
    grade: str = Query(None, description="年级"),
    class_name: str = Query(None, description="班级"),
):
    """教师查看指定班级的课程完成进度概览"""
    user = get_current_user(request)
    role = user.get("role", 2)
    if role not in (0, 1):
        raise HTTPException(status_code=403, detail="权限不足")

    username = user["username"]

    # 构建学生查询条件
    conditions = ["role=2"]
    params = []

    # 教师只能查看自己班级的学生
    if role == 1:
        teacher_info = execute_query_one(
            "SELECT grade, class FROM users WHERE username=?", (username,)
        )
        if teacher_info and teacher_info.get("grade"):
            teacher_grades = [g.strip() for g in teacher_info["grade"].split("|") if g.strip()]
            raw_classes = (teacher_info.get("class") or "").strip()
            grade_conditions = []
            for g in teacher_grades:
                grade_conditions.append("grade=?")
                params.append(g)
            if grade_conditions:
                conditions.append(f"({' OR '.join(grade_conditions)})")
            if raw_classes:
                class_groups = [c.strip() for c in raw_classes.split("|") if c.strip()]
                class_conditions = []
                for cg in class_groups:
                    for cls_val in cg.split(","):
                        cls_val = cls_val.strip()
                        if cls_val:
                            class_conditions.append("class=?")
                            params.append(cls_val)
                if class_conditions:
                    conditions.append(f"({' OR '.join(class_conditions)})")

    # 用户选择的额外筛选条件（对管理员直接应用，对教师则在教师权限基础上进一步缩小范围）
    if grade:
        conditions.append("grade=?")
        params.append(grade)
    if class_name:
        conditions.append("class=?")
        params.append(class_name)

    where = " AND ".join(conditions)
    students = execute_query(
        f"SELECT username, name, grade, class FROM users WHERE {where} ORDER BY grade, class, name",
        tuple(params),
    )

    if not students:
        return {"students": [], "total": 0}

    # 确定课程
    if course_id:
        courses_list = [{"id": course_id}]
    else:
        courses_list = execute_query("SELECT id, name FROM courses WHERE status='active'")

    # 构建知识点 ID 列表
    kp_map = {}  # course_id -> [(kp_id, kp_name)]
    for c in courses_list:
        kps = execute_query(
            """SELECT kp.id, kp.name FROM knowledge_points kp
               JOIN chapters ch ON ch.id = kp.chapter_id
               WHERE ch.course_id=? AND kp.status='active'
               ORDER BY kp.sort_order, kp.id""",
            (c["id"],),
        )
        if kps:
            kp_map[c["id"]] = kps

    # 构建每位学生的进度矩阵
    result = []
    for stu in students:
        stu_progress = {
            "username": stu["username"],
            "name": stu["name"],
            "grade": stu["grade"],
            "class": stu["class"],
            "courses": [],
        }
        for c in courses_list:
            kps = kp_map.get(c["id"], [])
            if not kps:
                continue
            kp_ids = [k["id"] for k in kps]
            placeholders = ",".join("?" for _ in kp_ids)
            progress_rows = execute_query(
                f"SELECT knowledge_point_id, status FROM learning_progress WHERE student_username=? AND knowledge_point_id IN ({placeholders})",
                (stu["username"], *kp_ids),
            )
            p_map = {r["knowledge_point_id"]: r["status"] for r in progress_rows}
            completed = sum(1 for kp_id in kp_ids if p_map.get(kp_id) == "completed")
            stu_progress["courses"].append({
                "course_id": c["id"],
                "total_kps": len(kps),
                "completed_kps": completed,
                "rate": round(completed / len(kps) * 100, 1) if kps else 0,
                "details": [
                    {"kp_id": k["id"], "kp_name": k["name"], "status": p_map.get(k["id"], "not_started")}
                    for k in kps
                ],
            })
        result.append(stu_progress)

    return {"students": result, "total": len(result)}


# ═══════════════════════════════════════════════════════════
# 辅助：获取单个行（复用 execute_query_one 不存在的情况）
# ═══════════════════════════════════════════════════════════

def execute_query_one(sql: str, params: tuple = ()):
    """执行查询并返回单条结果"""
    rows = execute_query(sql, params)
    return rows[0] if rows else None


# ═══════════════════════════════════════════════════════════
# V3.1 新增：AI 备课助手
# ═══════════════════════════════════════════════════════════

@router.get("/ai-lesson-plan")
async def ai_lesson_plan(
    request: Request,
    knowledge_point_id: int = Query(..., description="知识点 ID"),
):
    """AI 备课助手：根据知识点生成完整教案"""
    user = get_current_user(request)
    username = user["username"]
    role = user.get("role", 2)

    if role == 2:
        raise HTTPException(status_code=403, detail="仅教师和管理员可使用备课助手")

    # 获取知识点信息
    kp_rows = execute_query(
        """SELECT kp.id, kp.name, kp.chapter_id, c.name as chapter_name,
                  co.name as course_name, co.grade
           FROM knowledge_points kp
           JOIN chapters c ON c.id = kp.chapter_id
           JOIN courses co ON co.id = c.course_id
           WHERE kp.id = ?""",
        (knowledge_point_id,),
    )
    if not kp_rows:
        raise HTTPException(status_code=404, detail="知识点不存在")
    kp = kp_rows[0]

    from backend.prompts.teaching import LESSON_PLAN_PROMPT
    from backend.api.chat_router import get_api_keys
    from backend.api.ai_service import call_ai_sync

    keys = get_api_keys(username)
    api_key = keys.get("dashscope_key") or keys.get("deepseek_key") or ""
    if not api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请在系统配置中设置")

    def _safe(s):
        return str(s).replace('{', '{{').replace('}', '}}')

    prompt = LESSON_PLAN_PROMPT.format(
        course_name=_safe(kp["course_name"]),
        chapter_name=_safe(kp["chapter_name"]),
        knowledge_point=_safe(kp["name"]),
        grade=_safe(kp.get("grade", "")),
    )

    try:
        lesson_plan = call_ai_sync(prompt, api_key)
        return {
            "knowledge_point": kp["name"],
            "chapter_name": kp["chapter_name"],
            "course_name": kp["course_name"],
            "lesson_plan": lesson_plan,
        }
    except Exception as e:
        logger.error(f"AI 备课助手生成失败: {e}")
        raise HTTPException(status_code=500, detail=f"教案生成失败: {str(e)}")
