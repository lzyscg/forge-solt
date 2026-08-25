# Forge Core vNext — 交接文档

> 写给**下一个没有任何上下文的开发者或 Agent**。
> 读完这一份 + `notes/OPEN-QUESTIONS.md`，应该能直接开始 M6。
>
> 最后更新：M5（API 与 SSE）完成并通过一轮独立审查之后。
> 状态：`npx tsc --noEmit` 干净 · `npx eslint .` 干净 · **706 测试全绿（44 个文件）**。

---

## 0. 这是什么

一个**结构槽原生的 Agent 内容生产平台**。核心公式三行：

```
Structure        = StructureAgent(StructureSkill, TaskInput)
SlotContent[i]   = ContentAgent(SlotSkill[i], DeterministicContext[i], Slot[i])
Artifact         = Assemble(Structure, SlotContents)
```

人话：**章节的结构由 Agent 设计，不由模板写死**（D-01）；结构定下来之后，
每个槽位由另一个 Agent 独立填充，上下文由系统确定性地拼给它；最后系统把槽位装配成产物。
「完成」永远由系统判定，不接受模型说「我写完了」（AC-014）。

技术栈：TypeScript 模块化单体 · Node 22 + Fastify 5 · better-sqlite3 · React 18 + Vite 6 ·
Zod 3 · Vitest 2 · SSE · pino。单机单用户，P0 并发固定 1。

---

## 1. 五分钟跑起来

```bash
npm install
cp .env.example .env        # 然后把 DEEPSEEK_API_KEY 填进去
npm run typecheck && npm run lint && npm test     # 应当 706 全绿
```

> ⚠️ **这里原本有一条「删掉 `data/forge-core.sqlite`」的指引，已删除。**
> 当时那个库是 8-20 留下的空库，迁移哈希对不上、起不来，删掉是对的。
> 但那个库后来已重建，**现在装着真实生产数据**（实测启动正常、`migrations: 2`）。
> 照着旧指引执行 = 删掉真实任务，而 `data/` 全部 gitignore，**没有备份**。
> 若将来真的再遇到「已应用的迁移不可编辑」，先 `npx tsx src/server/cli/dump-trace.ts --latest`
> 确认库里有没有数据，再决定删不删。

`data/` 下的库**没有任何备份**（全部 gitignore）。其中：
`m4-measure.sqlite` / `m4-dense.sqlite` 是 M4 实测数据（`notes/M4-TUNING-REPORT.md`
的全部数字出自它们），`m7-accept*.sqlite` 是 M7 验收数据——**都别删**。

然后：

```bash
npm run dev            # server(3311) + vite client 一起起
npm run dev:server     # 只起后端
npx tsx src/server/cli/run-task.ts --help      # headless 跑一个任务（无 UI 无网络亦可）
npx tsx src/server/cli/dump-trace.ts --latest  # 打印最近一个任务的轨迹时间线
npx tsx src/server/cli/measure-runs.ts --help  # M4 的量化闸门
```

**环境变量**：`cp .env.example .env` 填好即可，**不需要手工 source**。
`dev:server` / `dev:fake` / `migrate` 三个脚本都带 `--env-file-if-exists=.env`，
Node 22 自己加载。解析与校验在 `src/server/config/env.ts`（§2.6），
是全系统唯一读 `process.env` 做配置的地方——加新配置项改这一个文件，别再各处 `?? 默认值`。

启动第一屏会打出本次实际用的端口/库/目录，以及缺失的 Provider 变量名。
**看一眼横幅**比事后查「为什么任务跑不动」便宜得多。

（历史坑，已消失：以前 `npm run dev:server` 不加载 `.env`，服务照常起来、
`/api/health` 还是绿的，任务一跑才失败，而原因只在 Provider 设置页看得到。）

### 1.4 部署形态：前后端分离（Q-24 已定案）

权威描述在方案 §10.6，这里只记你每天要用到的部分。

```
静态托管（生产是 nginx，本地是 vite preview）      Fastify :3311
  └── dist/client/  ← npm run build 产出            └── /api/*  仅此一项
```

