# Forge Core vNext 可执行技术实现方案

**文档版本：** V1.0
**文档状态：** 可执行实现基线
**上游文档：**
- 《Forge Core vNext：结构槽原生 Agent 内容生产平台需求规格说明书》V0.1（下称 **REQ**）
- 《Forge Core vNext 技术实现方案》V0.1（下称 **TECH-V0.1**）
- 《Forge Core vNext UI/UX 设计需求文档》V0.2（下称 **UX**）
- `design_handoff_forge_core_vnext/`（下称 **HANDOFF**，含 7 份高保真设计稿）

---

## 0. 本文档的定位

TECH-V0.1 回答的是「系统由哪些模块构成、每个模块负责什么」。它是一份**架构设计文档**。

本文档回答的是「现在坐下来敲第一行代码，敲什么」。它是一份**实现基线**，与 TECH-V0.1 的关系是：

- **继承**：技术栈选型、分层边界、模块职责划分、单进程串行、SQLite 权威状态、SSE 单向推送——全部沿用，不重新论证。
- **收敛**：TECH-V0.1 中所有「可以 A 也可以 B」的地方，本文档给出唯一决定和理由。
- **补全**：TECH-V0.1 未覆盖但 HANDOFF 已经画出来的部分（Provider 别名层、槽位级模型覆盖、产物校验规则、业务化状态投影），在本文档中补齐设计。
- **纠偏**：HANDOFF 与 REQ 存在实质冲突的地方（最重要的是「模板是否声明固定结构树」），在本文档中裁决。

**冲突时的优先级：本文档 > REQ > TECH-V0.1 > UX > HANDOFF。**

理由：REQ 定义产品边界，是不可让渡的；TECH-V0.1 是实现手段，可优化；UX/HANDOFF 是在 REQ 定稿前并行产出的，设计师对运行时模型的理解存在偏差，需要以 REQ 校正。本文档所有对 HANDOFF 的修改都在 §1 中显式列出，交付给设计侧确认。

---

## 1. 决议清单

这一节是本文档的核心。每条决议编号为 `D-nn`，实现时凡涉及该主题一律以此为准。

标记说明：
- 🔴 **需设计侧确认** —— 该决议要求修改已交付的设计稿
- 🟡 **需产品确认** —— 该决议是产品取舍，不是技术取舍
- 🟢 **技术决定** —— 纯实现选择，直接执行

> **📌 确认状态（2026-08-20）：全部 🔴 与 🟡 项已获批准。**
>
> 确认原则：**界面设计以需求规格说明书为准，前端按需改动。**
>
> 因此附录 C 的 12 条修改全部生效，不再是待确认项。设计稿（`.dc.html`）在冲突处不再具备约束力，其价值收敛为**视觉语言与交互模式的参考**——令牌、间距、状态分色、组件形态仍然精确遵循，但信息架构以本文档为准。

---

### D-01 🔴 模板不声明具体结构树，只声明槽位类型

**冲突来源**

HANDOFF 的 `模板详情.dc.html` 中，`NODES` 常量画的是一棵**具体的、写死的槽位树**：

```js
{ id: "chapter", kind: "container", children: [
    { no: "01", name: "chapter_outline" },
    { no: "02", name: "scene_1" },
    { no: "03", name: "scene_2" },
    { no: "04", name: "scene_3" },
    { no: "05", name: "chapter_hook" } ] }
```

`新建任务.dc.html` 的右栏预览同样是一棵固定树。

而 REQ §9.1 的 `TemplateDefinition` 里**没有结构树字段**，只有 `slotTypes`（槽位类型目录）和 `bindings.fillSlotByType`（类型到 Agent/Skill 的绑定）。REQ §13 明确规定具体结构由 Structure Agent 在运行时创建：「创建哪些槽位、每个槽位的 ID、类型、父子关系、同级顺序、内容目标、依赖」全部是 Agent 的职责。

这不是措辞差异，是两种不同的产品：

| | 静态树模板（设计稿画的） | 动态结构（REQ 定义的） |
|---|---|---|
| 槽位数量 | 模板写死 | Agent 根据输入决定 |
| 一章几个场景 | 永远 3 个 | 这一章的素材需要几个就几个 |
| Structure Agent | 不需要 | 核心角色 |
| 本质 | 一条固定流水线 | 结构槽生产 |

**决议**

**采用 REQ 的动态结构模型。** 模板只声明槽位类型目录 + 绑定 + 限制。

理由：动态结构是这个产品的全部立论。如果结构由模板写死，那么 `Structure = StructureAgent(StructureSkill, TaskInput)` 这条公式就不存在了，整个 REQ §13、§25.2、AC-003、AC-004 全部落空，产品退化成一个 YAML 驱动的顺序执行器——那样的话不需要这套架构。

同时，REQ §5.4 已经预留了退化路径：「一个普通单段文档可以退化为只有一个内容槽位的结构」。固定结构的需求可以由「Structure Skill 明确要求产出固定形态」来满足，而不需要在系统里增加第二条运行时路径（REQ §5.4：只有一套生产协议）。

**对设计稿的具体修改要求**

1. **模板详情页 `/templates/:id`**：左栏的「槽位结构树」改为「**槽位类型目录**」。视觉语言完全保留（同样的行高、缩进、选中态、右栏联动），但语义改变：
   - 列出的是 `slotTypes[]`，不是具体槽位
   - 不显示父子缩进（类型之间没有父子关系），改为按 `contentBearing` 分两组：**容器类型** / **内容类型**
   - 每行显示：类型 ID、类型名、`contentBearing` 标记、字数区间
   - 右栏 Assignment 面板逻辑不变——选中一个内容类型，右栏展示该类型的 Agent + Skill + 模型 + 超时 + 重试 + 校验规则。这部分设计可 100% 复用
   - 移除 `children[]` 组装顺序列表（组装顺序是运行时结构决定的，模板层不存在）
   - 新增一栏「**结构设计**」，展示 `bindings.createStructure` 的 Agent + Skill + 结构限制（maxSlots / maxDepth）——这是模板详情页当前缺失的最重要信息

2. **新建任务页 `/tasks/new` 右栏**：标题从「槽位树预览」改为「**示例结构**」，并在标题下方加一行说明：

   > 实际结构由 Structure Agent 在任务启动后生成，槽位数量与层级会随输入变化。

   树本身保留——见 D-02。

---

### D-02 🟢 模板可声明 `exampleStructure`，仅用于展示

D-01 拿掉了模板的固定树，但新建任务页的右栏预览是有真实价值的：用户在填输入之前，需要对「这个模板会产出什么形态的东西」有直观预期。

**决议**

模板可选声明 `exampleStructure`，语义严格限定为**展示用样例**：

- 永远不进入 Task Snapshot
- 永远不进入 Agent 上下文
- 永远不参与运行时任何逻辑
- 只被 `GET /api/templates/:id` 返回，供新建任务页与模板详情页渲染

在代码中该字段位于 `TemplateDefinition.presentation.exampleStructure`，与运行时字段物理隔离，`CompiledTemplate` 编译时**剥离该字段后再计算 `templateHash`**——保证改样例不会导致快照 Hash 变化。

---

### D-03 🟡 Provider 与模型别名层：必须实现，配置文件驱动 + 数据库覆盖

**缺口来源**

HANDOFF 的 `Provider 设置.dc.html` 有一张 `MAPPINGS` 表：

```js
{ alias: "claude-sonnet", provider: "Anthropic", model: "claude-sonnet-4-5", usage: "9 个槽位" }
```

README 明确指出这是关键抽象：「别名是模板与实际模型之间的间接层——模板里写别名，换模型时只改这张表，不动模板」。

而 TECH-V0.1 全文只在路由清单里出现过一次 `/settings/providers`，§7 数据库设计的 7 张表里没有任何 Provider 配置表，§9 API 设计里没有任何 `/api/providers` 端点。REQ §21 的最小 API 同样没有。

**这个缺口是阻塞性的**：REQ §24 的示例模板写的是 `provider: configured` / `model: main`——这两个值本身就是别名。没有别名解析层，示例模板根本无法执行。

**决议**

实现别名层，采用**配置文件为主 + 数据库存运行时可变部分**的混合方案：

```
providers.yaml           ← Provider 定义与别名映射（版本控制，人工编辑）
  ↓ 启动时加载
ProviderRegistry (内存)
  ↓ 运行时探测结果写入
provider_health (SQLite) ← 连通状态、延迟、最近检测时间、429 计数
```

不把别名映射放进数据库的理由：它是配置不是状态，应该进版本控制、可 code review、可随代码回滚。把健康状态放进数据库的理由：它是运行时观测结果，需要跨请求持久化供 UI 查询。

**关键决议：别名冻结，解析late-bound。**

Task Snapshot 冻结的是 `AgentDefinition.model = "main"`（别名字符串），**不冻结解析结果**。执行时才把别名解析为具体 `{ providerId, modelId }`。

理由：这正是别名层存在的意义。若冻结解析结果，则某个模型下线后，所有历史任务的 retry 都会失败，而修复手段只能是改数据库——这与 README「换模型时只改这张表」的设计意图直接相反。副作用是同一个任务的两次 attempt 可能用不同的实际模型，这一点通过在 `executions` 表中记录**解析后的** `provider` / `model` 来保证可追溯（TECH-V0.1 §7.5 已有这两个字段，语义在此明确为「解析后的实际值」）。

**API 补充**（REQ §21 未列，本文档新增）：

```
GET  /api/providers                    Provider 列表 + 健康状态 + 别名映射
POST /api/providers/:providerId/probe  主动探测连通性
GET  /api/providers/defaults           执行默认值
```

三个端点均为只读或幂等探测。**P0 不提供别名映射的写接口**——改映射就是改 `providers.yaml` 然后重启。UI 上「模型映射」表格为只读展示，去掉编辑入口（🔴 需设计侧确认）。

理由：写接口意味着需要处理「改映射时有任务正在跑」的并发语义，收益极低。

---

### D-04 🔴 「并发槽位」执行默认值与 P0 串行约束冲突

**冲突来源**

`Provider 设置.dc.html` 的 `DEFAULTS` 里有一项：

```js
{ label: "并发槽位", value: "3", note: "同一任务内可并行执行的槽位数" }
```

`模板列表.dc.html` 的模板描述里也写了「三段场景正文**并行**填充」。

而 REQ NFR-001 明确规定：「同一时间全局最多运行一个 Agent Assignment」，REQ §7 把「槽位并发执行」列入 P0 非目标。

**决议**

保留 UI 元素，值固定为 `1`，置灰不可编辑，note 改为：

> P0 全局串行执行。并发能力见路线图 P4。

理由：完全删掉这张卡会让「执行默认值」区只剩三项、布局失衡，且未来 P4 加回来又要改设计。保留并诚实标注是成本最低的处理。

`模板列表.dc.html` 中所有含「并行」字样的模板描述文案需改写（🔴）。这些是原型示意文案，不影响功能，但会误导用户对系统能力的预期。

---

### D-05 🟡 产物校验规则拆分为「确定性校验」与「写作要求」

**冲突来源**

`模板详情.dc.html` 中每个内容槽位都有一组 `checks[]`：

```js
checks: [
  "字数落在 1200–1800 区间",
  "不含小标题或列表结构",
  "结尾状态可被 scene_2 承接"
]
```

设计稿把这三条并列显示为「产物校验规则」，每条前面一个对勾图标——视觉上暗示它们都会被系统强制校验。

但它们的性质完全不同：

| 规则 | 可确定性校验？ |
|---|---|
| 字数落在 1200–1800 区间 | ✅ 数字比较 |
| 不含小标题或列表结构 | ✅ 正则匹配 |
| 结尾状态可被 scene_2 承接 | ❌ 需要语义理解 |

REQ FR-SLOT-004 只规定四项确定性校验（字符串类型、去空白后非空、不低于最小值、不超过最大值）。

> **本节已被后续变更部分修订（Slot Review 提前进入 P0，REQ §7.1 / FR-REVIEW-001..004）。**
> 原文此处写「P0 不进行语义质量审核，REQ §7 把 Slot Review 列入非目标」——该前提已不成立。
> 但**本节的决议与理由完全保留**，且被新增能力所加强，见下方「与语义审核的关系」。

**决议**

在模板的槽位类型定义中拆成两个字段：

```yaml
- id: scene
  contentBearing: true
  # 确定性校验：系统强制，违反则拒绝提交并计入重试
  validation:
    minChars: 1200
    maxChars: 1800
    forbidPattern: '(?m)^#{1,6}\s'      # 不含 Markdown 小标题
    forbidPatternMessage: 不得包含小标题
  # 写作要求：注入 Agent 上下文，系统不强制
  guidance:
    - 首段需衔接前一场景的结尾状态
    - 需留下至少一个未解悬念
```

UI 上两组用**不同图标**区分（🔴）：
- `validation` → 对勾图标 + 「系统校验」标签
- `guidance` → 引号或文档图标 + 「写作要求」标签

理由：让用户以为「结尾状态可被承接」会被系统校验，是一种承诺欺骗。而把这类要求明确标为「写作要求」并注入 Agent 上下文，既诚实又真正提升产出质量——它本来就该进 Skill 上下文。

`guidance` 进入 Fill Slot Context 的位置：紧跟 Slot Instruction 之后，标题为「本类型的写作要求」。

**与语义审核的关系（后续修订）**

Slot Review 提前进入 P0 之后，`guidance` 里的部分条目**可能**被语义审核检出违反——
例如「首段需衔接前一场景的结尾状态」正对应审核判据一，实测召回 3/3。

这**不改变**本节的三分结构，反而给它补上了中间的一档：

| 类别 | 谁来判 | 违反的后果 |
|---|---|---|
| `validation` | 代码，确定性 | 提交被拒，内容不落库，计入重试 |
| **语义审核判据** | **模型，非确定性** | **内容已落库，走返修；检不出则放行** |
| `guidance` 的其余部分 | 无人强制 | 仅注入上下文，影响产出但不校验 |

**UI 上三者必须仍然可区分**，且中间一档的标签**不得**做成对勾。
理由与本节原文一致：审核判据的检出能力因判据而异，实测中有判据长期检不出任何问题
（REQ FR-REVIEW-004）。把它显示成「系统校验」是同一种承诺欺骗，只是换了个位置。

建议标签：`validation` →「系统校验」；审核判据 →「**审核会看**」；
`guidance` →「写作要求」。中间一档的措辞刻意不承诺结果。

**`forbidPattern` 的安全约束**（🟢）：正则由模板作者编写，属于可信输入，但仍需防御 ReDoS。实现时用 `RegExp` 构造后，校验执行加 50ms 超时保护（`node:vm` 或简单的长度预检 + 复杂度启发式）。P0 采用最简方案：**模式串长度上限 200 字符，且在模板编译期用一组固定的对抗样本试跑，超时则拒绝加载模板**。

---

### D-06 🟢 槽位类型级的模型 / 超时 / 重试覆盖

**缺口来源**

`模板详情.dc.html` 的每个内容槽位显示三列：

```js
model: "claude-sonnet", timeout: "180 秒", retry: "1 次"
```

而且不同槽位取值不同——`chapter_outline` 是 90 秒 / 2 次，`scene_*` 是 180 秒 / 1 次。

REQ 的 `AgentDefinition` 只有全局 `provider`/`model`，`TemplateLimits` 只有全局 `executionTimeoutMs`/`maxExecutionRetries`。没有槽位类型级覆盖。

**决议**

`OperationBinding` 支持可选覆盖，四级回退：

```
binding.modelAlias  →  agent.model  →  (无)              必须能解析出值，否则模板校验失败
binding.timeoutMs   →  limits.executionTimeoutMs  →  providers.yaml defaults.timeoutMs
binding.maxRetries  →  limits.maxExecutionRetries →  providers.yaml defaults.maxRetries
```

解析在**模板编译期**完成，`CompiledTemplate` 中每个 binding 都持有解析后的完整三元组（`modelAlias` / `timeoutMs` / `maxRetries` 均为必填），运行时不再回退。

理由：把回退逻辑放在编译期，运行时读到的就是确定值——这符合 REQ NFR-006 确定性要求，也让模板详情页能直接展示最终生效值而不需要前端重算回退链。

`chapter_outline` 需要 2 次重试而 `scene_*` 只要 1 次，这个差异是合理的：结构化 JSON 输出比散文更容易违反格式约束。这条需求应当支持。

---

### D-07 🟢 业务化状态投影是后端职责，实现为 Domain 纯函数

**来源**

HANDOFF README 明确要求：

> `tone` 是语气分类（run / ok / wait / warn / fail / stop / idle），驱动前端取色，与状态机值解耦。**后端应显式返回，不要让前端从状态字符串猜。**
> `state` 是业务化描述文字（「正在填充 Slot」），不是状态机枚举。
> `detail` 是可判断的业务事实（「第 3 章 · scene_2 场景正文生成中」），不是日志行。

UX §10.3 也给出了槽位状态的派生表（pending + 依赖未完成 → 「等待依赖」；pending + 依赖已完成 → 「可生产」）。

`组件状态变体.dc.html` 的 `SLOT_STATES` 给出了权威的 8 态词表及其子行文案风格——注意子行的要求：

> 「等待依赖」子行必须点名在等谁，否则用户无从判断要不要干预。
> 「已完成」子行给出可核对的产物事实，不写「成功」这类空话。

**决议**

实现两个 **Domain 层纯函数**，位于 `domain/presentation.ts`：

```ts
deriveTaskPresentation(input: TaskPresentationInput): TaskPresentation
deriveSlotPresentation(input: SlotPresentationInput): SlotPresentation
```

放在 Domain 层而非 API 层的理由：这是纯函数，无 IO，且**它的正确性需要单元测试覆盖全部状态组合**——8 种槽位态 × 依赖状态 × 是否为当前执行槽位。放在 API 层会诱使实现者直接在 DTO mapper 里写 if-else，失去测试覆盖。

文案（中文字符串）内联在这两个函数里，不做 i18n 抽象（P0 单语言，抽象是浪费）。

完整派生规则见 §附录 B。

---

### D-08 🟡 模板状态与统计字段

**缺口来源**

`模板列表.dc.html` 展示了 `state: "已发布" | "草稿" | "已归档"` 和 `runs: 41`（已跑任务数），`模板详情.dc.html` 有「版本历史」「引用任务」两个 Tab。

REQ 的 `TemplateDefinition` 无 `status` 字段，API 无对应端点。

**决议**

| 字段/功能 | 决议 | 实现方式 |
|---|---|---|
| 模板状态 | ✅ P0 实现 | `template.yaml` 增加 `status: published \| draft \| archived`。`draft` 与 `archived` 不可用于创建新任务，但**不可硬删**（历史任务引用其快照） |
| 已跑任务计数 `runs` | ✅ P0 实现 | `SELECT COUNT(*) FROM tasks t JOIN task_snapshots s ON s.task_id=t.id WHERE s.template_id=?` |
| 「引用任务」Tab | ✅ P0 实现 | 同上查询的列表形式，复用任务列表行组件 |
| 「版本历史」Tab | ❌ P0 不实现 | 需要模板版本仓库，是独立课题。Tab 保留，渲染空态：「版本历史将在后续版本提供」 |
| 产出类型 `type` 筛选 | ✅ P0 实现 | `template.yaml` 增加 `presentation.outputKind: string`，自由文本，前端据此聚合筛选 chip |

---

### D-09 🟢 Assignment 不建独立表

概念文档 §7.1 已留口子：「P0 不要求必须建立独立的 Assignment 数据表」。

**决议：不建表。** Assignment 在运行期是一个内存对象，其全部持久化内容由 `executions` 表承载（`operation` / `target_slot_id` / `agent_id` / `skill_id` / `skill_version` / `context_json` / `context_hash` / `token_hash` / `provider` / `model` / `attempt_number`）。

`AgentAssignment.id` 直接使用 `execution.id`，不再单独生成。UX §13.5「技术详情」要求同时展示 Execution ID 与 Assignment ID——两者相同时前端只展示一行（🔴 微调）。

---

### D-10 🟢 Execution Token 校验必须与写入同事务、同语句

这是整个可靠性设计中**最容易写错**的一处，单列一条决议。

REQ FR-LIFE-002 要求已取消/超时/停止的 Execution 返回结果时不得写入。TECH-V0.1 §6.11 列出了校验清单，但没有规定校验与写入的时序关系。

**朴素实现（错误）**：

```ts
const exec = await execRepo.get(executionId);       // ① 读
if (exec.status !== 'running') throw STALE;          // ② 判
await slotRepo.commit(slotId, content);              // ③ 写
```

①②③ 之间存在窗口。虽然 P0 是单进程，但 Node 的异步调度使得「stop 请求的事务」完全可能插在②和③之间执行。

**决议**：校验条件下推为 UPDATE 语句的 WHERE 子句，用受影响行数判断成败。

```sql
UPDATE slots SET
  content_text = ?, status = 'completed',
  producer_agent_id = ?, producer_skill_id = ?,
  producer_skill_version = ?, producer_execution_id = ?,
  updated_at = ?
WHERE task_id = ? AND slot_id = ? AND status = 'running'
  AND EXISTS (
    SELECT 1 FROM executions e
    JOIN tasks t ON t.id = e.task_id
    WHERE e.id = ? AND e.token_hash = ?
      AND e.status = 'running'
      AND e.task_id = slots.task_id          -- D-19 补，见下
      AND e.target_slot_id = slots.slot_id
      AND t.active_execution_id = e.id
      AND t.status = 'running'
  );
```

**`e.task_id = slots.task_id` 是 D-19 补上的**，原 SQL 缺这一行。缺了它，
子查询只把 execution 的 `target_slot_id` 与外层行的 `slot_id` 对齐，而 `slot_id`
**只在任务内唯一**（`slots` 的主键是复合键 `(task_id, slot_id)`）。于是任务 A 上一个
合法在跑的 execution，可以提交任务 B 里同名的 `scene_01`——只要调用方把 taskId 传成 B。
今天调用方是我们自己的代码，看起来够不着；但 D-10 这条语句的全部意义正是
「不依赖调用方传对参数」，留着这个缺口等于在自证机制里开了一个后门。

`changes !== 1` → 抛 `EXECUTION_STALE`，记 `late_result_rejected` trace，不修改任何状态。

配合 `better-sqlite3` 的同步 API，整个 `db.transaction(() => {...})` 块内不存在 await 点，物理上杜绝了交错。**这是选择 better-sqlite3 同步驱动的核心理由**，不是性能考虑。

---

### D-11 🟢 提交边界用显式闸门封锁，不依赖模型自觉

REQ §12.3 规定 Agent 只能通过一个正式写动作提交。TECH-V0.1 §6.10 描述了提交后「Runtime 不再接受其他工具调用」。

**决议**：实现 `SubmissionGate` 对象，按 Assignment 创建，被所有工具闭包捕获：

```ts
class SubmissionGate {
  private closed = false;
  assertOpen(toolName: string): void {
    if (this.closed) {
      throw new ForgeError('TOOL_NOT_ALLOWED',
        `本次 Assignment 已提交，${toolName} 不再可用`);
    }
  }
  close(): void { this.closed = true; }
}
```

每个工具 handler 第一行调用 `gate.assertOpen(name)`。`complete_assignment` 成功后立即 `gate.close()` 并 `abortController.abort()`。

后续到达的 text delta 一律丢弃（不写 trace，不推 SSE）。后续到达的 tool call 返回 `TOOL_NOT_ALLOWED` 错误结果——**不抛异常中断循环**，因为 Provider 可能在同一批 response 中并发发出多个 tool call，需要让它们各自拿到错误结果后自然收敛。

> **实现陷阱（D-18 补）**：上面的 `assertOpen` 是 `throw`，而本决议要求
> `TOOL_NOT_ALLOWED` 表现为**工具结果**而非异常。两者不矛盾，但衔接处必须写对：
> **工具分发器负责捕获**——每个工具调用都包在 try/catch 里，
> 捕到 `ForgeError` 就转成该次 tool call 的错误结果字符串返回给模型，循环继续。
> 只有非 `ForgeError` 才允许向上冒泡。
>
> 如果漏了这个 catch，`TOOL_NOT_ALLOWED` 会一路冒泡到 Fastify 的 `setErrorHandler`，
> 变成一个**用户可见的 HTTP 错误**——而附录 A 明确标注它「非用户可见」。
> 这条链路的兜底见 §9.3 的 `INTERNAL_ONLY_ERROR_CODES` 检查：
> 兜底只保证不泄露，不能替你把语义修对，真正的修复点在工具分发器。

---

### D-12 🟢 `contextHash` 哈希结构化输入，与 `promptHash` 分离

TECH-V0.1 §6.7 的 `BuiltAssignmentContext` 同时包含 `systemText` / `userText` / `canonicalJson` / `contextHash`，未说明 hash 的输入是哪个。

**决议**：

```ts
contextHash = sha256(canonicalJson(structuredContextInput))   // 语义输入
promptHash  = sha256(systemText + '\n\n' + userText)          // 渲染结果
```

`contextHash` 只覆盖语义输入（snapshotHash、taskInput 字段值、targetSlotId、slot instruction、依赖槽位内容及其顺序、skill id+version+注入的 section id 列表、validation 限制）。

理由：REQ NFR-004 要求上下文可重建，FR-CTX-006 要求 hash 用于「判断上下文是否发生非预期变化」。若把渲染文本纳入 hash，那么调整一个 prompt 模板的换行就会让所有历史 hash 失配，这个信号就失去了诊断价值。两者分开记录，`contextHash` 回答「喂进去的信息变了吗」，`promptHash` 回答「怎么组织的变了吗」。

两者都写入 `executions` 表（新增 `prompt_hash` 列）并在 UX §13.5 技术详情中展示。

---

### D-13 🟢 结构校验失败反馈必须结构化且可执行

REQ FR-STR-006 允许重试时附带「上一次结构提案 + 确定性校验错误列表」，但没定义错误列表的形态。

这是**决定产品成败的一处细节**：`maxExecutionRetries` 默认 2，意味着 Structure Agent 总共只有 3 次机会满足 19 条校验。反馈质量直接决定通过率。

**决议**：校验违规使用三段式结构：

```ts
interface StructureViolation {
  rule: StructureRuleId;    // 机器可读，用于统计与测试断言
  message: string;          // 给人看：「slot「scene_2」的 parentId「chapter_x」不存在」
  agentHint: string;        // 给 Agent 看：可执行的修复指令
  slotIds: string[];        // 涉及的槽位，便于 UI 高亮
}
```

`agentHint` 的书写标准（写进代码注释与 review checklist）：

- ❌ 「依赖关系不合法」——不可执行
- ❌ 「请修正 dependsOn」——没说怎么改
- ✅ 「slot「scene_2」的 dependsOn 引用了「chapter」，但 chapter 是容器槽位。dependsOn 只能引用 contentBearing 为 true 的槽位。请改为引用具体的内容槽位，或删除该依赖。」

重试时的 User Message 追加块格式见 §7.4。

**M4 里程碑必须产出一个数字：结构提案首次通过率。** 低于 80% 则不进入 M5，回头改 Skill 文本与 `agentHint`。

---

### D-14 🟢 全局串行用显式互斥，不靠调用约定

REQ NFR-001 要求全局最多一个 Assignment。TECH-V0.1 §6.12 的 `tick()` 只检查 `task.activeExecutionId !== null`——这是**任务级**互斥，不是全局互斥。两个不同 Task 同时 start 会同时进入 Provider 调用。

而 §12 错误码表里已经有 `ENGINE_BUSY`，说明设计上预期到了这件事。

**决议**：`ProductionEngine` 持有一个进程级的单槽互斥 + FIFO 队列：

```ts
class ProductionEngine {
  private runningTaskId: string | null = null;
  private queue: string[] = [];              // 待调度 taskId，去重
  enqueue(taskId: string): void
  private async drain(): Promise<void>       // 串行消费，直到队列空
}
```

`POST /api/tasks/:id/start` 在别的任务运行时**不返回 `ENGINE_BUSY`**，而是入队并返回 `{ queued: true, position: n }`，任务状态置为 `running`，UI 展示「排队中（前面还有 n 个任务）」。

理由：直接拒绝会让用户必须手动轮询重试，体验很差。而队列在单进程内是 10 行代码。`ENGINE_BUSY` 错误码保留，用于队列长度超过上限（默认 50）的情况。

🔴 UI 需要新增一个「排队中」态——归入 `tone: 'wait'`，`state: '排队中'`，`detail: '前面还有 2 个任务'`。这是 `组件状态变体.dc.html` 现有 9 态之外的第 10 态。

---

### D-15 🟢 工程与依赖基线

