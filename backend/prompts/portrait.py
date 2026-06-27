"""
自我画像 Prompt 模板
生成生图 Prompt + AI 创意寄语
"""
import random
from typing import Any


# ── 预定义风格列表（含中英文描述） ──

PORTRAIT_STYLES = {
    "magic_academy": {
        "name": "魔法学院",
        "desc_cn": "魔法学院的学徒风格，身穿魔法袍，手持知识法杖，背景是星空魔法阵",
        "desc_en": "Harry Potter style magic academy student, wearing a wizard robe and holding a knowledge wand, standing in a starry magic circle background, mystical atmosphere",
    },
    "cyber_scholar": {
        "name": "赛博学霸",
        "desc_cn": "赛博朋克风的科技少年，霓虹灯光效，数字代码瀑布背景",
        "desc_en": "Cyberpunk style tech genius, neon lighting effects, digital code waterfall background, futuristic atmosphere, holographic displays floating around",
    },
    "chinese_ink": {
        "name": "国风墨韵",
        "desc_cn": "水墨丹青风格的文人雅士，毛笔书法和山水画背景",
        "desc_en": "Traditional Chinese ink wash painting style scholar, elegant brush strokes, misty mountain and flowing water background, classical oriental aesthetics",
    },
    "space_explorer": {
        "name": "星际探险",
        "desc_cn": "在知识宇宙中漫游的星际探险家，星河星云背景",
        "desc_en": "Space explorer traveling through the universe of knowledge, wearing a futuristic space suit, surrounded by colorful nebula and starry galaxy, cosmic atmosphere",
    },
    "anime_hero": {
        "name": "热血漫画",
        "desc_cn": "日系热血动漫风格，战斗姿态，速度线和夸张特效",
        "desc_en": "Japanese anime style heroic character, dynamic action pose, speed lines and dramatic special effects, manga comic style, energetic and passionate",
    },
    "fairy_spirit": {
        "name": "童话精灵",
        "desc_cn": "森林中的精灵学霸，精灵耳朵，魔法光芒环绕",
        "desc_en": "Fantasy forest elf scholar, pointed ears, glowing with magical light, surrounded by luminous fireflies and ancient trees, ethereal and dreamy atmosphere",
    },
    "steampunk": {
        "name": "蒸汽朋克",
        "desc_cn": "蒸汽朋克风的发明家，齿轮和铜色机械装饰，复古科技感",
        "desc_en": "Steampunk inventor, brass and copper mechanical gears, vintage laboratory setting, Victorian era technology aesthetic, warm amber lighting",
    },
    "pixel_world": {
        "name": "像素世界",
        "desc_cn": "复古8-bit像素游戏风格，像素块构成的人物和场景",
        "desc_en": "Retro 8-bit pixel art style game character, blocky pixel graphics, vintage video game aesthetic, bright limited color palette, nostalgic",
    },
    "dunhuang": {
        "name": "敦煌飞天",
        "desc_cn": "敦煌壁画风格的古典人物，飘带飞舞，古典矿物色调",
        "desc_en": "Dunhuang Mogao Caves mural style, classical flying Apsara figure, flowing silk ribbons, mineral pigment colors, ancient Chinese Buddhist art aesthetic",
    },
    "aurora_dream": {
        "name": "极光幻境",
        "desc_cn": "极光下的追梦少年，冰晶和极光质感，梦幻冷色调",
        "desc_en": "Dreamer under the aurora borealis, crystal ice formations, shimmering northern lights in the sky, dreamy cold color palette, ethereal winter wonderland",
    },
    "superhero": {
        "name": "超级英雄",
        "desc_cn": "美式超级英雄风格，披风战衣，城市天际线背景",
        "desc_en": "American comic superhero style, wearing a distinctive cape and costume, standing on a skyscraper overlooking the city skyline, dramatic heroic pose",
    },
    "medieval_knight": {
        "name": "圣殿骑士",
        "desc_cn": "中世纪骑士风格，铠甲和纹章，图书馆或城堡背景",
        "desc_en": "Medieval knight scholar, shining armor with academic emblems, standing in an ancient library filled with books, dramatic Renaissance painting style lighting",
    },
    "cyber_faerie": {
        "name": "赛博精灵",
        "desc_cn": "赛博朋克与精灵结合的奇幻风格，机械翅膀和霓虹纹路",
        "desc_en": "Cyberpunk fairy fusion, holographic wings with circuit patterns, neon glowing tattoos, magical-mechanical hybrid aesthetic, synthwave color palette",
    },
    "ocean_explorer": {
        "name": "深海探秘",
        "desc_cn": "深海探险家风格，潜水服和海洋生物，蓝色调",
        "desc_en": "Deep sea explorer, diving suit with advanced tech, surrounded by bioluminescent sea creatures and coral reefs, underwater lighting, ocean blue atmosphere",
    },
    "time_traveler": {
        "name": "时光旅者",
        "desc_cn": "穿越时空的旅人，不同时代的元素融合，钟表齿轮元素",
        "desc_en": "Time traveler blending elements from multiple eras, floating clock gears and pocket watches, surreal surrealist style, warm vintage tones with cool futuristic accents",
    },
    "random": {
        "name": "随机创意",
        "desc_cn": "由 AI 自由发挥创意风格",
        "desc_en": "Random creative style, choose one of the above styles randomly or create a unique blend, surreal and imaginative",
    },
}

