"""关怀拦截（学生安全护栏）的单一实现。

为什么单独一个模块：探索画布原先在路由文件里内联了一份 9 个关键词的表，
问答/生图/导图/知识星图四条 AI 入口里只有问答接了，另外三条裸奔；白板与智答
更是完全没有。表一散，口径必然漂——这里收成一份，任何入口 import 就能用。

三条硬口径（改之前先读）：
1. **优先接住人，不追求答题**：命中即返回固定话术，不调用大模型，
   避免模型把危机对话带偏，也避免多花一次 token。
2. **零原文**：通知只带学生身份与次数，不带任何提问文本；
   pc_ai_tasks 的 prompt_digest 落哈希（见 digest_prompt）。
3. **只拦学生**：role==2。教师问"青少年自杀率"这类教学/研究话题必须正常回答，
   否则老师会被自己的课件拦住。
"""
import hashlib
import re
from datetime import datetime

from backend.logger import logger

# ── 固定话术 ────────────────────────────────────────────────
# 三条信息缺一不可：① 承认情绪（不说教）② 现实中的具体求助人 ③ 24 小时热线兜底
CARE_REPLY = (
    "看到你可能正处在一个很难熬的时刻，我很在意你的感受，愿意说出来已经很不容易。\n\n"
    "现在请先做一件事：找一个现实中能马上帮到你的人——心理老师、班主任或家人，"
    "也可以拨打 12355 青少年服务热线（24 小时都有人接）。\n\n"
    "我会一直在这里。如果你愿意，就用一两句话说说此刻最困扰你的事，我们一起慢慢理一理。"
)

# 生图/导图这类"非对话"入口没法自然地回一段话术，用这个前缀告诉前端：
# 这不是报错，是把关怀话术原文显示出来（不要加 ⚠️）。
CARE_PREFIX = "[CARE] "

# 模型侧自评信号：提示词要求模型在察觉隐晦风险（没有明说）时于末尾单独输出该标记，
# 服务端 scrub 掉并据此发关怀通知——学生看不到这一行。
CARE_MARK = "[[CARE_SIGNAL]]"

# ── 判定规则 ────────────────────────────────────────────────
# 设计取舍：宁可略宽，不可漏。但每条都刻意避开"教学/科普语境"的常见搭配
# （如"自杀率""校园霸凌的定义""安眠药的副作用"），这些是正常提问，不该被拦。
CARE_RULES: tuple[tuple[str, str], ...] = (
    ("suicide", (
        # "自杀率/自杀人数/自杀新闻"是研究性提问，交给模型正常回答；"我想自杀"必须先接住
        r"自杀(?!率|人数|统计|数据|新闻|事件|干预|防治|预防)|自尽|轻生|寻死|想死(?!你)|不想活|活不下去|活够了|"
        r"活着没(什么)?(意思|意义)|活着(太|好)?累|结束(自己的)?生命|了结自己|"
        r"不如(死|去死)|死了算了|消失算了|不想醒来|一了百了|遗书|"
        r"跳楼|跳河|上吊|喝(农药|百草枯)|(吃|吞)(了)?(一瓶|很多|好多)?安眠药|烧炭"
    )),
    ("self_harm", (
        r"自残|自伤|割腕|割手|划(手腕|手臂)|割(手腕|手臂)|拿刀(割|划)|烫自己|撞墙|弄伤自己"
    )),
    ("harm_others", (
        r"同归于尽|报复社会|杀(了|死)(他|她|他们|老师|同学|全家)|"
        r"砍(死|人)|捅(死|人)|带刀(去|进)(学校|教室)|炸(学校|教学楼)"
    )),
    ("despair", (
        r"撑不下去|扛不住|熬不下去|没有(任何)?希望|没人(在乎|关心|喜欢)我|"
        r"我是(个)?(废物|垃圾)|我(活着)?(是)?(多余|没用)的?"
    )),
    ("en", r"\b(kill myself|suicide|end my life|self[- ]harm|cut myself|want to die|no reason to live)\b"),
)

_CARE_RES = tuple((tag, re.compile(pat, re.I)) for tag, pat in CARE_RULES)


def care_hit(text: str) -> str:
    """命中返回规则标签（便于审计区分强度），未命中返回空串。"""
    s = (text or "")
    if not s.strip():
        return ""
    for tag, rx in _CARE_RES:
        if rx.search(s):
            return tag
    return ""


def should_care(user: dict, *texts: str) -> str:
    """学生侧统一入口：非学生一律不拦。返回命中的标签或空串。"""
    if not user or int(user.get("role", 2) or 2) != 2:
        return ""
    for t in texts:
        tag = care_hit(t or "")
        if tag:
            return tag
    return ""


