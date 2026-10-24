# 模型业务回答 / 系统协议编译设计 V0.1

> 状态：已批准，进入 I1 垂直切片实施
>
> 适用范围：Forge Core 的模板、Skill、Assignment、工具、领域产物、Replay、trace、持久化和 benchmark。

## 1. 设计动机

Forge Core 的核心职责之一，是让模型专注于必须依赖语义理解的业务判断和内容生产，而不是维护中间协议、格式、编号、排序、计数、状态或序列化。

I1 的真实实验已经证伪了“继续增加 Prompt 规则”这条路线：

- r3 的容量行格式错误会使 parser 丢弃小节，并连带制造 P-ID 顺序错误；
- r4 收紧容量格式后该错误暂时消失，但标题编号和 P-ID 仍不稳定；
- r5 增加 N 行账本和两遍编号后，成功率、编译率和轻重分布同时回归，r4 已消失的容量错误重新出现。

这些失败主要不是故事理解错误，而是模型同时承担业务分析和机械协议造成的注意力竞争。继续扩写 Skill 只会让不同约束相互挤压。

因此，系统的权威输入应从“格式正确的展示文本”改为“结构化业务回答”。展示文本只是系统生成的视图。

## 2. 顶层职责规则

每增加一个字段或步骤，都先判断：

> 这个值是否必须经过语义理解才能决定？

### 2.1 模型负责

- 识别人物、事件、因果、动机和关系变化；
- 判断铺垫、压力、反转、兑现、结局和余波；
- 判断 `P0 / P1 / bridge` 的业务类别；
- 判断叙事模式和所需的业务容量；
- 描述场景目标、冲突、状态变化、结束状态与信息控制；
- 发现审核问题、给出准确引文和问题解释；
- 决定具体改写内容和最终正文表达。

### 2.2 系统负责

- operation、target、criterion、producer 和 execution 绑定；
- source section 识别、原编号 token、顺序和汉字数；
- 确定性展开档、正式 unit/slot/P-ID；
- 字数预算和 largest-remainder 分配；
- 字段名称、顺序、标点、Markdown、JSON、API DTO；
- 状态机、执行 token、原子提交和重试反馈；
- 确定性校验、hash、Replay、trace 和审计；
- 领域产物到展示产物的序列化。

### 2.3 Claude 质量判断的特殊位置

业务质量仍可由 Claude 判断，因为因果、反转、信息密度和“AI 味”不能被机械规则可靠替代。但 Claude 的判据、引文、过滤数量和最终结论必须可见、可抽查；系统负责保存和呈现这些证据，不把它伪装成确定性校验。

## 3. 当前职责错位

当前 `complete_assignment` 要求模型重复提供系统已知或可派生的信息：

- 模型选择 `kind`，但 Runtime 已知 operation；
- 模型填写 `slotId`，但 execution 已知 targetSlotId；
- 模型生成 root/slot ID、parentId 和 order；
- 审核模型携带 criterionId，但当前 Assignment 已冻结判据；
- NarrativePlan 模型维护标题编号、P-ID、字段顺序和容量标点；
- 系统从 Markdown 反向恢复领域对象。

这些字段不增加业务信息，却产生串槽、错 kind、跳号、格式挤压、parser 丢节和无意义重试。

## 4. 目标领域词汇

### Answer Contract

系统冻结的任务提交契约。它定义本次 Assignment 要模型回答哪些业务问题、可使用哪些上下文，以及系统将如何编译答案。模板只能引用系统支持的版本化 contract，不能提交任意 JSON Schema。

### Semantic Answer

模型对 Answer Contract 的业务回答。它不携带 operation、target、criterion、正式 ID、状态或展示格式。

### Domain Artifact

系统将 Semantic Answer 绑定、编号、计算和校验后得到的权威领域数据，例如 `CompiledNarrativePlan`。下游业务逻辑消费 Domain Artifact，而不是解析 Markdown。

### Artifact View

由 Domain Artifact 确定性生成的 Markdown、API、下载文件、UI 或兼容文本。View 不是权威数据源。

## 5. 目标数据流

```text
用户输入 / system-private 原文
        ↓
冻结任务快照
        ↓
Answer Contract Compiler
  ├─ 模型可见业务 schema
  ├─ runtime-only 私有 resolver
  ├─ 确定性 policy/version/hash
  └─ 无敏感 Replay 摘要
        ↓
模型提交 Semantic Answer
        ↓
Business Answer Module
  ├─ 自动绑定 operation/target/criterion/producer
  ├─ 分配正式 ID、顺序和预算
  ├─ 领域校验和可执行反馈
  └─ 编译 Domain Artifact
        ↓
原子保存 Domain Artifact + Artifact View
        ↓
下游业务 / Markdown / API / 审计
```

## 6. 深模块 interface

目标模块只暴露两个行为：

```ts
interface BusinessAnswerModule {
  prepare(input: PrepareAnswerInput): PreparedAnswerContract;
  submit(input: SubmitBusinessAnswerInput): Promise<AnswerSubmissionOutcome>;
}
```

`prepare()` 隐藏模板 contract 选择、私有派生上下文、动态 Zod/JSON Schema、contract hash 与 Replay 描述。

`submit()` 隐藏目标绑定、领域 compiler、ID/预算算法、确定性校验、serializer、原子持久化、状态转换和 trace。

内部可以按 contract kind 分派，但不把 compiler 注册表暴露给 Runtime。第一版只有 `narrative-plan/v2`，因此不为它建立只有一个 adapter 的假 port。

### 为什么不是极小 `unknown`