| 决策项 | 选择 | 理由 |
|---|---|---|
| 包结构 | 单包，`src/server` + `src/client` + `src/shared` | 无需 monorepo 工具链；`shared` 通过 tsconfig path alias 双向可见 |
| 校验库 | **Zod**（不用 TypeBox） | HTTP schema、Agent 工具参数、template.yaml 解析、Provider 输出解析——四处都要校验。一套词汇表胜过两套。配 `fastify-type-provider-zod` |
| 测试 | **Vitest** | 前后端同一 runner；原生 ESM/TS；`vitest --coverage` 开箱可用 |
| SQLite 驱动 | **better-sqlite3** | 同步 API 是 D-10 的前提，非性能考虑 |
| HTTP | Fastify | 沿用 TECH-V0.1 |
| 前端 | React 18 + Vite + TanStack Router + TanStack Query | Router 用于类型安全路由；Query 承担查询缓存与 SSE 后的 invalidate |
| 前端状态 | 无全局状态库 | 服务端是权威源；本地 UI 状态用 `useState` + 少量 context（分栏宽度、跟随开关） |
| 样式 | 原生 CSS + 设计系统令牌 | HANDOFF 的 `_ds/.../styles.css` 直接引入；不引 Tailwind（令牌已成体系，再套一层是噪音） |
| Markdown 渲染 | `markdown-it` + `DOMPurify` | 满足 TECH-V0.1 §13「禁止原始 HTML 或经过严格 Sanitizer」 |
| ID 生成 | `crypto.randomUUID()` | 无需额外依赖 |
| 时间 | ISO-8601 UTC 字符串存储，前端本地化 | 全库统一，避免时区错乱 |

**不引入**：ORM、状态机库（xstate）、依赖注入容器、Tailwind、Redux/Zustand、日志框架（用 `pino`，Fastify 自带）。

---

### D-16 🟡 支持「产出内容但不进最终产物」的槽位

**缺口来源**

`模板详情.dc.html` 的 `chapter_outline` 槽位标注为：

> 本章骨架：三个场景各自的目标、冲突与出场人物。后续场景槽位都读它，**不进最终正文**。

其 `children` 条目的 note 同样写着「不进正文，仅作上下文」。

而 REQ 的槽位模型只有两类：

| | contentBearing | 有 Agent/Skill | 进入 Artifact |
|---|---|---|---|
| 容器槽位 | false | ❌ | ❌ |
| 内容承载槽位 | true | ✅ | ✅ |

`chapter_outline` 需要的是第三种：**有 Agent/Skill、产出内容、供下游 `read_slot` 读取，但不进入组装**。当前的 `markdown_concat_v1` 会把它拼进 `chapter.md`，产出一份开头带着场景规划表的成品——错误产物。

**决议：支持。** `SlotTypeDefinition` 增加可选字段：

```ts
interface SlotTypeDefinition {
  id: string;
  name: string;
  description: string;
  contentBearing: boolean;
  /** 是否进入最终产物。仅对 contentBearing=true 有意义，默认 true */
  includeInArtifact?: boolean;
  validation?: SlotValidation;
  guidance?: string[];
}
```

**语义三分**（替代原来的二分）：

| 类型 | contentBearing | includeInArtifact | 有 Assignment | 进 Artifact | 可被 dependsOn |
|---|---|---|---|---|---|
| 容器槽位 | false | true（默认） | ❌ | 子树进 | ❌ |
| 内容槽位 | true | true（默认） | ✅ | ✅ | ✅ |
| **工作槽位** | true | **false** | ✅ | ❌ | ✅ |

**`includeInArtifact` 的作用域是子树，不是单个节点（D-18 修订）。**

原文写的是「仅对 `contentBearing=true` 有意义」，这在 DTO 层不可表达：
容器槽位该返回什么值？前后端各填各的就会漂移。改为统一语义：

> `includeInArtifact = false` 表示**以该槽位为根的整棵子树不进入产物**。

对叶子内容槽位，这与「本节点不进产物」完全等价，工作槽位的行为不变。
对容器槽位，它变成一个有用的能力：整节工作区（比如一个装着人物卡、
时间线、场景规划的 `working_notes` 容器）一次性排除，不必逐个子槽位标注。

这个定义还让 `assembly.ts` **更简单**而不是更复杂——递归函数遇到
`includeInArtifact === false` 直接返回空，不需要区分叶子和容器：

```ts
function collect(slot: Slot): string[] {
  if (!slot.includeInArtifact) return [];        // 子树整体跳过
  if (!slot.contentBearing) return childrenOf(slot).flatMap(collect);
  return slot.contentText ? [slot.contentText] : [];
}
```

因此**所有槽位（含容器）的 `includeInArtifact` 默认都是 `true`**，
DDL 的 `DEFAULT 1` 与之一致。注意默认值不能反过来设——
容器默认 `false` 会让整棵树都装配不出东西。

「工作槽位」（working slot）是本文档引入的术语，指大纲、场景规划、人物卡这类**为下游生产服务、但不属于交付物**的中间产出。

**权威来源只有一处：模板的 `SlotTypeDefinition`（D-19 澄清）。**

D-18 的子树语义容易被读成「每个槽位可以各自决定进不进产物」，
从而推出「`SlotProposalSchema` 缺了 `includeInArtifact` 字段」的结论。**不是。**

- **Agent 不得声明这个字段。** 「我的产出算不算交付物」是流程控制，属于 System；
  Agent 只负责生产内容（核心边界）。给 Structure Agent 一个能把自己
  从产物里摘出去的开关，等于把交付范围的决定权交给模型。
- **`slots.include_in_artifact` 列不是独立的编辑点**，而是结构提交时
  从该槽位的 `type` 在冻结快照里解析出来的**物化投影**
  （`validateConcreteStructure` 的产物 `ValidatedSlot` 已包含它）。
  物化的理由是 `assembly.ts` / `presentation.ts` 都不该为了读一个布尔值
  而随身携带整个 `CompiledTemplate`。
- 因此 D-18 举的「一次性排除整节 `working_notes` 工作区」，
  做法是**给那个容器槽位用一个 `includeInArtifact: false` 的槽位类型**，
  而不是在提案里逐槽位打标。模板作者控制，Agent 不控制。

**影响面（改动量很小，但要改全）**

1. `assembly.ts`：遍历时跳过 `includeInArtifact === false`
2. `readiness.ts`：**不变**——工作槽位仍需被调度、仍计入「全部内容槽位已完成」的判定
3. `structure-validation.ts`：**不变**——`dependsOn` 仍可引用工作槽位（它是 contentBearing=true）
4. `presentation.ts`：工作槽位的 detail 加后缀标识，如 `860 字 · 不进正文`
5. DTO：`SlotViewSchema` 增加 `includeInArtifact: boolean`
6. 前端槽位树：工作槽位用**虚线圆点**与内容槽位区分（🔴 附录 C 新增 C-13）
7. 组装顺序展示：工作槽位不出现在组装列表中

**为什么不用「容器槽位 + 特殊标记」实现**：容器槽位没有 Assignment，而 outline 需要 Agent 用 Skill 产出内容。两者本质不同，合并会污染容器槽位的语义（README 明确要求「容器槽位不伪造数据：不显示 Producer、不显示执行轨迹、不显示耗时」）。

**AC-013 的确定性不受影响**：`includeInArtifact` 来自冻结快照，同一任务多次组装结果一致。

---

### D-17 🟡 Provider 定案：DeepSeek（OpenAI 兼容）

**来源**：现有 ForgeCore 的 `.env.example` 中只有 `DEEPSEEK_API_KEY`。经确认，vNext 沿用 DeepSeek。

**决议**

1. **`openai-compatible.ts` 是 P0 唯一必需的 adapter**，M4 优先且只实现它。`anthropic.ts` 降级为「接口预留，暂不实现」——`ProviderAdapter` 接口保持不变，未来接入只是新增一个文件。
2. `providers.yaml` 的 provider 与别名以 DeepSeek 为准（见 §4.2 修订）。
3. `.env` 只需 `DEEPSEEK_API_KEY`。

**必须正视的风险：结构生成的 tool call 可靠性**

本系统的结构创建步骤要求模型在**一次 tool call 中**产出一棵完整槽位树——含 10~30 个对象，每个带 `id` / `type` / `parentId` / `order` / `instruction` / `dependsOn` 数组，且要同时满足 19 条校验。这是对结构化输出能力要求很高的任务。

DeepSeek 支持 function calling，但在这种**长、深、带交叉引用**的结构化 tool call 上，稳定性历史上弱于第一梯队模型。M4 的「首次通过率 ≥ 80%」目标存在达不到的实际可能。

**分级缓解方案**（M4 按序尝试，不要一上来就用重手段）：

| 级别 | 手段 | 代价 |
|---|---|---|
| L1 | 优化 `agentHint` 与 Output Contract 示例（D-13） | 零，本来就要做 |
| L2 | 精简结构复杂度：降低 `maxSlots`、要求扁平结构（depth ≤ 2） | 牺牲结构表达力 |
| L3 | `createStructure` 绑定切到 DeepSeek 的更强模型（**`deepseek-v4-pro`**），走 D-06 的槽位级 `modelAlias` 覆盖 | 结构步骤变慢、变贵 |
| L4 | 结构提交改为**文本 JSON 输出 + 解析**，不走 tool call | 需在 Runtime 增加一条提交路径，违反「单一写入动作」的整洁性，**仅在 L1–L3 全部失败时启用** |

**L4 是设计上的让步，启用前必须记录理由。** 它的实现方式是：`complete_assignment` 仍是唯一提交动作，但允许 Runtime 在检测到模型输出了完整 JSON 代码块而未发起 tool call 时，**代模型发起一次等价的 tool call**（并在 trace 中标注 `synthesized: true`）。这样提交边界、Token 校验、原子事务全部不变，只是入口多了一条。

**M4 必须记录实际测得的通过率**，无论达标与否——这个数字是后续所有 Skill 调优的基线。

**L3 原写「如推理型号」，实测必须改掉（M4 补正）**

M4 接上真实链路时查了一次模型目录，DeepSeek 现在的 `/v1/models` 只有
`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp` 三个。
旧名 `deepseek-chat` 与 `deepseek-reasoner` 仍然可用，但**两者都解析到同一个
`deepseek-v4-flash`**（实测：请求 `deepseek-reasoner`，响应里的 `model` 字段回的是
`deepseek-v4-flash`）。

也就是说，L3 若按字面执行——「把 `structure` 别名切到 `deepseek-reasoner`」——
**换来的是同一个模型，通过率一点不会变**，而且不会有任何报错提示这次调整是空操作。
一个看起来生效、实际什么都没做的缓解手段，比没有这个手段更糟：
它会让人误以为 L3 试过了、该往 L4 走了。

因此 L3 的目标模型明确为 `deepseek-v4-pro`，并已加入 `providers.yaml` 的 `models` 列表
（别名解析在加载期就校验模型是否在列表里，不加进去 L3 根本配不出来）。

**新增第二个 Provider：OpenCode Zen（业务方要求，D-17 补正）**

原文第 2、3 条写的是「`providers.yaml` 的 provider 与别名以 DeepSeek 为准」
「`.env` 只需 `DEEPSEEK_API_KEY`」。业务方要求接入 **OpenCode Zen**
（一个聚合网关）走它上面的 `deepseek-v4-flash`，理由是该套餐额度更充裕，
DeepSeek 官方 Key 留作备用。

**为什么这不是「换一个 provider」那么简单——接入前必须过两道闸**：

1. **端点形状。** OpenCode Zen 按模型家族分路：
   GPT/Grok 走 `/v1/responses`、Claude/Qwen 走 `/v1/messages`、
   Gemini 走 `/v1/models/gemini-*`，只有 **DeepSeek/Kimi/GLM/MiniMax 走
   `/v1/chat/completions`**。而本项目的 `openai-compatible` 适配器
   写死打 `${baseUrl}/chat/completions`（`openai-compatible.ts:121`），
   `anthropic` 那种 P0 未实现。
   **因此 Zen 上只有 chat/completions 那一族能用**，选 Claude/GPT 等于要写新适配器。
2. **工具调用 + 流式。** 引擎的整个循环建立在 tool call 上
   （`report_work` / `complete_assignment`）。不支持 tools 的模型会卡在
   `no_submission` 重试里——现象是「模型说了很多话但任务不动」。

`deepseek-v4-flash` 两道都过（同族、支持 tools），因此是 Zen 上的正确选择。

**实测结论（接入当日）：该 Key 余额不足，暂不可用。**

```
GET  /v1/models           → 200   认证有效，返回 64 个模型（含 deepseek-v4-flash）
POST /v1/chat/completions → 401   {"type":"CreditsError","message":"Insufficient balance"}
deepseek-v4-flash-free    → 上游 "Model is unavailable"
```

因此本次**只加 provider 条目，别名不动**（仍指向 DeepSeek 官方）。
把别名切到一个证实无法完成任何一次请求的 provider，
结果是每个任务都在第一次模型调用时失败，
而现场看起来像是「配置写错了」——排查成本远高于不切。

**顺带确认了一件本该确认的事**：余额不足返回的是 **HTTP 401** 而不是 200，
因此 `probe`（一次真实的 1-token `/chat/completions`）会如实报 `down`，
不会出现「Provider 设置页显示正常但任务全失败」的假绿。
这正是 `probe` 坚持打真实端点、而不是打 `/v1/models` 的价值所在——
`/v1/models` 在余额为 0 时**照样回 200**。

**充值后切换的动作**（三行，`config/providers.yaml`）：
把 `main` / `configured` / `structure` 三个别名的 `provider` 从 `deepseek`
改成 `opencode-zen`、`model` 改成 `deepseek-v4-flash`。
DeepSeek 官方条目原样保留，随时切回。

模板不需要任何改动——它们引用的是**别名**。
而且任务快照冻结的也是别名（D-03 晚绑定），
所以切换**不会改写历史任务的记录**，它们仍忠实记着当时那次解析的结果。

### D-18 🟢 循环引用用延迟外键解决，不用放弃外键解决

**背景（M0 实施时发现）**：§5.2 的原始 DDL 里有三处引用**没有外键约束**：
`task_snapshots.task_id`、`tasks.active_execution_id`、`slots.producer_execution_id`。
原因是这三处都构成循环引用（tasks ↔ task_snapshots、tasks ↔ executions），
写成立即外键就会让「先插哪个」变成死结。

**问题**：D-10 把 Execution Token 的全部校验压进了一条 UPDATE 的 WHERE 子句，
而那条子句的正确性直接建立在 `t.active_execution_id = e.id` 之上。
库层不保证这个引用有效、只靠应用层自觉，等于把 D-10 的安全性从
**约束**降级成**约定**——这是整个系统里最不该靠约定的一处。

**决议**：三处全部加 `DEFERRABLE INITIALLY DEFERRED` 外键。
SQLite 的延迟外键在 COMMIT 时才校验，事务内的插入顺序因此不再是约束，
死结消失，完整性拿回来。

**实施陷阱**：延迟外键在 `PRAGMA foreign_keys = OFF` 时**静默失效**，
不报错、不生效。§5.1 的 PRAGMA 设置因此不是性能调优，是正确性前提。
测试中必须有一条用例断言 `PRAGMA foreign_keys` 为 ON，
以及一条断言「提交悬空 `active_execution_id` 会在 COMMIT 时抛 FK 错误」。

**同批次的另外三项**（同样来自 M0 的 DDL 复核）：

| 项 | 内容 | 理由 |
|---|---|---|
| `executions` 唯一约束 | `UNIQUE (task_id, target_slot_id, attempt_number)` | §8.7 的 retry 与 D-06 的 `maxRetries` 都以 attempt_number 为准，库层不拒重复号就等于没有基准。注意 NULL 语义：结构创建 execution（`target_slot_id IS NULL`）不受保护 |
| `idx_executions_status` | `ON executions(status)` | §8.6 重启恢复要扫孤儿 execution，这是**启动路径上的必经查询**，全表扫意味着崩溃后恢复随历史线性变慢 |
| `trace_events.sequence` | 不改 schema，DDL 上方加注释约定 | 无库层生成机制，Repository 必须在**同一事务内** `SELECT MAX(sequence)+1`；`UNIQUE (task_id, sequence)` 是这条约定失守时的唯一兜底。这是留给 M2 的合同 |

---

### D-19 🟢 派生层只取用、不重建；规则表必须有兜底行

M1 实施附录 B 时暴露的一组同源问题，合并成一条决议。

**1. 「上次失败原因」不可重建 → 成文责任上移到 lifecycle。**
B.1 第 3/5 行与 B.2 第 5 行要显示「上次 {timeout} 秒超时」，
但派生函数手上的 `activeExecution` 是**当前**这次不是上一次，超时配置也不在签名里；
B.1 第 10 行要显示「首条违规的 message」，而 `StructureViolation[]` 同样不在签名里。
决议：**lifecycle 层写 `task.error_message` 时就写成可直接展示的完整中文**，
派生层只取用 `lastFailureReason` / `task.errorMessage`，不解析、不拼装。
理由：只有 lifecycle 同时持有 execution、超时配置和违规列表，
让派生层反推就要把这三样都塞进签名，而它们对其余 11 行毫无用处。

**2. 规则表必须有兜底行。** `TaskStatus × TaskPhase` 有 20 种组合，B.1 只覆盖了一部分。
派生函数跑在每次列表渲染上，一条脏数据不该把整页打成 500。已加 B.1 第 14 行。

**3. 死参数必须删。** `SlotPresentationInput.isActiveExecution` 没有任何一行规则读它。
留着谁都不读的输入，下一个人会以为它有意义并试图满足它。已删。
将来若真需要区分「running 但非当前活动执行」，**先加规则行、再加参数**，顺序不能反。

**4. 缺失的接线不许静默降级。** B.2 第 6 行的 `agentName` 不在 `Slot` 上
（`slot.producer` 在 running 期间恒为 `null`），必须由调用方从 execution 解析后传入。
写成可选参数、缺省退化为「Agent」是不可接受的——
那会把一个本该在调用方修复的接线缺失，变成一句看不出问题的界面文案。
定为**必填** `agentName: string | null`。

**5. 附带修订**：B.2 第 1 行的 n 口径定为**直接子槽位**；
工作槽位文案定为 `{charCount} 字 · 不进正文`（不叠加「校验通过」）；
§6.3 第 6/7 条的自相矛盾按「语义不改写、字节要归一化」重写；
空产物由 assembly-service 拒绝而非在 domain 里特判。

**6. `canonicalJson` 的边界行为**：bigint 抛 `TypeError`（静默丢弃会让 hash 悄悄失去区分度）、
非有限数转 `null`、不支持 `toJSON`、**循环引用必须抛可诊断的错误而不是栈溢出**。

**7. D-14 的隐含约定补写**：排队中与真正在跑共用 `status='running'`，靠 `queuePosition` 区分。
因此规定：**引擎实际开始执行某任务时，必须把它的 `queuePosition` 置为 `null`**，
否则 B.1 第 2 行会让任务永远显示「排队中」。

---

## 2. 工程骨架

### 2.1 目录结构

在 TECH-V0.1 §15 基础上调整（差异用 `←` 标注）：

```text
forge-core-vnext/
├── package.json
├── tsconfig.json                  # 根配置，paths: @shared/* @server/* @client/*
├── vite.config.ts
├── vitest.config.ts               ← 新增
├── .env.example                   ← 新增，只含 KEY 名不含值
│
├── config/                        ← 新增
│   └── providers.yaml             # D-03 Provider 定义与别名映射
│
├── migrations/
│   ├── 001_initial.sql
│   └── 002_indexes.sql
│
├── templates/
│   └── zhihu-chapter/
│       └── template.yaml
│
├── skills/
│   ├── chapter-structure-design/SKILL.md
│   ├── title-writing/SKILL.md
│   ├── opening-writing/SKILL.md
│   ├── scene-writing/SKILL.md
│   ├── emotional-closure-writing/SKILL.md
│   └── chapter-ending-writing/SKILL.md
│
├── src/
│   ├── shared/
│   │   ├── contracts.ts           # API DTO（Zod schema + 推导类型）
│   │   ├── trace.ts               # TraceEvent 契约与 kind 枚举
│   │   ├── tools.ts               # Agent 工具参数 schema
│   │   ├── errors.ts              # ForgeError + 错误码联合类型
│   │   └── presentation.ts        # Tone / 状态词表（前后端共享）
│   │
│   ├── server/
│   │   ├── config/                ← 新增（统一环境配置，见 §2.6）
│   │   │   └── env.ts             # 全系统唯一读 process.env 做【配置】的地方
│   │   │
│   │   ├── domain/                # 纯函数，零 IO
│   │   │   ├── template.ts
│   │   │   ├── structure-validation.ts
│   │   │   ├── readiness.ts
│   │   │   ├── assembly.ts
│   │   │   ├── state-machine.ts
│   │   │   ├── presentation.ts    ← D-07
│   │   │   └── canonical.ts       # canonical JSON + sha256
│   │   │
│   │   ├── application/
│   │   │   ├── template-catalog.ts
│   │   │   ├── template-loader.ts    ← 从 infrastructure 移来，见下方说明
│   │   │   ├── template-schema.ts    ← template.yaml 的 Zod 契约
│   │   │   ├── skill-loader.ts       ← 从 infrastructure 移来
│   │   │   ├── provider-config.ts    ← providers.yaml 的解析，见下方说明
│   │   │   ├── regex-budget.ts       ← forbidPattern 的时间预算闸门
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
│   │   │   ├── assignment-runner.ts
│   │   │   ├── agent-runtime.ts
│   │   │   ├── submission-gate.ts ← D-11
│   │   │   ├── skill-runtime.ts
│   │   │   ├── provider/
│   │   │   │   ├── provider-adapter.ts
│   │   │   │   ├── provider-registry.ts   ← D-03
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── openai-compatible.ts
│   │   │   │   └── fake.ts                # 测试用，见 §11.2
│   │   │   └── tools/
│   │   │       ├── index.ts       # buildToolset(assignment, gate)
│   │   │       ├── read-task-input.ts
│   │   │       ├── read-skill-section.ts
│   │   │       ├── read-structure-outline.ts
│   │   │       ├── read-slot.ts
│   │   │       ├── report-work.ts
│   │   │       └── complete-assignment.ts
│   │   │
│   │   ├── infrastructure/
│   │   │   ├── database/
│   │   │   │   ├── db.ts          # 连接 + pragma + 事务封装
│   │   │   │   ├── migrate.ts
│   │   │   │   └── repositories/
│   │   │   │       ├── task-repo.ts
│   │   │   │       ├── slot-repo.ts
│   │   │   │       ├── execution-repo.ts
│   │   │   │       ├── snapshot-repo.ts
│   │   │   │       ├── trace-repo.ts
│   │   │   │       ├── artifact-repo.ts
│   │   │   │       └── provider-health-repo.ts
│   │   │   ├── uow.ts             # Unit of Work，见 §5.4
│   │   │   └── sse-hub.ts
│   │   │
│   │   ├── api/
│   │   │   ├── server.ts
│   │   │   ├── error-mapper.ts
│   │   │   ├── dto/               ← 新增：领域对象 → DTO 投影
│   │   │   └── routes/
│   │   │       ├── templates.ts
│   │   │       ├── tasks.ts
│   │   │       ├── slots.ts
│   │   │       ├── executions.ts
│   │   │       ├── artifacts.ts
│   │   │       ├── providers.ts   ← D-03
│   │   │       └── stream.ts
│   │   │
│   │   ├── cli/                   ← 新增，见 §12 M4
│   │   │   ├── run-task.ts        # headless 跑任务
│   │   │   └── dump-trace.ts      # 导出 trace 供人工检查
│   │   │
│   │   └── main.ts
│   │
│   └── client/
│       ├── main.tsx
│       ├── router.tsx
│       ├── api/                   # fetch 封装 + SSE 客户端
│       ├── hooks/
│       ├── pages/
│       │   ├── task-list.tsx
│       │   ├── task-new.tsx
│       │   ├── task-workbench.tsx
│       │   ├── template-list.tsx
│       │   ├── template-detail.tsx
│       │   └── provider-settings.tsx
│       ├── components/
│       └── styles/
│           └── tokens.css         # 来自 HANDOFF/_ds/.../styles.css
│
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── e2e/
│
└── data/
    └── forge-core.sqlite
```

**`template-loader` / `skill-loader` 归 application 而非 infrastructure（M2-B 修订）**

原文把两个加载器画在 `infrastructure/` 下。改到 `application/` 的理由：

1. **它们是用例，不是适配器。** infrastructure 里的东西是「把某个外部系统包成本系统的接口」
   （SQLite、SSE 连接池）。而模板加载做的是**编译**：解析、交叉引用校验、
   D-06 回退链求解、算 `templateHash`——业务规则占了九成，读文件只占一成。
   放 infrastructure 会让「模板合不合法」这条规则散落在最不该放规则的一层。
2. **`template-catalog.ts` 本来就在 application**，而它必须依赖加载器。
   跨层依赖方向没问题（application → infrastructure 合法），但把一个用例
   拆成「目录在 application、加载在 infrastructure」两半只会让人两头找。
3. ESLint 的分层约束不受影响：application 允许文件 IO，禁的是 fastify / react / `@server/api/**`。

**`provider-config.ts` 归 application（新增）**

`config/providers.yaml` 的读取原文画在 `runtime/provider/provider-registry.ts` 里，
但**模板编译期就需要它**——D-06 回退链的最后一级是 `defaults.timeoutMs` /
`defaults.maxRetries`，没有它 `CompiledTemplate` 的必填字段填不满。
若让 template-loader 反向依赖 runtime，跑一次模板校验就得把整个 Provider 层拖起来。
因此拆成：**读文件 + Zod 解析在 `application/provider-config.ts`，
别名的晚绑定解析仍在 `ProviderRegistry`**，Registry 消费本模块的产物而不再自行 parse，
保证两处不会各解析出一份配置。

### 2.2 依赖清单

```jsonc
{
  "dependencies": {
    "fastify": "^5",
    "fastify-type-provider-zod": "^4",
    "zod": "^3",
    "better-sqlite3": "^11",
    "yaml": "^2",
    "markdown-it": "^14",
    "dompurify": "^3",
    "react": "^18",
    "react-dom": "^18",
    "@tanstack/react-router": "^1",
    "@tanstack/react-query": "^5"
  },
  "devDependencies": {
    "typescript": "^5",
    "vite": "^6",
    "vitest": "^2",
    "@vitejs/plugin-react": "^4",
    "@types/better-sqlite3": "^7",
    "@types/markdown-it": "^14",
    "tsx": "^4"
  }
}
```

**`@fastify/static` 已移除（Q-24 定案，业务方裁决）**

- **原文是什么**：上面这张依赖清单原本含 `"@fastify/static": "^8"`，隐含的部署形态是
  「后端顺带把 `dist/client` 发出去」的单端口方案。
- **为什么改**：业务方选择**前后端分离**——前端产物由静态托管（nginx / 任意静态服务）
  发出，后端只负责 `/api/*`。理由是后续要加的功能（CLI 操作方式、审核打回机制）
  会同时长在两侧，边界清晰比省一个进程更值钱。方向既定，这个依赖就是死的：
  M6/M7 复查时它已经**声明了却从未被 import**，留着只会让下一个人假设
  「静态托管已经有了」，直到上线那天才发现没有。
- **不改的代价**：一个永远不会被 import 的依赖，是「看起来生效、实际什么都没做」
  的典型（DEVLOG 经验 6）。判断方式只有一个：去掉它，看有没有区别——去掉之后
  `tsc` / `eslint` / 691 条测试全绿，没有任何区别，所以它确实是死的。
- **随之明确的边界**：见 §10.6。跨源部署所需的 CORS **P0 不做**，
  因为 §10.6 选定的托管形态在浏览器看来是同源的，根本不产生跨源请求。

Provider SDK **不作为依赖引入**。Anthropic 与 OpenAI-compatible 适配器都直接用 `fetch` 调 HTTP API。理由：我们只用到 messages + streaming + tools 三件事，SDK 带来的抽象（重试策略、自动分页、类型体操）与我们自己的超时/中止/重试语义会打架，而这些语义是 REQ 的硬要求（FR-AGT-003/004、FR-LIFE-001）。直接写 `fetch` + SSE 解析约 200 行/适配器，完全可控。

