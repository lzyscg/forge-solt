# Forge Core vNext UI/UX 设计需求文档

**文档版本：** V0.2  
**文档用途：** 交付 Claude Design，用于完成 P0 页面架构、视觉设计和交互原型  
**对应产品：** 结构槽原生 Agent 内容生产平台  
**设计范围：** 桌面端优先，覆盖核心生产闭环  
**核心原则：** 产物优先、结构槽中心、Agent 工作透明、Skill 可追踪、系统行为可解释

---

## 1. 设计目标

Forge Core vNext 的 UI 不是一个普通聊天界面，也不是一个以 Agent 节点和连线为中心的工作流画布。

它要直观表达：

```text
用户输入
  ↓
Agent 使用 Skill 创建具体结构
  ↓
Agent 使用 Skill 逐槽生产内容
  ↓
系统保存、调度和组装
  ↓
最终产物
```

用户进入任务后，应当在几秒内理解：

1. 当前任务处于哪个生产阶段；
2. 最终产物被拆成了什么结构；
3. 哪些结构槽已经完成，哪些正在等待；
4. 当前由哪个 Agent 使用哪个 Skill 处理哪个结构槽；
5. Agent 在工作过程中查看了什么、调用了什么、做出了哪些公开说明；
6. 为什么任务正在运行、等待、重试、停止或失败；
7. 距离最终产物完成还有多远。

整个产品的主视觉模型应当是：

```text
生产阶段
+
结构槽树
+
当前工作对象
+
Agent 工作轨迹
+
最终产物
```

---

## 2. 一句话产品模型

> Forge Core vNext 是一个以 Agent 为制作者、Skill 为工作方法、结构槽为工作对象，由系统负责调度、上下文装配、状态管理和最终组装的内容生产工作台。

UI 中的关键关系必须始终清晰：

| 概念 | UI 中回答的问题 |
|---|---|
| Agent | 谁在做 |
| Skill | 按什么方法做 |
| Operation | 正在执行什么动作 |
| Slot | 正在处理哪个内容单元 |
| Context | 基于哪些信息工作 |
| System | 如何调度、校验、保存和组装 |
| Artifact | 最终交付是什么 |

---

## 3. 设计原则

### 3.1 产物优先，而不是 Agent 拓扑优先

页面的主要对象应当是：

```text
Task
→ Structure
→ Slot
→ Slot Content
→ Artifact
```

Agent 是内容生产主体，但不是页面的唯一中心。

不使用无限画布作为任务主界面，不把每一次 Agent 调用设计成永久节点，也不默认绘制复杂关系网。

---

### 3.2 结构槽是主导航

结构槽树既是最终产物的结构预览，也是任务过程导航。

用户应能通过结构槽树查看：

- 最终产物有哪些部分；
- 当前处理到哪里；
- 每个部分的状态；
- 每个部分的内容目标；
- 每个部分的已生成内容；
- 每个部分由哪个 Agent、哪个 Skill 生产；
- 该部分对应的历史工作轨迹。

---

### 3.3 Agent 工作过程必须可观察

UI 不仅展示 Agent 最终生成了什么，也展示其可公开的工作过程：

- 任务理解；
- 工作计划；
- Skill 加载和章节读取；
- 上下文读取；
- 工具调用；
- 关键决策摘要；
- 公开输出；
- 正式提交；
- 系统校验；
- 最终保存结果。

这里展示的是 Agent 主动发布的**公开工作说明和可验证行为**，不是模型内部隐藏的 Chain-of-Thought。

界面中统一使用：

```text
工作说明
任务理解
工作计划
关键判断
工作轨迹
```

不要使用“内部思维”“隐藏推理”等表述。

---

### 3.4 Agent 行为与系统行为必须区分

Agent 负责：

- 创建具体结构；
- 定义槽位内容目标；
- 生成槽位内容；
- 发布公开工作说明；
- 调用被授权的工具。

System 负责：

- 冻结输入；
- 选择 Agent 和 Skill；
- 构建上下文；
- 校验结构；
- 选择 Ready Slot；
- 保存内容；
- 处理超时、停止和重试；
- 组装最终产物；
- 设置任务完成。

UI 需要通过 Actor 标签、图标和文案区分：

```text
Agent
System
Tool
Skill
```

不能只依靠颜色区分。

---

### 3.5 信息渐进展示

