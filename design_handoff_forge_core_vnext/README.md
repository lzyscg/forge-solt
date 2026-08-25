# Handoff: Forge Core vNext — 结构槽原生 Agent 内容生产平台

## Overview

Forge Core vNext 的 P0 全套界面原型，覆盖需求规格说明书 §14–§17、§22 所定义的页面范围。核心业务模型是**结构槽生产模式**：一个模板定义槽位树（slot tree），每个内容槽位挂一个 Assignment（Agent + Skill + 模型 + 依赖 + 产物校验规则），任务运行时按依赖顺序逐槽填充，全部通过后由容器槽位组装为最终产物。

这套原型的用途是**作为后端开发的界面契约**：每个页面的逻辑类顶部都有一组数据常量，其字段形状即该页面期望的 API 响应形状。后端可以直接照这些形状定义接口，前端实现时替换数据源即可。

## About the Design Files

本包内的 `.dc.html` 文件是**用 HTML 制作的设计参考稿** —— 展示预期的视觉与交互行为，不是可直接上线的生产代码。

预期做法是在目标代码库的既有技术环境中（React / Vue / 其它）**重新实现这些设计**，沿用该代码库已有的组件库与工程约定；若目标项目尚无前端环境，则选择合适的框架从头实现。

对后端开发而言，本包的价值集中在下面的 **Data Contracts** 一节：那是从界面反推出的数据需求，可直接作为接口设计的输入。

## Fidelity

**High-fidelity（高保真）**。颜色、字号、间距、状态分色、交互行为均为最终设定值，取自绑定的设计系统令牌（见 Design Tokens）。开发时应按令牌值精确还原，而非目测近似。

一处例外：任务工作台底部有一条状态控制条，那是原型用来切换 9 种状态演示的调试开关，**实现时必须删除** —— 真实状态由后端 SSE 推送驱动。

## Screens / Views

### 1. 任务列表 `/tasks` — `任务列表.dc.html`

**Purpose** 运营查看所有生产任务的当前进展，判断哪个任务需要介入。

**Layout** 68px 窄侧栏 + 主区。主区自上而下：头部（标题 + 计数 + 动作组，padding 22/32/18）、筛选条（padding 13/32，状态与模板两组 chip + 搜索框）、表格（4 列：任务 / 当前进展 / 槽位 / 更新）。表格行 padding 15px 32px，行间 1px hairline 分隔。

**关键设计约束**：状态列**不显示裸状态机值**。不写 `running`，写「正在填充 Slot」并在下一行给出「第 3 章 · scene_2 场景正文生成中」这类可判断的业务事实。这是需求书 §14 的明确要求，后端需提供业务化描述字段，而非仅返回状态枚举。

**Components**
- 状态点：7×7px 圆形，运行态 `animation: fc-pulse 1.4s ease-in-out infinite`（0%/100% opacity .35，50% opacity 1）
- 状态文字：`var(--font-heading)`，600，14px，按 tone 取色
- 进度条：3px 高，底 `--color-neutral-200`，填充色同状态色，宽度 = done/total
- 行 hover：`background: color-mix(in srgb, var(--color-accent) 5%, transparent)`
- 空态：padding 68px 32px，居中，标题 19px + 说明 13px

**Interactions** 点击行 → 任务工作台；「新建任务」→ 新建任务页；chip 筛选即时过滤，状态与模板两组条件为 AND 关系。

### 2. 新建任务 `/tasks/new` — `新建任务.dc.html`

**Purpose** 选模板、填冻结输入、创建任务。

**Layout** 头部 + 左右两栏。左栏（flex 1，padding 26/32/40，内容 max-width 620px）分两节：01 选择模板、02 填写冻结输入。右栏固定 400px，浅底（`color-mix(in srgb, var(--color-surface) 40%, transparent)`），显示选中模板的槽位树预览。

**关键设计约束**：**创建与启动分离**。头部有「仅创建」与「创建并启动」两个按钮，对应两个不同的后端动作。「仅创建」后任务停在 Ready 态，需在工作台手动启动第一个槽位。创建成功后头部下方插入一条提示条（浅强调底，左侧对勾图标），文案区分两种路径。