```bash
npm run build      # → dist/client
npm run preview    # 5274，serve 构建产物并代理 /api → 3311
```

**三条不能忘的**：

1. **后端永远只有 `/api/*`。** `GET :3311/` 是 404，这是对的，不是 bug。
   **这条由代码强制**：`buildServer` 里有个 `onRoute` 钩子，注册非 `/api`
   路由会在构造期直接抛（守卫与它的反证见 `tests/integration/q24-api-only-boundary.test.ts`）。
   你要加 CLI / 审核打回的端点时，一律挂在 `/api/` 下面——
   真想改变这个决定，先改方案 §10.6 再动代码。
2. **不需要 CORS，也不要加。** 分离的是部署件不是源——静态托管同时反代 `/api`，
   浏览器看到的始终是一个源。前端用相对路径 `/api/...`，
   也**不要**加 `VITE_API_BASE_URL`：那会是个没有任何部署在用的配置项。
   真做跨源时再加，且必须与 CORS 同时加。
3. **nginx 的 `/api/` 必须 `proxy_buffering off`**（完整配置在 §10.6）。
   默认缓冲会把 SSE 事件攒着不发，现象是「工作台卡住不动、最后突然全部涌出」，
   而后端日志一切正常——最难查的那类。SPA fallback（`try_files $uri /index.html`）
   同样不可省，否则刷新 `/tasks/<id>` 直接 404。

分离方案落地时实测过（经 5274 代理、全程不碰 3311）：深链接硬加载 200、
`GET :3311/` 与 `:3311/tasks/<id>` 双双 404、SSE 34 条 trace + 39 条 delta + 11 条 state
在 12.3 秒内**陆续**到达、任务 3/3 槽位完成并组装出产物。

**但第 3 条（缓冲）本地验不到**：vite 的代理本来就是 pipe，
`npm run preview` 绿了**不代表**生产的 nginx 不会缓冲。那条只能在真实 nginx 前面验。

---

## 2. 现在到哪了

| 里程碑 | 状态 | 产出 |
|---|---|---|
| M0 契约与骨架 | ✅ | `shared/` 全部 schema、迁移、Fastify 骨架 |
| M1 Domain 纯函数 | ✅ | 结构校验 19 条、readiness、assembly、状态机、presentation（分支覆盖强制 100%） |
| M2 持久化与事务 | ✅ | 6 个仓储、UoW、§5.5 八条事务边界、模板/Skill 加载器、快照冻结 |
| M3 生产引擎闭环 | ✅ | Runtime（Provider/工具/Agent 循环）、Application 服务层、引擎、CLI |
| M4 真实 Provider 与调优 | ✅ | DeepSeek 打通；结构提案首次通过率 **20/20 = 100%**（目标 ≥80%） |
| M5 API 与 SSE | ✅ | §9.1 全部 22 个端点 + SSE Hub + 错误映射 |
| M6 前端 | ✅ | 六个页面 + 工作台三栏 + `SafeMarkdown`，共 24 个文件 |
| **M7 加固与验收** | ✅ | 脱敏审计（全表全列）、E2E 三流程、32 槽位规模、连续 10 章 |

**当前基线：706 测试 / 44 文件，`tsc` 与 `eslint` 干净。**
M6/M7 之后做过一轮独立复查，找到并修了两个 bug（工作台状态跨任务泄漏、
时间线「有 N 条新事件」的 N 是编的），详见 `DEVLOG.md` 的 M6–M7 一节。

### M5 的实测结论（不是测试，是真跑）

真服务 + 真 DeepSeek 跑通一整章，经 HTTP 创建 + SSE 观察 + 下载产物：

- 5/5 槽位、产物 13,648 字节
- 154 条 trace（id 严格单调递增）、2566 条 delta、14 条 state、6 次心跳
- `assignment_created / started / submitted / completed` = **6/6/6/6**，与 6 条 execution 对齐
- **全库扫描 API Key 与 `reasoning_content`：0 命中**（trace_events / executions / tasks / slots / artifacts / task_snapshots 六张表逐列扫）

