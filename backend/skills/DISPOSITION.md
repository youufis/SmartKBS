# 技能系统处置记录（原 D 池 → 已清空）

> 引擎只加载 `*.skill.md`，本文件不会被扫描。更新于 2026-11-28（第二轮治理收尾，分支 codex/skill-injection-governance）。

## 处置结果（2026-11-28）

- **5 个无注入点技能已归档并移出扫描目录** → `backend/skills_archive/`（缘由与恢复方式见该目录 README）：
  `daily-curator`、`code-reviewer`、`grading-essay`、`grading-short`、`precision-mode`。
  共同点：宿主链路均为 JSON 结构化输出（批改/出题/抢答/代码审查/精选卡片），按 S-GRADING 红线
  永不运行时注入；其方法论价值已由业务模板（`prompts/code_review.py`、`prompts/daily_discovery.py`、
  `ESSAY_GRADING_PROMPT`）或代码引擎（`grading_rules`）承载，无并入增量。
- **场景映射补齐**：quiz/practice/wrong-book 排除 socratic-tutor（与 exam 既有口径一致），
  DEFAULT_CONFIG 与线上 system_config.json 双写对齐。
- **companion 双注入修复**：唯一注入点收敛到 `_chat_event_generator`。
- **引擎精确化**：`compose_detail` 返回真实 fired 清单；无可注入正文时不再产出注释空壳。
- **预览同源**：`/api/skills/preview` 复用 `compose_scene_segment`（对话兜底+护栏+精确 fired）。
- **写入口校验**：`enabled_skills` 存在性校验；技能改名撞既有名当场拒（防遮蔽不回滚）。
- **UI**：技能列表只存在用技能；未接入场景并入场景映射主表并带行内原因说明。

## 引擎遗留（低优先级，未动）

- `compose.position: suffix` 解析后未实现（当前无技能使用后置）；
- `compose.requires` 仅告警不自动补齐依赖；
- `skill_engine._deep_parse` 死代码，可随下次清理删除；
- 场景串 `quiz` 被"测验分析/课堂总结"与出题链路复用，建议拆独立场景名
  （如 `quiz-analysis`/`class-summary`/`svg-generation`）以便分别控制——属行为变更，需带实验单独做。

## 已决策保留的观察项

- `resources_router.py` html-generation 注入点：有完整护栏（html_is_complete/题目回解析）且日志零失败，保留观察，不盲目摘除；
- `analytics` 场景键：排除规则保留（将来接入学情链路即生效），场景本身维持未接入——报告结构已由业务模板承载。

## V8.6.1 对话链路（知识问答）注入治理（历史，保留）

- 新增 `core/chat-conversation`（对话直答节奏），`compatible_with: [chat, companion]`，只进对话链路。
- `chat / companion` 场景改为白名单注入：三阶增强 / 分步推理 / 可视化表达不再进对话；
  配置里没有该场景规则时，`prompts._DIALOGUE_SCENE_DEFAULT` 在代码侧兜底（浅合并会整体覆盖默认值，故必须留这层）。
- 所有技能段统一加「工作方式（禁止外显）」前言；`quality-enhancer` 三个阶段也各自声明不得外显。
- 知识问答链路把身份、回答要求、技能段、参考资料全部放 system，用户原话单独一条 user
  （`backend/chat_prompts.py` + `backend/chat_intent.py`，闸门开关见系统配置 `CHAT_*`）。
