# Forge Core vNext 核心名词与概念说明

**文档版本：** V0.1  
**文档状态：** 初版概念定义  
**配套文档：**《Forge Core vNext：结构槽原生 Agent 内容生产平台需求规格说明书》  
**适用阶段：** P0 最小可运行闭环

---

## 1. 文档目的

本文档用于解释 Forge Core vNext 需求规格中使用的核心名词，统一产品、设计、开发和测试人员对这些概念的理解。

本文档重点解决以下问题：

- “结构槽”究竟是什么；
- “模板”与“具体结构”有什么区别；
- Agent、模型、Skill、结构槽之间是什么关系；
- Task、Assignment、Execution Record 分别代表什么；
- 系统负责什么，Agent 负责什么；
- 哪些概念属于 P0 核心，哪些概念暂不进入 P0。

后续产品文档、技术设计、接口定义和代码命名原则上均应遵循本文档中的定义。

---

# 2. 整体概念模型

Forge Core vNext 的基本生产模型为：

```text
模板 Template
  │
  │ 定义生产方案
  ▼
任务 Task
  │
  │ 冻结模板和用户输入
  ▼
工作指派 Assignment
  │
  ├── 指定 Agent
  ├── 指定 Skill
  ├── 指定 Operation
  ├── 指定工作对象
  └── 提供确定性上下文
  │
  ▼
Agent 执行内容工作
  │
  ├── 创建具体结构
  └── 填充结构槽
  │
  ▼
结构槽 Slot
  │
  │ 保存内容和生产来源
  ▼
组装器 Assembler
  │
  │ 确定性组合所有槽位内容
  ▼
最终产物 Artifact
```

可以进一步压缩为：

```text
Agent + Skill + Context + Target
                    ↓
               Content Work
                    ↓
           Structure / Slot Content
```

其中：

| 概念 | 回答的问题 |
|---|---|
| Agent | 谁来做 |
| Skill | 按什么方法做 |
| Operation | 做什么动作 |
| Target | 对什么对象做 |
| Context | 基于哪些信息做 |
| System | 何时做、是否允许做、如何保存 |
| Slot | 工作结果保存在哪里 |
| Artifact | 最终交付是什么 |

---

# 3. 核心关系定义

## 3.1 Agent 与结构槽的关系

Agent 是内容工作的执行主体。

结构槽是 Agent 的工作对象。

两者之间的关系类似于：

```text
制作者 → 制作对象
```

例如：

```text
章节写作 Agent
  使用 scene-writing Skill
  对 scene_03 结构槽
  执行 fill_slot 动作
```

最终得到：

```text
scene_03.content
```

因此，结构槽不会自动生产内容，系统也不会直接生产语义内容。

结构槽内容必须由 Agent 使用明确的 Skill 创建。

---

## 3.2 Skill 与 Agent 的关系

Skill 是 Agent 执行某项工作的标准方法。

Agent 提供：

- 角色；
- 内容判断能力；
- 语言生成能力；
- 模型运行配置。

Skill 提供：

- 工作目标；
- 工作步骤；
- 内容约束；
- 禁止事项；
- 输出要求。

同一个 Agent 可以拥有多个 Skill，但一次具体工作只绑定一个主要 Skill。

例如：

```text
Agent：chapter_writer

可使用的 Skill：
- title-writing
- opening-writing
- scene-writing
- chapter-ending-writing
```

当 Agent 填充 `scene_03` 时，系统只向其加载：

```text
scene-writing
```

而不是同时加载全部 Skill。

---

## 3.3 模板与具体结构的关系

模板定义“允许如何生产”。

具体结构定义“本次任务实际生产什么”。

例如，模板允许使用：

```text
chapter
title
opening
scene
emotional_closure
chapter_end
```

结构设计 Agent 在某次具体任务中创建：

```text
chapter
├── title
├── opening
├── scene_01
├── scene_02
├── scene_03
├── emotional_closure
└── chapter_end
```

因此：

```text
模板 ≠ 具体结构
```

模板是生产规则。

具体结构是某个 Task 中实际存在的结构槽集合。

---

# 4. 基础配置类概念

## 4.1 模板 Template

### 定义

模板是一种内容生产方案的完整定义。

模板说明：

- 用户需要输入什么；
- 允许创建哪些类型的结构槽；
- 系统中有哪些 Agent；
- 可以使用哪些 Skill；
- 创建结构时使用哪个 Agent 和 Skill；
- 不同类型槽位由哪个 Agent 和 Skill 填充；
- 资源上限是什么；
- 最终产物如何组装。

模板可以理解为：

> 一种内容产品的生产工艺说明。

---

### 模板包含的内容

```text
输入字段
+ Slot Type
+ Agent Definition
+ Skill Reference
+ Operation Binding
+ Limits
+ Output Definition
```

---

### 模板不是什么

模板不是：

- 最终文档；
- 当前任务的具体结构；
- 单纯的一段 Prompt；
- 一个 Agent；
- 一个结构槽；
- 一次模型调用；
- 用户填写的内容；
- 结构槽正文的固定格式。

---

### 示例

“知乎盐选单章生产模板”可以规定：

```text
输入：
- 章节执行包

允许的槽位类型：
- title
- opening
- scene
- emotional_closure
- chapter_end

结构创建：
- structure_designer
- chapter-structure-design Skill

scene 填充：
- chapter_writer
- scene-writing Skill

输出：
- chapter.md
```

---

## 4.2 Agent Definition

### 定义

Agent Definition 是对一个内容生产角色的静态定义。

它通常包含：

