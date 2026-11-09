"""
系统配置管理 API
允许管理员在 UI 中集中管理系统常量（API Key、模型参数等）
配置存储于 STORAGE_DIR/system_config.json：
  · Web/源码部署 → <项目根>/system_config.json
  · 桌面版       → %APPDATA%/smartkbs-desktop/system_config.json
（v9.0.0 及更早存在 <项目根>/backend/system_config.json，升级时由 data_migration 搬过去）
"""
import json
import glob
import os
import re
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from backend.api.dependencies import get_current_user, require_admin
from backend.config import BASE_DIR, STORAGE_DIR
from backend.logger import logger
# 模型默认值只认 model_catalog 一份。以前这四行是手写字面量（注释还写着"由 model_catalog 维护"），
# 改清单默认模型时这里不会跟着变，升级后配置缺键就补出旧模型名 —— 正是 404 的来源。
from backend.model_catalog import (
    DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_LONG_MODEL, DEFAULT_VL_MODEL,
)
# 语音模型/音色同样只有一份清单（tts_voices），配置默认值跟着它走
from backend.tts_voices import DEFAULT_MODEL as TTS_DEFAULT_MODEL, DEFAULT_VOICE as TTS_DEFAULT_VOICE

router = APIRouter()

# ── 配置文件路径 ──
# 放在 STORAGE_DIR：Web 版 == 项目根（与历史一致）；桌面版 == %APPDATA%\<app>，
# 不再随安装目录被覆盖，API Key 等配置升级后仍在
STORAGE_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_FILE = STORAGE_DIR / "system_config.json"


def _backup_file() -> Path:
    """C1: 上一次成功保存的副本路径（随 CONFIG_FILE 动态派生，便于测试与迁移）"""
    return CONFIG_FILE.with_name(CONFIG_FILE.name + ".bak")


_SECRET_KEYS = ("dashscope_api_key", "APPID")                          # C3: 不回显明文
_MASK_PREFIX = "****"

