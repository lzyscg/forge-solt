# Forge Core vNext 技术实现方案

**文档版本：** V0.1  
**文档状态：** 初版技术设计  
**对应需求：**《Forge Core vNext：结构槽原生 Agent 内容生产平台需求规格说明书》  
**适用阶段：** P0 最小可运行闭环  
**设计原则：** 第一性原则、奥卡姆剃刀、模块化单体、单协议、单权威状态源

---

## 1. 文档目的

本文档定义 Forge Core vNext P0 阶段的技术实现方案，包括：

- 采用什么技术栈；
- 系统采用什么架构；
- 核心模块如何划分；
- 每个模块负责什么、不负责什么；
- Template、Agent、Skill、Task、Slot、Execution、Trace 和 Artifact 如何落地；
- 结构创建与槽位填充如何执行；
- Agent 如何查看 Skill、读取上下文、调用工具和提交结果；
- Agent 工作轨迹如何采集和展示；
- 数据如何持久化；
- 停止、超时、重试、迟到结果和重启恢复如何实现；
- 前后端如何通信；
- P0 应按什么顺序实施。

本文档只覆盖结构槽生产的基础闭环，不设计审核、Finding、Repair、Seal、Migration、Capability、Evidence 或多进程并发。

---

## 2. 技术方案总览

Forge Core vNext P0 采用以下总体方案：

> **一个 TypeScript 模块化单体应用，在单个 Node.js 进程中运行；使用 SQLite 保存权威状态；使用一个串行 Production Engine 推进任务；使用轻量 Agent Runtime 调用模型和工具；使用 REST 执行命令与查询，使用 SSE 将 Agent 工作轨迹实时推送到 React 工作台。**

整体结构如下：

