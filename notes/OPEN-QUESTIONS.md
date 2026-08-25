# 开发过程中的待决问题与观察

> 用户已授权本轮自主开发，不中途提问。所有需要人决策、或我做了但你可能想推翻的判断，都记在这里。
> 每条标注：**发现时间 / 所属里程碑 / 我采取的临时处置 / 需要你决定什么**。

---

## Q-01 设计系统样式表引用了 Google Fonts 外链

- **时间**：2026-08-20，M0
- **事实**：`design_handoff_forge_core_vnext/_ds/classical-*/styles.css` 首行
  `@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond...&family=Lora...')`。
  拷贝进 `src/client/styles/tokens.css` 时原样保留了。
- **影响**：本地/内网离线环境下字体回退到 `system-ui`，视觉会明显走样；
  另外每次加载会向 Google 发一次请求。
- **临时处置**：保留外链，M0 不动。
- **需要你决定**：是否把 Cormorant Garamond / Lora 下载为本地 woff2 自托管。
  如果这个工具将来要在无外网环境跑，就必须自托管。

---
## Q-02 我自主追加了决议 D-18（外键完整性），请你回看是否认可

- **时间**：2026-08-20，M0
- **触发**：数据库层落地时复核 §5.2 的 DDL，发现三处引用没有外键约束
  （`task_snapshots.task_id`、`tasks.active_execution_id`、`slots.producer_execution_id`），
  原因是循环引用导致插入顺序成死结。
- **为什么必须管**：D-10 把 Execution Token 的全部校验压进了一条 UPDATE 的 WHERE 子句，
  那条子句的正确性建立在 `t.active_execution_id = e.id` 上。库层不保证这个引用有效，
  就等于把 D-10 的安全性从**约束**降级成**约定**。
- **我的处置**：三处改用 `DEFERRABLE INITIALLY DEFERRED` 外键（COMMIT 时才校验，
  插入顺序不再是约束）。同批还加了 `executions` 的唯一约束和 `idx_executions_status` 索引。
  已写入文档 §1 的 D-18，DDL 同步修订。
- **需要你确认**：D-18 是我在你休息期间自行拍板的唯一一条决议。其余全部按既有文档执行。
  如果你不认可延迟外键这个方向（比如担心 SQLite 的延迟外键行为），推翻它的代价还很小——
  目前只有 migrations 两个文件依赖它。

---
## Q-03 我又自主追加了决议 D-19（派生层的取用边界 + 规则表兜底），同样请你回看

- **时间**：2026-08-21，M1
- **触发**：写附录 B 的实现时发现两条规则**根本无法求值**：
  一条的判据字段（`operation`）不在槽位上、另一条的输入（违规列表、超时秒数）不在函数签名里。
  根因是规则表和函数签名是分开写的，中间没有任何一致性机制。
- **我的处置**（已全部落进文档与代码，7 条子项）：
  1. 失败原因的**成文责任划给 lifecycle 层**，派生层只取用 `lastFailureReason`，不解析不拼装；
  2. B.1 补第 14 行兜底（`TaskStatus × TaskPhase` 有 20 种组合，原表只覆盖了一部分）；
  3. 删掉签名里没人读的 `isActiveExecution`（死参数留着，下一个人会以为它有意义）；
  4. `agentName` 改必填 `string | null`，取消「Agent」默认值（静默降级会掩盖接线缺失）；
  5. B.2 第 7 行拆成 7 / 7'，工作槽位是「N 字 · 不进正文」，不叠加「校验通过」；
  6. `canonicalJson` 加循环引用检测（原来会栈溢出，且报错不带任何定位信息）；
  7. 空产物的拒绝责任留给 M2 的 assembly-service，纯函数只返回 `''`。
- **反制措施**：每条规则都有一条**以表格行号命名**的单测。规则不可求值会在写测试时就炸，
  而不是等到界面渲染出空白。
- **需要你确认**：与 D-18 一样，这是我自行拍板的。推翻成本仍然低（只影响 domain 四个文件）。

---
## Q-04 M1 复盘中裁定的若干文档不一致（已改文档，列出供复核）

均按项目规则「先改文档再改代码」处理，代码与文档现已一致：

| # | 不一致 | 裁定 |
|---|---|---|
| 1 | §6.1 标题写「18 条规则」，表里 19 行，`StructureRuleId` 18 个取值 | **规则 19 条、枚举 18 个**。第 19 条复用 `NO_ROOT`（对 Agent 是同一件事、同一种修法）。文档已澄清，笔误处已改 |
| 2 | `depth` 0 基（DTO/缩进）vs 1 基（报错文案「第 5 层」） | **刻意差一，不对齐**。判据 `depth + 1 > maxStructureDepth`。已写进 §3 DTO 说明 |
| 3 | `providers.yaml defaults.maxRetries` 文档写 1，D-06 的 `maxExecutionRetries` 默认 2 | **统一为 2**。前者是回退链最后一级，取 1 会让没配 limits 的模板只有 2 次机会满足 19 条校验，而 §4.1 明说 3 次是「决定产品成败」的取值 |
| 4 | D-16 把 `includeInArtifact` 放在**类型**上，D-18 的例子却要求**槽位**级 | **权威来源只有模板的 `SlotTypeDefinition`**。`slots` 表那一列是提交时从类型解析出的物化投影，不是独立编辑点；`SlotProposalSchema` **不该**有这个字段——「我的产出算不算交付物」是流程控制，属 System，不能交给 Agent |
| 5 | `vitest.config.ts` 门槛 70% vs §11.1 要求 Domain 100% 分支 | **门槛改成真门槛**：per-glob `src/server/domain/**` 要求 100%，现已达标（194 测试全绿）。写在配置里才是约束，写在文档里只是愿望 |
| 6 | B.2 第 7 行对「completed 但无正文」渲染成「0 字 · 校验通过」 | 补第 7″ 行 → `warn / 数据异常`。AC-009 由 CHECK 保证落库数据到不了这里，但纯函数不挑调用方，而这是整张表里唯一会**主动撒谎**的输出 |

**同时修掉的一个真实 bug**：`assembly.ts` 与 `readiness.ts` 各有一份同级排序比较器，
两边注释都写着「必须与对方逐字一致」，而实际一个用 Unicode 码点序、一个用裸 `<`（UTF-16 码元序），
对 BMP 外字符给出**相反**顺序——即「产物顺序」与「生产顺序」分叉。
现已合并为一个导出函数，让第二份实现根本不存在。今天被 slot id 正则挡着看不出来，
但 `readiness.ts` 自己的注释声明它要容忍「不受今天校验保护的历史数据」。