# ── 默认配置（与 config.py 保持一致） ──
DEFAULT_CONFIG: dict[str, Any] = {
    # 品牌信息（AGENT_NAME 由 "智慧教学平台-" + AGENT_EDITION 自动拼接，不再单独保存）
    "AGENT_EDITION": "通用版",
    "ORG_NAME": "",
    # API 密钥（全局兜底）
    "dashscope_api_key": "",
    # 模型与应用配置
    "APPID": "",  # 留空则直接调用大模型(MODEL_NAME)；填写后调用百炼智能体应用。注意：APPID 必须与 DASHSCOPE_API_KEY 归属于同一个阿里云账号，否则无法调用
    "AGENT_ENABLED": False,  # 智能体启用闸门：勾选且 APPID 已填才走智能体；默认关，需显式开启（知识库就绪时优先走知识库，不受此项影响）
    "QWEN_OPENAI_API_BASE": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    # ── 文件提交类作业（上传 + AI 批改）──
    "HOMEWORK_MAX_FILE_MB": 10,        # 单文件上限，同时是教师可设值的天花板
    "HOMEWORK_MAX_FILES": 3,           # 一次提交最多几个文件（教师未按作业设时）
    "HOMEWORK_ENABLE_VL": True,        # 图片作业的多模态预解读（聊天侧已无多模态开关，这里保持独立）
    "HOMEWORK_ALLOWED_EXTS": [".docx", ".pdf", ".txt", ".md", ".xlsx", ".pptx",
                              ".jpg", ".jpeg", ".png", ".webp", ".bmp"],
    # ── 错题本：自动错题巩固练习（判定逻辑见 wrong_book_router.wrong_practice_policy）──
    "wrong_practice_threshold": 30,      # 待掌握错题超过这个数才自动布置
    "wrong_practice_per_set": 5,         # 每组抽几道题
    "wrong_practice_interval_days": 7,   # 两组之间的间隔天数，也是"未作答会话"的挡路时限
    "wrong_practice_avoid_recent_sets": 3,  # 抽题时避开最近几组出过的题（0=不排除）
  "wrong_book_sources": ["exam", "practice"],  # 错题本接入哪些活动（exam 固定接入不可关；其余见 wrong_book_router.WRONG_BOOK_SOURCE_LABELS）
    "MODEL_LONG_NAME": DEFAULT_LONG_MODEL,
    "MODEL_VL_NAME": DEFAULT_VL_MODEL,
    "MODEL_NAME": DEFAULT_CHAT_MODEL,
    # 图像理解走哪个模型：默认用对话模型看图（快、省），解题类仍交视觉模型
    "MODEL_IMAGE_VIA_CHAT": True,
    "MODEL_IMAGE_SOLVE_VL": True,
    # 文件大小限制
    "MAX_DOC_SIZE_MB": 10,
    "MAX_IMAGE_SIZE_MB": 5,
    # JWT
    "JWT_EXPIRATION_HOURS": 24,
    # 令牌滑动续期阈值（分钟）：剩余有效期低于该值时，随响应头 X-Renew-Token 下发新令牌。
    # 0 = 自动（有效期的一半，最多 6 小时）。治"页面开着不动，几小时后全线 401"。
    "JWT_RENEW_THRESHOLD_MINUTES": 0,
    # 在线用户超时
    "ONLINE_USER_TIMEOUT_SECONDS": 1800,
    # ── 来源 IP 防护（backend/security_guard.py，内存态，重启即清）──
    # 默认关闭：套了花生壳/NAT 穿透时，所有远程访客共用中继出口 IP，
    # 按 IP 封禁会"封一个连一片"。关掉只影响"封不封"，不影响失败审计（日志与快照照记）。
    "ENABLE_IP_GUARD": False,
    "TRUST_PROXY_HEADERS": False,           # 只有确实套了反代(Nginx/IIS)且它会覆写 XFF 时才开
    "AUTH_FAIL_WINDOW_SECONDS": 60,         # 鉴权失败统计窗口
    "AUTH_FAIL_LIMIT": 30,                  # 窗口内达到这个次数就封（挂机页面的 3 连发/30 秒 ≈ 6 次/分钟，不会误伤）
    "AUTH_FAIL_BAN_SECONDS": 600,           # 临时封禁时长，0 = 只记日志不封
    "LOGIN_FAIL_WINDOW_SECONDS": 600,       # 登录失败统计窗口（猜密码场景）
    "LOGIN_FAIL_LIMIT": 10,                 # 窗口内登录失败次数上限
    "IP_DENYLIST": [],                      # 永久拒绝的来源：精确 IP / 前缀(14.112.) / 网段(14.112.131.0/24)
    # ── 登录闸门（升级维护用）：默认全部允许，管理员永不受任何一项影响 ──
    # 前两项按角色：开启后该类账号既不能新登录，已在登录中的会话也会被请回登录页
    # 第三项按来源：开启后只挡外网地址，内网与本机照常（判据见 security_guard.is_external_ip）
    "LOGIN_BLOCK_STUDENT": False,           # 暂停学生登录
    "LOGIN_BLOCK_TEACHER": False,           # 暂停教师登录
    "LOGIN_BLOCK_EXTERNAL": False,          # 暂停外网登录（内网/本机照常）
    # AI 对话权限（可多选角色：1=教师, 2=学生；管理员始终可用）
    "ENABLE_AI_CHAT_FOR_ROLES": [1, 2],
    # 请求限制
    "ENABLE_REQUEST_LIMIT": False,
    "MAX_ALLOWED_REQUESTS": 50,
    # 下载中心
    "TEACHER_DOWNLOAD_QUOTA_GB": 5,
    # 文件类型白名单
    "IMAGE_EXTENSIONS": ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp'],
    "DOCUMENT_EXTENSIONS": [
        '.txt', '.md', '.pdf', '.doc', '.docx',
        '.xls', '.xlsx', '.ppt', '.pptx', '.csv',
        '.json', '.html', '.htm',
    ],
    # 技能系统：生效技能列表。"*" = 全部启用（新装默认，技能增减自动跟随）；
    # 管理员显式保存子集或空列表后按那份列表来（空列表 = 全部关闭）。
    "enabled_skills": ["*"],
    # 场景×技能映射：{场景: {"exclude":[...], "include":[...]}}，未列出的场景行为不变
    "skill_scene_map": {
        # V8.6.1：对话链路只留"对话直答节奏 + 语言自适应 + 安全过滤 + 实例驱动"，
        # 三阶增强/分步推理/可视化表达留给出题、教案、报告这类生成物场景
        "chat": {"include": ["chat-conversation", "language-control", "safety-guard", "example-driven"]},
        "companion": {"include": ["chat-conversation", "language-control", "safety-guard", "socratic-tutor"]},
    },
    # 课程名称列表
    "SUBJECTS": ["人工智能"],
    # 启用的试题题型（可在此增删，前端自动同步）
    "QUESTION_TYPES": [
        {"key": "single", "label": "单选题"},
        {"key": "multiple", "label": "多选题"},
        {"key": "true_false", "label": "判断题"},
        {"key": "short", "label": "简答题"},
        {"key": "fill", "label": "填空题"},
        {"key": "essay", "label": "作文"},
        {"key": "subjective", "label": "主观题"},
    ],
    # 消息通知类型（默认启用考试/系统/作业/认可通知，管理员可在系统配置中调整）
    # task 必须默认开：文件作业「发布成绩」靠它通知学生，静默丢弃会让教师以为已推送
    # success 必须默认开：教师给学生「认可」加分走的就是这个类型，缺失时通知会被白名单吞掉
    "enabled_notification_types": ["exam", "system", "task", "success", "care"],
    # 图片生成（通义万相，与对话模型共享 API Key）
    "IMAGE_GEN_ENABLED": True,
    "IMAGE_GEN_MODEL": DEFAULT_IMAGE_MODEL,
    "IMAGE_GEN_SIZE": "auto",   # auto = 不传尺寸、用模型默认值；也可选按模型联动的具体档位
    "IMAGE_GEN_MAX_PLACEHOLDERS": 1,   # 单题默认只自动生成 1 张实拍配图，控住成本
    # ── 语音合成（backend/tts_service.py；两代模型见 backend/tts_voices.py）──
    # 总开关默认关：关掉时全线不产生任何计费请求，智能点名页的语音播报也一并停用。
    # 音色与模型必须配对（跨模型混用实测报 411），保存时有跨键校验、页面上换模型会带出
    # 对应音色清单，所以这两个默认值必须成对出现。
    "TTS_ENABLED": False,
    "TTS_MODEL": TTS_DEFAULT_MODEL,
    "TTS_VOICE": TTS_DEFAULT_VOICE,   # 新闻联播·男（权威播报）
    "TTS_SPEECH_RATE": 1.0,
    "TTS_VOLUME": 50,
    # ── AI 播客（backend/podcast_service.py）──
    # 双主播：A 主讲（默认男声）、B 互动（默认女声）。留空 = 按当前 TTS 模型自动各挑一条
    # 实测可用的音色（优先"讲解/旁白"风格）。两者必须与 TTS_MODEL 同模型，保存时校验。
    "PODCAST_VOICE_A": "",
    "PODCAST_VOICE_B": "",
    "PODCAST_DURATION_OPTIONS": "3,4,5",   # 弹窗可选时长档位（分钟）
    "PODCAST_MAX_SECONDS": 300,            # 硬上限（秒）：超了按上限截断，不产出超标页面
    # ── AI 讲演（backend/lesson_cast_service.py）──
    # 必须写在这里：部署机升级时 system_config.json 会保留旧文件，新键不存在，
    # 只有靠 load_config() 的 DEFAULT_CONFIG 合并才能让配置页显示出值。
    "CAST_DURATION_OPTIONS": "3,4,5",      # 讲演可选档位（分钟），与播客同值
    "CAST_DEFAULT_MINUTES": 5,             # 默认档位：讲演要讲完一个完整知识点，取 5 而不是播客的 3
    "CAST_MAX_SECONDS": 300,               # 硬上限（秒），超出按整页截断
    "CAST_MAX_PAGES": 10,                  # 页数上限，5 分钟约 9 页
    "CAST_TTS_CONCURRENCY": 6,             # 讲演 TTS 合成并发（1~12）；按账号 QPS 调整
    # ── 课堂抽问（backend/api/class_drill_router.py）──
    # 页面上的「AI 生题」开关是否可用：关掉后课堂抽问只从题库取题，不再调用大模型（零 AI 计费）。
    # 页面开关是当堂临时选择，这里是全校总闸；两者都开才走 AI。
    "CLASS_DRILL_AI_ENABLED": True,
    # ── 探索画布（backend/api/personal_canvas_router.py；方案 docs/explore-canvas/）──
    "EXPLORE_CANVAS_ENABLED": True,          # 总开关：关=整组接口 404，前端入口隐藏，数据原样保留
    "EXPLORE_CANVAS_MAX": 50,                # 每人未归档画布上限（0=不限），防无限建导致数据膨胀
    "EXPLORE_CHAT_QUOTA": 50,                # 单人单日 AI 问答上限（次）
    "EXPLORE_IMAGE_QUOTA": 10,               # 单人单日生图上限（张）
    "EXPLORE_TTS_QUOTA": 30,                 # 单人单日卡片朗读上限（次）
    "EXPLORE_ASR_ENABLED": False,            # 后端语音转文字兜底通道（M1 上线）
    "EXPLORE_ASR_MINUTES": 10,               # 后端语音识别每人每日分钟数（近似计量）
    "EXPLORE_ASR_MODEL": "qwen3-asr-flash",    # 转写模型（OpenAI 兼容通道直传 base64）
    "EXPLORE_CONTINUOUS_REMIND_MIN": 40,     # 连续使用提醒（分钟，仅前端计时不强退）
    "EXPLORE_ASSET_ORPHAN_DAYS": 30,         # 素材孤儿判定（天）：超期未引用 → 回收站
    # 台账口径：pc_ai_tasks.prompt_digest 默认只落不可逆哈希（"只计行为、不看内容"）。
    # 需要排查模型问题时临时打开，会存提问前 200 字——排查完记得关回去。
    "EXPLORE_LOG_RAW_PROMPT": False,
    "EXPLORE_ASSET_TRASH_DAYS": 14,          # 回收站保留（天），到期物理删除
    "EXPLORE_TMP_HOURS": 24,                 # 临时素材（如 ASR 录音）存活小时数
    "EXPLORE_CANVAS_TRASH_DAYS": 30,       # 回收站画布保留（天），到期连页面/历史一并销毁
    "EXPLORE_SHARE_EXPIRE_DAYS": 7,         # 学生分享给老师的只读快照保留（天），到期自动回收
    "EXPLORE_ASSET_MAX_MB": 1024,            # 素材目录水位（MB）；全在用则只告警不强删
    "EXPLORE_SWEEP_HOUR": 3,                 # 每日自动清理时段（凌晨低峰）
    "EXPLORE_TTS_CACHE_MB": 200,             # TTS 缓存水位（MB）：超限清最久未用，7 天内课堂产物豁免
    "EXPLORE_SWEEP_DRY": False,              # 打开=只出清单不删文件（排查用）；默认走真清理，孤儿进回收站保留 14 天可还原
    # ── 课堂闯关（backend/api/class_ladder_router.py）──
    # AI 生题总闸（关掉后只从题库取题，零 AI 计费）。
    "CLASS_LADDER_AI_ENABLED": True,
    # 大屏默认皮肤：cloud/sunrise/mint（浅色，默认 cloud）/ star/cyber/academy/classic（深色）
    "CLASS_LADDER_DEFAULT_SKIN": "cloud",
    # 大屏音效总闸（前端用 WebAudio 合成，零素材零成本）
    "CLASS_LADDER_SOUND_ENABLED": True,
    # 积分防刷：每日上限（0 = 不限制）
    # 按"分池"而非一刀切：学术 / 课堂参与 / 轻量娱乐各有额度，互不挤占。
    # 旧版只有一条总上限 60，抢答刷满 3 场就能吃掉大半，学生再认真考一场试，
    # 等级奖会被静默吞掉——防刷规则反过来惩罚认真学习的人。
    "REWARD_DAILY_CHAT_POINTS": 10,
    "REWARD_DAILY_QUIZ_SESSIONS": 3,
    "REWARD_DAILY_ACADEMIC_POINTS": 80,
    "REWARD_DAILY_CLASS_POINTS": 40,
    "REWARD_DAILY_FUN_POINTS": 30,
    "REWARD_DAILY_TOTAL_POINTS": 0,
    # 称号系统配置
    "ENABLE_BADGES": True,
    "ENABLE_SUBJECT_TITLES": True,
    # 闯关挑战出题模式：false=AI 出题（默认）, true=从题库出题
    "QUEST_USE_BANK": True,  # 闯关优先从题库取题(used_count 轮换)，题库取不到才调 AI 生成 —— 成本随题量而非人数增长；可在系统配置-激励与闯关改回
    # ── 荣耀殿堂（backend/showcase_auto.py + api/showcase_router.py）──
    # 自动建卡总闸：打开后无需教师操作，达到积分门槛的学生自动上墙。
    "SHOWCASE_AUTO_ENABLED": True,
    # 上墙门槛：默认 1 分（= 有积分才上墙，0 分完全不上墙）
    "SHOWCASE_MIN_POINTS": 1,
    # 自动巡检间隔（分钟）：兜住"学生积分从 0 变正"
    "SHOWCASE_AUTO_INTERVAL_MIN": 30,
    # 名次展示策略：all=都显示 / top30=本班前10或全校前30(默认) / top10=本班前3或全校前10 / none=都不显示
    "SHOWCASE_RANK_MODE": "top30",
    # ── 我的画像（backend/api/portrait_router.py）──
    # 总闸：关掉后画像页只读，任何人都不能再生成（零 AI 计费）。
    "PORTRAIT_ENABLED": True,
    # 周期：false=每周（默认）、true=每月。周期同时决定"免费额度"与"画像吃哪一段数据"。
    "PORTRAIT_PERIOD_MONTHLY": False,
    # 额外生成一次消耗的积分（每周期第 1 次免费）
    "PORTRAIT_EXTRA_POINTS": 100,
    # 学生每周期额外生成次数上限（不含免费那次）
    "PORTRAIT_EXTRA_MAX": 2,
    # 教师/管理员每周期生成上限，含那次免费（他们不参与积分体系，不设限等于开放免费生图接口）。
    # 2026-10-24：教职工首页也用上画像头像后按"一人一周期一张"收口，默认 2 -> 1。
    "PORTRAIT_STAFF_MAX": 1,
    # 每到新周期自动为上一周期有活动的学生生成一张（默认关：会自动消耗 AI 额度）
    "PORTRAIT_AUTO_PUSH": False,
    # 版本管理：后台检测到新提交时，是否自动快进同步运行代码。
    # 涉及数据库迁移或 requirements.txt 变更时不会自动同步，仍走人工升级。
    "auto_pull_enabled": True,
    # 升级前自动留底（配置 + 两个数据库）。默认关：每次升级都会复制一份完整的库，
    # 备份目录会长期堆积；关掉后升级仍会保留「配置守护快照」（防配置被 reset 打回默认值），
    # 只是不再产出 pre_upgrade_* 备份目录。需要留底的管理员可自行开启或手动点「立即备份」。
    "UPGRADE_AUTO_BACKUP": False,
    # AI 请求超时设置（秒）— 白板 AI 生成图示/板书等操作的超时时间
    "AI_REQUEST_TIMEOUT": 300,
    # ── AI 输出形态与解析（backend/api/curriculum_router.py / question_router.py）──
    # 这两项以前只在代码里读、配置页看不到（"隐键"）：网关不支持 json_object 时无处可关。
    "AI_JSON_OBJECT_MODE": False,          # 强制 response_format=json_object（个别网关不支持，失败会自动降级）
    "AI_STRICT_PARSE": True,               # 严格解析：不接受截断救回的残缺结果，并逐题做字段体检
    "IMAGE_EXTRACT_MAX_TOKENS": 8000,      # 单次图片识别（题目提取）的 token 预算，长图/多图可上调
    # AI 线程池并发上限 — 全站同步 AI 调用（图示/板书/出题/批改/讨论/闯关）共用的工作线程数。
    # 这些线程只挂在网络等待上，放开到 8 不会压住数据库；调太小会让高峰期请求排队。
    "AI_MAX_CONCURRENCY": 8,
    # ── 直连模式多轮记忆（backend/chat_memory.py；仅在 APPID 留空/本次强制直连时生效）──
    # 默认开启；关闭后代码行为与"加记忆之前"逐字一致（读与写都不发生）。
    "CHAT_MEMORY_ENABLED": True,
    "CHAT_MEMORY_MAX_TURNS": 8,               # 带上最近几轮问答（一问一答=1 轮）
    "CHAT_MEMORY_TTL_MINUTES": 30,            # 闲置多久即失效（惰性删除 + 后台 prune）
    "CHAT_MEMORY_MAX_CHARS": 6000,            # 历史合计字符预算，超出从最旧一轮丢弃
    "CHAT_MEMORY_MAX_ROWS": 20000,            # 全表行数硬上限，超出全局淘汰最旧
    "CHAT_MEMORY_CONTENT_MAX_CHARS": 4000,    # 单条回答落库前的截断长度
    "CHAT_MEMORY_PRUNE_INTERVAL_MINUTES": 5,  # 后台兜底清理节拍
    # ── 主观题后台批量批改（backend/ai_grading.py；同步练习/学习考试/随堂测验共用）──
    # 学生提交时只判客观题，主观题进队列，由后台把「同一道题的多份答案」合并成一次
    # AI 调用评分（40 人 × 5 题：200 次调用 → 最多 25 次），判完再补成绩通知/错题本/积分。
    # 改完下一轮生效（无需重启），间隔越小出分越快、越大越省调用。
    "AI_GRADING_INTERVAL_SEC": 25,            # 后台扫描节拍（秒）
    "AI_GRADING_BATCH_SIZE": 8,               # 一次 AI 调用合并评几份答案
    "AI_GRADING_CONCURRENCY": 2,              # 同时进行中的批改调用数（避免挤占对话/出题）
    "AI_GRADING_MAX_ITEMS_PER_ROUND": 60,     # 单轮最多批多少题（防一次跑太久）
    # ── 百炼知识库检索（backend/bailian_kb.py；「直连 + 知识库」模式，与 APPID 智能体相互独立）──
    # 开启后聊天页「知识」勾选走 直连大模型 + 百炼知识检索服务；关闭时勾选只启用本地题库/大纲检索（原行为）。
    "KB_ENABLED": False,
    "KB_API_BASE": "",       # 业务空间专属域名（https://llm-xxx.cn-beijing.maas.aliyuncs.com），须与 API Key 同空间
    "KB_AGENT_ID": "",       # 知识检索服务 ID（aid-xxx），控制台"知识服务→知识检索"创建并发布后获得
    "KB_TOP_K": 5,           # 每次检索最多注入的资料条数
    "KB_MIN_SCORE": 0.65,    # 相关度阈值（0.01~1.00），低分切片丢弃。
    #                        V8.6.1 由 0.5 提到 0.65：实测「你好/你是谁」这类元问题
    #                        在 0.5 档照样命中 5/5 条教材切片，是"身份问题答成讲稿"的主因
    "KB_REL_GAP": 0.8,       # 相对分差裁剪（0.0~1.0）：低于最高分×系数的切片一并丢弃，
    #                        避免 5 条里混进蹭分的无关资料（0=关闭）
    "KB_TIMEOUT_MS": 5000,   # 检索超时（毫秒），超时静默降级本地检索，不阻塞对话
    # ── 知识问答（AI 对话）输出质量（backend/chat_intent.py / chat_prompts.py）──
    "CHAT_META_GUARD_ENABLED": True,     # 元问题闸门：身份/寒暄/低信息量不检索、不套质量模板
    "CHAT_IDENTITY_GUARD_ENABLED": True,  # 平台身份 system 提示：修"自报通义千问/ChatGPT"
    "CHAT_SKILL_SEGMENT_MODE": "system",  # 技能段位置：system=放进系统消息；inline=退回拼进正文
    "CHAT_META_MAX_TOKENS": 600,          # 元问题回答的输出上限（闲聊不必长）
}