```text
┌─────────────────────────────────────────────────────────────┐
│                        Browser UI                           │
│ React Task Workspace / Template Pages / Provider Settings   │
└───────────────────────┬─────────────────────────────────────┘
                        │ REST + SSE
┌───────────────────────▼─────────────────────────────────────┐
│                       API Layer                             │
│ Route Schema / Public DTO / Error Mapping / SSE Stream      │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│                  Application Layer                         │
│ TaskService / ProductionEngine / AssignmentService         │
│ ContextBuilder / CompletionService / LifecycleService       │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
┌───────────────▼──────────────┐   ┌──────────▼──────────────┐
│         Domain Layer         │   │      Agent Runtime       │
│ Template / Task / Slot       │   │ Provider Adapter         │
│ Structure Validation         │   │ Skill Runtime            │
│ Readiness / State Machine    │   │ Tool Runtime             │
│ Assembly                     │   │ Public Work Trace         │
└───────────────┬──────────────┘   └──────────┬──────────────┘
                │                             │
┌───────────────▼─────────────────────────────▼───────────────┐
│                  Infrastructure Layer                      │
│ SQLite Repositories / Migrations / Trace Store             │
│ Template Files / Skill Files / Provider Credentials         │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 核心架构决策

### 3.1 采用模块化单体，不采用微服务

P0 采用一个仓库、一个服务进程、一个数据库。

原因：

- 当前产品是本地或单机内容生产工具；
- 一次只运行一个 Agent Assignment；
- 不需要独立扩缩容不同服务；
- 不需要分布式事务；
- 不需要消息队列；
- 不需要跨服务追踪；
- 模块化边界已经足以隔离复杂度。

模块化单体不是“所有代码写在一个文件中”，而是：

```text
一个部署单元
+ 明确的模块边界
+ 单向依赖
+ 独立测试
```

---

### 3.2 全栈使用 TypeScript

前端、后端、共享 DTO、工具 Contract 和模板编译结果统一使用 TypeScript。

主要收益：

- Template、Assignment、Tool 和 API Contract 可以共享；
- 减少跨语言 DTO 漂移；
- 复用现有 Forge Core 团队经验；
- 方便对 Agent 工具参数进行严格类型校验；
- 便于构建 Fake Runtime 和测试 Fixture。

---

### 3.3 后端使用 Node.js + Fastify

推荐后端组合：

```text
Node.js 当前 LTS
+ TypeScript
+ Fastify
+ JSON Schema / TypeBox
```

Fastify 只承担：

- HTTP 路由；
- 请求参数校验；
- 响应序列化；
- 错误映射；
- SSE 连接。

Fastify 不承载领域逻辑。所有业务操作必须调用 Application Service。

---

### 3.4 前端使用 React + Vite

推荐前端组合：

```text
React
+ TypeScript
+ Vite
```

前端不引入复杂全局状态机。

服务器数据库是权威状态源，前端只保留：

- 页面查询缓存；
- 当前选中的 Slot；
- 当前展开的 Trace Event；
- 抽屉和筛选状态；
- SSE 连接状态。

---

### 3.5 使用 SQLite 作为唯一权威状态源

P0 使用：

```text
SQLite
+ better-sqlite3
+ 手写 SQL Migration
+ Repository Adapter
```

不使用 ORM。

原因：

- 数据模型规模较小且关系明确；
- 原子事务是核心要求；
- 单进程串行写入与 SQLite 非常匹配；
- 手写 SQL 更容易看清真实状态转换；
- 避免 ORM 隐式行为；
- Repository Adapter 可以在未来替换 Driver，而不影响 Domain 和 Application。

数据库访问必须统一经过 Repository，不允许业务模块自行执行 SQL。

---

### 3.6 不使用完整事件溯源

P0 的权威状态是：

```text
tasks
slots
executions
artifacts
```

`trace_events` 只负责：

- UI 实时工作轨迹；
- Agent 与 Skill 复盘；
- 工具调用记录；
- 技术排查。

系统不能依赖重新播放 Trace Event 来恢复 Task 或 Slot 状态。

原则为：

```text
状态表负责“现在是什么”
Trace 负责“刚才发生了什么”
```

---

### 3.7 最终 Artifact 直接保存在 SQLite

P0 的最终产物主要是 Markdown、文本或小型 JSON。

建议将 Artifact 内容直接作为 BLOB 或 TEXT 保存在 SQLite：

```text
artifacts.content_blob
```

这样可以在一个数据库事务中同时完成：

```text
写入 Artifact
+ 保存 Checksum
+ Task 进入 completed
```

避免出现：

```text
数据库显示 completed
但文件尚未写入或已经丢失
```

后续若需要处理视频、大型图片或超大文档，再把 Artifact Store 替换为内容寻址文件存储。

---

### 3.8 实时更新使用 SSE，不使用 WebSocket

浏览器主要需要接收：

- Task 状态变化；
- Slot 状态变化；
- Agent 公开输出；
- Skill 读取；
- 工具调用；
- Trace Event；
- Artifact 完成通知。

这些数据主要由服务端单向发送到浏览器，因此 P0 使用 Server-Sent Events。

用户操作仍通过普通 REST 请求完成。

```text
浏览器 → 服务端：REST
服务端 → 浏览器：SSE
```

---

### 3.9 不复用复杂 Coding Agent Framework 作为核心

P0 不将现有 Pi Coding Agent 或其他通用 Coding Agent Framework 作为 Production Runtime 的核心依赖。

原因是结构槽 Agent 的工作面非常窄：

- 读取 Skill；
- 读取授权上下文；
- 发布公开工作说明；
- 提交结构或槽位内容。

推荐实现一个轻量 Agent Runtime：

```text
Provider Adapter
+ Tool Loop
+ Timeout / Abort
+ Trace Recorder
+ Completion Boundary
```

后续可以把 Pi、OpenAI SDK、Claude SDK 或其他框架接成 Provider Adapter，但它们不得控制 Task、Slot 或 Execution 状态。

---

## 4. P0 技术不变量

以下规则必须写入代码和测试，而不是只写在文档中。

### 4.1 内容生产不变量

1. 所有语义内容由 Agent 生产；
2. 系统只执行确定性操作；
3. 每次 Agent 工作必须绑定一个 Agent；
4. 每次 Agent 工作必须绑定一个 Skill；
5. 每次 Agent 工作必须绑定一个 Operation；
6. 每次 Agent 工作必须绑定明确 Target；
7. Agent 只能通过 `complete_assignment` 正式提交结果。

---

### 4.2 状态不变量

1. Task 完成只能由系统推导；
2. Slot 完成必须同时存在 Content 和 Producer；
3. Running Slot 必须对应一个有效 Execution；
4. 一个 Task 同时最多有一个活动 Execution；
5. 全局同时最多运行一个 Provider Assignment；
6. 旧 Execution Token 永远不能再次生效；
7. Trace 写入失败不得改变生产状态；
8. Artifact 与 Task Completed 必须在同一个事务中提交。

---

### 4.3 上下文不变量

1. Agent 不继承随机聊天历史；
2. Assignment Context 可以从数据库和 Snapshot 重建；
3. Fill Slot 只能读取授权依赖槽位；
4. Agent 不可读取其他 Task；
5. Agent 不可读取任意本地文件；
6. Agent 不可访问模板源文件，只能访问任务 Snapshot；
7. 相同 Context 产生相同 Context Hash。

---

## 5. 代码分层

### 5.1 Domain Layer

Domain 只包含纯业务规则。

允许依赖：

- TypeScript 标准库；
- 纯类型；
- 纯函数。

禁止依赖：

- Fastify；
- SQLite；
- React；
- Provider SDK；
- 文件系统；
- 环境变量；
- HTTP。

Domain 负责：

- Template 编译后的领域结构；
- Task 和 Slot 状态机；
- Structure Validation；
- Ready Slot 推导；
- Next Slot 确定性选择；
- Assignment 结果校验规则；
- Artifact Assembly 纯函数；
- 稳定错误码。

---

### 5.2 Application Layer

Application 负责协调一个完整用例。

主要服务：

- `TemplateService`
- `TaskService`
- `ProductionEngine`
- `AssignmentService`
- `ContextBuilder`
- `CompletionService`
- `LifecycleService`
- `TraceService`
- `AssemblyService`

Application 可以依赖 Domain 和接口抽象，但不能直接依赖具体 SQLite Driver 或具体 Provider SDK。

---

### 5.3 Runtime Layer

Runtime 负责真正运行 Agent。

主要模块：

- `AgentRuntime`
- `ProviderAdapter`
- `SkillRuntime`
- `ToolRuntime`
- `TraceEmitter`
- `AssignmentRunner`

Runtime 通过 Application 暴露的接口读取授权数据和提交结果。

Runtime 不直接更新 Task 或 Slot 数据库行。

---

### 5.4 Infrastructure Layer

Infrastructure 实现：

- SQLite Repository；
- SQL Migration；
- Template 文件加载；
- Skill 文件加载；
- Provider HTTP Adapter；
- API Key 读取；
- 时钟；
- ID 生成；
- Hash；
- SSE Hub。

Infrastructure 只提供技术能力，不包含生产规则。

---

### 5.5 API Layer

API 负责：

- HTTP Contract；
- JSON Schema；
- DTO 转换；
- 权限入口；
- 错误状态码映射；
- SSE Stream；
- Artifact 下载响应。

API 不允许包含：

- Ready Slot 计算；
- 状态转换；
- Assignment 创建；
- Agent Tool 授权；
- Structure Validation。

---

### 5.6 Client Layer

Client 负责展示：

- Template；
- Task；
- Structure；
- Slot；
- Assignment；
- Agent Work Trace；
- Artifact。

Client 不自行推导权威任务状态，也不在浏览器中运行 Agent。

---

## 6. 核心模块设计

## 6.1 Template Catalog

### 职责

- 扫描 `templates/`；
- 解析 `template.yaml`；
- 解析 Agent Definition；
- 解析 Skill 引用；
- 校验 Binding；
- 编译为 `CompiledTemplate`；
- 计算版本 Hash；
- 提供模板列表与详情；
- 支持开发期 Reload。

### 输入

```text
templates/<templateId>/template.yaml
skills/<skillId>/SKILL.md
```

### 输出

```ts
interface CompiledTemplate {
  id: string;
  version: string;
  inputFields: InputFieldDefinition[];
  slotTypes: Record<string, SlotTypeDefinition>;
  agents: Record<string, AgentDefinition>;
  skills: Record<string, CompiledSkillMetadata>;
  bindings: CompiledBindings;
  limits: TemplateLimits;
  output: OutputDefinition;
  canonicalJson: string;
  templateHash: string;
}
```

### 不负责

- 创建 Task；
- 创建 Slot；
- 调用模型；
- 保存 Agent 输出；
- 推进任务状态。

---

## 6.2 Snapshot Service

### 职责

创建 Task 时冻结：

- Compiled Template；
- Agent Definition；
- Binding；
- Slot Type；
- Limits；
- Output；
- Skill 完整内容；
- Skill Section Index；
- 用户输入。

生成：

```text
snapshotHash
skillContentHash
```

Snapshot 一旦创建，不得修改。

### 关键实现

使用 Canonical JSON：

- Key 固定排序；
- 数组顺序保持；
- 去除非语义字段；
- SHA-256 计算 Hash。

### 不负责

- Reload 旧 Task；
- 更新 Skill；
- 迁移 Snapshot；
- 合并模板版本。

---

## 6.3 Task Service

### 职责

- 创建 Task；
- 读取 Task；
- 列出 Task；
- 返回 Task Workspace；
- 连接 Task 与 Snapshot；
- 校验当前生命周期操作是否合法。

### 主要命令

```text
createTask
startTask
stopTask
resumeTask
retryTask
```

### 不负责

- 直接运行模型；
- 直接选择 Slot；
- 直接提交 Agent 结果。

---

## 6.4 Structure Service

### 职责

- 创建 Structure Assignment；
- 验证 Structure Proposal；
- 将 Proposal 转换为 Slot；
- 原子写入全部 Slot；
- 将 Task Phase 从 `structure` 推进为 `slots`。

### 核心纯函数

```ts
validateConcreteStructure(
  proposal: StructureProposal,
  template: CompiledTemplate
): StructureValidationResult
```

### 校验范围

- ID 唯一；
- 单根；
- Parent 存在；
- Parent 无环；
- Slot Type 合法；
- 深度合法；
- 同级 Order 唯一；
- DependsOn 存在；
- DependsOn 无自引用；
- DependsOn 无环；
- 内容槽至少一个；
- 数量上限。

### 提交事务

```text
INSERT slots...
UPDATE execution = succeeded
UPDATE task.phase = slots
UPDATE task.active_execution_id = null
```

任何一步失败都回滚。

---

## 6.5 Slot Scheduler

### 职责

根据当前 Slot 状态计算：

- 哪些 Slot 是 Ready；
- 下一个执行哪个 Slot；
- 是否可以进入 Assembly；
- 是否出现 Dependency Deadlock。

### 核心函数

```ts
deriveReadySlots(slots: Slot[]): Slot[];