默认界面只显示用户判断任务状态所需的信息：

- 当前阶段；
- 结构槽树；
- 当前槽位目标；
- 当前内容；
- Agent；
- Skill；
- 工作轨迹；
- 任务控制。

以下内容放入展开区或技术详情抽屉：

- Context Hash；
- Snapshot Hash；
- Execution ID；
- Provider；
- Model；
- Token 使用量；
- 脱敏工具参数；
- 完整上下文；
- 稳定错误码；
- Trace 导出。

---

## 4. 设计范围与非目标

### 4.1 P0 必须设计的页面

```text
/tasks
/tasks/new
/tasks/:taskId
/templates
/templates/:templateId
/settings/providers
```

对应页面：

1. 任务列表；
2. 新建任务；
3. 任务工作台；
4. 模板列表；
5. 模板详情；
6. Provider 设置。

---

### 4.2 P0 不设计的独立页面

- Agent 管理中心；
- Skill 管理中心；
- 审核中心；
- Finding 中心；
- Artifact 全局资源库；
- 可视化流程编辑器；
- 结构手动编辑器；
- 数据分析看板；
- 多 Agent 拓扑画布。

Agent 和 Skill 在模板详情和任务工作台中展示。

Artifact 在所属 Task 中查看和下载。

---

## 5. 全局信息架构

```text
Forge Core
├── 生产任务
│   ├── 任务列表
│   ├── 新建任务
│   └── 任务工作台
├── 模板
│   ├── 模板列表
│   └── 模板详情
└── 设置
    └── Provider 与模型
```

---

## 6. 全局应用框架

### 6.1 全局导航

桌面端使用窄侧边导航栏，建议宽度为 64–72 px。

导航项：

- 生产任务；
- 模板；
- 设置。

支持悬停显示文字，也可以展开为约 200 px 的完整导航。

任务工作台本身已经采用三栏布局，因此不建议默认使用宽侧边导航。

---

### 6.2 全局顶栏

全局顶栏可展示：

- 当前页面名称；
- Provider 连接状态；
- 当前是否有 Agent Assignment 正在运行；
- 全局设置入口。

不要在顶栏堆叠复杂统计指标。

---

### 6.3 目标画布尺寸

主要高保真稿按以下尺寸设计：

```text
1440 × 900
```

最低桌面宽度：

```text
1280 px
```

P0 不要求完整移动端设计。

在 1024–1279 px 范围内：

- 右侧 Agent 工作面板改为可打开的抽屉；
- 左侧结构树允许折叠；
- 中央内容区保持优先。

---

## 7. 核心用户流程

### 7.1 正常生产流程

```text
模板列表
  ↓
模板详情
  ↓
使用模板创建任务
  ↓
填写任务输入
  ↓
创建 Task（Ready）
  ↓
用户点击开始
  ↓
Agent 创建结构
  ↓
系统校验结构
  ↓
Agent 逐槽生产
  ↓
系统组装
  ↓
查看并下载 Artifact
```

---

### 7.2 停止与继续

```text
任务正在运行
  ↓
用户点击停止
  ↓
确认停止当前 Assignment
  ↓
任务进入 Stopped
  ↓
用户点击继续
  ↓
从未完成的结构或 Slot 继续
```

停止确认文案需要明确：

> 当前正在运行的 Agent 结果即使稍后返回，也不会被保存。已完成的结构槽不会丢失。

---

### 7.3 失败与重试

```text
Provider 超时 / 输出无效 / 组装失败
  ↓
界面显示失败阶段和稳定错误
  ↓
显示已完成内容是否保留
  ↓
用户点击重试
  ↓
只重试失败阶段
```

---

## 8. 任务工作台总体布局

任务工作台是整个产品最重要的页面。

推荐使用：

```text
顶部任务区
+
生产阶段 Stepper
+
三栏工作区
```