---
## Q-05 留给 M3 的一个已知不足（不需要你现在决定）

`FakeProviderScript.invalidStructure` 在文档里只列了 4 种非法结构变体，而结构校验有 19 条规则。
M3 建 Fake Provider 时应当把它扩到「每条规则至少一个失败夹具」，否则 §11 声称的
「19 条规则各有失败 fixture」在集成层是落空的。记在这里免得到时候忘了。

---
## Q-06 M2-A 留给 M3 的四条接口合同（不需要你决定，是给 M3 的备忘）

1. **`executions.context_json` 存的是「已规范化的 JSON 文本」，不是对象。** 仓储刻意不自己
   `JSON.stringify`：D-12 要求 `contextHash` 与这段文本**逐字对应**，序列化发生在两个地方
   hash 就不再可靠。M3 的 ContextBuilder 必须用 `domain/canonical.ts` 的 `canonicalJson`
   产出这段文本**并据此算 hash**。`snapshots.compiledJson` / `skill.sectionIndexJson` 同理。

2. **限流退避与 `started_at` 打架。** 仓储按「每次 attempt 新建 execution」实现
   （`UNIQUE (task_id, target_slot_id, attempt_number)` 就是这个语义），`started_at` 只由
   `markRunning` 写一次。但 D-04 的限流退避明确「不创建新 Execution、不递增 attemptNumber」。
   M3 需要决定：退避后重发要不要重打 `started_at`（关系到超时是从哪一刻起算）。仓储目前没这个动作。

3. **`create_structure` 的 attempt 唯一性没有库层保护**——SQLite 的 UNIQUE 在 NULL 上失效，
   而结构 execution 的 `target_slot_id IS NULL`。M3 的结构重试路径必须自己保证不出重复 attempt 号。

4. **§8.3 `stopTask` 要在事务回调里读 `activeControllers` 这个内存 map。** 同步读，不违反
   `NotPromise` 约束，但 M3 必须保证那个 map 的读取**始终是同步的**——一旦有人把它换成
   异步查询，D-10 的全部原子性保证会静默失效。

---
## Q-07 M2-A 改的两处文档（已改，供复核）

1. **§8.4 `diagnoseStaleReason` 的签名原本查不出它自己列的判据。** 原签名只有 `executionId`，
   而五条判据里有三条需要提交方出示的 `tokenHash` 与 `taskId`/`slotId`——那三条会被一律归因成
   「未知原因」，这个函数也就白加了。已改为 `diagnoseStaleReason(db, { executionId, tokenHash, taskId, slotId })`，
   判据补到十条，并写死「只允许在 `changes !== 1` **之后**调用」——否则它会被当成前置校验，
   退回 D-10 明令禁止的「读-判-写」。

2. **§5.5 的「提交 Structure」原本没点名 D-10。** 只有「提交 Slot Content」写了条件 UPDATE，
   但结构提交面对的是同一个 stop 插队窗口，而且漏判后留下的是**一整棵不该存在的结构树**，
   比单个槽位的脏内容更难清理。已补上条件 UPDATE 的 SQL 与「为什么这里不需要完整 `EXISTS`」的说明。

---
## Q-08 D-10 的条件 UPDATE 少了一行，已补（真实缺口，附回归测试）

- **时间**：2026-08-21，M2 复审
- **事实**：文档 §1 D-10 给的 SQL（M2-A 逐字实现了它）在 EXISTS 子查询里只对齐了
  `e.target_slot_id = slots.slot_id`，**没有** `e.task_id = slots.task_id`。
  而 `slot_id` 只在任务内唯一（`slots` 主键是复合键）。于是：任务 A 上一个合法在跑的
  execution，可以把内容写进任务 B 里同名的 `scene_01`——只要调用方把 taskId 传成 B。
- **为什么必须补**：D-10 这条语句存在的**全部意义**就是「不依赖调用方传对参数」。
  说「今天调用方是我们自己的代码，够不着」，等于把这条自证机制降级成又一条约定。
- **处置**：文档 §1 D-10 与 `slot-repo.ts` 同步补上该行，并加了一条回归测试
  （已验证：去掉该行时测试变红，加回则绿）。

---
## Q-09 M2-B 复审：一处裁定 + 一处真实缺陷 + 未处理项

**裁定（M2-B 明确留给我决定的）：模板编译期要不要校验模型别名存在性 → 要。**

D-03 的「晚绑定」推迟的是**别名 → provider/model 的取值**，好让换模型不必重建历史快照。
它**不是**「别名写错了也要拖到执行时才发现」的许可。加载期放行的代价是：
任务创建成功、跑起来、烧掉一次 Assignment 才失败，而报错指向运行期而不是那行 YAML。

两道检查都保留，因为防的不是同一件事：编译期防**模板作者打错字**（此时 providers.yaml
就在手边，`defaults` 本来就要读它，查一下几乎不要钱）；运行期的 `MODEL_ALIAS_UNRESOLVED`
防**providers.yaml 在编译之后被改瘦**（别名被删/改名），编译期检查对此无能为力。
已实现为 `TemplateLoaderOptions.knownAliases`（可选，缺省不校验，便于纯编译测试）。

**M2-B 查出的一个真实文档缺陷（值得单独记）**：§4.1 示例里的
`forbidPattern: '(?m)^#{1,6}\s'` **不是合法 JS 正则**——V8 抛 `Invalid group`（已实测复现）。
`(?m)` 这种全局内联前缀在 PCRE / Python 合法，JS 只支持带作用域的 `(?m:...)`。
照抄规范写模板的人会得到语法错误，而他抄的正是规范里的例子。
处置是保留这个写法（跨语言正则的通用习惯），由编译期把前缀翻译成 `RegExp` flags。

**M2-B 改的其余文档**：§2.1 目录树（loader 从 infrastructure 移到 application）、
§4.1 新增编译期校验清单（8 类）与 forbidPattern 时间预算的实现要求、
`skills[].source` 的基准目录定义、§4.3 新增 `fill_slot` 必须声明 `slotTypes` 的约束。

**未处理、留给后续的**：
- `ExecutionDefaultsSchema` 里没有 `maxToolCallsPerAssignment`，所以它被定为模板必填。
  若将来想给它全局默认，要同时改 §4.2 / `providers.yaml` / `ExecutionDefaultsSchema` 三处，
  **不要单点加**。留给 M4 决定。
- `presentation.exampleStructure` 的 `depth` 不校验父子自洽（可能从 0 跳到 2）。
  纯展示字段，但前端按 `depth × 20px` 缩进，跳级会渲染出悬空节点。留给 UI 层。
