# Forge Core vNext：结构槽原生 Agent 内容生产平台需求规格说明书

**文档版本：** V0.1  
**文档状态：** 初版需求规格  
**目标阶段：** P0 最小可运行闭环  
**核心方法：** 第一性原则、奥卡姆剃刀、“如无必要，勿增实体”  
**产品代号：** Forge Core vNext

---

## 1. 文档目的

本文档用于定义 Forge Core vNext 第一阶段的产品边界、核心概念、生产流程、功能需求、状态模型和验收标准。

本阶段不从现有 Forge Core 的 `basic`、`structured_slots v1` 或 `authoritative review v2` 代码结构反推需求，而是从结构槽生产模式的第一性原理出发，重新定义一个最小、清晰、可运行的生产平台。

本文档重点回答以下问题：

1. Agent、Skill 和结构槽之间是什么关系；
2. 结构槽模式最少需要哪些功能才能完成生产闭环；
3. 哪些功能属于第一阶段必须实现；
4. 哪些功能暂不进入第一阶段；
5. 系统如何保证 Agent 工作目标和上下文明确；
6. 系统如何从用户输入推进到最终产物。

---

## 2. 产品背景

现有 Forge Core 在引入结构槽之前，已经具备较完整的模板、Agent、Skill、任务调度、产物管理和浏览器展示能力。

在引入结构槽后，系统逐渐叠加了：

- 多套生产协议；
- 多种 Turn Contract；
- Map Candidate 和 Map Activation；
- 多轮审核；
- Finding 生命周期；
- Repair Grant；
- Relation Review；
- Migration；
- System Seal；
- Capability；
- Evidence；
- Publication Pin；
- 多套存储、投影、API 和前端视图。

这些能力并非全部没有价值，但它们同时进入基础生产链，使“生成一个结构化内容产物”需要依赖过多实体和协议。

Forge Core vNext 不再以修复现有权威审核协议为第一目标，而是先重新建立结构槽生产模式最基础的生产闭环。

---

## 3. 产品定义

Forge Core vNext 是：

> **一个以 Agent 为内容生产主体、以 Skill 为工作方法、以结构槽为工作对象，由系统负责调度、上下文装配、状态管理和最终组装的内容生产平台。**

结构槽生产可以表达为：

```text
用户输入
  ↓
结构设计 Agent 使用结构设计 Skill
  ↓
创建具体结构槽
  ↓
系统选择当前可生产槽位
  ↓
内容 Agent 使用对应 Skill 填充槽位
  ↓
系统保存槽位内容并推进状态
  ↓
所有内容槽位完成
  ↓
系统确定性组装最终产物
```

形式化表达为：

```text
Structure =
  StructureAgent(
    StructureSkill,
    TaskInput
  )

SlotContent[i] =
  ContentAgent(
    SlotSkill[i],
    DeterministicContext[i],
    Slot[i]
  )

Artifact =
  Assemble(
    Structure,
    SlotContents
  )
```

---

## 4. Agent、Skill、结构槽和系统的关系

### 4.1 Agent：生产主体

Agent 是执行内容工作的主体。

Agent 负责：

- 根据用户输入设计具体内容结构；
- 决定需要创建哪些结构槽；
- 为结构槽定义内容目标；
- 根据 Skill 生成结构槽内容；
- 执行内容层面的判断、组织和表达。

Agent 不只是一个无身份的模型调用。每个 Agent 应具有明确的：

- 身份；
- 工作角色；
- 使用模型；
- 可执行动作；
- 可绑定 Skill。

---

### 4.2 Skill：Agent 的工作方法

Skill 是 Agent 执行某项生产工作的标准方法。

Skill 应至少定义：

- 工作目标；
- 适用动作；
- 适用槽位类型；
- 输入信息；
- 工作步骤；
- 内容约束；
- 禁止事项；
- 输出要求。

Skill 不是任务状态，也不是生产对象。Skill 不直接创建任务、更新槽位状态或决定任务完成。

第一阶段规定：

> 每一次 Agent Assignment 必须绑定一个明确的主要 Skill。

Agent 不得在一次工作中自行读取全部 Skill，也不得根据不完整上下文随机选择工作方法。

---

### 4.3 结构槽：Agent 的工作对象

结构槽是内容生产中的基本工作单元。

结构槽回答以下问题：

1. 这是哪个内容单元；
2. 它属于哪种类型；
3. 它处于结构中的什么位置；
4. 它需要完成什么内容目标；
5. 它依赖哪些前置槽位；
6. 它当前是否已经完成；
7. 它当前保存了什么内容；
8. 它由哪个 Agent 使用哪个 Skill 创建。

结构槽不是：

- Agent；
- WorkItem；
- Provider Attempt；
- 审核 Finding；
- 权限证明；
- 发布证明；
- 分布式事务单元。

---

### 4.4 系统：生产过程控制者

系统负责工程层面的控制，包括：

- 根据模板选择 Agent；
- 根据槽位类型选择 Skill；
- 判断当前槽位是否可以生产；
- 构建 Agent 的确定性上下文；
- 调用模型 Provider；
- 校验 Agent 输出；
- 原子保存结果；
- 推进槽位和任务状态；
- 拒绝停止后的迟到结果；
- 确定性组装最终产物。

核心边界为：

> **Agent 拥有内容生产权，系统拥有生产过程控制权。**

---

## 5. 核心设计原则

### 5.1 所有语义内容由 Agent 生产

以下内容层面的动作必须由 Agent 执行：

- 创建具体内容结构；
- 定义结构槽的内容目标；
- 生成结构槽内容；
- 进行语义改写；
- 创建需要创造性判断的衔接内容。

系统只能执行确定性工作，例如：

- 校验结构；
- 排序；
- 选择 Ready Slot；
- 装配上下文；
- 保存内容；
- 拼接文件；
- 计算状态。

若最终组装阶段需要补写过渡内容、统一语言或改写正文，则必须将该工作显式建模为结构槽，由 Agent 使用对应 Skill 完成。