**Components**
- 模板卡：padding 14/16，1px 描边，选中时描边转 `--color-accent` 且底色 `color-mix(accent 6%)`；左侧 11px 单选圆点，选中时实心加 2px 内白环
- 输入字段：必填/可选徽章（10.5px，必填走强调色描边，可选走 divider 描边），字段右上角显示字段 key（11px，中性灰）
- 结构预览树节点：容器槽位 13px 方形描边标记，内容槽位 13px 圆形强调色描边标记；缩进 `depth × 20px`

**冻结输入语义**（后端关键）：这些值在任务创建时**快照冻结**，整轮生产中所有槽位读到的都是同一份。启动后不可修改。后端需在创建时持久化快照，而非每次执行时重新读取。

### 3. 任务工作台 `/tasks/:id` — `任务工作台.dc.html`

**Purpose** 单任务的生产现场：看槽位树进展、看当前槽位的实时轨迹与产物、必要时介入。

**Layout** 三栏可拖拽。左栏槽位树、中栏产物工作区（内容水平居中）、右栏上下两块（执行轨迹 / 生产信息，块间分隔线亦可拖拽，两块各自可收起）。头部有 Stepper 五段（Ready / 创建结构 / 填充 Slot / 组装 / 完成），五段均可点击导航。

**支持的 9 种状态**：Ready、创建结构、结构校验失败、填充 Slot、历史 Slot 查看、等待依赖、超时重试、Stopped、Failed、Assembly、Completed。

**关键交互逻辑**（实现时必须保留）
1. **自动推进与手动选择互斥**：直播态下右栏自动跟随当前执行槽位；用户一旦选中历史槽位，自动跟随停止，右栏顶部出「查看当前工作」提示条供返回。
2. **面板主体判据统一**：右栏摘要、轨迹、生产信息共用同一套分支判据（容器槽位 / 内容槽位 / 结构创建 / 冻结输入 / 系统组装），三块内容不得各自判断，否则会出现上下打架。
3. **容器槽位不伪造数据**：chapter 这类容器槽位显示「无 Assignment · 容器槽位」，列出下级槽位与组装顺序，**不显示 Producer、不显示执行轨迹、不显示耗时** —— 它不调用 Agent。
4. **流式输出**：产物区实时逐字展开；轨迹事件的时间戳按**事件入列时刻**生成，不重排。

### 4. 模板列表 `/templates` — `模板列表.dc.html`

**Purpose** 浏览可用模板，选一个去新建任务。

**Layout** 头部 + 产出类型筛选条 + 卡片网格（`repeat(auto-fill, minmax(340px, 1fr))`，gap 18px）。

**Components** 卡片 padding 20/21/18，1px 描边，hover 转强调色描边。内含：产出类型 kicker（11px 大写 letter-spacing .1em）、版本号、标题 19px、说明 12.5px、四项计数（槽位 / Agent / Skill / 已跑任务，数字 20px `font-feature-settings: 'tnum'`）、标签行、状态与更新时间。

**三种模板状态**：已发布（强调色）、草稿（中性深）、已归档（中性浅）。归档模板仍可能被历史任务引用，后端不可硬删。

### 5. 模板详情 `/templates/:id` — `模板详情.dc.html`

**Purpose** 查看模板的槽位结构与每个槽位的 Assignment 配置。信息密度最高的一页。

**明确不做 Agent 路由图**（需求书 §16.2）。主体是槽位结构树，选中槽位后右栏展开该槽位的完整 Assignment。

**Layout** 头部 + Tab 条（槽位结构 / 版本历史 / 引用任务）+ 左右两栏。左栏槽位树（行 padding 13px，缩进 `26 + depth × 22px`，选中行浅强调底 + 左侧 2px 强调条）下接「模板级冻结输入」表。右栏固定 430px。