- 文档 §3.5 的 `SlotTypeDetailSchema` 代码片段仍是旧的（`contracts.ts` 已在 M0 修过）。

---
## Q-10 M2 收口：M2-C 复审记录

M2-C 的 agent 在写完全部代码与测试之后、提交报告之前被会话额度打断，因此没有交付报告。
我接手做了复审：实现与测试都在，340 条测试全绿，`tsc` / `eslint` 干净，
Domain 100% 门槛未破，application 层 98%。它**没有**改动文档。

**我修掉了它留下的两条失败测试。两条都是测试的判据写错了，不是实现有问题：**

1. 「presentation 不进 compiled_json」原本用**值级子串扫描**：遍历 `presentation.tags`
   断言每个 tag 都不出现在编译产物里。但 tag 里有「写作 Agent」，而 `agents[].name`
   正当地存在「章节写作 Agent」——一个完全合法的编译产物会被判成泄漏。
   （同一个坑作者已经在 `outputKind` 上踩过一次并绕开了，没意识到 tags 是同类问题。）
   改为**按结构验**：递归收集编译产物的全部键名，断言 `presentation` / `outputKind` /
   `tags` / `exampleStructure` 一个都不存在。presentation 有没有被剥离本来就是结构问题。

2. 「快照里搜不到凭据」的反向断言写成在整库 dump 的 JSON 文本里找 `"modelAlias":"main"`。
   但 `compiled_json` 在整库 dump 里是**被转义了一层的字符串**，那个子串根本不会以这个
   形状出现——断言的是序列化的偶然形状，不是事实。改为解析出 `compiled_json` 再断言对象字段。

**两条改后的断言我都做了反向验证**（故意把 presentation 塞回快照、故意改写 modelAlias），
确认它们会变红，不是空断言。

**M2 完成判据逐条核对**：§5.5 八条事务边界各有成功 + 回滚测试（回滚断言是全库逐字节相等）✓；
CHECK 约束违反测试 ✓；`run(async ...)` 编译期拒绝 ✓；五类非法模板各有独立用例 ✓；
快照隔离走真实文件路径（真拷贝、真改写、真重扫）✓。

---

## Q-11 M3-A（Runtime 层）：Q-05 已闭环 + 五处文档修订 + 三条留给后续

**Q-05 闭环**：`FakeProviderScript.invalidStructure` 已从 4 个字面量扩到
`Record<StructureRuleId, StructureProposal>`（18 项，覆盖 19 条规则——第 19 条复用
`NO_ROOT`，D-19）。夹具在 `src/server/runtime/provider/invalid-structures.ts`，
用 `Record` 声明，于是「新增规则忘了加夹具」是编译错误。每条规则一个测试，
外加一条「参照结构必须合法」的反向断言（防止整组断言恒真）。

**改了文档五处**（均先改文档后写代码）：

| # | 位置 | 改动 | 理由 |
|---|---|---|---|
| 1 | §7.3 | `ProviderTurnResult` 补 `appendMessages`，并定案中性的 `ProviderMessage` | 原结构下 §7.6 的 `buildToolResultMessages(turn)` **写不出来**：turn 里既没有 assistant 消息也没有 tool call 的 id，而 id 是 Provider 分配的 |
| 2 | §7.2 | `ResolvedModel` 补 `alias`；`apiKey` 定为不可枚举属性 | `executions.model_alias` 要写它；不可枚举挡住「整个对象被 stringify 进日志」这类最常见泄密 |
| 3 | §7.5 | `buildToolset` 收 port 而非 `TraceService`/`CompletionService`，补 `structure`/`onSubmitted`/`onRejected` | Runtime 夹在两个 application service 中间，直接 import 会互相引用，Runtime 集成测试就没法「无网络」了 |
| 4 | §7.6 | `no_submission` 拆成「提交被拒」与「压根没提交」两种收敛 | 混成一个码会让「结构一直写错」和「模型不会用工具」在 UI 上长得一样，而两者处置完全不同 |
| 5 | §8.5 | 定案退避包在 `runTurn` 一次调用上；`Retry-After` 封顶到 `maxMs`；退避后重查 `signal.aborted` | 包住循环会重放已成功的工具调用；`Retry-After: 86400` 不该让任务挂一天 |
| 6 | §11.2 | FakeProviderScript 四处修订（见 §11.2 正文） | 见该节表格 |

**留给后续，我没动的三条**：

1. **`maxTokens` 没有配置来源。** §7.3 的 `runTurn` 要 `maxTokens`，但
   `ExecutionDefaults`（§4.2 / `contracts.ts`）与 `template.yaml` 的 `limits` 里都没有它。
   我把它做成 `Assignment` 的必填字段由调用方给，实际值目前无处可取。
   与 Q-09 里 `maxToolCallsPerAssignment` 是同一类缺口，建议一起在 M4 定：
   要么进 `ExecutionDefaults`（则 §4.2 / providers.yaml / schema 三处同改），
   要么进模板 `limits`。**不要单点加。**

2. **限流退避耗尽后算不算消耗 `maxRetries`，D-04 没写。** D-04 只说了
   `PROVIDER_TIMEOUT` / `PROVIDER_ERROR` / 校验失败消耗配额，没说退避耗尽的那次。
   我裁定为**消耗**（`consumesRetry: true`）：不消耗意味着调用方可以无限重跑，
   那是真正的烧钱路径。若你不认可，改动点只有 `assignment-runner.ts` 的一个字段。

3. **`provider_health` 表没有仓储。** §2.1 列了 `provider-health-repo.ts`，M2 没建。
   ProviderRegistry 的健康状态目前只在内存里，进程重启即丢。
   D-03 说健康要「跨请求持久化供 UI 查询」——同一个进程内的跨请求是够的，
   跨重启不够。M5 接 `/api/providers` 时需要决定要不要补这张表的仓储。

**M3-A 自查**：84 条 runtime 测试；六条收敛分支（submitted / aborted / no_submission /
max_tokens / 工具超限 / 未知工具名）各有独立用例；限流退避「不递增 attempt」用
`assignment_started` 只有一条来证；abort 中断用「耗时远小于 hangMs」来证（不响应 abort 时会红）；
密钥不外流用整体 dump 反查 + 一条「dump 非空」的反向断言。

---
## Q-12 D-20：提交被拒 ≠ 本次 Assignment 结束（M3-C 接线时发现的真实死锁）

- **时间**：2026-08-21，M3-C
- **触发**：接线后跑第一条端到端用例，一个**完全合法**的结构提案被系统判成
  `EXECUTION_STALE`（迟到结果）。
