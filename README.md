# Forge Core vNext

**结构槽原生的 Agent 内容生产平台。** 输入一份「章节执行包」，输出一篇组装好的章节：
结构设计 Agent 先把章切成槽位树，每个槽位由写作 Agent 独立填充，
审核 Agent 按判据逐条检查，检出问题就返修，最后原子组装成产物。

全程可追溯：一次跑会留下几百条轨迹事件、每次调用的完整上下文与其哈希，
「从库里读出某次执行即可逐字重建它的输入」是硬约束，不是口号。

---

## 现在到哪一步了（2026-09-01）

**平台已经能跑；当前工作转入 S0–S6 内容质量迭代。** 这阶段的验收不是“功能更多”，而是产出是否更接近可投稿/签约短故事、且去掉 AI 味。

| | 状态 |
|---|---|
| 平台闭环 | ✅ M0–M7 + R0–R6 已能真实模型跑通、审核返修链路已落地 |
| **S0 指纹脚本** | ✅ 已由 `05d93af` 完成：`bench/fingerprint.mjs` 建成，并修正语料清单三处口径漏 |
| **S1 fixture 导出 + 回放器** | ✅ 已完成。旧库 168 个候选中只有 **6 条**双 hash 保真，162 条可审计排除；新增 ReplayInput 后，用当前模板/Skill 完整 capture 3 个故事得到 **114 条新 execution，114/114 逐字保真** |
| **S2 基线冻结** | ✅ `run r0` 已冻结：15 个 fixture case；四类 `n=3`，场景写作按首跑方差调到 `n=6`；共 54 份、53 成功、1 次未提交。无正文汇总见 `fixtures/s2-r0-summary.json` |
| 模板/Skill 不一致 | ✅ **S2.5 已完成**：两级模板、私有原文、防抄线、动态整篇预算、readsSlotTypes/孤儿检查均已实现；同一故事 r2 产出 25 节 / 14,844 汉字，防抄重合 0、私有原文表外 0 命中 |
| **S3 确定性产物闸门** | ✅ 人称/引号/编号 hard-warn 已接入 artifact validation；合成 parity 3/3，r2 为第一人称/直角引号/25 编号节 |
| **S4 分节粒度** | ✅ 第三轮真实 ReplayInput variant 达到 3/3，`outline-writing 1.2.0` 已提升生产；自动粒度审核因正常样本 1/3 误报未上线 |
| **S5 写作取舍/段落颗粒** | ✅ `scene-writing 1.2.0` + `numbered_sentence_paragraphs_v1` 已提升；18/18 文字不变，段长中位 44.5→20 |
| **S6 有效信息密度** | 🚧 写作 A/B 36/36 完成、局部审核探针 r2 9/9；写作变体未证明稳定改善，2000 汉字趋势窗口不足，未提升生产 Skill |
| 当前边界 | **S2.5–S5 完成；S6 机制部分验证但阶段未完成。** 缺口转入多故事整篇仿写验收。无正文证据见 `fixtures/s2-5-r1-summary.json`、`fixtures/s3-summary.json`、`fixtures/s4-summary.json`、`fixtures/s5-summary.json`、`fixtures/s6-summary.json` |

### 已知的最大问题：产物是流水账

写作 Skill（`skills/scene-writing/SKILL.md`）**只有一条真正谈手艺的规则**：
「摄像机拍不到的就是解释不是事件」。它是一条**准入**标准，
从没告诉模型**大多数动作不配占一个句子**——整份 Skill 里没有任何一句谈取舍。

而审核判据只有一个方向的刹车：S2（心理解释）是检出最多的一条，
每返修一轮就把文本再推向外部动作一次。**「动作太多、都一样重要」落在判据的盲区正中央。**

这是**写作 Skill 的问题**，不是模型能力问题，也不是机制问题。
下一阶段的工作就是它。

---

## 跑起来

```bash
npm install
cp .env.example .env      # 里面每一项都有注释说明

npm run dev               # 服务端 + 前端（启动时自动跑迁移）
npm run dev:fake          # 全程 FakeProvider，不发任何网络请求
```