### 2.3 TypeScript 配置要点

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,     // 关键：强制处理数组越界
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2023",
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@server/*": ["./src/server/*"],
      "@client/*": ["./src/client/*"]
    }
  }
}
```

`noUncheckedIndexedAccess` 在处理槽位树遍历时会强制显式处理 undefined，避免深度优先遍历里的经典空指针。

### 2.4 分层依赖约束的机器化

REQ §29 规定 domain 不得依赖 Provider / HTTP / React / SQLite / 文件系统 / Agent SDK。**这条规则必须由工具强制，不能靠自觉。**

用 ESLint `no-restricted-imports` 按目录配置：

```js
// eslint.config.js 片段
{
  files: ['src/server/domain/**'],
  rules: { 'no-restricted-imports': ['error', {
    patterns: [
      'better-sqlite3', 'fastify', 'react', 'node:fs', 'node:http',
      '@server/infrastructure/*', '@server/runtime/*', '@server/api/*',
      '@server/application/*'
    ]
  }]}
},
{
  files: ['src/server/application/**'],
  rules: { 'no-restricted-imports': ['error', {
    patterns: ['fastify', 'react', '@server/api/*']
  }]}
}
```

CI 中 lint 失败即阻断。

### 2.6 统一环境配置（后补，业务方要求）

原文没有规定配置从哪读，实现里就长成了 **9 处各自 `process.env['X'] ?? 默认值`**，
而且默认值是抄过去的：`'./templates'` 出现 4 次、`3311` 出现 2 次。

**不改的代价**（这是提出改动的直接原因）：改一个默认值要改四处，
漏一处的表现是「`main.ts` 用新值、CLI 还用旧值」——两条路径连到不同的库或目录，
**没有任何报错**。这类错误不会让测试变红，只会让两条路径静默地不一致。

#### 唯一读取点

`src/server/config/env.ts` 是全系统唯一一处为**配置**读 `process.env` 的地方。
它用 Zod 解析并校验，失败即抛，由入口打印后退出（退出码 1）。
其余文件——包括 `db.ts`、`migrate.ts`、`api/server.ts`、`template-catalog.ts`、两个 CLI——
一律从入口接收**已解析好的配置对象**，不再自带默认值。

（`template-catalog.ts` 那处尤其值得记：它原本自己写了一份 `?? './templates'`，
注释还叮嘱「默认值与 `.env.example` 逐字对齐」——**那句叮嘱本身就是问题**。
靠人去对齐两份常量迟早对不齐，而且对不齐没有任何报错。）

**「唯一」是有边界的说法，剩下三处读 `process.env` 的地方是有意保留的**：

| 位置 | 读什么 | 为什么不收进来 |
|---|---|---|
| `provider-registry.ts` | `process.env[apiKeyEnv]` | **凭据**，见下一节。刻意不与配置合并 |
| `dev-fake.ts` | `FAKE_SCENARIO` / `FAKE_TEMPLATE` | 仅 dev-fake 的脚本开关，不是服务配置；收进 `ServerConfig` 会让生产配置里多两个永远用不到的字段 |
| `dev-fake.ts` / `run-task.ts` | `fakeEnv(providers, process.env)` | 是**透传**不是读取：给假 Provider 补一个假 Key，保证它绝不出网 |

写清楚比含糊地说「唯一」好：下一个人 grep 到这三处时，
能立刻判断它们是例外还是漏网，而不用重新推一遍。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3311` / `127.0.0.1` | |
| `DATABASE_PATH` | `./data/forge-core.sqlite` | `dev-fake` 默认改为 `./data/dev-fake.sqlite` |
| `TEMPLATES_DIR` / `SKILLS_DIR` | `./templates` / `./skills` | |
| `LOG_LEVEL` | `info` | 枚举，拼错在启动时报错而非静默降级 |
| `NODE_ENV` | `development` | |

两条刻意的行为：

1. **空串按「未设置」处理。** `.env` 从 `.env.example` 复制过来常常只填了一部分，
   留下的是 `PORT=` 而不是没有这一行。若把空串当值，用户看到的是
   「端口 0 非法」——报错指向了一个他没做过的动作。
2. **配置错误拒绝启动，且一次报全部问题**，并指名是哪一项、去哪改（`.env`）。
   与「迁移跑不完不启动」「`providers.yaml` 读不出来不启动」同一条纪律。

#### 配置与凭据刻意不合并（REQ §13）

`env.ts` 只管配置，**不读、不碰、不返回任何 API Key**。
凭据仍然只由 `ProviderRegistry` 读（那里是全系统唯一读 `process.env[apiKeyEnv]` 的地方）。

理由：配置对象会被打日志、会被 `JSON.stringify`、会随依赖图传遍全系统。
一旦它开始携带 key，前面架的四道网就都绕过去了。
`env.test.ts` 里有一条断言专门守这个——将来有人往 `ServerConfig` 里加 `apiKey` 会立刻变红。

#### `.env` 与 `providers.yaml` 的分工

| | 放什么 | 进 git |
|---|---|---|
| `.env` | **值**：端口、库路径、目录、API Key | ❌ |
| `config/providers.yaml` | **结构**：provider 列表、baseUrl、模型、别名、超时 | ✅ |

不把 provider 信息也塞进 `.env` 的两个理由：
别名映射是嵌套结构，平铺成环境变量会变成 `PROVIDER_0_ALIAS_2_MODEL` 这种东西；
而且 provider 拓扑的变更**应该经过 code review**，凭据不应该。
实际维护成本已经很低：**换 Key = 改 `.env` 一行**；
加一个 Provider = `providers.yaml` 加一块 + `.env` 加一行。

#### 凭据缺失仍然不阻止启动，但必须喊出来

§7.2 明定「环境变量缺失 → `down` + 明确 note，**但不阻止服务启动**」，这条保留不变
（服务起不来就没法浏览历史任务，而浏览历史不需要凭据）。

补的是**可见性**：此前的真实现象是「`npm run dev:server` 不加载 `.env` →
服务照常起来 → `/api/health` 还是绿的 → 任务一跑才失败」，
而唯一说明原因的地方是 Provider 设置页，你得先想到去看那一页。
现在启动时直接打出配置横幅与缺失的变量名（只打**名**，不打值）。

同时 `dev:server` / `dev:fake` / `migrate` 三个脚本都加了 `--env-file-if-exists=.env`。
用 `-if-exists` 变体是因为新克隆还没有 `.env`——用 `--env-file` 会让 Node 抛一句
与本项目无关的报错，而 `-if-exists` 会让它落到我们自己的默认值与校验上。

---

## 3. 契约层

`src/shared/` 下的文件是前后端唯一共享真相。所有类型用 Zod schema 定义后推导，不手写 interface——保证运行时校验与编译期类型永不漂移。

**这条规则的边界（D-18 澄清）**：原文写成了无条件的「不手写 interface」，
但文档自己在 §3.2（`PublicError`）、§6.1（`StructureViolation`）、
D-16（`SlotTypeDefinition`）里都用了手写 interface，规则与示例互相打脸。
真正的判据不是「在哪个目录」，而是**这个类型会不会从不可信输入被解析出来**：

| 类型的来源 | 用 Zod | 理由 |
|---|---|---|
| HTTP 请求体 / 查询参数 | ✅ 必须 | 外部输入 |
| Agent 工具调用参数 | ✅ 必须 | 模型输出即不可信输入 |
| `template.yaml` / `SKILL.md` / `providers.yaml` | ✅ 必须 | 文件内容可被手改 |
| Provider 响应体 | ✅ 必须 | 外部系统 |
| API 响应 DTO | ✅ 必须 | 前端要按同一 schema 校验 |
| Domain 层内部结构（`StructureViolation` 等） | ❌ 不必 | 由自己的纯函数构造，永不被 parse，加 Zod 只是徒增运行时开销与噪音 |

一句话：**凡是跨进程边界的，一律 Zod；进程内自己造自己用的，普通 TS 类型即可。**
`src/shared/` 里的东西按定义全部跨边界，所以在那个目录里规则退化为「全都用 Zod」，
原文的表述在 `src/shared/` 范围内仍然成立。

### 3.1 基础词表 `shared/presentation.ts`

```ts
import { z } from 'zod';

/** 语气分类：驱动前端取色，与状态机值解耦（HANDOFF README 约定） */
export const ToneSchema = z.enum([
  'idle',   // 中性静止：Ready / Stopped
  'run',    // 运行中：脉冲圆点
  'wait',   // 等待：等待依赖 / 排队中
  'warn',   // 异常但属正常流程：超时重试 / 限流退避
  'ok',     // 完成
  'fail',   // 失败：唯一使用 danger 色的分类
  'container', // 容器槽位：方形标记
]);
export type Tone = z.infer<typeof ToneSchema>;

/** 三段式业务化描述，见 D-07 */
export const PresentationSchema = z.object({
  tone: ToneSchema,
  /** 业务化状态文字，如「正在填充 Slot」。不是状态机枚举 */
  state: z.string(),
  /** 可判断的业务事实，如「scene_2 场景正文生成中」。不是日志行 */
  detail: z.string(),
});
export type Presentation = z.infer<typeof PresentationSchema>;
```

### 3.2 错误契约 `shared/errors.ts`

```ts
export const ERROR_CODES = [
  // 模板
  'TEMPLATE_NOT_FOUND', 'TEMPLATE_INVALID', 'TEMPLATE_NOT_PUBLISHED',
  // 任务
  'TASK_NOT_FOUND', 'TASK_STATE_INVALID', 'TASK_INPUT_INVALID',
  // 引擎
  'ENGINE_BUSY',
  // 结构
  'STRUCTURE_INVALID', 'STRUCTURE_RETRY_EXHAUSTED',
  // 槽位
  'SLOT_NOT_FOUND', 'SLOT_NOT_READY', 'SLOT_TARGET_MISMATCH',
  'SLOT_CONTENT_INVALID', 'DEPENDENCY_DEADLOCK',
  // Provider / 执行
  'PROVIDER_TIMEOUT', 'PROVIDER_ERROR', 'PROVIDER_RATE_LIMITED',   // ← D-04 新增
  'PROVIDER_UNAVAILABLE',                                          // ← D-03 新增
  'MODEL_ALIAS_UNRESOLVED',                                        // ← D-03 新增
  'EXECUTION_CANCELLED', 'EXECUTION_STALE', 'EXECUTION_TOKEN_INVALID',
  'MAX_TOOL_CALLS_EXCEEDED',                                       // ← 新增
  // 工具
  'TOOL_NOT_ALLOWED', 'TOOL_INPUT_INVALID', 'SKILL_SECTION_NOT_FOUND',
  'ASSIGNMENT_OUTPUT_INVALID',
  // 组装 / 存储
  'ASSEMBLY_FAILED', 'ARTIFACT_NOT_FOUND', 'STORAGE_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 对外错误结构（REQ §12） */
export interface PublicError {
  code: ErrorCode;
  message: string;        // 面向用户的中文说明
  location: string | null;// 如 'slot:scene_02'
  action: string | null;  // 用户可执行的下一步，如 '点击重试从该槽位继续'
}

export class ForgeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly location: string | null = null,
    readonly action: string | null = null,
    readonly cause?: unknown,
  ) { super(message); }

  toPublic(): PublicError {
    return { code: this.code, message: this.message,
             location: this.location, action: this.action };
  }
}
```

`cause` 只写脱敏服务日志，不进 `toPublic()`。

### 3.3 Trace 契约 `shared/trace.ts`

```ts
import { z } from 'zod';

export const TraceActorSchema = z.enum(['system', 'agent', 'tool', 'skill']);

export const TRACE_KINDS = [
  'task_state_changed',
  'assignment_created', 'assignment_started', 'context_built',
  'skill_loaded', 'skill_section_read',
  'work_understanding', 'work_plan', 'work_decision',
  'work_progress', 'work_completion',
  'tool_call_started', 'tool_call_completed',
  'public_output_chunk',
  'assignment_submitted', 'validation_passed', 'validation_failed',
  'assignment_completed', 'assignment_failed', 'assignment_cancelled',
  'late_result_rejected',
  'slot_state_changed',
  'assembly_started', 'artifact_created',
  'provider_retry',                    // ← 新增，UX §18.6 要求展示 Attempt 变化
  'task_queued',                       // ← 新增，D-14
] as const;
export const TraceKindSchema = z.enum(TRACE_KINDS);
export type TraceKind = (typeof TRACE_KINDS)[number];

export const TraceEventSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  executionId: z.string().nullable(),
  sequence: z.number().int(),
  actor: TraceActorSchema,
  kind: TraceKindSchema,
  /** 卡片标题，如「读取上游产物」 */
  title: z.string(),
  /** 一句话正文，如「chapter_outline.scenes[1] · scene_01 结尾状态摘要」 */
  summary: z.string(),
  /** 展开区，已脱敏。大段正文不放这里 */
  payload: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

/** 前端筛选分组（UX §13.2） */
export const TRACE_FILTER_GROUPS = {
  all:    TRACE_KINDS,
  work:   ['work_understanding','work_plan','work_decision',
           'work_progress','work_completion'],
  skill:  ['skill_loaded','skill_section_read'],
  tool:   ['tool_call_started','tool_call_completed'],
  output: ['public_output_chunk'],
  system: ['task_state_changed','assignment_created','assignment_started',
           'context_built','assignment_submitted','validation_passed',
           'validation_failed','assignment_completed','assignment_failed',
           'assignment_cancelled','late_result_rejected','slot_state_changed',
           'assembly_started','artifact_created','provider_retry','task_queued'],
} as const satisfies Record<string, readonly TraceKind[]>;
```

**一条 Assignment 的轨迹必须自洽**（M5-D 补正）。`assignment_created` /
`assignment_started` / `assignment_submitted` / `assignment_completed`
与 operation 无关：`create_structure` 与 `fill_slot` 都要写全。
实测发现结构那条路径**只在失败时收尾**（`failAttempt` 写 `assignment_failed`），
成功时写完 `validation_passed` 就没有下文了——一次真实任务的 6 个 assignment
只有 5 条 `assignment_completed`。轻的后果是 UX §13 的时间线里结构那一格看起来卡住了；
重的后果是任何按 trace 统计「跑完几次 assignment」的东西
（`cli/measure-runs.ts`）都会**系统性地、每次一样地**少算一次，
因此不会被当成异常。这与 M4 修掉的「`assignment_started` 写两次」是同一类问题：
缺一半和多一半同样坏。

`组件状态变体.dc.html` 的 `ACTOR_COLOR` 里有一个 `Error` actor。它不是独立 actor——失败事件的 actor 仍是 `system`，前端按 `kind ∈ {validation_failed, assignment_failed, late_result_rejected}` 走 danger 配色（🔴 设计侧知悉）。

### 3.4 工具契约 `shared/tools.ts`

```ts
import { z } from 'zod';

export const SlotProposalSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/,
        'Slot ID 只能包含小写字母、数字和下划线，且以字母开头，最长 64 字符'),
  type: z.string(),
  parentId: z.string().nullable(),
  order: z.number().int().min(0),
  instruction: z.string(),
  dependsOn: z.array(z.string()).default([]),
});
export type SlotProposal = z.infer<typeof SlotProposalSchema>;

export const ToolSchemas = {
  read_task_input: z.object({
    field: z.string().optional(),   // 省略则返回全部字段
  }),

  read_skill_section: z.object({
    sectionId: z.string(),
  }),

  read_structure_outline: z.object({}),

  read_slot: z.object({
    slotId: z.string(),
  }),

  report_work: z.object({
    type: z.enum(['understanding','plan','decision','progress','completion']),
    summary: z.string().min(1).max(2000),
    relatedSkillSectionIds: z.array(z.string()).optional(),
    relatedSlotIds: z.array(z.string()).optional(),
  }),

  complete_assignment: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('structure'),
      rootSlotId: z.string(),
      slots: z.array(SlotProposalSchema).min(1),
    }),
    z.object({
      kind: z.literal('slot_content'),
      slotId: z.string(),
      content: z.string(),
    }),
  ]),
} as const;
```

注意 `SlotProposalSchema` 的 ID 正则同时承担 REQ FR-STR-004 第 4 条「Slot ID 满足安全字符规则」。把它放在 Zod 层意味着**格式错误在解析阶段就被拦下**，不会进入 19 条业务校验，报错也更精确。

**判别联合投影成 JSON Schema 时必须补 `type: "object"`（M4 实测补正）**

`complete_assignment` 是这 6 个 schema 里唯一的判别联合，而 `tool-schema.ts` 原先把它
直接投影成 `{ anyOf: [...] }`——一个没有根 `type` 的 schema。DeepSeek 的 function calling
校验器当场拒绝：

```
HTTP 400 Invalid schema for function 'complete_assignment':
schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

这条 400 是**第一次接真实 Provider 才可能发现的**：`FakeProvider` 不校验 schema，
所以 M3 的 508 条测试全绿也说明不了这一处能用。它同时说明一件事——
「adapter 已实现」与「adapter 能跑通」之间隔着一次真实调用。

**决议**：`ZodDiscriminatedUnion` 的投影结果补一个 `type: 'object'`。
这不是为了迁就某一家而伪造信息：判别联合的每一个分支按定义都是 object，
根类型就是 object，原先的输出是**漏了**而不是「故意留空」。
分支细节仍由 `anyOf` 完整保留，Zod 那份权威定义一个字不动
（§3.4 开头的「双重身份、单一定义」不受影响）。

已实测确认 DeepSeek 接受 `{ type: 'object', anyOf: [...] }` 并能据此产出格式正确的 tool call。

### 3.5 API DTO `shared/contracts.ts`

只列关键形状，完整定义在代码中。字段名与 HANDOFF 各页面的数据常量保持一致，便于前端直接替换数据源。

```ts
// ---------- 模板 ----------
export const TemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  status: z.enum(['published','draft','archived']),
  outputKind: z.string(),          // 「单章正文」，前端筛选用
  slotTypeCount: z.number(),
  agentCount: z.number(),
  skillCount: z.number(),
  runCount: z.number(),            // D-08
  tags: z.array(z.string()),
  updatedAt: z.string(),
});

// `GET /api/templates` 的返回体（M5-B 新增）。
// 早先只画了 TemplateSummary，隐含「列表 = 摘要数组」，但那样 TemplateCatalog
// 刻意收集的 `failures` 到了 HTTP 边界就没了。§4.1 的取舍是「一个坏模板不许让
// 整个列表页空白，但坏模板必须显式可见」——只返回数组等于把后半句丢掉，
// 表现是「我明明建了模板，列表里没有」。
// 只出 `dirName` 不出 `sourcePath`：后者是绝对路径，与 §9.3
//「sqlite 报错带表名、Node 报错带绝对路径，一律不出网」是同一条纪律。
export const TemplateLoadFailureViewSchema = z.object({
  dirName: z.string(),
  error: PublicErrorSchema,
});

export const TemplateListResponseSchema = z.object({
  templates: z.array(TemplateSummarySchema),
  failures: z.array(TemplateLoadFailureViewSchema),
});

export const SlotTypeDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  contentBearing: z.boolean(),
  // 以下仅 contentBearing=true 时存在
  binding: z.object({
    agentId: z.string(), agentName: z.string(), agentRole: z.string(),
    skillId: z.string(), skillVersion: z.string(), skillSummary: z.string(),
    modelAlias: z.string(),
    resolvedModel: z.string().nullable(),  // 当前别名解析结果，供展示
    timeoutMs: z.number(),
    maxRetries: z.number(),
  }).nullable(),
  validation: z.object({            // D-05 系统强制
    minChars: z.number().nullable(),
    maxChars: z.number().nullable(),
    rules: z.array(z.string()),     // 人类可读描述
  }),
  guidance: z.array(z.string()),    // D-05 写作要求，不强制
});

export const TemplateDetailSchema = TemplateSummarySchema.extend({
  inputFields: z.array(InputFieldSchema),
  structureBinding: z.object({      // D-01 新增区块
    agentId: z.string(), agentName: z.string(),
    skillId: z.string(), skillVersion: z.string(),
    modelAlias: z.string(), resolvedModel: z.string().nullable(),
    timeoutMs: z.number(), maxRetries: z.number(),
    maxSlots: z.number(), maxStructureDepth: z.number(),
  }),
  slotTypes: z.array(SlotTypeDetailSchema),
  exampleStructure: z.array(z.object({   // D-02，仅展示
    name: z.string(), typeId: z.string(),
    kind: z.enum(['container','content']), depth: z.number(),
  })).nullable(),
  output: z.object({ fileName: z.string(), mediaType: z.string() }),
});

// ---------- 任务 ----------
export const TaskSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  templateId: z.string(),
  templateName: z.string(),
  status: z.enum(['ready','running','stopped','completed','failed']),
  phase: z.enum(['structure','slots','assembly','done']),
  presentation: PresentationSchema,      // D-07：tone / state / detail
  doneSlots: z.number(),
  totalSlots: z.number(),                // 结构未创建时为 0
  updatedAt: z.string(),
});

export const SlotViewSchema = z.object({
  id: z.string(),
  type: z.string(),
  typeName: z.string(),
  parentId: z.string().nullable(),
  order: z.number(),
  depth: z.number(),                     // 服务端算好，前端不再递归
  path: z.array(z.string()),             // ['chapter','scene_03']，中栏「位置」用
  instruction: z.string(),
  dependsOn: z.array(z.string()),
  contentBearing: z.boolean(),
  status: z.enum(['pending','running','completed','failed']),
  presentation: PresentationSchema,      // D-07：8 态词表
  blockedBy: z.array(z.string()),        // pending 且依赖未完成时，点名在等谁
  charCount: z.number().nullable(),      // 「1,486 字 · 校验通过」子行用
  producer: z.object({
    agentId: z.string(), agentName: z.string(),
    skillId: z.string(), skillVersion: z.string(),
    executionId: z.string(),
    durationMs: z.number(),
  }).nullable(),
  error: PublicErrorSchema.nullable(),
});

export const TaskDetailSchema = TaskSummarySchema.extend({
  input: z.record(z.string()),
  snapshotHash: z.string(),
  slots: z.array(SlotViewSchema),
  stepper: z.array(z.object({            // UX §9.2 五段
    key: z.enum(['input','structure','slots','assembly','done']),
    label: z.string(),
    state: z.enum(['done','current','todo','error']),
    summary: z.string(),                 // 「7 个槽位」「4 / 7」
    owner: z.enum(['system','agent']),
  })),
  activeExecution: ExecutionViewSchema.nullable(),
  plannedAssignment: z.object({          // UX §12.3「计划工作」
    agentId: z.string(), agentName: z.string(),
    skillId: z.string(), skillVersion: z.string(),
    operation: z.enum(['create_structure','fill_slot']),
    targetSlotId: z.string().nullable(),
    blockedBy: z.array(z.string()),
  }).nullable(),
  queuePosition: z.number().nullable(),  // D-14
  artifact: ArtifactViewSchema.nullable(),
  error: PublicErrorSchema.nullable(),
});
```

**`depth` 是 0 基（D-19 澄清）**：根槽位 `depth = 0`。§6.1 第 9 条的 agentHint
写的是「处于第 5 层，上限 4 层」，那是 **1 基的人类说法**，两者差一是刻意的——
前端用 `depth × 20px` 做缩进，根必须是 0；报错文案给人看，从第 1 层数起才自然。
因此深度判据写成 `depth + 1 > maxStructureDepth`。这两处不要「对齐」，对齐就得有一处变别扭。

`SlotViewSchema` 里的 `depth` / `path` / `blockedBy` / `charCount` 都是服务端派生字段。把它们放进 DTO 而不是让前端算，是因为 HANDOFF 的树渲染直接用 `depth × 20px` 做缩进，而 `blockedBy` 是「子行必须点名在等谁」的数据来源——这些都属于 D-07 的投影职责。

---

## 4. 模板与 Skill 文件格式

### 4.1 `template.yaml` 完整格式

以 REQ §24 的示例为基线，补入 D-01/02/05/06/08 的决议：

```yaml
id: zhihu-chapter
version: 1.0.0
name: 知乎盐选单章结构槽生产
description: 章节结构由 Agent 依据执行包设计，逐槽填充后组装为单章正文。
status: published                    # D-08: published | draft | archived

presentation:                        # 纯展示，不进快照，不计入 templateHash
  outputKind: 单章正文
  tags: [结构 Agent, 写作 Agent, 场景写作]
  exampleStructure:                  # D-02
    - { name: chapter,   typeId: chapter, kind: container, depth: 0 }
    - { name: title,     typeId: title,   kind: content,   depth: 1 }
    - { name: opening,   typeId: opening, kind: content,   depth: 1 }
    - { name: scene_01,  typeId: scene,   kind: content,   depth: 1 }
    - { name: scene_02,  typeId: scene,   kind: content,   depth: 1 }
    - { name: chapter_end, typeId: chapter_end, kind: content, depth: 1 }

inputFields:
  - id: chapter_packet
    label: 章节执行包
    type: textarea
    required: true
    hint: 本章的素材、人物状态与情节目标

slotTypes:
  - id: chapter
    name: 章节容器
    description: 承载完整章节结构，不产出正文
    contentBearing: false

  # 工作槽位（D-16）：产出内容供下游 read_slot 读取，但不进最终产物
  - id: chapter_outline
    name: 章节骨架
    description: 各场景的目标、冲突与出场人物。后续场景槽位读取它，不进正文。
    contentBearing: true
    includeInArtifact: false         # ← D-16
    validation:
      minChars: 100
      maxChars: 3000
    guidance:
      - 每个场景需明确写出目标、冲突与出场人物
      - 只写规划，不写正文散文

  - id: scene
    name: 场景段
    description: 通过行动、冲突或信息变化推进正文
    contentBearing: true
    validation:                      # D-05 系统强制
      minChars: 300
      maxChars: 8000
      forbidPattern: '(?m)^#{1,6}\s'
      forbidPatternMessage: 场景正文不得包含 Markdown 小标题
    guidance:                        # D-05 写入 Agent 上下文，不强制
      - 首段需衔接前一场景的结尾状态
      - 通过可见行动推进，不用心理解释代替事件
      - 结尾留下可被下一槽位承接的具体状态

  # title / opening / emotional_closure / chapter_end 同构，此处省略

agents:
  - id: structure_designer
    name: 章节结构设计 Agent
    role: 根据章节执行包设计具体章节结构
    model: main                      # 别名，D-03 late-bound 解析
    systemInstruction: |
      你负责设计章节的内容结构，不负责撰写正文。

  - id: chapter_writer
    name: 章节写作 Agent
    role: 根据结构槽目标生产章节正文
    model: main
    systemInstruction: |
      你负责撰写单个结构槽的正文，不负责修改结构或其他槽位。

skills:
  - id: chapter-structure-design
    version: 1.0.0
    source: skills/chapter-structure-design/SKILL.md
  - id: scene-writing
    version: 1.0.0
    source: skills/scene-writing/SKILL.md
  # ...

bindings:
  createStructure:
    agentId: structure_designer
    skillId: chapter-structure-design
    timeoutMs: 90000                 # D-06 覆盖，结构输出短但格式严格
    maxRetries: 2

  fillSlotByType:
    scene:
      agentId: chapter_writer
      skillId: scene-writing
      timeoutMs: 180000              # D-06 覆盖
      maxRetries: 1
    title:
      agentId: chapter_writer
      skillId: title-writing
    # 未指定 timeoutMs / maxRetries 的走 limits 默认

limits:
  maxSlots: 32
  maxStructureDepth: 4
  maxExecutionRetries: 2             # 默认值，可被 binding 覆盖
  executionTimeoutMs: 120000         # 默认值，可被 binding 覆盖
  maxToolCallsPerAssignment: 24      # 新增：防止工具循环失控

output:
  fileName: chapter.md
  mediaType: text/markdown
  assembler: markdown_concat_v1
```

**`maxToolCallsPerAssignment`（新增）**：TECH-V0.1 §6.9 提到「控制最大工具调用数」但没给配置位。没有它，一个反复调 `read_skill_section` 的模型会一直烧 token 直到超时。超限抛 `MAX_TOOL_CALLS_EXCEEDED`，按重试配额处理。**它是必填项**：`providers.yaml` 的 `defaults` 里没有对应条目，也就是说它没有回退来源，给它编一个隐式默认值等于让「忘了配」变成一个要等到线上烧 token 才发现的问题（与 D-06 对 `modelAlias` 的态度一致）。

**`forbidPattern` 的 `(?m)` 前缀（M2-B 修订）**

上面示例里的 `forbidPattern: '(?m)^#{1,6}\s'` **不是合法的 JavaScript 正则**：
V8 对 `(?m)` 这种全局内联标志前缀直接抛 `Invalid group`（ES2025 的内联修饰符只支持
`(?m:...)` 这种带作用域的形式）。照着本节抄模板的人会得到一个「正则语法错误」，
而他抄的正是规范里的例子。

**决议：保留这个写法，由加载器在编译期把前缀翻译成 `RegExp` 的 flags 参数。**
不选「改示例 + 新增 `forbidPatternFlags` 字段」，是因为那要给每个模板作者
多一个字段和一条「别忘了配对」的约束，而 `(?m)` 前缀是跨语言正则的通用写法。
- 只接受 `i` / `m` / `s` / `u` 四个标志。`g` 会引入 `lastIndex` 状态、
  `y` 会改变匹配语义，两者都不适合「禁止出现」这种一次性判定。
- 编译产物里存的是**已剥离前缀的** `forbidPattern` 加一个 `forbidPatternFlags`，
  运行时 `new RegExp(pattern, flags)` 直接用，不再解析第二次。

**`forbidPattern` 必须配 `forbidPatternMessage`（M2-B 修订）**：只给正则源码
等于让模型自己反推意图，是 D-13 明列的「不可执行反馈」。编译期强制成对出现。