# 已下线的配置键：旧文件里可能还留着，读取时直接丢弃，免得出现在「未收录配置键」里误导管理员
_RETIRED_KEYS = {"ENABLE_MULTIMODAL", "MODEL_NO_IMAGE_LIST"}

_config_lock = threading.Lock()
_cache_lock = threading.RLock()
_cfg_cache: dict[str, Any] | None = None
_cfg_cache_key: tuple | None = None
_cfg_corrupt: dict[str, Any] = {"corrupt": False, "recovered_from_backup": False, "detail": ""}


def _config_stat_key() -> tuple | None:
    """C4: 用 (mtime_ns, size) 作为缓存键, 避免每次读盘 + 解析整份 JSON"""
    try:
        st = CONFIG_FILE.stat()
        return (st.st_mtime_ns, st.st_size)
    except OSError:
        return None


def _read_json_config(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def load_config() -> dict[str, Any]:
    """加载系统配置（C1/C4）

    - 带 (mtime,size) 缓存, 配置改动即时生效但不再每次读盘解析;
    - 文件缺失或损坏时先回退上一次备份, 并记录可见状态, 不再静默丢配置
      （缺文件曾被当成"用默认值"悄悄放过：课程只剩「人工智能」就是这么来的）;
    - 合并默认值保证新字段存在。
    """
    global _cfg_cache, _cfg_cache_key
    key = _config_stat_key()
    restore_payload: dict[str, Any] | None = None
    with _cache_lock:
        if _cfg_cache is not None and _cfg_cache_key == key:
            return dict(_cfg_cache)

        data: dict[str, Any] | None = None
        corrupt = {"corrupt": False, "recovered_from_backup": False, "detail": ""}
        if key is None:
            if CONFIG_FILE.exists():
                corrupt = {"corrupt": True, "recovered_from_backup": False,
                           "detail": "配置文件无法读取（被占用或无访问权限）"}
            else:
                # C1: 文件不存在 ≠ 正常。先捞 .bak，捞不到才认"用默认值"，两种都要报错，
                #     否则整站配置会静默变成出厂值，用户只会看到"课程列表少了几门"
                backup = _read_json_config(_backup_file())
                if backup is not None:
                    data = backup
                    restore_payload = backup
                    corrupt = {
                        "corrupt": True, "recovered_from_backup": True,
                        "detail": f"{CONFIG_FILE.name} 不存在，已回退到上一次备份(.bak)并写回主文件",
                    }
                else:
                    corrupt = {
                        "corrupt": True, "recovered_from_backup": False,
                        "detail": f"{CONFIG_FILE.name} 不存在且无可用备份，正在使用出厂默认值"
                                  "（课程/密钥/知识库等均为默认值，业务表现会异常）",
                    }
        else:
            data = _read_json_config(CONFIG_FILE)
            if data is None:
                backup = _read_json_config(_backup_file())
                corrupt = {
                    "corrupt": True,
                    "recovered_from_backup": backup is not None,
                    "detail": f"{CONFIG_FILE.name} 解析失败"
                              + ("，已回退到上一次备份" if backup is not None else "，且无可用备份"),
                }
                data = backup
        if data is None:
            if not corrupt["corrupt"] and key is not None:
                corrupt = {"corrupt": True, "recovered_from_backup": False,
                           "detail": "无可用配置，已使用系统默认值"}
            data = {}
        _cfg_corrupt.clear()
        _cfg_corrupt.update(corrupt)
        if corrupt["corrupt"]:
            logger.error(f"[配置] {corrupt['detail']}；请管理员尽快在系统配置页重新保存以修复配置文件")

        merged = dict(DEFAULT_CONFIG)
        merged.update(data)
        for _k in _RETIRED_KEYS:
            merged.pop(_k, None)
        _cfg_cache = merged
        _cfg_cache_key = key
        result = dict(merged)

    # 写回主文件必须放在锁外：save_config 的加锁顺序是 _config_lock → _cache_lock，
    # 这里若在 _cache_lock 内再取 _config_lock 就会与之反序、可能死锁。
    if restore_payload is not None:
        _restore_config_from_backup(restore_payload)
        with _cache_lock:
            _cfg_cache_key = _config_stat_key()
    return result


def _restore_config_from_backup(payload: dict[str, Any]) -> None:
    """主配置缺失但 .bak 还在时，尽量把备份写回主文件（失败只告警，继续按备份内容运行）"""
    try:
        with _config_lock:
            CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
            tmp = CONFIG_FILE.with_name(CONFIG_FILE.name + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False, indent=2))
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, CONFIG_FILE)      # 同盘原子替换
        logger.warning(f"[配置] 已用 .bak 恢复主配置文件: {CONFIG_FILE}")
    except OSError as e:
        logger.warning(f"[配置] .bak 恢复主配置失败（仍按备份内容运行）: {e}")


def save_config(config: dict[str, Any]):
    """保存配置（C1: 先备份 + 临时文件原子替换, 不再出现半截文件）"""
    global _cfg_cache, _cfg_cache_key
    payload = json.dumps(config, ensure_ascii=False, indent=2)
    with _config_lock:
        CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        try:
            if CONFIG_FILE.exists():
                shutil.copy2(CONFIG_FILE, _backup_file())
        except OSError as e:
            logger.warning(f"[配置] 备份写入失败(不影响本次保存): {e}")
        tmp = CONFIG_FILE.with_name(CONFIG_FILE.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, CONFIG_FILE)          # 同盘原子替换
    with _cache_lock:
        _cfg_cache = None
        _cfg_cache_key = None
    _rotate_config_history()


def _config_history_dir() -> Path:
    """配置滚动历史目录（跟着 CONFIG_FILE 走：Web 版=项目根，桌面版=%APPDATA%）"""
    return CONFIG_FILE.parent / "config_history"


def _rotate_config_history(keep: int = 30, recent_days: int = 7) -> None:
    """每次成功保存留一份带时间戳的副本。

    为什么需要：以前只有 `.bak` 一代。管理员先存对了、又存错一次，`.bak` 就被错误那份顶掉，
    "从历史备份恢复"于是再也找不到可用的一版。滚动历史保留最近 `keep` 份，
    外加 `recent_days` 天内的全部（避免高频保存把有用的那一版挤掉）。内容没变不重复落盘。
    """
    try:
        dst_dir = _config_history_dir()
        dst_dir.mkdir(parents=True, exist_ok=True)
        current = CONFIG_FILE.read_bytes()
        # 带毫秒：管理员在一次课里连点两次保存落在同一秒时，纯秒级时间戳会让后一份把前一份
        # 直接盖掉（实测下来"历史"里永远只有一条，回滚点等于没有）
        _now = datetime.now()
        stamp = _now.strftime("%Y%m%d_%H%M%S") + f".{_now.microsecond // 1000:03d}"
        dst = dst_dir / f"{CONFIG_FILE.name}.{stamp}.json"
        newest = sorted(dst_dir.glob(f"{CONFIG_FILE.name}.*.json"), reverse=True)
        if newest and newest[0].read_bytes() == current:
            return                      # 与上一份完全相同，不留重复
        dst.write_bytes(current)
        newest.insert(0, dst)

        cutoff = time.time() - recent_days * 86400
        victims = [f for i, f in enumerate(newest)
                   if i >= keep and (not f.stat().st_mtime or f.stat().st_mtime < cutoff)]
        for f in victims:
            try:
                f.unlink()
            except OSError:
                pass
    except Exception as exc:      # 历史留底失败绝不影响本次保存
        logger.warning(f"[配置] 滚动历史写入失败（不影响本次保存）：{exc}")


def list_config_history() -> list[Path]:
    try:
        return sorted(_config_history_dir().glob(f"{CONFIG_FILE.name}.*.json"), reverse=True)
    except OSError:
        return []


def get_config_value(key: str, default: Any = None) -> Any:
    """运行时获取配置值（供其他模块使用，走 mtime 缓存）"""
    cfg = load_config()
    return cfg.get(key, default)


def config_health() -> dict[str, Any]:
    """C1: 配置健康状态(供 /config/health 与启动自检使用)

    除了"文件在不在、解析成不成"，还要能回答"这份配置是不是其实已经退回出厂默认值"——
    配置被重置时文件存在、JSON 合法，光看 exists 完全正常（课程只剩「人工智能」
    就是这样被放过好几轮的），所以额外给出健康分与出厂默认判定。
    """
    cfg = load_config()
    with _cache_lock:
        info = dict(_cfg_corrupt)
    from backend.data_migration import looks_like_factory_default, score_config
    score = score_config(cfg)
    factory = looks_like_factory_default(cfg)
    status = ("corrupt_recovered_from_backup" if info.get("recovered_from_backup")
              else ("corrupt" if info.get("corrupt")
                    else ("factory_default" if factory else "ok")))
    subjects = cfg.get("SUBJECTS")
    return {
        "status": status,
        "ok": not info.get("corrupt", False),
        "detail": info.get("detail", ""),
        "file": str(CONFIG_FILE),
        "exists": CONFIG_FILE.exists(),
        "backup_exists": _backup_file().exists(),
        "history_count": len(list_config_history()),
        "score": score,
        "factory_default": factory,
        "subjects": len(subjects) if isinstance(subjects, list) else 0,
        "appid_set": bool(str(cfg.get("APPID") or "").strip()),
    }