### 还没有的东西

- ~~**一个 git commit 都没有。**~~ 已提交：`622e62b` 是 M0–M7 完成态的一次性快照，
  未拆分里程碑历史（拆一个已完成的快照只会编造出七个当时并不可运行的状态）。
- ~~**没有任何方式跑构建产物。**~~ **Q-24 已定案：前后端分离**（§10.6）。
  `@fastify/static` 已卸载，后端**永远只有 `/api/*`**；`dist/client` 由静态托管发出，
  本地用 `npm run preview`（5274）验证构建产物。详见 §1.4 部署形态。
- `provider_health` 表没有写入方（刻意，见 Q-20）；`executions.*_tokens` 恒为 NULL（Q-18）。
- UX §13.5 只做了一半：技术详情块有，但「复制 Trace / 导出 JSON / 导出 Markdown」
  没有，且已完成的槽位看不到技术详情——见 Q-25，同样需要你划范围。
- 前端测试只覆盖了三处（PanelSubject 五分支、时间线计数、路由换任务）。
  `useWorkbench` 的 SSE 合并、断线、首连播种**没有测试**——那是最容易错的一块。

---

## 3. 不可协商的规矩

这五条如果丢了，后面的代码会慢慢烂掉，而且烂得没有报错。

### 3.1 实现与文档冲突 → **先改文档，再改代码**

权威文档是 `Forge-Core-vNext-可执行技术实现方案-V1.0.md`。
文档里带「M3-B 修订 / M4 补正 / M5-C 明确 / M5-D 定案 / M5 审查补正」字样的段落，
**是有意做的修改，不是文档过期**。发现冲突时不要直接改代码，
先在文档相应位置写清楚「原文是什么 / 为什么改 / 不改的代价」，再动代码。

这条已经执行了十几次，是这个项目里最值钱的习惯——它让每个偏离都有据可查。

### 3.2 分层由 ESLint 强制，不靠自觉

```
shared ← domain（纯函数，零 IO）← application ← runtime / infrastructure ← api
client 只能碰 @shared
```

`domain/` 不许读时钟、不许碰数据库。`api/` 不许持有仓储——它只调 service。

### 3.3 事务回调里**绝对不能有 await**

选 better-sqlite3 的**全部理由**就是它同步（D-15）。D-10 把 Execution Token 的校验
压进 UPDATE 的 WHERE 子句，用受影响行数判成败；这套机制成立的前提是
「读-判-写」之间没有调度点。回调一旦是 async，事务会先于回调完成而提交，
stop 就能插进来，原子性保证全失效。

这条已经写进类型（`NotPromise<T>`），`run(async ...)` 编译不过。别绕过它。

### 3.4 每条断言都要**反证过**

写完测试之后，**把产品代码改坏，确认它真的变红**。这个项目靠这条抓到了至少 5 个假绿：

- `Content-Length` 那条断言其实在测 Fastify，我写的 header 是死代码 → 删掉
- 「绝对路径不出网」那条**恒为真**——唯一的坏模板样本失败在编译期，报错里本来就没路径
- 「resume 的 Promise 等自己那一轮」第一版写法改坏了也不红，重写了一版才守住
- `:memory:` 被解析成真实文件，**每个测试都在共享同一个 18MB 磁盘库**，没有任何测试变红，
  是靠 `git status` 里多出来一个文件发现的

判据不是「测试通过」，是「改坏了会失败」。

### 3.5 凭据与隐藏推理，一个字节都不许出网（REQ §13）

不许进：Template / Task Snapshot / Slot / Execution Log / Artifact / Trace / Prompt /
Tool Result / API Response / 数据库任何一列 / 日志。

已经架好的四道网，别拆：
1. `providers.yaml` 的 schema 是 `.strict()`，多写一个 `apiKey:` 字段会当场报错
2. `ResolvedModel.apiKey` 是**不可枚举**属性，`JSON.stringify` 带不出来
3. `TracePayloadSchema` 有**递归**键名黑名单，挂在 `TraceRepo.insert` 这个唯一写入口上；
   且 `insert` 返回的是 parse **之后**的对象，所以 SSE 推的和落库的是同一份脱敏结果
