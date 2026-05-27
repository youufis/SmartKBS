"""
智能点名 · 公平版 API 路由（重构版）
从 backend/smart_rollcall_api.py 迁移，保持功能完全一致
"""
from fastapi import APIRouter

from backend.smart_rollcall_api import (
    # ── 原有 API 处理函数（保持原有逻辑）──
    api_grades,
    api_classes,
    api_students,
    api_pick,
    api_mark,
    api_history,
    api_reset,
    api_save_record,
)

router = APIRouter()

# ── 从原 module-level 函数直接注册 ──

router.get("/grades", summary="获取年级列表")(api_grades)
router.get("/classes", summary="获取班级列表")(api_classes)
router.get("/students", summary="获取学生列表（含积分）")(api_students)
router.post("/pick", summary="公平点名选取")(api_pick)
router.post("/mark", summary="标记点名结果")(api_mark)
router.get("/history", summary="获取点名历史")(api_history)
router.post("/reset", summary="重置点名数据")(api_reset)
router.post("/save-record", summary="保存答题记录到 ChatHistory")(api_save_record)