- **根因**：两处实现各自作了相反的假设，单独看都自洽，接起来就死锁：
  - Runtime（M3-A）按 D-11 实现：`SubmissionGate` **只在成功时关闭**，被拒的提交
    返回一个 `isError: false` 的工具结果、正文是三段式违规——意思是「你还可以再试」。
  - Application（M3-B）在被拒路径上顺手 `markFailed` + 把 `active_execution_id` 置空。
  - 于是模型照着违规提示改好、在同一轮对话里重新提交时，D-10 的 WHERE 发现活动执行
    已经没了 → `EXECUTION_STALE`。**一个本该被接受的正确结构，被系统自己判成了迟到结果。**
- **裁定（已写入文档 §6.1 的 D-20）**：被确定性校验拒绝的提交**只写 trace**，
  不收敛 execution、不让出活动执行位、不动槽位状态。一次 Assignment 何时结束
  只由 ProductionEngine 决定。会话内的重复提交由 `maxToolCallsPerAssignment` 兜底。
- **收益不只是「不死锁」**：这套设计本来就有两层反馈，代价差两个数量级——
  同一次 Assignment 内改错只花几百 token（模型带着全部上下文增量修正），
  而跨 Assignment 重试要烧掉一整个 attempt。修好之后，一份「先错两次再改对」的
  结构提案从 **3 个 failed execution** 变成 **1 个 succeeded execution**。
- **连带删除**：`SubmissionRecord.executionSettled` 与
  `CompletionService.markSlotExhausted` 随之成为死代码，已删（D-19 的一贯态度）。

---
## Q-13 一条「错误信息在撒谎」的 bug，由 CLI 首次真实运行暴露

CLI 第一次跑通接线时失败，界面上的原因是**「结构提案未通过确定性校验」**，
而真实原因是少配了一个环境变量（`DEEPSEEK_API_KEY` 缺失 → 模型别名解析不出）。

根因：`markExhausted` 无条件用 `composeReason(violations)` 成文，而 `violations`
为空时它返回一句写死的「结构提案未通过确定性校验」。超时、Provider 报错、
缺配置——这三类失败的 violations 都是空的，于是全被说成校验问题。

这类 bug 比崩溃更贵：它把排查方向直接引向 Skill 文案和结构规则，
而真正的原因连一条线索都不留。已改为必填 `lastReason`，有违规才报违规。
配了一条专门的回归测试（断言 `errorMessage` 里有 `DEEPSEEK_API_KEY`、
且**不含**「未通过确定性校验」）。

---
## Q-14 `type: "object"` 缺一行，真实 Provider 直接 400（M4 第一次真实调用）

- **时间**：2026-08-21，M4-A
- **现象**：接上真实 DeepSeek 的第一次运行，任务停在创建结构阶段：
  `HTTP 400 Invalid schema for function 'complete_assignment': schema must be a
  JSON Schema of 'type: "object"', got 'type: null'.`
- **根因**：`complete_assignment` 是 6 个工具里唯一的判别联合，
  `tool-schema.ts` 把它投影成了没有根 `type` 的 `{ anyOf: [...] }`。
- **值得记下来的不是这个修法（补一行 `type: 'object'`），而是它为什么能活到 M4**：
  M3 的 508 条测试全绿，而 `FakeProvider` 不校验 schema。
  **「adapter 已实现」与「adapter 能跑通」之间隔着一次真实调用。**
  文档 §12.2 把 M4 排在 UI 之前的理由（「观察它不需要 UI」）在这里第一次兑现了——
  如果按常规顺序等 UI 建完再接真实模型，这个 400 会在界面全部做完之后才出现。
- **回归**：断言写成「遍历全部工具，根 `type` 都必须是 `object`」，
  而不是只钉 `complete_assignment`——这条约束属于工具集合，不属于某一个工具。
- **另一处只有真实链路才看得见的收获**：拿真实 key 跑完一整个任务后，
  对整个数据库做了一次全表全列扫描，`DEEPSEEK_API_KEY` 的值、`Authorization`、
  环境变量名、`reasoning_content` 四项**命中 0**。REQ §13 的脱敏至此不再是纸面承诺。

---
## Q-15 `assignment_started` 有两个写入点（M4 读第一份真实 trace 时发现）

- **时间**：2026-08-21，M4-A
- **现象**：一次任务 7 个 assignment，trace 里却有 14 条 `assignment_started`。
- **根因**：`assignment-service`（创建事务内，§5.5）与 `assignment-runner`
  （模型调用前，§8.5）各写一条。**两处各自的注释都是对的**——
  runner 那句「一次 `run()` 只写一条」字面上没错，错的是它默认了自己是唯一写入点。
- **裁定（已写入 §8.5）**：删掉创建事务里那一条。除了「同刻两条事件读起来像系统重复了」
  之外，真正的理由是：别名解析失败（D-03 晚绑定）时 Runtime 走不到写 trace 那一步，
  此时时间线上**应该**只有「已创建」而没有「已开始」；创建事务里那一条会把
  这类失败也标成「开始工作」，而这恰恰是晚绑定最需要在 trace 上看清楚的一类失败。
- **留给 M6 的提醒**：时间线 UI 若按 kind 计数做任何统计（如「本次跑了几轮」），
  依据是 `assignment_created`/`assignment_started` 与 execution 一一对应——
  这条不变量现在有测试守着（`m3-engine-loop` 主路径用例）。

---
## Q-16 M4 的两处文档与实现不符（都已按「先改文档」处理）

1. §12.2 写 `--provider deepseek`，CLI 实现的是 `--provider real`。
   **保留了代码的写法**：这个开关选的是「真实链路还是 `FakeProvider`」，
   不是选厂商——选厂商要改 `config/providers.yaml` 的别名映射（D-03 晚绑定），
   命令行拼不出那个语义。写成 `deepseek` 会暗示这里能换厂商。
2. §12.2 写「六个 `SKILL.md`」，而唯一的 P0 模板只声明 4 个 Skill。
   数字是早期草稿的残留，已改为「各 `SKILL.md`」——
   写死一个数只会让人去凑两个没有槽位类型需要它们的文件。

---
## Q-17 D-17 的 L3 缓解手段是个空操作（M4 查模型目录时发现）

- **时间**：2026-08-21，M4-A
- **背景**：D-17 给了 L1→L4 四级缓解方案，其中 L3 是
  「`createStructure` 绑定切到 DeepSeek 的更强模型（如推理型号）」。