**headless 跑一个完整任务：**

```bash
# 假 Provider：第一层原文 → 大纲
npx tsx src/server/cli/run-task.ts \
  --template zhihu-outline --input-file fixtures/chapter-packet.txt \
  --provider fake --db ./data/dev.sqlite

# 第二层大纲 + 系统私有原文 → 整篇正文，使用 JSON 多字段输入
npx tsx src/server/cli/run-task.ts \
  --template zhihu-story --input-json /tmp/story-input.json \
  --provider fake --db ./data/dev.sqlite
```

> **`--db` 不给就是内存库**，进程一退全部丢失。真跑忘了带它，
> 钱花了、数据没了（本项目踩过一次）。`DATABASE_PATH` 环境变量对 CLI **无效**。

### 环境变量

`config/providers.yaml` 受版本控制，**只允许出现环境变量的名字**（`apiKeyEnv`），
绝不写值。值放 `.env`（已 gitignore）：

```
DEEPSEEK_API_KEY=...
DATABASE_PATH=./data/forge-core.sqlite
```

REQ §13 / NFR-005：凭据与模型的隐藏推理（`reasoning_content`）
不得进入任何数据库列、轨迹、提示词、工具结果或日志。
`tests/integration/m7-desensitization-audit.test.ts` 对整库与 API 响应做审计。

---

## 架构

```
完整原文 → [zhihu-outline] → outline.md
outline.md + 系统私有原文 → [zhihu-story] → story → title + 8–30 个 section
                                      ↓ 结构审核 / 小节审核 / 防抄线
                                  numbered_sections_v1 → story.md
```

| 层 | 位置 | 职责 |
|---|---|---|
| `domain/` | 纯函数，零 IO，不读时钟 | 校验、投影、判定 |
| `application/` | 编排 | 服务、上下文装配、调度、引擎 |
| `infrastructure/` | SQLite 仓储 + UoW | 事务边界 |
| `runtime/` | Provider 适配与 Agent 循环 | 工具分发、提交闸门 |
| `client/` | React 工作台 | 只渲染不判断——呈现在服务端算 |

几条贯穿全局的纪律：

- **快照冻结**：任务创建时冻结模板与全部 Skill。改磁盘上的 SKILL.md 不影响历史任务。
- **一条判据一次调用**（D-23）：prompt 里不出现其他判据。
- **引文闸门**（D-11/D-25）：审核报的问题必须带逐字引文，代码逐字核对，对不上就丢弃。
  至今 14/14 命中、0 误杀。
- **任务永不因审核卡死**（D-26）：返修预算耗尽就按现状完成，并标记 `review_exhausted`。
  措辞受 D-30 约束——**不许说「审核通过」**，只能说「未检出问题」。

---

## Skill 与模板（S2.5 中间态）

```
skills/
  outline-structure-design/ outline-writing/ outline-review/
  chapter-structure-design/ title-writing/ scene-writing/
  structure-review/ scene-review/
templates/
  zhihu-outline/template.yaml   原文 → 全篇执行大纲
  zhihu-story/template.yaml     大纲 + 私有原文 → story.md
```

**S0–S5 已完成；S6 已完成机制实验但未达生产提升门槛。** 两级流水线、system 私有输入、14 字片段防抄线、
story→section、动态整篇预算与 D-88 检查均已落地；同一真实故事 r2 为 25 个编号小节、
14,844 汉字，且第一人称/直角引号产物闸门全绿。S4 `outline-writing 1.2.0` 已提升；
S5 `scene-writing 1.2.0` 与句末段落 assembler 已提升，18/18 不改文字、段长中位 44.5→20。
S6 已完成 36 份当前快照写作 A/B 与 9 次局部审核探针，但写作变体未证明跨 case 稳定改善，
且单节/三节拼接不足固定 2000 汉字冗余窗口，因此未提升生产 S6 Skill；缺口留到多故事整篇仿写验收。