**`skills[].source` 的基准目录（M2-B 补充）**：本节示例写的是
`skills/chapter-structure-design/SKILL.md`，但没说相对谁。定为**相对 `SKILLS_DIR`
的父目录**——对着 §2.1 的目录树只有这一种读法讲得通。加载器同时做目录逃逸检查：
解析后的路径必须仍在 `SKILLS_DIR` 内。这不是防攻击（单机部署没有攻击者），
而是防止一次手滑让加载器去读仓库外的文件并把内容哈希进快照。

**编译期校验清单（M2-B 补充，§12.2 M2 完成判据的展开）**

加载器在编译期拒绝以下全部情形，一律抛 `TEMPLATE_INVALID`（模板目录不存在除外，
那是 `TEMPLATE_NOT_FOUND`）。原则：**能在加载期发现的，绝不留到运行期**——
同一个错误在加载期只是一条清楚的报错，在运行期是「任务跑到一半失败」
甚至「整个进程卡死」。

| 类别 | 判据 |
|---|---|
| 结构 | YAML 语法错；顶层或任一对象出现未知字段（全部 `.strict()`，拼错的键当场报出）；`slotTypes` / `agents` / `skills` / `inputFields` 内 ID 重复 |
| 绑定 | 缺 `bindings.createStructure`；`agentId` / `skillId` 悬空；`fillSlotByType` 的键不是已知槽位类型；给容器类型配了填充绑定 |
| Skill | `skills[].version` 与 SKILL.md 里的不一致；`createStructure` 绑的 Skill `operation ≠ create_structure`；`fillSlotByType.X` 绑的 Skill `operation ≠ fill_slot` **或其 `slotTypes` 不含 X** |
| 覆盖 | `fillSlotByType` 未覆盖全部 `contentBearing` 槽位类型；一个 `contentBearing` 类型都没有 |
| D-06 | `binding.modelAlias` 与 `agent.model` 都缺失（无全局默认别名）；解析出的别名**不在** `config/providers.yaml` 的 `aliases` 里（见下） |
| 校验 | `minChars > maxChars`；`forbidPattern` 语法非法；`forbidPattern` 超出时间预算；`forbidPattern` 与 `forbidPatternMessage` 未成对 |
| 展示 | `presentation.exampleStructure` 引用了不存在的 `typeId`，或 `kind` 与该类型的 `contentBearing` 不符（展示字段虽不进 hash，但悬空引用一定是模板写错了） |
| 目录 | 模板目录名与 `id` 不一致；两个目录声明了同一个 `id` |

**别名存在性要在编译期查，但不取代运行期的 `MODEL_ALIAS_UNRESOLVED`（D-19 定案）。**

D-03 的「晚绑定」说的是**别名 → provider/model 的取值**推迟到执行时，
好处是换模型不必重建历史快照。它**不是**「别名写错了也要拖到执行时才发现」的许可。
一个引用了不存在别名的模板，如果加载期放行，代价是：任务创建成功、跑起来、
烧掉一次 Assignment 才失败，而错误信息指向的是运行期而不是那行 YAML。

两道检查都要保留，因为它们防的不是同一件事：

- **编译期**防的是**模板作者打错字**——此时 providers.yaml 就在手边（`defaults` 已经要读它），
  查一下几乎不要钱。
- **运行期**防的是**providers.yaml 在模板编译之后被改瘦了**——别名被删、被改名。
  编译期检查对这种情况无能为力，所以 `MODEL_ALIAS_UNRESOLVED` 必须留着。

> ⚠️ 本节开头的示例 YAML 因为写了「title / opening / emotional_closure / chapter_end 同构，此处省略」，
> 其 `exampleStructure` 引用了几个未在 `slotTypes` 中列出的类型，**照抄会被上表「展示」一行拒绝**。
> 那份示例是格式说明而不是可运行模板；可运行的最小合法模板见
> `tests/fixtures/templates/zhihu-chapter/template.yaml`，每类非法模板见
> `tests/fixtures/invalid-templates/`。

**`forbidPattern` 的时间预算**：`forbidPattern` 是模板作者手写的正则，
而它会被拿去跑模型生成的长文本——这是灾难性回溯的经典配方。
加载期用一组代表性输入（长同字符游程、长空白游程、真实形状的 Markdown 正文）
把每条正则跑一遍，单条超出预算即拒绝该模板。**必须在独立 worker 里跑并由父线程
`terminate()`**：回溯发生在 V8 正则引擎内部，主线程上没有任何检查点能观察到超时。

**`presentation` 的剥离时点**：校验在编译期做（见上表「展示」一行），
校验完**整块丢弃**，不进入 `CompiledTemplate`，因而不进 `templateHash`。
`templateHash = canonicalHash(CompiledTemplate 去掉 hash 字段本身)`——
哈希的是编译产物而不是 YAML 原文：原文含注释与缩进，改一个空格就换 hash，
没有语义价值；编译产物已把回退链求解完，两个写法不同但语义相同的模板得到同一个 hash。
`skills[]` 在编译产物里带上 SKILL.md 的 `contentHash`，因此**改了 Skill 正文
就是改了模板的行为**，只记 `id + version` 会让「版本号没动但内容改了」悄悄溜过去。

### 4.2 `config/providers.yaml`

```yaml
providers:
  - id: deepseek
    name: DeepSeek
    kind: openai-compatible          # 决定用哪个 adapter（D-17）
    baseUrl: https://api.deepseek.com/v1
    apiKeyEnv: DEEPSEEK_API_KEY      # 只写环境变量名，绝不写值
    models: [deepseek-chat, deepseek-reasoner]

aliases:
  main:       { provider: deepseek, model: deepseek-chat }
  configured: { provider: deepseek, model: deepseek-chat }   # REQ §24 示例用
  # 结构设计专用别名。若 M4 实测通过率不达标，把 createStructure 绑定切到这里
  # 即可换用更强模型，无需改模板（D-17 的 L3 缓解手段）
  structure:  { provider: deepseek, model: deepseek-chat }

defaults:
  timeoutMs: 180000
  # D-19 更正：原写 1，与 §2 D-06 的「maxExecutionRetries 默认 2」冲突。
  # 这一行是回退链的**最后一级**——模板没写 limits 时就用它。
  # 取 1 意味着一个没配 limits 的模板，其 Structure Agent 只有 2 次机会满足 19 条校验，
  # 而 §4.1 明说 3 次是「决定产品成败」的取值。两个默认值必须同为 2。
  maxRetries: 2
  concurrentSlots: 1               # D-04：P0 固定 1，不可配
  rateLimitBackoff:
    strategy: exponential
    initialMs: 1000
    maxMs: 60000
    maxAttempts: 5                 # 限流重试独立配额，不计入 maxRetries
```

**限流重试与失败重试是两套配额**（D-04 的展开）。`PROVIDER_RATE_LIMITED`（HTTP 429）走 `rateLimitBackoff`，不递增 `attemptNumber`，不产生新 Execution，只在同一 Execution 内退避重发，并写 `provider_retry` trace 让 UI 显示「限流退避中」。只有 `PROVIDER_TIMEOUT` / `PROVIDER_ERROR` / 校验失败才消耗 `maxRetries` 并创建新 Execution。

HANDOFF 的 `MAPPINGS` 表里 `claude-sonnet-4-5` 等 ID 是原型示意值，实际配置应使用当前模型 ID（如上）。别名层的价值正在于此——换模型只改这个文件。

### 4.3 `SKILL.md` 格式

沿用 TECH-V0.1 §6.8，补充两点约束：

```markdown
---
id: scene-writing
version: 1.0.0
operation: fill_slot
slotTypes: [scene]
summary: 通过可见行动与信息变化推进单个场景，不做心理解释。
requiredSections: [S1, S2, S6]      # 自动注入 Context 的章节
---

# 场景写作 Skill

## S1. 理解槽位目标
...

## S2. 读取前置状态
...

## S6. 提交前自检
...
```

**新增约束 1：`summary` 为必填。** 它进入 Context 的 Skill Overview 段，也用于模板详情页的 `skillSummary` 字段。没有它，模板详情页右栏的「Skill + 说明」无数据可显示。

**新增约束 2：Section ID 必须匹配 `^S\d+$`。** 编译期强制。理由：`read_skill_section` 的参数由模型生成，宽松的 ID 规则会导致模型传入标题全文而非 ID。固定为 `S1`/`S2` 这种短形式，模型的命中率显著更高。

**Section 解析规则**：以 `## ` 开头且首个 token 匹配 `^S\d+\.?$` 的行作为 section 起点，直到下一个同级标题或文件结束。标题中 ID 之后的部分为 section title。非 section 内容（frontmatter 之后、首个 `## S1` 之前）作为 Skill 的前言，随 Overview 一起注入。

**新增约束 3（M2-B）：`slotTypes` 与 `operation` 必须自洽。**
`operation: fill_slot` 时 `slotTypes` 必填且非空——模板编译期正是靠它校验
「这条绑定的槽位类型，该 Skill 管不管」；不声明就没法校验，
错配会一路漏到运行时，那时模型已经在按一份不适用的 Skill 干活了。
反过来 `operation: create_structure` 时不得声明 `slotTypes`：它的目标是整棵结构而非某个类型，
写了只能是误解，静默接受会让作者以为「结构 Skill 也能按类型挑」。

**`contentHash` 的定义（M2-B）**：`sha256(SKILL.md 全文，换行统一为 LF、字符串做 NFC 规范化)`。
哈希原文而非解析结果——解析结果丢掉了空白与注释，而「改了 SKILL.md」这件事本身
就该让 hash 变化，哪怕只改了一个换行，快照隔离要的正是这个语义。
统一换行是为了让同一份文件在 Windows 上 checkout 后不会让所有历史快照失配；
NFC 与 `canonical.ts` 的字符串处理保持一致。**路径不参与哈希**，
否则快照隔离的判据会随部署环境漂移。

---

## 5. 数据库

### 5.1 连接与 PRAGMA

```ts
// infrastructure/database/db.ts
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');       // 读不阻塞写
db.pragma('synchronous = FULL');       // 单机内容生产，不容忍丢事务
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
```

`synchronous = FULL` 而非 `NORMAL`：REQ NFR-002 要求「每个 Slot 完成后立即持久化」，一次 fsync 的开销（约 1ms）相对于一次 Provider 调用（数十秒）可以忽略，但换来断电不丢已完成槽位。

### 5.2 `migrations/001_initial.sql`

```sql
-- ============ 快照 ============
CREATE TABLE task_snapshots (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL UNIQUE
                     REFERENCES tasks(id) ON DELETE CASCADE
                     DEFERRABLE INITIALLY DEFERRED,   -- D-18
  template_id      TEXT NOT NULL,
  template_version TEXT NOT NULL,
  compiled_json    TEXT NOT NULL,      -- CompiledTemplate（已剥离 presentation）
  snapshot_hash    TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE task_skill_snapshots (
  task_id            TEXT NOT NULL,
  skill_id           TEXT NOT NULL,
  skill_version      TEXT NOT NULL,
  content_markdown   TEXT NOT NULL,
  section_index_json TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  PRIMARY KEY (task_id, skill_id)
);

-- ============ 任务 ============
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  snapshot_id         TEXT NOT NULL REFERENCES task_snapshots(id),
  input_json          TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN
                        ('ready','running','stopped','completed','failed')),
  phase               TEXT NOT NULL CHECK (phase IN
                        ('structure','slots','assembly','done')),
  active_execution_id TEXT NULL REFERENCES executions(id)
                        DEFERRABLE INITIALLY DEFERRED,  -- D-18
  artifact_id         TEXT NULL,
  error_code          TEXT NULL,
  error_message       TEXT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- ============ 槽位 ============
CREATE TABLE slots (
  task_id                TEXT NOT NULL REFERENCES tasks(id),
  slot_id                TEXT NOT NULL,
  type                   TEXT NOT NULL,
  parent_id              TEXT NULL,
  sort_order             INTEGER NOT NULL,
  instruction            TEXT NOT NULL,
  depends_on_json        TEXT NOT NULL DEFAULT '[]',
  content_bearing        INTEGER NOT NULL CHECK (content_bearing IN (0,1)),
  -- D-16：工作槽位（content_bearing=1 且 include_in_artifact=0）产出内容、
  -- 可被 read_slot 读取、计入完成判定，但装配时跳过，不进最终产物。
  include_in_artifact    INTEGER NOT NULL DEFAULT 1
                           CHECK (include_in_artifact IN (0,1)),
  status                 TEXT NOT NULL CHECK (status IN
                           ('pending','running','completed','failed')),
  content_text           TEXT NULL,
  producer_agent_id      TEXT NULL,
  producer_skill_id      TEXT NULL,
  producer_skill_version TEXT NULL,
  producer_execution_id  TEXT NULL REFERENCES executions(id)
                           DEFERRABLE INITIALLY DEFERRED,  -- D-18
  error_code             TEXT NULL,
  error_message          TEXT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (task_id, slot_id),

  -- REQ AC-009：完成的内容槽必须同时具备 content 与 producer，杜绝部分状态
  CHECK (
    NOT (status = 'completed' AND content_bearing = 1)
    OR (content_text IS NOT NULL
        AND producer_agent_id IS NOT NULL
        AND producer_skill_id IS NOT NULL
        AND producer_execution_id IS NOT NULL)
  ),
  -- 容器槽位不得有正文
  CHECK (NOT (content_bearing = 0) OR content_text IS NULL),

  -- D-18：父槽位自引用。slots 是复合主键，所以外键也必须是复合的
  -- （写成 REFERENCES slots(id) 会直接建表失败——没有 id 这一列）。
  -- 附带好处：它同时保证父子槽位不跨任务。
  -- 必须 DEFERRED：§5.5「提交 Structure」在一个事务内一次性插入整棵树，
  -- 无法保证父槽位排在子槽位之前。
  FOREIGN KEY (task_id, parent_id) REFERENCES slots(task_id, slot_id)
    DEFERRABLE INITIALLY DEFERRED
);

-- ============ 执行 ============
CREATE TABLE executions (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id),
  operation      TEXT NOT NULL CHECK (operation IN
                   ('create_structure','fill_slot')),
  target_slot_id TEXT NULL,
  agent_id       TEXT NOT NULL,
  skill_id       TEXT NOT NULL,
  skill_version  TEXT NOT NULL,
  token_hash     TEXT NOT NULL,
  context_json   TEXT NOT NULL,
  context_hash   TEXT NOT NULL,
  prompt_hash    TEXT NOT NULL,        -- D-12
  model_alias    TEXT NOT NULL,        -- D-03：冻结的别名
  provider       TEXT NOT NULL,        -- D-03：解析后的实际 provider
  model          TEXT NOT NULL,        -- D-03：解析后的实际 model
  attempt_number INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN
                   ('created','running','succeeded','failed','cancelled','stale')),
  input_tokens   INTEGER NULL,
  output_tokens  INTEGER NULL,
  error_code     TEXT NULL,
  error_message  TEXT NULL,
  started_at     TEXT NULL,
  finished_at    TEXT NULL,
  created_at     TEXT NOT NULL,

  -- D-18：同一槽位的同一次尝试不得有两条 execution。
  -- 注意 SQLite 语义：UNIQUE 中 NULL 互不相等，因此 target_slot_id IS NULL
  -- 的结构创建 execution【不受此约束保护】，别误以为它也被锁住了。
  UNIQUE (task_id, target_slot_id, attempt_number)
);

-- ============ 轨迹 ============
-- sequence 没有库层生成机制（无自增、无默认值）。Repository 必须在
-- 【同一事务内】执行 SELECT MAX(sequence)+1 再插入；下面的
-- UNIQUE (task_id, sequence) 是这条约定失守时的唯一兜底。
CREATE TABLE trace_events (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id),
  execution_id TEXT NULL,
  sequence     INTEGER NOT NULL,
  actor        TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  payload_json TEXT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (task_id, sequence)
);

-- ============ 产物 ============
CREATE TABLE artifacts (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  file_name    TEXT NOT NULL,
  media_type   TEXT NOT NULL,
  content_blob BLOB NOT NULL,
  checksum     TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);

-- ============ Provider 健康（D-03） ============
CREATE TABLE provider_health (
  provider_id      TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('ok','rate_limited','down')),
  latency_ms       INTEGER NULL,
  note             TEXT NULL,
  rate_limit_count INTEGER NOT NULL DEFAULT 0,  -- 滚动 10 分钟内 429 次数
  checked_at       TEXT NOT NULL
);
```

**两条 CHECK 约束是 AC-009 的最后一道防线。** 应用层已经用事务保证原子性，但数据库层再加一道，能在实现出 bug 时立刻炸掉而不是静默写入不一致数据。测试中应有一条用例直接尝试违反它并断言抛错。

### 5.3 `migrations/002_indexes.sql`

```sql
CREATE INDEX idx_slots_task_status   ON slots(task_id, status);
CREATE INDEX idx_slots_task_parent   ON slots(task_id, parent_id, sort_order);
CREATE INDEX idx_exec_task_created   ON executions(task_id, created_at DESC);
CREATE INDEX idx_exec_target         ON executions(task_id, target_slot_id);
CREATE INDEX idx_trace_task_seq      ON trace_events(task_id, sequence);
CREATE INDEX idx_trace_exec_seq      ON trace_events(execution_id, sequence);
CREATE INDEX idx_tasks_status_upd    ON tasks(status, updated_at DESC);
CREATE INDEX idx_snapshots_template  ON task_snapshots(template_id);  -- D-08 runCount
CREATE INDEX idx_executions_status   ON executions(status);           -- D-18：§8.6 重启恢复扫孤儿
```

### 5.4 Unit of Work

TECH-V0.1 §8 要求「Application 不允许手工跨多个独立 Repository 调用拼接事务，应提供面向用例的 Unit of Work」。具体实现：

```ts
// infrastructure/uow.ts
export interface UnitOfWork {
  tasks: TaskRepo;
  slots: SlotRepo;
  executions: ExecutionRepo;
  traces: TraceRepo;
  artifacts: ArtifactRepo;
  snapshots: SnapshotRepo;
}

export function createUowRunner(db: Database) {
  const repos: UnitOfWork = { /* 各 repo 持有同一个 db 句柄 */ };
  return function run<T>(fn: (uow: UnitOfWork) => T): T {
    // better-sqlite3 的 transaction 是同步的：fn 内不得有 await
    return db.transaction(fn)(repos);
  };
}
```

**硬性编码约定：传给 `run()` 的回调必须是同步函数。** 用 ESLint `require-await` 的反向规则 + code review 保证。这是 D-10 的执行前提——一旦回调里出现 await，事务会在 await 点提交（better-sqlite3 的事务不跨微任务），所有原子性保证失效。

在 `run()` 的类型签名上用 `fn: (uow: UnitOfWork) => T` 且 `T` 不约束为非 Promise 是不够的，应显式禁止：

```ts
type NotPromise<T> = T extends Promise<unknown> ? never : T;
function run<T>(fn: (uow: UnitOfWork) => NotPromise<T>): T
```

这样在编译期就拦下 `run(async uow => ...)`。

### 5.5 事务边界清单

| 用例 | 事务内容 |
|---|---|
| 创建 Task | `INSERT task_snapshots` + `INSERT task_skill_snapshots × n` + `INSERT tasks` |
| 创建 Assignment | `INSERT executions` + `UPDATE tasks.active_execution_id` + `UPDATE slots.status='running'`（fill_slot 时）+ `INSERT trace_events × 2` |
| 提交 Structure | `INSERT slots × n` + `UPDATE executions` + `UPDATE tasks(phase='slots', active_execution_id=NULL)`（**条件 UPDATE，见下**）+ `INSERT trace_events` |
| 提交 Slot Content | 见 D-10 的条件 UPDATE + `UPDATE executions` + `UPDATE tasks` + `INSERT trace_events` |
| Stop | `UPDATE executions(status='cancelled')` + `UPDATE slots(running→pending)` + `UPDATE tasks(status='stopped', active_execution_id=NULL)` + `INSERT trace_events` |
| 完成 Artifact | `INSERT artifacts` + `UPDATE tasks(phase='done', status='completed', artifact_id)` + `INSERT trace_events` |
| 重置失败 Slot | `UPDATE slots(failed→pending, 清 error)` + `UPDATE tasks(status='running')` |
| 启动恢复 | 对每个 running task：`UPDATE executions(→cancelled)` + `UPDATE slots(running→pending)` + `UPDATE tasks(→stopped)` |
| 一次尝试失败收尾（M3-C 补） | `UPDATE executions(→failed, error_*)` + `UPDATE slots(running→pending)`（fill_slot 时）+ `UPDATE tasks(active_execution_id=NULL)` + `INSERT trace_events` |
| 重试配额耗尽（M3-C 补） | `UPDATE slots(→failed, error_*)`（fill_slot 时）+ `UPDATE tasks(status='failed', error_*)` + `INSERT trace_events` |

**为什么「失败收尾」与「配额耗尽」是两条边界而不是一条（M3-C 实施时定案）**

一次尝试失败有两个来路，它们对 execution 的处置**必须不同**：

- **提交路径自己失败**（结构 19 条校验没过 / 槽位确定性校验没过）：
  `StructureService.submit` 与 `CompletionService.submitSlotContent` 在被拒的那一刻
  就已经把 execution 收敛成 `failed`、把 `active_execution_id` 让了出来。
- **提交路径根本没走到**（超时 / Provider 报错 / 压根没提交）：
  此时库里那条 execution 还停在 `running`，没有任何人会去收它。

于是引擎的规则是：**只收尾那些还停在 `running` 的 execution**。判据取自库
（`executions.get(id).status === 'running'`），不取自错误码——按错误码分派意味着
每新增一个「提交路径内部失败」的码都要记得在引擎里加一行，漏了就会
`markFailed` 覆盖掉一条已经写好的失败原因，或者更糟：把一条 `cancelled`
（用户停止）盖成 `failed`，而「谁取消的」正是事后最想知道的一件事。

「配额耗尽」单独成一条边界的理由同上：耗尽时 execution 可能已经被提交路径收敛过了，
这条边界因此**完全不碰 executions**，只落任务级失败（对照
`StructureService.markExhausted` 与 `CompletionService.markSlotExhausted`）。

**「提交 Structure」也要走条件 UPDATE（M2 实施时补）**。原表只给「提交 Slot Content」点名了 D-10，但两条边界面对的是同一个风险：stop 事务插进读-判-写窗口，把一次已被取消的执行的结果照样写进库。结构提交漏判的后果更重——留下的是一棵不该存在的完整结构树，而不是单个槽位。因此 `tasks.phase='slots'` 这一步写成：

```sql
UPDATE tasks SET phase = 'slots', active_execution_id = NULL, updated_at = ?
 WHERE id = ? AND status = 'running' AND active_execution_id = ?   -- 结构 execution 的 id
```

`changes !== 1` → 抛 `EXECUTION_STALE`。`INSERT slots × n` 与本语句在同一事务内，抛错即整体回滚，槽位一个都不会留下。

（这里不需要 D-10 那样的完整 `EXISTS` 子句：结构 execution 的 `target_slot_id IS NULL`，没有槽位可串；`active_execution_id = ?` 已经同时覆盖了「token 所属的执行仍是当前执行」这一条。）

**Trace 写入在事务内还是事务外？** 在事务内。理由：UX §18.7 要求 Stopped 态「右栏说明旧 Execution 已取消」——如果 trace 在事务外写而事务回滚了，UI 会显示一个没有发生的事件。代价是 SSE 推送必须在事务提交**之后**触发，因此 `TraceService` 分两步：事务内 `insert`，事务返回后 `publish`。

---

## 6. Domain 层

Domain 层是纯函数集合，零 IO，零依赖。**这一层的测试覆盖率要求 100% 分支覆盖**——它编码了系统的全部不变量，且是唯一能在没有数据库和模型的情况下完整验证的部分。

### 6.1 `structure-validation.ts`

```ts
export type StructureRuleId =
  | 'EMPTY_STRUCTURE'      | 'TOO_MANY_SLOTS'
  | 'DUPLICATE_SLOT_ID'    | 'INVALID_SLOT_ID'
  | 'NO_ROOT'              | 'MULTIPLE_ROOTS'
  | 'ROOT_MUST_BE_CONTAINER'
  | 'PARENT_NOT_FOUND'     | 'PARENT_CYCLE'
  | 'DEPTH_EXCEEDED'       | 'DUPLICATE_ORDER'
  | 'UNKNOWN_SLOT_TYPE'    | 'MISSING_INSTRUCTION'
  | 'DEPENDENCY_NOT_FOUND' | 'SELF_DEPENDENCY'
  | 'DEPENDENCY_CYCLE'     | 'DEPENDENCY_ON_CONTAINER'
  | 'NO_CONTENT_SLOT';

export interface StructureViolation {
  rule: StructureRuleId;
  message: string;     // 给人看
  agentHint: string;   // 给 Agent 看，可执行（D-13）
  slotIds: string[];
}

export type StructureValidationResult =
  | { ok: true;  slots: ValidatedSlot[] }
  | { ok: false; violations: StructureViolation[] };

export function validateConcreteStructure(
  proposal: { rootSlotId: string; slots: SlotProposal[] },
  template: CompiledTemplate,
): StructureValidationResult;
```

**19 条规则与 REQ FR-STR-004 的对应关系**（第 19 条 `rootSlotId` 一致性为本文档新增）：

> **19 条规则、18 个 `StructureRuleId`（D-19 澄清）**：第 19 条复用第 6 条的 `NO_ROOT`，
> 因为「声明的根不存在」与「没有根」对 Agent 是同一件事、同一种修法，
> 拆成两个码只会让重试提示里出现两条读起来一样的违规。
> 凡是写「18 条」的地方都是笔误——规则数是 19，枚举值数是 18，两者本就不必相等。

| # | REQ 条款 | RuleId | agentHint 示例 |
|---|---|---|---|
| 1 | Slot 数量 > 0 | `EMPTY_STRUCTURE` | 结构中至少需要一个根容器槽位和一个内容槽位。 |
| 2 | 不超过上限 | `TOO_MANY_SLOTS` | 当前提交 40 个槽位，上限 32。请合并粒度过细的场景段。 |
| 3 | ID 唯一 | `DUPLICATE_SLOT_ID` | 槽位 ID「scene_01」出现了 2 次。每个槽位需要唯一 ID。 |
| 4 | ID 安全字符 | `INVALID_SLOT_ID` | （由 Zod 在解析层拦截，见 §3.4） |
| 5 | 只有一个根 | `MULTIPLE_ROOTS` | 「chapter」和「appendix」的 parentId 都是 null。只能有一个根槽位，其余需挂到根之下。 |
| 6 | 根 parentId=null | `NO_ROOT` | 所有槽位都有 parentId，缺少根槽位。请将最外层容器的 parentId 设为 null。 |
| 7 | Parent 存在 | `PARENT_NOT_FOUND` | 槽位「scene_02」的 parentId「chapter_x」不存在。请改为已声明的槽位 ID。 |
| 8 | Parent 无环 | `PARENT_CYCLE` | 槽位「a」→「b」→「a」形成父子环。父子关系必须是一棵树。 |
| 9 | 深度不超上限 | `DEPTH_EXCEEDED` | 槽位「x」处于第 5 层，上限 4 层。请压平层级。 |
| 10 | 同级 order 唯一 | `DUPLICATE_ORDER` | 「chapter」下的「scene_01」和「opening」order 都是 1。同一父节点下 order 必须唯一。 |
| 11 | 类型在允许范围 | `UNKNOWN_SLOT_TYPE` | 槽位「x」的 type「summary」不在模板允许范围。可用类型：chapter, title, opening, scene, emotional_closure, chapter_end。 |
| 12 | 根必须非内容承载 | `ROOT_MUST_BE_CONTAINER` | 根槽位「title」的类型是内容承载类型。根槽位必须使用容器类型（chapter）。 |
| 13 | 内容槽有非空 instruction | `MISSING_INSTRUCTION` | 槽位「scene_02」缺少 instruction。每个内容槽位都需要说明本槽位要完成什么。 |
| 14 | dependsOn 引用存在 | `DEPENDENCY_NOT_FOUND` | 槽位「scene_02」依赖「scene_00」，但该槽位不存在。 |
| 15 | 不依赖自身 | `SELF_DEPENDENCY` | 槽位「scene_02」的 dependsOn 包含自己。请移除。 |
| 16 | 依赖无环 | `DEPENDENCY_CYCLE` | 「scene_01」→「scene_02」→「scene_01」形成依赖环。依赖必须是有向无环图。 |
| 17 | 只依赖内容槽 | `DEPENDENCY_ON_CONTAINER` | 槽位「scene_02」依赖「chapter」，但 chapter 是容器槽位。dependsOn 只能引用内容承载槽位。 |
| 18 | 至少一个内容槽 | `NO_CONTENT_SLOT` | 结构中全部是容器槽位，没有任何内容槽位，无法产出正文。 |
| 19 | rootSlotId 一致 | `NO_ROOT` | 声明的 rootSlotId「chapter」在 slots 中不存在或其 parentId 不为 null。 |