**右栏两套面板**（按槽位类型分支）
- 内容槽位：Assignment 卡（Agent + 说明、Skill + 说明、模型/超时/重试三列）、输入依赖列表（区分「槽位」依赖与「输入」依赖，前者走强调色徽章）、产物校验规则列表（对勾图标 + 规则文字）
- 容器槽位：一段说明（无 Assignment，只在下级全部通过后按顺序拼接）+ 下级槽位的组装顺序列表（带序号 01/02/…）

**校验失败语义**：校验不通过 → 槽位进入「结构校验失败」→ 按 Assignment 的重试次数重跑 → 重试用尽后停在失败态等人工介入。

### 6. Provider 设置 `/settings/providers` — `Provider 设置.dc.html`

**Purpose** 管理模型基础设施。**只管模型层，Agent 与 Skill 的编排在模板里定义，不在此页**（需求书 §17）。

**Layout** 头部 + 三节（已接入 Provider / 模型映射 / 执行默认值），内容 max-width 940px。

**Components**
- Provider 卡：名称 + endpoint + 连通状态（状态点 + 文字 + 延迟 + 检测时间）+ 异常说明（左侧 2px 强调色竖条）+ 底部模型标签行
- 模型映射表：4 列（别名 / Provider / 实际模型 / 在用槽位）。**别名是模板与实际模型之间的间接层** —— 模板里写别名，换模型时只改这张表，不动模板。这是后端需要落地的关键抽象。
- 执行默认值：四张卡（单槽位超时 / 重试次数 / 并发槽位 / 限流退避）。槽位 Assignment 未显式指定时取这里的值；已在跑的任务不受改动影响。

**三种连通状态**：连通正常、限流中（429 计数，落此 Provider 的槽位自动排队重试，**不计入失败次数**）、未连通（映射到此 Provider 的槽位启动时直接失败）。

### 7. 组件状态变体 — `组件状态变体.dc.html`

交付附录，非产品页面。把各组件的全部状态并排铺开供开发对照：Slot 节点 8 态、Trace 事件 4 类 actor、Stepper 3 种段况、状态标签 9 态、按钮 5 变体、确认弹窗 2 类。颜色常量与工作台用的是同一组取值。

## Interactions & Behavior

**导航** 各页 68px 侧栏三图标互通（生产任务 / 模板 / 设置）。任务列表行 → 工作台；模板卡 → 模板详情；面包屑回上级。侧栏图标 hover `background: color-mix(accent 8%)`。

**动画** 仅两处，均为状态指示：
- `fc-pulse` — 1.4s ease-in-out infinite，0%/100% opacity .35，50% opacity 1。用于运行中的状态点与 Stepper 当前段。
- `fc-blink` — 0%/49% opacity 1，50%/100% opacity 0。用于流式输出的光标。

**实时数据** 工作台需接 SSE。事件到达即入列并生成时间戳，不做重排。流式文本增量追加到产物区。

**破坏性操作** 只在文字与描边上转红（`oklch(0.46 0.13 32)`），不做填充。需二次确认弹窗，弹窗内列出将被清空的具体槽位名。

## State Management

**任务级** 当前状态（9 态之一）、当前执行槽位 id、槽位完成计数、输入快照。

**工作台本地 UI 状态** 选中槽位 id、是否跟随直播（用户选中历史槽位时置 false）、三处分隔线位置、右栏两块的收起状态。

**数据获取** 列表页轮询或按需刷新即可；工作台必须走推送 —— 轮询无法支撑流式输出。

## Data Contracts

后端接口设计的直接输入。每个页面逻辑类顶部的常量即该页期望的响应形状，与需求规格说明书 §21 一一对应。