selectNextReadySlot(slots: Slot[]): Slot | null;

allContentSlotsCompleted(slots: Slot[]): boolean;
```

### 稳定排序

```text
文档树深度优先顺序
→ 同级 order
→ slotId 字典序
```

### 不负责

- 保存 Ready 状态；
- 创建独立 WorkItem；
- Agent 自主领取；
- 并发调度。

---

## 6.6 Assignment Service

### 职责

将当前生产需求转换为一次明确 Assignment。

Assignment 包含：

```text
operation
agent
skill
target
context manifest
output contract
execution limits
```

### 两类 Assignment

```text
create_structure
fill_slot
```

### 关键规则

- Agent 和 Skill 从冻结 Binding 解析；
- 不允许运行时自由选择；
- 一个 Task 同时只能存在一个活动 Assignment；
- Assignment 创建时同步创建 Execution Record；
- Raw Execution Token 只返回给 Runtime，数据库只保存 Hash。

---

## 6.7 Context Builder

### 职责

构建确定性的 Assignment Context。

### Structure Context

```text
Platform Rules
+ Agent Role
+ Skill Overview
+ Required Skill Sections
+ Task Input
+ Allowed Slot Types
+ Limits
+ Structure Output Contract
```

### Fill Slot Context

```text
Platform Rules
+ Agent Role
+ Skill Overview
+ Required Skill Sections
+ Task Input
+ Structure Outline
+ Target Slot
+ Slot Instruction
+ Dependency Slot Contents
+ Content Limits
+ Slot Output Contract
```

### 输出

```ts
interface BuiltAssignmentContext {
  systemText: string;
  userText: string;
  manifest: ContextManifest;
  canonicalJson: string;
  contextHash: string;
}
```

### Context Manifest

用于 UI 展示和复现：

```ts
interface ContextManifest {
  taskInputFields: string[];
  skillSections: string[];
  targetSlotId: string | null;
  dependencySlotIds: string[];
  structureHash: string | null;
  snapshotHash: string;
}
```

### 不负责

- 调用 Provider；
- 推进任务状态；
- 读取未授权 Slot；
- 自动语义检索。

---

## 6.8 Skill Runtime

### 职责

- 从 Task Snapshot 读取 Skill；
- 提供 Skill Overview；
- 提供稳定 Section Index；
- 根据 Section ID 返回内容；
- 记录 Skill 加载 Trace；
- 限制 Agent 只能读取当前 Assignment 的 Skill。

### Skill 文件格式

```markdown
---
id: scene-writing
version: 1.0.0
operation: fill_slot
slotTypes:
  - scene
requiredSections:
  - S1
  - S2
  - S6
---

# 场景写作 Skill

## S1. 理解槽位目标

...

## S2. 读取前置状态

...

## S3. 设计可见行动

...

## S4. 推进冲突或信息变化

...

## S5. 建立后续连接

...

## S6. 提交前自检