**校验顺序要求**：先做「引用完整性」类（3/5/6/7/11/14/15），再做「图性质」类（8/16/9），最后做「语义完备」类（12/13/17/18）。理由是环检测在存在悬空引用时会误报，必须先确保引用都能解析。

**一次返回全部违规，不短路。** 只报第一条会让 Agent 陷入「改一条冒出下一条」的循环，白白消耗重试配额。

**提交被拒 ≠ 本次 Assignment 结束（D-20，M3-C 接线时发现）**

这条以前没写明，两处实现因此各自作了不同的假设，接起来就死锁了。定案：

> **被确定性校验拒绝的提交，只写 trace，不收敛 execution、不让出 `active_execution_id`。**
> 一次 Assignment 何时结束，只由 ProductionEngine 决定。

理由是这套设计里本来就有**两层**反馈，它们服务于不同的失败：

| | 触发 | 反馈载体 | 代价 |
|---|---|---|---|
| **同一次 Assignment 内** | 提交被校验拒 | 工具结果（`isError: false`，正文是三段式违规） | 几百 token，模型带着全部上下文增量修正 |
| **跨 Assignment（重试）** | 超时 / Provider 错 / 一次都没提交 / 会话内改不对 | §7.4 的重试追加块 | 一次完整 attempt，消耗 `maxRetries` |

第一层是 D-11 的直接推论：`SubmissionGate` **只在成功时关闭**——这是刻意的，
意思就是「被拒之后你还可以再试」。而 §7.5 让被拒的提交返回一个 `isError: false`
的工具结果、正文是可执行的 `agentHint`，也只有在会话还能继续时才有意义。

原先 `StructureService.submit` / `CompletionService.submitSlotContent` 在被拒路径上
顺手 `markFailed` 并把 `active_execution_id` 置空，于是模型照着违规提示改好、
在同一轮对话里重新提交时，D-10 的 WHERE 子句发现活动执行已经没了，
返回 `EXECUTION_STALE`——**一个本该被接受的正确结构，被系统自己判成了迟到结果**。
表现是「模型第一次写错就再也救不回来」，而每次重试都要烧掉一整个 attempt。

配套约束：会话内的重复提交由 `maxToolCallsPerAssignment` 兜底，不会无限循环。

### 6.2 `readiness.ts`

```ts
export function computeDepth(slots: Slot[]): Map<string, number>;
export function documentOrder(slots: Slot[]): Slot[];      // 深度优先，稳定
export function deriveReadySlots(slots: Slot[]): Slot[];
export function selectNextReadySlot(slots: Slot[]): Slot | null;
export function allContentSlotsCompleted(slots: Slot[]): boolean;
export function detectDeadlock(slots: Slot[]): DeadlockInfo | null;
export function blockedBy(slot: Slot, slots: Slot[]): string[];  // D-07 用
```

**`documentOrder` 的稳定排序**（REQ FR-SCH-002）：

```
从根开始深度优先前序遍历
同一父节点下的子节点按 (sort_order, slot_id) 升序
```

`slot_id` 作为最终 tiebreaker，保证即使 order 重复（理论上被校验挡住）也有确定结果。

`selectNextReadySlot` = `documentOrder(slots).find(s => isReady(s))`。用文档序而非依赖拓扑序，是因为 REQ FR-SCH-002 明确要求「文档树深度优先顺序 → 同级 order → Slot ID 字典序」。这两者可能不同：一个文档序靠前但依赖未满足的槽位会被跳过，选中靠后的。

**`detectDeadlock`**：存在 pending 内容槽 且 无 ready 槽 且 无 running 槽 且 无 failed 槽 → 死锁。返回涉及的槽位 ID 供报错定位。正常情况下依赖环在结构提交时已被拒，此函数用于保护异常数据（REQ FR-SCH-004）。

### 6.3 `assembly.ts`

```ts
export function assembleMarkdownConcatV1(slots: Slot[]): string;
```

规则（REQ FR-ASM-002 + D-16）：

1. 从 `rootSlotId` 起深度优先前序遍历，同级按 `(sort_order, slot_id)` 升序
   （与 `documentOrder` 同序）
2. 遇到 `includeInArtifact === false` 的槽位，**整棵子树跳过**（D-16 / D-18 子树语义）
3. 遇到 `contentBearing === false` 的容器槽位，本身不产出内容，继续下钻子节点
4. 其余槽位取 `content_text`
5. 用 `'\n\n'` 连接
6. **不改写槽位内容的语义**：不重排、不缩进、不补标题、不做 Markdown 规范化
7. 只做两类字节级归一化：行尾统一为 `\n`（含孤立 `\r`）、首尾 `trim`；输出为 UTF-8

第 2 步在第 3 步之前，是子树语义的全部实现——顺序反了就退化成「只跳自己」。

> **第 6 / 7 条原本自相矛盾（D-19 修订）**：原文第 6 条写「不做任何 trim 以外的处理」，
> 第 7 条又要求「行尾统一为 `\n`」——CRLF 归一化正是 trim 以外的处理。
> 按 AC-013 的确定性要求，归一化必须做（`\r\n` 来自模型输出，不归一化会让
> 同一内容在不同次运行产出不同字节）。所以第 6 条的真实意图是**语义**不改写，
> 不是**字节**不改写，已照此重写。

**空产物的处理**：本函数在无内容可拼时返回 `''`（而不是按第 7 条字面追加一个孤零零的 `\n`）。
但**空产物本身是错误**——结构校验规则 18 保证了至少有一个内容槽位，
所以产出为空只可能是 `includeInArtifact` 配置把内容槽位全排除了。
**assembly-service（M2）必须拒绝空产物并报错**，不能写一个 0 字节的 artifact 进库。
判断放在 service 而不是这里，是为了让本函数保持纯粹的「拼接」语义。

**确定性要求（AC-013）**：相同输入必须产出逐字节相同的输出。实现上需注意：
- 对每个槽位内容做 `content.replace(/\r\n/g, '\n').trim()`——`\r\n` 可能来自模型输出，不归一化会导致同一内容在不同次运行产出不同字节
- 末尾追加一个 `\n`（POSIX 文本文件惯例），保证 checksum 稳定

```ts
const checksum = 'sha256:' + createHash('sha256').update(buf).digest('hex');
```

### 6.4 `state-machine.ts`

把 REQ §19.1/§19.2 的状态机编码为纯函数，而非散落在各 service 的 if 判断：

```ts
export type TaskAction = 'start' | 'stop' | 'resume' | 'retry'
                       | 'complete' | 'fail' | 'enqueue';

export function canTransition(from: TaskStatus, action: TaskAction): boolean;
export function nextTaskStatus(from: TaskStatus, action: TaskAction): TaskStatus;
export function assertTransition(from: TaskStatus, action: TaskAction): void;
                        // 不合法则抛 ForgeError('TASK_STATE_INVALID')
```

允许的迁移：

```
ready     → start  → running
running   → stop   → stopped
running   → fail   → failed
running   → complete → completed
stopped   → resume → running
failed    → retry  → running
completed → (终态，无迁移)
```

`start` 对 `stopped`/`failed` 不合法——它们分别用 `resume`/`retry`。API 层把 `POST /start`、`/resume`、`/retry` 映射到不同 action，前端按 `status` 显示不同按钮文案（UX §9.1 的按钮表）。

槽位状态机同理：

```
pending   → schedule    → running
running   → commit      → completed
running   → exhaust     → failed
running   → cancel      → pending      （stop / 重启恢复）
failed    → reset       → pending      （retry）
completed → (终态)
```

### 6.5 `presentation.ts`（D-07）

完整派生规则见 §附录 B。函数签名：

```ts
export interface SlotPresentationInput {
  slot: Slot;
  allSlots: Slot[];
  activeAttempt: number | null;
  /** 已成文的失败原因，由 lifecycle 层写好。派生层不解析、不拼装 */
  lastFailureReason: string | null;
  elapsedMs: number | null;
  // ↓ D-18 补：附录 B.2 第 2 行「已停止」用到这两个输入，
  //   原签名里没有，导致该规则无法实现。
  taskStatus: TaskStatus;
  isInterruptionPoint: boolean;
  // ↓ D-19 补：第 6 行的 {agentName}。slot.producer 在 running 期间恒为 null，
  //   所以这个值只能由调用方从当前 execution 解析后传入。必填，不给默认值。
  agentName: string | null;
}
```

**已从签名中删除 `isActiveExecution`（D-19）**：附录 B.2 的 8 行没有任何一行用到它。
留着一个谁都不读的输入，下一个人会以为它有意义并试图去满足它。
如果将来 B.2 真的需要区分「running 但不是当前活动执行」（重启恢复中的孤儿态），
那应该先往规则表里加行，再往签名里加参数——**顺序不能反**。

```ts

export function deriveSlotPresentation(
  input: SlotPresentationInput
): Presentation & { blockedBy: string[]; charCount: number | null };

export interface TaskPresentationInput {
  task: Task;
  slots: Slot[];
  activeExecution: Execution | null;
  currentSlotTypeName: string | null;
  queuePosition: number | null;
  // ↓ D-19 补：B.1 第 3 / 5 行的「上次{lastFailureReason}」。
  //   与槽位级同源同语义：由 lifecycle 写成完整中文，派生层原样取用。
  //   不复用 task.errorMessage：后者是**终态**失败原因（第 10–12 行用），
  //   重试中的任务 status 仍是 running，两者的生命周期不同，混用会串味。
  lastFailureReason: string | null;
}

export function deriveTaskPresentation(
  input: TaskPresentationInput
): Presentation;
```

**文案质量约束**（写入代码注释与 review checklist，来自 `组件状态变体.dc.html` 的 note 字段）：

- 「等待依赖」的 detail **必须点名在等谁**：`等待 scene_03 定稿`，不是 `依赖未满足`
- 「已完成」的 detail **必须给可核对的事实**：`1,486 字 · 校验通过`，不是 `生成成功`
- 「超时重试」的 detail **必须同时给重试计数与上次失败原因**：`第 2 次尝试 · 上次 180 秒超时`
- 「结构校验失败」的 detail **必须并列判据与实收值**：`要求恰好 3 个场景，实收 2 个`
- 「已停止」的措辞**不带错误感**：`运营手动停止 · 可从此处续跑`

这些不是文案偏好，是「用户能否在不翻轨迹的情况下判断要不要介入」的功能要求。

### 6.6 `canonical.ts`

```ts
export function canonicalJson(value: unknown): string;
export function sha256Hex(input: string): string;
```

`canonicalJson` 规则（TECH-V0.1 §6.2）：
- 对象 key 按 Unicode 码点升序
- 数组保持原顺序
- `undefined` 与函数值剔除
- 数字用 `JSON.stringify` 默认表示
- 不加空白

用于 `templateHash` / `snapshotHash` / `contextHash`。**必须有一条测试断言 key 顺序不同的两个等价对象产出相同字符串。**

---

## 7. Runtime 层

### 7.1 整体时序

```
LifecycleService.start / resume / retry      [事务] 状态迁移走 domain/state-machine
  └─ ProductionEngine.enqueue(taskId)         D-14 单槽互斥 + FIFO，第二个任务排队
       └─ ProductionEngine.tick(taskId)       取得互斥后推进这个任务直到收敛
            └─ SlotScheduler.selectNext()     structure / slot / assembly / failed / running
            └─ AssignmentService.create(task) [事务] 建 Execution，标记 slot running
                 └─ ContextBuilder.build(...) 纯函数，产出 systemText/userText/hashes
                      └─ AssignmentRunner.run(assignment)
                           ├─ ProviderRegistry.resolve(modelAlias) → { adapter, model }
                           ├─ buildToolset(assignment, gate)
                           ├─ AgentRuntime.loop(...)   工具循环，最多 maxToolCallsPerAssignment
                           │    ├─ onTextDelta   → TraceService.bufferOutput()
                           │    └─ onToolCall    → 工具 handler
                           │         └─ complete_assignment
                           │              └─ CompletionService.submit()  [事务] D-10
                           │                   └─ gate.close() + abort()
                           └─ 收敛：succeeded / failed / cancelled
            └─ 引擎收尾：execution 仍 running 才收（§5.5「一次尝试失败收尾」）
            └─ 循环推进下一槽位；全部内容槽完成 → AssemblyService.assemble()
```

**「递归推进」在实现上写成循环。** 语义相同，但 32 个槽位 × 3 次尝试的真递归会把
整条失败链路压进一个上百层的栈——排查时看到的是被截断的堆栈，而不是出问题的那一层。
更要紧的是循环让「一次 `tick` 从头到尾持有互斥」成为结构性事实：递归实现里
每一层都要自己记得没有释放互斥，而只要有一层忘了，NFR-001 的全局串行就破了。

**`tick(taskId)` 是「把这个任务推进到收敛」，不是「推进一步」。** 重试配额按
**本轮调度**计（见 §8.7），配额计数器是 `tick` 的局部变量；做成「推进一步」的话，
每调用一次配额就重置，一个反复超时的槽位会被无限重试。

### 7.2 `ProviderRegistry`（D-03）

```ts
interface ResolvedModel {
  alias: string;           // ← M3-A 补：executions.model_alias 要写它，解析结果本身不含来源就没法追溯
  providerId: string;
  model: string;
  adapter: ProviderAdapter;
  apiKey: string;          // 从 process.env[provider.apiKeyEnv] 读，不落库不入 trace
}

class ProviderRegistry {
  resolve(alias: string): ResolvedModel;   // 未配置 → MODEL_ALIAS_UNRESOLVED
  async probe(providerId: string): Promise<ProviderHealth>;
  getHealth(providerId: string): ProviderHealth;
  recordRateLimit(providerId: string): void;
}
```

**`apiKey` 声明为不可枚举属性（M3-A 实现约定）**：`Object.defineProperty(..., { enumerable: false })`。
于是 `JSON.stringify(resolved)` 与 `{...resolved}` 都带不出密钥。
这挡不住显式读 `resolved.apiKey`（也不该挡），挡的是最常见的那种事故——
有人图省事把整个对象塞进 `logger.info` 或 trace payload。

`resolve()` 在**每次 Execution 创建时调用一次**，结果写入 `executions.provider` / `executions.model`。同一 Assignment 的重试会重新解析——这是 late-bound 的直接后果，也是它的价值。

**启动时行为**：加载 `providers.yaml`，对每个 provider 检查 `process.env[apiKeyEnv]` 是否存在。缺失则该 provider 标记为 `down`，note 为「环境变量 XXX 未配置」，映射到它的别名在 `resolve()` 时抛 `PROVIDER_UNAVAILABLE`。**不阻止服务启动**——UX 要求 Provider 设置页能显示「未连通」状态，服务必须能起来才能显示。

### 7.3 `ProviderAdapter`

```ts
interface ProviderAdapter {
  runTurn(input: {
    model: string;
    apiKey: string;
    system: string;
    messages: ProviderMessage[];
    tools: ProviderToolDefinition[];
    maxTokens: number;
    signal: AbortSignal;
    onTextDelta: (delta: string) => void;
    onToolCall: (call: ProviderToolCall) => Promise<ProviderToolResult>;
  }): Promise<ProviderTurnResult>;
}

interface ProviderTurnResult {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted';
  usage: { inputTokens: number; outputTokens: number } | null;
  /** 本轮结束后应追加到 messages 的内容（assistant 回复 + 各 tool 结果） */
  appendMessages: ProviderMessage[];        // ← M3-A 修订，理由见下
}
```

**`appendMessages` 是 M3-A 补上的（原文缺，导致 §7.6 无法实现）**

原 `ProviderTurnResult` 只有 `stopReason` 与 `usage`，而 §7.6 的循环写的是
`messages.push(...buildToolResultMessages(turn))`——那个函数**写不出来**：
`turn` 里既没有 assistant 消息，也没有各次 tool call 的结果与它们的 `id`，
而 tool call 的 id 是 Provider 分配的，只有 adapter 手里有。
把「本轮该追加什么」作为 turn 的产出返回，循环层原样 push 即可，
provider 特有的消息形状（Anthropic 的 `tool_result` block vs OpenAI 的 `role:'tool'` 多条）
也就留在了它该在的一层。

`ProviderMessage` 同时定案为**与 Provider 无关**的中性形状：

```ts
type ProviderMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ProviderToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; content: string; isError: boolean };
```

`ProviderToolCall.name` 是 `string` 而**不是** `ToolName`：模型输出是不可信输入，
把它写成 `ToolName` 等于在类型层面假装模型不会拼错工具名，
而 D-11 明确要求分发器兜住未知工具名。收窄发生在分发器里。

**流式 tool call 的累积**是两个适配器都必须正确处理的地方，也是最容易出 bug 的地方：

- **Anthropic**：`content_block_start`（含 tool name 与 id）→ 若干 `content_block_delta` 的 `input_json_delta.partial_json` 字符串片段 → `content_block_stop`。必须把 partial_json 拼接完整后再 `JSON.parse`，中途解析必然失败。
- **OpenAI-compatible**：`choices[0].delta.tool_calls[]` 数组，每个元素带 `index`。同一 index 的 `function.arguments` 片段要按到达顺序拼接。**注意 `id` 和 `function.name` 通常只在第一个片段出现**，后续片段只有 arguments。

两者都要求：**一个 turn 内可能有多个 tool call**。收到 `stopReason === 'tool_use'` 后，把所有 tool call 的结果作为一条 `role: 'user'`（Anthropic 用 `tool_result` content block；OpenAI 用 `role: 'tool'` 多条消息）回灌，进入下一轮。

**分片 schema 必须容忍 `null`，不只是容忍缺省（接入 OpenCode Go 时的根因）**

原文说「`id` 和 `function.name` 通常只在第一个片段出现」，实现照此写成
`z.string().optional()`。**但「只在第一片出现」有两种表达方式**，
而 `.optional()` 只接受其中一种：

| Provider | 续传分片里的 `name` | `.optional()` |
|---|---|---|
| DeepSeek 官方 | 字段**缺省** | ✅ 通过 |
| OpenCode Go | 显式 `"name": null` | ❌ **拒绝** |

后果被 `parseChunk` 失败即 `continue` 的写法**放大成静默数据丢失**：
schema 不过 → 整个分片被丢弃 → 连同它携带的 `arguments` 碎片一起丢 →
拼出来的参数是空串。

现场表现（接入 OpenCode Go 第二跑，107 条 trace）：

```
40x  read_skill_section   参数不合法：sectionId: Required
 5x  report_work          参数不合法：type: Required；summary: Required
 1x  read_structure_outline 失败
 2x  read_task_input      ✅ 成功  ← 唯一一个不需要参数的工具
```

**只有不需要参数的工具能成功**——这个分布本身就是诊断书。
而现象在上层看起来完全是另一回事：「模型烧掉 24 次工具调用也不提交」，
像是模型能力问题（D-17 早就写了这个风险，因此更容易被误判成它）。

**处置**：tool call 分片的 `id` / `name` / `arguments` 一律用 `.nullish()`。
同一个文件里 `content` 与 `finish_reason` 本来就是 `.nullish()`——
这条教训学过一次，只是没应用到 `tool_calls` 上。

**更深的一条，已处置（Q-26）**：`parseChunk` 失败即 `continue` 曾意味着
**schema 与真实响应不匹配时，唯一的表现是数据凭空少了一块，没有任何信号**。
这次是靠「只有无参工具能成功」这个特征分布反推出来的，而不是靠任何报错。

现在适配器会累计被丢弃的分片，**一轮结束统一上报一次**，
走 Q-21 建好的内部错误通道（生产是带 redact 的 pino，测试是 stderr）：

```
[provider:deepseek] 流式分片被丢弃 137 个（model=deepseek-chat）：
schema:choices.0.delta.tool_calls.0.function.name:invalid_type ×137。
这通常意味着响应形状与 StreamChunkSchema 对不上——后果是数据静默少一块，不是报错。
```

三条设计约束，每条都有测试：

1. **只报形状，不报内容。** 上报里只有字段路径与 Zod 的 issue `code`，
   没有任何分片内容——分片里可能有 `reasoning_content` 与正文，
   而诊断是要进日志的（REQ §13）。特别地**不能用 `issue.message`**：
   某些 code（如 `invalid_enum_value`）会把收到的**值**拼进 message。
2. **按形状归并，不逐条刷屏。** schema 一旦对不上，坏的往往是每一个分片；
   逐条报会刷出几百行，结果是没人看——等于没报。
3. **不抛异常。** 一个无关紧要的字段变化不该打断正在跑的生产。
   目标是让「悄悄少了一块数据」留下痕迹，不是让它变成故障。

另有一条同样重要的负向判据：**一切正常时一个字都不报**。
噪音会让这个信号被忽略，那它就白加了。已实测：真实链路跑完整章，日志零条。

**回灌时 `arguments` 必须是合法 JSON 文本（接入 OpenCode Go 时实测发现的潜伏 bug）**

原文只说了「怎么把碎片拼起来交给分发器」，没说**拼出来的东西回灌时长什么样**。
实现里是原样回传（`function: { arguments: call.argumentsJson }`），
于是模型发一个**参数为空**的 tool call 时，我们回灌的是 `arguments: ""`——
而空字符串不是合法 JSON。

真实事故（接入 OpenCode Go 首跑）：

```
seq 6  tool_call_started    read_skill_section   argumentsLength: 0   ← 模型发了空参数
seq 7  tool_call_completed  被拒绝：sectionId: Required               ← 分发器正确拒绝
seq 8  assignment_failed    HTTP 400: Assistant tool call
                            function.arguments must be valid JSON     ← 回灌时被网关拒
```

**为什么它一直没被发现**：DeepSeek 官方端点**容忍** `arguments: ""`，
照常返回 200。M4/M5/M7 全程只对着 DeepSeek 官方跑，这条路径从来没被拒过。
换一个严格校验的网关（OpenCode Go）立刻暴露。

**为什么它比看上去严重**：那条坏消息会**留在对话历史里**。
一旦进去，后面每一次请求都带着它，于是每次重试都以完全相同的方式失败——
现象是任务卡在 `running` 无限重试，而错误信息指向 Provider，看起来像是对方的问题。

**处置**：在**序列化边界**归一化，不在累积器里归一化。

- 累积器保持原样（拿到什么记什么）——分发器必须看到模型**真实**产出的东西才能正确拒绝，
  在累积阶段就补成 `{}` 会让「模型没给参数」这件事对分发器不可见，
  于是 `sectionId: Required` 这条正确的反馈也就没了。
- 只在拼 wire 消息那一步：`arguments` 为空或 parse 不过 → 回灌 `"{}"`。

语义上不算篡改：模型已经通过 tool result 收到了「参数不合法」的准确反馈，
`{}` 与 `""` 表达的都是「没给参数」，区别只是后者不合法、会让整段对话永久失效。

**中止语义**：`signal.aborted` 后立即 `reader.cancel()` 并 return `{ stopReason: 'aborted' }`，不抛异常。抛异常会与超时/取消的错误处理路径混淆。

**429 处理**：适配器内部**不做重试**，直接抛 `ForgeError('PROVIDER_RATE_LIMITED')` 并附带 `Retry-After`（如有）。退避重试由 `AssignmentRunner` 统一处理（见 §8.5），保证退避期间也能被 stop 中止。

**`maxTokens` 的来源：P0 由引擎派生，不进配置（M3-C 定案，M4 复议）**

`runTurn` 要 `maxTokens`，而 `ExecutionDefaults`（§4.2）与 `template.yaml` 的 `limits`
里都没有它（Q-11 第 1 条）。M3-C 不在这两处单点加一个字段——那会与
`maxToolCallsPerAssignment` 的缺口（Q-09）各自演化成两套回退链，
而 Q-09 已经写明「要给它全局默认就三处同改，不要单点加」。

P0 的处置是由 `ProductionEngine` **从已有的约束派生**：

```
fill_slot：      maxChars === null ? 上限 : clamp(maxChars × 2 + 1024, 下限, 上限)
create_structure：上限
下限 4096 / 上限 16384
```

派生而不是取常量的理由：这个数的**唯一**作用是「别让模型在写到一半时被截断」，
而「最多该写多少」这件事模板已经用 `validation.maxChars` 说过一遍了。
取一个与模板无关的常量，等于让一个 400 字的标题槽和一个 8000 字的场景槽
拿到同一个上限——前者浪费额度，后者可能不够。系数 2 是「一个汉字最坏约 2 token」的
保守估计，`+1024` 留给工具调用的 JSON 包装。

**这不是最终方案**：它猜的是分词器的行为，而分词器随 Provider 变。
M4 接真实 Provider 时应当把它挪进 `ExecutionDefaults`（则 §4.2 / `providers.yaml` /
`ExecutionDefaultsSchema` 三处同改）或模板 `limits`，与 `maxToolCallsPerAssignment`
一起定，**不要单点加**。在那之前，这个派生式是唯一取值来源，
写成 `resolveMaxTokens()` 一个导出函数以便一处改完全部生效。

### 7.4 `ContextBuilder`

#### Structure Context

System Message：

```
【平台边界】
你是 Forge Core 内容生产平台上的一个 Agent。
你的产出通过工具提交，系统负责保存、推进状态和组装产物。
你不能宣布任务完成，不能修改系统状态，不能选择自己的工作对象。

【你的身份】
{agent.name} — {agent.role}
{agent.systemInstruction}

【当前工作】
Operation: create_structure
你需要为本次任务设计具体的内容结构。

【工作方法】{skill.id} v{skill.version}
{skill.summary}
{skill.preamble}
{requiredSections 全文}

其余章节可用 read_skill_section 按需读取：
{sectionIndex 的 id + title 列表}

【工具】
read_task_input     读取冻结的任务输入
read_skill_section  按 Section ID 读取本 Skill 的其他章节
report_work         发布可公开的工作说明（不影响产出，用于让用户看到你的思路）
complete_assignment 唯一的正式提交动作

【提交规则】
只有 complete_assignment 会保存结果。
提交后本次工作立即结束，后续输出不会被保存。

【禁止】
不得决定每个槽位使用哪个 Agent 或 Skill——那由模板绑定决定。
不得设置任何槽位或任务的状态。
不得在提交结构的同时撰写正文。
```

User Message：

```
【任务输入】（已冻结）
{每个 inputField 的 label + 值}

【可用槽位类型】
{每个 slotType：id / name / description / contentBearing / 字数区间 / guidance}

【结构限制】
最多 {maxSlots} 个槽位
最大层级深度 {maxStructureDepth}
必须恰好一个根槽位，且根槽位必须是容器类型
至少一个内容承载槽位

【输出契约】structure_proposal_v1
调用 complete_assignment，参数形如：
{
  "kind": "structure",
  "rootSlotId": "chapter",
  "slots": [
    { "id": "chapter", "type": "chapter", "parentId": null, "order": 0,
      "instruction": "整章容器", "dependsOn": [] },
    { "id": "opening", "type": "opening", "parentId": "chapter", "order": 1,
      "instruction": "从……切入，建立……", "dependsOn": [] }
  ]
}

字段说明：
- id：小写字母开头，只含小写字母/数字/下划线，全局唯一
- parentId：根槽位为 null，其余指向已声明的槽位
- order：同一父节点下不可重复
- instruction：这个槽位要完成什么内容目标。内容槽位必填且不可为空
- dependsOn：本槽位开始生产前必须已完成的槽位。只能引用内容承载槽位，不能成环
```

**重试时追加块**（D-13）：

```
【上一次提交未通过校验】

你上次提交的结构：
{上次 proposal 的 JSON，原样回灌}

系统校验发现以下问题：

1. [DEPENDENCY_ON_CONTAINER] 槽位「scene_02」依赖「chapter」，但 chapter 是容器
   槽位。dependsOn 只能引用 contentBearing 为 true 的槽位。请改为引用具体的内容
   槽位，或删除该依赖。

2. [DUPLICATE_ORDER] 「chapter」下的「scene_01」和「opening」order 都是 1。同一
   父节点下 order 必须唯一。

请修正后重新提交完整结构。系统不保存部分结构，本次需要提交全部槽位。
这是第 {attempt} 次尝试，共 {maxRetries + 1} 次机会。
```

回灌上次提案的理由：让模型做**增量修正**而不是重新设计。重新设计大概率引入新的违规。

#### Fill Slot Context

System Message 结构相同，`【当前工作】`段改为：

```
Operation: fill_slot
目标槽位: {slot.id}（{slotType.name}）
你只能为这一个槽位撰写内容。提交其他槽位的内容会被系统拒绝。
```

User Message：

