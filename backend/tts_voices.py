# -*- coding: utf-8 -*-
"""语音合成：音色清单 + 姓名读法校正词典。

音色数据来源：2026-10-05 针对 qwen-audio-3.0-tts-flash 官方 597 条基础音色做的实测定包
（精选 15 + 替补 8，每条都用同一段课堂旁白真跑出过音频，见交付目录「音色精选15」）。
清单里只放**实测出声成功**的音色 —— 这个系列的音色与模型必须配对，跨模型混用会直接报
InvalidParameter / [cosyvoice:]Engine error [411]，所以未测过的音色一律不进下拉，
免得管理员选到一个必失败的选项。

需要换模型（例如改走 qwen-audio-3.1-tts-flash 拿方言音色）时，本清单必须整体替换：
3.0-flash 的 597 条基础音色里没有任何方言（语种列只有中文 589 + 英文 8）。
"""
from __future__ import annotations

from typing import Any

#: 已带模型名前缀的完整参数前缀（这些一律原样使用）
_FULL_PARAM_PREFIXES = ("qwen-audio-", "qwen3-tts-", "qwen-tts", "cosyvoice-")

# ── 默认模型与默认音色 ──
# 默认音色取「新闻联播·男（权威播报）」：点名是课堂权威场景，中低音权威感最贴合，
# 且它是全表唯一一条新闻联播音，短句（姓名）播报最不容易听腻。
DEFAULT_MODEL = "qwen-audio-3.0-tts-flash"
DEFAULT_VOICE = "qwen-audio-3.0-tts-flash-longnixiwei"