def storage_info() -> dict[str, Any]:
    """数据落盘概览（备份与恢复页要显示"数据到底在哪、有多大、有没有第二份在危险位置"）"""
    from backend.data_migration import storage_overview
    from backend.config import DATA_DIR, DB_DIR, MEDIA_ROOT, TEMP_UPLOAD_ROOT
    out = storage_overview()
    try:
        usage = shutil.disk_usage(str(STORAGE_DIR))
        out["disk"] = {"total_gb": round(usage.total / 1024 ** 3, 2),
                       "free_gb": round(usage.free / 1024 ** 3, 2)}
    except OSError:
        out["disk"] = {"total_gb": 0, "free_gb": -1}
    out["storage_dir"] = str(STORAGE_DIR)
    out["config_file"] = str(CONFIG_FILE)
    out["config_backup"] = str(_backup_file())
    out["config_history_dir"] = str(_config_history_dir())
    out["config_history_count"] = len(list_config_history())
    out["db_dir"] = str(DB_DIR)
    out["media_root"] = str(MEDIA_ROOT)
    out["temp_uploads"] = str(TEMP_UPLOAD_ROOT)
    out["data_dir"] = str(DATA_DIR)
    out["base_dir"] = str(BASE_DIR)
    # 危险信号：安装目录（代码目录）里还躺着一份库 —— 桌面版覆盖安装会把它连目录一起删
    legacy = out.get("legacy_db") or {}
    out["legacy_data_at_risk"] = bool(out.get("desktop_layout")
                                      and any((v or 0) > 0 for v in legacy.values()))
    out["config_health"] = config_health()
    return out


def _mask_secret(value: Any) -> Any:
    if not isinstance(value, str) or not value:
        return value
    return _MASK_PREFIX + (value[-4:] if len(value) > 4 else "")


def _mask_config(config: dict[str, Any]) -> dict[str, Any]:
    out = dict(config)
    for k in _SECRET_KEYS:
        if out.get(k):
            out[k] = _mask_secret(out[k])
    return out


# ── C2/C5: 配置写入校验 ──

_NUM_RANGES: dict[str, tuple[float, float]] = {
    # 探索画布（配额与素材清理，见 personal_canvas_router / explore_asset_sweeper）
    "EXPLORE_CHAT_QUOTA": (0, 999), "EXPLORE_IMAGE_QUOTA": (0, 999), "EXPLORE_TTS_QUOTA": (0, 999),
    "EXPLORE_CANVAS_MAX": (0, 500),
    "EXPLORE_CONTINUOUS_REMIND_MIN": (5, 180), "EXPLORE_ASSET_ORPHAN_DAYS": (1, 365),
    "EXPLORE_ASSET_TRASH_DAYS": (1, 90), "EXPLORE_TMP_HOURS": (1, 168), "EXPLORE_CANVAS_TRASH_DAYS": (7, 365), "EXPLORE_SHARE_EXPIRE_DAYS": (1, 90),
    "EXPLORE_ASSET_MAX_MB": (64, 10240), "EXPLORE_SWEEP_HOUR": (0, 23), "EXPLORE_TTS_CACHE_MB": (50, 4000),
    "EXPLORE_ASR_MINUTES": (1, 120),
    "wrong_practice_threshold": (0, 500),
    "wrong_practice_per_set": (1, 20),
    "wrong_practice_interval_days": (0, 90),
    "wrong_practice_avoid_recent_sets": (0, 20),
    "JWT_EXPIRATION_HOURS": (1, 720),
    "JWT_RENEW_THRESHOLD_MINUTES": (0, 43200),
    "ONLINE_USER_TIMEOUT_SECONDS": (60, 86400),
    "AUTH_FAIL_WINDOW_SECONDS": (5, 3600),
    "AUTH_FAIL_LIMIT": (1, 100000),
    "AUTH_FAIL_BAN_SECONDS": (0, 86400),
    "LOGIN_FAIL_WINDOW_SECONDS": (30, 86400),
    "LOGIN_FAIL_LIMIT": (1, 100000),
    "MAX_DOC_SIZE_MB": (1, 200),
    "MAX_IMAGE_SIZE_MB": (1, 200),
    # ── 文件提交类作业 ──
    "HOMEWORK_MAX_FILE_MB": (1, 100),
    "HOMEWORK_MAX_FILES": (1, 20),
    "IMAGE_GEN_MAX_PLACEHOLDERS": (0, 8),
    "REWARD_DAILY_CHAT_POINTS": (0, 200),
    # ── 我的画像 ──
    "PORTRAIT_EXTRA_POINTS": (0, 1000),
    "PORTRAIT_EXTRA_MAX": (0, 20),
    "PORTRAIT_STAFF_MAX": (0, 20),
    # ── 荣耀殿堂 ──
    "SHOWCASE_MIN_POINTS": (0, 100000),
    "SHOWCASE_AUTO_INTERVAL_MIN": (5, 1440),
    "PODCAST_MAX_SECONDS": (60, 1800),
    # ── AI 讲演（与播客共用语音总闸，档位与上限独立）──
    "CAST_DEFAULT_MINUTES": (1, 30),
    "CAST_MAX_SECONDS": (60, 1800),
    "CAST_MAX_PAGES": (3, 20),
    "CAST_TTS_CONCURRENCY": (1, 12),
    "REWARD_DAILY_QUIZ_SESSIONS": (0, 20),
    "REWARD_DAILY_ACADEMIC_POINTS": (0, 500),
    "REWARD_DAILY_CLASS_POINTS": (0, 500),
    "REWARD_DAILY_FUN_POINTS": (0, 300),
    "REWARD_DAILY_TOTAL_POINTS": (0, 500),
    "TEACHER_DOWNLOAD_QUOTA_GB": (1, 100),
    "MAX_ALLOWED_REQUESTS": (1, 10000),
    "AI_REQUEST_TIMEOUT": (5, 900),
    # 图片题目提取的 token 预算：下限防呆，上限按住模型上下文（超出只会白等一次超时）
    "IMAGE_EXTRACT_MAX_TOKENS": (500, 32000),
    "AI_MAX_CONCURRENCY": (1, 32),
    "CHAT_MEMORY_MAX_TURNS": (1, 30),
    "CHAT_MEMORY_TTL_MINUTES": (1, 1440),
    "CHAT_MEMORY_MAX_CHARS": (500, 30000),
    "CHAT_MEMORY_MAX_ROWS": (500, 500000),
    "CHAT_MEMORY_CONTENT_MAX_CHARS": (200, 20000),
    "CHAT_MEMORY_PRUNE_INTERVAL_MINUTES": (1, 120),
    # ── 主观题后台批量批改（backend/ai_grading.py）──
    # 必须在此登记：_validate_config_updates 只保留认识的键，漏登记会导致
    # 「系统配置页面改了但保存后不生效」（静默丢弃）。
    "AI_GRADING_INTERVAL_SEC": (5, 3600),
    "AI_GRADING_BATCH_SIZE": (1, 50),
    "AI_GRADING_CONCURRENCY": (1, 8),
    "AI_GRADING_MAX_ITEMS_PER_ROUND": (1, 500),
    # ── 百炼知识库检索（backend/bailian_kb.py）──
    "KB_TOP_K": (1, 20),
    "KB_TIMEOUT_MS": (500, 30000),
    # ── 知识问答输出质量（backend/chat_intent.py / chat_prompts.py）──
    "CHAT_META_MAX_TOKENS": (100, 4000),
    # ── 语音合成（backend/tts_service.py）──
    "TTS_VOLUME": (0, 100),
}
# 浮点范围校验（_NUM_RANGES 会取整，0.01~1.00 的阈值必须走这里）
_FLOAT_RANGES: dict[str, tuple[float, float]] = {
    "KB_MIN_SCORE": (0.01, 1.00),
    "KB_REL_GAP": (0.0, 1.00),
    "TTS_SPEECH_RATE": (0.5, 2.00),
}
_BOOL_KEYS = {
    "EXPLORE_CANVAS_ENABLED", "EXPLORE_ASR_ENABLED", "EXPLORE_SWEEP_DRY",
    "EXPLORE_LOG_RAW_PROMPT",
    "ENABLE_REQUEST_LIMIT", "IMAGE_GEN_ENABLED",
    "MODEL_IMAGE_VIA_CHAT", "MODEL_IMAGE_SOLVE_VL",
    "ENABLE_IP_GUARD", "TRUST_PROXY_HEADERS",
    "ENABLE_BADGES", "ENABLE_SUBJECT_TITLES", "QUEST_USE_BANK",
    "auto_pull_enabled", "CHAT_MEMORY_ENABLED", "KB_ENABLED", "AGENT_ENABLED",
    "UPGRADE_AUTO_BACKUP",
    "TTS_ENABLED", "CLASS_DRILL_AI_ENABLED", "CLASS_LADDER_AI_ENABLED", "CLASS_LADDER_SOUND_ENABLED",
    "PORTRAIT_ENABLED", "PORTRAIT_PERIOD_MONTHLY", "PORTRAIT_AUTO_PUSH",
    "SHOWCASE_AUTO_ENABLED",
    "CHAT_META_GUARD_ENABLED", "CHAT_IDENTITY_GUARD_ENABLED",
    "AI_JSON_OBJECT_MODE", "AI_STRICT_PARSE",
    "LOGIN_BLOCK_STUDENT", "LOGIN_BLOCK_TEACHER", "LOGIN_BLOCK_EXTERNAL",
    "HOMEWORK_ENABLE_VL",
}
_STR_LIMITS: dict[str, int] = {
    "EXPLORE_ASR_MODEL": 60,
    "AGENT_EDITION": 64, "ORG_NAME": 100, "QWEN_OPENAI_API_BASE": 300,
    "MODEL_LONG_NAME": 80, "MODEL_VL_NAME": 80, "MODEL_NAME": 80,
    "IMAGE_GEN_MODEL": 80, "IMAGE_GEN_SIZE": 32,
    "SHOWCASE_RANK_MODE": 16,
    "CLASS_LADDER_DEFAULT_SKIN": 16,
    "dashscope_api_key": 200, "APPID": 128,
    "KB_API_BASE": 300, "KB_AGENT_ID": 128,
    "CHAT_SKILL_SEGMENT_MODE": 16,
    "TTS_MODEL": 80, "TTS_VOICE": 128,
    "PODCAST_VOICE_A": 128, "PODCAST_VOICE_B": 128, "PODCAST_DURATION_OPTIONS": 32,
    "CAST_DURATION_OPTIONS": 32,
}
_STRLIST_KEYS = {"IMAGE_EXTENSIONS": 60, "DOCUMENT_EXTENSIONS": 60, "enabled_skills": 100,
                 "SUBJECTS": 40, "enabled_notification_types": 40, "IP_DENYLIST": 64,
                 "HOMEWORK_ALLOWED_EXTS": 60,
                 "wrong_book_sources": 20}
_TITLE_LIST_KEYS = {"TITLE_CONFIG", "SUBJECT_TITLE_CONFIG", "BADGE_CONFIG"}
_EXT_RE = None


