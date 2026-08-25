# Forge Core vNext —— 项目背景说明

> **这份文档的用途**：给一个没有任何上下文的外部设计伙伴（人或模型）看，
> 让它能就「加入**审核返修机制**」这个新特性给出**不会撞坏现有地基**的设计方案。
>
> 读完这份，你应该能回答：这个系统靠什么不变量成立、新特性会撞到哪几条、
> 以及一份可用的设计产出该长什么样。
>
> 全部事实截至 2026-08-25，对应代码状态：**716 测试 / 44 文件全绿**，
> `tsc` 与 `eslint` 干净，真实 Provider 端到端跑通。

---

## 0. 一句话

一个**结构槽原生（structure-slot-native）的 Agent 内容生产平台**。
当前唯一的 P0 场景是「写一章网文」，但架构不是为这一个场景写死的。

核心公式三行：

```
Structure        = StructureAgent(StructureSkill, TaskInput)
SlotContent[i]   = ContentAgent(SlotSkill[i], DeterministicContext[i], Slot[i])
Artifact         = Assemble(Structure, SlotContents)
```

人话：

1. **章节的结构由 Agent 设计，不由模板写死。** 模板只声明「有哪些**槽位类型**」
   （标题 / 骨架 / 场景段……），具体这一章分几个场景、怎么排，是结构 Agent
   读了本章执行包之后**当场设计**的。
2. **结构定下来后，每个槽位由另一个 Agent 独立填充。** 它的上下文由系统
   **确定性地**拼给它（不是让模型自己去翻），一次只干一个槽位的活。
3. **最后由系统把槽位装配成产物。**

贯穿始终的一条：**「完成」永远由系统判定，不接受模型说「我写完了」。**

---

## 1. 这个系统的世界观（读设计方案前必须先接受的几条）

这些不是实现细节，是**这个项目之所以是这个样子的原因**。新特性必须与它们相容，
或者显式地推翻某一条（推翻是允许的，但必须是明写的决定，不能是副作用）。

### 1.1 模型输出是**不可信输入**

系统从不相信模型的自述。模型说「我写好了」不算数，必须**调用一个特定的工具**
（`complete_assignment`）把产物交出来，由系统做确定性校验。
校验不过就退回违规清单，让它在同一轮对话里改。

### 1.2 「质量」与「合规」是两件事，P0 只做后者

模板里刻意拆成两个字段：

```yaml
- id: scene
  validation:            # 确定性校验：系统强制，违反则拒绝提交并计入重试
    minChars: 300
    maxChars: 8000
    forbidPattern: '(?m)^#{1,6}\s'     # 不得含 Markdown 小标题
  guidance:              # 写作要求：注入 Agent 上下文，系统不强制
    - 首段需衔接前一场景的结尾状态
    - 通过可见行动推进，不用心理解释代替事件
```

原因：「字数在 300–8000」和「不含小标题」机器能判；
**「结尾状态能不能被下一场承接」机器判不了**。
设计稿最初把这三条并列成「产物校验规则」，被显式拆开了。

**这条直接决定了本次要讨论的特性的位置**：需求文档 REQ §7 把 **Slot Review
（语义质量审核）列为非目标**，FR-SLOT-004 明写「P0 不进行语义质量审核」。
所以「加入审核返修机制」**是一次有意的范围反转**，不是补一个漏掉的功能。

### 1.3 单机、单用户、串行

P0 并发固定为 1：全局同一时刻只有一个任务在真正生产，任务内槽位也是串行的。
没有登录、没有多用户、没有权限模型——「审核员」和「作者」是同一个人。
不要设计需要账号体系或角色权限才成立的方案。

### 1.4 可追溯优先于省事

每一次 Agent 工作都留下一条 `execution` 记录（含上下文哈希、提示词哈希、
使用的模型别名与实际解析结果、第几次尝试），以及一条**事件时间线**（trace）。
界面上能看到「系统当时给了它什么、它做了什么、为什么被拒」。
任何新特性都要回答「它在时间线上长什么样」。

---

## 2. 技术形态

| 项 | 取值 |
|---|---|
| 形态 | TypeScript **模块化单体** |
| 运行时 | Node 22 · Fastify 5 |
| 存储 | **better-sqlite3**（选它是因为**同步 API**，不是性能——见 §4.3） |
| 前端 | React 18 + Vite 6 + TanStack Query |
| 校验 | Zod 3（**契约单一来源**，前后端都从它 `z.infer` 推类型，不手写 interface） |
| 测试 | Vitest 2 |
| 实时 | SSE（不是 WebSocket） |
| 日志 | pino（带 redact） |
| Provider | OpenAI 兼容协议；当前用 DeepSeek 官方 |