#: 精选 15（一种风格只留一个，女 8 : 男 7）+ 替补 8。
#: style 用于下拉标签，note 是给管理员看的取舍提示（"别拿来讲知识点"这类）。
VOICE_CATALOG: list[dict[str, Any]] = [
    # ── 精选 15 ──
    {"voice": "qwen-audio-3.0-tts-flash-longliuxulan", "name": "龙柳旭澜", "style": "标准播音·女（正式开场）",
     "gender": "女", "age": 25, "lang": "中文", "group": "main",
     "note": "字正腔圆最有台标感；长文本略端着，适合开场与通知"},
    {"voice": "qwen-audio-3.0-tts-flash-longnixiwei", "name": "龙霓曦薇", "style": "新闻联播·男（权威播报）",
     "gender": "男", "age": 38, "lang": "中文", "group": "main",
     "note": "全表唯一新闻联播音，中低音权威感强；不适合陪伴型语气。默认音色"},
    {"voice": "qwen-audio-3.0-tts-flash-longhuiyanxing", "name": "龙辉焱杏", "style": "知识讲解·沉稳男（主力旁白）",
     "gender": "男", "age": 42, "lang": "中文", "group": "main",
     "note": "节奏稳、耐听，微课主讲男声首选"},
    {"voice": "qwen-audio-3.0-tts-flash-longsonglinwang", "name": "龙松麟望", "style": "磁性电台·男（情感慢读）",
     "gender": "男", "age": 36, "lang": "中文", "group": "main",
     "note": "气声多、近讲感，配慢节奏背景音更好"},
    {"voice": "qwen-audio-3.0-tts-flash-longrongzhihe", "name": "龙蓉芷荷", "style": "电台质感·女（课文美读）",
     "gender": "女", "age": 24, "lang": "中文", "group": "main",
     "note": "电台质感里最干净的一条，长段不累"},
    {"voice": "qwen-audio-3.0-tts-flash-longlanghongmo", "name": "龙朗虹沫", "style": "温柔陪伴·女（鼓励反馈）",
     "gender": "女", "age": 25, "lang": "中文", "group": "main",
     "note": "语速偏软，答题鼓励可用，正式播报别用"},
    {"voice": "qwen-audio-3.0-tts-flash-longqinghuilang", "name": "龙晴辉朗", "style": "知性讲解·女（主力女声）",
     "gender": "女", "age": 24, "lang": "中文", "group": "main",
     "note": "清晰利落又亲和，女声主讲首选，可与沉稳男交替"},
    {"voice": "qwen-audio-3.0-tts-flash-longmohuiling", "name": "龙沫晖翎", "style": "御姐权威·女（角色/结论）",
     "gender": "女", "age": 26, "lang": "中文", "group": "main",
     "note": "气场强适合下定论，日常讲解偏冷"},
    {"voice": "qwen-audio-3.0-tts-flash-longyiyusong", "name": "龙熠瑜松", "style": "活泼互动·女（课堂气氛）",
     "gender": "女", "age": 24, "lang": "中文", "group": "main",
     "note": "情绪上扬，短句最佳；点名播报想活泼些可换这条"},
    {"voice": "qwen-audio-3.0-tts-flash-longjufuhe", "name": "龙菊芙荷", "style": "呆萌女童（吉祥物/低龄）",
     "gender": "女", "age": 7, "lang": "中文", "group": "main",
     "note": "只适合短台词与趣味桥段，别拿来讲知识点"},
    {"voice": "qwen-audio-3.0-tts-flash-longxuanyixiao", "name": "龙暄漪霄", "style": "二次元男童（学生角色）",
     "gender": "男", "age": 7, "lang": "中文", "group": "main",
     "note": "与呆萌女童可配成双吉祥物，男女童分工清楚"},
    {"voice": "qwen-audio-3.0-tts-flash-longyingdielin", "name": "龙莹蝶琳", "style": "热血激昂·男（高潮动员）",
     "gender": "男", "age": 42, "lang": "中文", "group": "main",
     "note": "全表情绪最高的一条，放在比赛/颁奖等高潮处"},
    {"voice": "qwen-audio-3.0-tts-flash-longxiaqueshan", "name": "龙霞雀杉", "style": "搞怪逗趣·男（喜剧担当）",
     "gender": "男", "age": 25, "lang": "中文", "group": "main",
     "note": "口语感强，正式讲解慎用"},
    {"voice": "qwen-audio-3.0-tts-flash-longrongxianyu", "name": "龙蓉弦煜", "style": "古风宫廷·女（历史演绎）",
     "gender": "女", "age": 26, "lang": "中文", "group": "main",
     "note": "咬字带腔调，适合古风/历史题材"},
    {"voice": "qwen-audio-3.0-tts-flash-loongadriangao", "name": "Adrian Gao", "style": "英文叙述·男（双语片段）",
     "gender": "男", "age": 22, "lang": "英文", "group": "main",
     "note": "英文术语朗读、双语片头；纯中文场景不必选"},
    # ── 替补 8（需要时替换主选） ──
    {"voice": "qwen-audio-3.0-tts-flash-longyiqinghui", "name": "龙漪晴晦", "style": "长辈·慈祥祖母",
     "gender": "女", "age": 60, "lang": "中文", "group": "alt",
     "note": "祖辈声线，家庭情境剧"},
    {"voice": "qwen-audio-3.0-tts-flash-longxintaofeng", "name": "龙昕桃凤", "style": "长者旁白·浑厚男",
     "gender": "男", "age": 58, "lang": "中文", "group": "alt",
     "note": "比沉稳男更厚重、语速更慢"},
    {"voice": "qwen-audio-3.0-tts-flash-longyuelinwang", "name": "龙玥麟望", "style": "亲切客服·女",
     "gender": "女", "age": 25, "lang": "中文", "group": "alt",
     "note": "标准客服腔，礼貌但有距离感"},
    {"voice": "qwen-audio-3.0-tts-flash-longbaichexuan", "name": "龙柏澈萱", "style": "磁性电台·年轻男",
     "gender": "男", "age": 28, "lang": "中文", "group": "alt",
     "note": "与磁性电台·男同风格，想更年轻选这条"},
    {"voice": "qwen-audio-3.0-tts-flash-longjiquexue", "name": "龙霁鹊雪", "style": "古风武侠·男",
     "gender": "男", "age": 24, "lang": "中文", "group": "alt",
     "note": "少侠/武将角色，与古风宫廷女配成对手戏"},
    {"voice": "qwen-audio-3.0-tts-flash-loongolivialin", "name": "Olivia Lin", "style": "英文女声",
     "gender": "女", "age": 28, "lang": "英文", "group": "alt",
     "note": "英文音色里最柔和的一条"},
    {"voice": "qwen-audio-3.0-tts-flash-longlulanxuan", "name": "龙露岚萱", "style": "反派·女",
     "gender": "女", "age": 27, "lang": "中文", "group": "alt",
     "note": "只做角色，不做讲解"},
    {"voice": "longchuanshu_v3.6", "name": "龙川叔", "style": "川普大叔·男（系统音色）",
     "gender": "男", "age": 40, "lang": "中文", "group": "alt",
     "note": "系统音色，voice 直接填 longchuanshu_v3.6 不带模型前缀；带川味的趣味角色音"},
]

#: 中文名/裸后缀 -> 完整 voice 参数（手填时的兜底，与下拉同源）
_NAME_TO_VOICE = {item["name"]: item["voice"] for item in VOICE_CATALOG}