```
【任务输入】（已冻结）
{...}

【结构概要】
（只含 id / type / parent / order / instruction / dependsOn / status，不含正文）
chapter [容器]
├─ title           [已完成]
├─ opening         [已完成]
├─ scene_01        [已完成]
├─ scene_02        [已完成]
├─ scene_03        [← 当前槽位]  依赖: scene_02
├─ emotional_closure [等待]      依赖: scene_03
└─ chapter_end     [等待]        依赖: emotional_closure

【本槽位目标】
{slot.instruction}

【本类型的写作要求】
{slotType.guidance 逐条}

【依赖槽位内容】
以下是本槽位显式声明依赖的槽位的正文。其他槽位的正文不在你的上下文中。

── scene_02 ──
{scene_02 的完整 content}

【内容限制】
字数 {minChars} – {maxChars}
{forbidPatternMessage，如有}

【输出契约】slot_content_v1
调用 complete_assignment：
{ "kind": "slot_content", "slotId": "scene_03", "content": "……" }

content 为本槽位的正文，不要包含槽位标题或编号，不要包含对其他槽位的引用说明。
```

**结构概要用树形字符文本而非 JSON**：模型对缩进树的空间理解优于嵌套 JSON，且 token 更省。这是 REQ FR-CTX-003 允许的范围内的呈现选择。

#### 确定性保证

`ContextBuilder` 必须是纯函数：

```ts
function buildContext(input: ContextInput): BuiltAssignmentContext
```

`ContextInput` 只包含：snapshot、taskInput、slots、targetSlot、dependencyContents、skillSnapshot、attemptNumber、lastViolations。**不接受 Date.now()、不接受随机数、不读环境变量。** 时间戳等非确定内容一律不进 context。这保证 REQ NFR-004「上下文可重建」与 FR-CTX-006「相同状态相同 Hash」。

### 7.5 工具实现

`buildToolset` 按 Assignment 创建闭包，权限在闭包里冻结（TECH-V0.1 §13）：

```ts
export function buildToolset(ctx: {
  taskId: string;
  operation: 'create_structure' | 'fill_slot';
  targetSlotId: string | null;
  allowedDependencySlotIds: readonly string[];
  skillSnapshot: SkillSnapshot;
  taskInput: Readonly<Record<string, string>>;
  executionId: string;
  executionToken: string;
  gate: SubmissionGate;
  // ↓ M3-A 修订：依赖倒置。runtime 声明 port，application 提供实现
  trace: TraceWriter;          // 包着 TracePort，写入前统一过 TracePayloadSchema
  completion: CompletionPort;
  structure: StructurePort;    // read_structure_outline / read_slot 的数据来源
  onSubmitted: () => void;     // 提交成功：gate.close() + abort()（D-11）
  onRejected: (r: SubmissionRejection) => void;  // 提交被拒：攒违规给下一次 attempt（D-13）
}): ToolDefinition[];
```

**为什么改成 port 而不是直接收 `TraceService` / `CompletionService`（M3-A）**

§7.1 的时序里 Runtime 夹在 `AssignmentService`（在它上面）与 `CompletionService`
（在它下面）之间，两个方向都指向 `application/`。直接 import 会让两层互相引用，
后果是「跑一次工具循环」必须把整个数据库层拖起来——而 §11.1 明确要求
Runtime 集成测试「无网络、可控时序」。因此 `runtime/ports.ts` 声明
`TracePort` / `CompletionPort` / `StructurePort` / `SnapshotReadPort` 的最小签名，
接线由组合根完成，形状对不上时写适配器。

`CompletionPort.submit` **用返回值而不是异常表达「被拒」**：结构校验失败是预期内的
业务结果（D-13 要求把违规回给 Agent 增量修正），而异常在这条链路上还要同时承载
「数据库炸了」。混在一个 catch 里，迟早有人把 `SQLITE_BUSY` 当成校验失败喂给模型。

关键点：`read_slot` 的权限判断**不看模型传的参数是否"合理"，只看是否在 `allowedDependencySlotIds` 里**：

```ts
async function readSlot({ slotId }: { slotId: string }) {
  gate.assertOpen('read_slot');
  if (!ctx.allowedDependencySlotIds.includes(slotId)) {
    throw new ForgeError('TOOL_NOT_ALLOWED',
      `slot「${slotId}」不在当前槽位的依赖中。` +
      `可读取：${ctx.allowedDependencySlotIds.join(', ') || '（无）'}`);
  }
  // ...
}
```

`read_structure_outline` 在 `operation === 'create_structure'` 时直接抛 `TOOL_NOT_ALLOWED`（结构还不存在）。

**工具错误的处理方式**：工具抛出的 `ForgeError` **不中断工具循环**，而是作为 `tool_result` 的错误内容回给模型，让它自己修正。只有以下情况中断循环：
- 超时
- 中止
- 工具调用次数超限
- `complete_assignment` 成功（正常结束）

理由：模型第一次调 `read_slot('scene_01')` 被拒后，看到错误消息里列出了可读列表，通常能立刻改对。直接失败会浪费一次完整的 attempt。

### 7.6 `AgentRuntime` 工具循环

```ts
async function loop(a: Assignment, gate: SubmissionGate): Promise<LoopResult> {
  const messages: ProviderMessage[] = [{ role: 'user', content: a.userText }];
  let toolCalls = 0;

  for (;;) {
    const turn = await adapter.runTurn({
      system: a.systemText, messages, tools, signal: a.signal,
      onTextDelta: d => trace.bufferOutput(a.executionId, d),
      onToolCall: async call => {
        if (++toolCalls > a.maxToolCalls) {
          throw new ForgeError('MAX_TOOL_CALLS_EXCEEDED', /* ... */);
        }
        return await dispatchTool(call);   // 内含 trace 记录与错误包装
      },
    });

    if (gate.isClosed) return { kind: 'submitted' };
    if (turn.stopReason === 'aborted') return { kind: 'aborted' };
    if (turn.stopReason === 'end_turn') {
      // 模型自然结束但没有提交——这是失败
      return { kind: 'no_submission' };
    }
    if (turn.stopReason === 'max_tokens') {
      return { kind: 'failed', code: 'PROVIDER_ERROR',
               message: '模型输出超出长度上限且未完成提交' };
    }
    // tool_use：把结果回灌，继续下一轮
    messages.push(...buildToolResultMessages(turn));
  }
}
```

**`no_submission` 是必须处理的分支**（对应 AC-014）：模型说了一堆「我已完成」但没调 `complete_assignment`。此时 Execution 失败，按重试配额重跑，错误码 `ASSIGNMENT_OUTPUT_INVALID`，message 为「Agent 未通过 complete_assignment 提交结果」。这正是 REQ §5.5「Agent 不得自行宣布任务完成」在运行时的落点。

在这种情况下，重试时的 User Message 追加：

```
【上一次未产出结果】
你上一次的工作没有调用 complete_assignment，因此没有任何内容被保存。
请在完成思考后，务必调用 complete_assignment 提交结果。
```

**`no_submission` 必须分成两种，不能混为一谈（M3-A 补充）**

循环返回 `no_submission` 有两条来路，收敛结果不同：

| 来路 | 错误码 | 下一次 attempt 追加什么 |
|---|---|---|
| 调用过 `complete_assignment` 但被 CompletionPort 拒（如 19 条校验没过） | 被拒时的那个码（如 `STRUCTURE_INVALID`） | D-13 的违规反馈块 |
| 调用过 `complete_assignment` 但被**工具层预检**拒（kind 与 operation 不符 / slotId 不是目标槽位，AC-008） | `SLOT_TARGET_MISMATCH` / `ASSIGNMENT_OUTPUT_INVALID` | 预检那句可执行的中文 |
| 压根没调用 `complete_assignment` | `ASSIGNMENT_OUTPUT_INVALID` | 上面那段固定文案 |

**第二行是 M3-C 补的，原表漏了它。** `complete_assignment` 的三处预检
（kind 不符 ×2、slotId 不是目标槽位）在 `ctx.completion.submit` 之前就抛，
因此不会经过 CompletionPort，也就走不到 `onRejected`。漏了这一条的后果是：
「模型一直往错的槽位提交」会被归到最后一行，收敛成 `ASSIGNMENT_OUTPUT_INVALID` +
`noSubmission: true`，于是下一次 attempt 追加的是「你上次没有调用
complete_assignment」——而模型明明调了，只是 slotId 写错了。给模型一句与事实相反的
反馈，是这条链路上最坏的一种反馈。因此三处预检在抛出之前一律先调 `ctx.onRejected`。

混成一个码的后果是：「结构一直写错」与「模型不会用工具」在 UI 上长得一模一样，
而这两件事的处置完全不同（改 Skill / 改模型别名）。
因此 `AssignmentOutcome` 带一个显式的 `noSubmission: boolean`，
由 Runtime 判定、由 ContextBuilder 取用——判定方与拼文案方分离，
两边各写一份判据的话，改了一处忘了另一处的表现是「重试时模型收到的还是原样提示」，
而这种失败看起来跟模型能力不足一模一样。

### 7.7 Trace 输出缓冲

REQ 与 TECH-V0.1 都要求 text delta 不逐 token 持久化。实现：

```ts
class OutputBuffer {
  private buf = '';
  private timer: NodeJS.Timeout | null = null;

  push(delta: string): void {
    this.buf += delta;
    sseHub.publishRaw(taskId, { type: 'delta', text: delta });  // 实时推，不落库
    if (this.buf.length >= 1024) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 250);
  }

  flush(): void { /* 写一条 public_output_chunk trace */ }
}
```

**SSE 推 delta，数据库存 chunk。** 前端的流式光标靠 delta 驱动；断线重连后靠 chunk 补读。两者的 sequence 体系不同：delta 是瞬时消息不带 sequence，chunk 是正式 trace 带 sequence。前端重连时丢弃所有已缓存的 delta，用 `?after=lastSequence` 补 trace，避免重复。

---

## 8. 可靠性实现

这一节的每一条都对应 REQ 的一个 AC。实现时逐条对照。

### 8.1 Execution Token

```ts
const raw = crypto.randomUUID() + crypto.randomUUID();    // 72 字符
const hash = sha256Hex(raw);
// DB 只存 hash；raw 只在内存中传给 Runtime
```

Token 的失效方式**不是删除**，而是把 `executions.status` 改为非 `running`。D-10 的 UPDATE 语句同时检查 `e.status = 'running'` 和 `t.active_execution_id = e.id`，任一不满足即失效。

### 8.2 超时（AC-010）

```ts
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(new TimeoutSignal()), timeoutMs);
try {
  result = await runtime.loop(assignment, gate);
} finally {
  clearTimeout(timer);
}
```

超时后：
1. `abort` 触发，adapter 返回 `{ stopReason: 'aborted' }`
2. `AssignmentRunner` 检查中止原因，区分 timeout 与 user-stop
3. timeout → Execution 标记 `failed` + `PROVIDER_TIMEOUT`，消耗一次 retry 配额
4. user-stop → Execution 已经在 stop 事务中被标记 `cancelled`，此处不重复写

**区分中止原因的实现**：`AbortController.abort(reason)` 传入不同的 reason 对象，`signal.reason` 可读。不要用两个 AbortController。

### 8.3 停止（AC-011）

REQ FR-LIFE-001 规定的顺序是硬要求：

```ts
function stopTask(taskId: string): void {
  // 第一步：事务内让数据库拒绝后续提交
  const ctrl = run(uow => {
    const task = uow.tasks.get(taskId);
    assertTransition(task.status, 'stop');
    const exec = task.activeExecutionId
      ? uow.executions.get(task.activeExecutionId) : null;

    if (exec) {
      uow.executions.markCancelled(exec.id);
      if (exec.targetSlotId) uow.slots.resetToPending(taskId, exec.targetSlotId);
    }
    uow.tasks.update(taskId, {
      status: 'stopped', activeExecutionId: null,
    });
    uow.traces.insert(/* assignment_cancelled */);
    return activeControllers.get(taskId) ?? null;
  });

  // 第二步：事务提交之后才 abort
  ctrl?.abort(new UserStopSignal());
  sseHub.publishPending(taskId);
}
```

**顺序不能颠倒。** 若先 abort，Provider 可能在事务开始前就返回结果并成功提交——那正是 AC-011 要防的。

### 8.4 迟到结果（AC-011）

D-10 的条件 UPDATE 已经从物理上保证了拒绝。补充的是**可观测性**：

```ts
if (changes !== 1) {
  const reason = diagnoseStaleReason(db, {                // 查明具体原因
    executionId, tokenHash, taskId, slotId,
  });
  uow.executions.markStale(executionId, reason);
  uow.traces.insert({ kind: 'late_result_rejected',
    title: '迟到结果已拒绝',
    summary: `Execution ${executionId} 的结果未被保存：${reason}` });
  throw new ForgeError('EXECUTION_STALE', /* ... */);
}
```

`diagnoseStaleReason` 依次检查：execution 不存在 / token 不匹配 / execution 已非 running / execution 属于别的任务 / execution 的目标槽位不符 / task 不存在 / task.active_execution_id 已变 / task 已非 running / slot 不存在 / slot 已非 running。给出精确原因便于排查。

**签名修正（M2 实施时发现）**：原文写作 `diagnoseStaleReason(uow, executionId)`，但那组参数不足以复现 D-10 的判据——「token 不匹配」需要提交方出示的 `tokenHash`，「目标槽位不符」与「slot 已非 running」需要 `taskId` / `slotId`。只传 `executionId` 只能查出五条里的两条，剩下三条会被归因成含糊的「未知原因」，可观测性就白加了。因此签名改为接收完整的判据输入，且直接收 `db` 句柄而非 `uow`——它是一条只读诊断查询，不需要仓储语义。

**调用时机是硬约束**：本函数只允许在 `changes !== 1` **之后**调用。把它挪到 UPDATE 之前当前置校验，就正好写回了 D-10 明令禁止的「读 → 判 → 写」三段式。它只产出给人看的字符串，绝不参与判定。

**归因必须写在第二个事务里（M3-B 实施时发现）**：上面那段伪代码把 `markStale` 与
`late_result_rejected` trace 放在 `changes !== 1` 分支里、与被拒的 UPDATE 同一个事务，
然后 `throw`。**那样写这两条记录会被同一次 throw 一起回滚掉**，可观测性等于零——
而本节存在的全部理由就是可观测性（物理拒绝已经由 D-10 完成了）。

正确的顺序是：让提交事务干净地整体回滚（「迟到结果被拒时不修改任何状态」由此天然成立，
不需要任何补偿逻辑），调用方在事务**外**捕获 `EXECUTION_STALE`，
再**另开一个事务**写 `markStale` + `late_result_rejected` trace。实现见
`application/completion-service.ts` 的 `recordLateRejection`。

附带一条收窄：`markStale` 只在 execution 仍处于 `created` / `running` 时才打。
若它已经是 `cancelled`（用户 stop 的正常路径），覆盖成 `stale` 会把「谁取消的」抹掉，
而那恰恰是事后排查最想知道的一件事。

### 8.5 限流退避（D-04）

```ts
async function callWithRateLimitBackoff(fn, cfg, signal) {
  let delay = cfg.initialMs;
  for (let i = 0; i < cfg.maxAttempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof ForgeError) || e.code !== 'PROVIDER_RATE_LIMITED') throw e;
      if (i === cfg.maxAttempts - 1) throw e;
      registry.recordRateLimit(providerId);
      trace.insert({ kind: 'provider_retry', actor: 'system',
        title: '触发限流，正在退避重试',
        summary: `${delay}ms 后重试（第 ${i + 1} 次）` });
      await sleepAbortable(delay, signal);      // 可被 stop 中止
      delay = Math.min(delay * 2, cfg.maxMs);
    }
  }
}
```

**退避期间必须可中止**——`sleepAbortable` 监听 signal，否则用户点了停止还要等 60 秒。

限流退避**不创建新 Execution，不递增 attemptNumber**（D-04）。

**包在哪一层（M3-A 定案）**：包住 `adapter.runTurn` 这**一次调用**，
不是包住整个工具循环。包住循环会把本次已经做过的工具调用全部重放一遍
（包括可能已经成功的提交）。代价是「turn 中途 429」时本轮已分发的工具调用会重复计数——
实际上 429 都发生在请求发出的瞬间，此处记一笔以免将来有人以为它被证明过。

由于退避循环整个发生在**一次 `AssignmentRunner.run()` 内部**，
它没有任何创建 Execution 的能力——D-04 的「不新建 Execution」因此是结构性保证而非约定。
可观测判据：一次 `run()` 只写一条 `assignment_started`，
所以「退避了几次」（`provider_retry` 条数）与「跑了几个 attempt」在 trace 上永远分得开。

**`assignment_started` 只允许有一个写入点（M4 实测补正）**

上面这条判据在 M4 第一次跑真实链路时被实测推翻：一次 assignment 产生了
**两条** `assignment_started`（7 个 assignment → 14 条）。两个写入点各自都守着
自己的注释，合起来却破坏了这条判据：

| 写入点 | 时机 | actor | 携带 |
|---|---|---|---|
| `assignment-service`（§5.5 的创建事务） | 创建 Execution 的同一个事务内 | `agent` | 「第 N 次尝试」 |
| `assignment-runner`（§8.5） | 别名解析成功之后、发起模型调用之前 | `system` | provider / model / maxToolCalls / timeoutMs |

**决议：删掉创建事务里那一条，`assignment_started` 归 Runtime 独有。** 理由有三：

1. 它与同一事务里的 `assignment_created` **时间戳相同**。时间线上并排出现
   「已创建工作分配」和「开始工作」两条同刻事件，读的人只会以为系统重复了。
2. 它携带的 `attemptNumber` 已经在 `assignment_created` 的 payload 里，删掉不丢信息。
3. **「开始」必须意味着模型真的开始工作。** 别名解析失败（`MODEL_ALIAS_UNRESOLVED`）
   时 Runtime 会在写 `assignment_started` 之前就返回——此时时间线上应当只有
   「已创建」而没有「已开始」。创建事务里那一条会把这种失败也标成「开始工作」，
   而这恰恰是 D-03 晚绑定最需要在 trace 上看清楚的一类失败。

§5.5「两条 trace 放在同一个事务里」相应改为**一条**（`assignment_created`）。
注意这不影响该节「execution 创建时就置 running」的结论——那条的依据是 D-10 的
条件 UPDATE 要求 `e.status = 'running'`，与写几条 trace 无关。

**`Retry-After` 必须封顶**：听 Provider 的建议，但取 `min(retryAfter, cfg.maxMs)`。
一个错误或恶意的 `Retry-After: 86400` 不该让任务挂一整天。
Provider 没给建议时用指数退避的当前值——**不编一个默认值塞进 `Retry-After`**，
否则「Provider 明确要求等 60 秒」与「Provider 什么都没说」在下游无法区分。

**退避期间被中止**：`sleepAbortable` 返回后要重新检查 `signal.aborted`，
命中就返回 `{ stopReason: 'aborted' }` 交由收敛处按 `signal.reason` 区分是超时还是 stop，
而不是继续重发。

**退避后不重打 `started_at`；超时从 `run()` 入口起算（M3-C 定案）**

M2-A 留下的问题是：仓储按「每次 attempt 新建 execution」实现，`started_at` 只由
`markRunning` 写一次，而退避明确不新建 Execution——那么退避后重发，超时该从哪一刻算？

裁定：**从 `AssignmentRunner.run()` 进入的那一刻算，退避不重置任何计时**。三条理由：

1. **实现上本来就与 `started_at` 无关。** §8.2 的超时是 `run()` 入口的一个
   `setTimeout(timeoutMs)`，`started_at` 从来没参与过判定。若要「退避后重新计时」，
   得额外去重置那个 timer，而那正是把一次限流严重的调用拖成
   `maxAttempts × timeoutMs` 的做法——用户点了一个 120 秒超时的任务，实际等 10 分钟。
2. **`started_at` 是给人看的耗时口径**（附录 B 的 `elapsedMs` 直接由它算）。
   重打之后界面显示「已耗时 30 秒」而系统在 5 分钟处判超时，两个数对不上，
   而对不上的时候用户信的是界面。
3. **少一个写入点。** `executions.started_at` 目前只有 `markRunning` 一个写入口，
   而 `markRunning` 同时是把 status 置为 `running` 的那一步——D-10 的
   `e.status = 'running'` 依赖它。为了重打时间戳新开一个能碰这一行的入口，
   是在一条安全关键的语句旁边加一把不必要的钥匙。

因此仓储不需要新增任何方法，Q-06 第 2 条闭环。

### 8.6 重启恢复（AC-012）

```ts
// main.ts 启动时，在 HTTP 服务监听之前执行
function recoverOnStartup(): void {
  run(uow => {
    for (const task of uow.tasks.findByStatus('running')) {
      const exec = task.activeExecutionId
        ? uow.executions.get(task.activeExecutionId) : null;
      if (exec && (exec.status === 'running' || exec.status === 'created')) {
        uow.executions.markCancelled(exec.id, 'SERVICE_RESTART');
        if (exec.targetSlotId) uow.slots.resetToPending(task.id, exec.targetSlotId);
      }
      uow.tasks.update(task.id, { status: 'stopped', activeExecutionId: null });
      uow.traces.insert({ kind: 'task_state_changed', actor: 'system',
        title: '服务重启，任务已暂停',
        summary: '未完成的执行已取消，已完成的槽位内容保留。点击继续从中断处恢复。' });
    }
  });
}
```

REQ FR-LIFE-003 明确要求 P0 **不自动恢复模型调用**，等用户 Resume。

同时清理孤儿：`status IN ('created','running')` 但其 task 已非 running 的 execution，一律标 `cancelled`。

### 8.7 Retry（FR-LIFE-004）

按失败阶段分派：

```ts
function retryTask(taskId: string): void {
  run(uow => {
    const task = uow.tasks.get(taskId);
    assertTransition(task.status, 'retry');

    if (task.phase === 'structure') {
      // 结构失败：清掉可能存在的部分数据（正常不应有），重跑结构
      uow.slots.deleteAll(taskId);
    } else if (task.phase === 'slots') {
      // 槽位失败：只重置 failed 槽位，completed 的不动
      uow.slots.resetFailedToPending(taskId);
    }
    // assembly 失败：什么都不用重置，直接重跑组装

    uow.tasks.update(taskId, {
      status: 'running', errorCode: null, errorMessage: null,
    });
  });
  engine.enqueue(taskId);
}
```

**已完成 Slot 永不重新生成**（REQ FR-LIFE-004、AC-012）。这条要有专门的测试。

**重试配额按「本轮调度」计，不按 `executions.attempt_number` 累计（M3-C 定案）**

`attempt_number` 是**持久且单调递增**的：它是 `UNIQUE (task_id, target_slot_id,
attempt_number)` 的组成部分，也是 UI 上「第 3 次尝试」那个数字的来源，
所以不能因为一次 retry 就倒回去。

但配额**不能**按它算。结构在第 3 次尝试上耗尽 → 任务 failed → 用户点重试，
若配额判据是 `nextAttemptNumber(taskId, null) > maxRetries + 1`，第 4 次尝试立刻
被判耗尽——重试按钮点了等于没点，而 UI 上还会显示一次「已用尽 3 次尝试」。

因此配额计数器是 `ProductionEngine.tick()` 的**局部变量**（按 `targetSlotId` 分桶），
一次 `tick` 从头到尾持有它，任务离开引擎即消失。retry / resume 都是重新入队，
于是天然拿到一份新配额——这正是「用户显式要求再试一次」应有的语义。

配套的两条：

- 计数器分两个桶：`consumesRetry: true` 的失败进 `maxRetries` 桶（D-04），
  `consumesRetry: false` 的（别名解析失败、原因不明的中止）进一个**容量为 1** 的
  兜底桶。后者存在的唯一理由是**保证终止**：不消耗任何配额的失败若允许无限重试，
  就是一个不报错、不前进、只烧钱的死循环，而它在 UI 上看起来与「正在生产」一模一样。
- 因此每一次失败的尝试必定消耗两个桶之一，`tick` 的循环因此必然终止——
  这是「不允许出现永久 running」的第三道网（前两道是超时与启动恢复）。

### 8.8 断言清单

把 REQ 的不变量写成运行时断言，在关键位置检查，失败即抛（而非静默）：

```ts
// 每次 tick 开始
assert(countRunningExecutionsGlobally() <= 1, '违反 NFR-001 全局串行');
// 每次 slot 提交后
assert(slot.status !== 'completed' || slot.contentText !== null, '违反 AC-009');
// 每次进入 assembly 前
assert(allContentSlotsCompleted(slots), '违反 FR-ASM-001');
```

生产环境保留这些断言。它们的开销可忽略，而静默的状态损坏在内容生产场景里代价极高（用户会拿到一个缺段的产物且不知道）。

---

## 9. API 层

### 9.1 端点全表

| 方法 | 路径 | 说明 | 上游依据 |
|---|---|---|---|
| GET | `/api/templates` | 模板列表（含 runCount） | REQ §21 + D-08 |
| GET | `/api/templates/:id` | 模板详情（槽位类型目录 + 结构绑定 + exampleStructure） | REQ §21 + D-01/02 |
| GET | `/api/templates/:id/tasks` | 引用该模板的任务 | D-08 |
| POST | `/api/templates/:id/reload` | 开发期热重载 | REQ §21 |
| POST | `/api/tasks` | 创建任务（`?start=true` 时创建并启动） | REQ §21 + HANDOFF「仅创建/创建并启动」 |
| GET | `/api/tasks` | 任务列表（含 presentation） | REQ §21 + D-07 |
| GET | `/api/tasks/:id` | 任务详情（含 slots / stepper / activeExecution） | REQ §21 |
| POST | `/api/tasks/:id/start` | 启动 | REQ §21 |
| POST | `/api/tasks/:id/stop` | 停止 | REQ §21 |
| POST | `/api/tasks/:id/resume` | 继续 | REQ §21 |
| POST | `/api/tasks/:id/retry` | 重试 | REQ §21 |
| GET | `/api/tasks/:id/slots` | 槽位列表 | REQ §21 |
| GET | `/api/tasks/:id/slots/:slotId` | 单槽位（含完整 content） | REQ §21 |
| GET | `/api/tasks/:id/slots/:slotId/flow` | 单槽位的生产流程（轮次 / 判据 / 结算） | **R5 新增** |
| GET | `/api/tasks/:id/executions` | 执行记录列表 | REQ §21 |
| GET | `/api/tasks/:id/traces?after=&limit=` | 轨迹分页 | TECH-V0.1 §9.4 |
| GET | `/api/tasks/:id/stream?after=` | SSE | TECH-V0.1 §9.4 |
| GET | `/api/tasks/:id/artifact` | 产物元信息 + 内容 | REQ §21 |
| GET | `/api/tasks/:id/artifact/download` | 下载 | REQ §21 |
| GET | `/api/providers` | Provider + 健康 + 别名映射 | **D-03 新增** |
| POST | `/api/providers/:id/probe` | 主动探测 | **D-03 新增** |
| GET | `/api/providers/defaults` | 执行默认值 | **D-03 新增** |

**`POST /api/tasks` 的 `?start=true`**：对应 HANDOFF 新建任务页的「仅创建」与「创建并启动」两个按钮。实现为一个端点带查询参数，而非两个端点——创建逻辑完全相同，只是末尾多一个 `engine.enqueue()`。

**`GET /api/templates` 返回 `TemplateListResponse` 而不是 `TemplateSummary[]`**（M5-B 修订）：
除模板数组外还带 `failures`。理由见 §3.5 该 schema 处的注释——
加载失败的模板必须在列表页显式可见，返回裸数组会让它们静默消失。

**`GET /api/templates/:id/tasks` 返回 `TaskSummary[]`**：与 `GET /api/tasks` 同形，
按 `updated_at DESC` 排序。它服务的是模板详情页的「引用该模板的任务」区块，
所以不带 `presentation` 以外的任务级派生字段——需要详情就点进去。

**`ModelAliasView.usageCount` 数的是「全部绑定」，不只是槽位类型绑定**（M5-C 明确）：
契约注释原文写的是「引用该别名的槽位类型数」，照字面实现会让 `structure`
这个别名的 usageCount 恒为 0——因为它只被 `bindings.createStructure` 引用，
而那不是槽位类型。这个页面存在的目的是回答「改掉这个别名会影响到谁」，
报 0 等于说「随便改」。因此计数覆盖 `createStructure` 与 `fillSlotByType` 两处，
范围是全部**加载成功**的模板（坏模板编译不出绑定，数不进来）。

**`POST /api/tasks/:id/{start,stop,resume,retry}` 立刻返回，不等生产跑完。**
生命周期服务为此提供 `dispatch()`：状态迁移与状态机校验**同步**完成
（失败同步抛，交给 §9.3 的 setErrorHandler），本轮推进留在后台。
路由若改成 `await lifecycle.start()`，一次请求会挂几分钟；
而若直接丢掉那个 Promise，被状态机拒绝的请求会返回 200，
错误变成一条无人接手的 unhandled rejection。