布局示意：

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ 任务名称  模板  状态  当前阶段             开始 / 停止 / 继续 / 重试       │
├────────────────────────────────────────────────────────────────────────────┤
│ 输入 ✓  →  创建结构 ✓  →  槽位生产 4/7  →  组装等待  →  最终产物          │
├──────────────────┬──────────────────────────────────┬──────────────────────┤
│ 结构槽树         │ 当前槽位 / 结构 / Artifact      │ Agent 工作面板       │
│ 约 280–300 px    │ 自适应，最小约 560 px            │ 约 400–440 px        │
│                  │                                  │                      │
│ chapter          │ scene_03                         │ 当前 Assignment      │
│ ├ title       ✓  │ 槽位目标                         │ Agent / Skill        │
│ ├ opening     ✓  │ 依赖内容                         │ Operation / Target   │
│ ├ scene_01    ✓  │ 正文或实时生成内容               │ Attempt / 运行时间   │
│ ├ scene_02    ✓  │ Producer 信息                    │                      │
│ ├ scene_03    ▶  │                                  │ 实时工作轨迹         │
│ ├ scene_04    ○  │                                  │                      │
│ └ chapter_end ○  │                                  │                      │
└──────────────────┴──────────────────────────────────┴──────────────────────┘
```

建议：

- 左栏固定或可折叠；
- 中栏优先占据剩余空间；
- 右栏固定宽度并独立滚动；
- 三栏之间使用清晰但克制的分隔；
- 不使用大量浮层遮挡正文。

---

## 9. 任务顶部区域

### 9.1 任务标题行

展示：

- 任务名称；
- 模板名称；
- Task Status；
- 当前 Phase；
- 更新时间；
- 生命周期按钮。

示例：

```text
《深夜来电》第三章

知乎盐选单章结构槽生产
正在运行 · 槽位生产

[停止]
```

生命周期按钮根据状态变化：

| Task Status | 按钮 |
|---|---|
| ready | 开始生产 |
| running | 停止 |
| stopped | 继续 |
| failed | 重试 |
| completed | 下载产物 |

---

### 9.2 生产阶段 Stepper

固定五个阶段：

```text
输入
→
创建结构
→
填充槽位
→
组装产物
→
完成
```

每个阶段展示状态和摘要。

示例：

```text
输入
已冻结

创建结构
7 个槽位

填充槽位
4 / 7

组装产物
等待全部槽位完成

完成
尚未生成
```

阶段主体标识：

```text
输入：System
创建结构：Agent
填充槽位：Agent
组装产物：System
完成：System
```

Stepper 中的阶段可点击：

- 点击“输入”查看冻结输入；
- 点击“创建结构”查看结构创建过程与对应 Agent Trace；
- 点击“填充槽位”回到结构槽树；
- 点击“组装产物”查看组装顺序；
- 点击“完成”查看 Artifact。

---

## 10. 左栏：结构槽树

### 10.1 树头部

展示：

```text
内容结构
4 / 7 已完成
```

附带简洁进度条。

P0 不需要搜索和复杂筛选；当未来结构槽超过约 50 个时再增加。

---

### 10.2 树节点

每个节点展示：

- Slot 名称或 ID；
- Slot Type；
- 状态图标；
- 必要时显示等待原因。

示例：

```text
✓ title
  标题

✓ opening
  开场

▶ scene_03
  场景段 · 正在生产

○ scene_04
  场景段 · 等待 scene_03
```

---

### 10.3 状态表达

数据库状态与 UI 派生状态：

| 数据状态 | 条件 | UI 文案 |
|---|---|---|
| pending | 依赖未完成 | 等待依赖 |
| pending | 依赖已完成 | 可生产 |
| pending | `revisionRound > 0` | 返修中（第 N 次） |
| running | — | 正在生产 |
| reviewing | — | 审核中 |
| completed | `reviewExhausted = 0` | 已完成 |
| completed | `reviewExhausted = 1` | 已完成（返修次数用尽） |
| failed | — | 失败 |

必须同时使用图标、文字和颜色，不能只靠颜色。

推荐图形语义：

```text
○ 等待依赖
● 可生产
▶ 正在生产
◐ 审核中
↻ 返修中
✓ 已完成
✓ 已完成（返修次数用尽）
! 失败
```

#### 措辞约束（REQ FR-REVIEW-004，属正确性要求）

语义审核**不构成质量保证**——它按判据找错，找不到不等于内容合格，
且各判据的实际检出能力差异很大。因此界面上：

- **不得**出现「审核通过」「质量合格」「已校验」，或任何使用户推断
  内容质量已获保障的表述；
- 审核未检出问题时，Slot **直接显示「已完成」**，不额外加审核徽标——
  加一个「已审核」标记就等于做出了未经支持的承诺；
- 审核检出问题只体现为**返修过程**（`返修中（第 N 次）`）与 Trace 记录，
  不作为对内容的评级。

`已完成（返修次数用尽）` 是唯一需要区别显示的完成态：它表示**审核仍有未解决的
检出项，但已按现状收尾**。这条不是警告用户「内容不合格」，而是如实说明
「系统在这里停止了尝试」——文案不得升格为错误或警示色。

> 与 `失败` 的区别必须清楚：`失败` 是产不出内容，
> `已完成（返修次数用尽）` 是产出了内容且已进入产物。

---

### 10.4 点击行为

点击 Slot：

- 中栏展示该 Slot 的目标、依赖和内容；
- 右栏展示该 Slot 对应的 Agent 工作过程；
- 不改变系统当前正在运行的 Assignment。

如果用户正在查看历史 Slot，而另一个 Slot 正在运行：

- 右栏顶部出现“返回当前工作”按钮；
- 左侧当前运行 Slot 保留明显的运行标识；
- 不自动打断用户当前查看。

---

### 10.5 结构创建阶段

结构尚未创建时，左栏显示占位状态：

```text
结构尚未创建

