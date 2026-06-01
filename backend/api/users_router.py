"""
用户管理 API 路由
注册 / 更新 / 改密 / 删除 / 查询 / 导入 / 批量删除
"""
import asyncio
import csv
import io
import json
import os
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend.database import execute_query, execute_insert_update, execute_batch, get_transaction
from backend.auth import (
    hash_password,
    is_admin,
    is_teacher,
    can_manage_users,
    can_manage_html_files,
    can_import_users,
)
from backend.api.dependencies import get_current_user
from backend.config import STU_DIR, ROOT_DIR, BASE_DIR
from backend.logger import logger

router = APIRouter()


# ── 数据模型 ──

class RegisterRequest(BaseModel):
    username: str
    password: str
    class_val: Optional[str] = ""
    name: Optional[str] = ""
    gender: Optional[int] = 0
    role: Optional[int] = 2  # 默认普通用户
    grade: Optional[str] = ""  # 年级：高一/高二


class UpdateUserRequest(BaseModel):
    username: str
    class_val: Optional[str] = ""
    name: Optional[str] = ""
    gender: Optional[int] = 0
    grade: Optional[str] = ""



class ChangePasswordRequest(BaseModel):
    username: str
    new_password: str


class BulkDeleteRequest(BaseModel):
    pattern: str


# ── 辅助函数 ──

def _standardize_gender(gender_value) -> int:
    """标准化性别值"""
    if gender_value is None:
        return 0
    g = str(gender_value).strip()
    if g in ("1", "M", "m", "男"):
        return 1
    return 0


def _standardize_role(role_value) -> int:
    """标准化角色值"""
    if role_value is None:
        return 2
    r = str(role_value).strip()
    if r in ("0", "admin", "管理员"):
        return 0
    if r in ("1", "teacher", "教师"):
        return 1
    return 2


# ── 彻底删除用户（数据库 + 文件系统） ──

def _delete_user_completely(username: str):
    """
    彻底删除用户的所有相关数据：
    1. 删除用户文件目录（stu/<username> 或 <username>）
    2. 删除数据库中所有与该用户相关的记录
    """
    # 1. 删除用户文件目录
    user_dir = os.path.join(BASE_DIR, STU_DIR, username)
    alt_dir = os.path.join(BASE_DIR, username)
    for d in [user_dir, alt_dir]:
        if os.path.isdir(d):
            try:
                shutil.rmtree(d)
                logger.info(f"已删除用户目录: {d}")
            except Exception as e:
                logger.warning(f"删除用户目录失败 {d}: {e}")

    # 2. 删除数据库中所有与该用户相关的记录（使用事务）
    delete_ops = [
        # 以 username 为直接标识的表
        ("DELETE FROM daily_usage WHERE username=?", (username,)),
        ("DELETE FROM conversations WHERE username=?", (username,)),
        ("DELETE FROM notifications WHERE recipient_username=?", (username,)),
        ("DELETE FROM discussion_members WHERE username=?", (username,)),
        ("DELETE FROM discussion_messages WHERE username=?", (username,)),
        ("DELETE FROM interaction_quiz_answers WHERE student_username=?", (username,)),
        ("DELETE FROM interaction_poll_votes WHERE student_username=?", (username,)),
        ("DELETE FROM interaction_questions WHERE student_username=?", (username,)),
        ("DELETE FROM learning_progress WHERE student_username=?", (username,)),
        ("DELETE FROM task_submissions WHERE student_username=?", (username,)),
        # 以 username 为创建者/拥有者的表
        ("DELETE FROM shared_resources WHERE owner_username=?", (username,)),
        ("DELETE FROM tasks WHERE creator_username=?", (username,)),
        ("DELETE FROM announcements WHERE creator_username=?", (username,)),
        ("DELETE FROM interaction_quizzes WHERE creator_username=?", (username,)),
        ("DELETE FROM interaction_polls WHERE creator_username=?", (username,)),
        ("DELETE FROM discussions WHERE creator_username=?", (username,)),
        # 教师相关数据（积分、点名等）
        ("DELETE FROM scores WHERE teacher_username=?", (username,)),
        ("DELETE FROM rollcall_weights WHERE teacher_username=?", (username,)),
        ("DELETE FROM rollcall_meta WHERE teacher_username=?", (username,)),
        ("DELETE FROM rollcall_history WHERE teacher_username=?", (username,)),
        # 最后删除用户本身
        ("DELETE FROM users WHERE username=?", (username,)),
    ]
    execute_batch(delete_ops)
    logger.info(f"用户 '{username}' 的所有数据库记录已清除")