### 9.2 DTO 投影层

`api/dto/` 目录承担领域对象 → DTO 的映射，**这是唯一允许调用 `derive*Presentation` 的地方**：

```ts
// api/dto/task-dto.ts
export function toTaskSummary(
  task: Task, slots: Slot[], template: TemplateMeta,
  activeExec: Execution | null, queuePosition: number | null,
): TaskSummary {
  const contentSlots = slots.filter(s => s.contentBearing);
  return {
    id: task.id,
    name: task.name,
    templateId: template.id,
    templateName: template.name,
    status: task.status,
    phase: task.phase,
    presentation: deriveTaskPresentation({
      task, slots, activeExecution: activeExec,
      currentSlotTypeName: /* ... */, queuePosition,
    }),
    doneSlots: contentSlots.filter(s => s.status === 'completed').length,
    totalSlots: contentSlots.length,
    updatedAt: task.updatedAt,
  };
}
```

**DTO 层不得包含业务判断**——所有 if/else 都应在 domain 的 `derive*` 函数里。DTO 层只做字段搬运与调用。

**投影层实际落在 `application/task-service.ts`（M3-B 修订）**。原文把它画在 `api/dto/`，
改动理由两条：

1. **投影需要跨仓储取数，是编排而不是搬运。** 一个 `TaskDetail` 要 tasks + slots +
   executions + artifacts + task_snapshots 五张表，还要解冻结快照才能拿到槽位类型名与
   Agent 名（`agentName` 是附录 B.2 第 6 行的必填输入）。放进 `api/dto/`
   等于让 HTTP 层直接持有六个仓储。
2. **CLI 也要它。** §12 M3 的 `cli/run-task.ts` 无 UI 无网络，但同样需要投影来打印进度，
   而 CLI 不该经过 api 层。

「唯一允许调用 `derive*Presentation` 的地方」这条约束原样保留，只是地点改为
`application/task-service.ts`；`api/dto/` 退化为薄转发。约束的实质
（同一套业务判断只有一份实现）不变。

### 9.3 错误映射

**映射表以附录 A 为唯一来源，且必须写全。**

早期草稿在这里写了个部分表加一句「其余默认 500」，这是错的：
附录 A 规定 `SLOT_NOT_READY` 是 **409**，走「默认 500」会得到 500。
正确做法是把 `ERROR_HTTP_STATUS` 声明成 `Record<ErrorCode, number>` 并**逐条写满**——
`Record` 的完备性检查会让「新增错误码但忘了配状态码」变成编译错误，
而不是一个要等到线上才发现的 500。此表实现在 `shared/errors.ts`。

响应体统一为 `PublicError`。Fastify 的 `setErrorHandler` 里做 `ForgeError` → HTTP 的转换，非 `ForgeError` 一律映射为 `{ code: 'STORAGE_ERROR', message: '服务内部错误' }` 并把原始错误写 `pino` 日志（含 stack，但脱敏）。

**内部错误码不得出网（D-18）**。附录 A 里有一类错误码标注为「回给 Agent，非用户可见」，
典型是 `TOOL_NOT_ALLOWED`（D-11）。这类码一旦冒泡到 `setErrorHandler` 就是实现 bug：
它意味着某个本该被转成「工具错误结果」的异常逃逸出了工具层。
`shared/errors.ts` 导出 `INTERNAL_ONLY_ERROR_CODES`，
`setErrorHandler` 必须显式检查——命中就以 500 + 通用文案响应，
**同时以 `error` 级别打一条带明确字样的日志**（例如 `internal-only error escaped to HTTP`）。
默默按原码返回等于把内部协议泄露给前端，而默默改写又会掩盖 bug；
必须是「对外安全 + 对内刺眼」。

**查询参数非法用 `TASK_INPUT_INVALID`，不许静默兜底**（M5-B 补充）。
`?after=` / `?limit=` 这类分页参数解析不出数字时有两条路：退回默认值，或 400。
选后者。`?after=abc` 静默变成 `after=0` 会**从头重放整条轨迹**，
而调用方没有任何办法察觉自己传错了——SSE 断线重连正是靠这个参数续传的，
一次静默归零就是一次全量重放。附录 A 该行的触发条件已相应扩充为
「必填输入缺失，或请求参数非法」；不新增错误码，因为对调用方而言
「你传的东西不对，改了再来」是同一件事，多一个码只会多一处要配状态码的地方。

**`action` 字段必填有意义的值**（UX §18.8 要求「显示重试操作」）：

```ts
'STRUCTURE_RETRY_EXHAUSTED' → action: '点击重试重新设计结构，已冻结的输入不变'
'PROVIDER_TIMEOUT'          → action: '点击重试从当前槽位继续，已完成的槽位不会重新生成'
'DEPENDENCY_DEADLOCK'       → action: '结构存在无法满足的依赖，需要重新创建任务'
```

### 9.4 SSE 协议

```
GET /api/tasks/:taskId/stream?after=142

event: trace
id: 143
data: {"id":"...","sequence":143,"actor":"agent","kind":"work_plan",...}

event: delta
data: {"executionId":"exec_x","text":"她戴上耳机，"}

event: state
data: {"taskStatus":"running","phase":"slots","activeSlotId":"scene_03"}

: heartbeat
```

四类事件：

- **`trace`** — 正式轨迹事件，带 `id`（= sequence）。浏览器 `EventSource` 会自动在重连时发 `Last-Event-ID` 头，服务端据此补发。
- **`delta`** — 流式正文增量，**不带 id**（不是持久事件）。前端追加到产物区。
- **`state`** — 任务/槽位状态变化的轻量通知。前端收到后 `queryClient.invalidateQueries(['task', id])` 重新拉取权威状态，而不是尝试从事件增量维护本地状态。
- **`: heartbeat`** — 每 15 秒一次注释行，防止中间代理断连。

**为什么 state 事件只做失效通知而不携带完整状态**：避免前端出现两套状态推导逻辑（一套从 REST 响应，一套从 SSE 增量），那必然导致两者不一致。SSE 只负责「有变化了，去拉」，权威状态永远来自 REST。这符合 TECH-V0.1 §3.4「服务器数据库是权威状态源」。

**连接管理**：`SseHub` 按 taskId 维护订阅者集合。任务进入终态（completed/failed/stopped）后仍保持连接（用户可能还在看），但停止推 delta。客户端离开页面时主动关闭。

**`state` 事件由 Hub 观测 trace 得出，没有 `publishState` 这个方法**（M5-D 定案）。
Hub 在每条 trace 推送之后读一次权威状态，与上次推过的三元组比对，**变了才推**。
反过来做（在 lifecycle / engine 的每个状态迁移处补一行 `publishState`）要改十几个调用点，
漏掉任何一个的表现是「界面卡在旧状态，刷新一下才对」——最难测、也最容易被当成偶发。
观测式的数据源就是数据库，不可能与真实状态漂移。
代价是它依赖一条隐含约定：**改状态的地方必须写 trace**。§5.5 的八条事务边界目前都写，
但这条约定需要被有意识地维持，已记入 `notes/OPEN-QUESTIONS.md` Q-22。

**首次连接不补发，所以前端打开工作台时必须自己拉一次 `GET /api/tasks/:id/traces`。**
这不只是「为了看历史」——实测中 `POST /api/tasks?start=true` 到 SSE 建连之间
就已经错过了第一个 Assignment 的 `assignment_created` / `assignment_started`。
换句话说 SSE **从来不保证**你能看到连接之前的事件，权威历史只有 REST 那一条路
（这与 §9.4 已经写过的「重连成功后先拉一次校准」是同一件事，只是首连同样适用）。

**新订阅者必须无条件收到一次 `state` 基线。** 只走「变了才推」的去重会漏掉它：
一个跑完之后才被打开的任务，其状态早在无人订阅期间就被推进缓存了，
于是新连接一条 state 都收不到，页面只能干等下一条 trace（可能是几十秒后，也可能永远没有）。

**补发的两条硬要求**：
1. **`Last-Event-ID` 优先于 `?after=`。** 浏览器 `EventSource` 重连时会原样重发同一个 URL
   （连同当初那个 `after`），同时带上 `Last-Event-ID`。让 query 赢的话，
   断线越多重复越多，前端会看到同一批轨迹一次次涌进来。
2. **补发要翻页翻到底，不许截断。** 一次任务的轨迹轻易上百条（实测一章 295 条），
   只发一页的后果是时间线缺了后半段而没有任何报错。

**先注册订阅者，再读历史补发，中间不得有 await。** 顺序反过来会留下一个窗口：
在「读完历史」与「注册」之间提交的 trace 既不在补发里、也不在实时流里，永久丢失。
这条时序的成立依赖 better-sqlite3 的同步读；将来若换异步驱动，
必须改成「先注册 + 缓冲实时事件 + 补发后按 sequence 去重回放」。

**关闭时必须主动 `end()` 掉 SSE 响应，且要在 `preClose` 而不是 `onClose`。**
SSE 的响应按定义永远不结束，而 Fastify 的 `server.close()` 会等所有连接——
等到 `onClose` 才去关，服务器已经在等这些连接了，优雅关闭会挂到超时。

**断线处理**（UX §18.11）：前端 `EventSource` 自动重连；重连期间页面顶部显示轻量提示条「连接已断开，正在重连」，**保留最后一次权威状态，不将任务标记为失败**。重连成功后先拉一次 `GET /api/tasks/:id` 校准，再消费增量。

---

## 10. 前端实现映射

### 10.1 页面 → 数据源

| 页面 | 路由 | 主查询 | 实时 | 设计稿 |
|---|---|---|---|---|
| 任务列表 | `/tasks` | `GET /api/tasks` | 轮询 10s | `任务列表.dc.html` |
| 新建任务 | `/tasks/new` | `GET /api/templates` + `/:id` | 无 | `新建任务.dc.html` |
| 任务工作台 | `/tasks/:id` | `GET /api/tasks/:id` + `/traces` | **SSE** | `任务工作台.dc.html` |
| 模板列表 | `/templates` | `GET /api/templates` | 无 | `模板列表.dc.html` |
| 模板详情 | `/templates/:id` | `GET /api/templates/:id` | 无 | `模板详情.dc.html`（按 D-01 调整） |
| Provider 设置 | `/settings/providers` | `GET /api/providers` | 无 | `Provider 设置.dc.html`（按 D-03/04 调整） |

### 10.2 设计稿迁移规则

HANDOFF README 明确：`.dc.html` 是**设计参考稿，不是生产代码**，`support.js` **不要移植**。

迁移方式：

1. **令牌直接复用**：把 `_ds/classical-.../styles.css` 拷入 `src/client/styles/tokens.css`，`main.tsx` 中 import。所有颜色/字号/圆角引用 CSS 变量，禁止硬编码色值。
2. **唯一的系统外色值**：失败态的 `oklch(0.46 0.13 32)` 与 `oklch(0.96 0.02 32)` 在 tokens.css 中补充定义为 `--color-danger` / `--color-danger-bg`，不再内联。
3. **类名沿用**：`.btn` / `.btn-primary` / `.btn-secondary` / `.btn-ghost` / `.tag` / `.input` / `.dialog` 直接复用设计系统类名，组件不重新发明。
4. **逐页对照**：实现每个页面时，把对应 `.dc.html` 在浏览器打开并排比对。README 声明为 High-fidelity，「颜色、字号、间距、状态分色、交互行为均为最终设定值」，应按令牌值精确还原而非目测。
5. **必须删除**：任务工作台底部的状态切换调试条（README 明确要求实现时删除，真实状态由 SSE 驱动）。

### 10.3 任务工作台的三条关键交互

README 点名「实现时必须保留」，逐条给出实现方式：

**① 自动跟随与手动选择互斥**

```ts
const [followLive, setFollowLive] = useState(true);
const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);

// 用户点击槽位树 → 停止跟随
function onSelectSlot(id: string) {
  setSelectedSlotId(id);
  setFollowLive(false);
}

// 跟随态下，activeSlotId 变化自动切换选中
useEffect(() => {
  if (followLive && task.activeExecution?.targetSlotId) {
    setSelectedSlotId(task.activeExecution.targetSlotId);
  }
}, [followLive, task.activeExecution?.targetSlotId]);

// 右栏顶部：!followLive && task.activeExecution → 显示「返回当前工作」
```

**② 面板主体判据统一**

README 警告：右栏摘要、轨迹、生产信息「共用同一套分支判据，三块内容不得各自判断，否则会出现上下打架」。

实现为**一个 hook 产出一个判别式**，三个子组件消费同一个值：

```ts
type PanelSubject =
  | { kind: 'container';  slot: SlotView }
  | { kind: 'content';    slot: SlotView; execution: ExecutionView | null }
  | { kind: 'structure';  execution: ExecutionView | null }
  | { kind: 'input' }
  | { kind: 'assembly' };

function usePanelSubject(task: TaskDetail, selectedSlotId: string | null,
                         stepperFocus: StepperKey | null): PanelSubject;
```

三个子组件签名统一为 `(props: { subject: PanelSubject })`，**内部不得再判断 task.phase 或 slot.contentBearing**。

**③ 容器槽位不伪造数据**

`subject.kind === 'container'` 时：
- 摘要区显示「无 Assignment · 容器槽位」+ 下级槽位与组装顺序
- 轨迹区显示空态「容器槽位不调用 Agent，无执行轨迹」
- 生产信息区**不显示** Producer、不显示耗时

这条由 `PanelSubject` 的类型系统强制：`{ kind: 'container' }` 分支上根本没有 `execution` 字段，写不出访问 Producer 的代码。

**④ 流式输出的时间戳**

README：「轨迹事件的时间戳按**事件入列时刻**生成，不重排」。

实现：trace 事件的 `createdAt` 由服务端在插入时生成，前端**原样显示不做本地时间推算**，且列表严格按 `sequence` 升序渲染，不按 `createdAt` 排序（两者在正常情况下一致，但 sequence 是权威的）。

### 10.4 状态派生的前端职责边界

前端**不做**状态判断。所有 `tone` / `state` / `detail` / `blockedBy` / `depth` 均来自后端 DTO（D-07）。

前端只做两件事：
1. 按 `tone` 查颜色表取色
2. 按 `kind`（container/content）走两套渲染分支

`kind` 是 README 点名的「整套界面里最重要的一个判据」。

### 10.5 Markdown 安全渲染

```ts
const md = new MarkdownIt({ html: false, linkify: true });
const html = DOMPurify.sanitize(md.render(content), {
  ALLOWED_TAGS: ['p','br','strong','em','h1','h2','h3','h4',
                 'ul','ol','li','blockquote','code','pre','a','hr'],
  ALLOWED_ATTR: ['href'],
});
```

`html: false` 已禁用原始 HTML，DOMPurify 是第二道防线。外链统一加 `rel="noopener noreferrer nofollow"` 与 `target="_blank"`（在 `DOMPurify.addHook` 里注入）。

**内容来自模型输出，必须视为不可信输入。** 这不是理论风险——模型可能在正文里生成 `<img src=x onerror=...>` 之类的内容（无论是被提示注入还是训练数据污染）。

### 10.6 部署形态：前后端分离（Q-24 定案）

原文没有写部署形态，只在 §2.2 的依赖清单里留了一个 `@fastify/static`，
于是形成了 M6/M7 复查发现的那个缺口：`npm run build` 产出 `dist/client`，
但**没有任何方式把它跑起来**（`buildServer` 只注册 `/api/*`，实测 `GET /` 是 404）。
业务方裁决：**前后端分离**。

#### 职责切分

```
静态托管（nginx / 任意静态服务）        Node 进程（Fastify）
  └── dist/client/                       └── /api/*  :3311
        index.html + js + css                  仅此一项职责
```

后端**永远只有 `/api/*`**。这条是分离方案的全部内容，也是它的全部约束：
任何时候在 Fastify 上注册一条非 `/api` 前缀的路由，都意味着这个决定被悄悄推翻了。

**这条约束由代码强制，不靠自觉**（与分层交给 ESLint、事务回调交给 `NotPromise<T>`、
`providers.yaml` 交给 `.strict()` 同一条纪律）：`buildServer` 在注册任何路由**之前**
挂了一个 `onRoute` 钩子，注册非 `/api` 路由会**在构造期直接抛**。

为什么必须做成强制的：违规的后果是**没有任何报错**。假设有人加了 `/review/pending`，
`tsc` / `eslint` / 全部测试都不会红，而线上现象是「这条路由写了没生效」——
静态托管已经把非 `/api` 的路径 fallback 到 `index.html`，请求根本到不了后端。
这正是 DEVLOG 经验 6 说的那类「看起来生效、实际什么都没做」。

守卫本身按「改坏了会失败」反证过：把判断条件改成恒假之后，
`tests/integration/q24-api-only-boundary.test.ts` 的 4 条里有 2 条立刻变红
（另外 2 条本就该保持绿——它们断言的是「没有违规时不抛」与「对外 404」）。

#### 同源，因此不需要 CORS

分离的是**部署件**，不是**源**。静态托管同时反向代理 `/api` 到后端，
浏览器看到的自始至终是一个源，不产生跨源请求，因此：

- **不引入 `@fastify/cors`**，后端不加任何 CORS 头；
- 前端 `src/client/api/http.ts` 继续用**相对路径** `/api/...`，
  不引入 `VITE_API_BASE_URL` 之类的可配置基址。

**为什么不顺手把基址做成可配置的**：那会是一个默认值等于当前行为、
且没有任何部署在用的配置项——同样属于「看起来生效、实际什么都没做」。
真要做跨源部署（前端上 CDN、后端另一个域名）时再加，
届时**必须同时**加 CORS，两件事是一件事，分开做必然漏一半。

#### nginx 参考配置

```nginx
server {
  listen 80;
  root /srv/forge-core/dist/client;

  # SPA fallback：TanStack Router 用的是 history 路由，
  # 直接访问或刷新 /tasks/<id> 时磁盘上并没有这个文件。
  # 少了这一行，深链接与刷新一律 404。
  location / {
    try_files $uri /index.html;
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3311;
    proxy_http_version 1.1;

    # ↓ 这三行是给 SSE 的，不是可选优化 ↓
    # nginx 默认会缓冲上游响应。对 /api/tasks/:id/stream 而言，
    # 缓冲意味着 trace/delta 事件**攒着不发**，前端工作台看起来就是
    # 「任务卡住了、什么都不动，最后突然全部涌出来」——
    # 而后端日志一切正常，是最难查的那类现象。
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;   # SSE 长连接，默认 60s 会被周期性掐断
  }
}
```

`proxy_read_timeout` 给足是因为 SSE 连接本就该长期挂着；
心跳是每 15 秒一次（§9.4），能防住多数中间设备的空闲超时，
但防不住 nginx 自己那条 60 秒的读超时——心跳只在**有数据流动**时刷新它，
而一个空闲任务的工作台连心跳都不会推。

#### 本地验证构建产物

`vite preview` 起的是**构建产物**（不是 dev server 的现场编译），
`vite.config.ts` 的 `preview.proxy` 承担上面 nginx 那段代理的角色——
但**只承担一部分**，边界见下：

```bash
npm run build          # → dist/client
npm run dev:server     # 或 npm run dev:fake
npm run preview        # 5274，serve dist/client 并代理 /api → 3311
```

这条路径存在的意义是：**让「构建产物能不能跑」这件事有人走一遍**。
Q-24 之所以能一直藏着，就是因为前端验证全走 vite dev、后端测试全打 `/api/*`，
两边都绿，中间那段从来没人走过。

**它验得到什么、验不到什么**（定案时实测，全程经 5274、不碰 3311）：

| | 结果 |
|---|---|
| 构建产物能加载并打通 API | ✅ 任务 3/3 槽位完成、产物已组装 |
| SPA fallback（深链接硬加载 `/tasks/<id>`） | ✅ 200 + `text/html` |
| 后端边界（`GET :3311/` 与 `:3311/tasks/<id>`） | ✅ 双双 404，后端确实只有 `/api/*` |
| SSE 陆续到达 | ✅ 34 trace + 39 delta + 11 state，12.3 秒内分批到 |
| **nginx 的 `proxy_buffering off`** | ❌ **验不到** |

最后一行必须写明白：vite 的代理本来就是 pipe，不缓冲，
所以**本地这一层绿了不代表生产不会缓冲**。曾经在 `preview.proxy` 里加过一段
给 SSE 打 `x-accel-buffering: no` 的钩子想「一并验掉」，按「去掉它，看有没有区别」
反证过——带与不带，事件条数与到达间隔完全一致，那段钩子一点作用没有
（`x-accel-buffering` 是写给 nginx 的指令，vite 和浏览器都不认），已删除。
**缓冲这条只能在真实 nginx 前面验。**

---

## 11. 测试架构

### 11.1 分层与覆盖目标

| 层 | 工具 | 覆盖目标 | 特点 |
|---|---|---|---|
| Domain 单测 | Vitest | **100% 分支** | 纯函数，无 IO，毫秒级 |
| Repository 测试 | Vitest + 内存 SQLite | 全部事务边界 | `new Database(':memory:')` |
| Runtime 集成 | Vitest + FakeProvider | 全部 AC | 无网络，可控时序 |
| API 测试 | Vitest + `fastify.inject()` | 全部端点 + 错误码 | 无需真起服务 |
| 前端组件 | Vitest + Testing Library | 状态分支渲染 | 重点测 PanelSubject 分支 |
| E2E | Playwright | 主流程 + 3 个异常流程 | M6 之后 |
| 真实 Provider | 手动 + CLI | AC-015 | M4 与 M7 |

### 11.2 FakeProvider 能力清单

REQ NFR-007 要求的能力，逐条实现为可编程行为：

```ts
interface FakeProviderScript {          // 一条脚本 = 一轮 runTurn 的行为
  // 基础
  emitText?: string[];                    // 逐段 text delta
  callTools?: FakeToolCall[];             // 按序发起的工具调用
  submitStructure?: StructureProposal;    // 直接提交结构
  submitContent?: { slotId: string; content: string };

  // 异常模拟
  hangMs?: number;                        // 挂起，用于测超时（等待可被 abort 打断）
  throwError?: ErrorCode;                 // 抛指定错误
  neverSubmit?: boolean;                  // 只说话不提交（测 no_submission）
  submitWrongSlot?: string;               // 提交错误槽位（测 AC-008）
  submitAfterDelayMs?: number;            // 延迟提交（测迟到结果）
  invalidStructure?: StructureRuleId;     // ← M3-A 扩写，见下
  stopReason?: 'end_turn' | 'max_tokens'; // ← M3-A 新增，见下
}

interface FakeToolCall {
  name: string;                           // ← 刻意是 string，不是 ToolName，见下
  args: unknown;
}

interface FakeProviderOptions {
  turns?: FakeProviderScript[];
  rateLimitTimes?: number;                // 前 N 次 runTurn 抛 429（provider 级，不消费 turns）
  retryAfterMs?: number | null;
}
```

**M3-A 的四处修订，逐条说明理由：**

1. **`invalidStructure` 从 4 个字面量扩成 `StructureRuleId`（18 个取值 / 19 条规则）。**
   这是 `notes/OPEN-QUESTIONS.md` Q-05 记的缺口：本章原文声称
   「19 条规则各有失败 fixture」，而脚本只能表达 4 种，
   于是「Runtime 能把每一类违规完整转成 D-13 反馈」在集成层从未被证明。
   夹具落在 `runtime/provider/invalid-structures.ts`，声明为
   `Record<StructureRuleId, StructureProposal>`——**新增规则却忘了加夹具是编译错误**，
   而不是一句没人核对的文档承诺。
   夹具**允许触发额外违规**（结构错误本来就常常连锁），
   测试断言「至少包含目标规则」；断言「只有目标规则」会把夹具变成
   结构校验实现细节的镜像，改一行 domain 就得改十八个夹具。
   规则 4（`INVALID_SLOT_ID`）的夹具走的是另一条路径：它在 `SlotProposalSchema`
   解析层就被拦下，表现为 `TOOL_INPUT_INVALID` 而非结构违规——两条路径各有测试。

2. **新增 `stopReason`。** §7.6 的收敛分支里有 `max_tokens`，
   而原清单没有任何字段能触发它，那条分支在集成层不可测。

3. **`FakeToolCall.name` 是 `string` 而不是 `ToolName`。**
   D-11 要求分发器兜住**拼错的工具名**并回 `TOOL_NOT_ALLOWED`，
   而 `ToolName` 类型的字段根本没法表达「拼错」。

4. **`rateLimitTimes` 从脚本移到 Provider 级选项。**
   429 发生在请求发出之前，它不消费任何一轮脚本；
   留在脚本里会让「退避了 3 次后成功」需要写 4 条脚本，
   而那 4 条脚本恰好会掩盖「退避没有新建 attempt」这个要被证明的事实。

**关键：`submitAfterDelayMs` 是测试 AC-011 的核心。** 测试流程：

```ts
it('停止后的迟到结果不得写入 Slot', async () => {
  fake.script({ submitAfterDelayMs: 500, submitContent: {...} });
  const task = await createAndStartTask();
  await waitForSlotRunning(task.id, 'scene_01');

  await lifecycle.stopTask(task.id);          // 在提交之前停止

  await sleep(800);                            // 等迟到结果到达

  const slot = slotRepo.get(task.id, 'scene_01');
  expect(slot.status).toBe('pending');         // 恢复为 pending
  expect(slot.contentText).toBeNull();         // 内容未写入
  const exec = executionRepo.findLatest(task.id);
  expect(['cancelled','stale']).toContain(exec.status);
});
```

### 11.3 AC → 测试映射

REQ §26 的 15 条验收标准，逐条落到测试文件：

| AC | 内容 | 测试位置 | 里程碑 |
|---|---|---|---|
| AC-001 | 模板绑定解析 | `domain/template.test.ts` | M1 |
| AC-002 | 快照隔离 | `integration/snapshot.test.ts` | M2 |
| AC-003 | Agent 创建合法结构 | `integration/structure.test.ts` | M3 |
| AC-004 | 无效结构不产生部分数据 | `integration/structure.test.ts` | M3 |
| AC-005 | Ready Slot 正确推进 | `domain/readiness.test.ts` | M1 |
| AC-006 | Agent/Skill 可见 | `api/task-detail.test.ts` | M5 |
| AC-007 | 上下文隔离 | `application/context-builder.test.ts` | M3 |
| AC-008 | 单槽提交 | `integration/completion.test.ts` | M3 |
| AC-009 | 原子保存 | `integration/completion.test.ts` + DB CHECK | M3 |
| AC-010 | 超时收敛 | `integration/reliability.test.ts` | M3 |
| AC-011 | 拒绝迟到结果 | `integration/reliability.test.ts` | M3 |
| AC-012 | 重启恢复 | `integration/recovery.test.ts` | M3 |
| AC-013 | 确定性组装 | `domain/assembly.test.ts` | M1 |
| AC-014 | 完成由系统决定 | `integration/completion.test.ts` | M3 |
| AC-015 | 真实链路 | CLI 手动 + 记录 | M4 / M7 |

**AC-007 的测试要点**（上下文隔离）：

```ts
it('scene_03 的上下文只含 scene_02 正文', () => {
  const ctx = buildContext({ targetSlot: scene03, /* ... */ });
  expect(ctx.userText).toContain(SCENE_02_CONTENT);
  expect(ctx.userText).not.toContain(SCENE_01_CONTENT);
  expect(ctx.userText).not.toContain(OPENING_CONTENT);
  expect(ctx.userText).toContain('scene_01');       // 结构概要里有 ID
  expect(ctx.manifest.dependencySlotIds).toEqual(['scene_02']);
});
```

注意断言的精细之处：结构概要里**应该**出现 `scene_01` 这个 ID（REQ FR-CTX-003 要求 outline 含全部槽位的 id/type/status），但**不应该**出现它的正文。这两件事容易混淆。

### 11.4 确定性回归测试

REQ NFR-006 列出六项必须确定的行为。为每项建立**快照测试**：

```ts
it('相同结构与内容产出逐字节相同的 artifact', () => {
  const a = assembleMarkdownConcatV1(FIXTURE_SLOTS);
  const b = assembleMarkdownConcatV1(shuffleArrayCopy(FIXTURE_SLOTS));
  expect(a).toBe(b);                                   // 顺序无关
  expect(sha256Hex(a)).toMatchInlineSnapshot('"..."'); // 跨版本稳定
});

it('相同任务状态产出相同 contextHash', () => {
  const h1 = buildContext(INPUT).contextHash;
  const h2 = buildContext(structuredClone(INPUT)).contextHash;
  expect(h1).toBe(h2);
  expect(h1).toMatchInlineSnapshot('"..."');
});
```

内联快照的价值：任何人改动组装或上下文构建逻辑时，测试会立刻失败并显示新旧 hash——迫使改动者显式确认这是有意的破坏性变更。

---

## 12. 实施里程碑