- **实测**：DeepSeek 现在的 `/v1/models` 只有 `deepseek-v4-flash`、`deepseek-v4-pro`、
  `deepseek-v4-flash-vision-exp`。旧名 `deepseek-chat` 和 `deepseek-reasoner` 都还能调，
  但**两者都解析到同一个 `deepseek-v4-flash`**（请求 `deepseek-reasoner`，
  响应里的 `model` 回的是 `deepseek-v4-flash`）。
- **为什么值得单独记一条**：按字面执行 L3 会换来同一个模型，通过率一点不变，
  而且**不会有任何报错**。一个看起来生效、实际什么都没做的缓解手段比没有更糟——
  它会让人误判「L3 试过了，该上 L4 了」，而 L4 是文档明确说「设计上的让步」的那一级。
- **已处理**：D-17 的 L3 目标模型改为 `deepseek-v4-pro`，并加进 `providers.yaml`
  的 `models` 列表（别名解析在加载期校验模型是否在列表里，不加就配不出来）。
- **留给业务方的问题**：`deepseek-v4-pro` 的价格与延迟没有实测过。
  如果真的要动用 L3，得先确认「结构步骤变慢变贵」这个代价能接受到什么程度。

---
## Q-18 `executions.input_tokens` / `output_tokens` 永远是 NULL（M4 实测数据发现）

- **时间**：2026-08-21，M4-D。20 次实测跑完后统计 token 用量，
  `SELECT COUNT(*) FROM executions WHERE input_tokens IS NOT NULL` → **0 / 121**。
- **这条链路是完整建好的**，一处不缺：
  `openai-compatible.ts` 从流的最后一个 chunk 解析 `usage` →
  `AssignmentRunner` 把它放进 `result.usage` 一路返回 →
  `CompleteAssignmentInput.usage` 有这个字段 →
  `ExecutionRepo.markSucceeded(id, usage)` 接受它 →
  `task-service.ts` 把它投影进 API DTO。
- **但它永远不可能被填上**。原因是时序：提交发生在**工具调用内部**，
  即这一轮 turn 还没结束的时候，而 `usage` 是 Provider 在**流的最后**才给的。
  `markSucceeded` 在那个时刻拿不到它，于是恒为 `undefined`。
  Runner 确实把 usage 带回给了 ProductionEngine，但那时 execution 行
  已经是 `succeeded` 终态，没有人再写回去。
- **为什么这比「没做」更糟**：API 会把这个字段当成真数据发出去，
  前端拿到的是一个永远为 null 的合法字段——看起来像「这次没统计到」，
  而不是「这个功能没接上」。D-17 的 L3 要权衡「变慢变贵」，
  没有 token 数据这个权衡根本做不出来。
- **本次不改的理由（刻意记下来）**：唯一干净的修法是在 Runner 返回之后
  由引擎补一条 UPDATE 写回 usage。那条路径紧挨着 D-10 的条件 UPDATE——
  全系统最不该在里程碑收尾时匆忙改动的一段 SQL。
  留给 M5：接 `/api/tasks/:id` 时一并处理，那时正好要正视这个 DTO 字段。
- **顺带**：`provider_health` 表同样没有仓储（M3 记过），
  两件事都落在 M5 的「API 与真实数据对齐」这一批里。

---
## Q-19 20 次实测的结论只对**一份**输入成立（M4-D 自评）

四项指标全部 100%（结构首次 20/20、槽位首次 100/100、端到端 20/20），
但这 20 次跑的是**同一份** `fixtures/chapter-packet.txt`。

一个 100% 说明的是「结构 Agent 稳定地处理**这一章**」，
不是「稳定地处理章节」。20 次同输入之间的差异只来自模型采样，
而结构提案真正的难度来自**输入的多样性**——人物更多、情节要求更密、
有「必须合成一场」和「必须跨场铺垫」这类互相拉扯的约束时，
S2 的「场景数由素材密度决定」到底是有效指导还是一句正好合身的话，
同输入重复 20 次是测不出来的。

因此另做了一份刻意更密的 `fixtures/chapter-packet-dense.txt`
（五个人物、五条情节要求、一条「四房反应必须在同一场里」、
一条「沉默要在前面几场就被注意到、结尾才兑现」），单独跑一小批，
**两批数字分开报，不合并**——合并会用 20 个容易样本把少数难样本稀释掉。

首个观察：密集包产出 **4 个场景**，而简单包 20 次全部是 3 个。
方向上说明 S2 起了作用，不是巧合合身。

---
## Q-20 `provider_health` 表在 P0 没有任何写入方（M5-C 明确决定）

- **现状**：§5.2 建了 `provider_health` 表，但 `ProviderRegistry` 把健康状态
  **只放在内存里**（`#health` / `#rateLimitHits`），全系统没有一处写这张表。
- **这是刻意的，不是遗漏**。持久化健康状态意味着它会跨重启存活，
  而重启之后那份状态多半是错的：Registry 启动时会按环境变量重新判一次
  「凭据配没配」，这个结论比「上次退出前那一刻的观测」准确得多。
  存一份旧的 `ok` 回来，只会让 Provider 设置页在密钥已经被删掉之后
  依然显示「正常」——而这个页面存在的全部理由就是防这件事。
- **为什么记下来而不是直接删表**：删它要写一条迁移，而 §5.2 是逐字对应的
  规范章节，改动面比收益大。留着但显式标注「P0 无写入方」，
  比留着一张看起来接好了的空表要诚实。
- **留给后续的问题**：如果 M7 之后要做「限流历史」这类跨重启的观测，
  这张表就是现成的落点，那时再决定写入方是 Registry 还是一个独立的观测服务。

---
## Q-21 application 层没有 logger，内部错误只能进 stderr（M5-C 发现）

- **触发点**：`runtime-ports.ts` 的 `reasonOf`。原实现里「是 Error 就用它的 message」
  会把 sqlite 的报错（带表名和 SQL）、Node 的 fs 报错（带绝对路径）
  直接写进 `tasks.error_message`——那一列**既出 API 也直接显示给用户**。
  这与 §9.3「原始错误只进日志」是同一条纪律，只是那条守的是 HTTP 边界，
  这条守的是数据库里那一列：写进去就晚了，之后每一次读都在泄露。
- **已修**：`reasonOf` 只信任 `ForgeError` 的 message，其余一律退回调用方给的
  成文中文（这同时也是 D-19 的要求：一句英文的 `no such table` 不是可展示的中文）。
- **未解决的部分**：原始错误现在打到 `console.error`（前缀
  `[internal-error]`），而不是 pino。原因是 application 层根本没有注入 logger——
  `buildApp` 的签名里没有它，engine / lifecycle / 各 service 都拿不到。