...
```

### Section Index

编译时生成：

```ts
interface SkillSectionIndex {
  id: string;
  title: string;
  order: number;
  startOffset: number;
  endOffset: number;
  contentHash: string;
}
```

### 可观察性边界

系统可以准确记录：

- 哪些 Section 被自动注入；
- 哪些 Section 被 Agent 显式调用工具读取。

系统不能声称知道模型内部真正“注意”了哪些文字。

---

## 6.9 Agent Runtime

### 职责

- 创建一次无历史 Provider Session；
- 注入 Assignment Context；
- 暴露受限工具；
- 处理流式公开输出；
- 执行工具循环；
- 控制最大工具调用数；
- 控制 Timeout；
- 响应 Abort；
- 采集 Usage；
- 在正式提交后终止本次 Assignment。

### Provider Adapter 接口

```ts
interface ProviderAdapter {
  runTurn(input: {
    model: string;
    messages: ProviderMessage[];
    tools: ProviderToolDefinition[];
    signal: AbortSignal;
    onTextDelta: (delta: string) => void;
    onToolCall: (call: ProviderToolCall) => Promise<ProviderToolResult>;
  }): Promise<ProviderTurnResult>;
}
```

### P0 Provider 实现

优先实现：

```text
OpenAICompatibleProviderAdapter
```

后续按需增加：

```text
OpenAIResponsesAdapter
AnthropicAdapter
PiAdapter
LocalModelAdapter
```

Provider Adapter 不能接触 Repository。

---

## 6.10 Tool Runtime

P0 只暴露六个工具。

### `read_task_input`

用途：

- 读取冻结的 Task Input；
- 支持读取单个字段或全部字段。

权限：

- 只能读取当前 Task。

---

### `read_skill_section`

用途：

- 按 Section ID 读取当前 Skill 的详细内容。

权限：

- 只能读取当前 Assignment 绑定的 Skill；
- 只能读取 Snapshot 中存在的 Section。

自动产生：

```text
skill_section_read
tool_call_started
tool_call_completed
```

---

### `read_structure_outline`

用途：

- 读取当前 Task 的轻量 Structure Outline。

权限：

- Structure Phase 不可调用；
- Slots Phase 可调用；
- 不返回非依赖槽位正文。

---

### `read_slot`

用途：

- 读取一个授权依赖 Slot 的内容。

权限：

```text
requestedSlotId ∈ targetSlot.dependsOn
```

P0 不允许读取任意已完成 Slot。

---

### `report_work`

用途：

Agent 主动发布可公开的工作说明。

```ts
report_work({
  type:
    | "understanding"
    | "plan"
    | "decision"
    | "progress"
    | "completion";
  summary: string;
  relatedSkillSectionIds?: string[];
  relatedSlotIds?: string[];
});
```

该工具：

- 只写 Trace；
- 不修改 Task；
- 不修改 Slot；
- 不影响执行结果。

---

### `complete_assignment`

唯一正式提交工具。

Structure Assignment：

```ts
{
  kind: "structure",
  rootSlotId: string,
  slots: SlotProposal[]
}
```

Fill Slot Assignment：

```ts
{
  kind: "slot_content",
  slotId: string,
  content: string
}
```

成功提交后：

- Execution 进入提交边界；
- Runtime 不再接受其他工具调用；
- Provider Stream 被中止或自然关闭；
- 后续文本只作为迟到输出忽略；
- Production Engine 推进下一步。

---

## 6.11 Completion Service

### 职责

接收 `complete_assignment`，执行不可绕过的提交边界。

### 通用校验

- Assignment ID 正确；
- Execution Token 正确；
- Execution 为 Running；
- Task 为 Running；
- Task Active Execution 正确；
- Agent 正确；
- Skill 正确；
- Operation 正确；
- Target 正确；
- Execution 未超时；
- Execution 未取消。

### Structure 提交

调用 Structure Service。

### Slot Content 提交

校验：

- Slot ID 与 Target 相同；
- Slot 仍为 Running；
- DependsOn 仍全部 Completed；
- Content 非空；
- 字数合法；
- Content 类型合法。

### 原子事务

```text
UPDATE slot.content
UPDATE slot.status = completed
UPDATE slot.producer_*
UPDATE execution.status = succeeded
UPDATE task.active_execution_id = null
INSERT trace_event(validation_result)
```

提交成功后通知 Production Engine 再次 Tick。

---

## 6.12 Production Engine

Production Engine 是整个生产循环的唯一编排入口。

### 职责

- 串行推进 Task；
- 根据 Phase 决定下一动作；
- 创建 Assignment；
- 调用 Assignment Runner；
- 进入 Assembly；
- 处理失败；
- 维护全局单执行槽。

### 核心算法

```ts
async function tick(taskId: string): Promise<void> {
  const task = await taskRepository.get(taskId);

  if (task.status !== "running") return;
  if (task.activeExecutionId !== null) return;

  if (task.phase === "structure") {
    await assignmentService.createAndRunStructureAssignment(task);
    return;
  }

  if (task.phase === "slots") {
    const slots = await slotRepository.listByTask(taskId);

    const next = selectNextReadySlot(slots);
    if (next !== null) {
      await assignmentService.createAndRunFillSlotAssignment(task, next);
      return;
    }

    if (allContentSlotsCompleted(slots)) {
      await taskRepository.moveToAssembly(taskId);
      await tick(taskId);
      return;
    }

    await lifecycleService.failTask(
      taskId,
      "DEPENDENCY_DEADLOCK"
    );
    return;
  }

  if (task.phase === "assembly") {
    await assemblyService.assembleAndComplete(taskId);
  }
}
```

### 全局串行

使用进程内 `ExecutionQueue`：

```text
FIFO
全局并发度 = 1
```

数据库 Token 和状态校验负责正确性，内存 Queue 只负责调度效率。

---

## 6.13 Trace Service

### 职责

- 保存结构化 Trace Event；
- 为每个 Execution 分配单调 Sequence；
- 发布实时事件到 SSE Hub；
- 返回分页历史；
- 脱敏 Tool 参数和结果；
- 聚合高频 Text Delta。

### Trace Event

```ts
interface TraceEvent {
  id: string;
  taskId: string;
  executionId: string | null;
  sequence: number;

  actor: "agent" | "system" | "tool";
  kind: TraceEventKind;

  title: string;
  summary: string;
  payload: JsonObject | null;

