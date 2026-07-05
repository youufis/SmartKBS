"""
自我画像 Prompt 模板
生成生图 Prompt + AI 创意寄语
"""
import random
from typing import Any

# 活动类型名称映射（供学生数据展示用）
_ACTIVITY_NAMES = {
    "quiz": "随堂测验", "poll": "快速投票", "question": "课堂提问",
    "exam": "考试", "practice": "智能练习", "discussion": "分组讨论",
    "rollcall": "点名签到", "chat": "AI对话", "task": "任务",
    "learning": "学习进度", "login": "每日登录", "code": "代码练习",
    "quest": "知识闯关", "quick_quiz": "知识抢答", "course_practice": "课程练习",
    "resource_view": "资源浏览",
    "daily_discovery": "每日精选", "news_view": "热点新闻",
}


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
    student_stats = profile.get("student_stats", {})
    if teach_stats:
        prompt_parts.append(f"Teaching responsibilities: {teach_stats}.")
    if admin_stats:
        prompt_parts.append(f"Administration scope: {admin_stats}.")
    if student_stats:
        s = student_stats
        parts = []
        if s.get("total_exams", 0) > 0:
            parts.append(f"{s['total_exams']} exams")
        if s.get("total_activities", 0) > 0:
            parts.append(f"{s['total_activities']} total activities")
        if s.get("total_chats", 0) > 0:
            parts.append(f"{s['total_chats']} AI conversations")
        if s.get("total_discovery", 0) > 0:
            parts.append(f"explored {s['total_discovery']} fun facts")
        if s.get("total_news", 0) > 0:
            parts.append(f"read {s['total_news']} news articles")
        if parts:
            prompt_parts.append("Active learner with " + ", ".join(parts) + ".")

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

    # 随机化摄影/艺术参数，让每张画像观感不同
    _lighting = random.choice([
        "cinematic lighting, dramatic shadows",
        "soft golden hour light, warm atmosphere",
        "studio softbox lighting, clean and bright",
        "moody low-key lighting, mysterious vibe",
        "natural daylight, fresh and vibrant",
        "rim lighting, ethereal glow effect",
    ])
    _mood = random.choice([
        "confident smile, bright eyes looking at viewer",
        "thoughtful gaze, gentle expression",
        "energetic and cheerful, big smile",
        "calm and determined, steady eyes",
        "curious and playful, slight smirk",
        "warm and friendly, approachable look",
    ])
    _quality = random.choice([
        "professional portrait photography, 8K, highly detailed skin texture",
        "award-winning portrait shot, razor sharp focus, 4K",
        "editorial photography style, crisp details, perfect exposure",
        "high-end magazine cover portrait, flawless lighting",
    ])

    prompt_parts.append(
        f"{_mood}. {_lighting}. {_quality}. "
        "NO text, NO letters, NO words, NO watermark, NO signature, NO calligraphy."
    )

    return ". ".join(prompt_parts)