---

### 5.2 每次 Agent 工作必须绑定 Skill

系统不得只向 Agent 提供一段临时 Prompt，然后要求 Agent自行决定如何工作。

每个 Agent Assignment 必须明确包含：

```text
Agent
+ Skill
+ Operation
+ Target
+ Deterministic Context
```

---

### 5.3 Agent 上下文必须由系统确定性构建

Agent 不继承随机聊天历史。

一次 Assignment 的上下文只能来自明确声明的数据：

```text
Agent Role
+ 当前 Skill
+ 当前 Operation
+ 冻结的 Task Input
+ 当前结构或目标 Slot
+ 结构概要
+ 明确依赖的已完成 Slot 内容
+ 上一次确定性校验错误（仅重试时）
```

默认不注入：

- 之前所有 Agent 对话；
- 所有事件日志；
- 所有已完成槽位全文；
- 所有 Skill；
- 其他任务内容；
- Provider 隐式会话记忆；
- 未声明的项目文件。

---

### 5.4 系统只有一套生产协议

P0 阶段不区分：

```text
basic
structured_slots
authoritative_review
```

所有内容生产统一使用：

```text
创建结构
→ 填充结构槽
→ 组装产物
```

一个普通单段文档可以退化为只有一个内容槽位的结构，不再需要独立的 Basic Runtime。

---

### 5.5 任务完成只能由系统推导

Agent 不得自行设置：

```text
Task Completed
Slot Completed
Artifact Final
```

任务完成条件为：

```text
所有内容承载槽位均已完成
且
系统成功组装最终产物
```

---

### 5.6 第一阶段采用最少实体

P0 阶段核心内容实体只保留：

- Task；
- Slot。

配置定义包括：

- Template；
- Agent Definition；
- Skill Definition。

运行期可以保存 Execution Record，用于超时、停止、重试和迟到结果校验，但 Execution Record 不属于内容领域实体。

最终 Artifact 是由 Task 和 Slot 内容派生的结果，不建立复杂发布生命周期。

---

## 6. P0 产品目标

P0 阶段必须完成以下闭环：

1. 用户选择模板并创建任务；
2. 系统冻结模板、Agent、Skill 和用户输入；
3. 结构设计 Agent 使用指定 Skill 创建具体结构；
4. 系统校验并保存结构槽；
5. 系统确定当前可以生产的槽位；
6. 系统为槽位构建确定性上下文；
7. 内容 Agent 使用指定 Skill 填充槽位；
8. 系统原子保存槽位内容；
9. 系统依次推进全部槽位；
10. 系统确定性组装最终产物；
11. 用户能够查看任务过程、槽位内容和最终产物；
12. 服务重启、Provider 超时和用户停止不会造成重复提交或永久卡死。

---

## 7. P0 非目标

以下能力不进入 P0：

- Slot Review；
- Global Review；
- Finding；
- Repair Grant；
- Scope Expansion；
- Relation Review；
- Map Candidate；
- Map Activation；
- Seal；
- Submitter Agent；
- Capability；
- Evidence；
- Benchmark Promotion；
- Publication Pin；
- Blob Closure；
- 结构迁移；
- 结构版本合并；
- 内容版本历史；
- 局部人工编辑器；
- 多 Worker；
- 槽位并发执行；
- 跨进程 Lease；
- 多 Agent 自由消息路由；
- 动态 Skill 搜索；
- Agent 自主选择模型；
- Agent 自主选择工作对象；
- 完整事件溯源；
- 通过事件重放恢复全部状态；
- 可视化模板编辑器。

这些能力只有在基础结构槽生产闭环稳定，并且真实业务明确提出需求后，才进入后续版本。

---

## 8. 用户与系统角色

### 8.1 任务操作用户

任务操作用户可以：

- 浏览模板；
- 创建任务；
- 填写模板输入；
- 启动任务；
- 停止任务；
- 继续已停止任务；
- 重试失败任务；
- 查看结构树；
- 查看当前 Agent 和 Skill；
- 查看已完成槽位内容；
- 查看和下载最终产物。

P0 不提供用户直接修改结构和槽位正文的能力。

---

### 8.2 模板开发者

模板开发者负责：

- 定义输入字段；
- 定义允许使用的槽位类型；
- 定义 Agent；
- 定义 Skill；
- 绑定结构创建动作；
- 绑定不同槽位类型的填充动作；
- 定义资源上限；
- 定义输出文件和组装方式。

P0 阶段模板通过代码或配置文件维护，不提供图形化编辑器。

---

### 8.3 Agent

Agent 是运行时内容生产角色，不是平台用户。

Agent 只在系统创建 Assignment 后执行，不主动扫描任务，不主动领取工作，不自由选择目标槽位。

---

## 9. 核心概念模型

### 9.1 Template

Template 定义一种结构槽生产方案。

```ts
interface TemplateDefinition {
  id: string;
  version: string;
  name: string;
  description: string;

  inputFields: InputFieldDefinition[];

  slotTypes: SlotTypeDefinition[];
  agents: AgentDefinition[];
  skills: SkillReference[];

  bindings: {
    createStructure: OperationBinding;
    fillSlotByType: Record<string, OperationBinding>;
  };

  limits: TemplateLimits;

  output: {
    fileName: string;
    mediaType: string;
    assembler: "markdown_concat_v1";
  };
}
```

---

### 9.2 Agent Definition

```ts
interface AgentDefinition {
  id: string;
  name: string;
  role: string;

  provider: string;
  model: string;

  systemInstruction: string;
}
```

Agent Definition 只描述 Agent 身份和运行配置，不保存任务状态。

---

### 9.3 Skill Definition

```ts
interface SkillDefinition {
  id: string;
  version: string;
  name: string;

  operation: "create_structure" | "fill_slot";

  applicableSlotTypes: string[];

  instruction: string;

  outputContract:
    | "structure_proposal_v1"
    | "slot_content_v1";
}
```