  createdAt: string;
}
```

### P0 Event Kind

```text
task_state_changed
assignment_created
assignment_started
context_built
skill_loaded
skill_section_read
work_understanding
work_plan
work_decision
work_progress
work_completion
tool_call_started
tool_call_completed
public_output_chunk
assignment_submitted
validation_passed
validation_failed
assignment_completed
assignment_failed
assignment_cancelled
late_result_rejected
slot_state_changed
assembly_started
artifact_created
```

### 高频输出处理

Provider Text Delta 不逐 Token 持久化。

策略：

- 内存中实时 SSE 推送；
- 每 250ms 或累计 1KB 聚合为一个 `public_output_chunk`；
- Execution 完成时写入最终公开文本摘要。

---

## 6.14 Assembly Service

### 职责

- 加载全部 Slot；
- 验证所有内容 Slot Completed；
- 按确定性顺序组装；
- 计算 SHA-256；
- 写入 Artifact；
- 将 Task 设置为 Completed。

### P0 Assembler

```text
markdown_concat_v1
```

规则：

- 深度优先遍历；
- 忽略容器 Slot；
- 两个换行符连接；
- 保留 Slot Content 内部格式；
- UTF-8 编码。

### 原子事务

```text
INSERT artifact
UPDATE task.phase = done
UPDATE task.status = completed
UPDATE task.artifact_id
INSERT trace_event(artifact_created)
```

---

## 6.15 Lifecycle Service

### Start

```text
ready/stopped/failed
→ running
→ ProductionEngine.enqueue
```

### Stop

事务顺序：

1. 读取 Active Execution；
2. 使 Token 失效；
3. Execution 设为 Cancelled；
4. Running Slot 恢复 Pending；
5. 清除 Active Execution；
6. Task 设为 Stopped；
7. 事务提交；
8. 触发 AbortController。

必须先让数据库拒绝旧结果，再触发 Provider Abort。

### Resume

```text
stopped
→ running
→ ProductionEngine.enqueue
```

### Retry

按失败阶段：

- Structure：创建新的 Structure Execution；
- Slots：Failed Slot 重置 Pending；
- Assembly：重新 Assembly。

### Startup Recovery

服务启动时：

```text
running Task
+ active Execution
→ Execution Cancelled
→ Running Slot Pending
→ Task Stopped
```

P0 不自动恢复模型调用。

---

## 7. 数据库设计

## 7.1 `task_snapshots`

```text
id                  TEXT PRIMARY KEY
task_id             TEXT UNIQUE NOT NULL
template_id         TEXT NOT NULL
template_version    TEXT NOT NULL
compiled_json       TEXT NOT NULL
snapshot_hash       TEXT NOT NULL
created_at          TEXT NOT NULL
```

---

## 7.2 `task_skill_snapshots`

```text
task_id             TEXT NOT NULL
skill_id            TEXT NOT NULL
skill_version       TEXT NOT NULL
content_markdown    TEXT NOT NULL
section_index_json  TEXT NOT NULL
content_hash        TEXT NOT NULL

PRIMARY KEY(task_id, skill_id)
```

---

## 7.3 `tasks`

```text
id                    TEXT PRIMARY KEY
name                  TEXT NOT NULL
snapshot_id           TEXT NOT NULL
input_json             TEXT NOT NULL

status                 TEXT NOT NULL
phase                  TEXT NOT NULL
active_execution_id    TEXT NULL
artifact_id            TEXT NULL

error_code             TEXT NULL
error_message          TEXT NULL

created_at             TEXT NOT NULL
updated_at             TEXT NOT NULL
```

约束：

```text
status ∈ ready,running,stopped,failed,completed
phase ∈ structure,slots,assembly,done
```

---

## 7.4 `slots`

```text
task_id                 TEXT NOT NULL
slot_id                 TEXT NOT NULL
type                     TEXT NOT NULL

parent_id                TEXT NULL
sort_order               INTEGER NOT NULL
instruction              TEXT NOT NULL
depends_on_json          TEXT NOT NULL

content_bearing          INTEGER NOT NULL
status                   TEXT NOT NULL
content_text             TEXT NULL

producer_agent_id        TEXT NULL
producer_skill_id        TEXT NULL
producer_skill_version   TEXT NULL
producer_execution_id    TEXT NULL

error_code               TEXT NULL
error_message            TEXT NULL

created_at               TEXT NOT NULL
updated_at               TEXT NOT NULL

PRIMARY KEY(task_id, slot_id)
```

数据库 Check 约束：

```text
content_bearing ∈ 0,1
status ∈ pending,running,completed,failed
```

业务约束由 Domain 验证：

```text
completed content slot 必须有 content 和 producer
container slot 不得有正文
```

---

## 7.5 `executions`

```text
id                    TEXT PRIMARY KEY
task_id               TEXT NOT NULL

operation             TEXT NOT NULL
target_slot_id        TEXT NULL

agent_id              TEXT NOT NULL
skill_id              TEXT NOT NULL
skill_version         TEXT NOT NULL

token_hash            TEXT NOT NULL
context_json          TEXT NOT NULL
context_hash          TEXT NOT NULL

provider              TEXT NOT NULL
model                 TEXT NOT NULL

attempt_number        INTEGER NOT NULL
status                TEXT NOT NULL

error_code            TEXT NULL
error_message         TEXT NULL

started_at            TEXT NULL
finished_at           TEXT NULL
created_at            TEXT NOT NULL
```

状态：

```text
created
running
succeeded
failed
cancelled
stale
```

---

## 7.6 `trace_events`

```text
id              TEXT PRIMARY KEY
task_id         TEXT NOT NULL
execution_id    TEXT NULL
sequence        INTEGER NOT NULL

actor           TEXT NOT NULL
kind            TEXT NOT NULL
title           TEXT NOT NULL
summary         TEXT NOT NULL
payload_json    TEXT NULL

created_at      TEXT NOT NULL

UNIQUE(task_id, sequence)
```

索引：

```text
(task_id, sequence)
(execution_id, sequence)
(kind, created_at)
```

---

## 7.7 `artifacts`

```text
id              TEXT PRIMARY KEY
task_id         TEXT UNIQUE NOT NULL

file_name       TEXT NOT NULL
media_type      TEXT NOT NULL
content_blob    BLOB NOT NULL