| 页面 | 常量 | 形状 |
|---|---|---|
| 任务列表 | `TASKS` | `{name, template, tone, state, detail, done, total, updated}` |
| 新建任务 | `TEMPLATES` | `{id, name, desc, slots, inputs[{key, label, value, hint, multiline, req}], tree[{name, kind, depth, assignment}]}` |
| 模板列表 | `TPLS` | `{name, output, version, slots, agents, skills, runs, desc, tags[], state, tone, type, updated}` |
| 模板详情 | `NODES` | `{id, name, depth, kind, purpose, agent, agentNote, skill, skillNote, model, timeout, retry, deps[{kind, name, note}], checks[], children[{no, name, note}], containerNote, dep}` |
| Provider 设置 | `PROVIDERS` / `MAPPINGS` / `DEFAULTS` | `{name, endpoint, tone, state, latency, checked, note, models[]}` / `{alias, provider, model, usage}` / `{label, value, note}` |
| 任务工作台 | `SLOTS` / `executions` / `assignmentRows` | 见文件末尾逻辑类 |

**三个字段约定**
- `tone` 是**语气分类**（run / ok / wait / warn / fail / stop / idle），驱动前端取色，与状态机值解耦。后端应显式返回，不要让前端从状态字符串猜。
- `state` 是**业务化描述文字**（「正在填充 Slot」），不是状态机枚举。
- `detail` 是**可判断的业务事实**（「第 3 章 · scene_2 场景正文生成中」），不是日志行。

`kind` 字段区分 `container` 与 `content`，前端据此走两套完全不同的渲染分支 —— 这是整套界面里最重要的一个判据。

## Design Tokens

全部取自绑定的设计系统，见 `_ds/classical-77148255-5e00-4a2c-957b-cef734727482/styles.css`。实现时应引用令牌变量，不要硬编码色值。

**颜色** `--color-bg` `--color-surface` `--color-text` `--color-divider` `--color-accent` `--color-accent-600/700/800` `--color-accent-100` `--color-neutral-100…900`

**唯一的系统外色值** 破坏性/失败态用 `oklch(0.46 0.13 32)`（文字与描边）与 `oklch(0.96 0.02 32)`（浅底）。设计系统无对应语义色，故内联定义；若目标代码库已有 danger 语义色，改用它。

**字体** `--font-heading`（标题、数字、槽位名）、`--font-body`（正文）。等宽处用 `ui-monospace, SFMono-Regular, Menlo, monospace`（槽位 key、时间戳、JSON 片段）。

**字号** 页标题 25–26px / 区标题 18–19px / 卡片标题 16.5–19px / 正文 13.5–14px / 辅助 12–12.5px / 徽章与 kicker 10.5–11.5px。数字一律 `font-feature-settings: 'tnum'`。

**圆角** `--radius-sm` `--radius-md`。**阴影** `--shadow-md`（仅弹窗）。

**间距** 页面 padding 26–32px，区间距 34–42px，卡内 14–22px，元素间 6–18px。

**类名** 按钮 `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-ghost`；标签 `.tag` + `.tag-accent` / `.tag-outline` / `.tag-neutral`；输入 `.input`；弹窗 `.dialog` + `.dialog-title` / `.dialog-body` / `.dialog-actions`。其余样式内联。

## Assets

无图片、无字体文件。所有图标为内联 SVG（stroke-width 1.6–1.8，`stroke-linecap="round"`，尺寸 14–19px），来自 Lucide 图标集的通用形状，可替换为目标代码库现有图标库的等价图标。

## Files

| 文件 | 内容 |
|---|---|
| `任务列表.dc.html` | 任务列表页 |
| `新建任务.dc.html` | 新建任务页 |
| `任务工作台.dc.html` | 任务工作台（9 态、流式输出、三栏可拖拽） |
| `模板列表.dc.html` | 模板列表页 |
| `模板详情.dc.html` | 模板详情页 |
| `Provider 设置.dc.html` | Provider 设置页 |
| `组件状态变体.dc.html` | 组件状态对照附录 |
| `support.js` | 原型运行时。**不要移植** —— 仅供本包内 HTML 在浏览器中直接打开预览。 |
| `_ds/classical-…/styles.css` | 设计系统令牌与基础类，令牌值的权威来源 |

每个 `.dc.html` 直接用浏览器打开即可预览，从 `任务列表.dc.html` 进入可点击走通全流程。
