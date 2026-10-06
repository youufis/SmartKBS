# -*- coding: utf-8 -*-
"""语音合成：模型清单、按模型分组的音色目录、姓名读法校正词典。

为什么音色必须跟模型走
  这个系列**音色与模型必须配对**：实测把 3.0 的音色给 3.1 用、或反过来，都直接报
  `InvalidParameter / [cosyvoice:]Engine error [411]`。所以目录按模型分组，
  配置页换模型时音色清单要跟着换，后端也做归属校验 —— 不能等点名现场才发现静默失败。

音色数据来源（2026-10-05 / 10-06 两份实测定包）
  3.0：官方 597 条基础音色里挑 23 条（精选 15 + 替补 8），每条都用同一段课堂旁白真跑出音频；
  3.1：官方 68 条系统音色里挑 32 条（精选 15 + 备选 17），逐个点名实测出声通过。
  清单里只放**实测成功**的音色；官方还有更多，管理员手填也能用（走 unknown 放行分支）。

3.1 相对 3.0 的增量：8 种方言 + 8 种外语、情感与拟声标签、instruction 指令、seed 复现、
  hot_fix 纠音。3.0 的增量是"597 条声线可选、含 7 岁童声等细分"。
  本模块只登记 voice 参数，那些能力开关尚未接入（3.0 收到 instruction 会怎样还没实测）。
"""
from __future__ import annotations

from typing import Any

M30 = "qwen-audio-3.0-tts-flash"
M31 = "qwen-audio-3.1-tts-flash"

#: 默认模型保持 3.0 不动（与"生图默认模型不动"同口径）：智能点名已用它上线并实测稳定。
DEFAULT_MODEL = M30

MODELS: list[dict[str, Any]] = [
    {"id": M30, "label": "Qwen-Audio 3.0 Flash", "default_voice": M30 + "-longnixiwei",
     "note": "597 条基础音色里精选，声线细分多（含童声）；无方言与情感标签"},
    {"id": M31, "label": "Qwen-Audio 3.1 Flash", "default_voice": "longsanshu_v3.1",
     "note": "68 条系统音色，实测延迟更低；自带 8 种方言 + 8 外语、情感标签、纠音能力"},
]
MODEL_DEFAULT_VOICE: dict[str, str] = {m["id"]: m["default_voice"] for m in MODELS}

_V30 = M30 + "-"          # 3.0 基础音色的参数前缀