def history_user_text(history: list, limit: int = 3) -> str:
    """最近几轮"学生自己说的话"——只取 user 侧，assistant 的关怀话术不能反过来触发关怀。"""
    if not isinstance(history, list):
        return ""
    outs = [str(h.get("content") or "") for h in history[-8:]
            if isinstance(h, dict) and h.get("role") == "user"]
    return "\n".join(outs[-limit:])


def already_cared(history: list) -> bool:
    """上一轮助手说的就是关怀话术 → 说明已经接住过了，别再把学生锁在同一个回复里。"""
    if not isinstance(history, list):
        return False
    probe = CARE_REPLY[:16]
    for h in reversed(history[-6:]):
        if isinstance(h, dict) and h.get("role") == "assistant":
            return probe in str(h.get("content") or "")
    return False


def scrub(text: str) -> tuple[str, bool]:
    """从模型输出里摘掉 CARE_MARK。

    流式是按"累计全文"下发的，客户端每帧整体替换，因此对每帧做替换即可；
    末尾出现半截标记（如 "[[CARE"）时先截掉，等下一帧补齐再处理，
    避免学生看到一闪而过的方括号。
    """
    s = text or ""
    if CARE_MARK in s:
        return s.replace(CARE_MARK, ""), True
    for i in range(len(CARE_MARK) - 1, 0, -1):
        if s.endswith(CARE_MARK[:i]):
            return s[:-i], False
    return s, False


def digest_prompt(text: str) -> str:
    """pc_ai_tasks.prompt_digest 的唯一写入口。

    默认只落不可逆哈希：产品口径是"只计行为、不看内容"，原先这里存了提问前 200 字，
    等于给统计台账留了一份原文副本。确需排查模型问题时把 EXPLORE_LOG_RAW_PROMPT 打开。
    """
    s = (text or "").strip()
    if not s:
        return ""
    try:
        from backend.api.config_router import get_config_value
        if get_config_value("EXPLORE_LOG_RAW_PROMPT", False):
            return s[:200]
    except Exception:
        pass
    return "h:" + hashlib.sha256(s.encode("utf-8")).hexdigest()[:24]


# 同一学生每天最多推几条——重复触发时不能让管理员被自己的手机淹没
MAX_NOTIFY_PER_STUDENT_PER_DAY = 2


def notify_care(user: dict, *, tag: str = "", title: str = "探索画布·关怀提醒",
                link: str = "/activity-monitor?tab=explore-usage", source_type: str = "explore_care") -> bool:
    """给全体管理员推一条零原文关怀提醒。返回是否真的投递。

    只发管理员是当前的产品决定（不按班主任/心理教师做角色路由）：
    系统只有 0/1/2 三种角色，没有班主任与心理教师的身份，硬按班级推断会推错人。
    """
    try:
        from backend.api.notification_router import create_notification
        from backend.database import get_connection
        from backend.notification_types import ensure_care_enabled

        ensure_care_enabled()
        uname = str(user.get("username") or "")
        if not uname:
            return False
        name = user.get("name") or uname
        day_start = datetime.now().strftime("%Y-%m-%d 00:00:00")

        with get_connection() as conn:
            c = conn.cursor()
            admins = [r[0] for r in c.execute(
                "SELECT username FROM users WHERE role = 0").fetchall()]
            sent_map = dict(c.execute(
                "SELECT recipient_username, COUNT(*) FROM notifications WHERE type = 'care'"
                " AND COALESCE(source_id, '') = ? AND created_at >= ? GROUP BY recipient_username",
                (uname, day_start)).fetchall())

        detail = ("学生 " + name + "（" + uname + "）在探索画布中的表达触发了敏感意图，"
                  "系统已按关怀话术应答，请关注该生状态。系统未保留提问原文。")
        pushed = 0
        for admin in admins:
            n = int(sent_map.get(admin, 0) or 0)
            if n >= MAX_NOTIFY_PER_STUDENT_PER_DAY:
                continue  # 当天已经推够了，避免同一学生反复触发把管理员淹没
            text = detail + ("（今日第 " + str(n + 1) + " 次）" if n else "")
            create_notification(admin, "care", title, text,
                                related_link=link, source_type=source_type, source_id=uname)
            pushed += 1
        if pushed:
            logger.info("[care] 关怀提醒已推送 %s 条 tag=%s", pushed, tag or "-")
        return bool(pushed)
    except Exception as e:
        logger.warning("[care] 关怀提醒发送失败: %s", e)
        return False