### 2.1 分层（由 ESLint 机器强制，不靠自觉）

```
shared  ←  domain（纯函数，零 IO）  ←  application  ←  runtime / infrastructure  ←  api
```

- `domain/` 是纯函数，**不许碰 IO**，分支覆盖率强制 **100%**（配置里的真门槛，不是愿望）。
- 前端只能 import `@shared`，碰不到服务端任何东西。
- 越层 import 是 lint 错误，不是 code review 意见。

### 2.2 部署形态：前后端分离

```
静态托管（生产 nginx / 本地 vite preview）        Fastify :3311
  └── dist/client/                                └── /api/*   仅此一项
```

**后端永远只有 `/api/*`，这条由代码强制**——注册非 `/api` 路由会在服务构造期直接抛异常。
（原因：违规**没有任何报错**，静态托管会把非 `/api` 路径 fallback 到 index.html，
线上表现是「路由写了没生效」。）

**这个部署形态当初就是为了本次要做的特性定的**——业务方的原话是
「后续要加 CLI 操作方式和审核打回机制，前后分离改起来清晰」。
所以：**新端点一律挂 `/api/` 下面**，前端是独立部署件。

---

## 3. 数据模型

八张表（SQLite）：

| 表 | 作用 |
|---|---|
| `tasks` | 任务。`status` × `phase` 两个正交维度 |
| `task_snapshots` | **冻结的模板副本**（见 §4.1） |
| `task_skill_snapshots` | 冻结的 Skill 文档副本 |
| `slots` | 结构槽位（复合主键 `(task_id, slot_id)`，父子自引用） |
| `executions` | 每一次 Agent 工作的记录 |
| `trace_events` | 事件时间线（追加写，单调递增 id） |
| `artifacts` | 装配出的最终产物 |
| `provider_health` | 建了但 P0 **无写入方**（刻意，健康状态跨重启后多半是错的） |

### 3.1 状态取值（与数据库 CHECK 约束**逐字一致**）

```ts
TaskStatus  = 'ready' | 'running' | 'stopped' | 'completed' | 'failed'
TaskPhase   = 'structure' | 'slots' | 'assembly' | 'done'      // 与 status 正交
SlotStatus  = 'pending' | 'running' | 'completed' | 'failed'
Operation   = 'create_structure' | 'fill_slot'                  // 只有这两条生产路径
ExecStatus  = 'created' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale'
```

> ⚠️ 这几个枚举**同时出现在三处并且必须一致**：Zod schema、数据库 CHECK、
> domain 层的状态机与派生表。改动任何一个取值都是四处联动 + 一次迁移。

### 3.2 两条值得知道的 CHECK 约束

```sql
-- REQ AC-009：完成的内容槽必须同时具备正文与生产者，杜绝「部分完成」
CHECK ( NOT (status = 'completed' AND content_bearing = 1)
        OR (content_text IS NOT NULL AND producer_agent_id IS NOT NULL
            AND producer_skill_id IS NOT NULL AND producer_execution_id IS NOT NULL) )

-- 容器槽位不得有正文
CHECK ( NOT (content_bearing = 0) OR content_text IS NULL )
```

### 3.3 `executions` 的关键列

```
id, task_id, operation, target_slot_id, agent_id, skill_id, skill_version,
token_hash,                          -- 执行凭据（§4.3）
context_json, context_hash,          -- 系统当时喂进去的确定性上下文 + 它的哈希
prompt_hash,                         -- 与 context_hash 分离
model_alias, provider, model,        -- 冻结别名 + 执行时解析结果
attempt_number,                      -- UNIQUE (task_id, target_slot_id, attempt_number)
status, input_tokens, output_tokens, error_code, error_message, ...
```

---

## 4. 五条地基不变量（**新设计撞到哪条，就必须在方案里正面回答**）

这一节是这份文档的重点。前面都是背景，这里是约束。

### 4.1 AC-002：任务读的是**冻结快照**，永远不读磁盘

建任务的那一刻，系统把模板 + 全部 Skill 文档**拷贝一份存进数据库**。
之后这个任务的每一次执行都只读自己那份快照。改磁盘上的模板不影响在跑的任务。

**为什么重要**：它保证「同一个任务的每一步看到的规则是同一套」，
也是产物可复现的基础。

