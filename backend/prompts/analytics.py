"""
学情分析相关 Prompt
"""

TEACHING_SUGGESTIONS_PROMPT = """请根据以下班级的多维度数据，生成具体可操作的教学建议。

## 班级数据

### 基本信息
- 年级/班级：{grade}{cls}班
- 学生人数：{total_students}人
- 学科：{subject}

### 课堂积分
- 有积分记录的学生数：{score_count}人
- 总积分：{score_total}
- 平均积分：{score_avg}
- 最高积分：{score_max}
- 最低积分：{score_min}

### 点名情况
- 总点名次数：{rollcall_total}次
- 回答正确：{rollcall_correct}次
- 回答错误：{rollcall_wrong}次
- 正确率：{rollcall_rate}%

### 考试情况
{exam_text}

### 任务完成
- 活跃任务数：{active_tasks}
- 已提交学生数：{submitted_students}
- 任务参与率：{task_rate}%

## 输出要求

请以 Markdown 格式生成以下内容：

### 📊 班级整体评估
对班级当前学习状态进行一句话概括性评价。

### 🎯 具体教学建议（2-4条）
每条建议必须包含：
- **建议标题**：简明扼要
- **建议内容**：具体可操作的做法，包含实施步骤
- **预期效果**：实施后的预期改善

### ⚡ 重点关注学生
如果有点名或积分数据，指出需要重点关注的学生类型（如：积分偏低、点名正确率低的学生），并给出分层教学建议。

### 📋 下一阶段教学计划建议
根据考试情况和任务完成情况，建议下一阶段的教学重点和节奏调整。

## 注意事项
1. 建议必须具体、可执行，不要泛泛而谈
2. 结合{subject}学科特点
3. 语气专业、务实
4. 直接以内容开头，不要出现"根据提供的数据"等冗余表述
"""

# ── 班级学情分析报告 ──
CLASS_ANALYSIS_PROMPT = """请根据以下班级数据，生成一份专业的学情分析报告。

班级：{grade}{cls}班
学生人数：{total_students}

【课堂积分】
有积分记录的学生数：{score_count}
总积分：{score_total}
平均积分：{score_avg}
最高积分：{score_max}

【点名情况】
总点名次数：{rollcall_total}
回答正确次数：{rollcall_correct}
回答错误次数：{rollcall_wrong}

【考试情况】
{exam_lines}

【任务完成】
活跃任务数：{active_tasks}
已提交学生数：{submitted_students}

请生成包含以下内容的分析报告（以 Markdown 格式输出）：
1. 📊 **班级整体情况**：对该班级的学习状态进行总体评价
2. 📈 **学习亮点**：指出表现突出的方面
3. ⚠️ **待改进之处**：指出需要加强的方面
4. 💡 **教学建议**：给出具体的教学改进建议
"""

# ── 学生个人学情分析 ──
STUDENT_ANALYSIS_PROMPT = """请根据以下学生数据，生成一份个性化的学情分析报告。

学生：{student_name}
班级：{student_grade}{student_class}

【考试成绩】
{exam_text}

【课堂积分】累计 {total_score} 分
【点名情况】共被点名 {rc_total} 次，回答正确 {rc_correct} 次
【任务完成】已提交 {task_count} 个任务
【AI 对话】共 {chat_count} 次

请生成（Markdown 格式）：
1. 📊 **学习概况**
2. 💪 **优势与进步**
3. ⚠️ **需要加强的方面**
4. 🎯 **下阶段学习建议**
"""

# ── 教学建议（简化版，用于教师端建议表格） ──
TEACHING_ADVICE_PROMPT = """请根据以下教学数据，为{grade}{class_num}班生成具体的教学建议。

【班级概况】
年级：{grade}
班级：{class_num}班
学生人数：{total_students}

【课堂积分】
有积分记录学生数：{score_count}
总积分：{score_total}
平均积分：{score_avg}

【点名情况】
总点名次数：{rc_total}
回答正确：{rc_correct}
正确率：{rc_rate}%

【考试情况】
{exam_text}

【任务情况】
活跃任务数：{active_tasks}
已提交学生数：{submitted}

请生成3-5条具体的教学建议，每行一条，以"1. "开头。"""