Structure Agent 正在根据任务输入设计内容结构。
```

结构校验通过后，树一次性出现。

P0 不展示未经提交的半成品结构树。

---

## 11. 中栏：工作对象与内容

中栏根据当前选择对象切换：

```text
任务输入
结构概览
单个 Slot
组装过程
最终 Artifact
```

---

### 11.1 Slot 标题区

展示：

```text
scene_03

类型：场景段
状态：正在生产
位置：chapter / scene_03
```

---

### 11.2 槽位目标

`Slot Instruction` 必须置于内容之前，使用高辨识度卡片。

示例：

```text
本槽位目标

主人公发现同事说出的时间与监控记录矛盾，
并因此决定独自前往仓库确认。
```

这是用户理解该槽位为什么存在的主要依据。

---

### 11.3 依赖内容

展示依赖标签：

```text
依赖

[scene_02 ✓]
```

点击依赖标签跳转到对应 Slot。

P0 不默认显示完整 DAG 或关系网。

等待中的 Slot 应显示：

```text
当前尚不能生产

等待以下槽位完成：
scene_03
```

---

### 11.4 Slot Content

#### Pending

显示：

```text
尚未生成内容
```

并解释：

- 等待依赖；
- 或已 Ready、等待系统调度。

#### Running

显示实时正文输出区域：

```text
正在生成 scene_03……
```

Provider 的公开正文流可以实时出现。

不得显示隐藏推理内容。

#### Completed

展示最终保存的 Slot Content。

下方展示 Producer：

```text
生产来源

Agent：chapter_writer
Skill：scene-writing v1.2.0
Execution：exec-004
完成时间：11:42:18
```

#### Failed

展示：

- 失败阶段；
- 对用户可理解的说明；
- Attempt 次数；
- 稳定错误码（默认折叠）；
- 是否保留已有内容；
- 可执行操作。

---

### 11.5 组装视图

进入 Assembly 时，中栏显示：

```text
正在组装最终产物

已完成槽位：7 / 7
Assembler：markdown_concat_v1
输出：chapter.md
```

展示确定性组装顺序：

```text
title
↓
opening
↓
scene_01
↓
scene_02
↓
scene_03
↓
chapter_end
```

---

### 11.6 Artifact 视图

任务完成后，中栏默认显示 Artifact Viewer：

- 文件名；
- Markdown 预览；
- 文件大小；
- 生成时间；
- Checksum；
- 下载按钮。

左侧结构槽树继续保留，用户可以在最终产物和局部内容间切换。

---

## 12. 右栏：Agent 工作面板

右栏回答：

> 这个 Agent 是如何使用这个 Skill，完成当前或所选结构槽的？

整体分为两个区域：

```text
当前 Assignment 摘要
+
Agent 工作轨迹
```

---

### 12.1 Assignment 摘要

固定在右栏顶部。

展示：

```text
当前工作

Agent
chapter_writer
章节正文写作 Agent

Skill
scene-writing
v1.2.0

Operation
fill_slot

Target
scene_03

Attempt
1 / 3