> 🔴 **这是审核返修最硬的一处碰撞。**
> 快照在**建任务时**冻结，而「你这段写得不行，改成 XX」是**建任务之后**
> 才产生的**新输入**——它在快照里没有位置。
> 返修意见放哪、算不算快照的一部分、要不要引入快照代际，是必须回答的问题。

### 4.2 AC-014：完成由**系统**判定

Agent 不得自行宣布完成。它必须调 `complete_assignment` 工具提交，
系统做确定性校验后才算数。「模型说了一堆『我已完成』但没调工具」是
一条**必须处理的失败分支**（错误码 `ASSIGNMENT_OUTPUT_INVALID`），不是边缘情况。

> 🔴 **人工审核是要往这里插进第三个裁判。**
> 打回究竟是一种**新的裁决权**（人可以否决系统已判定的 completed），
> 还是只是**下一次生产的输入**（人的意见变成新一轮 Assignment 的上下文）？
> 这个答案决定了后面所有东西的形态。

### 4.3 D-10：执行凭据的校验必须与写入**同事务、同一条语句**

每次 Assignment 会发一个一次性 token，它的哈希存在 `executions.token_hash`，
同时 `tasks.active_execution_id` 指向它。提交槽位内容时，
**校验与写入压在同一条 `UPDATE ... WHERE` 里**，绝不「先读后判再写」：

```sql
UPDATE slots SET content_text = ?, status = 'completed', ...
WHERE task_id = ? AND slot_id = ? AND status = 'running'
  AND EXISTS (SELECT 1 FROM executions e JOIN tasks t ON t.active_execution_id = e.id
              WHERE e.id = ? AND e.token_hash = ? AND e.status = 'running'
                AND e.target_slot_id = slots.slot_id
                AND e.task_id = slots.task_id)
```

防的是「用户点了停止，而一个慢吞吞的模型回复在之后才到达」这个插队窗口——
迟到的结果必须被拒绝（`late_result_rejected`），而不是覆盖掉已停止的状态。

> ⚠️ 选 better-sqlite3 的**唯一原因**就是它的同步 API 让这件事成立。
> 硬性约定：**事务回调里绝对不能出现 `await`**（有类型 + lint 双重强制）。
> 一旦有 await，事务会在 await 点提交，全部原子性保证静默失效。

> 🟡 **审核打回会撞上同一个插队窗口**：在某个槽位正在跑的时候点「打回」，
> 与点「停止」是同一类竞态。

### 4.4 D-11 / D-20：提交闸门 + 「被拒 ≠ 本次工作结束」

- 提交闸门**只在成功时关闭**。被确定性校验拒绝的提交，返回一条
  `isError: false` 的工具结果（正文是三段式违规说明），意思是「你还可以再试」。
- **被拒的提交只写 trace，不收敛 execution、不让出活动执行位、不动槽位状态。**

这条是踩过坑才定的：曾经在被拒路径上顺手把 execution 标失败，
结果模型照着提示改好、在同一轮里重新提交时，被系统自己判成了「迟到结果」——
**一个本该被接受的正确结构，被判成了过期**。

**它还带来一个两个数量级的成本差**：同一次 Assignment 内改错只花几百 token
（模型带着全部上下文增量修正），而跨 Assignment 重试要烧掉一整个 attempt。
一份「先错两次再改对」的提案，修好后从 **3 个 failed execution** 变成
**1 个 succeeded execution**。

> 🟢 **这条对审核返修是正面参考**：它已经证明了「反馈—修正」的两层结构，
> 以及「便宜的那层要尽量用上」。人工返修意见是不是也该有对应的两层，值得想。

### 4.5 一条**隐含约定**：改状态的地方**必须写 trace**

SSE 的 `state` 事件（告诉前端「状态变了，去重新拉一次」）**不是各处显式推送的**，
而是由 SSE Hub 在**每条 trace 推送之后**读一次权威状态、与上次比对、变了才推。

这样做是为了避免「十几个状态迁移点，漏掉任何一个都表现为界面卡在旧状态、
刷新一下才对」——最难被测试抓住的那类 bug。

代价是一条隐含约定：**存在「改了状态但不写 trace」的路径，前端就收不到通知。**
目前不存在这种路径（八条事务边界每条都写 trace）。

> 🔴 **审核动作会是第一个不由生产引擎发起的状态变更**——它来自 HTTP 请求，
> 不走引擎的 tick 循环。这是这条约定第一次被真正威胁。

---

## 5. 生产循环长什么样

一次 Assignment（= 一次 Agent 工作）的流程：