# ── 评论体裁列表 ──

COMMENT_GENRES = [
    "武侠风格——以武林侠客的口吻描述学生的学习进境，使用「内力」「招式」「功法」等武侠术语",
    "星际史诗——以太空歌剧的叙事风格，将学习比作探索未知星域", 
    "古风诗赋——用文言文或诗词的形式，典雅地评价学生的表现",
    "马戏表演——以马戏团主持人的热烈口吻，夸张地赞美学生的「表演」",
    "奇幻冒险——以 RPG 游戏旁白的风格，描述「勇者」的成长之旅",
    "电影预告——用电影预告片的磁性嗓音和镜头语言，预告「大片」的上映",
    "治愈系——温柔的治愈风格，像春日暖阳般温暖鼓励学生",
    "体育解说——以激情澎湃的体育解说员口吻，解说学生的「精彩表现」",
    "歌词改编——改编热门歌曲的歌词，把学习历程唱出来",
    "AI 观察报告——以 AI 系统检测报告的格式，一本正经地分析学生数据",
    "童话故事——用「从前有个…」的童话叙事风格，讲述学生的成长故事",
    "网络热梗——用轻松幽默的网络流行语和梗，吐槽中带着鼓励",
    "内心独白——以学生的内心 OS 形式，展现自信乐观的自我对话",
    "侦探推理——化身为名侦探，推理出「学霸养成的真相」",
    "天气预报——以天气预报的形式播报「学习气象」，幽默比喻学习状态",
]


def build_portrait_image_prompt(
    profile: dict[str, Any],
    style: str = "random",
    extra_requirements: str = "",
) -> str:
    """构建生图 Prompt（英文，供通义万相使用）

    Args:
        profile: 用户画像数据
        style: 风格 key
        extra_requirements: 额外要求

    Returns:
        英文生图 Prompt
    """
    name = profile.get("name", "用户")
    grade = profile.get("grade", "")
    cls = profile.get("class", "")
    role = profile.get("role", 2)
    role_name = profile.get("role_name", "用户")
    main_title = profile.get("titles", {}).get("main", "初窥门径")
    points = profile.get("total_points", 0)
    streak = profile.get("streak_days", 0)
    gender = profile.get("gender", "")

    # 弱点描述
    weakness = profile.get("weakness", [])
    weak_str = ""
    if weakness:
        weak_str = ", ".join([f"struggling with {w['kp']}" for w in weakness[:2]])

    # 优势描述
    strength = profile.get("strength", [])
    strong_str = ""
    if strength:
        strong_str = ", ".join([s.get("kp", "") for s in strength[:2]])

    # 选择风格
    style_info = PORTRAIT_STYLES.get(style, PORTRAIT_STYLES["random"])
    style_desc = style_info["desc_en"]

    # 根据角色设置身份称谓
    if role == 1:
        identity = "a confident Chinese teacher, professional educator"
    elif role == 0:
        identity = "a capable Chinese administrator, educational manager"
    else:
        identity = "a Chinese student, young learner"

    # 性别描述
    gender_desc = {"male": "male", "female": "female"}.get(gender, "")
    identity_with_gender = identity
    if gender_desc:
        identity_with_gender = f"{gender_desc} {identity}"

    prompt_parts = [
        f"Masterpiece portrait of {identity_with_gender}, photorealistic style, highly detailed face and skin texture.",
        f"Name: {name}, {role_name}",
    ]
    if grade or cls:
        prompt_parts.append(f"Department: {grade} {cls}.")
    prompt_parts.append(f"Title: '{main_title}', achievement points: {points}.")
    teach_stats = profile.get("teach_stats", "")
    admin_stats = profile.get("admin_stats", "")
    if teach_stats:
        prompt_parts.append(f"Teaching responsibilities: {teach_stats}.")
    if admin_stats:
        prompt_parts.append(f"Administration scope: {admin_stats}.")

    if streak > 0:
        prompt_parts.append(f"Continuous study streak: {streak} days.")

    if weak_str:
        prompt_parts.append(f"Background subtly hints at areas of focus: {weak_str}.")
    if strong_str:
        prompt_parts.append(f"Atmosphere reflects strength in: {strong_str}.")

    if style_desc:
        prompt_parts.append(f"Art style: {style_desc}.")

    if extra_requirements:
        prompt_parts.append(extra_requirements)

    prompt_parts.append(
        "Friendly, confident expression, bright eyes looking at viewer. "
        "Cinematic lighting, professional portrait photography, soft focus background, 8K quality. "
        "NO text, NO letters, NO words, NO watermark, NO signature, NO calligraphy in the image."
    )

    return ". ".join(prompt_parts)