P0 阶段每次 Assignment 只加载一个 Skill。

---

### 9.4 Slot Type

Slot Type 由模板定义。

```ts
interface SlotTypeDefinition {
  id: string;
  name: string;
  description: string;

  contentBearing: boolean;

  minContentChars?: number;
  maxContentChars?: number;
}
```

`contentBearing: false` 的槽位是结构容器，不触发内容填充 Assignment。

---

### 9.5 Task

```ts
interface Task {
  id: string;
  name: string;

  templateId: string;
  templateVersion: string;
  snapshotHash: string;

  input: Record<string, string>;

  status:
    | "ready"
    | "running"
    | "stopped"
    | "completed"
    | "failed";

  phase:
    | "structure"
    | "slots"
    | "assembly"
    | "done";

  activeExecutionId: string | null;

  errorCode: string | null;
  errorMessage: string | null;

  artifactPath: string | null;
  artifactChecksum: string | null;

  createdAt: string;
  updatedAt: string;
}
```

---

### 9.6 Slot

```ts
interface Slot {
  id: string;
  taskId: string;

  type: string;

  parentId: string | null;
  order: number;

  instruction: string;
  dependsOn: string[];

  contentBearing: boolean;

  status:
    | "pending"
    | "running"
    | "completed"
    | "failed";

  content: string | null;

  producerAgentId: string | null;
  producerSkillId: string | null;
  producerSkillVersion: string | null;
  producerExecutionId: string | null;

  errorCode: string | null;
  errorMessage: string | null;

  createdAt: string;
  updatedAt: string;
}
```

容器槽位在结构提交后直接处于 `completed`，但不包含正文内容。

---

### 9.7 Execution Record

Execution Record 是运行记录，不是内容领域实体。

```ts
interface ExecutionRecord {
  id: string;
  taskId: string;

  operation:
    | "create_structure"
    | "fill_slot";

  targetSlotId: string | null;

  agentId: string;
  skillId: string;
  skillVersion: string;

  executionTokenHash: string;
  contextHash: string;

  status:
    | "created"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "stale";

  attemptNumber: number;

  errorCode: string | null;
  errorMessage: string | null;

  startedAt: string | null;
  finishedAt: string | null;
}
```

Execution Record 用于：

- 防止迟到结果提交；
- Provider 超时；
- 停止和取消；
- 重试；
- 运行过程展示；
- 问题排查。

---

### 9.8 Artifact

P0 中 Artifact 是最终组装结果，不建立多版本生产体系。

```ts
interface ArtifactRecord {
  taskId: string;

  fileName: string;
  mediaType: string;

  path: string;
  checksum: string;
  byteSize: number;

  createdAt: string;
}
```

---

## 10. 模板需求

### FR-TPL-001 模板声明

模板必须声明：

- 输入字段；
- 允许使用的槽位类型；
- Agent；
- Skill；
- 结构创建绑定；
- 各槽位类型的填充绑定；
- 最大槽位数量；
- 最大结构深度；
- Provider 重试次数；
- 输出文件名；
- 确定性 Assembler。

---

### FR-TPL-002 Agent 与 Skill 绑定

模板必须显式绑定：

```text
create_structure
→ Agent
→ Skill
```

以及：

```text
fill_slot
+ Slot Type
→ Agent
→ Skill
```

系统不得让 Agent 在运行时自行决定使用哪个 Skill。

---

### FR-TPL-003 模板校验

加载模板时，系统必须校验：

- Agent ID 唯一；
- Skill ID 唯一；
- Slot Type ID 唯一；
- 所有 Binding 引用的 Agent 存在；
- 所有 Binding 引用的 Skill 存在；
- Skill 的 Operation 与 Binding 一致；
- Fill Slot Binding 覆盖所有 `contentBearing: true` 的槽位类型；
- Skill 的适用槽位类型包含对应 Slot Type；
- 输出文件名合法；
- Limits 合法。

无效模板不得用于创建任务。

---

### FR-TPL-004 模板快照

创建任务时，系统必须冻结：

- Template Definition；
- Agent Definition；
- Skill 内容；
- Skill 版本；
- Slot Type；
- Operation Binding；
- Output 配置；
- 用户输入。

任务运行期间不得读取已经发生变化的模板源文件或 Skill 源文件。

---

## 11. 任务创建需求

### FR-TASK-001 创建任务

用户选择模板并填写输入后，系统创建 Task。

创建时必须：

1. 校验必填输入；
2. 创建模板快照；
3. 计算快照 Hash；
4. 保存冻结输入；
5. 将 Task 状态设置为 `ready`；
6. 将 Task Phase 设置为 `structure`。

---

### FR-TASK-002 启动任务

用户启动任务后：

```text
Task.status = running
Task.phase = structure
```

系统创建结构设计 Assignment。

---

### FR-TASK-003 任务不可变输入

任务创建后，P0 不允许修改：

- Template；
- Agent；
- Skill；
- 用户输入；
- Operation Binding；
- Slot Type。

需要使用新配置时，应创建新任务。

---

## 12. Agent Assignment

### 12.1 Assignment 定义

Assignment 是系统交给 Agent 的一项明确工作。

```ts
interface AgentAssignment {
  id: string;
  executionToken: string;

  operation:
    | "create_structure"
    | "fill_slot";

  agent: {
    id: string;
    role: string;
  };

  skill: {
    id: string;
    version: string;
    instruction: string;
  };

  targetSlotId: string | null;

  context: AssignmentContext;
}
```

---

### 12.2 Assignment 不由 Agent 自行领取

P0 不实现 Agent 自主领取任务。

Assignment 只能由系统根据当前 Task 和 Slot 状态创建。

---

### 12.3 单一写入动作

Agent 运行期间只允许通过一个正式写动作提交结果：

```ts
complete_assignment({
  assignmentId: string;
  executionToken: string;

  result:
    | {
        kind: "structure";
        rootSlotId: string;
        slots: SlotProposal[];
      }
    | {
        kind: "slot_content";
        slotId: string;
        content: string;
      };
});
```