```
引擎选出下一个要干的活
  → 系统确定性地构建上下文（不让模型自己找）
  → 发一次性执行凭据，写 executions 行
  → 进入 Agent 对话循环（流式）
      模型可用的工具只有 6 个：
        read_task_input          读本次任务输入
        read_skill_section       按需读 Skill 文档的某一节（不是整篇塞进去）
        read_structure_outline   读当前结构树
        read_slot                读别的槽位已产出的内容
        report_work              汇报理解/计划/决策/进度（进时间线，给人看）
        complete_assignment      ★ 唯一的提交出口
  → complete_assignment 触发确定性校验
      通过 → 闸门关闭，本次 Assignment 结束
      不过 → 返回结构化违规清单，继续同一轮对话（D-20）
  → 全部内容槽完成 → 系统装配产物
```

**结构提案要过 19 条确定性校验**（根节点唯一、深度不超限、槽位类型必须在模板声明内、
依赖不成环……），失败反馈是结构化且可执行的（指出**哪个节点、违反哪条、怎么改**），
不是一句「格式错误」。

**时间线事件种类**（当前 26 种，前端按它渲染）：

```
task_state_changed, assignment_created, assignment_started, context_built,
skill_loaded, skill_section_read, work_understanding, work_plan, work_decision,
work_progress, work_completion, tool_call_started, tool_call_completed,
public_output_chunk, assignment_submitted, validation_passed, validation_failed,
assignment_completed, assignment_failed, assignment_cancelled, late_result_rejected,
slot_state_changed, assembly_started, artifact_created, provider_retry, task_queued
```

> 新增事件种类会动契约（前后端共享的 Zod enum + 前端渲染分支）。
> trace 的 payload 有**键名黑名单**（命中即解析失败），这是脱敏要求的机器化。

---

## 6. 现在到哪了

| 里程碑 | 状态 |
|---|---|
| M0 契约与骨架 | ✅ |
| M1 Domain 纯函数（19 条结构校验、状态机、装配、派生投影） | ✅ 分支覆盖强制 100% |
| M2 持久化与事务（6 仓储、UoW、8 条事务边界、快照冻结） | ✅ |
| M3 生产引擎闭环（Provider / 工具 / Agent 循环 / 服务层 / CLI） | ✅ |
| M4 真实 Provider 与调优 | ✅ 结构提案首次通过率 **20/20** |
| M5 API 与 SSE（22 个端点） | ✅ |
| M6 前端（六个页面 + 工作台三栏） | ✅ |
| M7 加固与验收（脱敏审计、E2E、32 槽位规模、连续 10 章） | ✅ |

**实测**（真服务 + 真 DeepSeek，经 HTTP 创建 + SSE 观察 + 下载产物）：
单章约 **85–91 秒**，5/5 槽位，产物约 9–13 KB，
154 条 trace / 2566 条 delta，**全库扫描 API Key 与隐藏推理：0 命中**。

### 已知缺口（与本次设计相关的）

- **UX §13.5 只做了一半**：已完成的槽位**看不到技术详情**
  （上下文哈希 / 提示词哈希 / 起止时间），「复制 Trace / 导出 JSON / 导出 Markdown」
  三个动作也没实现。
  → *注意：审核员恰恰是需要看这块面板的人，这个缺口应该并进本次设计一起考虑。*
- **前端 SSE 合并 / 断线重连 / 首连播种没有测试**——是最容易错的一块，
  而审核返修要往同一条通道加新状态。
- `executions.input_tokens / output_tokens` **恒为 NULL**（时序问题：
  提交发生在工具调用内部，而用量在流的最后才到）。别把它当可用数据。

---

## 7. 本次要设计的东西：**审核返修（审核打回）机制**

### 7.1 出发点

产物跑出来了，人看完觉得**某个槽位写得不行**，想让系统带着修改意见重做那一段，
而不是整章推倒重来。

### 7.2 它不是「补一个功能」，是一次范围反转

REQ §7 明确把 Slot Review 列为**非目标**，FR-SLOT-004 明写「P0 不进行语义质量审核」。
因此设计方案需要把它作为**一次明写的反转**处理，并说明反转之后
§1.2 的「确定性校验 vs 写作要求」二分是否还成立、人工审核落在哪一侧。

### 7.3 必须正面回答的四个问题