- Agent ID；
- Agent 名称；
- 角色说明；
- Provider；
- 模型；
- 基础系统指令。

---

### Agent 与模型的区别

Agent 不等于模型。

```text
模型 Model
=
底层语言模型能力

Agent
=
角色定义
+ 模型配置
+ 系统指令
+ 可执行工作范围
```

同一个模型可以被配置为多个不同 Agent。

例如：

```text
同一个模型
├── 结构设计 Agent
├── 章节写作 Agent
└── 报告撰写 Agent
```

这些 Agent 使用相同模型，但承担不同角色。

---

### Agent 不是什么

Agent 不是：

- Provider；
- 模型本身；
- Skill；
- 结构槽；
- Task；
- 一个永久聊天线程；
- 一个可以自由领取任何任务的自治进程。

P0 中，Agent 只能在系统创建 Assignment 后工作。

---

## 4.3 Skill

### 定义

Skill 是 Agent 完成某类工作的标准方法。

Skill 描述：

```text
这个工作要达到什么目标
输入信息是什么
处理步骤是什么
要遵守哪些规则
哪些行为禁止
输出应该是什么
```

Skill 应当具有明确版本。

---

### Skill 的作用

Skill 用于将 Agent 的工作方式标准化。

没有 Skill 时，Agent 可能根据临时 Prompt 和随机上下文自由发挥。

绑定 Skill 后，Agent 的工作变成：

```text
按照一份明确的工作规程
完成一个明确对象上的明确动作
```

---

### Skill 与 Prompt 的区别

Prompt 通常是一次模型调用中的具体提示文本。

Skill 是更稳定、更完整的工作规范。

```text
Skill
├── 工作目标
├── 工作步骤
├── 判断标准
├── 内容约束
├── 禁止事项
└── 输出 Contract
```

系统可以根据 Skill 和 Assignment 自动构建最终 Prompt。

因此：

```text
Skill ≠ 单次 Prompt
```

---

### Skill 与知识库的区别

Skill 主要说明“怎么做”。

知识资料主要说明“知道什么”。

例如：

```text
scene-writing Skill
=
如何写一个有效的场景段

人物设定资料
=
当前故事中的人物是谁
```

P0 中，Skill 作为工作方法进入 Context；业务资料通过 Task Input 或依赖槽位内容进入 Context。

---

## 4.4 Slot Type

### 定义

Slot Type 是模板层面对某一类结构槽的定义。

它说明：

- 这种槽位代表什么；
- 是否承载正文；
- 内容长度限制；
- 应由哪个 Agent 和 Skill 填充。

---

### Slot Type 与 Slot 的区别

Slot Type 是类型。

Slot 是具体实例。

例如：

```text
Slot Type：scene
```

某个 Task 中可能存在：

```text
scene_01
scene_02
scene_03
```

它们都是 `scene` 类型的具体 Slot。

类比为：

```text
“章节”是一种类型
“第三章”是一个具体实例
```

---

### 示例

```ts
{
  id: "scene",
  name: "场景段",
  contentBearing: true,
  minContentChars: 300,
  maxContentChars: 8000
}
```

---

## 4.5 Operation

### 定义

Operation 是 Agent 在内容层面执行的动作类型。

P0 只定义两个 Operation：

```text
create_structure
fill_slot
```

---

### create_structure

表示：

> Agent 根据用户输入和结构 Skill 创建本次任务的具体结构。

工作结果是 Slot Proposal 集合。

---

### fill_slot

表示：

> Agent 根据目标槽位、Skill 和上下文生成该槽位的内容。

工作结果是某个 Slot 的正文。

---

### 系统动作不属于 Agent Operation

以下动作由系统完成，不属于 Agent Operation：

- 校验结构；
- 选择 Ready Slot；
- 保存内容；
- 修改状态；
- 组装产物；
- 停止任务；
- 重试；
- 判断 Task 是否完成。

---

## 4.6 Binding

### 定义

Binding 是模板中对以下关系的静态绑定：

```text
Operation 或 Slot Type
→ Agent
→ Skill
```

Binding 回答：

> 这类工作应该由哪个 Agent 使用哪个 Skill 完成？

---

### 示例

```text
create_structure
→ structure_designer
→ chapter-structure-design
```

```text
fill_slot(scene)
→ chapter_writer
→ scene-writing
```

---

### Binding 的作用

Binding 防止 Agent 自行决定：

- 使用哪个 Skill；
- 使用哪个模型；
- 执行哪个角色；
- 接手哪种槽位。

这些工程层面的决定由模板和系统控制。

---

# 5. 任务运行类概念

## 5.1 任务 Task

### 定义

Task 是用户基于某个模板创建的一次具体生产任务。

例如：

```text
模板：
知乎盐选单章结构槽生产

Task：
生成《深夜来电》第三章
```

Task 保存：

- 使用的模板；
- 模板版本；
- 用户输入；
- 模板快照；
- 当前状态；
- 当前生产阶段；
- 当前执行；
- 最终产物位置。

---

### Task 与模板的区别

```text
模板
=
可重复使用的生产方案

Task
=
模板的一次具体运行
```

一个模板可以创建多个 Task。

每个 Task 拥有独立的：

- 用户输入；
- 结构槽；
- 内容；
- 执行记录；
- 最终产物。

---

### Task 与项目的区别

Task 表示一次完整的生产运行。

它不一定等于一个长期项目。

例如，一个长篇小说项目可以包含多个 Task：

```text
Task 1：创建全书大纲
Task 2：生成第一章
Task 3：生成第二章
Task 4：生成第三章
```

P0 只定义 Task，不额外定义 Project 实体。

---

## 5.2 Task Input