Agent 不得直接：

- 写数据库；
- 修改 Slot 状态；
- 设置 Task 状态；
- 生成 Artifact Record；
- 创建下一个 Assignment；
- 选择下一个 Agent；
- 宣布任务完成。

---

## 13. 创建结构需求

### FR-STR-001 创建结构 Assignment

结构创建 Assignment 必须绑定：

- 模板声明的 Structure Agent；
- 模板声明的 Structure Skill；
- 冻结的用户输入；
- 模板允许的 Slot Type；
- Slot Type 说明；
- 最大槽位数量；
- 最大结构深度；
- 输出 Contract。

---

### FR-STR-002 Structure Agent 职责

Structure Agent 负责决定：

- 创建哪些槽位；
- 每个槽位的 ID；
- 每个槽位的类型；
- 父子关系；
- 同级顺序；
- 每个槽位的内容目标；
- 槽位之间的必要依赖。

Structure Agent 不得决定：

- 每个槽位使用哪个 Agent；
- 每个槽位使用哪个 Skill；
- Provider；
- 模型；
- Slot 状态；
- Task 状态。

Agent 和 Skill 由系统根据模板绑定解析。

---

### FR-STR-003 Slot Proposal

Structure Agent 提交的 Slot Proposal 格式为：

```ts
interface SlotProposal {
  id: string;
  type: string;

  parentId: string | null;
  order: number;

  instruction: string;
  dependsOn: string[];
}
```

以下字段由系统生成，不允许 Agent 提交：

- status；
- content；
- producerAgentId；
- producerSkillId；
- producerExecutionId；
- errorCode；
- createdAt；
- updatedAt。

---

### FR-STR-004 结构确定性校验

系统必须校验：

1. Slot 数量大于 0；
2. Slot 数量不超过模板上限；
3. Slot ID 唯一；
4. Slot ID 满足安全字符规则；
5. 只有一个根槽位；
6. 根槽位 `parentId = null`；
7. 非根槽位的 Parent 必须存在；
8. Parent 关系不得成环；
9. 结构深度不得超过模板上限；
10. 同一 Parent 下 `order` 不重复；
11. Slot Type 必须属于模板允许范围；
12. 根槽位必须为非内容承载类型；
13. 每个内容承载槽位必须具有非空 Instruction；
14. `dependsOn` 引用的槽位必须存在；
15. `dependsOn` 不得引用自身；
16. 依赖图不得成环；
17. `dependsOn` 只能引用内容承载槽位；
18. 结构中至少存在一个内容承载槽位。

---

### FR-STR-005 原子提交结构

结构校验全部通过后，系统在一个事务中：

1. 保存所有 Slot；
2. 将容器 Slot 状态设置为 `completed`；
3. 将内容 Slot 状态设置为 `pending`；
4. 将结构 Execution 设置为 `succeeded`；
5. 将 Task Phase 更新为 `slots`；
6. 清除 Task 的 Active Execution。

任一校验或保存失败时，不得保存部分 Slot。

---

### FR-STR-006 结构校验失败重试

结构校验失败时，系统可以在模板限制内重新创建结构 Assignment。

新的 Assignment 可以附带：

- 上一次结构提案；
- 确定性校验错误列表。

不得附带无关历史对话。

超过最大重试次数后：

```text
Task.status = failed
Task.errorCode = STRUCTURE_RETRY_EXHAUSTED
```

---

## 14. 槽位调度需求

### FR-SCH-001 Ready Slot

内容槽位满足以下条件时为 Ready：

```text
Slot.status = pending
且
Slot.dependsOn 中所有槽位均为 completed
```

---

### FR-SCH-002 确定性选择

P0 一次只选择一个 Ready Slot。

当存在多个 Ready Slot 时，系统按以下顺序选择：

1. 文档树深度优先顺序；
2. 同级 `order`；
3. Slot ID 字典序作为最终稳定排序。

相同结构和相同状态必须得到相同的下一 Slot。

---

### FR-SCH-003 不允许 Agent 选择目标槽位

Agent 不得：

- 主动扫描所有 Pending Slot；
- 自行领取 Slot；
- 修改 DependsOn；
- 选择其他 Slot 作为工作对象。

系统在 Assignment 中明确指定目标 Slot。

---

### FR-SCH-004 无可执行槽位处理

若不存在 Ready Slot：

- 如果所有内容承载槽位均已完成，进入 Assembly；
- 如果存在 Failed Slot，Task 进入 Failed；
- 如果仍有 Pending Slot，但没有 Ready Slot，Task 进入 Failed，并记录：

```text
DEPENDENCY_DEADLOCK
```

正常情况下，依赖环应在结构提交前被拒绝，因此该错误主要用于保护异常数据。

---

## 15. 确定性上下文需求

### FR-CTX-001 Structure Assignment Context

Structure Agent 的上下文必须包含：

```text
Agent Role
+ Structure Skill
+ Operation = create_structure
+ Frozen Task Input
+ Allowed Slot Types
+ Slot Type Descriptions
+ Structure Limits
+ Output Contract
```

默认不得包含其他任务或历史执行内容。

---

### FR-CTX-002 Fill Slot Assignment Context

填充 Slot 的上下文必须包含：

```text
Agent Role
+ 当前 Slot 对应的 Skill
+ Operation = fill_slot
+ Frozen Task Input
+ Structure Outline
+ Target Slot
+ Target Slot Instruction
+ DependsOn Slot Contents
+ Slot Type Content Limits
+ Output Contract
```

---

### FR-CTX-003 Structure Outline

Structure Outline 只包含：

- Slot ID；
- Slot Type；
- Parent；
- Order；
- Instruction；
- DependsOn；
- Status。

Structure Outline 默认不包含其他非依赖槽位的正文内容。

---

### FR-CTX-004 依赖内容