运行时间
00:43
```

推荐将核心关系汇总为一句可读文案：

> chapter_writer 正在使用 scene-writing v1.2.0 填充 scene_03。

---

### 12.2 历史 Slot

用户选择已完成 Slot 时，右栏显示该 Slot 的 Producer Execution。

顶部标识：

```text
历史工作记录
```

显示：

- Producer Agent；
- Producer Skill；
- Execution；
- 最终状态；
- 完整 Trace。

如果当前另有 Assignment 正在运行，显示：

```text
[返回当前工作]
```

---

### 12.3 Pending Slot

用户选择尚未运行的 Slot 时，右栏显示“计划工作”：

```text
计划工作

Agent：chapter_writer
Skill：scene-writing
Operation：fill_slot
Target：scene_04

当前尚未创建 Assignment
等待：scene_03
```

---

## 13. Agent 工作轨迹

### 13.1 时间线结构

按 Sequence 和时间顺序显示：

```text
System 创建 Assignment
Agent 发布任务理解
Skill 加载
Agent 读取 Skill Section
Agent 读取依赖 Slot
Agent 发布工作计划
Agent 调用工具
Agent 发布关键判断
Agent 输出正文
Agent 正式提交
System 校验
System 保存 Slot
```

---

### 13.2 Trace 筛选

提供筛选标签：

```text
全部
工作说明
Skill
工具
输出
系统
```

默认显示全部。

筛选只影响展示，不改变数据。

---

### 13.3 Trace Event 类型与视觉

#### System Event

示例：

```text
System · 10:31:02

创建 Fill Slot Assignment
目标：scene_03
```

显示为中性系统卡片。

---

#### 工作说明

类型包括：

- 任务理解；
- 工作计划；
- 关键判断；
- 进度说明；
- 完成说明。

示例：

```text
Agent · 任务理解

本槽位需要通过具体行动发现时间矛盾，
同时不能提前揭露幕后人物。
```

这类内容来自 Agent 主动调用 `report_work`，不是系统生成的内部思维。

---

#### Skill Event

示例：

```text
Skill · scene-writing v1.2.0

读取章节：
S1 理解槽位目标
S3 设计可见行动
S4 推进信息变化
```

支持展开查看任务 Snapshot 中对应的 Skill Section。

必须显示：

- Skill ID；
- Skill Version；
- Section ID；
- Section 标题；
- 自动注入或工具读取。

不能声称模型“真正注意了”某段内容，只记录系统实际提供或 Agent 实际读取的内容。

---

#### Tool Event

示例：

```text
Tool · read_slot

参数摘要
slotId：scene_02

结果
读取成功 · 1,842 字符

耗时
24 ms
```

工具卡片支持展开查看：

- 脱敏参数；
- 结果摘要；
- 完整结果入口；
- 状态；
- 耗时；
- 错误。

大段正文默认不在 Trace 中全部展开。

---

#### 公开输出

区分：

```text
工作说明
正式正文输出
```

正式正文输出使用更接近编辑器的视觉样式。

Running 时显示流式内容和生成光标。

完成后以最终 Slot Content 为准，Trace 中保留聚合后的公开输出片段。

---

#### System Validation

示例：

```text
System · 校验通过