- **留给 M7 的问题**：要不要把 logger 作为一个端口注入 `buildApp`？
  倾向是要——M7 的完成判据里有「脱敏审计：grep 全部日志」，
  而 `console.error` 出来的东西没有结构、没有 taskId、也不过 pino 的 redact 配置。
  代价是又多一个所有服务都要接的横切依赖。
- **【M7 已实现】**：采用最小横切方案——`runtime-ports.ts` 增加可注入的
  `setInternalErrorSink`（默认仍是 `console.error`，测试行为不变），`main.ts` 在
  `buildServer` 后用 Fastify 的 pino `app.log`（带 redact）注册该 sink。
  内部错误因此有结构、过脱敏配置，且不改动 `reasonOf` 的调用签名。

---
## Q-22 SSE 的 `state` 事件由 Hub 自己观测，而不是各处显式推送（M5-D 定案）

- **做法**：`SseHub` 不提供 `publishState`。它在每条 trace 推送之后读一次
  权威状态（`TaskService.getStreamState`），与上次推过的三元组比对，**变了才推**。
- **为什么不在 lifecycle / engine 的每个状态迁移处补一行 `publishState`**：
  那要改十几个调用点，而漏掉任何一个的表现是「界面卡在旧状态，刷新一下才对」——
  最难被测试抓住、也最容易被当成偶发的一类 bug。
  观测式的做法数据源就是数据库，不可能与真实状态漂移。
- **代价**：state 事件的时机挂在 trace 上。若将来出现一种「改了状态但不写 trace」
  的路径，前端就收不到失效通知。目前不存在这种路径（§5.5 的八条事务边界
  每一条都写 trace），但这是一条**需要维持的隐含约定**，写在这里以免它被无声打破。

---
## Q-23 SIGTERM 时不 drain 引擎、不 flush trace 缓冲（M5 审查发现，留给 M7）

- **现状**：`main.ts` 的 shutdown 是 `app.close()` → `db.close()` → `process.exit(0)`。
  若此时有任务在跑，`tick` 的下一次仓储调用会撞上已关闭的连接；
  `settleEscapedError` 内部的事务同样会失败（被它自己的兜底 catch 吞掉），
  任务留在 `running`，靠下次启动的 `recoverOnStartup` 收拾——**功能上能自愈**。
- **真正会丢东西的是 trace 缓冲**：`traces.flushAll()` 从没被调用。
  §7.7 规定 delta 不落库、断线重连靠 `public_output_chunk` 补读，
  于是缓冲区里那段还没攒够 1024 字符的正文会随进程一起消失，
  而它是那段正文**唯一**的持久化副本。
- **为什么不在 M5 修**：正确的收尾顺序（停止接受新任务 → 等当前 tick 收敛
  或超时 → flushAll → 关库）需要给 `engine.drain()` 加一个有上限的等待，
  而那要动引擎的队列语义——M5 已经动过一次 `enqueue` 的去重判据了，
  同一个里程碑里第二次改它不划算。
- **留给 M7**：shutdown 里补 `forge.traces.flushAll()`，并给 drain 一个超时上界。
  M7 的完成判据本来就有「重启恢复」的 E2E，这条正好一起验。
- **【M7 已实现】**：`main.ts` 收尾顺序改为 `app.close()`（停 HTTP/SSE）→
  有界等待 `engine.drain()`（`DRAIN_TIMEOUT_MS`，超时不阻塞）→ `traces.flushAll()` → 关库。
  重启恢复的 E2E 见 `tests/integration/m7-e2e-flows.test.ts`。

---
## Q-24 服务端不 serve 前端产物，`@fastify/static` 是死依赖（M6/M7 复查发现）

- **现状**：`package.json` 里有 `@fastify/static`，但全仓库没有任何一处 import 它。
  `npm run build` 产出 `dist/client`，而 `buildServer` 只注册 `/api/*`——
  实测 `GET /` 返回 404。也就是说**目前只有 `vite dev` 的代理这一条路能打开界面**，
  没有任何方式把构建产物跑起来。
- **为什么它没被任何测试抓到**：所有前端验证都走 vite dev（5273 代理到 3311），
  而所有后端测试只打 `/api/*`。两边都是绿的，中间那段没人走。
- **两个方向，需要业务方定**：
  1. 单端口部署：`buildServer` 注册 `@fastify/static` 指向 `dist/client`，
     并加一条 SPA fallback（非 `/api` 前缀的 404 回 `index.html`，
     否则刷新 `/tasks/xxx` 会 404）。依赖就用上了。
  2. 前端另行托管（nginx / 静态托管），后端只管 API：那就把 `@fastify/static` 删掉。
- **不要就这么留着**：一个声明了却不用的依赖，下一个人会假设「静态托管已经有了」。

### 【已定案】业务方选**方向 2：前后端分离**

- **业务方理由**：后续要加的功能（CLI 操作方式、审核打回机制）会同时长在两侧，
  边界清晰比省一个进程更值钱。
- **已落实**（文档先行，§2.2 + 新增 §10.6）：
  1. `@fastify/static` 已从 `package.json` 卸载。去掉之后 `tsc` / `eslint` /
     691 条测试全绿、行为零差异——这正是它确实是死依赖的证明。
  2. 新增 `npm run preview`（5274，`vite preview` serve `dist/client` 并代理 `/api`），
     让「构建产物能不能跑」这条路径**第一次有人走**。已实测走通完整生产流水线。
  3. 后端的约束固化为一句：**永远只有 `/api/*`**，且**由代码强制**——
     `buildServer` 在注册任何路由之前挂 `onRoute` 钩子，注册非 `/api` 路由
     构造期直接抛。必须强制而不能只写文档，是因为违规**没有任何报错**：
     tsc / eslint / 测试全绿，线上表现为「路由写了没生效」（静态托管
     已经把非 `/api` 路径 fallback 到 index.html 了）。
     守卫按「改坏了会失败」反证过，见 `tests/integration/q24-api-only-boundary.test.ts`。
- **明确不做的两件事，以及为什么**：
  - **不引入 CORS**。分离的是部署件不是源——静态托管同时反代 `/api`，
    浏览器看到的始终是一个源。
  - **不引入 `VITE_API_BASE_URL`**。那会是一个默认值等于当前行为、
    且没有任何部署在用的配置项，即 DEVLOG 经验 6 说的那种「看起来生效、
    实际什么都没做」。真做跨源部署时再加，且**必须与 CORS 同时加**——
    两件事是一件事，分开做必然漏一半。