checksum        TEXT NOT NULL
byte_size       INTEGER NOT NULL

created_at      TEXT NOT NULL
```

---

## 8. 数据库事务边界

以下操作必须使用显式事务：

### 创建 Task

```text
INSERT task_snapshot
INSERT task_skill_snapshots
INSERT task
```

### 提交 Structure

```text
INSERT all slots
UPDATE execution
UPDATE task
INSERT trace events
```

### 提交 Slot Content

```text
UPDATE slot
UPDATE execution
UPDATE task
INSERT trace events
```

### Stop

```text
UPDATE execution
UPDATE running slot
UPDATE task
INSERT trace event
```

### 完成 Artifact

```text
INSERT artifact
UPDATE task
INSERT trace event
```

Repository 层提供：

```ts
database.transaction(() => {
  // all writes
});
```

Application 不允许手工跨多个独立 Repository 调用拼接事务。

应提供面向用例的 Unit of Work。

---

## 9. API 设计

## 9.1 Template

```text
GET  /api/templates
GET  /api/templates/:templateId
POST /api/templates/:templateId/reload
```

---

## 9.2 Task

```text
POST /api/tasks
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/start
POST /api/tasks/:taskId/stop
POST /api/tasks/:taskId/resume
POST /api/tasks/:taskId/retry
```

---

## 9.3 Slot

```text
GET /api/tasks/:taskId/slots
GET /api/tasks/:taskId/slots/:slotId
```

---

## 9.4 Execution 与 Trace

```text
GET /api/tasks/:taskId/executions
GET /api/tasks/:taskId/traces?after=:sequence&limit=:limit
GET /api/tasks/:taskId/stream?after=:sequence
```

SSE Event：

```text
event: trace
id: <sequence>
data: <TraceEvent JSON>
```

客户端断线重连后使用最后 Sequence 补读。

---

## 9.5 Artifact

```text
GET /api/tasks/:taskId/artifact
GET /api/tasks/:taskId/artifact/download
```

下载接口从 SQLite BLOB 流式返回，并设置：

```text
Content-Type
Content-Disposition
ETag = checksum
```

---

## 10. 前端技术结构

## 10.1 页面

```text
/tasks
/tasks/new
/tasks/:taskId
/templates
/templates/:templateId
/settings/providers
```

---

## 10.2 组件树

```text
AppShell
├── TaskListPage
├── NewTaskPage
├── TemplateListPage
├── TemplateDetailPage
├── ProviderSettingsPage
└── TaskWorkspacePage
    ├── TaskHeader
    ├── ProductionStepper
    ├── SlotTree
    ├── SlotDetailPanel
    ├── AgentWorkPanel
    │   ├── AssignmentSummary
    │   ├── TraceFilter
    │   ├── TraceTimeline
    │   └── TraceEventCard
    ├── TaskControls
    └── ArtifactViewer
```

---

## 10.3 Task Workspace 布局

```text
顶部：
Task 状态 + Phase + 控制 + 生产 Stepper

左侧：
Slot Tree

中央：
Slot Instruction + DependsOn + Slot Content

右侧：
Assignment Summary + Agent Work Trace

