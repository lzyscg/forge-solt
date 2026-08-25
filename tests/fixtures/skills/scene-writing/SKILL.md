---
id: scene-writing
version: 1.0.0
operation: fill_slot
slotTypes: [scene]
summary: 通过可见行动与信息变化推进单个场景，不做心理解释。
requiredSections: [S1, S2, S6]
---

# 场景写作 Skill

## S1. 理解槽位目标

读取本槽位的 instruction，明确这一场景要完成的情节推进。

## S2. 读取前置状态

用 read_slot 读取依赖槽位的结尾状态，首段需与之衔接。

## S6. 提交前自检

检查字数区间，检查正文中没有 Markdown 小标题。
