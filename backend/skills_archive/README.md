# 已归档技能（不加载、不注入）

本目录在 `backend/skills/` 扫描范围之外，这些 .skill.md 仅作设计沿革保留。

- 2026-11-28 技能治理复核结论：以下技能的核心价值已被业务 prompt 模板或代码引擎承载，
  且其宿主链路均为 JSON 结构化输出（批改/出题/抢答），运行时注入有历史事故风险，故移出技能库：
  - precision-mode / grading-essay / grading-short —— S-GRADING：判分口径已集中在
    `backend/grading_rules.py` + 批改模板（维度/权重/分档更精确）；
  - code-reviewer —— `backend/prompts/code_review.py` 已含完整 6 维度细则与 JSON schema；
  - daily-curator —— `backend/prompts/daily_discovery.py` 已含多样性/趣味性/字段口径。

恢复某技能 = 把文件挪回 `backend/skills/` 并删除 frontmatter 的 `status: archived` 行；
仅挪回但不删 status 的，引擎三层拦截（入口/解析/compose）仍保证其永不注入。