### 定义

Task Input 是用户在创建 Task 时填写的业务输入。

例如：

```text
章节执行包
故事主题
人物设定
目标风格
写作约束
```

Task Input 描述的是整个任务的总体要求。

---

### Task Input 与 Slot Instruction 的区别

Task Input 面向整个任务。

Slot Instruction 面向一个具体槽位。

例如：

```text
Task Input：
本章需要让主人公发现同事隐瞒了关键证据。

scene_03 Instruction：
主人公通过对方无意中说出的时间矛盾，确认其曾到过案发现场。
```

Slot Instruction 是 Structure Agent 对总体目标进行拆解后的局部工作目标。

---

## 5.3 Snapshot

### 定义

Snapshot 是 Task 创建时冻结的生产配置副本。

Snapshot 包含：

- Template；
- Agent Definition；
- Skill 内容和版本；
- Slot Type；
- Binding；
- Limits；
- Output Definition；
- Task Input。

---

### Snapshot 的作用

Snapshot 保证：

> Task 在运行期间使用的生产规则不会随着模板源文件变化而发生漂移。

例如：

```text
8 月 1 日创建 Task A
使用 scene-writing v1

8 月 2 日修改 Skill 为 v2

Task A 继续使用 v1
新建 Task B 使用 v2
```

---

### Snapshot Hash

Snapshot Hash 是对冻结生产配置计算出的摘要。

它用于判断：

- 当前 Task 使用的是哪一份配置；
- 配置是否被意外修改；
- 两次执行是否基于同一生产方案。

Snapshot Hash 不是审核证明，也不是发布证书。

---

# 6. 结构与结构槽概念

## 6.1 具体结构 Concrete Structure

### 定义

具体结构是某个 Task 实际拥有的全部结构槽及其组织关系。

具体结构由 Structure Agent 创建，并由系统校验和保存。

---

### 具体结构包含两类关系

#### 第一类：组织关系

通过以下字段表达：

```text
parentId
order
```

它们回答：

- 一个 Slot 属于哪个父节点；
- 同级 Slot 之间的顺序是什么；
- 最终产物按什么顺序组装。

组织关系形成一棵树。

---

#### 第二类：生产依赖关系

通过以下字段表达：

```text
dependsOn
```

它回答：

- 当前 Slot 在哪些 Slot 完成后才能生产；
- 当前 Slot 需要读取哪些前置 Slot 内容。

依赖关系形成一个无环有向图。

---

### 组织关系与生产依赖不能混淆

例如：

```text
chapter
├── opening
├── scene_01
└── scene_02
```

这是组织关系。

而：

```text
scene_02 dependsOn scene_01
```

是生产依赖。

`scene_02` 与 `scene_01` 是同级结构槽，但 `scene_02` 需要等待 `scene_01` 完成。

---

## 6.2 结构槽 Slot

### 定义

结构槽是具体结构中的一个具名内容位置。

它是 Agent 在内容生产阶段工作的直接对象。

结构槽至少包含：

```text
身份
类型
父节点
顺序
内容目标
依赖
状态
内容
生产来源
```

---

### 一个结构槽回答的问题

每个 Slot 都应回答：

1. 我是谁；
2. 我属于什么类型；
3. 我位于结构中的哪里；
4. 我要承担什么内容作用；
5. 我要等待哪些槽位；
6. 我当前处于什么状态；
7. 我的正文是什么；
8. 我的内容由谁使用什么 Skill 生产。

---

### 结构槽不是固定文本框

结构槽不是简单的 UI 输入框。

它是一个具有：

- 内容语义；
- 结构位置；
- 生产目标；
- 依赖关系；
- 生产状态；

的内容工作单元。

它可以在前端显示为文本区域，但其本质不是表单控件。

---

### 结构槽不是固定长度的切片

结构槽不等于把全文机械地按字数切成若干片段。

结构槽按照内容职责拆分。

例如：

```text
opening
=
完成进入场景和建立初始状态的职责

scene_02
=
完成冲突升级和信息变化的职责

chapter_end
=
完成悬念落点的职责
```

---

### 结构槽不是 WorkItem

Slot 是内容对象。

Assignment 是对这个对象执行的一次工作。

例如：

```text
Slot：
scene_03

Assignment：
让 chapter_writer 使用 scene-writing Skill 填充 scene_03
```

同一个 Slot 在未来可能经历多次 Assignment，但仍然是同一个内容对象。

**返修会让这件事真实发生**：审核检出问题后，同一个 Slot 回到 `pending` 重新生产，
产生新的 Assignment——**Slot 还是那个 Slot，Assignment 换了一个**。
这正是两者必须分离的原因。

P0 **支持自动返修**（REQ FR-REVIEW-003），但**不建内容版本历史**：
只保留上一稿供下一轮返修使用，不做多版本留存与查看（那属于 P1）。

---

## 6.3 容器槽位 Container Slot

### 定义

容器槽位是只用于组织结构、不直接承载正文的 Slot。

其属性为：

```text
contentBearing = false
```

例如：

```text
chapter
section
act
```

---

### 容器槽位的作用

容器槽位用于：

- 形成结构树；
- 归类下级内容；
- 决定组装层级；
- 表达内容结构。

容器槽位不创建 Fill Slot Assignment。

---

### 示例

```text
chapter
├── title
├── opening
└── scene_01
```

`chapter` 是容器槽位。

其余槽位是内容承载槽位。

---

## 6.4 内容承载槽位 Content-Bearing Slot

### 定义

内容承载槽位是需要 Agent 生成实际正文的 Slot。

其属性为：

```text
contentBearing = true
```

