---
id: chapter-structure-design
version: 1.1.0
operation: create_structure
readsSlotTypes: []
summary: 依据全篇执行大纲设计 story → section 槽位树，只设计生产结构，不写正文。
requiredSections: [S1, S2, S3, S5]
---

# 整篇故事结构设计 Skill

你的产出是一棵槽位树，不是正文：一个 `story` 根容器、一个 `title`，以及
**8–30 个 `section` 内容槽位**。每个 section 的 instruction 都必须对应
`outline_blueprint` 中一个编号小节。

## S1. 读取全篇大纲

用 `read_task_input` 读取 `outline_blueprint`，确认：

1. 编号小节总数与顺序；
2. 每节发生什么、改变什么、停在哪里；
3. 出场人物、冲突与信息控制；
4. 结尾如何兑现。

不要新增大纲里没有的事件或设定。

## S2. 建立 section

为大纲每个编号小节建立一个 section，数量一一对应且为 8–30 个。
section 的 instruction 写清：发生什么、改变什么、停在哪里；必要时加入出场、冲突、
信息控制和节拍。instruction 是规划，不能写成可直接复制的正文。

## S3. 依赖与顺序

- section 按编号顺序排列并链式依赖：第二节依赖第一节，依次类推；
- title 的阅读顺序在最前，但 `dependsOn` 全部 section，确保标题基于完整故事；
- 依赖不能成环，不能指向 story 容器或自己。

## S4. 常见失误

（本节不自动注入，需要时用 `read_skill_section` 读取）

- 把一次地点连续误当作 section 边界，导致一个 section 塞入多次关键变化；
- instruction 写成正文，逼下游照抄；
- 漏掉停点，下一节无法衔接；
- 小节数量与 outline_blueprint 不一致。

## S5. 提交前自检

- [ ] 唯一根槽位类型为 story，`parentId=null`。
- [ ] 有一个 title 和 8–30 个 section。
- [ ] 每个编号小节恰好对应一个 section，顺序一致。
- [ ] 每个 section instruction 写清发生、改变、停点。
- [ ] section 链式依赖，title 依赖全部 section。
- [ ] ID、父子、order、dependsOn 均满足结构约束。
- [ ] 大纲点名的事件、反转、结局都落到具体 section。
- [ ] 总槽位数和深度不超过模板上限。

完成后一次性调用 `complete_assignment` 提交完整结构。