4. pino 的 `redact` 配置

**新增一条（M5）**：`task.error_message` 那一列既出 API 也直接显示给用户。
`runtime-ports.ts` 的 `reasonOf` 只信任 `ForgeError.message`（我们自己写的中文）；
裸 `Error` 的 message 可能带 sqlite 表名、SQL、绝对路径，一律退回成文的兜底句，
原始对象只打到 stderr（前缀 `[internal-error]`）。

---

## 4. 代码地图

```
src/shared/          contracts.ts（API DTO）· errors.ts（错误码全表 + HTTP 映射）
                     trace.ts（TraceKind + 脱敏黑名单）· presentation.ts · tools.ts
src/server/
  domain/            纯函数。structure-validation / readiness / assembly /
                     state-machine / presentation / canonical。零 IO，可 100% 确定性测试
  application/       编排层。composition.ts 是**唯一**知道「谁依赖谁」的文件
  runtime/           Provider 适配、工具实现、Agent 工具循环、Trace 缓冲
  infrastructure/    db / migrate / 6 个仓储 / uow / sse-hub
  api/               薄转发。routes/*.ts 只做「取参数 → 调 service → 返回」
  cli/               run-task / dump-trace / measure-runs
tests/
  fixtures/          db.ts（表和行）· app.ts（服务图）· engine.ts（整张真图 + FakeProvider）
                     · workspace.ts（可写模板目录）· api.ts（真 Fastify + inject）
  integration/       m0..m5 各里程碑的判据测试
```

### 几个容易找错地方的点

- **DTO 投影在 `application/task-service.ts` 与 `template-service.ts`，不在 `api/dto/`。**
  文档 §9.2 原本画在 api 层，M3-B 修订过，理由写在那两个文件头。
  「`derive*Presentation` 只有一个调用点」这条约束原样保留，只是地点变了。
- **`composition.ts` 是组合根。** CLI、集成测试、HTTP 服务共用**同一张图**。
  想加一个 service，改这一个文件。
- **SSE Hub 在 `infrastructure/`，但它实现的是 `application/trace-service.ts` 声明的端口。**
  trace-service 不认识 Hub，只知道「把事件送出去」这一个能力。
- **`ForgeApp.sse` 无条件创建**，CLI 也有一个（空 Map + unref 的定时器）。
  让它可选会立刻回到「谁先构造」的死结。

---

## 5. API 契约速查（M6 直接照着接）