### 12.1 与 TECH-V0.1 阶段划分的差异

TECH-V0.1 的 Phase 0→7 把「可靠性」放在 Phase 6、「真实 Provider」放在 Phase 7，即全部 UI 建完之后。本文档调整为：

| | TECH-V0.1 | 本文档 | 理由 |
|---|---|---|---|
| 可靠性 | Phase 6（UI 之后） | **M3（UI 之前）** | Token 检查点、abort 传播、提交边界闸门决定 Runtime 的内部结构。事后加等于重写 |
| 真实 Provider | Phase 7（最后） | **M4（UI 之前）** | 会反向推翻 Skill 文本、Output Contract、agentHint 设计。观察它不需要 UI |
| Trace | Phase 4（独立阶段） | **写入并入 M3，读取并入 M5/M6** | Trace 写入与 Runtime 深度耦合，事后穿插埋点会污染 Runtime |
| 契约对齐 | 无 | **M0（最前）** | 设计稿已高保真，契约不冻结则前端写两遍 |

排序原则：**风险高的先做，风险低但量大的后做；能不靠 UI 观察的就不要等 UI。**

### 12.2 里程碑详表

---

#### M0 — 契约对齐与工程骨架

**产出**

- `config/providers.yaml`、`.env.example`
- `src/shared/` 全部文件（contracts / trace / tools / errors / presentation）
- `package.json` / `tsconfig.json` / `vitest.config.ts` / `eslint.config.js`（含 §2.4 分层约束）
- 空壳 Fastify 服务 + 空壳 Vite 前端，`npm run dev` 可同时起
- 迁移执行器 + `001_initial.sql` + `002_indexes.sql`
- **§1 决议清单中 🔴 项的设计侧确认结论**

**完成判据**

```
npm run dev            服务起，前端开，数据库自动迁移
npm run lint           domain 层的越界 import 会被拦截（写一个反例验证）
npm test               跑通（此时 0 个测试）
```

**风险**：设计侧对 D-01 的确认可能需要来回。**这条是唯一的外部阻塞项，应最先发起沟通。**

---

#### M1 — Domain 纯函数

**产出**

`domain/` 全部文件 + 对应测试。不碰数据库，不碰网络，不碰 React。

**完成判据**

- `structure-validation` 的 19 条规则各有至少一个失败 fixture 与一个通过 fixture
- 随机生成的合法槽位树 100 次全部通过校验（轻量 property test）
- `deriveReadySlots` / `selectNextReadySlot` 覆盖：无依赖、链式依赖、菱形依赖、全部完成、死锁
- `assembleMarkdownConcatV1` 通过确定性快照测试
- `derive*Presentation` 覆盖全部 10 种任务态与 8 种槽位态
- **domain 目录分支覆盖率 100%**

**AC 覆盖**：AC-005、AC-013

**为什么第一个做**：零依赖，可并行开工，且它编码了系统全部不变量。这一层的 bug 最贵——错误的组装顺序会产出错误的成品，错误的 readiness 会导致死锁。

---

#### M2 — 持久化与事务

**产出**

`infrastructure/database/` 全部 repository + `uow.ts` + `template-loader` + `skill-loader` + `template-catalog` + `snapshot-service`

**完成判据**

- 每条 §5.5 事务边界都有测试，且有对应的**回滚测试**（中途抛错，断言无部分写入）
- DB CHECK 约束的违反测试（直接构造非法 UPDATE，断言抛错）
- `run(async ...)` 在编译期被拒（`@ts-expect-error` 测试）
- 模板加载：合法模板通过、每类非法模板被拒（缺 binding、binding 引用不存在的 agent、skill operation 不匹配、fillSlot 未覆盖全部 contentBearing 类型、forbidPattern 超时）
- 快照隔离：创建任务后改 SKILL.md，旧任务读到的仍是旧内容

**AC 覆盖**：AC-002

---

#### M3 — 生产引擎闭环 ★

**这是最重要的里程碑。完成后，所有不需要网络调用的东西全部被证明。**

**产出**

- `application/` 全部 service（含 production-engine 的互斥队列）
- `runtime/` 全部（含 SubmissionGate、工具集、FakeProvider）
- `trace-service`（写入侧）
- `assembly-service`
- `lifecycle-service`（start/stop/resume/retry/startup-recovery）
- `cli/run-task.ts` — headless 跑一个完整任务

**完成判据**

```
npx tsx src/server/cli/run-task.ts --template zhihu-chapter \
   --input-file fixtures/chapter-packet.txt --provider fake

→ 结构创建 → 7 个槽位依次填充 → 组装 → chapter.md 落库
→ 全程无 UI，无网络
```

以及全部异常路径：

- 非法结构（4 种）被整体拒绝，数据库无部分 slot
- 结构重试耗尽 → `STRUCTURE_RETRY_EXHAUSTED`
- Provider 超时 → 按配额重试 → 耗尽后 failed，无永久 running
- 停止后迟到结果被拒，slot 回到 pending
- 提交错误 slotId 被拒
- 只说话不提交 → `no_submission` 分支正确处理
- 进程杀掉重启 → running task 变 stopped，已完成 slot 保留，resume 后从中断处继续
- 两个任务同时 start → 串行执行，第二个显示排队

**AC 覆盖**：AC-003、004、007、008、009、010、011、012、014

**这是「P0 核心完成」的真正时刻。**

---

#### M4 — 真实 Provider 与 Skill 调优 ★

**产出**

- `provider/openai-compatible.ts`（DeepSeek，D-17。`anthropic.ts` 不实现）
- 各 `SKILL.md` 实际内容（由实现方产出初稿，业务方审校）
- `cli/dump-trace.ts`
- **一份调优报告，含结构提案首次通过率**

> **「六个 SKILL.md」改为「各 SKILL.md」（M4 实施补正）**。这个数字是早期草稿留下的，
> 与唯一的 P0 模板 `zhihu-chapter` 对不上：它声明 4 个 Skill
> （结构设计 / 章节骨架 / 标题 / 场景）。Skill 数量由模板决定，
> 写死一个数只会让人去凑两个没有槽位类型需要它们的文件。

**完成判据**

```
npx tsx src/server/cli/run-task.ts --provider real \
   --template zhihu-chapter --input-file fixtures/chapter-packet.txt
```

> **`--provider deepseek` 改为 `--provider real`（M4 实施补正）**。CLI 的这个开关
> 选的是「走真实链路还是走 `FakeProvider`」，不是选哪一家 provider——
> 具体用谁由 `config/providers.yaml` 的别名映射决定（D-03 晚绑定）。
> 写成 `--provider deepseek` 会暗示这里能换厂商，而换厂商实际上要改 yaml，
> 命令行拼不出那个语义。

连续跑 20 次，记录：

| 指标 | 目标 |
|---|---|
| 结构提案首次通过率 | **≥ 80%** |
| 结构提案三次内通过率 | ≥ 98% |
| 槽位内容首次通过率 | ≥ 90% |
| 单章端到端成功率 | ≥ 90% |
| 单章平均耗时 | 记录，不设目标 |

**未达标不得进入 M5。** 改进手段按顺序尝试：① 改 `agentHint` 措辞 ② 改 Output Contract 的示例 ③ 改 SKILL.md 的 requiredSections ④ 放宽某条校验规则（需重新评估该规则是否必要）。

**为什么排在 UI 之前**：这一步可能推翻 Skill 文本、Output Contract 和 agentHint 的设计。观察它只需要 CLI + `dump-trace`，零 UI 成本。如果等 UI 建完才发现通过率只有 40%，前面的界面工作全部要陪着返工。

**这是整个项目风险最集中的一步。** 排期上应留出比编码更多的调试时间。

---

#### M5 — API 与 SSE

**产出**

`api/` 全部路由 + DTO 投影层 + 错误映射 + `sse-hub` + trace 读取侧

**完成判据**

- §9.1 全部端点有 `fastify.inject()` 测试
- 每个错误码至少一条测试断言其 HTTP status 与 `action` 文案
- SSE：连接、收 trace、断线后 `Last-Event-ID` 补发、心跳、任务终态后不推 delta
- `GET /api/tasks` 返回的 `presentation` 三字段在 6 种任务态下均符合 §附录 B

**AC 覆盖**：AC-006

---

#### M6 — 前端

**顺序**：模板列表 → 模板详情 → 任务列表 → 新建任务 → **任务工作台（最后）**

理由：前四页是常规 CRUD 展示，用于建立组件库与令牌体系；工作台复用它们全部产出，且自身复杂度最高（原型 1146 行、10 种状态、三栏可拖拽、流式、自动跟随互斥）。

**完成判据**

- 每页与对应 `.dc.html` 并排比对，令牌值精确还原
- 工作台 10 种状态全部可达（用 FakeProvider 构造）
- `PanelSubject` 五个分支的组件测试
- 状态切换调试条已删除
- 断线重连不误标失败

---

#### M7 — 加固与验收

**产出**

- 脱敏审计：grep 全部日志/trace/API 响应，确认无 API Key、无 Authorization、无隐藏推理
- E2E（Playwright）：主流程 + 停止续跑 + 重启恢复
- 性能：50 个槽位的任务，工作台首屏 < 1s，trace 分页正常
- **连续完成 10 个真实章节任务，无人工干预数据库或文件**

**完成判据 = REQ §27 的十项 P0 成功指标全部满足。**

---

### 12.3 里程碑依赖图

```
M0 ─┬─→ M1 ─→ M2 ─→ M3 ─→ M4 ─→ M5 ─→ M6 ─→ M7
    └─→ (设计侧确认 🔴 项，与 M1/M2 并行)
```

M1 与 M2 之间可部分并行（M2 的 template-loader 依赖 M1 的 template domain 类型，但 repository 层不依赖）。M5 与 M6 之间可部分并行（前端可先对着 DTO schema 用 mock 开工）。**M3 与 M4 是严格串行且不可跳过的关键路径。**

---

## 附录 A：错误码全表

| 错误码 | HTTP | 触发条件 | action 文案 |
|---|---|---|---|
| `TEMPLATE_NOT_FOUND` | 404 | 模板 ID 不存在 | 返回模板列表重新选择 |
| `TEMPLATE_INVALID` | 400 | 模板校验失败 | 检查 template.yaml 后重新加载 |
| `TEMPLATE_NOT_PUBLISHED` | 400 | 用 draft/archived 模板建任务 | 该模板不可用于新任务，请选择已发布模板 |
| `TASK_NOT_FOUND` | 404 | 任务 ID 不存在 | — |
| `TASK_STATE_INVALID` | 409 | 状态机不允许该操作 | 刷新页面查看最新状态 |
| `TASK_INPUT_INVALID` | 400 | 必填输入缺失，**或请求参数非法**（M5-B 扩充） | 补齐必填字段后重新创建 |
| `ENGINE_BUSY` | 429 | 队列超过上限 | 等待当前任务完成后重试 |
| `STRUCTURE_INVALID` | — | 结构校验未通过（内部，触发重试） | — |
| `STRUCTURE_RETRY_EXHAUSTED` | 500 | 结构重试耗尽 | 点击重试重新设计结构，已冻结的输入不变 |
| `SLOT_NOT_FOUND` | 404 | 槽位不存在 | — |
| `SLOT_NOT_READY` | 409 | 依赖未满足 | 等待前置槽位完成 |
| `SLOT_TARGET_MISMATCH` | — | 提交的 slotId ≠ target | — |
| `SLOT_CONTENT_INVALID` | — | 字数/格式校验失败 | — |
| `DEPENDENCY_DEADLOCK` | 500 | 有 pending 无 ready | 结构存在无法满足的依赖，需要重新创建任务 |
| `PROVIDER_TIMEOUT` | 500 | 超时 | 点击重试从当前槽位继续，已完成的槽位不会重新生成 |
| `PROVIDER_ERROR` | 500 | Provider 返回错误 | 检查 Provider 设置后重试 |
| `PROVIDER_RATE_LIMITED` | 503 | 429 且退避耗尽 | 该 Provider 正在限流，稍后重试或切换模型别名 |
| `PROVIDER_UNAVAILABLE` | 503 | 凭证缺失或探测失败 | 前往 Provider 设置检查配置 |
| `MODEL_ALIAS_UNRESOLVED` | 500 | 别名未在 providers.yaml 中定义 | 在 config/providers.yaml 中补充该别名 |
| `EXECUTION_CANCELLED` | — | 用户停止 | — |
| `EXECUTION_STALE` | — | 迟到结果 | — |
| `EXECUTION_TOKEN_INVALID` | — | Token 不匹配 | — |
| `MAX_TOOL_CALLS_EXCEEDED` | — | 工具调用超限 | — |
| `TOOL_NOT_ALLOWED` | — | 越权工具调用（回给 Agent，非用户可见） | — |
| `TOOL_INPUT_INVALID` | — | 工具参数不符 schema | — |
| `SKILL_SECTION_NOT_FOUND` | — | Section ID 不存在 | — |
| `ASSIGNMENT_OUTPUT_INVALID` | 500 | 未提交或提交格式错 | 点击重试 |
| `ASSEMBLY_FAILED` | 500 | 组装失败 | 点击重试，已完成的槽位内容保留，只重新执行组装 |
| `ARTIFACT_NOT_FOUND` | 404 | 产物不存在 | — |
| `STORAGE_ERROR` | 500 | 数据库/文件系统错误 | 请查看服务日志 |

标 `—` 的 HTTP 列表示该错误码只在内部流转，不直接返回给用户（会被上层转换为任务失败状态）。

**「不直接返回给用户」的准确范围是「不得作为 HTTP 错误响应体的 `code`」**（M5 审查补正）。
它**不**禁止这些码出现在 `ExecutionView.error` / `SlotView.error` / `TaskDetail.error`
这类**投影字段**里：那是对一次已经发生的执行的诊断记录，不是本次请求的失败原因。
UX §13.5 的技术详情面板要显示的正是它——把 `EXECUTION_CANCELLED` 换成
`STORAGE_ERROR` 反而是在撒谎。

这条区分必须写下来，因为两条路径的守卫**不是同一处**：
`setErrorHandler`（§9.3）只管异常冒泡那一条，投影路径不经过它。
所以投影字段上另有一条要求：

> **投影出来的 `message` 必须是一句可直接展示的完整中文（D-19），
> 绝不能是内部枚举字面量。**

实测发现过一次违反：`lifecycle.stop()` 把 `'USER_STOP'` 直接写进
`executions.error_message`，于是 `GET /api/tasks/:id/executions` 返回
`{"code":"EXECUTION_CANCELLED","message":"USER_STOP"}`，
而那串英文常量名会原样出现在技术详情面板上。
成文责任在 lifecycle 层，不在派生层——这正是 D-19 已经写过的那条分工。

---

## 附录 B：状态派生规则表（D-07 实现依据）

### B.1 任务级 `deriveTaskPresentation`

| # | 条件（按序匹配，首个命中即返回） | tone | state | detail |
|---|---|---|---|---|
| 1 | `status=ready` | `idle` | 待启动 | 冻结输入已就绪，尚未开始生产 |
| 2 | `status=running` 且 `queuePosition!=null` | `wait` | 排队中 | 前面还有 {n} 个任务 |
| 3 | `status=running` 且 `phase=structure` 且 `attempt>1` | `warn` | 结构重试中 | 第 {attempt} 次尝试 · 上次{lastFailureReason} |
| 4 | `status=running` 且 `phase=structure` | `run` | 创建结构 | Structure Agent 正在设计章节结构 |
| 5 | `status=running` 且 `phase=slots` 且 `attempt>1` | `warn` | 超时重试 | 第 {attempt} 次尝试 · 上次{lastFailureReason} |
| 6 | `status=running` 且 `phase=slots` 且有 running slot | `run` | 正在填充 Slot | {slotId} {typeName}生成中 |
| 7 | `status=running` 且 `phase=slots` 且无 running slot | `wait` | 等待调度 | {done}/{total} 已完成，正在选择下一槽位 |
| 8 | `status=running` 且 `phase=assembly` | `run` | 组装中 | {total} 个槽位全部通过，正在组装产物 |
| 9 | `status=stopped` | `idle` | 已停止 | 运营手动停止，可从 {slotId} 续跑 |
| 10 | `status=failed` 且 `phase=structure` | `fail` | 结构校验失败 | {task.errorMessage} |
| 11 | `status=failed` 且 `phase=slots` | `fail` | 槽位生产失败 | {slotId} {errorMessage} |
| 12 | `status=failed` 且 `phase=assembly` | `fail` | 组装失败 | {errorMessage}，已完成槽位内容保留 |
| 13 | `status=completed` | `ok` | 已完成 | {total} 个槽位全部通过，产物已组装 |
| 14 | **以上均未命中**（如 `running` + `phase=done` 这类脏数据） | `idle` | 状态未知 | 任务处于未预期的状态组合：{status}/{phase} |

**第 14 行是必须的（D-19）**。原表没有兜底行，而 `TaskStatus × TaskPhase` 有
5×4=20 种组合、表里只覆盖了一部分，`running` + `phase=done` 就落空。
派生函数跑在每次列表渲染上，**一条脏数据不该把整页打成 500**——
兜底返回一个诚实的「状态未知」，同时把组合原样写进 detail 便于排查。

**跨层合同（D-19）**：第 3 / 5 行的「上次…」与第 10 行的「首条违规」
都不是本函数能重建的信息——`activeExecution` 是**当前**这次不是上一次，
`StructureViolation[]` 也不在签名里。因此规定：

> **失败原因的成文责任在 lifecycle 层，不在派生层。**
> lifecycle 在写 `task.error_message` 时，必须写成一句可直接展示的完整中文，
> 例如「120 秒超时」「结构校验未通过：scene_02 依赖了容器槽位 chapter」。
> 派生层只负责取用（`lastFailureReason` / `task.errorMessage`），**不做解析、不做拼装**。

理由：只有 lifecycle 手上同时有 execution、超时配置和违规列表；
让派生层去反推，就得把这三样都塞进签名，而它们对其余 11 行毫无用处。

### B.2 槽位级 `deriveSlotPresentation`

对应 `组件状态变体.dc.html` 的 8 态 `SLOT_STATES`。**按序匹配，首个命中即返回**：

| # | 条件 | tone | state | detail | 图形 |
|---|---|---|---|---|---|
| 1 | `contentBearing=false` | `container` | 容器槽位 | 收拢 {n} 个**直接子槽位** | ■ 方形 |
| 2 | `taskStatus='stopped'` 且 `isInterruptionPoint` | `idle` | 已停止 | 运营手动停止 · 可从此处续跑 | ○ 中性 |
| 3 | `status=pending` 且 `blockedBy.length>0` | `wait` | 等待依赖 | 等待 {blockedBy.join('、')} 定稿 | ○ 描边圆 |
| 4 | `status=pending` | `idle` | 未填充 | 等待执行 | ● 淡实心 |
| 5 | `status=running` 且 `activeAttempt>1` | `warn` | 超时重试 | 第 {attempt} 次尝试 · 上次{lastFailureReason} | ▶ 脉冲 |
| 6 | `status=running` | `run` | 正在填充 | {agentName} 生成中 · 已 {elapsed} 秒 | ▶ 脉冲 |
| 7″ | `status=completed` 且 `contentText === null` | `warn` | 数据异常 | 标记为已完成但没有正文（违反 AC-009） | ! warn |
| 7 | `status=completed` 且 `includeInArtifact` | `ok` | 已完成 | {charCount} 字 · 校验通过 | ✓ 实心 |
| 7' | `status=completed` 且 `!includeInArtifact` | `ok` | 已完成 | {charCount} 字 · 不进正文 | ✓ 虚线 |
| 8 | `status=failed` | `fail` | 生产失败 | {errorMessage} | ! danger |

**匹配顺序的两处理由**：

- **第 1 行必须在最前**：容器槽位无论 `status` 取何值，都不得被渲染成带字数的完成态
  （「已完成 · N 字」）——容器不产出正文，那个字数是伪造的。

  > **容器槽位的 status 定为 `pending`（M3-B 修订）**。本行原文写的是
  > 「容器槽位在结构提交后就是 `completed`」，`domain/readiness.ts` 的注释也照抄了这句。
  > 但 M2 的 `SlotRepo.insertMany` 把 status 硬编码为 `'pending'`，仓储层没有提供
  > 把容器置为 completed 的入口。核对全部读取点后确认这是**纯文案分歧**，不是行为差异：
  > `isSlotReady` / `allContentSlotsCompleted` / `detectDeadlock` / `findInterruptionPoint`
  > 都先按 `contentBearing` 过滤，`assembly.ts` 根本不读 status，本行自己也先按
  > `contentBearing` 短路。因此容器槽位落库即 `pending` 并永远保持 `pending`。
  > 相应地，本行「必须在最前」的理由改为上面那句——它不再依赖容器的具体 status，
  > 这也让理由本身变得更强：无论将来容器的 status 怎么变，这一行都必须排在最前。
- **第 2 行必须在 `running` 之前**：停止发生时中断点槽位仍可能是 `running`，
  按自身状态渲染会得到「正在填充」，与任务已停止的事实矛盾。

**第 7″ 行（D-19 补）**：AC-009 由 `slots` 的 CHECK 约束保证，
所以「completed 但无正文」在**落库数据里不可能出现**。但派生函数是纯函数，
不保证只被落库数据调用（内存态、测试夹具、将来的导入路径都能构造出它）。
不加这一行的话，该状态会渲染成 `0 字 · 校验通过`——
对一个明显违反 AC-009 的数据宣称「校验通过」，是这张表里唯一会**主动撒谎**的输出。
处理方式与 B.1 第 14 行同理：不抛错（不让一条脏数据打死整页），但也不粉饰。

**第 7 / 7' 行的措辞（D-19 定案）**：工作槽位是 `{charCount} 字 · 不进正文`，
**不是**「校验通过 · 不进正文」——D-16 影响面第 4 条给的就是前者。
「校验通过」对工作槽位是句废话（它本来就不进产物，用户关心的是它不进产物），
两句都堆上去只会稀释信息。7 与 7' 是同一条规则的两个分支，仍算 8 态之一。

**第 6 行的 `agentName`（D-19）**：这个值**不在** `Slot` 上——
`slot.producer` 要到提交时才写入，running 期间恒为 `null`。
因此 `SlotPresentationInput` 必须显式接收 `agentName: string | null`，
由调用方从当前 execution 的 `agentId` 解析后传入。
写成可选参数并在缺省时退化为「Agent」是**不可接受的**：
那会让一个本该在调用方修复的接线缺失，静默降级成一句看不出问题的界面文案。

传入 `null` 时（结构阶段等确实没有具名 agent 的场景）detail 退化为
`生成中 · 已 {elapsed} 秒`，即**省略主语**而不是编一个主语。
两者的区别在于：省略主语的句子读得出「这里没有名字」，
而「Agent 生成中」读起来像一个叫 Agent 的东西在干活，掩盖了缺失。

**槽位级只有这 8 态。**「排队中」是**任务级**状态（见 B.1 第 2 行），
不下沉到槽位——排队时任务还没开始生产，一个槽位都没有。
D-14 所说的「第 10 态」指的是全局界面状态清单的增量，不是 B.2 的第 9 行。

> **B.2 的两次修订（M0 实施时发现，原表不可实现）**
>
> 1. 原表有一行 `status=failed 且 operation=create_structure → 结构校验失败`。
>    这一行**无法求值也无法命中**：`operation` 是 execution 的字段不是槽位的；
>    而结构创建是原子的——失败时一个槽位都还没落库，不存在可渲染的槽位。
>    结构校验失败是**任务级**表现，B.1 已有对应行。**已删除。**
> 2. 原表最后一行依赖「任务已停止」与「该 slot 是中断点」，
>    但 §6.5 的 `SlotPresentationInput` 里两个输入都没有。
>    **已补进函数签名**（见 §6.5），否则这一行同样不可实现。
>
> 这两处暴露了同一个问题：派生规则表和函数签名是分开写的，
> 没有机制保证「规则用到的输入」是签名的子集。实现 `presentation.ts` 时，
> 每条规则都必须有一条单测，用例名直接写本表的行号——
> 规则不可求值会在写测试时立刻暴露，而不是等到前端渲染出空白。

---

## 附录 C：界面修改清单

**状态：已确认（2026-08-20）。确认原则——界面设计以需求规格说明书为准，前端按需改动。**

下列修改全部生效，实现时直接按此执行，无需再回设计侧确认：

| # | 页面 | 修改内容 | 依据 |
|---|---|---|---|
| C-1 | 模板详情 | 「槽位结构树」→「槽位类型目录」，去掉父子缩进，按 contentBearing 分两组 | D-01 |
| C-2 | 模板详情 | 移除容器槽位的 `children[]` 组装顺序列表 | D-01 |
| C-3 | 模板详情 | 新增「结构设计」区块，展示 createStructure 绑定与结构限制 | D-01 |
| C-4 | 模板详情 | 「产物校验规则」拆为「系统校验」（对勾）与「写作要求」（引号）两组，图标区分 | D-05 |
| C-5 | 模板详情 | 「版本历史」Tab 渲染空态 | D-08 |
| C-6 | 新建任务 | 右栏标题「槽位树预览」→「示例结构」，加一行「实际结构由 Agent 运行时生成」说明 | D-01/02 |
| C-7 | Provider 设置 | 「模型映射」表移除编辑入口，改为只读 | D-03 |
| C-8 | Provider 设置 | 「并发槽位」置灰为 1，note 改为「P0 全局串行执行」 | D-04 |
| C-9 | 模板列表 | 模板描述中所有「并行」字样改写 | D-04 |
| C-10 | 任务列表 / 工作台 | 新增第 10 态「排队中」，归入 `tone: wait` | D-14 |
| C-11 | 工作台 | 技术详情中 Execution ID 与 Assignment ID 合并为一行 | D-09 |
| C-12 | 组件状态变体 | `Error` 不作为独立 actor，按 kind 走 danger 配色 | §3.3 |
| C-13 | 工作台 / 模板详情 | 新增**工作槽位**视觉：虚线圆点，与内容槽位（实心）区分；子行加「不进正文」标识；组装顺序列表中不出现 | D-16 |

C-1 至 C-3 是**实质性改动**，需要重新出稿；其余为局部调整。

---

## 附录 D：与上游文档的差异索引

便于上游文档维护者回溯本文档做了哪些修改：

**对 REQ 的补充**（不冲突，只补缺）
- §21 API 增加 `/api/providers` 三个端点（D-03）
- `TemplateDefinition` 增加 `status` / `presentation` / `limits.maxToolCallsPerAssignment`（D-08、§4.1）
- `SlotTypeDefinition` 增加 `validation` / `guidance`（D-05）
- `OperationBinding` 增加 `modelAlias` / `timeoutMs` / `maxRetries`（D-06）
- 错误码增加 6 个（§3.2）
- Trace kind 增加 2 个（§3.3）
- 结构校验规则增加第 19 条 `rootSlotId` 一致性（§6.1）

**对 TECH-V0.1 的修正**
- `ProductionEngine` 从任务级互斥改为**全局互斥 + 队列**（D-14）
- `contextHash` 与 `promptHash` 分离（D-12）
- Assignment 明确不建表（D-09）
- 阶段划分重排：可靠性与真实 Provider 前移至 UI 之前（§12.1）
- 校验库从 TypeBox 改为 Zod（D-15）
- Provider SDK 明确不引入，直接用 fetch（§2.2）

**对 UX / HANDOFF 的裁决**
- 见附录 C 全表

---

## 附录 E：第一周可执行清单

M0 的具体动作，按天拆：

**Day 1**
- ~~发起设计侧沟通~~ —— 已确认（2026-08-20），界面以需求文档为准，前端按需改动
- `npm init` + 依赖安装 + tsconfig + eslint 分层约束 + vitest 配置
- 写一个越界 import 的反例，确认 lint 能拦下

**Day 2**
- `src/shared/errors.ts`、`presentation.ts`、`trace.ts`、`tools.ts`

**Day 3**
- `src/shared/contracts.ts`（照着 HANDOFF 各页的数据常量逐字段对齐）

**Day 4**
- `config/providers.yaml` + `.env.example`
- `migrations/001_initial.sql` + `002_indexes.sql` + 迁移执行器
- 空壳 Fastify + 空壳 Vite，`npm run dev` 双起

**Day 5**
- 把 `_ds/classical-.../styles.css` 拷入 `src/client/styles/tokens.css`，补 `--color-danger`
- 跑通 `npm run dev` / `npm run lint` / `npm test` 三条命令
- 收敛设计侧对附录 C 的反馈，更新本文档 §1

**M0 完成标志**：任何一个新加入的开发者，`git clone && npm i && npm run dev` 就能起来，且 `src/shared/` 里的类型能告诉他每个 API 长什么样。

---

**文档结束。**

实现过程中若发现本文档与实际冲突，**先改文档再改代码**——本文档是实现基线，代码与它不一致时以文档为准，除非文档被显式修订。