底部或抽屉：
完整过程记录 / 技术详情
```

---

## 10.4 客户端数据流

首次进入：

```text
GET task workspace
GET slots
GET trace history
OPEN SSE
```

收到 SSE 后：

- Trace Event 直接追加到时间线；
- 状态变化 Event 触发轻量 Workspace Reload；
- 不直接信任 Event 自行修改权威状态。

原则：

```text
SSE 用于通知与流式展示
REST Snapshot 用于权威页面状态
```

---

## 10.5 Agent Work Panel

默认展示：

```text
Agent
Skill
Operation
Target
Attempt
运行时间
最近 Trace
```

Trace 筛选：

```text
全部
工作说明
Skill
工具
系统
输出
```

不展示：

- 隐藏 Chain-of-Thought；
- Provider 私有 Reasoning；
- API Key；
- System Secret；
- 未脱敏工具 Payload。

---

## 11. Agent Prompt 结构

P0 每次 Assignment 使用独立 Session。

### System Message

```text
平台边界
Agent Role
当前 Operation
当前 Skill Overview
Required Skill Sections
工具使用规则
正式提交规则
禁止事项
```

### User Message

```text
Task Input
Structure Outline
Target Slot
Slot Instruction
Dependency Content
Output Contract
```

### Runtime Reminder

工具执行后可以动态追加简短提醒：

```text
当前正式提交目标仍为 scene_03。
只有 complete_assignment 会保存生产结果。
```

不实施多轮自由聊天历史。

---

## 12. 错误模型

统一错误结构：

```ts
interface PublicError {
  code: string;
  message: string;
  location: string | null;
  action: string | null;
}
```

P0 稳定错误码：

```text
TEMPLATE_NOT_FOUND
TEMPLATE_INVALID
TASK_NOT_FOUND
TASK_STATE_INVALID
ENGINE_BUSY
STRUCTURE_INVALID
STRUCTURE_RETRY_EXHAUSTED
SLOT_NOT_FOUND
SLOT_NOT_READY
SLOT_TARGET_MISMATCH
SLOT_CONTENT_INVALID
DEPENDENCY_DEADLOCK
PROVIDER_TIMEOUT
PROVIDER_ERROR
EXECUTION_CANCELLED
EXECUTION_STALE
EXECUTION_TOKEN_INVALID
TOOL_NOT_ALLOWED
SKILL_SECTION_NOT_FOUND
ASSIGNMENT_OUTPUT_INVALID
ASSEMBLY_FAILED
ARTIFACT_NOT_FOUND
STORAGE_ERROR
```

内部 Stack 只写脱敏服务日志，不直接返回前端。

---

## 13. 安全边界

### Provider Credential

P0 从环境变量或本地安全配置读取。

不得进入：

- Task Snapshot；
- Trace；
- Prompt；
- Tool Result；
- API Response；
- Artifact。

---

### 工具权限

工具实例必须按 Assignment 创建，不使用全局万能工具。

例如 Fill Slot 的 `read_slot` 闭包中直接冻结：

```text
taskId
targetSlotId
allowedDependencySlotIds
```

不要把权限判断交给模型参数。

---

### Markdown 展示

前端预览 Markdown 时：

- 禁止原始 HTML，或经过严格 Sanitizer；
- 外部链接使用安全属性；
- 不执行脚本；
- 不自动加载不可信远程资源。

---

### Trace 脱敏

Trace Service 必须裁剪：

- Authorization；
- API Key；
- 环境变量；
- Provider 原始请求 Header；
- 隐藏 Reasoning；
- 超长正文参数。

完整 Slot Content 通过 Slot API 查看，不重复塞入 Trace。

---

## 14. 测试架构

## 14.1 Domain Unit Tests

覆盖：

- Structure Validation；
- Parent Cycle；
- Dependency Cycle；
- Ready Slot；
- 稳定排序；
- Task 状态机；
- Slot 状态机；
- Assembly；
- Context Canonicalization。

---

## 14.2 Repository Tests

使用临时 SQLite 数据库，覆盖：

- Migration；
- Foreign Key；
- 事务回滚；
- Structure 原子提交；
- Slot 原子提交；
- Stop 原子提交；
- Artifact 原子完成；
- Unique 约束；
- Restart Recovery。

---

## 14.3 Fake Provider

实现脚本化 Provider：

```ts
fake.enqueue({
  textDeltas: [...],
  toolCalls: [...],
  delayMs: 0,
  terminalError: null
});
```

可模拟：

- 正常 Structure；
- 正常 Slot Content；
- 无效 Tool 参数；
- Provider Timeout；
- Provider Error；
- 不调用 Complete；
- 多次 Complete；
- Stop 后迟到结果；
- Skill Section 读取；
- Report Work。

---

## 14.4 Runtime Integration Tests

覆盖：

```text
Assignment
→ Context
→ Provider
→ Tool
→ Completion
→ Transaction
→ Next Tick
```

---

## 14.5 API Tests

覆盖：

- Route Schema；
- 生命周期；
- 错误映射；
- Artifact 下载；
- SSE Replay；
- Unknown Task；
- 状态冲突。

---

## 14.6 Client Tests

覆盖：

- Slot Tree 状态；
- Stepper；
- Assignment Summary；
- Trace Timeline；
- Skill Event；
- Tool Event；
- Stop / Resume；
- Artifact Viewer；
- SSE 重连。

---

## 14.7 E2E Tests

Playwright 完整链路：

```text
选择模板
→ 新建 Task
→ Start
→ Structure
→ Fill Slots
→ Assembly
→ Artifact Download
```

故障链路：

```text
Timeout
Stop
Late Result
Restart
Retry
```

---

## 14.8 真实 Provider 验收

真实 Provider 测试通过环境变量显式开启，不进入普通测试默认路径。

至少保存：

- Task ID；
- Snapshot Hash；
- Context Hash；
- Agent；
- Skill；
- Trace；
- Artifact Checksum；
- 测试命令；
- 是否人工修改数据。

---

## 15. 推荐目录结构

```text
forge-core-vnext/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── migrations/
│   ├── 001_initial.sql
│   └── 002_indexes.sql
│
├── templates/
│   └── zhihu-chapter/
│       └── template.yaml
│
├── skills/
│   ├── chapter-structure-design/
│   │   └── SKILL.md
│   ├── title-writing/
│   │   └── SKILL.md
│   ├── opening-writing/
│   │   └── SKILL.md
│   ├── scene-writing/
│   │   └── SKILL.md
│   └── chapter-ending-writing/
│       └── SKILL.md
│
├── src/
│   ├── shared/
│   │   ├── contracts.ts
│   │   ├── schemas.ts
│   │   ├── errors.ts
│   │   └── trace-contracts.ts
│   │
│   ├── server/
│   │   ├── domain/
│   │   │   ├── template/
│   │   │   ├── task/
│   │   │   ├── slot/
│   │   │   ├── structure/
│   │   │   ├── execution/
│   │   │   └── artifact/
│   │   │
│   │   ├── application/
│   │   │   ├── template-service.ts
│   │   │   ├── snapshot-service.ts
│   │   │   ├── task-service.ts
│   │   │   ├── structure-service.ts
│   │   │   ├── slot-scheduler.ts
│   │   │   ├── assignment-service.ts
│   │   │   ├── context-builder.ts
│   │   │   ├── completion-service.ts
│   │   │   ├── production-engine.ts
│   │   │   ├── lifecycle-service.ts
│   │   │   ├── assembly-service.ts
│   │   │   └── trace-service.ts
│   │   │
│   │   ├── runtime/
│   │   │   ├── agent-runtime.ts
│   │   │   ├── assignment-runner.ts
│   │   │   ├── provider/
│   │   │   │   ├── provider-adapter.ts
│   │   │   │   └── openai-compatible.ts
│   │   │   ├── skill-runtime.ts
│   │   │   └── tools/
│   │   │       ├── read-task-input.ts
│   │   │       ├── read-skill-section.ts
│   │   │       ├── read-structure-outline.ts
│   │   │       ├── read-slot.ts
│   │   │       ├── report-work.ts
│   │   │       └── complete-assignment.ts
│   │   │
│   │   ├── infrastructure/
│   │   │   ├── database/
│   │   │   │   ├── sqlite-database.ts
│   │   │   │   ├── migrations.ts
│   │   │   │   └── repositories/
│   │   │   ├── template-files/
│   │   │   ├── provider-config/
│   │   │   ├── hashing/
│   │   │   └── sse/
│   │   │
│   │   ├── api/
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   └── error-mapper.ts
│   │   │
│   │   └── main.ts
│   │
│   └── client/
│       ├── app.tsx
│       ├── router.tsx
│       ├── gateway/
│       ├── hooks/
│       ├── pages/
│       ├── components/
│       │   ├── production-stepper/
│       │   ├── slot-tree/
│       │   ├── slot-detail/
│       │   ├── agent-work-panel/
│       │   └── artifact-viewer/
│       └── styles/
│
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── e2e/
│
└── data/
    └── forge-core.sqlite