目标 Slot：scene_03
内容长度：1,226 字符
依赖状态：满足
Execution Token：有效
```

技术字段默认折叠。

---

### 13.4 自动跟随

Trace 默认自动滚动到最新事件。

如果用户向上滚动：

- 停止自动跟随；
- 显示“有 5 条新事件”；
- 提供“回到最新”按钮。

---

### 13.5 Trace 技术详情

右栏提供二级入口：

```text
技术详情
```

展示：

- Execution ID；
- Assignment ID；
- Context Hash；
- Snapshot Hash；
- Provider；
- Model；
- Attempt Number；
- Token Usage；
- 开始和结束时间；
- 稳定错误码；
- 脱敏 Trace 导出。

提供：

```text
复制 Trace
导出 JSON
导出 Markdown
```

导出内容必须脱敏。

---

## 14. 任务列表

### 14.1 布局

桌面端优先使用列表或表格，不需要复杂 Dashboard。

推荐字段：

| 任务 | 模板 | 状态 | 当前阶段 | 进度 | 当前工作 | 更新时间 |
|---|---|---|---|---|---|---|

示例：

```text
《深夜来电》第三章
知乎盐选单章结构槽生产
正在运行
槽位生产
4 / 7
chapter_writer · scene_03
1 分钟前
```

---

### 14.2 业务化状态文案

不要只显示：

```text
running
failed
```

优先显示：

```text
正在创建结构
正在生成 scene_03
正在重试 · Attempt 2/3
已停止
正在组装
已完成
```

---

### 14.3 筛选

P0 只需要：

- 全部；
- 进行中；
- 已停止；
- 失败；
- 已完成；
- 模板筛选。

主操作：

```text
新建任务
```

---

## 15. 新建任务

### 15.1 页面布局

推荐左右两栏：

```text
┌──────────────────────────────┬─────────────────────────────┐
│ 任务输入                     │ 当前模板的生产方案          │
│                              │                             │
│ 任务名称                     │ 创建结构                    │
│ 章节执行包                   │ structure_designer          │
│ 其他模板字段                 │ chapter-structure-design    │
│                              │                             │
│                              │ 填充内容                    │
│                              │ title → title-writing       │
│                              │ scene → scene-writing       │
│                              │                             │
│ [创建任务]                   │ 输出：chapter.md            │
└──────────────────────────────┴─────────────────────────────┘
```

---

### 15.2 创建与启动分离

创建成功后：

```text
Task.status = ready
```

进入任务工作台，由用户显式点击：

```text
开始生产
```

避免用户提交表单后立即产生模型费用而无法再次检查。

---

## 16. 模板列表与模板详情

### 16.1 模板列表

模板卡片展示：

- 名称；
- 描述；
- 版本；
- 输入字段数量；
- Slot Type 数量；
- Agent 数量；
- 输出文件。

操作：

- 查看详情；
- 使用此模板。

---

### 16.2 模板详情

不要使用 Agent 路由图。

使用“生产配方”表达：

```text
用户输入
  ↓
Structure Agent + Structure Skill
  ↓
具体结构槽
  ↓
按 Slot Type 分配 Agent + Skill
  ↓
System Assembler
  ↓
Artifact
```

页面区块：

1. 模板说明；
2. 输入字段；
3. 结构创建 Agent 与 Skill；
4. Slot Type 与 Binding 表；
5. Skill 概要与稳定章节；
6. Limits；
7. Output；
8. 使用模板创建任务。

Slot Binding 表：

| Slot Type | 承载内容 | Agent | Skill |
|---|---:|---|---|
| chapter | 否 | — | — |
| title | 是 | chapter_writer | title-writing |
| opening | 是 | chapter_writer | opening-writing |
| scene | 是 | chapter_writer | scene-writing |
| chapter_end | 是 | chapter_writer | chapter-ending-writing |

---

## 17. Provider 设置

P0 设置页只管理模型基础设施。

展示：

```text
Provider
- 名称
- API Base
- 凭证状态
- 连接状态
- 连接测试