例如：

```text
title
opening
scene
chapter_end
```

---

### 内容承载槽位的完成条件

一个内容承载槽位只有在以下条件同时满足时才能完成：

- Agent 完成 Fill Slot Assignment；
- 提交目标与当前 Slot 一致；
- 内容不为空；
- 内容满足基础长度限制；
- 系统成功原子保存；
- Producer 信息完整。

---

## 6.5 Slot Instruction

### 定义

Slot Instruction 是 Structure Agent 为某个具体 Slot 创建的局部内容目标。

它回答：

> 这个具体槽位应该完成什么内容任务？

---

### Slot Type 与 Slot Instruction 的区别

Slot Type 描述一类槽位的一般职责。

Slot Instruction 描述当前任务中某个槽位的具体职责。

例如：

```text
Slot Type：scene
一般职责：
通过行动、冲突或信息变化推进正文。
```

```text
Slot：scene_03
具体 Instruction：
主人公发现同事说出的时间与监控记录矛盾，并决定独自去仓库确认。
```

---

## 6.6 Dependency / dependsOn

### 定义

`dependsOn` 表示当前 Slot 所依赖的前置内容槽位。

P0 中它同时承担两个作用：

1. 生产前置条件；
2. 上下文内容来源。

---

### 示例

```ts
{
  id: "scene_03",
  dependsOn: ["scene_02"]
}
```

表示：

- `scene_02` 未完成时，`scene_03` 不得生产；
- 填充 `scene_03` 时，Context 中应包含 `scene_02` 的内容。

---

### 为什么 P0 不区分多种关系

P0 不定义：

- sequence；
- state inheritance；
- information dependency；
- reference；
- semantic relation。

因为基础生产闭环只需要知道：

```text
是否要等待
是否要读取
```

如果未来真实业务证明这两个含义必须分开，可以拆分为：

```text
waitFor
readFrom
```

P0 不提前增加关系实体。

---

## 6.7 Ready Slot

### 定义

Ready Slot 是当前已经具备生产条件的内容槽位。

判断规则为：

```text
status = pending
且
dependsOn 中所有 Slot 均 completed
```

---

### Ready Slot 不是一种持久化状态

Slot 状态仍然是：

```text
pending
running
completed
failed
```

Ready 是系统根据当前状态动态计算出的条件。

数据库中不需要增加：

```text
status = ready
```

避免同一个事实被重复保存。

---

# 7. Agent 工作类概念

## 7.1 Assignment

### 定义

Assignment 是系统交给 Agent 的一项明确工作。

它完整表达：

```text
由谁
使用什么方法
执行什么动作
对什么目标
基于哪些上下文
产生什么格式的结果
```

---

### Assignment 的构成

```text
Agent
+ Skill
+ Operation
+ Target
+ Context
+ Output Contract
```

---

### 示例

```text
Assignment ID：
assignment-103

Agent：
chapter_writer

Skill：
scene-writing v1

Operation：
fill_slot

Target：
scene_03

Context：
Task Input
+ Structure Outline
+ scene_03 Instruction
+ scene_02 Content

Output：
scene_03 正文
```

---

### Assignment 与 Task 的区别

Task 是完整生产任务。

Assignment 是 Task 中的一项具体工作。

例如：

```text
Task：
生成第三章

Assignments：
1. 创建章节结构
2. 填充 title
3. 填充 opening
4. 填充 scene_01
5. 填充 scene_02
6. 填充 chapter_end
```

---

### Assignment 是否必须单独建表

Assignment 是必要的业务概念，但 P0 不要求必须建立独立的 Assignment 数据表。

实现中可以由 Execution Record 同时保存：

- Assignment 的目标；
- Agent；
- Skill；
- Operation；
- Execution 状态。

是否分表属于技术实现问题，不改变概念定义。

---

## 7.2 工作目标 Target

### 定义

Target 是当前 Assignment 直接作用的对象。

P0 有两类 Target：

```text
create_structure
→ Target 为当前 Task 的结构

fill_slot
→ Target 为一个具体 Slot
```

---

### 为什么 Target 必须明确

Target 防止 Agent：

- 自行选择其他槽位；
- 同时改写多个槽位；
- 修改结构外对象；
- 把内容提交到错误位置。

---

## 7.3 工作上下文 Context

### 定义

Context 是系统为一次 Assignment 确定性构建的全部工作输入。

Context 不是 Agent 自行积累的聊天历史。

---

### Fill Slot Context 的组成

```text
Agent Role
+ 当前 Skill
+ 当前 Operation
+ Frozen Task Input
+ Structure Outline
+ Target Slot
+ Slot Instruction
+ DependsOn Slot Contents
+ Content Limits
+ Output Contract
```

---

### 确定性上下文

“确定性”表示：

> 当 Task 状态、Slot、Skill 和 Snapshot 相同时，系统应构建出相同的 Context。

Agent 不应因为：

- 服务重启；
- Provider 会话变化；
- 之前的聊天轮次；
- 无关文件；
- 其他任务；

得到不同的工作信息。

---

### Context 不默认包含什么

默认不包含：

- 所有历史聊天记录；
- 所有 Slot 正文；
- 所有 Skill；
- 全部事件日志；
- Provider 隐式记忆；
- 其他 Agent 的自由文本；
- 其他 Task 的资料。

---

## 7.4 Structure Outline

### 定义

Structure Outline 是当前具体结构的轻量结构视图。

它包含：

- Slot ID；
- Slot Type；
- Parent；
- Order；
- Instruction；
- DependsOn；
- Status。

默认不包含非依赖槽位的正文。

---

