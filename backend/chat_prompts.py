# -*- coding: utf-8 -*-
'''知识问答（AI 对话）单轮组稿 —— 身份 / 回答要求 / 资料 / 技能的分层归位

修的问题（V8.6.1，对应"你是谁答成讲稿"事故）：
1. 身份缺失：链路里只有「你是一位学科教师 + 请用你的学科知识回答」，没有任何
   平台身份，也没有 system 角色（ai_service 直连分支一律 user-only），
   于是模型自报"通义千问（Qwen）"，甚至照着教材切片说自己是 ChatGPT。
2. 资料压过提问：寒暄与身份问题也走知识库检索，2585 字切片压在 3 字提问前面，
   注入语"资料与问题无关时忽略资料"太弱，模型必然围绕资料作答。
3. 模板外显：「输出质量三阶增强」等技能正文直接拼进 user 文本，小模型把
   "## 阶段一：深度分析""- [ ] 准确性检查"当成答案模板抄进正文。

本模块把一次提问拆成 system（身份 + 回答要求 + 技能指引 + 资料）与
user（用户原话），使提问重新成为注意力的中心。
所有函数都是纯组装，不发请求，便于离线断言（tests/test_chat_prompt_quality.py）。
'''
import re
from typing import Any, Optional

from backend.logger import logger

# ── 参考资料注入规则（替代 chat_router 里就地拼接的两套文案）──
_KB_CLOUD_RULES = (
    '【知识库参考资料】以下片段检索自教师上传的教材/课件知识库。使用规则：'
    '① 只有当某段资料能直接回答当前问题时才引用它；'
    '② 与问题无关的资料一律忽略，不要为了用上资料而把话题改成资料内容；'
    '③ 确需引用时注明《文档名》，并说明这是平台资料而非你的独立判断；'
    '④ 不得编造页码或原文，不得提及"命中的片段/资料1/相关度"等内部标记。'
)
_KB_LOCAL_RULES = (
    '【教学参考资料】以下内容检索自平台题库与课程大纲，仅作补充参考；'
    '与当前问题无关时忽略，不要为用上资料而改写话题。'
)

# ── 回答要求（替代"请用你的学科知识回答用户的问题"）──
_ANSWER_RULES = (
    '【回答要求】\n'
    '- 先直接回答用户问的那件事，再给必要的解释；篇幅跟着问题的大小走：'
    '一句话能说清的就不用小标题、不列章节、不出表格。\n'
    '- 下面是你的内部工作方法，不是答案模板：严禁在回答里出现'
    '"阶段一/阶段二/深度分析/结构化输出/自我审查/检查清单"这类标题、编号或'
    '"- [ ]""- [x]"勾选项，也不要把受众分析、难点预判的过程写进正文。\n'
    '- 不重复朗读系统给你的身份、参考资料、用户信息；称呼学生至多一次。\n'
    '- 拿不准的事实直说不确定，不编造数据、页码、出处、原文。'
)

# ── 元问题（身份/寒暄/低信息量/平台外）专属回答要求：压掉结构化倾向 ──
_META_RULES: dict[str, str] = {
    '身份/能力询问': (
        '【本轮是问你这个助手】\n'
        '- 用 1~3 句话说明你是谁、主要能帮上什么，可给 2~3 个具体例子。\n'
        '- 不要展开成分章节的说明文，不要出思考题、不要布置练习、不要引用教材。\n'
        '- 若用户想知道技术底层，只说"由平台接入的大模型驱动，具体型号以系统配置为准"。'
    ),
    '寒暄': (
        '【本轮是打招呼】\n'
        '- 一两句自然回应就够了，直接问对方想解决什么；\n'
        '- 不要自我介绍身份、不要罗列能力清单、不要介绍知识库、不要用标题和分点、不要出题。'
    ),
    '低信息量': (
        '【本轮内容太少，无法判断想问什么】\n'
        '- 用一句话请对方补充具体问题，语气简短友好，不超过两句。\n'
        '- 不要猜测意图展开长篇讲解，不要出题。'
    ),
    '平台外请求': (
        '【本轮超出平台能力】\n'
        '- 一句话说清平台内查不到实时信息/做不到这件事，并给一个平台内可替代的方向。\n'
        '- 不要编造实时数据，不要展开讲解与该请求字面相似的知识。'
    ),
    '空提问': '【本轮是空消息】只用一句话请用户说出问题。',
}