#: 按模型分组的音色目录。age 为空串表示官方音色表没有年龄列。
VOICE_CATALOGS: dict[str, list[dict[str, Any]]] = {
    M30: [
        {"voice": _V30 + "longliuxulan", "name": "龙柳旭澜", "style": "标准播音·女（正式开场）", "gender": "女", "age": "25", "lang": "中文", "group": "main", "note": "字正腔圆最有台标感；长文本略端着，适合开场与通知"},
        {"voice": _V30 + "longnixiwei", "name": "龙霓曦薇", "style": "新闻联播·男（权威播报）", "gender": "男", "age": "38", "lang": "中文", "group": "main", "note": "全表唯一新闻联播音，中低音权威感强；3.0 默认音色"},
        {"voice": _V30 + "longhuiyanxing", "name": "龙辉焱杏", "style": "知识讲解·沉稳男（主力旁白）", "gender": "男", "age": "42", "lang": "中文", "group": "main", "note": "节奏稳、耐听，微课主讲男声首选"},
        {"voice": _V30 + "longsonglinwang", "name": "龙松麟望", "style": "磁性电台·男（情感慢读）", "gender": "男", "age": "36", "lang": "中文", "group": "main", "note": "气声多、近讲感"},
        {"voice": _V30 + "longrongzhihe", "name": "龙蓉芷荷", "style": "电台质感·女（课文美读）", "gender": "女", "age": "24", "lang": "中文", "group": "main", "note": "电台质感里最干净的一条，长段不累"},
        {"voice": _V30 + "longlanghongmo", "name": "龙朗虹沫", "style": "温柔陪伴·女（鼓励反馈）", "gender": "女", "age": "25", "lang": "中文", "group": "main", "note": "语速偏软，答题鼓励可用，正式播报别用"},
        {"voice": _V30 + "longqinghuilang", "name": "龙晴辉朗", "style": "知性讲解·女（主力女声）", "gender": "女", "age": "24", "lang": "中文", "group": "main", "note": "清晰利落又亲和，女声主讲首选"},
        {"voice": _V30 + "longmohuiling", "name": "龙沫晖翎", "style": "御姐权威·女（角色/结论）", "gender": "女", "age": "26", "lang": "中文", "group": "main", "note": "气场强适合下定论，日常讲解偏冷"},
        {"voice": _V30 + "longyiyusong", "name": "龙熠瑜松", "style": "活泼互动·女（课堂气氛）", "gender": "女", "age": "24", "lang": "中文", "group": "main", "note": "情绪上扬，短句最佳"},
        {"voice": _V30 + "longjufuhe", "name": "龙菊芙荷", "style": "呆萌女童（吉祥物/低龄）", "gender": "女", "age": "7", "lang": "中文", "group": "main", "note": "只适合短台词与趣味桥段"},
        {"voice": _V30 + "longxuanyixiao", "name": "龙暄漪霄", "style": "二次元男童（学生角色）", "gender": "男", "age": "7", "lang": "中文", "group": "main", "note": "与呆萌女童可配成双吉祥物"},
        {"voice": _V30 + "longyingdielin", "name": "龙莹蝶琳", "style": "热血激昂·男（高潮动员）", "gender": "男", "age": "42", "lang": "中文", "group": "main", "note": "全表情绪最高的一条"},
        {"voice": _V30 + "longxiaqueshan", "name": "龙霞雀杉", "style": "搞怪逗趣·男（喜剧担当）", "gender": "男", "age": "25", "lang": "中文", "group": "main", "note": "口语感强，正式讲解慎用"},
        {"voice": _V30 + "longrongxianyu", "name": "龙蓉弦煜", "style": "古风宫廷·女（历史演绎）", "gender": "女", "age": "26", "lang": "中文", "group": "main", "note": "咬字带腔调，适合古风/历史题材"},
        {"voice": _V30 + "loongadriangao", "name": "Adrian Gao", "style": "英文叙述·男（双语片段）", "gender": "男", "age": "22", "lang": "英文", "group": "main", "note": "英文术语朗读、双语片头"},
        {"voice": _V30 + "longyiqinghui", "name": "龙漪晴晦", "style": "长辈·慈祥祖母", "gender": "女", "age": "60", "lang": "中文", "group": "alt", "note": "祖辈声线，家庭情境剧"},
        {"voice": _V30 + "longxintaofeng", "name": "龙昕桃凤", "style": "长者旁白·浑厚男", "gender": "男", "age": "58", "lang": "中文", "group": "alt", "note": "比沉稳男更厚重、语速更慢"},
        {"voice": _V30 + "longyuelinwang", "name": "龙玥麟望", "style": "亲切客服·女", "gender": "女", "age": "25", "lang": "中文", "group": "alt", "note": "标准客服腔，礼貌但有距离感"},
        {"voice": _V30 + "longbaichexuan", "name": "龙柏澈萱", "style": "磁性电台·年轻男", "gender": "男", "age": "28", "lang": "中文", "group": "alt", "note": "与磁性电台·男同风格，想更年轻选这条"},
        {"voice": _V30 + "longjiquexue", "name": "龙霁鹊雪", "style": "古风武侠·男", "gender": "男", "age": "24", "lang": "中文", "group": "alt", "note": "少侠/武将角色"},
        {"voice": _V30 + "loongolivialin", "name": "Olivia Lin", "style": "英文女声", "gender": "女", "age": "28", "lang": "英文", "group": "alt", "note": "英文音色里最柔和的一条"},
        {"voice": _V30 + "longlulanxuan", "name": "龙露岚萱", "style": "反派·女", "gender": "女", "age": "27", "lang": "中文", "group": "alt", "note": "只做角色，不做讲解"},
        {"voice": "longchuanshu_v3.6", "name": "龙川叔", "style": "川普大叔·男（系统音色）", "gender": "男", "age": "40", "lang": "中文", "group": "alt", "note": "系统音色，参数不带模型前缀；带川味的趣味角色音"},
    ],
    M31: [
        {"voice": "loongstella_v3.1", "name": "loongstella", "style": "正式播报·女", "gender": "女", "age": "", "lang": "中文", "group": "main", "note": "飒爽利落，片头/通知/结论性旁白，节奏快不拖"},
        {"voice": "longsanshu_v3.1", "name": "龙三叔", "style": "权威解说·男（主力男旁白）", "gender": "男", "age": "", "lang": "中文", "group": "main", "note": "沉稳质感，长段讲解最耐听；3.1 默认音色"},
        {"voice": "xieshurou_v3.1", "name": "谢舒柔", "style": "知性讲解·女（主力女旁白）", "gender": "女", "age": "", "lang": "中文", "group": "main", "note": "柔和自然知性，知识点讲解与步骤说明"},
        {"voice": "yeqinghe_v3.1", "name": "叶清禾", "style": "温柔陪伴·女", "gender": "女", "age": "", "lang": "中文", "group": "main", "note": "亲切温柔，鼓励反馈、答疑、陪伴式提示"},
        {"voice": "yuxiaoyun_v3.1", "name": "于小云", "style": "元气宣传·女", "gender": "女", "age": "", "lang": "中文", "group": "main", "note": "元气亲切，活动宣传与报名号召，广播感"},
        {"voice": "qiaoxiaojiao_v3.1", "name": "乔小娇", "style": "甜萌角色·女", "gender": "女", "age": "", "lang": "中文", "group": "main", "note": "俏丽可爱，吉祥物与趣味提示"},
        {"voice": "yezhiqing_v3.1", "name": "叶知晴", "style": "儿童·女童", "gender": "女", "age": "", "lang": "中文", "group": "main", "note": "轻快自然，学生角色与低龄向对白"},
        {"voice": "libai_v3.1", "name": "李白", "style": "诗词古风·男", "gender": "男", "age": "", "lang": "中文", "group": "main", "note": "古代诗仙音，古诗文朗诵与历史文化导入"},
        {"voice": "longanchong_v3.1", "name": "龙安冲", "style": "激情动员·男", "gender": "男", "age": "", "lang": "中文", "group": "main", "note": "情绪最高的一条，竞赛冲刺与活动动员"},
        {"voice": "longanyang_v3.1", "name": "龙安洋", "style": "阳光社交·男", "gender": "男", "age": "", "lang": "中文", "group": "main", "note": "阳光大男孩，同学/伙伴角色与日常对话"},
        {"voice": "longjielidou_v3.1", "name": "龙杰力豆", "style": "儿童·男童", "gender": "男", "age": "", "lang": "中文", "group": "main", "note": "天真男童音，可与女童配成姐弟"},
        {"voice": "longanlingxin_v3.1", "name": "龙安灵心", "style": "方言·女（多语种全能）", "gender": "女", "age": "", "lang": "中文/方言/外语", "group": "main", "note": "上海/广东/东北/重庆/陕西/云南/宁波/甘肃话 + 8 外语"},
        {"voice": "xunanchuan_v3.1", "name": "许南川", "style": "方言·男（多语种全能）", "gender": "男", "age": "", "lang": "中文/方言/外语", "group": "main", "note": "唯一的方言男声，与龙安灵心配成方言男女"},
        {"voice": "Abby_v3.1", "name": "Abby", "style": "英文·美式女", "gender": "女", "age": "", "lang": "英文", "group": "main", "note": "英语听力、双语术语朗读、外教角色"},
        {"voice": "Eric_v3.1", "name": "Eric", "style": "英文·英式男", "gender": "男", "age": "", "lang": "英文", "group": "main", "note": "与 Abby 配成英式/美式对话"},
        {"voice": "longanwen_v3.1", "name": "龙安温", "style": "客服助手·女", "gender": "女", "age": "", "lang": "中文", "group": "alt", "note": "优雅知性女"},
        {"voice": "longxiaoxia_v3.1", "name": "龙小夏", "style": "语音助手·女（权威）", "gender": "女", "age": "", "lang": "中文", "group": "alt", "note": "沉稳权威女"},
        {"voice": "longanlang_v3.1", "name": "龙安朗", "style": "语音助手·男", "gender": "男", "age": "", "lang": "中文", "group": "alt", "note": "清爽利落男"},
        {"voice": "baianran_v3.1", "name": "白安然", "style": "低沉纪录片·女", "gender": "女", "age": "", "lang": "中文", "group": "alt", "note": "低沉浑厚带气声"},
        {"voice": "xuyanchu_v3.1", "name": "许言初", "style": "深度专题播报·女", "gender": "女", "age": "", "lang": "中文", "group": "alt", "note": "沉稳有磁性"},
        {"voice": "guyunshu_v3.1", "name": "顾云舒", "style": "音乐电台·女", "gender": "女", "age": "", "lang": "中文", "group": "alt", "note": "成熟稳重"},
        {"voice": "yunhuanhuan_v3.1", "name": "云欢欢", "style": "高亢演讲·女", "gender": "女", "age": "", "lang": "中文", "group": "alt", "note": "高亢热情"},
        {"voice": "longanzhi_v3.1", "name": "龙安智", "style": "睿智轻熟·男", "gender": "男", "age": "", "lang": "中文", "group": "alt", "note": "睿智轻熟男"},
        {"voice": "longanhuan_v3.1", "name": "龙安欢", "style": "方言·女（备选）", "gender": "女", "age": "", "lang": "中文/方言/外语", "group": "alt", "note": "方言能力与龙安灵心相同"},
        {"voice": "longanfengyue_v3.1", "name": "龙安风悦", "style": "方言·女（备选）", "gender": "女", "age": "", "lang": "中文/方言/外语", "group": "alt", "note": "方言能力与龙安灵心相同"},
        {"voice": "longpaopao_v3.1", "name": "龙泡泡", "style": "童趣·女", "gender": "女", "age": "", "lang": "中文", "group": "alt", "note": "飞天泡泡音"},
        {"voice": "longniuniu_v3.1", "name": "龙牛牛", "style": "童趣·男童", "gender": "男", "age": "", "lang": "中文", "group": "alt", "note": "阳光男童"},
        {"voice": "longshanshan_v3.1", "name": "龙闪闪", "style": "戏剧化童声", "gender": "女", "age": "", "lang": "中文", "group": "alt", "note": "戏剧化童声"},
        {"voice": "Emily_v3.1", "name": "Emily", "style": "英文·英式女", "gender": "女", "age": "", "lang": "英文", "group": "alt", "note": "英式女声"},
        {"voice": "Luna_v3.1", "name": "Luna", "style": "英文·英式女", "gender": "女", "age": "", "lang": "英文", "group": "alt", "note": "英式女声（另一条）"},
        {"voice": "David_v3.1", "name": "David", "style": "英文·美式男", "gender": "男", "age": "", "lang": "英文", "group": "alt", "note": "美式男声"},
        {"voice": "Brian_v3.1", "name": "Brian", "style": "英文·美式男", "gender": "男", "age": "", "lang": "英文", "group": "alt", "note": "美式男声（另一条）"},
    ],
}