def _bad_ext(ext: Any) -> bool:
    global _EXT_RE
    if _EXT_RE is None:
        import re as _re
        _EXT_RE = _re.compile(r"^\.[A-Za-z0-9]{1,10}$")
    return not (isinstance(ext, str) and _EXT_RE.match(ext))


def _validate_skill_scene_map(value: Any) -> None:
    """场景×技能映射结构校验: {scene: {include?/exclude?: [技能名]}}"""
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="skill_scene_map 必须是对象（场景→映射规则）")
    if len(value) > 50:
        raise HTTPException(status_code=400, detail="skill_scene_map 最多 50 个场景")
    for scene, rule in value.items():
        if not isinstance(scene, str) or not scene.strip() or len(scene) > 60:
            raise HTTPException(status_code=400, detail="skill_scene_map 场景名需为不超过 60 字的非空字符串")
        if not isinstance(rule, dict):
            raise HTTPException(status_code=400, detail=f"skill_scene_map.{scene} 必须是含 include/exclude 的对象")
        unknown = set(rule) - {"include", "exclude"}
        if unknown:
            raise HTTPException(status_code=400, detail=f"skill_scene_map.{scene} 仅支持 include/exclude 字段")
        for fld in ("include", "exclude"):
            lst = rule.get(fld, [])
            if not isinstance(lst, list) or not all(isinstance(x, str) and x.strip() for x in lst):
                raise HTTPException(status_code=400, detail=f"skill_scene_map.{scene}.{fld} 必须是非空字符串列表")
            if len(lst) > 100:
                raise HTTPException(status_code=400, detail=f"skill_scene_map.{scene}.{fld} 最多 100 项")


def _validate_title_config(key: str, value: Any) -> None:
    """C5: 称号/徽章配置结构校验, 避免写坏后称号子系统全线报错"""
    if not isinstance(value, list) or not value:
        raise HTTPException(status_code=400, detail=f"{key} 必须是非空列表")
    if key == "BADGE_CONFIG":
        seen: set[str] = set()
        for i, item in enumerate(value):
            if not isinstance(item, dict) or not item.get("id") or not item.get("name"):
                raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项需包含 id 与 name")
            if str(item["id"]) in seen:
                raise HTTPException(status_code=400, detail=f"{key} 存在重复 id: {item['id']}")
            seen.add(str(item["id"]))
        return
    points_field = "min_points" if key == "TITLE_CONFIG" else "min_questions"
    prev_level = -1
    prev_points = -1
    for i, item in enumerate(value):
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项必须是对象")
        for need in ("level", "name", points_field):
            if need not in item:
                raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项缺少字段 {need}")
        try:
            level = int(item["level"])
            points = int(item[points_field])
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项的 level/{points_field} 必须是整数")
        if not str(item["name"]).strip():
            raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项 name 不能为空")
        if points < 0:
            raise HTTPException(status_code=400, detail=f"{key} 第 {i + 1} 项 {points_field} 不能为负")
        if level <= prev_level or points < prev_points:
            raise HTTPException(status_code=400,
                                detail=f"{key} 第 {i + 1} 项的 level/{points_field} 必须逐级递增(不能低于上一档)")
        prev_level, prev_points = level, points


def _validate_config_updates(updates: dict[str, Any]) -> dict[str, Any]:
    """C2: 校验并规范化配置更新; 未知键忽略(与旧行为一致)"""
    out: dict[str, Any] = {}
    for key, value in updates.items():
        if key in _NUM_RANGES:
            lo, hi = _NUM_RANGES[key]
            try:
                num = int(float(value))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{key} 必须是数字（{lo}~{hi}）")
            if not lo <= num <= hi:
                raise HTTPException(status_code=400, detail=f"{key} 需在 {lo}~{hi} 之间，当前 {num}")
            out[key] = num
        elif key in _FLOAT_RANGES:
            lo, hi = _FLOAT_RANGES[key]
            try:
                num = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{key} 必须是数字（{lo}~{hi}）")
            if not lo <= num <= hi:
                raise HTTPException(status_code=400, detail=f"{key} 需在 {lo}~{hi} 之间，当前 {num}")
            out[key] = round(num, 2)
        elif key in _BOOL_KEYS:
            if isinstance(value, bool):
                out[key] = value
            elif isinstance(value, str) and value.strip().lower() in ("true", "false", "1", "0"):
                out[key] = value.strip().lower() in ("true", "1")
            else:
                raise HTTPException(status_code=400, detail=f"{key} 必须是布尔值")
        elif key in _STR_LIMITS:
            if not isinstance(value, str):
                raise HTTPException(status_code=400, detail=f"{key} 必须是文本")
            if len(value) > _STR_LIMITS[key]:
                raise HTTPException(status_code=400, detail=f"{key} 最长 {_STR_LIMITS[key]} 字")
            out[key] = value.strip() if key in ("dashscope_api_key", "APPID", "KB_API_BASE", "KB_AGENT_ID") else value
        elif key in _STRLIST_KEYS:
            if isinstance(value, str):
                # 容错：标签输入框有时会把整串原样送来（旧前端 / 直接调 API），
                # 这里按逗号/分号/顿号/换行拆开；空串 -> 空列表 = 允许清空（黑名单可为空）
                value = [x.strip() for x in re.split(r"[,，、;；\n]", value) if x.strip()]
            if not isinstance(value, list) or not all(isinstance(x, str) and x.strip() for x in value):
                raise HTTPException(status_code=400, detail=f"{key} 必须是非空字符串列表")
            if len(value) > _STRLIST_KEYS[key]:
                raise HTTPException(status_code=400, detail=f"{key} 最多 {_STRLIST_KEYS[key]} 项")
            # 错题本接入范围只认后端登记过的活动来源：写错一个字母就静默失效，必须当场拒
            if key == "wrong_book_sources":
                from backend.api.wrong_book_router import ALWAYS_ON_WRONG_BOOK_SOURCES, WRONG_BOOK_SOURCE_LABELS
                unknown = [x for x in value if x not in WRONG_BOOK_SOURCE_LABELS]
                if unknown:
                    raise HTTPException(
                        status_code=400,
                        detail="wrong_book_sources 含未登记的活动: " + "、".join(unknown)
                               + "（可选：" + "、".join(WRONG_BOOK_SOURCE_LABELS) + "）")
                missing = [x for x in ALWAYS_ON_WRONG_BOOK_SOURCES if x not in value]
                if missing:
                    raise HTTPException(
                        status_code=400,
                        detail="wrong_book_sources 必须包含 " + "、".join(missing) + "（考试是错题本的基本盘，不可关闭）")
            # 关怀提醒是安全通道：服务端强制开启（notification_router.ALWAYS_ON_TYPES），
            # 保存时把 care 补回去，避免出现"列表里没有它、页面显示未勾选，但其实一直在发"的口径错乱
            if key == "enabled_notification_types" and "care" not in value:
                value = list(value) + ["care"]
            # 作业白名单 HOMEWORK_ALLOWED_EXTS 同样按扩展名校验，防管理员手滑写成 "docx"
            if key.endswith(("EXTENSIONS", "_EXTS")) and any(_bad_ext(x) for x in value):
                raise HTTPException(status_code=400, detail=f"{key} 每一项需形如 .pdf（点号 + 1~10 位字母数字）")
            out[key] = [x.strip() for x in value]
        elif key == "ENABLE_AI_CHAT_FOR_ROLES":
            if not isinstance(value, list) or not all(isinstance(x, int) and x in (0, 1, 2) for x in value):
                raise HTTPException(status_code=400, detail="ENABLE_AI_CHAT_FOR_ROLES 需为角色编号列表(1=教师, 2=学生)")
            out[key] = list(value)
        elif key == "QUESTION_TYPES":
            if not isinstance(value, list) or not value:
                raise HTTPException(status_code=400, detail="QUESTION_TYPES 必须是非空列表")
            for i, item in enumerate(value):
                if not isinstance(item, dict) or not str(item.get("key", "")).strip() or not str(item.get("label", "")).strip():
                    raise HTTPException(status_code=400, detail=f"QUESTION_TYPES 第 {i + 1} 项需包含 key 与 label")
            out[key] = value
        elif key in _TITLE_LIST_KEYS:
            _validate_title_config(key, value)
            out[key] = value
        elif key == "skill_scene_map":
            _validate_skill_scene_map(value)
            out[key] = value
    out = _check_model_pairing(out, updates)
    dropped = [k for k in updates if k not in out]
    if dropped:
        # 走到这里说明该键在 DEFAULT_CONFIG 里但没有登记任何校验规则 —— 保存会被丢弃。
        # 补进 _NUM_RANGES/_BOOL_KEYS/_STR_LIMITS/_STRLIST_KEYS 即可。
        logger.warning(f"[config] 以下配置键无校验规则, 已被忽略: {dropped}")
    return out


def _check_model_pairing(out: dict[str, Any], updates: dict[str, Any]) -> dict[str, Any]:
    """跨键一致性：音色/尺寸必须与所选模型配对。

    为什么单独立一个函数：这两类错都是"两个键各看都合法、合起来必然失败"，
    逐键校验表管不到。实测错配的表现是调用侧 411（音色）与 400/任务 FAILED（尺寸），
    都发生在运行时，管理员在页面上完全看不出来 —— 所以在保存时就拦住。

    只拦"明确属于另一个已知模型/端点"的值；清单外的手填值一律放行，
    因为官方音色与模型远多于本清单（3.0 有 597 条音色、3.1 有 68 条）。
    """
    cfg = load_config()

    if "TTS_MODEL" in out or "TTS_VOICE" in out:
        from backend.tts_voices import DEFAULT_MODEL, resolve_voice

        model = out.get("TTS_MODEL") or cfg.get("TTS_MODEL") or DEFAULT_MODEL
        raw = out.get("TTS_VOICE", cfg.get("TTS_VOICE", ""))
        resolved = resolve_voice(raw, model)
        if resolved["status"] == "mismatch":
            raise HTTPException(
                status_code=400,
                detail=(f"音色 {raw} 属于模型 {resolved['owner_model']}，"
                        f"与所选合成模型 {model} 不配对（实测调用会报 411）。"
                        "请先选合成模型，再从下拉里挑一个该模型的音色"))
        out["TTS_VOICE"] = resolved["voice"]      # 顺手归一（中文名/裸后缀 → 完整参数）

    # AI 播客的两个音色同样必须与合成模型配对（跨模型实测报 411）；
    # 留空是合法值 = 交给后端按模型自动各挑一条，所以这里只拦"明确错配"。
    if {"PODCAST_VOICE_A", "PODCAST_VOICE_B", "TTS_MODEL"} & set(out):
        from backend.tts_voices import DEFAULT_MODEL as _TT_DEFAULT_MODEL
        from backend.tts_voices import resolve_voice as _resolve_voice

        model = out.get("TTS_MODEL") or cfg.get("TTS_MODEL") or _TT_DEFAULT_MODEL
        for key, role in (("PODCAST_VOICE_A", "主讲"), ("PODCAST_VOICE_B", "互动")):
            raw = str(out.get(key, cfg.get(key, "")) or "").strip()
            if not raw:
                out[key] = ""
                continue
            res = _resolve_voice(raw, model)
            if res["status"] == "mismatch":
                raise HTTPException(
                    status_code=400,
                    detail=(f"播客{role}音色 {raw} 属于模型 {res['owner_model']}，"
                            f"与所选合成模型 {model} 不配对（实测调用会报 411）。"
                            "请先选合成模型，再从下拉里挑一个该模型的音色；"
                            "留空则按模型自动选"))
            out[key] = res["voice"]

    if "IMAGE_GEN_MODEL" in out or "IMAGE_GEN_SIZE" in out:
        # 延迟导入：image_gen_service 在模块级引用了本文件的 get_config_value
        from backend.api.image_gen_service import AUTO_SIZE, normalize_size
        from backend.model_catalog import DEFAULT_IMAGE_MODEL, describe_size_rule

        model = out.get("IMAGE_GEN_MODEL") or cfg.get("IMAGE_GEN_MODEL") or DEFAULT_IMAGE_MODEL
        raw = str(out.get("IMAGE_GEN_SIZE", cfg.get("IMAGE_GEN_SIZE", AUTO_SIZE)) or "").strip()
        norm = normalize_size(raw, model)
        if not norm:
            raise HTTPException(
                status_code=400,
                detail=(f"生图尺寸 {raw!r} 不适用于模型 {model}：{describe_size_rule(model)}；"
                        "也可以填 auto 让模型自己定"))
        out["IMAGE_GEN_SIZE"] = norm

    return out