### Structure Outline 的作用

它让 Agent 知道：

- 当前 Slot 在整体结构中的位置；
- 前后有哪些内容单元；
- 当前 Slot 承担什么整体作用。

同时避免将全文全部放进 Context。

---

## 7.5 Output Contract

### 定义

Output Contract 是系统规定的 Agent 提交结果格式。

P0 有两种：

```text
structure_proposal_v1
slot_content_v1
```

---

### Output Contract 的作用

它约束：

- 结果必须包含哪些字段；
- 哪些字段允许 Agent填写；
- 哪些字段由系统生成；
- 提交目标必须是什么；
- 内容类型必须是什么。

Output Contract 只验证结构和基础格式，不判断语义质量。

---

## 7.6 Execution Record

### 定义

Execution Record 记录 Assignment 的一次具体执行尝试。

它回答：

- 这次调用何时开始；
- 使用哪个 Agent；
- 使用哪个 Skill；
- 目标是什么；
- 当前状态是什么；
- 是否成功；
- 是否超时；
- 是否被取消；
- 是否成为迟到结果；
- 这是第几次尝试。

---

### Assignment 与 Execution Record 的区别

```text
Assignment
=
要做什么工作

Execution Record
=
某一次实际尝试执行这项工作
```

同一个工作发生重试时：

```text
Assignment 目标不变
Execution Record 增加
```

例如：

```text
填充 scene_03
├── Execution 1：Provider Timeout
└── Execution 2：Succeeded
```

---

## 7.7 Execution Token

### 定义

Execution Token 是一次执行提交结果时必须携带的临时凭证。

其作用是判断：

> 返回结果是否仍属于当前有效执行。

---

### Execution Token 的用途

当发生以下情况时，旧 Token 必须失效：

- 用户停止任务；
- Provider 超时；
- 系统开始重试；
- 服务重启；
- 当前执行被取消。

旧模型结果之后即使返回，也不能写入 Slot。

---

### Execution Token 不是什么

Execution Token 不是：

- Agent 长期权限；
- 复杂 Grant；
- 权威证明；
- 发布证书；
- 用户身份凭证。

它只是防止迟到结果提交的运行时保护机制。

---

## 7.8 Context Hash

### 定义

Context Hash 是对一次 Assignment 的完整确定性 Context 计算出的摘要。

它用于：

- 调试上下文差异；
- 判断重试是否使用相同 Context；
- 复现模型输入；
- 检查是否发生非预期上下文漂移。

Context Hash 不代表内容质量。

---

# 8. 模型与运行基础设施概念

## 8.1 Model

### 定义

Model 是实际执行语言理解和内容生成的底层模型。

例如：

```text
某个 GPT 模型
某个 DeepSeek 模型
某个 Claude 模型
本地开源模型
```

模型提供能力，但不包含业务角色。

---

## 8.2 Provider

### 定义

Provider 是向系统提供模型调用接口的服务。

Provider 负责：

- API 接口；
- 鉴权；
- 模型访问；
- 流式返回；
- Token 统计；
- 调用错误。

---

### Provider 与 Model 的区别

```text
Provider
=
模型访问服务

Model
=
被调用的具体模型
```

同一个 Provider 可以提供多个 Model。

同一个 Model 也可能通过不同 Provider 接入。

---

## 8.3 Agent Runtime

### 定义

Agent Runtime 是系统中负责执行 Agent Assignment 的技术组件。

它负责：

1. 读取 Agent Definition；
2. 读取 Skill；
3. 接收 Context；
4. 构建 Provider 请求；
5. 调用 Model；
6. 向 Agent 暴露正式提交工具；
7. 收集公开输出；
8. 处理 Timeout 和 Abort；
9. 返回执行结果。

---

### Agent Runtime 不负责什么

Agent Runtime 不负责：

- 选择下一个 Slot；
- 判断 Task 是否完成；
- 保存最终状态；
- 组装 Artifact；
- 修改模板；
- 创建结构规则。

这些由生产平台其他系统组件负责。

---

## 8.4 Production Runtime

### 定义

Production Runtime 指完整的任务推进系统。

它包括：

- Task Lifecycle；
- Ready Slot 计算；
- Assignment 创建；
- Context Builder；
- Agent Runtime；
- 结果校验；
- 状态保存；
- Artifact Assembly。

为避免歧义，文档和代码中不建议单独使用“Runtime”一词。

应明确写成：

```text
Agent Runtime
Production Runtime
```

---

# 9. 状态与生命周期概念

## 9.1 Task Status

### 定义

Task Status 表示任务在运行生命周期中的总体状态。

P0 包含：

| 状态 | 含义 |
|---|---|
| ready | 已创建，尚未启动 |
| running | 正在生产 |
| stopped | 被用户或恢复机制停止，可继续 |
| failed | 发生无法自动继续的失败 |
| completed | 最终产物已经成功生成 |

---

## 9.2 Task Phase

### 定义

Task Phase 表示任务当前处于哪一个生产阶段。

P0 包含：

| Phase | 含义 |
|---|---|
| structure | 正在创建具体结构 |
| slots | 正在逐槽填充内容 |
| assembly | 正在组装最终产物 |
| done | 生产已经完成 |

---

### Status 与 Phase 的区别

Status 回答：

> 这个任务当前能否继续运行？

Phase 回答：

> 这个任务当前正在生产什么？

例如：

```text
status = stopped
phase = slots
```

表示：

> 任务停止了，但停止前正在进行槽位填充。

---

## 9.3 Slot Status

### 定义

Slot Status 表示一个内容槽位的生产状态。