def decide_turn(question: str, meta_guard_enabled: bool = True) -> tuple[Optional[str], bool, bool]:
    """一次对话提问的裁决：(元问题原因, 是否检索知识库, 是否注入质量技能)。

    闸门关掉时 (None, True, True) 完全等同 V6.9 的行为，用于一键回退。
    元问题一律既不检索也不注入技能：前者防"教材切片淹没提问"，
    后者防"三阶增强模板被抄成答案"。
    """
    if not meta_guard_enabled:
        return None, True, True
    from backend import chat_intent
    reason = chat_intent.is_meta_question(question)
    if reason:
        return reason, False, False
    may, _why = chat_intent.should_retrieve(question)
    return None, may, True


def platform_display_name() -> str:
    """平台对外显示名（与登录页品牌同源：优先学校名，回退"智慧教学平台-{版本}"）"""
    try:
        from backend.api.config_router import get_config_value
        org = str(get_config_value("ORG_NAME", "") or "").strip()
        if org:
            return org
        edition = str(get_config_value("AGENT_EDITION", "通用版") or "").strip()
        return f"智慧教学平台-{edition}" if edition else "智慧教学平台"
    except Exception as e:  # 配置不可用时不影响对话
        logger.debug(f"平台名读取失败，用默认: {e}")
        return "智慧教学平台"


_ROLE_PREFIX_RE = re.compile(r"^你(是一位|是一名|是位|是)\s*")


def _persona_phrase(persona: str) -> str:
    """把 build_ai_role() 的整句（"你是一位高中通用技术教师"）收成名词短语

    身份句里要接的是「内置的___」，留着"你是一位"就会拼成
    「内置的你是一位通用技术教师」这种病句。
    """
    p = _ROLE_PREFIX_RE.sub("", str(persona or "").strip())
    return p or "学科教师"


def build_identity_block(persona: str, *, user_name: str = "", role_label: str = "") -> str:
    """固定身份：修"你是谁"自报通义千问/ChatGPT 的根因"""
    who = _persona_phrase(persona)
    platform = platform_display_name()
    lines = [
        f'【你的身份】你是「{platform}」内置的{who}，是这套教学平台里的 AI 助手。',
        '- 有人问"你是谁/你叫什么/你是什么模型/你是不是 ChatGPT"时，只按上面这句话回答。',
        '- 严禁自报底层大模型名称（通义千问、Qwen、ChatGPT、GPT、DeepSeek、文心、豆包等），'
        '也不要把自己说成某个公开聊天产品，或某份教材、教程里讲解的那个模型。',
        '- 被追问实现细节时说"由平台接入的大模型驱动，具体型号以系统配置为准"，不编造参数、公司、版本。',
    ]
    if user_name or role_label:
        who_user = '、'.join(x for x in (role_label, user_name) if x)
        lines.append(f'- 正在与你对话的是：{who_user}。用人的口吻交流，不要每轮复读这份信息。')
    return '\n'.join(lines)


def resolve_persona(username: str, user_payload: Optional[dict[str, Any]] = None) -> tuple[str, str, str]:
    """返回 (persona 文本, 对话者姓名, 对话者身份标签)

    教师/管理员 → 其任教学科的教师；学生 → 学习助手。异常一律退回通用「学科教师」，
    绝不因为画像查不到而阻塞对话。
    """
    ctx: dict[str, Any] = {}
    try:
        from backend.utils import get_user_context_from_payload
        ctx = get_user_context_from_payload(user_payload) or {}
    except Exception:
        ctx = {}
    try:
        from backend.auth import get_user_role
        role = get_user_role(username) if username else (user_payload or {}).get('role', 2)
    except Exception:
        role = (user_payload or {}).get('role', 2)

    name = str(ctx.get('name') or '')
    if role in (0, 1):
        role_label = '管理员' if role == 0 else '教师'
        subjects: list[str] = []
        try:
            from backend.permission_service import get_teacher_subjects
            subjects = [s for s in (get_teacher_subjects(username) or []) if s]
        except Exception:
            subjects = []
        try:
            from backend.prompts import build_ai_role
            persona = build_ai_role(subjects=subjects) if subjects else build_ai_role()
        except Exception:
            persona = '学科教师'
        return persona, name, role_label

    role_label = '学生'
    cls = str(ctx.get('class') or '').strip()
    if cls:
        role_label = f'学生·{cls}班' if cls.isdigit() else f'学生·{cls}'
    # 学生侧不再套"xx教师"的壳：实测对学生说"我是你的学科教师"会让
    # 身份回答变得含混（教师人设 + 助手自称同时出现）
    persona = '学习助手'
    return persona, name, role_label