# ── API 端点 ──


@router.get("")
async def get_config(request: Request):
    """获取全部系统配置（管理员；C3: 密钥类字段掩码回显，不回传明文）"""
    user = get_current_user(request)
    require_admin(user)
    return _mask_config(load_config())


# ── 配置备份与恢复（管理员在页面上操作，不必登服务器） ──
# 场景：升级或误操作把整份配置打回出厂默认值（课程只剩「人工智能」、APPID/知识库为空）。
# 历史副本散落在根目录 / backend/ / 各种备份目录里，页面按"健康分"排序列出来，选一份覆盖即可。
# 关键：出厂默认值同样是 111 个键、约 5KB，光看大小和键数分不出好坏，
# 所以用 score_config 的指纹（APPID / 版本号 / 知识库）判断哪份"像真实配置"。
_CONFIG_SOURCE_LABELS: dict[str, str] = {
    "current": "当前使用中",
    "current_bak": "当前配置的上次保存(.bak)",
    "legacy_backend": "旧位置 backend/",
    "legacy_backend_bak": "旧位置 backend/ 的上次保存",
    "restore_backup": "恢复前自动备份",
    "migration_backup": "迁移前的留底",
    "db_backup": "备份目录 db_backups",
    "upgrade_backup": "在线升级前自动留底",
    "config_history": "每次保存的滚动历史",
}


def _config_source_specs() -> list[dict[str, Any]]:
    """候选来源清单。id 由本函数生成，restore 只认这里的 id（前端不能传任意路径）"""
    base = Path(BASE_DIR)
    specs: list[dict[str, Any]] = [
        {"id": "current", "kind": "current", "path": CONFIG_FILE},
        {"id": "current_bak", "kind": "current_bak", "path": _backup_file()},
        {"id": "legacy_backend", "kind": "legacy_backend",
         "path": base / "backend" / "system_config.json"},
        {"id": "legacy_backend_bak", "kind": "legacy_backend_bak",
         "path": base / "backend" / "system_config.json.bak"},
    ]

    def _add_glob(kind: str, pattern: str) -> None:
        for hit in sorted(glob.glob(pattern), reverse=True)[:20]:
            specs.append({"id": f"{kind}:{hit}", "kind": kind, "path": Path(hit)})

    _add_glob("restore_backup", str(CONFIG_FILE) + ".before-restore.*")
    _add_glob("restore_backup", str(CONFIG_FILE) + ".before-upgrade-restore.*")
    _add_glob("migration_backup", str(CONFIG_FILE) + ".replaced-by-migration.*")
    _add_glob("config_history", str(_config_history_dir() / (CONFIG_FILE.name + ".*.json")))
    # db_backups / .upgrade_backups 的现行位置是 STORAGE_DIR（桌面版=%APPDATA%），
    # BASE_DIR 是历史位置（v9.0.0 及更早；Web/源码部署两者本来就同路径）—— 两边都扫再去重，
    # 否则桌面版的升级留底在页面上永远列不出来。
    for root in (STORAGE_DIR, base):
        _add_glob("db_backup", str(Path(root) / "db_backups" / "system_config*.json"))
        _add_glob("upgrade_backup",
                  str(Path(root) / ".upgrade_backups" / "*" / "protected" / "system_config*.json"))
    seen: set = set()
    uniq: list[dict[str, Any]] = []
    for spec in specs:
        try:
            key = str(Path(spec["path"]).resolve())
        except OSError:
            key = str(spec["path"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(spec)
    return uniq


def _describe_config_source(spec: dict[str, Any]) -> dict[str, Any]:
    """把一份候选文件描述成页面能直接渲染的行（含健康分与"是否像出厂默认值"）"""
    from backend.data_migration import looks_like_factory_default, score_config

    p: Path = spec["path"]
    display = str(p)
    try:
        display = str(p.relative_to(Path(BASE_DIR)))          # 项目内的显示相对路径
    except ValueError:
        pass
    item: dict[str, Any] = {
        "id": spec["id"],
        "kind": spec["kind"],
        "label": _CONFIG_SOURCE_LABELS.get(spec["kind"], spec["kind"]),
        "path": display,
        "exists": p.is_file(),
        "is_current": False,
        "size": 0,
        "mtime": "",
        "keys": 0,
        "subjects": 0,
        "score": -1,
        "factory_default": True,
    }
    try:
        item["is_current"] = p.resolve() == CONFIG_FILE.resolve()
    except OSError:
        pass
    if not item["exists"]:
        return item
    try:
        st = p.stat()
        item["size"] = st.st_size
        item["mtime"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))
    except OSError:
        pass
    data = _read_json_config(p)
    if isinstance(data, dict):
        item["keys"] = len(data)
        subjects = data.get("SUBJECTS")
        item["subjects"] = len(subjects) if isinstance(subjects, list) else 0
        item["score"] = score_config(data)
        item["factory_default"] = looks_like_factory_default(data)
    return item


@router.get("/sources", summary="可恢复的配置来源清单（管理员）")
async def list_config_sources(request: Request):
    """列出所有历史副本并按健康分排序，供页面选择恢复"""
    user = get_current_user(request)
    require_admin(user)
    items = [_describe_config_source(spec) for spec in _config_source_specs()]
    items.sort(key=lambda x: x["mtime"] or "", reverse=True)
    items.sort(key=lambda x: (not x["exists"], -x["score"]))   # 稳定排序：先存在、再高分
    return {"sources": items, "count": len(items)}


class ConfigRestoreRequest(BaseModel):
    source: str


@router.post("/restore", summary="从历史备份恢复系统配置（管理员）")
async def restore_config_from_source(req: ConfigRestoreRequest, request: Request):
    """用选定的历史副本覆盖当前配置；覆盖前自动把当前文件另存为 .before-restore.<时间>"""
    user = get_current_user(request)
    require_admin(user)

    spec = next((s for s in _config_source_specs() if s["id"] == req.source), None)
    if spec is None:
        raise HTTPException(status_code=400, detail="无效的配置来源，请刷新列表后重试")
    src: Path = spec["path"]
    if not src.is_file():
        raise HTTPException(status_code=404, detail="该备份文件已不存在，可能已被清理")
    data = _read_json_config(src)
    if not isinstance(data, dict) or not data:
        raise HTTPException(status_code=400, detail="该文件不是有效配置（JSON 解析失败）")
    if not isinstance(data.get("SUBJECTS"), list) or not data["SUBJECTS"]:
        raise HTTPException(status_code=400, detail="该文件缺少课程列表（SUBJECTS），可能不是系统配置")

    before = load_config()
    stamp = time.strftime("%Y%m%d_%H%M%S")
    backup_path: Path | None = CONFIG_FILE.with_name(f"{CONFIG_FILE.name}.before-restore.{stamp}")
    try:
        if CONFIG_FILE.exists():
            shutil.copy2(CONFIG_FILE, backup_path)
        else:
            backup_path = None
    except OSError as exc:
        logger.warning(f"[配置] 恢复前备份失败（仍继续恢复）：{exc}")
        backup_path = None

    merged = dict(DEFAULT_CONFIG)
    merged.update(data)
    save_config(merged)

    after = load_config()
    changed = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    label = _CONFIG_SOURCE_LABELS.get(spec["kind"], spec["kind"])
    logger.warning(
        f"管理员 {user['username']} 从「{label}」恢复系统配置：{len(changed)} 项变化；"
        f"恢复前备份={backup_path}")
    return {
        "status": "ok",
        "source": _describe_config_source(spec)["path"],
        "backup": str(backup_path) if backup_path else "",
        "changed_count": len(changed),
        "changed_keys": changed[:50],
        "subjects": after.get("SUBJECTS", []),
    }


@router.post("/sources/delete", summary="删除某个配置备份（管理员）")
async def delete_config_source(req: ConfigRestoreRequest, request: Request):
    """删掉一份不再需要的配置副本（磁盘上的历史备份文件）"""
    user = get_current_user(request)
    require_admin(user)
    spec = next((s for s in _config_source_specs() if s["id"] == req.source), None)
    if spec is None:
        raise HTTPException(status_code=400, detail="无效的配置来源，请刷新列表后重试")
    if spec["kind"] in ("current", "legacy_backend"):
        raise HTTPException(
            status_code=400,
            detail="当前使用中/旧位置的真实配置不能在这里删除，请先确认已在别处留好备份")
    if spec["kind"] == "current_bak" and not CONFIG_FILE.is_file():
        # 主配置已经没了，.bak 就是唯一还在用的那份（load_config 正按它运行），删掉 = 整站配置归零
        raise HTTPException(status_code=400,
                            detail="主配置文件当前不存在，这份 .bak 是唯一可用的配置，不能删除")
    path: Path = spec["path"]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="该备份文件已不存在")
    try:
        size = path.stat().st_size
        path.unlink()
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"删除失败：{exc}")
    logger.warning(f"管理员 {user['username']} 删除配置备份 {spec['id']}（{size} 字节）")
    return {"status": "ok", "id": spec["id"], "freed_kb": round(size / 1024, 1)}


def _alert_state_file() -> Path:
    return CONFIG_FILE.parent / ".config_alert_state.json"