| 状态 | 含义 |
|---|---|
| pending | 尚未开始 |
| running | 当前正在由 Agent 处理 |
| completed | 内容已成功保存 |
| failed | 达到最大重试次数后仍未完成 |

---

### Ready 不是 Slot Status

Ready 是动态计算结果，不写入状态字段。

```text
pending + dependencies completed
→ Ready
```

---

# 10. 结果与交付概念

## 10.1 Slot Content

### 定义

Slot Content 是内容 Agent 对某个内容承载 Slot 生成并成功提交的正文。

Slot Content 必须明确绑定：

- Slot；
- Producer Agent；
- Producer Skill；
- Skill Version；
- Producer Execution。

---

### Slot Content 与 Agent 公开文本的区别

Agent 在执行过程中可能输出解释或状态文字。

只有通过正式 `complete_assignment` 提交并通过系统校验的内容，才是 Slot Content。

普通模型回复不能自动成为 Slot Content。

---

## 10.2 Producer

### 定义

Producer 表示某项内容的生产来源。

P0 中，一个完成的内容槽位应记录：

```text
producerAgentId
producerSkillId
producerSkillVersion
producerExecutionId
```

Producer 信息回答：

> 哪个 Agent 使用哪个版本的 Skill，在哪一次执行中生产了这段内容？

Producer 记录用于追踪，不构成权威证明体系。

---

## 10.3 Artifact

### 定义

Artifact 是系统将所有已完成内容槽位组装后形成的最终交付文件。

例如：

```text
chapter.md
report.md
lyrics.txt
storyboard.json
```

---

### Artifact 与 Slot 的区别

Slot 是生产过程中的局部内容单元。

Artifact 是完整交付结果。

```text
多个 Slot Content
        ↓
     Assembler
        ↓
      Artifact
```

---

### Artifact 与 Task 的区别

Task 是一次生产过程。

Artifact 是该生产过程的最终结果。

一个 Task 在 P0 中最多产生一个最终 Artifact。

---

## 10.4 Assembler

### 定义

Assembler 是系统中负责将结构槽内容组合为最终 Artifact 的确定性组件。

P0 中使用：

```text
markdown_concat_v1
```

---

### Assembler 可以做什么

- 按结构顺序遍历 Slot；
- 跳过容器 Slot；
- 读取 Slot Content；
- 插入固定分隔符；
- 输出文件；
- 计算 Checksum。

---

### Assembler 不能做什么

- 调用模型；
- 重写正文；
- 创作过渡句；
- 总结全文；
- 统一语言风格；
- 补齐缺失槽位；
- 判断内容语义质量。

若某项工作需要语义判断，应创建显式 Slot，并由 Agent 使用 Skill 完成。

---

## 10.5 Checksum

### 定义

Checksum 是对最终 Artifact 文件内容计算出的摘要。

它用于判断：

- 文件是否发生变化；
- 相同输入是否组装出相同结果；
- 数据库记录与实际文件是否一致。

Checksum 不代表审核通过，也不代表内容正确。

---

# 11. 系统行为类概念

## 11.1 系统 System

### 定义

本文档中的“系统”指除 Agent 内容判断之外的确定性平台代码。

系统负责：

- 调度；
- Binding 解析；
- Ready Slot 计算；
- Context 构建；
- Provider 调用控制；
- 结果校验；
- 持久化；
- 状态推进；
- Assembly；
- 生命周期控制。

---

### 系统与 Agent 的职责边界

| 工作 | Agent | 系统 |
|---|---:|---:|
| 决定具体章节需要几个场景 | 是 | 否 |
| 定义场景内容目标 | 是 | 否 |
| 生成场景正文 | 是 | 否 |
| 检查 Slot ID 是否重复 | 否 | 是 |
| 检查依赖是否成环 | 否 | 是 |
| 选择当前 Ready Slot | 否 | 是 |
| 选择 Agent 和 Skill | 否 | 是 |
| 构建工作上下文 | 否 | 是 |
| 保存 Slot Content | 否 | 是 |
| 设置 Slot Completed | 否 | 是 |
| 判断所有 Slot 是否完成 | 否 | 是 |
| 组装 Markdown | 否 | 是 |
| 设置 Task Completed | 否 | 是 |

---

## 11.2 Validation

### 定义

Validation 是系统执行的确定性规则检查。

P0 包括：

- 模板校验；
- 结构校验；
- Assignment 校验；
- Execution Token 校验；
- Slot Content 基础校验；
- Artifact 文件校验。

---

### Validation 与 Review 的区别

Validation 检查确定性规则。

例如：

```text
Slot ID 是否唯一
依赖是否成环
内容是否为空
长度是否超限
目标 Slot 是否一致
```

Review 判断语义，**由模型执行，结果不确定**。

**P0 实现的 Review 是「按判据找错」，不是「给内容打分」。** 这个区别是刚性的：

| | 例子 | P0 是否实现 |
|---|---|---|
| **按判据找错** | 首段是否接得上上一场的结尾状态；有没有用心理解释代替可见事件 | ✅ 实现 |
| **整体质量评价** | 场景是否有张力；文章整体是否优秀 | ❌ 不实现，也不打算实现 |

后者不进入本系统的任何路径：没有评分、没有等级、没有「优秀/合格」判定。
系统只回答「按这条判据，找到问题了吗」。

三者的完整分工（另见技术方案「validation 与 guidance」一节）：

| 类别 | 谁来判 | 违反的后果 |
|---|---|---|
| Validation | 代码，确定性 | 提交被拒，内容不落库 |
| **Review 判据** | **模型，非确定性** | **内容已落库，走返修；检不出则放行** |
| 写作要求 guidance | 无人强制 | 只注入 Agent 上下文 |