def normalize_voice(raw: str | None, model: str | None = None) -> str:
    """把管理员填的各种写法归一成 API 认的 voice 参数。

    接受：完整参数（原样）/ 裸后缀 longnixiwei / 中文名 龙霓曦薇 / 空（回默认）。
    裸后缀补模型前缀，是因为下拉之外管理员常手填半截；系统音色（longchuanshu_v3.6
    这类带 _v3 版本号的）本身就不带前缀，原样放行。
    """
    model = (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    text = str(raw or "").strip()
    if not text:
        return DEFAULT_VOICE
    if text in _NAME_TO_VOICE:
        return _NAME_TO_VOICE[text]                       # 中文名
    if text.startswith(_FULL_PARAM_PREFIXES):
        return text                                       # 已是完整参数
    if text.startswith(("long", "loong")):
        # 系统音色（longchuanshu_v3.6 这类带版本号的）本就不带模型前缀，原样放行；
        # 其余按裸后缀处理，补上当前模型的前缀。
        return text if "_v" in text else f"{model}-{text}"
    return text


def voices_for_ui() -> list[dict[str, Any]]:
    """给配置页下拉用的清单（含"是否默认"标记，前端据此排序与标注）"""
    return [{**item, "is_default": item["voice"] == DEFAULT_VOICE} for item in VOICE_CATALOG]


# ══════════════════════════════════════════════════════════════
#  姓名读法校正：只处理姓氏（多音字姓氏被读错是点名播报唯一的硬伤）
#
#  机制是"换成同音常用字"而不是标注拼音 —— qwen-audio 系列对 SSML/音素标注的支持
#  未经验证，同音字替换则一定能读对，且只影响送合成的文本：界面显示、点名历史、
#  积分记录里仍是原姓名。
#
#  收录原则：只收「作姓时读音与常见读音不同」或「极易被读半边」的姓，
#  并且必须能找到**同调**常用字（找不到干净同音字的宁可不收，例如 盖 gě、那 nā、
#  覃 qín/tán 存疑、柏 bǎi/bó 存疑 —— 收进去反而把本来读对的姓改坏）。
#  名字里的多音字（乐、佳、期…）不动：绝大多数读对，替换错的风险大于收益。
# ══════════════════════════════════════════════════════════════

#: 复姓（取前两字匹配，优先于单姓）
COMPOUND_SURNAME_READ: dict[str, str] = {
    "万俟": "墨其",   # Mòqí
    "尉迟": "玉池",   # Yùchí
    "长孙": "掌孙",   # Zhǎngsūn
    "单于": "缠无",   # Chánwú
    "令狐": "灵狐",   # Línghú
    "澹台": "谈台",   # Tántái
    "阏氏": "烟支",   # Yānzhī
}

#: 单姓（取首字匹配）
SINGLE_SURNAME_READ: dict[str, str] = {
    "单": "善",     # shàn（常读 dān）
    "曾": "增",     # zēng（常读 céng）
    "仇": "秋",     # qiū（常读 chóu）
    "乐": "月",     # yuè（常读 lè）
    "区": "欧",     # ōu（常读 qū）
    "解": "谢",     # xiè（常读 jiě）
    "查": "渣",     # zhā（常读 chá）
    "朴": "瓢",     # piáo（常读 pǔ）
    "翟": "宅",     # zhái（常读 dí）
    "郦": "丽",     # lì（易读 lì 半边错成 zhǐ）
    "宓": "福",     # fú（易读 mì）
    "召": "邵",     # shào（常读 zhào）
    "句": "勾",     # gōu（常读 jù）
    "缪": "妙",     # miào（常读 móu/miù）
    "能": "奈",     # nài（常读 néng）
    "阚": "瞰",     # kàn（易读 hǎn）
    "都": "督",     # dū（易读 dōu）
    "员": "运",     # yùn（易读 yuán）
    "华": "话",     # huà（易读 huá）
    "曲": "屈",     # qū（易读 qǔ）
    "种": "虫",     # chóng（易读 zhǒng）
    "省": "醒",     # xǐng（易读 shěng）
    "过": "郭",     # guō（易读 guò）
    "纪": "己",     # jǐ（易读 jì）
    "著": "助",     # zhù（易读 zhù/zhe 混）
    "乜": "聂",     # niè（易读 miē）
    "磨": "莫",     # mò（易读 mó）
    "郗": "西",     # xī（易读 chī）
    "溥": "普",     # pǔ（易读 bó）
    "厍": "社",     # shè（易读 kù）
    "逄": "庞",     # páng（易读 féng）
    "郇": "寻",     # xún（易读 huàn）
    "恽": "运",     # yùn（易读 huī）
    "缑": "勾",     # gōu（易读 hòu）
    "芈": "米",     # mǐ（易读 wěi）
    "仉": "掌",     # zhǎng（易读 jǐ）
    "翦": "简",     # jiǎn（生僻，易读 qiān）
}


def fix_name_reading(name: str) -> str:
    """按姓氏词典校正姓名的播报读法（只改文本，不改显示）。

    复姓优先匹配，避免「单于」被当成「单」+「于」二次替换成"善无"。
    """
    text = str(name or "").strip()
    if len(text) < 2:
        return text
    if text[:2] in COMPOUND_SURNAME_READ:
        return COMPOUND_SURNAME_READ[text[:2]] + text[2:]
    if text[0] in SINGLE_SURNAME_READ:
        return SINGLE_SURNAME_READ[text[0]] + text[1:]
    return text


def catalog_of(voice: str) -> dict[str, Any] | None:
    """查音色在清单里的元数据（日志与前端展示用，手填的清单外音色返回 None）"""
    for item in VOICE_CATALOG:
        if item["voice"] == voice:
            return item
    return None