全部 22 个端点都有 `inject()` 测试，形状由 `src/shared/contracts.ts` 的 Zod schema 定义——
**前端直接 `z.infer` 推导类型，不要手写 interface**。

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/health` | `{status, version, migrations}` |
| GET | `/api/templates` | `TemplateListResponse`（**含 `failures`**，坏模板要显式可见） |
| GET | `/api/templates/:id` | `TemplateDetail` |
| GET | `/api/templates/:id/tasks` | `TaskSummary[]` |
| POST | `/api/templates/:id/reload` | `TemplateDetail`（整目录重扫） |
| POST | `/api/tasks[?start=true]` | `TaskCommandResult` · **201 + Location** |
| GET | `/api/tasks?limit=` | `TaskSummary[]` |
| GET | `/api/tasks/:id` | `TaskDetail` |
| POST | `/api/tasks/:id/{start,stop,resume,retry}` | `TaskCommandResult`（**立刻返回，不等生产**） |
| GET | `/api/tasks/:id/slots` | `SlotView[]`（**不含正文**） |
| GET | `/api/tasks/:id/slots/:slotId` | `SlotDetail`（含 `content`） |
| GET | `/api/tasks/:id/executions` | `ExecutionView[]` |
| GET | `/api/tasks/:id/traces?after=&limit=` | `TraceListResponse` |
| GET | `/api/tasks/:id/stream?after=` | SSE |
| GET | `/api/tasks/:id/artifact` | `ArtifactView`（含正文） |
| GET | `/api/tasks/:id/artifact/download` | `text/markdown` + Content-Disposition |
| GET | `/api/providers` | `ProviderListResponse` |
| POST | `/api/providers/:id/probe` | `ProviderHealth` |
| GET | `/api/providers/defaults` | `ExecutionDefaults` |

**错误响应统一是 `PublicError`**：`{code, message, location, action}`。
`action` 是 UX §18.8 要的操作提示，**为 null 是有意义的取值**——表示没有可执行的下一步，
此时不要显示按钮。404 也是这个形状（前端不必为路由不存在单写一套解析）。

**查询参数解析不出来一律 400**，不静默兜底。`?after=abc` 若悄悄变成 0 就是一次全量重放。

### SSE 协议（§9.4）

```
event: trace     id: 143    data: {...TraceEvent}     ← 带 id，可补发
event: delta                data: {executionId,text}  ← 不带 id，断线就丢
event: state                data: {taskStatus,phase,activeSlotId}
: heartbeat                                           ← 每 15 秒
```

四条前端必须知道的事：

1. **`state` 只是失效通知**，不是状态快照。收到就 `invalidateQueries(['task', id])`
   重新拉 REST。**不要**试图从 SSE 增量维护本地状态——那会长出第二套状态推导逻辑，
   与 REST 那套必然打架。权威状态永远来自 REST。
2. **首次连接不补发历史。** 打开工作台时必须自己拉一次 `GET /api/tasks/:id/traces`。
   SSE 从来不保证你能看到连接之前的事件——实测中 `POST ?start=true` 到建连之间
   就已经错过了第一个 Assignment 的 `created` / `started`。
3. **重连靠 `Last-Event-ID`**（浏览器 `EventSource` 自动带），服务端据此补发。
   它的优先级**高于** `?after=`——否则每次重连都从最初那个游标重放一遍。
4. **断线不要把任务标成失败**（UX §18.11）。顶部显示一条轻量提示条，
   保留最后一次权威状态，重连成功后先拉一次 `GET /api/tasks/:id` 校准。

---

## 6. 前端（M6 已完成，这里是接手要点）

六个页面都在：模板列表 / 模板详情 / 任务列表 / 新建任务 / 任务工作台 / Provider 设置。
工作台是三栏可拖拽 + 流式 + 自动跟随，右栏三块共用 `PanelSubject` 单一判据。

**怎么在浏览器里跑起来**（不联网、不烧钱）：

```bash
npm run dev:fake     # 3311，FakeProvider 驱动完整流水线
npm run dev:client   # 5273，vite 代理 /api → 3311
```

`FAKE_SCENARIO=happy|struct-fail|slot-fail` 切换场景。
`.claude/launch.json` 里已经配好这两个（`fake-server` / `client`）。
**注意 `dev:fake` 的脚本是按一个任务的用量预置的**——创建第二个任务时脚本已耗尽，
它会走结构失败路径。这对验证失败态反而方便，但别把它当成 bug。

**已知的完成判据里，有一条没有真正做到**：「工作台 10 种状态全部可达」
只做到了 happy / struct-fail / slot-fail 三条脚本能覆盖的那些，
没有逐态清点过。要补的话从 `src/server/dev-fake.ts` 的 `scriptScenario` 加场景。

### 三个必须一直守住的

1. **Markdown 渲染是安全边界，不是展示细节（§10.5）。**
   模型输出是**不可信输入**。`new MarkdownIt({ html: false })` + DOMPurify 允许标签白名单，
   两道都要。外链统一 `rel="noopener noreferrer nofollow"` + `target="_blank"`。
   这不是理论风险——模型可能在正文里生成 `<img src=x onerror=...>`。

2. **派生字段一律用服务端算好的，前端不要重算（D-07）。**
   `depth`（直接 `depth × 20px` 缩进）、`path`、`blockedBy`、`charCount`、
   `presentation.{tone,state,detail}` 全都是服务端给的。
   前端重算一遍就等于同一套业务判断有两份实现，必然漂移。
   附录 B 那张 14 行的规则表已经在 `domain/presentation.ts` 里实现并 100% 分支覆盖了。

3. **`TaskDetail.stepper` 是五段进度条的数据源**，`owner` 字段区分
   「系统的确定性动作」与「Agent 的工作」——工作台右栏据此决定显示
   「系统组装」还是某个 Agent 的工作面板。

4. **工作台的全部本地状态都是「这一个任务的」。**
   `/tasks/$taskId` 上那句 `remountDeps: ({params}) => params.taskId` 不是可选优化，
   删掉它就会有静默的错数据：trace 的 `sequence` 每任务从 1 起，
   而合并按 sequence 去重——换任务时新任务的事件会被旧编号整段吃掉。
   同理 `selectedSlotId`（槽位 id 来自模板，同模板任务必然重名）与 `commandError`。

### 写前端测试之前先知道这两件事

1. **本仓库没开 `globals: true`**，所以 @testing-library 的自动清理**不生效**。
   每个 jsdom 测试文件都要自己 `afterEach(cleanup)`，否则上一条用例的 DOM
   留在 body 里，下一条 `screen.getByText` 会「找到多个元素」。
2. **jsdom 没有 `EventSource`，且 `scrollHeight`/`clientHeight` 恒为 0。**
   测滚动相关行为必须先 `Object.defineProperty` 造出滚动几何，
   否则测到的是 jsdom 的默认零值而不是你的逻辑。
   现成的样板见 `src/client/pages/task-switch.test.tsx`（fetch + EventSource 桩）
   与 `src/client/workbench/trace-timeline.test.tsx`（滚动几何）。

---

## 7. 陷阱清单（症状 → 原因）

| 症状 | 原因 |
|---|---|
| `npm run dev:server` 报「已应用的迁移不可编辑」 | 见 §1，删掉 `data/forge-core.sqlite` |
| 测试莫名其妙互相看到对方的数据 | 有人用了会被 `path.resolve` 的内存库哨兵。判据必须是 `isMemorySentinel`，不是 `includes(':memory:')` |
| 任务永久停在 `running` | 这是本系统**最不能接受**的状态。三道网：Runtime 超时 / 引擎双桶配额 / 启动恢复。M5 又补了两条：引擎逃逸异常收尾、`enqueue` 不再因「正在跑」而丢弃入队 |
| 改一次模板名，所有历史任务的显示都变了 | 有人从磁盘现读模板了。任务必须读**自己的冻结快照**（AC-002） |
| 前端时间线里每条事件出现两次 | SSE 首连补发了历史。首连不该补发，见 §5 |
| 优雅关闭挂到超时 | SSE 响应永远不会自己结束。必须在 `preClose`（不是 `onClose`）里 `sse.close()` |
| 某个本该 409 的错误回了 500 | `ERROR_HTTP_STATUS` 必须是完备的 `Record<ErrorCode, number>`，**永远不许写「其余默认 500」** |
| 模型说完话但没提交 | 这是正常路径，走 `no_submission` 重试。给模型的反馈必须说「你没有提交」，不能说成别的（给模型一句与事实相反的反馈是最坏的反馈） |
| 换个任务，时间线还是上一个任务的 | `/tasks/$taskId` 的 `remountDeps` 被删了。sequence 每任务从 1 起，去重会吃掉新任务的事件 |
| 前端测试报「找到多个元素」 | 没写 `afterEach(cleanup)`。本仓库没开 `globals: true`，自动清理不生效 |
| 任务全都失败，但服务和 `/api/health` 都正常 | Provider 凭据缺失。看启动横幅的 `[provider]` 警告行，或 Provider 设置页。填 `.env` 的 `DEEPSEEK_API_KEY` |
| 改了默认端口/目录却没生效 | 别在各处 `?? 默认值`，默认值只在 `src/server/config/env.ts` 一处（§2.6） |
| 之前跑的任务「不见了」 | `DATABASE_PATH` 指向了另一个库。历史记录按库文件走，`dev:fake` 默认落在 `dev-fake.sqlite` |
| `npm run build` 成功但打不开页面 | 忘了 serve `dist/client`。后端只有 `/api/*`（这是定案，见 §1.4）。本地用 `npm run preview` |
| 工作台卡住不动，最后事件突然全部涌出 | 反代开着缓冲。nginx 的 `/api/` 要 `proxy_buffering off`（§1.4 第 3 条） |
| 刷新 `/tasks/<id>` 变 404 | 静态托管缺 SPA fallback（`try_files $uri /index.html`） |

---

## 8. 需要你（业务方）做的事

1. **轮换 DeepSeek API Key。** 它在聊天记录里以明文出现过。泄露点是聊天记录，不是仓库
   （仓库里只有 `.env`，已 gitignore；`providers.yaml` 只记环境变量**名**）。
2. ~~**首次 git commit。**~~ ✅ 已完成（`622e62b`）。
3. **以业务方身份审一遍 4 份 `SKILL.md`**（`skills/` 下）。它们是 M4 重写的，
   直接决定模型产出的质量。我能验证「结构合法」，验证不了「这一章好不好看」。
4. **决定 D-17 的 L3 要不要动用**（Q-17）：`deepseek-v4-pro` 的价格与延迟没实测过。
   目前 L1 就够了（首次通过率 100%），L2/L3/L4 一次都没用上。
5. ~~**决定部署形态**（Q-24）~~ ✅ 已定案：**前后端分离**。理由是后续要加的功能
   （CLI 操作方式、审核打回机制）会同时长在两侧，边界清晰比省一个进程更值钱。
   落地见 §1.4 与方案 §10.6。
6. **决定 UX §13.5 在 P0 做到哪**（Q-25）：导出三件套没做，已完成槽位也看不到技术详情。
   是补齐还是把 §13.5 标成 P1，得你说了算——否则下一个人会当成 bug 再改一遍。

---

## 9. 未解问题索引

全文在 `notes/OPEN-QUESTIONS.md`，共 **25 条**。Q-21 与 Q-23 已在 M7 落实，
**Q-24 已由业务方定案**（各自条目下都补了结论）。

M6/M7 复查新增的两条，都是**范围问题不是缺陷**：

- **Q-24** ✅ 已定案：前后端分离，`@fastify/static` 已卸载，见 §1.4
- **Q-25** ⏳ 待划线：已完成槽位看不到技术详情（UX §13.5 只做了一半）

M5 期间新增的四条：

- **Q-20** `provider_health` 表 P0 没有写入方（刻意——持久化健康状态跨重启后多半是错的）
- **Q-21** application 层没有 logger，内部错误只能进 stderr（M7 决定要不要注入）
- **Q-22** SSE 的 `state` 由 Hub 观测 trace 得出，依赖一条隐含约定：**改状态的地方必须写 trace**
- **Q-23** SIGTERM 不 flush trace 缓冲，会丢一段还没落盘的正文（M7）

早前的几条里，对 M6/M7 影响最大的是：

- **Q-18** `executions.input_tokens/output_tokens` 恒为 NULL。链路完整建好了但时序上不可能被填上
  （提交发生在工具调用内部，而 usage 在流的最后才到）。前端会拿到一个永远为 null 的合法字段——
  **不要**把它渲染成「本次消耗 0 token」。
- **Q-19** M4 的 100% 只对**一份**输入成立。密集输入包单独跑过一小批，两批数字分开报、不合并。

---

## 10. 这个项目的开发方式

前面几个里程碑是「主 Agent 编排 + subagent 逐任务开发与审查」跑下来的。
M5 因为环境问题主 Agent 独立完成，收尾时补了一轮独立审查——**那一轮报了 7 条应修 + 5 条建议，
全部属实**，其中两条（stop→resume 竞态导致永久 running、我自己那条恒为真的安全断言）
是主 Agent 自己不可能发现的。

结论：**独立审查视角的价值在收尾时最高**，比开发期更高。M6 建议照此办理——
自己把页面写完，然后开一个不带上下文的审查者对着 `.dc.html` 和判据逐条核。