def notify_admins_config_risk() -> dict[str, Any]:
    """配置处于"损坏/靠 .bak 运行/已退回出厂默认值"时，给管理员发一条站内通知。

    补的是"出事没人知道"：以前只有 logger.error 一行，管理员要到学生说"课程怎么少了两门"
    才发现。同一状态只提醒一次（用状态指纹去重），修好后状态变了会重新计时。
    """
    health = config_health()
    status = health.get("status")
    if status == "ok":
        return {"notified": False, "status": status}
    fingerprint = f"{status}:{health.get('score')}:{health.get('subjects')}:{health.get('file')}"
    state_file = _alert_state_file()
    try:
        if state_file.is_file():
            last = json.loads(state_file.read_text(encoding="utf-8"))
            if last.get("fingerprint") == fingerprint:
                return {"notified": False, "status": status, "reason": "同一状态已提醒过"}
    except Exception:
        pass
    try:
        from backend.database import execute_query as _eq
        rows = _eq("SELECT username FROM users WHERE role=0")
        admins = [r[0] for r in rows] if rows else []
        if not admins:
            return {"notified": False, "status": status, "reason": "没有管理员账号"}
        from backend.api.notification_router import notify_users
        title = ("⚠️ 系统配置异常：" +
                 ("已按 .bak 备份运行" if status == "corrupt_recovered_from_backup" else
                  ("疑似退回出厂默认值" if status == "factory_default" else "配置文件损坏")))
        notify_users(
            usernames=admins, type_="system", title=title,
            content=f"{health.get('detail') or ''}\n"
                    f"配置文件：{health.get('file')}\n"
                    f"课程数：{health.get('subjects')}，健康分：{health.get('score')}"
                    f"（0~2 分基本就是出厂默认值）\n"
                    "请到「系统配置 → 备份与恢复」查看数据位置并从历史副本恢复，"
                    "不要在被重置的状态上继续点保存。",
            related_link="/admin/system-config",
        )
        state_file.write_text(json.dumps({"fingerprint": fingerprint,
                                          "at": time.strftime("%Y-%m-%d %H:%M:%S")},
                                         ensure_ascii=False), encoding="utf-8")
        logger.warning(f"[配置告警] 已通知 {len(admins)} 位管理员：{title}")
        return {"notified": True, "status": status, "admins": len(admins)}
    except Exception as exc:
        logger.debug(f"[配置告警] 通知发送失败：{exc}")
        return {"notified": False, "status": status, "reason": str(exc)}


@router.post("/alert", summary="立即复检并推送配置异常告警（管理员）")
async def trigger_config_alert(request: Request):
    """给"备份与恢复"页一个手动重发/复检入口（改了状态指纹就能再提醒一次）"""
    user = get_current_user(request)
    require_admin(user)
    return notify_admins_config_risk()


@router.get("/storage", summary="数据落盘位置与体积概览（管理员）")
async def get_storage_info(request: Request):
    """数据根/库/媒体/备份位置 + 磁盘余量 + 配置健康分。

    「升级后数据像没了」的第一现场几乎都是路径：换目录、换账号、安装目录里还有一份旧库。
    把这些直接摊到页面上，比让人去翻日志快。
    """
    user = get_current_user(request)
    require_admin(user)
    return storage_info()


@router.get("/health", summary="配置文件健康状态（管理员）")
async def get_config_health(request: Request):
    """C1: 配置文件损坏/回退状态可见, 不再静默用默认值覆盖真实配置"""
    user = get_current_user(request)
    require_admin(user)
    return config_health()


@router.get("/meta", summary="配置项类型与取值范围元数据（管理员）")
async def get_config_meta(request: Request):
    """下发后端的校验规则(数值范围/布尔键/文本长度/列表上限), 供前端表单直接复用。

    只含规则不含配置值, 因此不涉及密钥泄露; 前端不再自己复制一份范围表,
    两处永远不会不一致（改范围只需改后端这一处）。
    """
    user = get_current_user(request)
    require_admin(user)
    from backend.notification_types import catalog as notification_type_catalog

    return {
        "num_ranges": {k: [lo, hi] for k, (lo, hi) in _NUM_RANGES.items()},
        "float_ranges": {k: [lo, hi] for k, (lo, hi) in _FLOAT_RANGES.items()},
        "bool_keys": sorted(_BOOL_KEYS),
        "str_limits": _STR_LIMITS,
        "strlist_keys": _STRLIST_KEYS,
        # 通知类型目录：页面的勾选项由它渲染，避免"代码在发、页面勾不到"
        "notification_types": notification_type_catalog(),
    }


@router.get("/chat-memory", summary="直连对话记忆占用与治理参数（管理员）")
async def get_chat_memory_stats(request: Request):
    """会话轮次表的行数/字节数/最老记录 + 当前生效的治理参数"""
    user = get_current_user(request)
    require_admin(user)
    from backend import chat_memory
    return chat_memory.stats()


@router.post("/chat-memory/clear", summary="立即清空直连对话记忆（管理员）")
async def clear_chat_memory(request: Request):
    """清空会话记忆表：按 username 参数只清一人，不带参数清全部（隐私应急用）"""
    user = get_current_user(request)
    require_admin(user)
    from backend import chat_memory
    target = (request.query_params.get("username") or "").strip()
    if target:
        removed = chat_memory.purge_user(target)
    else:
        removed = chat_memory.prune_expired(ttl_minutes=0)
    return {"message": "已清空对话记忆", "username": target or "*", "removed": removed}


class ConfigUpdate(BaseModel):
    config: dict[str, Any]


@router.put("")
async def update_config(req: ConfigUpdate, request: Request):
    """更新系统配置（管理员）"""
    user = get_current_user(request)
    require_admin(user)
    current = load_config()
    # 允许更新已知的 key + 称号配置相关 key
    _title_keys = {"TITLE_CONFIG", "SUBJECT_TITLE_CONFIG", "BADGE_CONFIG", "ENABLE_BADGES",
                   "ENABLE_SUBJECT_TITLES", "QUEST_USE_BANK"}
    known = {k: v for k, v in req.config.items() if k in DEFAULT_CONFIG or k in _title_keys}
    # C3: 掩码回显的值代表"未修改"（前端表单会原样提交），空串才是主动清空
    for k in _SECRET_KEYS:
        if isinstance(known.get(k), str) and known[k].startswith(_MASK_PREFIX):
            known.pop(k)
    # C2: 类型/范围校验, 不合法整批拒绝(不做部分写入)
    known = _validate_config_updates(known)
    if not known:
        # 没有实际变更(例如只提交了掩码密钥)时不写盘, 避免无意义的文件重写
        return {"status": "ok", "config": _mask_config(current), "updated": []}
    current.update(known)
    save_config(current)
    logger.info(f"管理员 {user['username']} 更新了系统配置 ({len(known)} 项)")

    # 更新 API Key 后清除聊天模块的缓存，使新 key 即时生效
    if any(k in ('dashscope_api_key', 'deepseek_api_key') for k in req.config):
        try:
            from backend.api.chat_router import clear_api_key_cache
            clear_api_key_cache()
        except Exception:
            pass

    # C3: 响应同样掩码, 不回传明文密钥
    return {"status": "ok", "config": _mask_config(current), "updated": sorted(known.keys())}


@router.get("/public")
async def get_public_config():
    """公开配置（无需登录）— 用于登录页面等展示品牌信息"""
    cfg = load_config()
    edition = cfg.get("AGENT_EDITION", "通用版")
    full_name = f"智慧教学平台-{edition}" if edition else "智慧教学平台"
    return {
        "AGENT_NAME": full_name,
        "ORG_NAME": cfg.get("ORG_NAME", ""),
    }


@router.get("/apikey-status")
async def get_apikey_status(request: Request):
    """获取 API Key 配置状态（管理员），告知来源：env（环境变量）、config（系统配置）、missing（缺失）"""
    user = get_current_user(request)
    require_admin(user)

    import os
    env_key = os.environ.get("DASHSCOPE_API_KEY", "")
    cfg_key = load_config().get("dashscope_api_key", "")

    if env_key:
        status = "env"
        source = "环境变量 DASHSCOPE_API_KEY"
        hint = ""
    elif cfg_key:
        status = "config"
        source = "系统配置"
        hint = ""
    else:
        status = "missing"
        source = ""
        hint = "请设置环境变量 DASHSCOPE_API_KEY，或在下方填写 API Key 并保存"

    return {
        "status": status,
        "source": source,
        "hint": hint,
        "configured": status != "missing",
    }


@router.get("/multimodal-status")
async def get_multimodal_status(request: Request):
    """获取多模态模型启用状态（需登录，无需管理员权限）"""
    get_current_user(request)
    cfg = load_config()
    # 多模态不再可关：对话模型按约定必须支持图片，读不到键也按 True 返回
    return {"multimodal_enabled": True}


# 自检接口的等待上限：必须短于前端按钮的超时（120 秒），否则浏览器先掐断，
# 管理员看到的是 "timeout of 30000ms exceeded" 而不是"智能体侧慢/域名连不上"这类真原因。
MODEL_TEST_TIMEOUT_SEC = 60
APPID_TEST_TIMEOUT_SEC = 90


@router.post("/model-test", summary="直连大模型连通性自检（管理员）")
async def model_connectivity_test(request: Request):
    """实测「接入地址 + MODEL_NAME + API Key」直连链路是否可用。

    接入地址按「业务空间专属域名 → 普通域名」逐个实测（两个域名通用），返回每个地址的
    结果与最终生效地址；专属域名连不上而普通域名可用时会明确提示已回落，
    免得管理员对着 getaddrinfo 猜到底是哪个域名的问题。
    """
    user = get_current_user(request)
    require_admin(user)
    import time
    from backend.config import ai_api_bases

    cfg = load_config()
    bases = ai_api_bases()
    model = str(cfg.get("MODEL_NAME", "") or "").strip()
    key = str(cfg.get("dashscope_api_key", "") or "").strip()
    if not key:
        import os
        key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        return {"ok": False, "error": "API Key 未配置"}
    if not model:
        return {"ok": False, "error": "未填写 MODEL_NAME（模型与端点 → 对话模型）"}

    import httpx
    results = []
    winner = None
    for i, base in enumerate(bases):
        host = base.split("//")[-1].split("/")[0]
        item = {"base": base, "host": host, "primary": i == 0, "ok": False}
        t0 = time.time()
        try:
            resp = httpx.post(
                f"{base}/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"model": model, "messages": [{"role": "user", "content": "回复OK"}], "max_tokens": 16},
                timeout=MODEL_TEST_TIMEOUT_SEC,  # 连接与读取都要在 60 秒内给出结果
            )
            item["cost_ms"] = int((time.time() - t0) * 1000)
            if resp.status_code == 200:
                d = resp.json()
                reply = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                item["ok"] = True
                item["reply"] = str(reply).strip()[:30] or "（空回复，但链路通）"
                if winner is None:
                    winner = item
            else:
                item["error"] = "HTTP " + str(resp.status_code) + ": " + resp.text[:160]
        except Exception as exc:
            item["cost_ms"] = int((time.time() - t0) * 1000)
            if "Timeout" in type(exc).__name__:
                item["error"] = f"{MODEL_TEST_TIMEOUT_SEC} 秒内无响应（连接或模型侧超时）"
            else:
                item["error"] = str(exc)[:160]
        results.append(item)

    err_text = None
    if winner is None:
        err_text = "；".join("{}：{}".format(r["host"], r.get("error") or "不可用")
                             for r in results)[:300]
    first = results[0] if results else {}
    win = winner or {}
    return {
        "ok": winner is not None,
        "model": model,
        "cost_ms": win.get("cost_ms"),
        "reply": win.get("reply"),
        "base": win.get("base") or first.get("base") or "",
        "host": win.get("host") or first.get("host") or "",
        "results": results,
        "fallback_used": bool(winner and not winner.get("primary")),
        "error": err_text,
    }