⚠️ **Review 找不到问题 ≠ 内容合格。** 各判据的实际检出能力差异极大，
实测中存在长期检不出任何问题的判据。因此系统一律表述为「未检出问题」，
**绝不表述为「审核通过」**（REQ FR-REVIEW-004）。

---

## 11.3 Atomic Commit

### 定义

Atomic Commit 表示一组状态变更必须同时成功或同时失败。

例如提交 Slot Content 时，以下操作必须是一个整体：

```text
保存 Content
+ 保存 Producer
+ Slot 变为 completed
+ Execution 变为 succeeded
+ 清除 Active Execution
```

不能出现只完成其中一部分的情况。

---

## 11.4 Deterministic / 确定性

### 定义

确定性表示：

> 相同的权威输入和相同状态应产生相同的系统判断或系统输出。

P0 中以下部分应当确定：

- Binding 解析；
- Ready Slot 选择；
- Context 内容组成；
- 结构校验；
- 状态推进；
- Artifact Assembly。

模型生成内容本身不要求完全确定。

---

# 12. 完整示例

以下示例展示核心概念如何组合。

## 12.1 模板

```text
Template：
zhihu-chapter-v1
```

模板声明：

```text
Structure Agent：
structure_designer

Structure Skill：
chapter-structure-design

scene Slot Binding：
chapter_writer + scene-writing

Output：
chapter.md
```

---

## 12.2 创建 Task

用户输入：

```text
Task Name：
生成第三章

Task Input：
主人公在深夜接到失踪同事的电话，
并在通话中发现对方可能正被监视。
```

系统冻结 Template、Agent、Skill 和 Task Input，创建：

```text
Task：
task-001
status = ready
phase = structure
```

---

## 12.3 创建结构 Assignment

系统创建：

```text
Assignment：
assignment-001

Operation：
create_structure

Agent：
structure_designer

Skill：
chapter-structure-design

Target：
task-001 的具体结构
```

Structure Agent 提交：

```text
chapter
├── title
├── opening
├── scene_01
├── scene_02
├── scene_03
└── chapter_end
```

系统通过 Validation 后保存 Slot。

---

## 12.4 填充场景 Slot

系统判断：

```text
scene_02.status = pending
scene_02.dependsOn = [scene_01]
scene_01.status = completed
```

所以 `scene_02` 是 Ready Slot。

系统根据 Binding 创建：

```text
Assignment：
assignment-004

Operation：
fill_slot

Agent：
chapter_writer

Skill：
scene-writing

Target：
scene_02
```

Context 包含：

```text
Agent Role
+ scene-writing Skill
+ Frozen Task Input
+ Structure Outline
+ scene_02 Instruction
+ scene_01 Content
```

Agent 提交 `scene_02` 正文。

系统校验并原子保存。

---

## 12.5 组装 Artifact

所有内容承载 Slot 完成后：

```text
Task.phase = assembly
```

Assembler 按顺序组合：

```text
title.content
+ opening.content
+ scene_01.content
+ scene_02.content
+ scene_03.content
+ chapter_end.content
```

生成：

```text
chapter.md
```

然后：

```text
Task.status = completed
Task.phase = done
```

---

# 13. P0 明确不使用的概念

为了避免在基础阶段重新引入复杂度，以下概念不属于 P0 核心模型。

## 13.1 WorkItem

P0 不建立独立 WorkItem 实体。

当前可执行工作由：

```text
Task 状态
+ Slot 状态
+ dependsOn
```

动态推导。

系统使用 Assignment 表示一次明确工作。

---

## 13.2 Relation

P0 不建立通用 Relation 实体。

仅使用：

```text
parentId
order
dependsOn
```

表达组织关系和生产依赖。

---

## 13.3 Review

**P0 实现槽位级语义审核**（REQ FR-REVIEW-001..004）。

形态：Slot Type 可选绑定一个 Review Skill；绑定后，槽位内容通过确定性 Validation
落库即进入 `reviewing`，Review Skill 声明的每一条判据各跑一次独立 Assignment。
**审核是槽位「完成」的组成部分**，不是完成之后的独立流程——因此下游槽位
永远只读到已审结算过的内容，不存在「上游改了下游要不要重做」。

不实现的部分：整体质量评价、跨槽位/全局审核、人工审核与人工打回。

---

## 13.4 Finding

**两个同名概念，必须分清。**

**不实现**：旧权威审核体系里的 Finding 生命周期——

```text
open
repair_planned
addressed
verified_closed
```

以及与之耦合的 Repair Grant、Scope Expansion、Evidence。

**实现**：**Review Finding**——一段取自待审内容的引文，加一句问题说明。
它必须通过**确定性引文校验**才被采纳（校验不过即丢弃），
不携带状态机、不携带授权、不携带评分。它是一次性的返修依据，
不是一个有生命周期的实体。

---

## 13.5 Repair Grant

P0 不建立返修授权和扩权协议。**这一条不变。**

P0 确有**自动局部返修**（REQ FR-REVIEW-003），但它没有「授权」这一层：
检出问题即返修，轮次上限来自 Slot Type 定义，耗尽即按现状完成。
没有谁向谁申请，也没有范围协商。

人工发起的返修（手动重生成、用户填写返修指令）仍属后续阶段。

---

## 13.6 Seal

P0 不建立 Seal、Seal Record 或 Seal Gate。

所有内容槽位完成并成功组装 Artifact 后，Task 直接 Completed。

---

## 13.7 Submitter Agent

P0 不需要 Submitter Agent。