| # | 问题 | 撞到的地基 |
|---|---|---|
| 1 | **裁决权归谁。** 人的「打回」是一种可以否决系统判定的新权力，还是仅仅是下一次生产的输入？ | §4.2 AC-014 |
| 2 | **返修意见存在哪。** 它是建任务之后产生的新输入，冻结快照里没有它的位置。挂在 execution 的上下文上？新开快照代际？还是第三种东西？ | §4.1 AC-002 |
| 3 | **状态机怎么改。** `SlotStatus` 现在只有 4 个值，且与数据库 CHECK 逐字一致、domain 层 100% 分支覆盖、还有两张派生投影表按它渲染界面。需要新状态吗？如果需要，是几个？ | §3.1 |
| 4 | **审核动作在时间线上长什么样。** 它是第一个不由引擎发起的状态变更（来自 HTTP，不走 tick），必须写 trace，否则界面会静默卡在旧状态。 | §4.5 |

### 7.4 还需要考虑的几点

- **正在跑的时候打回**，与「停止」是同一个插队窗口（§4.3）。
- **打回一个槽位，下游槽位怎么办？** 场景 2 是读着场景 1 的内容写的
  （`read_slot`），场景 1 改了，场景 2 还算数吗？系统是该级联失效、
  该提示、还是该不管？——这一条可能是整个设计里**产品影响最大**的。
- **历史怎么留。** 被打回的那一版内容是覆盖掉还是留档？
  `slots.content_text` 现在是单值列，留档意味着建表。
- **产物已经装配之后再打回**呢？`artifacts` 已经有一行了。
- **CLI 也要能用**（业务方明确要的第二个功能是 CLI 操作方式），
  所以审核不能只设计成一个前端交互。

### 7.5 明确**不需要**考虑的

- 多用户 / 角色 / 权限（单机单用户）。
- 并发（P0 固定串行）。
- 让 AI 来做审核（这是「人来审」，不是「加一个审核 Agent」——
  如果你认为该有 AI 预审，那是一条独立提案，请单列，不要混进主线）。

---

## 8. 这个项目的工作规矩（决定了什么样的设计产出是可用的）

1. **实现与文档冲突 → 先改文档，再改代码。** 所有决议以编号形式沉淀
   （目前 D-01 … D-20），每条写清「原文 / 为什么改 / 不改的代价」。
   **所以本次设计的产出应该是「一条新决议 D-21 + REQ 范围修订」的形态**，
   而不是直接给代码。
2. **每条断言都要反证过。** 任何测试都必须验证过「把产品代码改坏时它会变红」。
   空断言比没有断言更糟。
3. **不留装饰性实现。** 曾经写过一段自认为能防 SSE 缓冲的代码，
   按「去掉它看有没有区别」一验——**完全没区别**，删掉了。
   一个看起来生效、实际什么都没做的机制比没有更糟：它会让人误判问题已经解决。
4. **命名与报错必须诚实。** 曾经有个 bug 是错误信息在撒谎：真实原因是环境变量没配，
   界面上却显示「结构提案未通过确定性校验」，把排查方向引向完全错误的地方。

### 8.1 期望的设计产出形态

最有用的是这样一份东西：

- **先给出对 §7.3 四个问题的明确取舍**（每个问题一个决定 + 被否掉的选项 + 否掉的理由）。
  尤其是问题 1，其余三个多半是它的推论。
- **列出这个方案要动的地基**：哪条不变量被修改/放宽了，代价是什么。
- **给出至少一个替代方案并说明为什么不选它**——只有一个方案的设计通常是没做过取舍的。
- **点出这个方案自己解决不了的问题**（比如 §7.4 的级联失效，如果决定不管，就明写不管）。
- 暂时**不需要**具体的 TypeScript 代码、表结构 DDL 或 API 路径细节，
  那些在决议定下来之后是机械工作。

---

## 附：术语对照

| 词 | 含义 |
|---|---|
| **槽位 Slot** | 结构树上的一个节点。有的产出正文（内容槽），有的只是容器 |
| **工作槽位** | 产出内容供下游读取、但**不进最终产物**的槽位（比如「章节骨架」） |
| **Assignment** | 一次 Agent 工作单元。不建独立表，物化为一行 `execution` |
| **Execution** | 一次执行记录。同一个槽位重试会产生多行（`attempt_number` 递增） |
| **快照 Snapshot** | 建任务时冻结的模板 + Skill 副本 |
| **Skill** | 给 Agent 看的 Markdown 工作指南，按节（section）按需读取 |
| **Trace** | 事件时间线，界面上「这次跑了什么」的唯一依据 |
| **别名 alias** | 模板里写 `model: main`，实际映射到哪个 provider/模型在**执行时**才解析 |
| **确定性校验** | 机器可判的规则（字数、正则、结构合法性），系统强制 |
| **写作要求 guidance** | 注入模型上下文的软要求，系统**不**强制 |