@router.post("/appid-test", summary="智能体应用连通性自检（管理员）")
async def appid_connectivity_test(request: Request):
    """用一条最小提问实测 APPID 智能体是否可用（Key 与 APPID 须同账号）。

    返回 {ok, cost_ms, reply} 或 {ok:false, error}，不抛异常。
    """
    user = get_current_user(request)
    require_admin(user)
    import asyncio
    import time
    cfg = load_config()
    app_id = str(cfg.get("APPID", "") or "").strip()
    if not app_id:
        return {"ok": False, "error": "未填写 APPID（留空时系统本就直连大模型，无需测试）"}
    key = str(cfg.get("dashscope_api_key", "") or "").strip()
    if not key:
        import os
        key = os.environ.get("DASHSCOPE_API_KEY", "")
    if not key:
        return {"ok": False, "error": "API Key 未配置"}
    t0 = time.time()
    try:
        import os
        os.environ["DASHSCOPE_API_KEY"] = key
        from dashscope import Application as DashScopeApp
        # 智能体应用（带知识库检索 / 深度思考）实测经常要几十秒：旧写法在 async 端点里
        # 直接同步调用，既卡住整个事件循环，又让前端 30 秒先超时，管理员只看到
        # "timeout of 30000ms exceeded" 而拿不到真实原因。现放线程池执行并给硬上限。
        resp = await asyncio.wait_for(
            asyncio.to_thread(DashScopeApp.call, app_id=app_id,
                              messages=[{"role": "user", "content": "回复OK"}], stream=False),
            timeout=APPID_TEST_TIMEOUT_SEC,
        )
    except asyncio.TimeoutError:
        return {"ok": False, "timeout": True,
                "cost_ms": int((time.time() - t0) * 1000),
                "error": f"智能体 {APPID_TEST_TIMEOUT_SEC} 秒内未返回（多为应用侧知识库检索或深度思考耗时）。"
                        + "可稍后重试，或改用「直连大模型 + 知识库」链路"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:200]}

    try:
        text = None
        output = getattr(resp, "output", None)
        if isinstance(output, str):
            text = output
        elif output is not None:
            text = (output.get("text") if hasattr(output, "get") else getattr(output, "text", None))
        if text:
            return {"ok": True, "cost_ms": int((time.time() - t0) * 1000),
                    "reply": str(text).strip()[:30]}
        code = str(getattr(resp, "code", "") or "")
        msg = str(getattr(resp, "message", "") or "")
        return {"ok": False,
                "cost_ms": int((time.time() - t0) * 1000),
                "error": (code + " " + msg).strip() or "智能体返回为空（请检查应用是否已发布、知识库是否正常）"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:200]}

@router.post("/kb-test", summary="知识库检索连通性自检（管理员）")
async def kb_connectivity_test(request: Request):
    """用一条真实检索验证「专属域名 + 检索服务 ID + API Key」三件套是否配套。

    返回 {ok, total, cost_ms, sample} 或 {ok:false, error:原因}，不抛异常。
    """
    user = get_current_user(request)
    require_admin(user)
    from backend import bailian_kb
    return bailian_kb.test_kb()


@router.get("/tts-voices", summary="语音合成模型与音色清单（管理员）")
async def tts_voices():
    """一次返回**两个模型各自的**音色清单，供配置页做"换模型 → 换音色"联动。

    单一数据源在 backend/tts_voices.py（只收实测出声成功的音色），前端不再抄一份，
    避免两边漂移后管理员选到一个必然报 411 的组合。合并成一次响应而不是按 model 查询，
    是为了让下拉切换零延迟 —— 清单一共几十条，没必要来回打接口。
    """
    from backend.tts_voices import DEFAULT_MODEL, MODEL_DEFAULT_VOICE, models_for_ui, voices_for_ui

    return {
        "default_model": DEFAULT_MODEL,
        "models": models_for_ui(),
        "default_voice_by_model": MODEL_DEFAULT_VOICE,
        "voices_by_model": {m["id"]: voices_for_ui(m["id"]) for m in models_for_ui()},
    }


@router.get("/model-options", summary="模型候选清单与账号可见性（管理员）")
async def model_options(request: Request, kind: str = "chat"):
    """对话 / 长文本 / 视觉 / 生图的可选模型，供配置页下拉。

    visible=false 只代表"没在账号模型清单里查到"，**不代表下线**（实测该清单不完整：
    两个 qwen-audio TTS 模型都不在其中却能用）。所以前端只标灰提示，不做拦截。
    """
    from backend.model_catalog import annotate, options_for

    user = get_current_user(request)
    require_admin(user)
    if kind not in ("chat", "long", "vl", "image"):
        raise HTTPException(status_code=400, detail="kind 只能是 chat / long / vl / image")
    out: dict = {"kind": kind, "options": annotate(kind),
                 "known": sorted(m["id"] for m in options_for(kind))}
    if kind == "image":
        # 尺寸档位随模型变（两代端点范围不同），一并下发，前端才能做"换模型 → 校验尺寸"
        from backend.model_catalog import describe_size_rule, size_presets_for, size_rule

        out["image_sizes"] = {
            m["id"]: {"presets": size_presets_for(m["id"]), "rule": size_rule(m["id"]),
                      "hint": describe_size_rule(m["id"])}
            for m in out["options"]
        }
    return out


# ── 生图 / 语音合成自检：都会产生一次真实调用与少量费用，故限管理员 + 限次数 ──

_SELFTEST_HITS: dict[str, list[float]] = {}
_SELFTEST_WINDOW_SECONDS = 3600
_SELFTEST_MAX_PER_WINDOW = 10


def _selftest_guard(request: Request) -> str:
    """自检的公共前置：登录 + 管理员 + 次数节流。返回用户名。"""
    user = get_current_user(request)
    require_admin(user)
    username = user["username"]
    now = time.time()
    hits = [x for x in _SELFTEST_HITS.get(username, []) if now - x < _SELFTEST_WINDOW_SECONDS]
    if len(hits) >= _SELFTEST_MAX_PER_WINDOW:
        _SELFTEST_HITS[username] = hits
        raise HTTPException(status_code=429,
                            detail=f"自检次数已达上限（每小时 {selftest_max_hint()} 次）——"
                                   "每次自检都会产生一次真实调用与费用，请稍后再试")
    hits.append(now)
    _SELFTEST_HITS[username] = hits
    return username


def selftest_max_hint() -> int:
    return _SELFTEST_MAX_PER_WINDOW


@router.post("/image-test", summary="生图自检（管理员，真实生成一张图）")
async def image_gen_test(request: Request):
    """用当前配置真生成一张最小图，回报实际用的模型 / 端点 / 尺寸。

    与 model-test 同一套理由：配置页填完就该立刻知道对不对，而不是等教师出题时
    才发现"配图一直没出来"。返回里刻意区分 size_configured 与 size_sent ——
    auto 表示不传、跨端点降级会回落，这正是过去最难自查的一类不一致。
    """
    _selftest_guard(request)
    from backend.api.image_gen_service import self_test

    return await self_test()


@router.post("/tts-test", summary="语音合成自检（管理员，返回可播放音频）")
async def tts_connectivity_test(request: Request):
    """合成一句固定自检文本，返回可播放 URL 与实际生效的模型 / 音色。

    回传 voice_configured 与 voice 两个值：改模型后音色没跟着换（配置里仍是上一个
    模型的音色）是最常见的一种错配，只回一个值看不出"写的是什么、用的是什么"。
    """
    _selftest_guard(request)
    from backend.tts_service import self_test as tts_self_test

    return await tts_self_test()


@router.get("/titles", summary="获取称号配置（管理员）")
async def get_title_config_api(request: Request):
    """获取称号系统全部配置"""
    user = get_current_user(request)
    require_admin(user)
    cfg = load_config()
    from backend.title_system import get_title_config, get_subject_title_config, get_badge_config
    return {
        "TITLE_CONFIG": cfg.get("TITLE_CONFIG", get_title_config()),
        "SUBJECT_TITLE_CONFIG": cfg.get("SUBJECT_TITLE_CONFIG", get_subject_title_config()),
        "BADGE_CONFIG": cfg.get("BADGE_CONFIG", get_badge_config()),
        "ENABLE_BADGES": cfg.get("ENABLE_BADGES", True),
        "ENABLE_SUBJECT_TITLES": cfg.get("ENABLE_SUBJECT_TITLES", True),
    }


@router.put("/titles", summary="更新称号配置（管理员）")
async def update_title_config_api(req: ConfigUpdate, request: Request):
    """更新称号系统配置"""
    user = get_current_user(request)
    require_admin(user)
    current = load_config()
    allowed = {k: v for k, v in req.config.items()
               if k in ("TITLE_CONFIG", "SUBJECT_TITLE_CONFIG", "BADGE_CONFIG",
                        "ENABLE_BADGES", "ENABLE_SUBJECT_TITLES")}
    # C5: 结构校验后再落盘, 避免写坏称号/徽章配置把积分子系统整体打挂
    allowed = _validate_config_updates(allowed)
    if not allowed:
        raise HTTPException(status_code=400, detail="没有可更新的称号配置项")
    current.update(allowed)
    save_config(current)
    logger.info(f"管理员 {user['username']} 更新了称号配置")
    return {"status": "ok"}


@router.get("/subjects", summary="获取启用的课程列表")
async def get_subjects(request: Request):
    # U-CFG: 这些枚举页仅供已登录页面使用(匿名只有 /config/public)
    get_current_user(request)
    """从系统配置返回课程列表"""
    from backend.subject_config import get_subjects, get_default_subject
    return {
        "subjects": get_subjects(),
        "default": get_default_subject(),
    }

@router.get("/question-types", summary="获取启用的题型列表")
async def get_question_types():
    """从系统配置返回题型列表（管理员可在系统配置页面修改）"""
    cfg = load_config()
    types = cfg.get("QUESTION_TYPES", [])
    return {
        "types": types,
        "default": types[0] if types else {"key": "single", "label": "单选题"},
    }

@router.get("/grades", summary="获取年级列表")
async def get_grades(request: Request, stage: str | None = None):
    get_current_user(request)
    """获取年级列表，支持按学段筛选（小学/初中/高中）"""
    from backend.permission_service import get_all_grades, get_all_stages
    grades = get_all_grades(stage or "")
    stages = get_all_stages()
    return {
        "grades": grades,
        "stages": stages,
    }


@router.get("/grades/{grade_id}/classes", summary="获取某年级的班级列表")
async def get_classes_by_grade(grade_id: int, request: Request):
    get_current_user(request)
    """获取指定年级下的所有班级"""
    from backend.permission_service import get_all_classes, get_grade_by_id
    grade = get_grade_by_id(grade_id)
    if not grade:
        raise HTTPException(status_code=404, detail="年级不存在")
    classes = get_all_classes(grade_id)
    return {
        "grade": grade,
        "classes": classes,
    }


@router.get("/stages", summary="获取学段列表")
async def get_stages(request: Request):
    get_current_user(request)
    """获取所有学段"""
    from backend.permission_service import get_all_stages
    return {"stages": get_all_stages()}