- **留给运维的唯一硬要求**：nginx 的 `/api/` location 必须 `proxy_buffering off`
  且 `proxy_read_timeout` 给足（§10.6 有完整配置）。默认缓冲会让 SSE 事件攒着不发，
  现象是「工作台卡住不动、最后突然全部涌出」，而后端日志一切正常。
- **这条硬要求本地验不到，且不要假装能验**：`preview.proxy` 里曾加过一段
  给 SSE 打 `x-accel-buffering: no` 的钩子，看着像是把缓冲问题一并覆盖了。
  按「去掉它，看有没有区别」反证——带与不带完全一致（34 trace / 39 delta /
  6 次明显间隔），因为 vite 的代理本来就是 pipe，而那个头是写给 nginx 的、
  vite 与浏览器都不认。钩子已删，理由写在 `vite.config.ts` 的注释里。
  **`npm run preview` 绿了不代表生产不会缓冲**，这一条只能在真实 nginx 前面验。

---
## Q-25 已完成槽位看不到「技术详情」（UX §13.5 覆盖缺口，M6/M7 复查发现）

- **现状**：`RightPanel` 的技术详情块由 `techExec` 控制，而 content 分支的
  `subject.execution` 只在**运行中**才有值（`determinePanelSubject` 只找
  `status === 'running'` 的 execution）。槽位一旦完成，execution 变成 null，
  §13.5 要求的 contextHash / promptHash / tokens / 起止时间整块消失。
- **讽刺的是它本来拿得到**：`slot.producer.executionId` 就在手里，
  而 `GET /executions` 返回的数组里包含那一条。判据函数改两行就能补上。
- **为什么没顺手改**：§13.5 同时还要求「复制 Trace / 导出 JSON / 导出 Markdown」
  三个动作，这三个也没实现。这更像是 P0 对 §13.5 做了整体裁剪，
  而不是漏了一条——**该裁到哪儿是业务方的决定，不是我的**。
- **需要定的**：§13.5 在 P0 到底做多少。若决定「查得到就该显示」，
  那就补 producer 那条 execution；若决定整块延后，就在文档里把 §13.5 标成 P1，
  免得下一个人以为这是 bug 又改一遍。

---
## Q-26 分片 schema 不匹配时静默丢数据，没有任何信号（接入 OpenCode Go 时暴露）

- **现状**：`openai-compatible.ts` 的读流循环里是
  `const chunk = parseChunk(payload); if (chunk === null) continue;`。
  Zod 校验不过 → 整个分片被丢弃 → **不记日志、不计数、不进 trace**。
- **它造成过什么**：`StreamToolCallDeltaSchema` 的 `name` 写的是 `.optional()`，
  只接住「字段缺省」（DeepSeek 官方的形状），接不住「显式 `null`」（OpenCode Go 的形状）。
  于是每个续传分片连同它携带的 `arguments` 碎片被整片丢掉，拼出来是空串。
  **上层看到的完全是另一回事**：「模型烧掉 24 次工具调用也不提交」，
  很像 D-17 早就写明的「结构生成 tool call 可靠性」风险——差一点就被归因成模型能力问题。
  真正的诊断线索是那个分布：40 次 `read_skill_section` 全部
  「参数不合法」，而唯一成功的是 `read_task_input`——**唯一不需要参数的工具**。
- **schema 那一处已修**（改成 `.nullish()`，带反证测试）。**但机制没修**：
  下一个 Provider 的下一个形状差异，还会以同样的方式静默丢数据。
- **要定的**：给「分片被丢弃」一个信号。几个方向，代价递增：
  1. 累计一个计数，turn 结束时若 > 0 就写一条 trace（`kind` 需新增，会动契约）；
  2. 走 `setInternalErrorSink`（Q-21 已建好的通道），打到 stderr 即可，不动契约；
  3. 直接抛 `PROVIDER_ERROR`——最响，但一个无关紧要的字段变化就会打断生产，
     考虑到「模型输出是不可信输入」这条前提，多半过激。
- **倾向 2**，但没做，因为它需要把 sink 注入到 adapter（目前 adapter 不持有 logger），
  而那会改 `ProviderAdapter` 的构造契约——值得单独一次改动，不该混在 bug 修复里。

### 【已处置】选方向 2：走 Q-21 的内部错误通道（2026-08-25）

改动比预想的小：加的是 `OpenAiCompatibleOptions.onDroppedChunk`（**适配器自己的**
构造选项），不是 `ProviderAdapter` 接口。当时高估了侵入性——
`ProviderAdapter` 只约束 `runTurn` / `probe`，构造参数各适配器自定。
缺省实现走新增的 `reportInternal()`（`runtime-ports.ts`，与 `reasonOf` 同一条通道）。

**三条设计约束，每条都有测试守着**：

1. **只报形状，不报内容。** 上报里只有字段路径与 Zod 的 issue `code`。
   特别地**不用 `issue.message`**——某些 code（如 `invalid_enum_value`）
   会把收到的**值**拼进 message，那等于把分片内容打进日志。
   分片里可能有 `reasoning_content` 与正文（REQ §13）。
   判据写成了一条断言：把隐藏推理放进分片，上报内容里不得出现它。
2. **按形状归并，一轮结束报一次。** schema 对不上时坏的往往是每一个分片，
   逐条报会刷几百行 → 没人看 → 等于没报。
3. **不抛异常。** 无关紧要的字段变化不该打断生产。
   目标是留痕，不是把它变成故障。

**还有一条负向判据**：一切正常时一个字都不报，否则噪音会淹掉信号。
已实测——真实链路跑完整章 5/5，日志零条丢弃记录。

**反证**：把计数与上报去掉、退回 `if (chunk === null) continue`，
5 条里红 3 条（另 2 条是「正常时不报」与「不含正文」，本就该保持绿）。

**这条到此关闭。** 它的价值不在这次——schema 那处已经修好了——
而在下一次：换 Provider 时如果响应形状又有出入，
现在会看到一行明确指向字段的日志，而不是再花一轮生产去反推分布。

---
## Q-27 OpenCode Go 上「首次尝试几乎必超时、重试才成功」

- **实测**（首次真实生产跑通，11 条 execution：`succeeded 6 / failed 5`）：

  | 步骤 | 第 1 次 | 第 2 次 |
  |---|---|---|
  | create_structure | 90s 超时 ❌ | 72s ✅ |
  | chapter_outline | 120s 超时 ❌ | 40s ✅ |
  | scene_1 | 180s 超时 ❌ | 63s ✅ |
  | scene_2 | 180s 超时 ❌ | 41s ✅ |
  | scene_3 | 91s 未提交 ❌ | 92s ✅ |
  | title | 53s ✅ | — |