# ── API 端点 ──

@router.post("/register")
async def register_user(req: RegisterRequest, request: Request):
    """注册新用户（仅管理员）"""
    current_user = get_current_user(request)
    if not can_manage_users(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员可以注册用户")

    username = req.username.strip()
    password = req.password.strip()

    if not username or not password:
        raise HTTPException(status_code=400, detail="用户名和密码不能为空")

    # 检查用户是否已存在
    existing = execute_query("SELECT username FROM users WHERE username=?", (username,))
    if existing:
        raise HTTPException(status_code=400, detail=f"用户 '{username}' 已存在")

    hashed = hash_password(password)
    gender_num = _standardize_gender(req.gender)
    role_num = _standardize_role(req.role)

    try:
        execute_insert_update(
            "INSERT INTO users (username, password, class, name, gender, role, grade) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (username, hashed, req.class_val, req.name, gender_num, role_num, req.grade or ""),
        )
        logger.info(f"用户注册成功: {username}")
        return {"message": f"用户 '{username}' 注册成功"}
    except Exception as e:
        logger.error(f"用户注册失败: {e}")
        raise HTTPException(status_code=500, detail=f"注册失败: {str(e)}")


@router.put("/update")
async def update_user_info(req: UpdateUserRequest, request: Request):
    """更新用户信息（仅管理员）"""
    current_user = get_current_user(request)
    if not can_manage_users(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员可以更新用户信息")

    username = req.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="用户名不能为空")

    existing = execute_query("SELECT username FROM users WHERE username=?", (username,))
    if not existing:
        raise HTTPException(status_code=404, detail=f"用户 '{username}' 不存在")

    gender_num = _standardize_gender(req.gender)

    try:
        execute_insert_update(
            "UPDATE users SET class=?, name=?, gender=?, grade=? WHERE username=?",
            (req.class_val, req.name, gender_num, req.grade or "", username),
        )
        logger.info(f"用户信息已更新: {username}")
        return {"message": f"用户 '{username}' 信息已更新"}
    except Exception as e:
        logger.error(f"更新用户信息失败: {e}")
        raise HTTPException(status_code=500, detail=f"更新失败: {str(e)}")


@router.put("/password")
async def change_password(req: ChangePasswordRequest, request: Request):
    """修改密码（管理员可改任何用户，普通用户仅改自己）"""
    current_user = get_current_user(request)
    current_username = current_user["username"]

    username = req.username.strip()
    new_password = req.new_password.strip()

    if not username or not new_password:
        raise HTTPException(status_code=400, detail="用户名和新密码不能为空")

    # 普通用户只能改自己的密码
    if current_username != "root" and username != current_username:
        raise HTTPException(status_code=403, detail="权限不足：只能修改自己的密码")

    hashed = hash_password(new_password)

    try:
        execute_insert_update(
            "UPDATE users SET password=? WHERE username=?",
            (hashed, username),
        )
        logger.info(f"密码已修改: {username}")
        return {"message": f"用户 '{username}' 密码已修改"}
    except Exception as e:
        logger.error(f"修改密码失败: {e}")
        raise HTTPException(status_code=500, detail=f"修改密码失败: {str(e)}")


@router.delete("/{username}")
async def delete_user(username: str, request: Request):
    """彻底删除用户及其所有相关数据（仅管理员）"""
    current_user = get_current_user(request)
    if not can_manage_users(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员可以删除用户")

    # 检查用户是否存在并获取角色
    rows = execute_query("SELECT username, role FROM users WHERE username=?", (username,))
    if not rows:
        raise HTTPException(status_code=404, detail=f"用户 '{username}' 不存在")

    user_role = rows[0][1]

    # 禁止删除任何管理员账号（role=0）
    if user_role == 0:
        raise HTTPException(status_code=400, detail="不能删除管理员账号")

    try:
        _delete_user_completely(username)
        logger.info(f"用户已彻底删除: {username}")
        return {"message": f"用户 '{username}' 已彻底删除"}
    except Exception as e:
        logger.error(f"删除用户失败: {e}")
        raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")


@router.get("/{username}")
async def get_user_info(username: str, request: Request):
    """查询用户信息"""
    current_user = get_current_user(request)

    rows = execute_query(
        "SELECT username, class, name, gender, role, grade FROM users WHERE username=?",
        (username,),
    )
    if not rows:
        raise HTTPException(status_code=404, detail=f"用户 '{username}' 不存在")

    username, class_val, name_val, gender_val, role_val, grade_val = rows[0]
    role_name = {0: "管理员", 1: "教师", 2: "普通用户"}.get(role_val, "普通用户")
    gender_name = "男" if gender_val == 1 else "女" if gender_val == 0 else ""

    return {
        "username": username,
        "class": class_val,
        "name": name_val,
        "gender": gender_name,
        "role": role_val,
        "role_name": role_name,
        "grade": grade_val or "",
    }


@router.get("")
async def get_all_users(request: Request, keyword: Optional[str] = None):
    """查看所有用户，支持按用户名/姓名模糊搜索"""
    get_current_user(request)  # 只需登录

    if keyword and keyword.strip():
        kw = f"%{keyword.strip()}%"
        rows = execute_query(
            "SELECT username, class, name, gender, role, grade FROM users WHERE username LIKE ? OR name LIKE ? ORDER BY username",
            (kw, kw),
        )
    else:
        rows = execute_query(
            "SELECT username, class, name, gender, role, grade FROM users ORDER BY username"
        )
    users = []
    for username, class_val, name_val, gender_val, role_val, grade_val in rows:
        role_name = {0: "管理员", 1: "教师", 2: "普通用户"}.get(role_val, "普通用户")
        gender_name = "男" if gender_val == 1 else "女" if gender_val == 0 else ""
        users.append({
            "username": username,
            "class": class_val,
            "name": name_val,
            "gender": gender_name,
            "role": role_name,
            "grade": grade_val or "",
        })

    return {"users": users, "total": len(users)}


@router.post("/bulk-delete")
async def bulk_delete_users(req: BulkDeleteRequest, request: Request):
    """批量彻底删除用户（按用户名模式匹配，跳过管理员账号）"""
    current_user = get_current_user(request)
    if not can_manage_users(current_user["username"]):
        raise HTTPException(status_code=403, detail="权限不足：仅管理员可以批量删除")

    pattern = req.pattern.strip()
    if not pattern:
        raise HTTPException(status_code=400, detail="请提供要删除的用户名模式")

    try:
        # 先查出匹配的非管理员用户（用于返回列表）
        rows = execute_query(
            "SELECT username FROM users WHERE username LIKE ? AND role != 0",
            (f"%{pattern}%",),
        )
        deleted = [row[0] for row in rows]
        if not deleted:
            return {"message": "没有匹配的用户", "deleted": []}

        # 逐个彻底删除（每个用户清理数据库记录 + 文件目录）
        for username in deleted:
            _delete_user_completely(username)

        logger.info(f"批量删除用户: pattern={pattern}, count={len(deleted)}")
        return {"message": f"已删除 {len(deleted)} 个用户", "deleted": deleted}
    except Exception as e:
        logger.error(f"批量删除失败: {e}")
        raise HTTPException(status_code=500, detail=f"批量删除失败: {str(e)}")


@router.post("/import")
async def import_users(file: UploadFile = File(...), request: Request = None):
    """CSV 批量导入用户（流式进度返回）"""
    if request:
        current_user = get_current_user(request)
        if not can_import_users(current_user["username"]):
            raise HTTPException(status_code=403, detail="权限不足：仅管理员或教师可以导入用户")

    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="请上传 CSV 文件")

    content = await file.read()

    # 尝试多种编码
    content_str = None
    for encoding in ["utf-8-sig", "utf-8", "gbk", "gb2312"]:
        try:
            content_str = content.decode(encoding)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if content_str is None:
        raise HTTPException(status_code=400, detail="无法解析 CSV 文件编码")

    reader = csv.DictReader(io.StringIO(content_str))
    rows = list(reader)
    total = len(rows)

    async def event_generator():
        imported = 0
        errors = []

        # 发送开始事件
        yield f"data: {json.dumps({'type': 'start', 'total': total}, ensure_ascii=False)}\n\n"

        # 在单一事务中执行所有数据库操作，避免逐条连接/提交的开销
        with get_transaction() as conn:
            cursor = conn.cursor()

            for row_num, row in enumerate(rows, start=2):
                try:
                    username = row.get("username", "").strip()
                    password = row.get("password", "").strip()
                    if not username or not password:
                        errors.append(f"第{row_num}行：用户名或密码为空")
                        await asyncio.sleep(0)
                        continue

                    # 检查是否已存在（同一连接，无额外开销）
                    cursor.execute(
                        "SELECT username FROM users WHERE username=?", (username,)
                    )
                    if cursor.fetchone():
                        errors.append(f"第{row_num}行：用户 '{username}' 已存在，跳过")
                        await asyncio.sleep(0)
                        continue

                    hashed = hash_password(password)
                    class_val = row.get("class", "").strip()
                    name_val = row.get("name", "").strip()
                    gender_val = _standardize_gender(row.get("gender", "0"))
                    role_val = _standardize_role(row.get("role", "2"))
                    grade_val = row.get("grade", "").strip()

                    cursor.execute(
                        "INSERT INTO users (username, password, class, name, gender, role, grade) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (username, hashed, class_val, name_val, gender_val, role_val, grade_val),
                    )
                    imported += 1
                except Exception as e:
                    errors.append(f"第{row_num}行：{str(e)}")

                # 每处理一行发送一次进度
                progress_data = {
                    'type': 'progress',
                    'current': row_num - 1,
                    'total': total,
                    'imported': imported,
                    'error_count': len(errors),
                    'percent': round((row_num - 1) / total * 100, 1),
                }
                yield f"data: {json.dumps(progress_data, ensure_ascii=False)}\n\n"

        # 事务在此自动提交，所有插入一次性写入磁盘

        # 发送完成事件
        logger.info(f"批量导入用户: imported={imported}, errors={len(errors)}")
        done_msg = f"成功导入 {imported} 个用户，{len(errors)} 个错误"
        done_data = {
            'type': 'done',
            'imported': imported,
            'error_count': len(errors),
            'errors': errors[:50],
            'message': done_msg,
        }
        yield f"data: {json.dumps(done_data, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/import/template")
async def download_import_template():
    """下载用户导入 CSV 模板"""
    import tempfile

    csv_content = "username,password,class,name,gender,role,grade\n"
    csv_content += "s11001,123456,1,张三,男,2,高一\n"
    csv_content += "s11002,123456,1,李四,女,2,高一\n"
    csv_content += "t001,123456,\"1,2,3,4|1,2,7,8\",王老师,男,1,高一|高二\n"

    # 创建临时文件
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".csv", mode="w", encoding="utf-8-sig")
    tmp.write(csv_content)
    tmp.close()

    return FileResponse(
        tmp.name,
        media_type="text/csv",
        filename="user_import_template.csv",
    )