`submit_answer({answer: unknown})` 表面很小，但把模型提示、运行时校验和模板能力全部推成任意 schema，领域词汇和类型安全都会消失。

### 为什么不是全局产物联合

固定的 structure/narrative/prose/review/revision 大联合虽然类型明确，但所有模型都会看到所有 kind，且每增加产物都扩大公共 interface。正确做法是由当前 Assignment 动态暴露唯一契约。

## 7. I1：`narrative-plan/v2`

### 7.1 系统派生 Source Section Context

当私有原文存在 8–30 个合格编号分节时，系统生成 runtime-only profile：

```ts
interface SourceSectionContext {
  ref: string;
  sourceToken: string;
  order: number;
  hanCount: number;
  expansion: 'light' | 'standard' | 'detailed';
}
```

- ref 是本次 contract 的引用，不是正式 ID；
- sourceToken 保留 `01` 等前导零；
- expansion 按冻结 q30/q70 算法派生；
- 数量和顺序由系统锁定；
- 没有合格编号分节时，V0.1 fail-closed 并继续走 legacy，不在同一切片引入自由分节协议。

### 7.2 模型回答

每节只回答：标题、状态变化、priority、mode、容量四个业务整数、cast、objective、conflict、endState 和可选 informationControl。

模型不回答：operation、kind、slotId、section order、原编号、unit ID、P-ID、expansion、weight、budget、Markdown 标签或标点。

### 7.3 系统编译

系统负责：

1. sourceSectionRef 一一绑定；
2. 分配 `unit_01…`；
3. 非 bridge 单位连续分配 `P001…`；
4. 注入 source expansion；
5. 校验容量 8/4/4/2；
6. 校验 P0、结局和展开分布；
7. 计算 weight 和 story budget；
8. 生成 `CompiledNarrativePlan`；
9. 生成兼容 Outline v2 Markdown。

因此 section count、前导零、标题编号、P-ID 和容量格式错误在结构上不可表达。

## 8. 模板与 Skill

模板的 content-bearing slot type 可显式引用：

```yaml
answerContract:
  kind: narrative-plan
  version: 2
  sourceField: source_text
  sourceSegmentation: preserve-numbered-sections
  expansionPolicy: source-length-quantiles-v1
```

模板负责编译政策、私有字段授权和确定性约束。Skill 只描述如何理解故事、判断 priority/mode/capacity、保留因果反转和结局，不再描述九行格式、全角分号、P-ID 和标题编号。

旧模板未声明 contract 时继续走 legacy `complete_assignment`。

## 9. 其他任务的后续迁移

- Structure：模型提交语义树和局部引用，系统分配正式 slot ID、parentId、sort order 与依赖 ID。
- Fill：普通正文只提交 `{content}`；系统绑定目标、producer、预算与 review 状态。
- Review：模型只提交 verdict、quote 和 problem；系统绑定 targetSlotId 与 criterionId。
- Revision：模型提交 targetRef/替换内容，系统绑定版本、应用局部修改并保留未改部分。

这些不属于 I1 第一批代码范围。

## 10. 持久化

新 NarrativePlan 在 story_outline 提交后产生，不能回写不可变 task snapshot，也不能只存在于 Markdown。槽位提交应在同一 D-10 条件更新中原子保存：

- canonical Domain Artifact JSON 和 hash；
- kind/version；
- 系统生成的兼容 content_text；
- producer 和状态。

四个 artifact 字段必须全空或全非空。第一批 application 层只接受 narrative-plan v2，不开放任意 artifact。

## 11. Replay

- ReplayInput v1 原字节和解析行为保留；
- v2 使用版本判别 envelope；
- 冻结公共上下文、contract kind/version/hash、模型可见 schema、政策版本和无敏感派生摘要/hash；
- 不冻结私有正文、标题/正文片段、凭据、敏感工具结果和模型输出正文；
- replay 时必须从 hash 匹配的私有存储重新准备 contract，缺失或漂移 fail-closed；
- benchmark 不混组 v1/v2，实验 identity 包含 contract 和 policy hash。

## 12. 隐私与 trace

私有正文只从 hash 校验过的 runtime 存储读取。任何含源标题或正文片段的派生数据仍视为敏感，只在模型调用的内存生命周期存在。首次敏感工具结果后继续抑制文本 delta、SSE 和普通 trace。

持久化 trace 只记录：

- contract kind/version/hash；
- unit/priority/capacity 聚合；
- artifact kind/version/hash；
- section count、policy 标识；
- 结构化 violation。

不得记录私有正文、可逆片段或完整业务答案。公开 benchmark 继续执行固定 14 汉字私有片段扫描。

## 13. 兼容迁移

1. 保留 r3–r5 判退和生产 Skill 不变；
2. 建立纯领域 compiler/serializer；
3. 增加模板显式 opt-in；
4. 只迁移非生产 story_outline Assignment；
5. 影子验证权威 artifact 与 legacy Markdown round-trip 等价；
6. 离线通过后才建立新 Skill 和正式 semantic-contract A/B；
7. 跨故事稳定改善且无语义保真退化后，才迁移已发布模板和生产 Skill；
8. 最后才将 complete_assignment 限定为 legacy execution。

## 14. 验收边界

机械验收要求 100% section 对应、token 保留、P-ID 连续、容量合法和 Markdown round-trip；这些只证明架构消除了机械失败，不代表 I1、S6、F0、平台签约或商业质量成功。

最终质量仍以固定真实样本的因果、关系变化、反转、结局、有效信息密度、“AI 味”和下游成稿为准。正式失败必须保留，不 best-of，不合并不兼容 checkpoint。