#: 中文名 -> (模型, 完整 voice)：手填中文名时的兜底，与下拉同源
_NAME_INDEX: dict[str, tuple[str, str]] = {
    item["name"]: (model, item["voice"]) for model, lst in VOICE_CATALOGS.items() for item in lst
}
_VOICE_INDEX: dict[str, str] = {
    item["voice"]: model for model, lst in VOICE_CATALOGS.items() for item in lst
}


def models_for_ui() -> list[dict[str, Any]]:
    """模型下拉（带各自默认音色的中文名与音色条数，前端一次拿全做联动）"""
    out = []
    for m in MODELS:
        default = m["default_voice"]
        item = dict(m)
        item["is_default"] = m["id"] == DEFAULT_MODEL
        item["voice_count"] = len(VOICE_CATALOGS.get(m["id"], []))
        entry = catalog_of(default, m["id"])
        item["default_voice_name"] = entry["name"] if entry else default
        item["default_voice_style"] = entry["style"] if entry else ""
        out.append(item)
    return out


def voices_for_ui(model: str | None = None) -> list[dict[str, Any]]:
    """某模型的音色清单；不传则返回全部模型合并（每条带 model 字段）"""
    if model:
        rows = VOICE_CATALOGS.get(str(model).strip(), [])
    else:
        rows = [dict(x, model=m) for m, lst in VOICE_CATALOGS.items() for x in lst]
    default = MODEL_DEFAULT_VOICE.get(str(model or "").strip(), DEFAULT_VOICE)
    return [{**row, "is_default": row["voice"] == default} for row in rows]