- **后果**：任务能跑完（重试兜住了），但**配额与时间都花了约两倍**。
  对一个按用量计费的订阅套餐来说，这是实打实的浪费。
- **不要急着归因**：「第二次总是更快」看起来像网关冷启动或路由预热，
  但**没有证据**——只跑了一轮，样本 n=1，也没有对照。
  真要下结论得像 M4 那样用 `measure-runs.ts` 连跑一批，两个 Provider 分开报。
- **可选处置**：
  1. 调高 `template.yaml` 的 `limits.timeoutMs`（现在这套是对着 DeepSeek 官方调的，
     那边探针 200ms，OpenCode Go 探针 4.3s）；
  2. 让 `timeoutMs` 能按 provider 覆盖（D-06 的回退链目前到不了 provider 这一层）；
  3. 什么都不做，接受两倍开销。
- **需要业务方定**：这直接花的是套餐额度。在跑量之前先定，比跑完再心疼便宜。

### 【已处置】选方向 1：按实测重定模板超时（2026-08-25）

**先推翻了我自己的第一个判断。** 原以为是「首次慢、重试快」的网关预热，
挖 trace 后不成立——首轮延迟分布是 `16s / 3s / 159s / 135s / 3s`（失败）
对 `3s / 25s / 21s / 3s / 41s / 92s`（成功），**没有首次与重试的规律，
只有极大的方差**。另外单独采了 5 次小请求，TTFT 稳定在 1.2–2.0s，
说明慢的不是「等着开始」，而是**生成本身**——是吞吐问题不是延迟问题。

**实测吞吐**（从成功执行反算，n=1 章）：

| 槽位 | 字数 | 耗时 | 字/秒 |
|---|---|---|---|
| chapter_outline | 674 | 40s | 16.7 |
| title | 5 | 53s | 0.1 |
| scene_1 | 992 | 63s | 15.8 |
| scene_2 | 1298 | 41s | 32.0 |
| scene_3 | 1204 | 92s | 13.1 |

合计 4173 字 / 288s → **平均 14.5 字/秒**。

**两条从数据里读出来、光看代码看不出来的事**：

1. **`title` 产出 5 个字却花了 53s。** 耗时由**工具调用往返次数**主导，
   不是生成量。所以「这个槽输出短」**不是**给它短预算的理由——
   原来的 `createStructure: 90000` 注释写的正是「结构输出短但格式严格」，
   这个推理方向本身就是错的。
2. **超时的两次，首轮各吃掉 135s / 159s**，而同样的槽成功时只要 41–92s。
   同一个 Provider 上约 2.5 倍的慢跑是常态，预算给到典型值的 2 倍并不够。

**改动**（`templates/zhihu-chapter/template.yaml`）：

| | 原 | 新 | 依据 |
|---|---|---|---|
| `createStructure.timeoutMs` | 90s | **240s** | 典型 72s，原预算只剩 25% 余量 |
| `limits.executionTimeoutMs` | 120s | **240s** | outline 40s / title 53s，覆盖 2.5 倍慢跑 |
| `scene.timeoutMs` | 180s | **420s** | 典型 41–92s，慢跑首轮 159s |

**明确没有解决的**：按 14.5 字/秒，一个写满 `maxChars: 8000` 的场景需要约 553s，
420s 仍会超时。没有继续往上加，因为超时是「任务永久 running」的最后一道网，
加得越大失败发现得越慢。真遇到再抬，或者把 `maxChars` 调小。

**这个改动在架构上是将就的，值得单独记一笔**：慢是 **Provider 的属性**，
却被写进了**模板**。切回 DeepSeek 官方后，这套预算会变得过于宽松，
真卡住时要等 4 分钟才发现。架构上正确的做法是让 `timeoutMs` 能按 provider 覆盖，
但 D-06 的回退链（binding → agent → limits → providers.defaults）到不了 provider 这一层，
而且 provider 是 D-03 晚绑定的、超时来自冻结快照——
两者混合会让「有效超时」不再由快照单独决定，这是个真的语义变更，不该顺手做。
更精确的另一条路是把「首字/静默超时」与「总预算」拆成两个闸，
那样能区分「Provider 卡住」与「Agent 干太多」——目前一个预算把两件事混在一起。

### 【当天推翻】业务方决定切回 DeepSeek 官方，超时随之改回

抬高超时确实起了作用（浪费的执行从 5 次降到 2 次），**但没解决慢**：

| | 调整前 | 调整后 |
|---|---|---|
| 执行成败 | succeeded 6 / failed 5 | succeeded 6 / failed 2 |
| 单章墙钟 | — | 1370s ≈ 23 分钟 |

而且剩下那两次失败很说明问题：`create_structure` 跑满 240s 超时后
第二次 174s 成功；`scene_3` 跑满 420s 超时后第二次 155s 成功——
**同一段内容两次耗时差 2–3 倍**。继续抬超时只是在给方差让路，
而超时是「任务永久 running」的最后一道网，抬得越高真卡住时越晚发现。

**三方对照（同模板、同输入、同模型 deepseek-v4-flash）**：

| | 单章耗时 | 依据 |
|---|---|---|
| DeepSeek 官方 | **85.6s**（M4 连跑 20 章，最长 110s） | `M4-TUNING-REPORT.md` |
| DeepSeek 官方 | **91s**（本次切回后实测） | 与 M4 基线吻合 |
| OpenCode Go | **1370s** | 本次实测 |

约 **15–16 倍**差距。业务方判断这对开发测试节奏影响过大，切回官方。

**因此 `template.yaml` 的三处超时也一并改回 90s / 120s / 180s**——
那套抬高的预算**只在跑 Go 时才成立**，留着会让官方链路上真正的卡死晚 4 分钟才被发现。
两件事必须同时改，这也正说明「把 Provider 的属性写进模板」是将就：
它让 Provider 与模板产生了本不该有的耦合，切换时要记得改两个文件。

**切回后实测**：91s 墙钟、succeeded 6 / failed 1、产物 9317 字节。
单步耗时 7–25s（对比 Go 的 22–420s）。

**Q-27 到此关闭。** 保留 `opencode-go` 的 provider 条目——
它适合「能等的批量后台跑」，也保留了当时评估过、没有实施的混合形态：
结构走官方（一失败整章重来）、正文走 Go（量大、能等）。
真要做混合，别名机制天然支持，模板一个字不用改。

---