系统只向 Agent 注入 `dependsOn` 中已完成槽位的正文。

不得自动注入：

- 所有前序槽位；
- 所有同级槽位；
- 所有已完成槽位；
- 全文草稿。

若某项内容确实是当前 Slot 的必要输入，应通过 `dependsOn` 明确声明。

---

### FR-CTX-005 无隐式会话历史

每个 Assignment 使用独立、可重建的 Provider Context。

系统不得依赖：

- Provider 持久对话；
- 上一次 Agent Turn 的隐藏记忆；
- 模型侧线程历史。

上下文应能够根据数据库状态和冻结快照重新构建。

---

### FR-CTX-006 上下文 Hash

系统应为每次 Assignment 计算 `contextHash`，用于：

- 调试；
- 重现；
- 判断上下文是否发生非预期变化。

相同任务状态、相同 Slot、相同 Skill 和相同模板快照应产生相同的 Context 内容和 Hash。

---

## 16. Agent 执行需求

### FR-AGT-001 Provider 调用

系统根据 Agent Definition 调用对应 Provider 和模型。

API Key 必须由环境或安全配置注入，不得写入：

- Template；
- Task Snapshot；
- Slot；
- Execution Log；
- Artifact；
- 前端响应。

---

### FR-AGT-002 每次执行绑定 Execution Token

每次 Assignment 必须生成唯一的 Execution Token。

Agent 提交结果时必须同时提供：

- Assignment ID；
- Execution Token。

系统只接受当前仍然有效的 Token。

---

### FR-AGT-003 超时

每次 Provider 调用必须有明确超时。

超时后：

1. 当前 Execution 标记为 Failed；
2. 当前 Token 失效；
3. Provider Abort 被触发；
4. 系统根据重试策略重试或使 Task 失败。

不得无限停留在 Running。

---

### FR-AGT-004 有限重试

模板可以声明最大执行重试次数。

每次重试必须创建新的：

- Execution ID；
- Execution Token；
- Attempt Number。

旧 Token 不得复用。

---

### FR-AGT-005 不保存隐藏思维过程

系统不得持久化或向用户展示 Provider 的隐藏推理过程。

可以保存：

- Agent 公开输出；
- 工具调用名称；
- Assignment 结果；
- 稳定错误码；
- 开始和结束时间；
- Token 使用统计；
- Provider 请求状态。

---

## 17. 填充结构槽需求

### FR-SLOT-001 创建填充 Assignment

系统选择 Ready Slot 后，根据其 Slot Type 查询模板 Binding：

```text
Slot Type
→ Agent
→ Skill
```

然后创建 Fill Slot Assignment。

---

### FR-SLOT-002 Slot Agent 职责

内容 Agent 负责：

- 理解当前 Slot Instruction；
- 按照 Skill 的工作方法生成内容；
- 使用明确依赖内容维持必要连续性；
- 输出当前 Slot 的正文。

内容 Agent 不负责：

- 改写其他 Slot；
- 创建新 Slot；
- 删除 Slot；
- 修改依赖；
- 组装全文；
- 选择下一个 Slot；
- 设置状态。

---

### FR-SLOT-003 输出范围

Fill Slot Assignment 只能提交当前 Target Slot 的内容。

若提交的 `slotId` 与 Assignment Target 不一致，系统必须拒绝。

---

### FR-SLOT-004 基础内容校验

系统必须校验：

- 内容类型为字符串；
- 去除首尾空白后不为空；
- 内容长度不低于 Slot Type 最小值；
- 内容长度不超过 Slot Type 最大值；
- Assignment ID 和 Token 有效；
- Target Slot 仍处于 Running；
- Agent 和 Skill 与当前 Assignment 一致；
- Slot 的依赖仍然满足。

P0 不进行语义质量审核。

---

### FR-SLOT-005 原子保存

内容校验通过后，系统在一个事务中：

1. 保存 Slot Content；
2. 保存 Producer Agent；
3. 保存 Producer Skill 和版本；
4. 保存 Producer Execution；
5. 将 Slot 状态设置为 `completed`；
6. 将 Execution 状态设置为 `succeeded`；
7. 清除 Task Active Execution；
8. 更新 Task 时间；
9. 触发下一次调度。

不得出现：

- 内容已保存但 Slot 仍 Running；
- Slot 已 Completed 但没有 Content；
- Execution 成功但 Producer 信息缺失；
- 已推进下一个 Slot，但当前结果未提交。

---

## 18. 最终组装需求

### FR-ASM-001 进入 Assembly

当所有 `contentBearing: true` 的 Slot 均为 `completed` 时：

```text
Task.phase = assembly
```

---

### FR-ASM-002 确定性组装

P0 使用内建：

```text
markdown_concat_v1
```

其规则为：

1. 按文档树深度优先顺序遍历；
2. 忽略 `contentBearing: false` 的容器 Slot；
3. 读取内容 Slot 的 Content；
4. 使用两个换行符连接；
5. 保留各 Slot Content 内部格式；
6. 输出 UTF-8 Markdown 文件。

相同的结构和 Slot Content 必须生成完全相同的文件字节。

---

### FR-ASM-003 不在组装阶段生成语义内容

Assembler 不得：

- 重写正文；
- 创建过渡句；
- 总结内容；
- 统一风格；
- 调用模型；
- 自动补齐空槽位。

需要语义加工时，应在结构中创建相应 Slot，并由 Agent 完成。

---

### FR-ASM-004 保存 Artifact

组装成功后，系统必须：

1. 写入临时文件；
2. 计算 Checksum；
3. 原子移动到最终文件路径；
4. 保存 Artifact Record；
5. 将 Task Phase 设置为 `done`；
6. 将 Task Status 设置为 `completed`。

---

### FR-ASM-005 组装失败

若文件系统写入或组装失败：

```text
Task.status = failed
Task.errorCode = ASSEMBLY_FAILED
```

已完成的 Slot Content 保留。用户重试时不重新生成已完成槽位，只重新执行 Assembly。