def catalog_of(voice: str, model: str) -> dict[str, Any] | None:
    """在某模型目录里查一条音色（清单外返回 None）"""
    for item in VOICE_CATALOGS.get(model, []):
        if item["voice"] == voice:
            return item
    return None


def owner_of(voice: str) -> str | None:
    """这条音色属于哪个已知模型；清单外返回 None"""
    return _VOICE_INDEX.get(voice)


def resolve_voice(raw: str | None, model: str | None = None) -> dict[str, Any]:
    """把管理员填的写法归一，并判定它与所选模型是否配对。

    返回 {voice, status, owner_model}：
      status = 'match'    属于本模型（或本模型目录内的中文名/裸后缀）
             = 'mismatch' 明确属于另一个已知模型 —— 保存要拦、运行时要回落
             = 'unknown'  两份清单都没有（管理员手填的官方其它音色）—— 一律放行
    只拦"明确错配"，不拦"未知"：官方音色远多于本清单（3.0 有 597 条、3.1 有 68 条），
    硬白名单会把合法的手填值全拒掉。
    """
    model = (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    text = str(raw or "").strip()
    if not text:
        return {"voice": MODEL_DEFAULT_VOICE.get(model, DEFAULT_VOICE), "status": "match",
                "owner_model": model}
    if text in _NAME_INDEX:                       # 中文名
        owner, full = _NAME_INDEX[text]
        return {"voice": full, "status": "match" if owner == model else "mismatch", "owner_model": owner}
    if text in _VOICE_INDEX:                      # 完整参数，目录内
        owner = _VOICE_INDEX[text]
        return {"voice": text, "status": "match" if owner == model else "mismatch", "owner_model": owner}
    # 裸后缀：3.0 的基础音色形如 <模型名>-<后缀>。补完前缀要再查一次目录 ——
    # 否则"管理员只填了 longnixiwei"这种常见写法会被误判成 unknown，跳过配对校验。
    if text.startswith(("long", "loong")) and "_v" not in text and model == M30:
        cand = f"{M30}-{text}"
        owner = _VOICE_INDEX.get(cand)
        if owner:
            return {"voice": cand, "status": "match" if owner == model else "mismatch",
                    "owner_model": owner}
        return {"voice": cand, "status": "unknown", "owner_model": None}
    return {"voice": text, "status": "unknown", "owner_model": None}


def normalize_voice(raw: str | None, model: str | None = None) -> str:
    """只要一个规范化后的 voice 参数（内部走 resolve_voice）"""
    return resolve_voice(raw, model)["voice"]


# 兼容旧引用：默认音色 = 默认模型的默认音色
DEFAULT_VOICE = MODEL_DEFAULT_VOICE[DEFAULT_MODEL]
DEFAULT_MODEL_ID = DEFAULT_MODEL
_ALL_VOICES = _VOICE_INDEX


# ══════════════════════════════════════════════════════════════
#  姓名读法校正：只处理姓氏（多音字姓氏被读错是点名播报唯一的硬伤）
#  机制是"换成同音常用字"而不是标拼音 —— 音素/SSML 支持未经验证，同音字一定读得对，
#  且只影响送合成的文本：界面显示、点名历史、积分记录里仍是原姓名。
#  收录原则：只收"作姓时读音与常见读音不同"或极易读半边的姓，且必须能找到同调常用字
#  （盖 gě、那 nā、覃 qín/tán、柏 bǎi/bó 这类没有干净同音字的宁可不收）。
#  3.1 的 hot_fix 能直接标拼音、以后接入 3.1 能力时可替掉这套土办法。
# ══════════════════════════════════════════════════════════════

COMPOUND_SURNAME_READ: dict[str, str] = {
    "万俟": "墨其", "尉迟": "玉池", "长孙": "掌孙", "单于": "缠无",
    "令狐": "灵狐", "澹台": "谈台", "阏氏": "烟支",
}

SINGLE_SURNAME_READ: dict[str, str] = {
    "单": "善", "曾": "增", "仇": "秋", "乐": "月", "区": "欧", "解": "谢",
    "查": "渣", "朴": "瓢", "翟": "宅", "郦": "丽", "宓": "福", "召": "邵",
    "句": "勾", "缪": "妙", "能": "奈", "阚": "瞰", "都": "督", "员": "运",
    "华": "话", "曲": "屈", "种": "虫", "省": "醒", "过": "郭", "纪": "己",
    "著": "助", "乜": "聂", "磨": "莫", "郗": "西", "溥": "普", "厍": "社",
    "逄": "庞", "郇": "寻", "恽": "运", "缑": "勾", "芈": "米", "仉": "掌",
    "翦": "简",
}


def fix_name_reading(name: str) -> str:
    """按姓氏词典校正姓名的播报读法（复姓优先，避免「单于」被当成「单」）"""
    text = str(name or "").strip()
    if len(text) < 2:
        return text
    if text[:2] in COMPOUND_SURNAME_READ:
        return COMPOUND_SURNAME_READ[text[:2]] + text[2:]
    if text[0] in SINGLE_SURNAME_READ:
        return SINGLE_SURNAME_READ[text[0]] + text[1:]
    return text