```

---

## 16. 实施阶段

## Phase 0：工程骨架

实现：

- TypeScript；
- Fastify；
- React + Vite；
- SQLite Migration；
- Shared Contract；
- 基础 CI；
- Fake Provider。

验收：

```text
服务启动
前端打开
数据库自动迁移
基础 API 可访问
```

---

## Phase 1：Template 与 Snapshot

实现：

- Template YAML；
- Skill Markdown；
- Skill Section Parser；
- Template Compiler；
- Binding Validation；
- Snapshot Hash；
- Template 页面；
- New Task。

验收：

```text
有效模板可创建 Task
修改 Skill 后旧 Task Snapshot 不变
```

---

## Phase 2：Structure 闭环

实现：

- Structure Assignment；
- Agent Runtime；
- Read Skill；
- Report Work；
- Complete Structure；
- Structure Validation；
- Slot 原子写入；
- Structure UI。

验收：

```text
Agent 创建合法结构
非法结构整体拒绝
```

---

## Phase 3：Slot 生产闭环

实现：

- Ready Slot；
- Context Builder；
- Slot Binding；
- Read Slot；
- Fill Slot；
- 原子提交；
- 串行生产循环。

验收：

```text
所有 Slot 自动依次完成
依赖未满足时不会执行
```

---

## Phase 4：Agent Work Trace

实现：

- Trace Event；
- SSE；
- Skill Section Event；
- Tool Event；
- Report Work；
- Output Chunk；
- Agent Work Panel。

验收：

```text
用户可以看到 Agent、Skill、计划、决策、工具和提交过程
```

---

## Phase 5：Assembly 与 Artifact

实现：

- Markdown Assembler；
- Artifact BLOB；
- Checksum；
- Artifact Viewer；
- Download。

验收：

```text
所有 Slot 完成后自动生成 chapter.md
重复 Assembly Checksum 一致
```

---

## Phase 6：可靠性

实现：

- Timeout；
- Abort；
- Token；
- Stop；
- Late Result；
- Retry；
- Startup Recovery；
- 错误模型。

验收：

```text
无永久 Running
Stop 后旧结果不可提交
重启后从未完成 Slot 继续
```

---

## Phase 7：真实 Provider 验收

实现：

- OpenAI-Compatible Provider；
- Provider 设置；
- 真实模型 E2E；
- 脱敏日志。

验收：

```text
无需人工修改数据完成至少 10 个真实章节任务
```

---

## 17. P0 完成定义

只有同时满足以下条件，P0 才算完成：

1. 只有一套结构槽 Production Runtime；
2. Agent 能使用 Skill 创建 Structure；
3. Agent 能使用 Skill 填充 Slot；
4. Agent Context 可重建且有 Hash；
5. Agent Work Trace 可实时查看；
6. Skill Section 读取可追踪；
7. Tool Call 可追踪；
8. Slot 提交具备原子性；
9. Provider Timeout 有界收敛；
10. Stop 后迟到结果被拒绝；
11. 重启不丢失已完成 Slot；
12. Artifact 与 Completed 原子提交；
13. 真实 Provider 可端到端生成最终文件；
14. 不依赖 Review、Finding、Seal、Migration 或 Capability；
15. `ProductionEngine`、`AgentRuntime`、`TraceService` 和 UI 均有自动化测试。

---

## 18. 明确不采用的技术

P0 不采用：

- 微服务；
- Kafka、RabbitMQ 等消息队列；
- Temporal、Airflow 等工作流引擎；
- PostgreSQL；
- 图数据库；
- 向量数据库；
- 完整 Event Sourcing；
- CQRS 双存储；
- Kubernetes；
- 多进程 Worker；
- 分布式 Lease；
- 通用 Agent 自主规划框架；
- Agent 自由文件系统；
- Agent Shell；
- 自动 Skill 搜索；
- 可视化流程编辑器；
- 复杂 ORM；
- 独立 WorkItem Graph；
- 多版本 Artifact Store。

后续只有在真实业务指标证明必要时，才增加相应实体或基础设施。

---

## 19. 后续扩展接口

P0 需要保留扩展接口，但不提前实现功能。

### Slot Revision

未来可以增加：

```text
slot_revisions
```

不修改 P0 Slot Scheduler 和 Context Builder 的核心接口。

---

### Review

未来 Review 应绑定：

```text
slot_revision_id
或
artifact_id
```

而不是修改 Slot 的基础含义。

---

### 更丰富关系

未来可把：

```text
dependsOn
```

拆分为：

```text
waitFor
readFrom
semanticRelations
```

P0 不提前建 Relation Table。

---

### 并发执行

未来可将：

```text
ExecutionQueue concurrency = 1
```

提升为 N。

在此之前必须增加：

- Slot Claim；
- 并发提交 CAS；
- Provider 资源预算。

---

### 大型 Artifact

未来将 SQLite BLOB Adapter 替换为：

```text
ContentAddressedArtifactStore
```

Application 继续使用相同 Artifact Repository 接口。

---

## 20. 最终技术定义

Forge Core vNext P0 的技术本质是：

> **一个以 SQLite 为权威状态源、以 Production Engine 为确定性调度核心、以轻量 Agent Runtime 为内容执行层、以 Skill Snapshot 为工作方法、以 Slot 为内容对象、以 Trace Event 为可观察过程、以 React Task Workspace 为主要界面的模块化单体系统。**

核心调用链为：

```text
Task Command
→ Production Engine
→ Assignment
→ Deterministic Context
→ Agent + Skill
→ Tool Loop
→ complete_assignment
→ Atomic Commit
→ Next Slot
→ Deterministic Assembly
→ Artifact
```

核心观察链为：

```text
Agent Runtime
→ Trace Event
→ SQLite Trace Store
→ SSE
→ Agent Work Panel
```

生产状态和观察数据严格分离：

```text
Task / Slot / Execution / Artifact
=
权威生产状态

Trace Event
=
Agent 和系统工作过程
```

这套架构优先解决基础结构槽生产是否可靠、可理解、可恢复和可迭代，不提前建设审核权威、复杂关系、迁移或分布式调度。