---

## 19. 生命周期需求

### 19.1 Task 状态机

```text
ready
  │ start
  ▼
running
  ├─────────────── stop ───────────────► stopped
  │                                         │
  │                                         │ resume
  │                                         ▼
  │                                      running
  │
  ├──────────── unrecoverable ───────────► failed
  │                                         │
  │                                         │ retry
  │                                         ▼
  │                                      running
  │
  └──────── structure + slots + assembly ─► completed
```

---

### 19.2 Slot 状态机

```text
pending
  │ scheduled
  ▼
running
  ├──────── valid commit ───────► completed
  │
  ├──────── max retries ────────► failed
  │
  └──────── stop/restart ───────► pending
```

---

### FR-LIFE-001 停止

停止任务时，系统必须先：

1. 使当前 Execution Token 失效；
2. 将当前 Execution 标记为 Cancelled；
3. 将 Running Slot 恢复为 Pending；
4. 再触发 Provider Abort；
5. 将 Task 设置为 Stopped。

顺序必须保证迟到结果无法提交。

---

### FR-LIFE-002 迟到结果

已取消、已超时、已替换或已停止的 Execution 返回结果时：

- 不写入 Slot；
- 不更新 Task；
- Execution 标记为 Stale；
- 记录稳定诊断日志。

---

### FR-LIFE-003 服务重启恢复

服务启动时若发现：

```text
Task.status = running
且
存在未结束 Execution
```

系统必须：

1. 使旧 Execution Token 失效；
2. 将旧 Execution 标记为 Cancelled；
3. 将 Running Slot 恢复为 Pending；
4. 将 Task 设置为 Stopped；
5. 等待用户 Resume。

P0 不在进程重启后自动继续调用模型。

---

### FR-LIFE-004 Retry

任务失败后，用户可以 Retry。

根据失败阶段：

- Structure 失败：重新创建 Structure Assignment；
- Slot 失败：将目标 Slot 从 Failed 重置为 Pending；
- Assembly 失败：直接重新执行 Assembly。

已完成 Slot 不重新生成。

---

## 20. 前端需求

P0 前端包含以下页面。

### 20.1 模板列表

显示：

- 模板名称；
- 模板描述；
- 版本；
- Agent 数量；
- Slot Type 数量；
- 模板状态。

---

### 20.2 模板详情

显示：

- 输入字段；
- Structure Agent 和 Skill；
- 各 Slot Type 对应的 Agent 和 Skill；
- Slot Type 说明；
- 资源限制；
- 输出文件格式。

---

### 20.3 新建任务

根据模板输入字段渲染表单。

用户只能填写业务输入，不在任务创建页修改：

- Agent；
- Model；
- Skill；
- Binding；
- Slot Type；
- Assembler。

---

### 20.4 任务列表

显示：

- 任务名称；
- 模板；
- 状态；
- Phase；
- 当前 Agent；
- 当前 Skill；
- 当前目标 Slot；
- 已完成槽位数量；
- 总内容槽位数量；
- 更新时间。

---

### 20.5 任务详情

必须显示：

- Task 状态和 Phase；
- 当前 Execution；
- 当前 Agent；
- 当前 Skill；
- 当前 Operation；
- 结构树；
- 每个 Slot 的状态；
- Slot Instruction；
- Slot DependsOn；
- 已完成 Slot Content；
- Slot Producer Agent；
- Slot Producer Skill；
- 错误信息；
- 开始、停止、继续、重试操作；
- 最终 Artifact。

P0 不显示隐藏推理过程。

---

### 20.6 Artifact 查看

任务完成后，用户可以：

- 查看 Markdown；
- 下载原始文件；
- 查看 Checksum；
- 查看生成时间。

---

## 21. 最小 API

### Template

```text
GET  /api/templates
GET  /api/templates/:templateId
POST /api/templates/:templateId/reload
```

### Task

```text
POST /api/tasks
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/start
POST /api/tasks/:taskId/stop
POST /api/tasks/:taskId/resume
POST /api/tasks/:taskId/retry
```

### Slot

```text
GET /api/tasks/:taskId/slots
GET /api/tasks/:taskId/slots/:slotId
```

### Execution

```text
GET /api/tasks/:taskId/executions
```

### Artifact

```text
GET /api/tasks/:taskId/artifact
GET /api/tasks/:taskId/artifact/download
```

Agent 工具调用走内部 Runtime 接口，不暴露为普通用户 API。

---

## 22. 存储需求

### 22.1 权威状态

P0 建议使用事务型本地数据库作为权威状态源。

建议使用 SQLite，至少包含：

```text
task_snapshots
tasks
slots
executions
artifacts
```

---

### 22.2 不采用完整事件溯源

P0 不要求通过 Event Replay 重建 Task 和 Slot 状态。

原则为：

```text
状态表是权威数据
Execution Record 是运行记录
Artifact 是派生结果
```

可以增加审计日志，但审计日志不作为任务状态的唯一来源。

---

### 22.3 原子性

以下操作必须使用数据库事务：

- 提交完整结构；
- 提交 Slot Content；
- 停止任务；
- 重置失败 Slot；
- 完成 Task；
- 保存 Artifact 元数据。

---

### 22.4 文件写入

最终 Artifact 使用：

```text
写临时文件
→ fsync 或等价持久化
→ 原子 rename
→ 保存数据库记录
```

避免数据库显示完成但文件不存在。

---

## 23. 非功能需求

### NFR-001 单进程串行执行

P0 为本地单进程系统。

同一时间全局最多运行一个 Agent Assignment。

系统可以保存多个 Task，但不并行调用多个 Agent。

---

### NFR-002 可恢复

每个 Slot 完成后立即持久化。

系统重启后不得要求从第一个 Slot 重新生成。

---

### NFR-003 有界失败

Provider 调用必须具备：

- Timeout；
- 最大重试次数；
- Abort；
- 稳定错误码。

不得出现无限 Running。

---