Model
- Provider
- Model ID
- 显示名称
- 是否可用
```

API Key 只显示：

```text
已配置
未配置
```

不得回显原始值。

---

## 18. 必须覆盖的任务工作台状态

Claude Design 需要为任务工作台提供以下关键状态稿。

### 18.1 Ready

- 输入已冻结；
- 结构未创建；
- 显示开始生产按钮；
- 右栏显示将要使用的 Structure Agent 和 Skill。

### 18.2 正在创建结构

- Stepper 停在“创建结构”；
- 左栏显示结构创建中占位；
- 中栏显示任务输入和结构设计说明；
- 右栏实时展示 Structure Agent Trace。

### 18.3 结构校验失败并重试

- 中栏显示确定性校验错误；
- 右栏保留 Agent Trace；
- 显示 Attempt 1/3；
- 明确说明不会保存部分 Slot。

### 18.4 正在填充 Slot

- 左栏突出当前 Slot；
- 中栏实时展示正文；
- 右栏展示 Agent、Skill、工具和公开工作说明。

### 18.5 Slot 等待依赖

- 中栏说明等待哪个 Slot；
- 右栏展示计划 Binding，不展示虚假 Assignment。

### 18.6 Provider 超时与自动重试

- 顶部状态显示正在重试；
- 右栏显示 Attempt 变化；
- 旧 Attempt 标记为超时；
- 当前新 Attempt 有独立 Trace。

### 18.7 Stopped

- 顶部显示已停止；
- 中栏保留所有已完成内容；
- 右栏说明旧 Execution 已取消；
- 显示继续按钮。

### 18.8 Failed

- 显示失败阶段；
- 显示用户可理解的原因；
- 显示哪些数据已保留；
- 显示重试操作；
- 技术错误折叠。

### 18.9 Assembly

- 全部 Slot 已完成；
- 中栏显示组装顺序；
- 右栏显示 System 组装轨迹；
- 不再显示 Agent 正在创作。

### 18.10 Completed

- 默认显示 Artifact；
- 可下载；
- 可查看所有 Slot；
- 可查看每个 Slot 的历史 Trace；
- Stepper 全部完成。

### 18.11 SSE 断线

- 页面保留最后一次权威状态；
- 显示轻量连接提示；
- 自动重连；
- 不将任务误标为失败。

---

## 19. 视觉风格

### 19.1 整体气质

目标是：

```text
专业
克制
可信
高信息密度但不拥挤
适合长时间生产和排查
```

它是一套内容生产控制台，不是聊天软件，也不是营销网站。

---

### 19.2 主题

P0 优先设计浅色主题。

建议：

- 大面积中性浅色背景；
- 白色或略带灰度的内容面板；
- 单一主强调色；
- 状态使用语义色；
- Trace Actor 使用轻量色块区分；
- 避免大面积渐变、霓虹和强装饰。

---

### 19.3 字体

- 正文和 UI 使用高可读性无衬线字体；
- ID、Hash、Tool Name、Error Code 使用等宽字体；
- 正文预览保持适合长文本阅读的行宽和行高；
- 不把所有内容都做成紧凑代码样式。

---

### 19.4 间距与密度

建议使用 8 px 网格。

任务工作台应同时容纳较多信息，但保持：

- 明确层级；
- 12–16 px 区块间距；
- 统一卡片圆角；
- 清晰焦点态；
- 可滚动区域边界明确。

---

### 19.5 无障碍

- 状态不能只靠颜色；
- 图标配文字或 Tooltip；
- 所有操作支持键盘焦点；
- 对比度满足常规可读性；
- Trace Timeline 可被屏幕阅读器按顺序读取；
- 实时事件使用非侵入式 Live Region；
- 动画可减少。

---

## 20. 交互细节

### 20.1 Slot 选择

- 默认自动选择当前 Running Slot；
- 用户选择其他 Slot 后不自动跳回；
- 新 Assignment 开始时显示轻量提示；
- 提供“返回当前工作”。

### 20.2 Stepper 点击

阶段可作为任务内容导航，但不能直接修改状态。

### 20.3 Trace 展开

- 单击事件展开；
- Skill Section 可查看 Snapshot 内容；
- Tool Result 大内容使用独立抽屉；
- 技术字段默认折叠。

### 20.4 停止任务

必须二次确认。

确认框明确说明：

- 当前 Assignment 将取消；
- 迟到结果不会保存；
- 已完成 Slot 保留；
- 可稍后继续。

### 20.5 重试

界面必须说明重试范围：

```text
只重试 scene_03
不会重新生成已完成槽位
```

或：

```text
只重新执行 Artifact 组装
```

---

## 21. 示例数据

Claude Design 可使用以下统一样例制作高保真稿。

### Task

```text
任务名称：
《深夜来电》第三章

模板：
知乎盐选单章结构槽生产

状态：
正在运行

Phase：
槽位生产

进度：
4 / 7
```

### Structure

```text
chapter
├── title              completed
├── opening            completed
├── scene_01           completed
├── scene_02           completed
├── scene_03           running
├── emotional_closure  pending
└── chapter_end        pending
```

### Current Assignment

```text
Agent：
chapter_writer

Agent Role：
章节正文写作 Agent

Skill：
scene-writing v1.2.0

Operation：
fill_slot

Target：
scene_03

Attempt：
1 / 3

运行时间：
00:43
```

### Slot Instruction

```text
主人公发现同事说出的时间与监控记录矛盾，
并因此决定独自前往仓库确认。
```

### Dependency

```text
scene_02
```

### Trace

```text
10:31:02 · System
创建 Fill Slot Assignment，目标 scene_03。

10:31:03 · Agent · 任务理解
本槽位需要通过具体行动发现时间矛盾，同时不能提前揭露幕后人物。

10:31:05 · Skill
加载 scene-writing v1.2.0，自动注入 S1、S2、S6。

10:31:07 · Tool · read_skill_section
读取 S3“设计可见行动”和 S4“推进信息变化”。