def build_portrait_comment_prompt(
    profile: dict[str, Any],
    style: str = "random",
    genre_hint: str = "",
) -> str:
    """构建 AI 创意寄语 Prompt

    Args:
        profile: 用户画像数据
        style: 风格 key
        genre_hint: 指定体裁，留空随机

    Returns:
        LLM 调用 Prompt
    """
    name = profile.get("name", "用户")
    grade = profile.get("grade", "")
    cls = profile.get("class", "")
    role = profile.get("role", 2)
    role_name = profile.get("role_name", "用户")
    main_title = profile.get("titles", {}).get("main", "初窥门径")
    points = profile.get("total_points", 0)
    streak = profile.get("streak_days", 0)

    # 考试数据
    exams = profile.get("recent_exams", {})
    exam_str = ""
    if exams.get("count", 0) > 0:
        exam_str = f"近期{exams['count']}场考试平均{exams['avg']}分，趋势{exams.get('trend', '稳定')}"

    # 薄弱点
    weakness = profile.get("weakness", [])
    weak_str = ""
    if weakness:
        items = [f"{w['kp']}" for w in weakness[:3]]
        weak_str = f"正在攻克：{'、'.join(items)}"

    # 优势
    strength = profile.get("strength", [])
    strong_str = ""
    if strength:
        items = [s.get("kp", "") for s in strength[:2]]
        strong_str = f"擅长领域：{'、'.join(items)}"

    # 里程碑
    milestones = profile.get("milestones", [])
    milestone_str = ""
    if milestones:
        milestone_str = "、".join(milestones[:2])

    # 活动数据
    activity_str = _get_activity_summary(profile.get("username", ""))

    # 随机选择体裁（如果未指定）
    if not genre_hint:
        genre_hint = random.choice(COMMENT_GENRES)

    # 风格名称
    style_info = PORTRAIT_STYLES.get(style, PORTRAIT_STYLES["random"])
    style_name = style_info["name"]

    # 根据角色设置身份描述
    teach_stats = profile.get("teach_stats", "")
    admin_stats = profile.get("admin_stats", "")

    if role == 1:
        identity_desc = "一位辛勤耕耘的人民教师"
        extra = f"\n- {teach_stats}" if teach_stats else ""
        profile_section = f"【教师数据】\n- 姓名：{name}\n- 任教：{grade} {cls}\n- 当前称号：{main_title}（{points}积分）{extra}"
        role_instruction = "- 以教师身份来写，语气可以更成熟、从容，体现教育工作者的风范\n- 称呼「你」即可"
    elif role == 0:
        identity_desc = "一位运筹帷幄的教育管理者"
        extra = f"\n- {admin_stats}" if admin_stats else ""
        profile_section = f"【管理员数据】\n- 姓名：{name}\n- 管理领域：{grade} {cls}\n- 当前称号：{main_title}（{points}积分）{extra}"
        role_instruction = "- 以管理员身份来写，语气稳重、有格局，体现管理者的视野\n- 称呼「你」即可"
    else:
        identity_desc = "一位努力学习的同学"
        profile_section = f"【学生数据】\n- 姓名：{name}\n- 年级/班级：{grade} {cls}\n- 当前称号：{main_title}（{points}积分）"
        role_instruction = "- 以学生身份来写，语气亲切、有活力\n- 称呼「你」即可"

    prompt = f"""你是一个创意写作大师。根据以下用户数据，写一段有趣、温暖、有创意、激励人的"本周寄语"。

{profile_section}
- 连续学习：{streak}天
- {exam_str}
- {weak_str}
- {strong_str}
- 近期成就：{milestone_str}
- {activity_str}
- 角色身份：{identity_desc}

【本周画像风格】
{style_name}

【写作要求】
- 体裁：{genre_hint}
- 融入以上真实的个人数据，让用户感到"这是专门写给我的"
- 要有具体的数字和细节，不要空洞的鼓励
- 语气真诚、生动、有画面感、有创意
- 长度 100-250 字
- 适当使用 emoji 增加趣味
- {role_instruction}
- 如果使用了武侠/星际等体裁，要保持一致性

直接返回寄语内容，不要有任何解释或前缀。"""

    return prompt


def _get_activity_summary(username: str) -> str:
    """获取学生的活动参与摘要"""
    try:
        from backend.database import execute_query
        rows = execute_query(
            """SELECT activity_type, COUNT(*) as cnt
               FROM reward_history
               WHERE student_username=? AND created_at >= date('now', '-30 days')
               GROUP BY activity_type
               ORDER BY cnt DESC
               LIMIT 5""",
            (username,),
        )
        if rows:
            activities = [f"{r[0]}{r[1]}次" for r in rows]
            return f"近30天活跃：{'、'.join(activities)}"
    except Exception:
        pass
    return ""


def get_random_style() -> tuple[str, str]:
    """随机返回一个风格 (key, name)"""
    keys = [k for k in PORTRAIT_STYLES.keys() if k != "random"]
    key = random.choice(keys)
    return key, PORTRAIT_STYLES[key]["name"]