最终完成是系统行为，不需要另一个 Agent 宣布提交。

---

## 13.8 Migration

P0 中结构创建并校验后冻结。

不支持生产期间：

- 新增 Slot；
- 删除 Slot；
- 合并 Slot；
- 拆分 Slot；
- 修改依赖；
- 迁移内容。

---

## 13.9 Capability、Evidence、Promotion

P0 不建立：

- Runtime Capability；
- Qualification；
- Benchmark Evidence；
- Promotion；
- 发布证明。

功能是否可用由普通代码版本、测试和配置管理决定。

---

# 14. 推荐统一用词

后续文档和代码建议统一使用以下名称。

| 中文名称 | 英文名称 | 推荐代码名称 |
|---|---|---|
| 模板 | Template | `TemplateDefinition` |
| 任务 | Task | `Task` |
| 任务输入 | Task Input | `task.input` |
| 模板快照 | Task Snapshot | `TaskSnapshot` |
| 具体结构 | Concrete Structure | `ConcreteStructure` |
| 结构槽 | Slot | `Slot` |
| 槽位类型 | Slot Type | `SlotTypeDefinition` |
| 容器槽位 | Container Slot | `contentBearing: false` |
| 内容承载槽位 | Content-Bearing Slot | `contentBearing: true` |
| 槽位目标 | Slot Instruction | `slot.instruction` |
| 生产依赖 | Dependency | `slot.dependsOn` |
| 可生产槽位 | Ready Slot | `isReadySlot()` |
| Agent 定义 | Agent Definition | `AgentDefinition` |
| Skill 定义 | Skill Definition | `SkillDefinition` |
| 内容动作 | Operation | `create_structure` / `fill_slot` |
| 绑定 | Binding | `OperationBinding` |
| 工作指派 | Assignment | `AgentAssignment` |
| 工作目标 | Target | `targetSlotId` |
| 工作上下文 | Context | `AssignmentContext` |
| 结构概要 | Structure Outline | `StructureOutline` |
| 输出契约 | Output Contract | `OutputContract` |
| 执行记录 | Execution Record | `ExecutionRecord` |
| 执行凭证 | Execution Token | `executionToken` |
| 上下文摘要 | Context Hash | `contextHash` |
| 模型 | Model | `model` |
| 模型服务商 | Provider | `provider` |
| Agent 运行时 | Agent Runtime | `AgentRuntime` |
| 生产运行时 | Production Runtime | `ProductionRuntime` |
| 槽位内容 | Slot Content | `slot.content` |
| 生产来源 | Producer | `producer*` |
| 组装器 | Assembler | `Assembler` |
| 最终产物 | Artifact | `ArtifactRecord` |
| 文件摘要 | Checksum | `checksum` |
| 系统校验 | Validation | `validate*` |
| 原子提交 | Atomic Commit | 数据库事务 |
| 任务状态 | Task Status | `task.status` |
| 生产阶段 | Task Phase | `task.phase` |
| 槽位状态 | Slot Status | `slot.status` |

---

# 15. 名词使用原则

后续文档和讨论应遵循以下原则。

## 15.1 不将 Slot 称为 WorkItem

Slot 是内容对象。

Assignment 才是针对 Slot 的工作。

---

## 15.2 不将 Agent 称为模型

模型是底层能力。

Agent 是具有角色和配置的内容生产主体。

---

## 15.3 不将 Skill 称为 Prompt

Skill 是完整工作方法。

Prompt 是某次调用时根据 Skill 和 Context 生成的具体输入。

---

## 15.4 不将 Template 称为 Structure

Template 定义生产方案。

Structure 是一次 Task 中实际创建的槽位结构。

---

## 15.5 不将 Validation 称为 Review

Validation 检查确定性规则，由代码执行，结果确定。

Review 按判据找语义问题，由模型执行，**结果不确定**。

**两者现在都已实现，因此这条命名纪律比以前更要紧**，且后果完全不同：

| | Validation 失败 | Review 检出问题 |
|---|---|---|
| 内容落库了吗 | 没有，提交被拒 | 已落库 |
| 后续动作 | 计入重试 | 走返修，轮次耗尽即按现状完成 |
| 通过意味着什么 | 该规则确实满足 | **只意味着没找到问题，不意味着没有问题** |

最后一行是不许含糊的地方：把 Review 的结果说成 Validation 那样的「通过」，
就是把一个不确定的探测结果冒充成确定的保证（REQ FR-REVIEW-004）。

---

## 15.6 不将 Slot Content 称为 Artifact

Slot Content 是局部内容。

Artifact 是所有必要 Slot 组装后的完整交付文件。

---

# 16. 核心定义总结

Forge Core vNext 的核心概念可以最终归纳为：

> **模板定义生产方案，任务承载一次具体生产，系统为 Agent 创建明确的工作指派，Agent 使用明确的 Skill 对具体结构槽执行内容动作，系统保存结果并将所有槽位确定性组装为最终产物。**

其中：

```text
Agent
=
内容生产主体

Skill
=
Agent 的工作方法

Slot
=
Agent 的工作对象

Assignment
=
系统交给 Agent 的具体工作

Context
=
系统为工作确定性提供的信息

Template
=
Agent、Skill、Slot Type 与生产规则的组合方案

Task
=
模板的一次具体运行

Artifact
=
所有必要 Slot 完成后的最终交付结果
```

P0 的最小生产闭环为：

```text
Template
→ Task
→ Structure Assignment
→ Agent 创建 Slots
→ Fill Slot Assignment
→ Agent 填充 Slot Content
→ System Assembly
→ Artifact
```