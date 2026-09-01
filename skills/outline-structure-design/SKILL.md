---
id: outline-structure-design
version: 1.0.0
operation: create_structure
readsSlotTypes: []
summary: 为完整原文的大纲任务建立一个根容器和一个可审核的大纲槽位。
requiredSections: [S1]
---

# 全篇大纲任务结构 Skill

## S1. 固定结构

本模板的结构固定为两层：

- 根槽位 `outline_document`，类型 `outline_document`，`parentId` 为 `null`；
- 内容槽位 `story_outline`，类型 `story_outline`，父槽位为 `outline_document`。

`story_outline` 的 instruction 写明：从完整原文提取 8–30 个编号小节的执行规划，
每节包含出场、目标、冲突、结束状态；只写规划，不写正文。

两个槽位都不声明依赖。完成后一次性调用 `complete_assignment` 提交完整结构。