def build_portrait_comment_prompt(
    profile: dict[str, Any],
    style: str = "random",
) -> str:
    """构建 AI 创意寄语 Prompt

    Args:
        profile: 用户画像数据
        style: 风格 key

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

    # 风格名称
    style_info = PORTRAIT_STYLES.get(style, PORTRAIT_STYLES["random"])
    style_name = style_info["name"]

    # 根据角色设置身份描述
    teach_stats = profile.get("teach_stats", "")
    admin_stats = profile.get("admin_stats", "")

    # 累计统计数据
    student_stats = profile.get("student_stats", {})

    if role == 1:
        identity_desc = "一位辛勤耕耘的人民教师"
        extra = f"\n- {teach_stats}" if teach_stats else ""
        profile_section = f"【教师数据】\n- 姓名：{name}\n- 任教：{grade} {cls}\n- 当前称号：{main_title}（{points}积分）{extra}"
        role_instruction = "语气成熟从容，体现教育工作者的风范与温度"
    elif role == 0:
        identity_desc = "一位运筹帷幄的教育管理者"
        extra = f"\n- {admin_stats}" if admin_stats else ""
        profile_section = f"【管理员数据】\n- 姓名：{name}\n- 管理领域：{grade} {cls}\n- 当前称号：{main_title}（{points}积分）{extra}"
        role_instruction = "语气稳重有格局，体现管理者的视野与温度"
    else:
        identity_desc = "一位努力学习的同学"
        # 聚焦闪光点——把数据变成积极、有温度的描述
        extra_stats = ""
        if student_stats:
            sparkles = []
            s = student_stats
            # 闪光点1：坚持不懈
            if s.get("total_exams", 0) >= 3:
                sparkles.append(f"经历了{s['total_exams']}场考试的打磨，越战越勇")
            elif s.get("total_exams", 0) > 0:
                sparkles.append(f"勇敢地接受了{s['total_exams']}场考试的挑战")
            # 闪光点2：本周积极性
            if s.get("week_points", 0) >= 10:
                sparkles.append(f"本周火力全开，拿下{s['week_points']}积分")
            elif s.get("week_points", 0) > 0:
                sparkles.append(f"本周有{s['week_points']}积分入账，稳步前进")
            # 闪光点3：求知欲
            if s.get("total_chats", 0) >= 10:
                sparkles.append(f"求知欲爆棚，和AI聊了{s['total_chats']}个回合")
            elif s.get("total_chats", 0) > 0:
                sparkles.append(f"善于提问，主动与AI对话{s['total_chats']}次")
            # 闪光点4：团队协作
            if s.get("total_discussions", 0) >= 5:
                sparkles.append(f"乐于分享，在{s['total_discussions']}次讨论中发光发热")
            elif s.get("total_discussions", 0) > 0:
                sparkles.append(f"积极参与讨论，碰撞思维火花")
            # 闪光点5：迎难而上（改错题的积极面）
            if s.get("wrong_count", 0) >= 5:
                sparkles.append(f"面对{s['wrong_count']}道错题毫不退缩，正在逐个击破")
            elif s.get("wrong_count", 0) > 0:
                sparkles.append(f"认真对待每一道错题，从中汲取养分")
            # 闪光点6：资源探索
            if s.get("week_resource_views", 0) >= 10:
                sparkles.append(f"本周探索了{s['week_resource_views']}个学习资源，知识面不断拓展")
            elif s.get("total_resource_views", 0) >= 10:
                sparkles.append(f"已浏览{s['total_resource_views']}个学习资源，主动获取知识")
            elif s.get("total_resource_views", 0) > 0:
                sparkles.append(f"积极浏览学习资源，开阔视野")
            # 闪光点7：最热爱的活动
            act_detail = s.get("activity_detail", {})
            if act_detail:
                top_act = sorted(act_detail.items(), key=lambda x: -x[1])[0]
                name_cn = _ACTIVITY_NAMES.get(top_act[0], top_act[0])
                sparkles.append(f"最爱{name_cn}，已打卡{top_act[1]}次")
            if sparkles:
                extra_stats = "✨ " + "\n✨ ".join(sparkles[:4])
        if extra_stats:
            profile_section = f"【学生数据】\n🌟 {name} · {grade} {cls} · 称号「{main_title}」\n{extra_stats}"
        else:
            profile_section = f"【学生数据】\n🌟 {name} · {grade} {cls} · 称号「{main_title}」"
        role_instruction = "语气亲切有活力，像好朋友在聊天"

    prompt = f"""你是一位创意作家。根据以下用户数据，为ta创作一段"本周画像寄语"。

【关于ta】
{profile_section}
{exam_str}
{weak_str}
{strong_str}
{milestone_str}
{activity_str}
连续{streak}天在路上 · {identity_desc}

画像风格：{style_name}

【创作方向】
- 你可以用任何形式来写——一段故事、一首小诗、一段内心独白、幻想场景、对话片段……都可以
- 重点是从ta的数据中找到**最特别的发光点**，围绕它展开
- 让ta的独特之处成为作品的灵魂，而不是简单罗列数字
- 温暖真诚，让人读完觉得被看见、被肯定
- {role_instruction}

100-250字。直接写，不要前缀。"""

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