10:31:09 · Tool · read_slot
读取 scene_02，1,842 字符。

10:31:12 · Agent · 工作计划
先确认人物当前状态，再选择能够直接触发下一步行动的可见证据。

10:31:21 · Agent · 关键判断
使用监控时间与口述时间的矛盾，避免让角色直接承认撒谎。

10:31:28 · Agent · 公开输出
门外的感应灯亮了第二次。林昭低头看向手机上的监控时间……

10:31:49 · Tool · complete_assignment
提交 scene_03。

10:31:50 · System
内容校验通过，scene_03 已完成。
```

---

## 22. Claude Design 交付要求

请基于本需求输出以下设计成果。

### 22.1 页面架构

提供：

- 全局导航结构；
- 页面关系图；
- 主要用户流程；
- 任务工作台信息层级。

### 22.2 高保真页面

至少设计：

1. 任务列表；
2. 模板列表；
3. 模板详情；
4. 新建任务；
5. Provider 设置；
6. 任务工作台——Ready；
7. 任务工作台——正在创建结构；
8. 任务工作台——正在填充 Slot；
9. 任务工作台——Provider 超时重试；
10. 任务工作台——Stopped 或 Failed；
11. 任务工作台——Assembly；
12. 任务工作台——Completed。

主要尺寸：

```text
1440 × 900
```

### 22.3 组件设计

提供以下组件及状态变体：

- Production Stepper；
- Task Status Badge；
- Slot Tree；
- Slot Tree Node；
- Slot Instruction Card；
- Dependency Chip；
- Slot Content Viewer；
- Assignment Summary；
- Trace Timeline；
- System Event；
- Work Note Event；
- Skill Event；
- Tool Event；
- Public Output Event；
- Validation Event；
- Task Controls；
- Artifact Viewer；
- Error Notice；
- Connection Notice；
- Confirmation Dialog。

### 22.4 可点击原型

至少覆盖：

```text
模板详情
→
新建任务
→
Ready 工作台
→
创建结构
→
槽位生产
→
查看历史 Slot Trace
→
返回当前工作
→
最终 Artifact
```

### 22.5 设计说明

设计稿中需要标注：

- 固定区与滚动区；
- 三栏宽度；
- 面板折叠规则；
- Trace 自动跟随规则；
- Slot 选择规则；
- 1280 px 适配规则；
- 1024–1279 px 抽屉降级规则；
- 状态图标含义；
- Agent、System、Tool、Skill 的视觉区分；
- 哪些内容属于公开工作说明；
- 哪些技术信息默认折叠。

---

## 23. 设计验收标准

设计应满足以下条件：

1. 用户无需理解 Agent 架构，也能看懂任务当前进展；
2. 用户一眼能识别最终产物的结构；
3. 用户一眼能识别当前 Agent、Skill、Operation 和 Target；
4. Agent 工作轨迹不是黑箱；
5. Skill 的版本和实际读取章节可以追踪；
6. 工具调用参数和结果可以逐层展开；
7. 工作说明与正式正文有明确视觉区分；
8. Agent 行为和 System 行为有明确视觉区分；
9. 失败、停止、重试和迟到结果的含义清晰；
10. 界面不依赖无限画布、复杂关系图或原始日志；
11. 1440 px 桌面视图中三栏可同时阅读；
12. 任务完成后仍可从 Artifact 回溯到单个 Slot 和对应 Trace；
13. 所有关键状态均有明确空状态、加载状态、错误状态和完成状态；
14. 不展示模型内部隐藏 Chain-of-Thought；
15. 整体视觉适合长时间内容生产和 Skill 调试。

---

## 24. 最终设计定义

Forge Core vNext 的任务工作台应当直观表达：

```text
左侧：
最终产物由哪些结构槽组成

中间：
当前结构槽要完成什么，以及最终产出了什么

右侧：
哪个 Agent 使用哪个 Skill，通过哪些公开步骤、Skill 读取和工具调用完成了它

顶部：
整个任务处于哪个生产阶段

完成后：
所有结构槽如何被系统组装成最终 Artifact
```

最终用户应能够清楚回答：

> 这个产物现在完成到哪里了？当前是谁在用什么方法处理哪个部分？Agent 实际查看了什么、调用了什么、做出了哪些公开判断？系统为什么允许或拒绝这次提交？最终产物是如何由各个结构槽组成的？
