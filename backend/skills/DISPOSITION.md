# 技能系统待处置清单 (D 池)

> 引擎只加载 `*.skill.md`，本文件不会被扫描。更新于 2026-09-29（技能系统审计收尾）。

## 当前无注入点、实际不生效的技能（4 个）
| 技能 | 声明场景 | 不生效原因 | 处置选项 |
|---|---|---|---|
| `daily-curator` | daily-discovery / news | P0 摘除 daily-discovery 注入(与 json_mode 冲突)；news 从未有注入点 | 接线自由文本场景 / 停用 / 删除 |
| `code-reviewer` | code-review / code-generation | 代码审查为 JSON 输出端点，按 S-GRADING 红线刻意不注入 | 重写为无格式指令版再接线，或保留待未来 |
| `grading-essay` | exam-grading / practice-grading | 判分 JSON 端点，历史事故(S-GRADING)排除区 | 同上；接线前必须做"只含评分维度、不含输出格式指令"改造 |
| `grading-short` | exam-grading / interaction-grading / practice-grading | 同上 | 同上 |

另：`precision-mode` 已限定评分场景（本轮 c0ad0fe），在评分端点接线技能前处于休眠，属预期设计。

## 引擎遗留（低优先级）
- `compose.position: suffix` 解析后未实现（当前无技能使用后置）；
- `compose.requires` 仅告警不自动补齐依赖；
- `skill_engine._deep_parse` 已成死代码（B 重写解析器后无调用方），可随下次清理删除；
- 场景串 `quiz` 被"题目解析/总结"(interaction×3、question×1) 与"试题 SVG 生成"(question×1) 复用，建议 SVG 拆独立场景名（如 `svg-generation`）以便分别控制注入。

## 已决策保留的观察项
- `resources_router.py` html-generation 注入点：有完整护栏（html_is_complete/题目回解析）且日志零失败，保留观察，不盲目摘除。