### NFR-004 上下文可重建

每次 Agent Context 必须可以仅使用以下数据重新构建：

- Task Snapshot；
- Task Input；
- Structure；
- Slot；
- DependsOn Slot Content；
- Skill Snapshot；
- Agent Definition。

---

### NFR-005 不泄露敏感信息

不得在日志、数据库和前端中存储：

- API Key；
- Authorization Header；
- Provider Secret；
- 隐藏推理内容。

---

### NFR-006 确定性

以下行为必须确定：

- Ready Slot 选择；
- Agent 和 Skill Binding；
- Context 构建顺序；
- Structure Validation；
- Slot Validation；
- Artifact Assembly；
- Task Completion。

---

### NFR-007 可测试

系统必须提供 Fake Agent Runtime，使测试可以：

- 固定返回 Structure Proposal；
- 固定返回 Slot Content；
- 模拟超时；
- 模拟无效结构；
- 模拟 Provider Error；
- 模拟停止后的迟到结果；
- 模拟服务重启。

---

## 24. P0 模板示例

```yaml
id: zhihu-chapter-v1
version: 0.1.0
name: 知乎盐选单章结构槽生产

inputFields:
  - id: chapter_packet
    label: 章节执行包
    type: textarea
    required: true

slotTypes:
  - id: chapter
    name: 章节容器
    description: 承载完整章节结构
    contentBearing: false

  - id: title
    name: 标题
    description: 章节标题
    contentBearing: true
    minContentChars: 1
    maxContentChars: 120

  - id: opening
    name: 开场
    description: 从正在发生的动作切入
    contentBearing: true
    minContentChars: 100
    maxContentChars: 3000

  - id: scene
    name: 场景段
    description: 通过行动、冲突或信息变化推进正文
    contentBearing: true
    minContentChars: 300
    maxContentChars: 8000

  - id: emotional_closure
    name: 情绪落点
    description: 形成当前章节的情绪回声
    contentBearing: true
    minContentChars: 100
    maxContentChars: 2000

  - id: chapter_end
    name: 章节结尾
    description: 留下具体且可追踪的未完成问题
    contentBearing: true
    minContentChars: 100
    maxContentChars: 2000

agents:
  - id: structure_designer
    name: 章节结构设计 Agent
    role: 根据章节执行包设计具体章节结构
    provider: configured
    model: main

  - id: chapter_writer
    name: 章节写作 Agent
    role: 根据结构槽目标生产章节正文
    provider: configured
    model: main

skills:
  - id: chapter-structure-design
    version: 1.0.0
    source: skills/chapter-structure-design/SKILL.md

  - id: title-writing
    version: 1.0.0
    source: skills/title-writing/SKILL.md

  - id: opening-writing
    version: 1.0.0
    source: skills/opening-writing/SKILL.md

  - id: scene-writing
    version: 1.0.0
    source: skills/scene-writing/SKILL.md

  - id: emotional-closure-writing
    version: 1.0.0
    source: skills/emotional-closure-writing/SKILL.md

  - id: chapter-ending-writing
    version: 1.0.0
    source: skills/chapter-ending-writing/SKILL.md

bindings:
  createStructure:
    agentId: structure_designer
    skillId: chapter-structure-design

  fillSlotByType:
    title:
      agentId: chapter_writer
      skillId: title-writing

    opening:
      agentId: chapter_writer
      skillId: opening-writing

    scene:
      agentId: chapter_writer
      skillId: scene-writing

    emotional_closure:
      agentId: chapter_writer
      skillId: emotional-closure-writing

    chapter_end:
      agentId: chapter_writer
      skillId: chapter-ending-writing

limits:
  maxSlots: 32
  maxStructureDepth: 4
  maxExecutionRetries: 2
  executionTimeoutMs: 120000

output:
  fileName: chapter.md
  mediaType: text/markdown
  assembler: markdown_concat_v1
```

---

## 25. 标准生产流程

### 25.1 正常流程

```text
用户创建任务
  ↓
Task ready / phase structure
  ↓
用户启动
  ↓
Structure Assignment
  ↓
Structure Agent + Structure Skill
  ↓
提交 Structure Proposal
  ↓
系统校验并保存 Slots
  ↓
Task phase slots
  ↓
系统选择 Ready Slot
  ↓
系统解析 Agent + Skill
  ↓
构建确定性上下文
  ↓
Agent 填充 Slot
  ↓
系统原子保存
  ↓
继续选择下一 Ready Slot
  ↓
全部内容 Slot completed
  ↓
Task phase assembly
  ↓
系统确定性组装
  ↓
Task completed
```

---

### 25.2 结构无效流程

```text
Structure Agent 提交
  ↓
系统校验失败
  ↓
拒绝整份结构
  ↓
生成结构化错误
  ↓
在最大次数内重新创建 Assignment
  ↓
仍失败
  ↓
Task failed
```

---

### 25.3 Provider 失败流程

```text
Provider Error / Timeout
  ↓
当前 Execution 失效
  ↓
在最大次数内重试
  ↓
仍失败
  ↓
Structure 或 Slot 标记 failed
  ↓
Task failed
```

---

### 25.4 停止流程

```text
用户点击停止
  ↓
系统先使 Execution Token 失效
  ↓
Running Slot 恢复 pending
  ↓
触发 Provider Abort
  ↓
Task stopped
  ↓
迟到结果返回
  ↓
标记 stale，不提交
```

---

## 26. P0 验收标准

### AC-001 模板绑定

给定一个有效模板，系统能够准确解析：

```text
create_structure → Structure Agent + Structure Skill
fill_slot(scene) → Writer Agent + Scene Skill
```

Agent 无法替换绑定。

---

### AC-002 模板快照

任务创建后修改模板或 Skill 源文件：

- 已创建任务继续使用旧快照；
- 新任务使用新版本；
- 两者 Context Hash 不混淆。

---

### AC-003 Agent 创建结构

Structure Agent 能够根据输入创建合法结构，系统将其保存为 Slot。