_PUNCT_RE = re.compile(r"""[\s\.,;:!?、。，；：！？…~～\-\"'`（）()\[\]{}]+""")


def _norm_q(text: str) -> str:
    return _PUNCT_RE.sub("", str(text or "").strip().lower())


def is_repeat_question(question: str, history: Optional[list]) -> bool:
    """同一会话里这句问题是否已经问过（忽略标点/大小写，扫描全部历史 user 轮）

    只比对"上一句"是不够的：实测 root 在一次会话里
    `你好 → 你是谁 → 你好 → 你好`，第 2/3/4 次"你好"都拿到了逐字相同的自我介绍，
    因为它们中间隔着别的轮次。重复检测要看整段会话记忆。
    """
    qn = _norm_q(question)
    if len(qn) < 2:
        return False
    for item in reversed(history or []):
        if isinstance(item, dict) and item.get("role") == "user" \
                and _norm_q(item.get("content")) == qn:
            return True
        if isinstance(item, str) and _norm_q(item) == qn:
            return True
    return False


REPEAT_HINT = (
    '【这句问题在本次会话里已经问过了】不要再复述刚才那段回答，也不要再来一遍自我介绍：'
    '要么补一个他没试过的角度或例子，要么直接问他想深入哪一块；'
    '确实无可补充的，就一句话说明「刚才答过了，要我展开哪部分」。'
)


def build_kb_block(kb_context: str) -> str:
    """参考资料 → 放进 system 尾部，并附硬使用规则"""
    if not kb_context:
        return ''
    rules = _KB_CLOUD_RULES if '【知识库参考资料】' in kb_context else _KB_LOCAL_RULES
    return f'{rules}\n\n{kb_context}'


def build_meta_rules(meta_reason: Optional[str]) -> str:
    if not meta_reason:
        return ''
    return _META_RULES.get(meta_reason, _META_RULES['空提问'])


def compose_chat_turn(
    question: str,
    *,
    username: str = '',
    user_payload: Optional[dict[str, Any]] = None,
    persona: Optional[str] = None,
    user_name: Optional[str] = None,
    role_label: Optional[str] = None,
    kb_context: str = '',
    skill_segment: str = '',
    meta_reason: Optional[str] = None,
    extra_rules: str = '',
) -> tuple[str, str]:
    """组一份 (system, user)。

    - system：身份 → 回答要求（元问题换成专属规则）→ 技能工作方式 → 参考资料
    - user  ：用户原话，不再前缀"用户问题："、不再夹带人设与资料

    提问永远排在资料前面；资料只出现在 system。
    """
    if persona is None or user_name is None or role_label is None:
        p2, n2, l2 = resolve_persona(username, user_payload)
        persona = p2 if persona is None else persona
        user_name = n2 if user_name is None else user_name
        role_label = l2 if role_label is None else role_label

    parts: list[str] = [
        build_identity_block(persona or '', user_name=user_name or '', role_label=role_label or ''),
        build_meta_rules(meta_reason) if meta_reason else _ANSWER_RULES,
    ]
    if skill_segment:
        parts.append(skill_segment)
    if extra_rules:
        parts.append(extra_rules)
    kb_block = build_kb_block(kb_context)
    if kb_block:
        parts.append(kb_block)
    return '\n\n'.join(p for p in parts if p), (question or '')