**每个 Skill 目录下有一份 `RELIABILITY.md`**，记录这条 Skill / 每条判据
在真实模型上的实测表现。它**刻意不在 `SKILL.md` 里**——`SKILL.md` 的每个字节
都会进模型上下文，把「这条判据可能没用」写进去等于先给模型一个放行的理由。

**改 Skill 之前先读它的 RELIABILITY.md。** 那里记着哪些判据是死的、
哪些改动已经试过并失败、以及每个数字的样本量。

判据文本必须**取自写作 Skill**（§6.3），不另写一套标准——
审核和写作对着两份标准是最难查的一类不一致。

### 已知的两条能力边界（改文本救不回来）

1. **需要判断的判据召回为 0。** R0.5 盲测：D3（事实矛盾）、D4（停错地方）
   在三种提问架构下都是 0/3。失败方式已查清——模型做了对账、把矛盾一字不差
   写进工作区、**然后照样放行**。不是感知失败，是判决失败。
2. **提示词说重了没用。** 返修提示词里本来就写着「未被指出问题的部分保持原样」，
   实测同一次返修改了 72.8% 的正文。两条独立证据指向同一件事：
   **这类问题只能靠机制，不能靠措辞。**

---

## 测量纪律

这个项目的结论都要有数字撑着，`probe/` 下是可复跑的测量脚本：

| 脚本 | 答什么 | 成本 |
|---|---|---|
| `revision-granularity.py` | 为修一条 finding，附带改了多少正文 | **0**（读历史库） |
| `finding-origin.py` | 每条缺陷是原稿自带还是返修造的 | **0** |
| `drift-gate-simulation.py` | 阈值闸门能不能用 | **0** |
| `edit-contract-replay.ts` | 重放历史返修，验编辑清单契约 | ~15 万 in |
| `bad-tree-recall.ts` | 注入坏树，量结构审核召回 | ~7 万 in / 棵 |
| `run-r4-regression.mjs` | 场景审核判据的回归门槛 | ~42 万 in |

> **改 `skills/scene-review/SKILL.md` 的判据需要重跑 R4 回归**（约 42 万 token）。
> `structure-review` 没有这条基线。

三条从踩坑里换来的规矩：

1. **对副本跑，别开 `data/` 下的原库。**
2. **失败的执行不写 `slot_reviews`。** 于是「这条判据的调用没成功」和
   「这条判据未检出问题」在裁决表里长得一模一样。任何读这张表的分析
   都要先断言「这一轮的裁决条数齐不齐」——不齐就整份结果不可信。
3. **重复样本比新变体值钱。** 坏树注入里同一棵树跑两次给出了不同裁决，
   那条顺手加的一致性检查是整跑最有价值的一条。

---

## 决策与记录

| 文件 | 内容 |
|---|---|
| `Forge-Core-vNext-可执行技术实现方案-V1.0.md` | 权威技术方案（D-01…D-32） |
| `notes/AUTOMATED-REVIEW-REVISION-DESIGN-V0.2.md` | 审核返修设计（D-21…D-32） |
| `notes/REVISION-GRANULARITY-DESIGN-V0.1.md` | 返修粒度（D-60…D-65）+ 实测 |
| `notes/R0.5-REVIEWER-PROBE-REPORT.md` | 审核能力边界的原始报告 |
| `skills/*/RELIABILITY.md` | 每条判据的实测可靠度 |

设计文档里的「诚实声明」一节是硬性要求：**每份设计都要写明哪些结论有实测支撑、
哪些是推断、样本量多大。**

---

## 下一步

1. **完成 S5 写作取舍实验。** 当前可恢复 checkpoint 运行 3 个固定 section × 两条件 × n=6；不读取半成品作结论。
2. **S6 完整回归只跑一次。** 局部 S5 判据 r2 已 9/9；等 S5 写作侧通过后再跑版本化 116 次回归。
3. **保持 r0/r1/r2 与 S4 三轮并排。** 不覆盖失败；S4 自动审核 1/3 误报证据继续保留。