---

### AC-004 无效结构不产生部分数据

Structure Proposal 中存在循环依赖时：

- 系统拒绝整份结构；
- 数据库中不存在部分 Slot；
- Task 不进入 Slots Phase。

---

### AC-005 Ready Slot 正确推进

只有所有 DependsOn 均完成的 Slot 才能被调度。

---

### AC-006 Agent 与 Skill 明确

每次任务详情中都能看到：

- 当前 Agent；
- 当前 Skill；
- 当前 Operation；
- 当前 Target Slot。

---

### AC-007 上下文隔离

生成 `scene_03` 时，若其只依赖 `scene_02`：

- Context 包含 `scene_02` 内容；
- 不包含 `scene_01`、`opening` 等未声明正文；
- 包含完整 Structure Outline；
- 不包含历史聊天记录。

---

### AC-008 单槽提交

Agent 在 `scene_03` Assignment 中尝试提交 `scene_04` 内容时，系统拒绝。

---

### AC-009 原子保存

Slot 完成后必须同时满足：

- Content 存在；
- Status 为 Completed；
- Producer Agent 存在；
- Producer Skill 存在；
- Producer Execution 存在。

不得出现部分状态。

---

### AC-010 Provider 超时收敛

Provider 长时间无响应时：

- 在 Timeout 后结束；
- 不永久 Running；
- 按上限重试；
- 超过上限进入 Failed。

---

### AC-011 停止拒绝迟到结果

用户停止任务后，旧 Provider 返回内容：

- 内容不进入 Slot；
- Slot 保持 Pending；
- Execution 标记 Stale 或 Cancelled。

---

### AC-012 重启恢复

服务在 Slot Running 时被终止，重新启动后：

- 旧 Execution 失效；
- Slot 恢复 Pending；
- Task 进入 Stopped；
- 用户 Resume 后从该 Slot 继续；
- 已完成 Slot 不重新生成。

---

### AC-013 确定性组装

相同结构和相同 Slot Content 多次组装：

- 输出文件字节一致；
- Checksum 一致。

---

### AC-014 完成由系统决定

即使 Agent 输出“任务已完成”，只要仍有未完成内容 Slot：

- Task 不得进入 Completed；
- Artifact 不得生成。

---

### AC-015 完整真实链路

使用真实 Provider 完成至少一条：

```text
章节输入
→ Structure Agent
→ Title
→ Opening
→ Scene × N
→ Emotional Closure
→ Chapter End
→ chapter.md
```

任务无需手工修改数据库或文件即可完成。

---

## 27. P0 成功指标

第一阶段进入可用状态前，应满足：

1. 连续完成至少 10 个真实结构槽任务；
2. 无任务永久停留在 Running；
3. 无停止后的迟到结果被提交；
4. 无部分结构提交；
5. 无 Completed Slot 缺失 Content；
6. 服务重启后无需重新生成已完成 Slot；
7. 相同状态生成的 Context 可重复构建；
8. 相同 Slot 内容组装出的 Artifact Checksum 一致；
9. 不依赖审核、Finding、Seal 或 Capability 模块；
10. 核心生产链只使用一套 Runtime。

---

## 28. 后续阶段

### P1：可控返修

在 P0 稳定后增加：

- 手动重生成单个 Slot；
- Slot Revision；
- 保留旧内容；
- 用户填写返修指令；
- 基于上一版本进行局部修订；
- 重新组装 Artifact。

---

### P2：语义审核

真实业务证明有必要后增加：

- Slot Review；
- Artifact Review；
- 审核结果绑定具体 Slot Revision；
- 审核返回受影响 Slot；
- 局部返修。

不默认恢复现有 Finding、Repair Grant 和权威审核体系。

---

### P3：结构调整

在结构冻结模式稳定后增加：

- 新增 Slot；
- 删除未生产 Slot；
- 调整顺序；
- 修改依赖；
- 结构版本；
- 内容失效传播。

结构拆分、合并和正式 Migration 应作为独立专题设计。

---

### P4：并发与多执行器

只有串行性能无法满足业务时增加：

- 多 Ready Slot 并行；
- 多 Worker；
- Lease；
- 并发提交控制；
- 资源调度。

不得提前在 P0 构建跨进程调度系统。

---

## 29. 第一阶段推荐代码边界

```text
src/
├── domain/
│   ├── template.ts
│   ├── task.ts
│   ├── slot.ts
│   ├── structure-validation.ts
│   ├── readiness.ts
│   └── assembly.ts
│
├── application/
│   ├── task-service.ts
│   ├── production-loop.ts
│   ├── assignment-service.ts
│   ├── context-builder.ts
│   └── lifecycle-service.ts
│
├── runtime/
│   ├── agent-runtime.ts
│   ├── provider-adapter.ts
│   ├── assignment-runner.ts
│   └── completion-tool.ts
│
├── infrastructure/
│   ├── database.ts
│   ├── repositories/
│   └── artifact-store.ts
│
├── templates/
├── skills/
├── api/
└── client/
```

依赖方向：

```text
domain
  ↑
application
  ↑
runtime / infrastructure
  ↑
api
  ↑
client
```

Domain 不得依赖：

- Provider；
- HTTP；
- React；
- SQLite；
- 文件系统；
- Agent SDK。

---

## 30. 最终产品边界

Forge Core vNext P0 不解决“如何证明内容绝对正确”，而只解决一个更基础的问题：

> **如何让一个有明确身份的 Agent，使用明确的 Skill，在明确且确定的上下文中，对一个明确的结构槽执行内容工作，并由系统可靠地保存、推进和组装这些结果。**

第一阶段的最小闭环为：

```text
Agent 创建结构
→ 系统校验结构
→ Agent 使用 Skill 填充槽位
→ 系统保存并推进
→ 系统组装产物
```

所有后续审核、返修、关系、迁移、并发和权威证明，都必须建立在这一基础闭环已经稳定的前提之上。