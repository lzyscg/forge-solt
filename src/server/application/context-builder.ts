/**
 * ContextBuilder（文档 §7.4 + D-12）。
 *
 * 纯函数：输入一组已经取好的数据，输出 systemText / userText / contextJson /
 * contextHash / promptHash。**不读时钟、不读随机源、不读环境变量、不做 IO**——
 * §7.4「确定性保证」与 REQ NFR-004「上下文可重建」全靠这一条。
 * 一旦这里出现一个时间戳，同一份状态就再也算不出同一个 hash，
 * FR-CTX-006「相同状态相同 Hash」这个诊断信号立刻失效且无人察觉。
 *
 * ## D-12：两个 hash 不能合并
 *
 *   contextHash = sha256(canonicalJson(结构化语义输入))
 *   promptHash  = sha256(systemText + '\n\n' + userText)
 *
 * `contextHash` 回答「喂进去的信息变了吗」，`promptHash` 回答「怎么组织的变了吗」。
 * 合并成一个的后果是：调一下 prompt 模板里的换行，所有历史 hash 全部失配，
 * 而「上下文是否发生非预期变化」这个问题从此没有答案。
 *
 * `contextHash` 覆盖的语义输入清单（D-12 逐字）：
 * snapshotHash、taskInput 字段值、targetSlotId、slot instruction、
 * 依赖槽位内容及其顺序、skill id+version+注入的 section id 列表、validation 限制，
 * **以及 R3 追加的 `revision`**（D-31 授权：上一轮的对话轮次要「序列化进下一次
 * execution 的 context_json，由它照常参与 context_hash / prompt_hash 计算」）。
 * 后者与「重试追加块」的区别见 `StructuredContextInput.revision` 处的完整论证：
 * 重试回灌的是同一份输入上次哪里没过，返修带来的是这一稿真正多出来的信息。
 * 清单少列一项比多列一项更危险——它是全文件唯一看起来权威的枚举，
 * 下一个读的人会以为漏进去的那一项是 bug。
 *
 * **重试追加块刻意不在其中。** 第 1 次与第 3 次尝试的 contextHash 相同、promptHash 不同，
 * 这正是想要的读数：「输入没变，只是把上次的违规回灌了进去」。
 * 把 attemptNumber 或违规列表塞进 contextHash，会让「同一槽位重试前后语义输入是否一致」
 * 这个问题永远得到「不一致」，等于把信号调成常亮。
 *
 * ## contextJson 就是 contextHash 的原文
 *
 * 与 snapshot-service 同一条纪律：落库的 `executions.context_json` 与
 * `context_hash` 必须**逐字对应**，任何时候都能拿库里那一列重算一遍来核对。
 * 因此本文件产出的 `contextJson` 不是「顺手序列化一下」，而是哈希的唯一输入。
 *
 * ## taskInput / dependencies 为什么是数组而不是对象
 *
 * `canonicalJson` 会把对象的 key 按码点序重排。任务输入字段的顺序来自模板的
 * `inputFields` 声明序，依赖槽位的顺序来自 `dependsOn` 的声明序——两者都是语义的一部分
 * （前者决定 User Message 的段落顺序，后者决定模型读到上游内容的先后）。
 * 用 `{ id, value }[]` 保序，用 `Record` 则会被静默重排，
 * 于是两份实际喂给模型的文本不同的上下文会算出同一个 hash。
 */

import type { Operation } from '@shared/contracts.ts';
import type { StructureViolation } from '@server/domain/structure-validation.ts';
import { canonicalJson, sha256Hex } from '@server/domain/canonical.ts';
import { ForgeError } from '@shared/errors.ts';
import type { Slot } from '@server/domain/types.ts';
import type { RawFinding } from '@server/domain/review-evidence.ts';
import type { PriorRound } from '@server/domain/revision-context.ts';
import { renderRevisionContext } from '@server/domain/revision-context.ts';
import { compareSiblings, documentOrder } from '@server/domain/readiness.ts';
import type { FrozenSkill, FrozenTaskSnapshot } from './snapshot-service.ts';
import type { CompiledAgent, CompiledSlotType } from './template-loader.ts';

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

/** 依赖槽位的正文。顺序即注入顺序，由调用方按 `targetSlot.dependsOn` 的声明序给出 */
export interface DependencyContent {
  slotId: string;
  content: string;
}

export interface ContextBuilderCommonInput {
  /** 冻结快照。运行期唯一的模板与 Skill 来源（AC-002） */
  snapshot: FrozenTaskSnapshot;
  /** 本次绑定的 Agent，来自 `snapshot.compiled.agents` */
  agent: CompiledAgent;
  /** 本次绑定的 Skill 快照 */
  skill: FrozenSkill;
  /** 从 1 起。第 1 次尝试不追加重试块 */
  attemptNumber: number;
  /** `maxRetries + 1`。只用于「这是第 n 次尝试，共 m 次机会」这句话 */
  maxAttempts: number;
}

/** §7.4 的重试追加块（D-13：三段式违规原样传入，不许压成一句话） */
export interface StructureRetryInput {
  /**
   * 上次 proposal 的 JSON 原文，原样回灌（§7.4）。
   * 目的是让模型做**增量修正**而不是重新设计——重新设计大概率引入新的违规。
   * 由调用方给出文本而不是对象：回灌的必须是模型上次真正提交的那份字节。
   */
  previousProposalJson: string | null;
  /** 全部违规，不截断（D-13：只报第一条会让模型陷入「改一条冒出下一条」的循环） */
  violations: readonly StructureViolation[];
  /** §7.6 的 `no_submission` 分支：模型说完了但没调 complete_assignment */
  noSubmission: boolean;
}

/**
 * R5：结构审核检出问题后，重新设计那一轮的追加上下文。
 *
 * 与 `StructureRetryInput` 是**两件事**，与 fill_slot 那边 `retry` / `revision` 的
 * 分法一模一样：`retry` 是「上一次提案没过 19 条确定性校验」，同一稿的重来；
 * 这一个是「上一稿已经建成了树，审核 Agent 按判据在 instruction 里挑出了问题」。
 * 一次尝试可能同时处在两者之中（重新设计的那一版又漏了个 parentId），两段各自成段。
 */
export interface StructureReviewInput {
  /** 第几次重新设计，从 1 起。只用于「第 n 次」这句话 */
  round: number;
  /**
   * 上一版结构的概要原文，**与审核 Agent 当时看到的逐字相同**。
   *
   * 回灌它的理由与 §7.4 回灌 proposalJson 相同：让模型做增量修正而不是重抽一版。
   * 但这里给的是结构概要而不是提案 JSON——审核意见里的引文出自概要，
   * 给 JSON 会让模型得自己在两种写法之间做对应，而那一步它经常做错。
   */
  previousOutline: string;
  /** 通过引文闸门的 findings，按判据书写顺序。空数组说明上一轮全被丢弃了 */
  findings: readonly { criterionId: string; quote: string; problem: string }[];
}

export interface StructureContextInput extends ContextBuilderCommonInput {
  operation: 'create_structure';
  retry: StructureRetryInput | null;
  /** R5：审核驱动的重新设计。首次创建结构时为 null */
  review: StructureReviewInput | null;
}

export interface FillSlotRetryInput {
  noSubmission: boolean;
  /**
   * 上次内容校验的失败原因，**已成文的完整中文**（D-19：成文责任在写入方）。
   * 本层原样列出，不解析、不改写。
   */
  reasons: readonly string[];
}

/**
 * R3：返修那一轮的追加上下文（D-31）。
 *
 * 与 `retry` 是**两件事**，不能合并：
 * `retry` 是「上一次提交没过系统的确定性校验」，同一稿的重来；
 * `revision` 是「上一稿已经入库，审核按判据检出了问题」，是下一稿。
 * 一个槽位可能同时处在两者之中（返修轮里又写短了），两段各自成段。
 */
export interface FillSlotRevisionInput {
  /** `slots.revision_round`，从 1 起。只用于「第 n 轮返修」这句话 */
  round: number;
  /**
   * 第 0 … round-1 轮，**按轮次升序，一轮不缺**。
   *
   * D-31 要求同一槽位从首稿到第 N 轮返修是一段连续的对话（「都还在」），
   * 且明确接受「context_json 随轮次增长，最多 3 稿」这个代价。
   * 只带最近一轮会让第 2 轮的 Agent 不知道第 0 轮被指出过什么，
   * 于是它可能在修 S2 的问题时把 S1 的修复改回去——白烧一轮预算。
   */
  priorRounds: readonly PriorRound[];
  /**
   * R6 / D-65：系统已降级，本轮放行整篇提交。
   *
   * **不进 `context_json`**：它是「这一次尝试怎么问」的策略，不是 D-12 那份
   * 语义输入的一部分。放进去会让同一轮的两次尝试算成不同的上下文，
   * 而 contextHash 的含义是「喂给模型的**信息**变没变」，不是「话术变没变」。
   */
  degraded: boolean;
}

export interface FillSlotContextInput extends ContextBuilderCommonInput {
  operation: 'fill_slot';
  /** 全部槽位，用于渲染【结构概要】。含正文的字段本层不读 */
  slots: readonly Slot[];
  targetSlot: Slot;
  /** 目标槽位的类型定义，来自 `snapshot.compiled.slotTypes` */
  slotType: CompiledSlotType;
  dependencies: readonly DependencyContent[];
  retry: FillSlotRetryInput | null;
  /** R3 / D-31：非 null 表示这是返修轮。首稿为 null */
  revision: FillSlotRevisionInput | null;
}

/** R2：审核上下文输入（D-23/D-32） */
export interface ReviewSlotContextInput extends ContextBuilderCommonInput {
  operation: 'review_slot';
  /** 被审槽位 */
  targetSlot: Slot;
  /** 被审槽位类型定义 */
  slotType: CompiledSlotType;
  /** 全部槽位，用于渲染【结构概要】 */
  slots: readonly Slot[];
  dependencies: readonly DependencyContent[];
  /** 本条判据的 ID（= 审核 Skill 的 section ID） */
  criterionId: string;
  /** 待审正文（= 槽位 contentText） */
  contentUnderReview: string;
}

export type ContextBuilderInput = StructureContextInput | FillSlotContextInput | ReviewSlotContextInput;

export interface BuiltAssignmentContext {
  operation: Operation;
  systemText: string;
  userText: string;
  /** `canonicalJson(语义输入)`。落 `executions.context_json`，与 contextHash 逐字对应 */
  contextJson: string;
  contextHash: string;
  promptHash: string;
}

/**
 * D-12 的语义输入。这个 interface 的字段清单就是决议里那份清单，
 * 增删任何一个字段都是在改变「上下文变没变」的判据，改之前先改 D-12。
 */
export interface StructuredContextInput {
  operation: Operation;
  snapshotHash: string;
  /** 保序（见文件头） */
  taskInput: readonly { id: string; value: string }[];
  targetSlotId: string | null;
  slotInstruction: string | null;
  /** 保序 */
  dependencies: readonly DependencyContent[];
  skill: {
    id: string;
    version: string;
    /** 实际注入 System Message 的 section id 列表，不是 Skill 的全部 section */
    injectedSectionIds: readonly string[];
  };
  /** fill_slot 才有；结构提案的限制来自 limits，不属于 validation */
  validation: {
    minChars: number | null;
    maxChars: number | null;
    forbidPattern: string | null;
    forbidPatternFlags: string | null;
    forbidPatternMessage: string | null;
  } | null;
  /**
   * R3 / D-31：返修轮的追加语义输入。**刻意进 contextHash**，与 `retry` 相反。
   *
   * `retry` 不进，因为它回灌的是「同一份输入上次哪里没过」——输入本身没变。
   * `revision` 必须进，因为它就是新的输入：上一轮的对话轮次与审核意见是这一稿
   * 真正多出来的信息，D-31 明写「由它照常参与 context_hash / prompt_hash 计算」。
   * 不进的后果是 `context_json` 与 `context_hash` 不再逐字对应，
   * 「拿库里那一列重算一遍」这句话失效（AC-R-013 靠的正是这一列）。
   *
   * **只记读过的槽位 ID，不记它们的正文**（FR-CTX-005）：正文已经在
   * `dependencies` 里了，那一份是装配时从库里现取的，是唯一的真相来源。
   */
  revision: {
    round: number;
    /** 第 0 … round-1 轮，升序。数组本身随轮次增长，D-31 的代价一节已接受 */
    priorRounds: readonly {
      visibleOutput: string;
      readSlotIds: readonly string[];
      submittedContent: string;
      findings: readonly RawFinding[];
    }[];
  } | null;
}

// ---------------------------------------------------------------------------
// 文本片段
// ---------------------------------------------------------------------------

/**
 * 【平台边界】段（§7.4 逐字）。
 *
 * 这四句是 REQ §5.5「Agent 不得自行宣布任务完成」在 prompt 层的落点。
 * 它不是唯一的防线（真正的防线是 D-11 的闸门与 D-10 的条件 UPDATE），
 * 但少了它，模型会花掉大量 token 去尝试它根本没有的能力。
 */
const PLATFORM_BOUNDARY = [
  '【平台边界】',
  '你是 Forge Core 内容生产平台上的一个 Agent。',
  '你的产出通过工具提交，系统负责保存、推进状态和组装产物。',
  '你不能宣布任务完成，不能修改系统状态，不能选择自己的工作对象。',
].join('\n');

const STRUCTURE_TOOLS = [
  '【工具】',
  'read_task_input     读取冻结的任务输入',
  'read_skill_section  按 Section ID 读取本 Skill 的其他章节',
  'report_work         发布可公开的工作说明（不影响产出，用于让用户看到你的思路）',
  'complete_assignment 唯一的正式提交动作',
].join('\n');

const FILL_SLOT_TOOLS = [
  '【工具】',
  'read_task_input       读取冻结的任务输入',
  'read_skill_section    按 Section ID 读取本 Skill 的其他章节',
  'read_structure_outline 读取本任务的结构概要',
  'read_slot             读取本槽位显式依赖的槽位正文',
  'report_work           发布可公开的工作说明（不影响产出，用于让用户看到你的思路）',
  'complete_assignment   唯一的正式提交动作',
].join('\n');

const SUBMIT_RULES = [
  '【提交规则】',
  '只有 complete_assignment 会保存结果。',
  '提交后本次工作立即结束，后续输出不会被保存。',
].join('\n');

const STRUCTURE_FORBIDDEN = [
  '【禁止】',
  '不得决定每个槽位使用哪个 Agent 或 Skill——那由模板绑定决定。',
  '不得设置任何槽位或任务的状态。',
  '不得在提交结构的同时撰写正文。',
].join('\n');

const FILL_SLOT_FORBIDDEN = [
  '【禁止】',
  '不得为目标槽位以外的任何槽位撰写内容。',
  '不得设置任何槽位或任务的状态，不得宣布任务完成。',
  '不得读取未在依赖中声明的槽位。',
].join('\n');

/** 段落之间统一空一行。用一个函数而不是各处手写 '\n\n'，免得漏一处让 promptHash 无声漂移 */
function joinBlocks(blocks: readonly (string | null)[]): string {
  return blocks.filter((block): block is string => block !== null && block !== '').join('\n\n');
}

/**
 * 【工作方法】段：Skill 概览 + preamble + requiredSections 全文 + 其余章节目录。
 *
 * 返回值同时给出**实际注入的 section id 列表**——它是 D-12 语义输入的一部分，
 * 必须由渲染方给出而不是调用方另算一份：两处各算一次，迟早出现
 * 「注入了 S3 但 hash 里记的是 S2」这种查无可查的偏差。
 */
function renderSkillBlock(skill: FrozenSkill): { text: string; injectedSectionIds: string[] } {
  const injected: string[] = [];
  const parts: string[] = [`【工作方法】${skill.id} v${skill.version}`, skill.summary];
  if (skill.preamble !== '') parts.push(skill.preamble);

  for (const sectionId of skill.requiredSections) {
    const section = skill.sectionIndex[sectionId];
    // 加载期 `parseSkill` 已保证 requiredSections 都能解析（缺一个即 TEMPLATE_INVALID）。
    // 这里仍判一次是因为本函数吃的是**快照读回来的数据**，而快照来自数据库；
    // 静默跳过会让上下文少一整章而 hash 照样算得出来。
    if (section === undefined) continue;
    injected.push(section.id);
    parts.push(`## ${section.id}${section.title === '' ? '' : `. ${section.title}`}\n${section.content}`);
  }

  const rest = skill.sections.filter((section) => !injected.includes(section.id));
  if (rest.length > 0) {
    parts.push(
      ['其余章节可用 read_skill_section 按需读取：', ...rest.map((s) => `${s.id}  ${s.title}`)].join('\n'),
    );
  }

  return { text: parts.join('\n\n'), injectedSectionIds: injected };
}

function renderIdentity(agent: CompiledAgent): string {
  return ['【你的身份】', `${agent.name} — ${agent.role}`, agent.systemInstruction].join('\n');
}

function renderTaskInput(snapshot: FrozenTaskSnapshot): string {
  const lines = ['【任务输入】（已冻结）'];
  for (const field of snapshot.compiled.inputFields) {
    const value = snapshot.input[field.id];
    // 非必填字段可以没有值。写成「（未填写）」而不是省略整行：
    // 省略会让模型以为这个字段不存在，进而自己编一个。
    lines.push(`${field.label}：${value ?? '（未填写）'}`);
  }
  return lines.join('\n');
}

function formatCharRange(minChars: number | null, maxChars: number | null): string | null {
  if (minChars === null && maxChars === null) return null;
  if (minChars !== null && maxChars !== null) return `${minChars} – ${maxChars}`;
  return minChars !== null ? `不少于 ${minChars}` : `不超过 ${maxChars}`;
}

// ---------------------------------------------------------------------------
// Structure Context（§7.4）
// ---------------------------------------------------------------------------

const STRUCTURE_OUTPUT_CONTRACT = [
  '【输出契约】structure_proposal_v1',
  '调用 complete_assignment，参数形如：',
  '{',
  '  "kind": "structure",',
  '  "rootSlotId": "chapter",',
  '  "slots": [',
  '    { "id": "chapter", "type": "chapter", "parentId": null, "order": 0,',
  '      "instruction": "整章容器", "dependsOn": [] },',
  '    { "id": "opening", "type": "opening", "parentId": "chapter", "order": 1,',
  '      "instruction": "从……切入，建立……", "dependsOn": [] }',
  '  ]',
  '}',
  '',
  '字段说明：',
  '- id：小写字母开头，只含小写字母/数字/下划线，全局唯一',
  '- parentId：根槽位为 null，其余指向已声明的槽位',
  '- order：同一父节点下不可重复',
  '- instruction：这个槽位要完成什么内容目标。内容槽位必填且不可为空',
  '- dependsOn：本槽位开始生产前必须已完成的槽位。只能引用内容承载槽位，不能成环',
].join('\n');

function renderSlotTypeCatalog(slotTypes: readonly CompiledSlotType[]): string {
  const lines = ['【可用槽位类型】'];
  for (const type of slotTypes) {
    const kind = type.contentBearing ? '内容槽位' : '容器槽位';
    const range = formatCharRange(type.validation.minChars, type.validation.maxChars);
    lines.push(`- ${type.id}（${type.name}）：${type.description}`);
    lines.push(`  ${kind}${range === null ? '' : ` · 字数 ${range}`}`);
    for (const item of type.guidance) lines.push(`  · ${item}`);
  }
  return lines.join('\n');
}

/**
 * D-13 的重试追加块。
 *
 * 三段式违规**原样列出**：`[rule] agentHint`。`message` 是给人看的、`agentHint`
 * 是给模型看的可执行修复指令，这里只取后者并保留 rule 标签——
 * 保留标签是为了让模型能识别「上一轮报的还是这一条」。
 * 不做去重、不做截断、不合并同类项：D-13 明确一次给全部。
 */
/**
 * R5：审核检出问题后重新设计结构的追加块。
 *
 * 三条与 `renderStructureRetry` 一致的纪律：逐条列出不合并、原样给引文不改写、
 * 明说「要交完整结构」（系统不保存部分结构）。
 *
 * 一条不同：这里**不印「第 n 次尝试，共 m 次机会」**。那句话说的是失败重试的配额，
 * 而重新设计不是失败——它和填槽的返修一样，走的是 D-26 的返修预算，是另一个数。
 * 两个数印在同一段里，模型会把它们当成同一个，然后在第 2 版就开始「因为快没机会了」
 * 而收敛到保守方案。
 */
function renderStructureReview(review: StructureReviewInput): string {
  const lines = [
    '【上一版结构未通过审核】',
    '',
    `这是第 ${review.round} 次重新设计。你上一版的结构是：`,
    '',
    review.previousOutline,
    '',
  ];

  if (review.findings.length === 0) {
    // 走得到：上一轮全部 finding 都没通过引文闸门（verdict 降级为 discarded）
    // 却仍然结算为返修的情形不存在——但审核行可能因整树替换而读不到。
    // 与其编一段「审核说你哪里不好」，不如说清楚现在的处境。
    lines.push('审核认为这一版需要重新设计，但具体意见没有保留下来。');
  } else {
    lines.push('审核逐条指出的问题如下，每一条都附了它引用的原文：', '');
    review.findings.forEach((finding, index) => {
      lines.push(`${index + 1}. [${finding.criterionId}] ${finding.problem}`, `   引用：${finding.quote}`);
    });
  }

  lines.push(
    '',
    '请针对上述问题重新设计整棵结构并提交。没有被指出问题的部分可以保留。',
    '系统不保存部分结构，本次需要提交全部槽位。',
  );
  return lines.join('\n');
}

function renderStructureRetry(retry: StructureRetryInput, attempt: number, maxAttempts: number): string {
  if (retry.noSubmission) {
    return [
      '【上一次未产出结果】',
      '你上一次的工作没有调用 complete_assignment，因此没有任何内容被保存。',
      '请在完成思考后，务必调用 complete_assignment 提交结果。',
      '',
      `这是第 ${attempt} 次尝试，共 ${maxAttempts} 次机会。`,
    ].join('\n');
  }

  const lines = ['【上一次提交未通过校验】'];
  if (retry.previousProposalJson !== null) {
    lines.push('', '你上次提交的结构：', retry.previousProposalJson);
  }
  lines.push('', '系统校验发现以下问题：', '');
  retry.violations.forEach((violation, index) => {
    lines.push(`${index + 1}. [${violation.rule}] ${violation.agentHint}`);
  });
  lines.push(
    '',
    '请修正后重新提交完整结构。系统不保存部分结构，本次需要提交全部槽位。',
    `这是第 ${attempt} 次尝试，共 ${maxAttempts} 次机会。`,
  );
  return lines.join('\n');
}

function buildStructureTexts(input: StructureContextInput): {
  systemText: string;
  userText: string;
  injectedSectionIds: string[];
} {
  const skillBlock = renderSkillBlock(input.skill);
  const { limits } = input.snapshot.compiled;

  const systemText = joinBlocks([
    PLATFORM_BOUNDARY,
    renderIdentity(input.agent),
    ['【当前工作】', 'Operation: create_structure', '你需要为本次任务设计具体的内容结构。'].join('\n'),
    skillBlock.text,
    STRUCTURE_TOOLS,
    SUBMIT_RULES,
    STRUCTURE_FORBIDDEN,
  ]);

  const userText = joinBlocks([
    renderTaskInput(input.snapshot),
    renderSlotTypeCatalog(input.snapshot.compiled.slotTypes),
    [
      '【结构限制】',
      `最多 ${limits.maxSlots} 个槽位`,
      `最大层级深度 ${limits.maxStructureDepth}`,
      '必须恰好一个根槽位，且根槽位必须是容器类型',
      '至少一个内容承载槽位',
    ].join('\n'),
    STRUCTURE_OUTPUT_CONTRACT,
    // 审核意见排在确定性校验之前：两者都在时，前者说的是「这棵树规划得不对」，
    // 后者说的是「这次提交的 JSON 有形式问题」。先看该往哪个方向重新设计，
    // 再看这一版哪里写错了。
    input.review === null ? null : renderStructureReview(input.review),
    input.retry === null ? null : renderStructureRetry(input.retry, input.attemptNumber, input.maxAttempts),
  ]);

  return { systemText, userText, injectedSectionIds: skillBlock.injectedSectionIds };
}

// ---------------------------------------------------------------------------
// Fill Slot Context（§7.4）
// ---------------------------------------------------------------------------

const SLOT_STATUS_LABEL: Record<Slot['status'], string> = {
  pending: '等待',
  running: '生成中',
  reviewing: '审核中',
  completed: '已完成',
  failed: '失败',
};

/**
 * 【结构概要】的树形文本。
 *
 * §7.4 明确用树形字符文本而非 JSON：模型对缩进树的空间理解优于嵌套 JSON，token 也更省。
 * 顺序必须与 `documentOrder` 一致——那是系统真正的调度顺序，
 * 给模型看另一种顺序会让它对「谁在我前面」形成错误认知。
 *
 * 不含任何槽位正文（FR-CTX-003）：正文只通过【依赖槽位内容】按依赖声明给出。
 *
 * ## 为什么带 instruction
 *
 * 合并 outline 之前，「后面还要发生什么」这件事由一个独立的章节骨架槽位提供，
 * 挂成每个场景的依赖。骨架并进结构生成之后，那份横向视野的唯一去处就是
 * 每个槽位的 `instruction`——不渲染出来，场景二就只能看见场景一的正文，
 * 对场景三一无所知，写出来的东西没法给后面留口子。
 *
 * `instruction` 是**规划**不是正文，所以它不受依赖白名单约束：
 * 让场景二看见场景三的计划没有问题，让它看见场景三的正文才有问题
 * （那会让它去衔接一段还不存在、且将来可能被改写的文字）。
 * 与 `read_structure_outline` 工具的判断同源，理由写在那个文件里。
 */
export function renderStructureOutline(slots: readonly Slot[], targetSlotId: string): string {
  const byId = new Map<string, Slot>();
  for (const slot of slots) if (!byId.has(slot.slotId)) byId.set(slot.slotId, slot);

  const childrenOf = new Map<string | null, Slot[]>();
  for (const slot of slots) {
    const key = slot.parentId !== null && byId.has(slot.parentId) ? slot.parentId : null;
    const bucket = childrenOf.get(key);
    if (bucket === undefined) childrenOf.set(key, [slot]);
    else bucket.push(slot);
  }
  // 复用 readiness 的同级比较器，而不是自己再排一次：
  // 「产物顺序 / 调度顺序 / 模型看到的顺序」三者分叉是查起来最费劲的一类 bug。
  for (const bucket of childrenOf.values()) bucket.sort(compareSiblings);

  const lines: string[] = [];
  const visited = new Set<string>();

  const label = (slot: Slot): string => {
    const kind = slot.contentBearing ? '' : ' [容器]';
    if (slot.slotId === targetSlotId) return `${slot.slotId}${kind} [← 当前槽位]`;
    const status = ` [${SLOT_STATUS_LABEL[slot.status]}]`;
    const deps = slot.dependsOn.length === 0 ? '' : `  依赖: ${slot.dependsOn.join('、')}`;
    return `${slot.slotId}${kind}${status}${deps}`;
  };

  const walk = (slot: Slot, prefix: string, isLast: boolean, depth: number): void => {
    if (visited.has(slot.slotId)) return;
    visited.add(slot.slotId);
    const branch = depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
    lines.push(`${prefix}${branch}${label(slot)}`);
    const children = childrenOf.get(slot.slotId) ?? [];
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ');
    // 目标另起一行、缩进到子节点那一列：instruction 是成段的中文，跟在标记后面
    // 会把那一行撑到几百字符，树形结构靠列对齐传达的层级就全毁了。
    // 容器不产出内容，它的 instruction 对下游没有可执行含义，不渲染。
    if (slot.contentBearing && slot.instruction.trim() !== '') {
      lines.push(`${childPrefix}   目标：${slot.instruction.replace(/\s*\n\s*/g, ' ').trim()}`);
    }
    children.forEach((child, index) => {
      walk(child, childPrefix, index === children.length - 1, depth + 1);
    });
  };

  const roots = childrenOf.get(null) ?? [];
  roots.forEach((root, index) => {
    walk(root, '', index === roots.length - 1, 0);
  });

  // 父子成环的槽位到不了任何根。少列一个槽位表现为「模型不知道它前面还有东西」，
  // 因此按 documentOrder 的兜底顺序补齐，与 readiness 的处理保持一致。
  for (const slot of documentOrder(slots)) {
    if (visited.has(slot.slotId)) continue;
    visited.add(slot.slotId);
    lines.push(label(slot));
  }

  return ['【结构概要】', '（只含 id / 类型 / 层级 / 状态 / 依赖，不含正文）', ...lines].join('\n');
}

function renderDependencies(dependencies: readonly DependencyContent[]): string {
  if (dependencies.length === 0) {
    return [
      '【依赖槽位内容】',
      '本槽位没有声明任何依赖，因此没有上游正文可读。',
    ].join('\n');
  }
  const lines = [
    '【依赖槽位内容】',
    '以下是本槽位显式声明依赖的槽位的正文。其他槽位的正文不在你的上下文中。',
  ];
  for (const dependency of dependencies) {
    lines.push('', `── ${dependency.slotId} ──`, dependency.content);
  }
  return lines.join('\n');
}

function renderFillSlotRetry(retry: FillSlotRetryInput, attempt: number, maxAttempts: number): string {
  if (retry.noSubmission) {
    return [
      '【上一次未产出结果】',
      '你上一次的工作没有调用 complete_assignment，因此没有任何内容被保存。',
      '请在完成思考后，务必调用 complete_assignment 提交结果。',
      '',
      `这是第 ${attempt} 次尝试，共 ${maxAttempts} 次机会。`,
    ].join('\n');
  }
  const lines = ['【上一次提交未通过校验】', ''];
  retry.reasons.forEach((reason, index) => {
    lines.push(`${index + 1}. ${reason}`);
  });
  lines.push('', '请修正后重新提交完整正文。', `这是第 ${attempt} 次尝试，共 ${maxAttempts} 次机会。`);
  return lines.join('\n');
}

/**
 * R3：返修段（D-31）。**每一轮一段，第 0 轮起，一轮不缺。**
 *
 * ## 依赖槽位只列 ID，正文不重复渲染
 *
 * `renderRevisionContext` 的第二个参数在这里恒为**空 Map**，因此它不渲染
 * 「依赖槽位内容」那一节。依赖正文在同一条 User Message 里已经由
 * `renderDependencies` 完整渲染过一遍了（而且那一份是调度器刚从库里读出来的，
 * 是唯一的真相来源）。把它再印一遍既撑大 prompt，又制造了两个看起来平级的版本。
 *
 * 「上一轮读过哪些槽位」这条信息（D-31 第 2 项）仍然保留，只是改成列 ID 并
 * 指回上面那一段——这也正是把 slotId 记进 trace 的代价所换来的东西。
 *
 * 措辞受 D-30 约束：只说「检出的问题」，不说「审核通过 / 质量合格 / 已校验」。
 */
const NO_DEPENDENCY_CONTENTS: ReadonlyMap<string, string> = new Map();

/**
 * R6 / D-61：返修提交编辑清单的约定。
 *
 * **它取代的那两句话是被实测证伪的**：原文写着「未被指出问题的部分保持原样，
 * 然后提交完整正文」，而实测里同一次返修改动了 72.8% 的正文
 * （`probe/revision-granularity.py`），27 条被检出的缺陷里 5 条是返修自己写出来的
 * （`probe/finding-origin.py`）。与 R0.5 的强制对账实验是同一个教训：
 * **把话说重救不回来**，只能靠机制。
 *
 * 这份文本本身经过重放验证（`probe/edit-contract-replay.ts`，10 次历史返修，
 * prompt 由本函数生成且 contextHash 与库里 10/10 对账通过）：
 * 8 次产出的清单**逐字对不上 0 条、不唯一 0 条、超过半篇 0 条**。
 * 改这段文字之前先看那份结果，它是这段措辞唯一的依据。
 */
const EDIT_LIST_CONTRACT = [
  '请针对尚未解决的问题定点修改。**这一轮不提交完整正文，提交一份编辑清单。**',
  '',
  '调用 complete_assignment，参数形如：',
  '{"kind":"slot_edits","edits":[{"oldText":"要被替换掉的原文","newText":"替换成什么"}]}',
  '',
  '规则：',
  '1. oldText 必须**逐字**出现在上一轮那份正文里，一个字都不能差（标点、语气词都算）。',
  '   系统会用代码逐字核对，对不上的整份退回。',
  '2. oldText 必须在正文里**唯一**。可能出现多处时，把它加长到唯一为止。',
  '3. 没有写进清单的段落**原样保留**，不需要你重复一遍。',
  '4. 你可以修改没有被判据点名的地方（比如为了衔接通顺），但**必须把它写成一条编辑**——',
  '   不允许悄悄改动。',
  '5. 一条编辑的 oldText 不得超过上一稿的一半。',
  '',
  '注意：往轮已经改好的地方不要改回去。',
].join('\n');

/**
 * D-65 降级后的约定。**由系统决定何时启用，不由模型自选。**
 *
 * 实测里模型一次都没主动走过整篇退路——两次失败一次是吐非法 JSON、
 * 一次是连吐 4 轮到长度上限也不提交。而且那两次恰好是历史上附带改动
 * 最高的两次（72.8%、42.2%）：**「想整篇重写」的场合，正是编辑清单最难产出的场合。**
 * 不给系统降级，这两种在生产里就是执行失败 → 重试 → 白烧一轮返修预算，
 * 最终撞上 D-26 那条铁律要防的东西。
 */
const DEGRADED_CONTRACT = [
  '请针对尚未解决的问题定点修改，未被指出问题的部分保持原样。',
  '这一轮**可以**提交完整正文（kind 为 "slot_content"），也可以继续提交编辑清单。',
  '注意：往轮已经改好的地方不要改回去。',
].join('\n');

function renderFillSlotRevision(revision: FillSlotRevisionInput): string {
  const blocks: string[] = [
    `【返修】第 ${revision.round} 轮`,
    '这一稿由你自己接着改：下面按轮次列出你每一轮的工作过程、当轮提交的正文，以及按判据检出的问题。',
    revision.degraded ? DEGRADED_CONTRACT : EDIT_LIST_CONTRACT,
  ];

  revision.priorRounds.forEach((prior, round) => {
    blocks.push('', `── 第 ${round} 轮 ──`);
    if (prior.readSlotIds.length > 0) {
      // 只列 ID，正文指回上面的【依赖槽位内容】——不在这里印第二遍
      blocks.push(
        `你这一轮读过的依赖槽位：${prior.readSlotIds.join('、')}（正文见上面的【依赖槽位内容】）`,
      );
    }
    blocks.push(renderRevisionContext(prior, NO_DEPENDENCY_CONTENTS));
  });

  return blocks.join('\n');
}

function buildFillSlotTexts(input: FillSlotContextInput): {
  systemText: string;
  userText: string;
  injectedSectionIds: string[];
} {
  const skillBlock = renderSkillBlock(input.skill);
  const { targetSlot, slotType } = input;

  const systemText = joinBlocks([
    PLATFORM_BOUNDARY,
    renderIdentity(input.agent),
    [
      '【当前工作】',
      'Operation: fill_slot',
      `目标槽位: ${targetSlot.slotId}（${slotType.name}）`,
      '你只能为这一个槽位撰写内容。提交其他槽位的内容会被系统拒绝。',
    ].join('\n'),
    skillBlock.text,
    FILL_SLOT_TOOLS,
    SUBMIT_RULES,
    FILL_SLOT_FORBIDDEN,
  ]);

  const range = formatCharRange(slotType.validation.minChars, slotType.validation.maxChars);
  const limitLines = ['【内容限制】'];
  if (range !== null) limitLines.push(`字数 ${range}`);
  if (slotType.validation.forbidPatternMessage !== null) {
    limitLines.push(slotType.validation.forbidPatternMessage);
  }
  if (limitLines.length === 1) limitLines.push('本槽位没有确定性字数或格式限制。');

  const userText = joinBlocks([
    renderTaskInput(input.snapshot),
    renderStructureOutline(input.slots, targetSlot.slotId),
    ['【本槽位目标】', targetSlot.instruction].join('\n'),
    // D-05：guidance 是「写作要求」，系统不强制，位置紧跟 Slot Instruction 之后
    slotType.guidance.length === 0
      ? null
      : ['【本类型的写作要求】', ...slotType.guidance.map((item) => `- ${item}`)].join('\n'),
    renderDependencies(input.dependencies),
    limitLines.join('\n'),
    [
      '【输出契约】slot_content_v1',
      '调用 complete_assignment：',
      `{ "kind": "slot_content", "slotId": "${targetSlot.slotId}", "content": "……" }`,
      '',
      'content 为本槽位的正文，不要包含槽位标题或编号，不要包含对其他槽位的引用说明。',
    ].join('\n'),
    // 返修段在重试段之前：前者说的是「上一稿要怎么改」，后者说的是
    // 「上一次提交连校验都没过」。后者更近、更急，放在最后一段。
    input.revision === null ? null : renderFillSlotRevision(input.revision),
    input.retry === null ? null : renderFillSlotRetry(input.retry, input.attemptNumber, input.maxAttempts),
  ]);

  return { systemText, userText, injectedSectionIds: skillBlock.injectedSectionIds };
}

// ---------------------------------------------------------------------------
// Review Slot Context（R2：§4.3/D-23/D-32）
// ---------------------------------------------------------------------------

/**
 * R2：审核上下文输出契约（D-23：一条判据一次 execution）。
 *
 * 模型返回 JSON：{ verdict: "no_finding" | "revise", findings: [{ criterionId, quote, problem }] }
 * verdict 含义：no_finding = 未检出问题；revise = 检出问题（需带 findings）。
 * 措辞约束（D-30）：不得出现「审核通过」「质量合格」「已校验」。
 */
const REVIEW_OUTPUT_CONTRACT = [
  '【输出契约】review_result_v1',
  '调用 complete_assignment：',
  '{',
  '  "kind": "review_result",',
  '  "slotId": "<被审槽位ID>",',
  '  "verdict": "no_finding" | "revise",',
  '  "findings": [',
  '    { "criterionId": "<判据ID>", "quote": "<逐字引文>", "problem": "<问题说明>" }',
  '  ]',
  '}',
  '',
  '字段说明：',
  '- verdict: no_finding = 未检出问题；revise = 检出问题',
  '- findings: verdict 为 revise 时必填，每条带一条逐字出自待审正文的引文',
  '- quote 必须逐字出自待审正文，标点允许归一化',
].join('\n');

/**
 * R2：审核上下文渲染（D-23/D-32）。
 *
 * 与 fill_slot 的关键差别：
 * - system prompt 只注入这一条判据的章节文本，不提示还有别的判据（AC-R-002）；
 * - user message 注入待审正文；
 * - 审核 Agent 每轮全新，不携带任何往轮审核记录（D-32）。
 */
function buildReviewSlotTexts(input: ReviewSlotContextInput): {
  systemText: string;
  userText: string;
  injectedSectionIds: string[];
} {
  const { targetSlot, slotType, criterionId, contentUnderReview } = input;

  // AC-R-002：system prompt 只注入这一条判据的章节文本。
  // renderSkillBlock 注入了 requiredSections 的全文 + 其余章节目录。
  // 审核 Skill 的 requiredSections 应只包含本条判据对应的 section（R4 配置）。
  // 但为确保 prompt 绝对不含其他判据文本，这里用 sectionIndex 直接取本条判据的文本，
  // 而不是依赖 requiredSections 的正确配置。
  const criterionSection = input.skill.sectionIndex[criterionId];
  if (criterionSection === undefined) {
    throw new ForgeError(
      'STORAGE_ERROR',
      `审核 Skill「${input.skill.id}」中没有判据（section）「${criterionId}」`,
      `slot:${targetSlot.slotId}`,
    );
  }

  const criterionBlock = `## ${criterionSection.id}${criterionSection.title === '' ? '' : `. ${criterionSection.title}`}\n${criterionSection.content}`;

  const systemText = joinBlocks([
    PLATFORM_BOUNDARY,
    renderIdentity(input.agent),
    [
      '【当前工作】',
      'Operation: review_slot',
      `目标槽位: ${targetSlot.slotId}（${slotType.name}）`,
      `判据: ${criterionId}`,
      // 容器槽位没有正文，被审的是它底下那棵树的规划。说成「本槽位正文」会让模型
      // 去找一段不存在的正文，然后要么空手而归、要么把 instruction 当正文来挑毛病。
      targetSlot.contentBearing
        ? '你只需按上述判据审核本槽位正文，不审其他判据。'
        : '你只需按上述判据审核这棵结构树的规划，不审其他判据；这里还没有任何正文。',
    ].join('\n'),
    // 只注入本条判据文本 + Skill 概览（不含其他判据的 section 全文）
    `【工作方法】${input.skill.id} v${input.skill.version}`,
    input.skill.summary,
    input.skill.preamble === '' ? null : input.skill.preamble,
    criterionBlock,
    FILL_SLOT_TOOLS, // 审核用同一套工具（read_slot 读依赖、read_structure_outline 看结构）
    SUBMIT_RULES,
    REVIEW_OUTPUT_CONTRACT,
  ]);

  /*
   * R5 结构审核：待审的就是那棵树，所以 user message 里**不再另画一遍结构概要**。
   *
   * 这不是省 token，是防一类静默失败。两处渲染的是同一棵树但写法不同
   * （`renderStructureOutline` 用 `├─` 连线且不带 instruction，
   * `contentUnderReview` 用缩进且带 instruction）。两份都摆在模型眼前时，
   * 它完全可能从上面那一份里抄一句当引文——而那一句逐字不出现在下面那一份里。
   * D-11 的闸门会把这条 finding 丢弃，verdict 降级为 `discarded`，
   * 对下游等同「未检出问题」（D-25）。表现是审核看起来什么都没查出来。
   *
   * 【本槽位目标】同样去掉：容器的 instruction 说的是「承载章节结构」这类话，
   * 对判断这棵树规划得好不好没有任何信息量，只是又一段可以被误引的文字。
   */
  const structureReview = !targetSlot.contentBearing;

  const userText = joinBlocks([
    renderTaskInput(input.snapshot),
    structureReview ? null : renderStructureOutline(input.slots, targetSlot.slotId),
    structureReview ? null : ['【本槽位目标】', targetSlot.instruction].join('\n'),
    renderDependencies(input.dependencies),
    structureReview ? '【待审结构】' : '【待审正文】',
    contentUnderReview,
  ]);

  // 只记本条判据的 section ID 进 injectedSectionIds
  return { systemText, userText, injectedSectionIds: [criterionId] };
}

function structuredInputOf(
  input: ContextBuilderInput,
  injectedSectionIds: readonly string[],
): StructuredContextInput {
  const taskInput = input.snapshot.compiled.inputFields.map((field) => ({
    id: field.id,
    // `?? ''` 而不是省略：`canonicalJson` 会把 undefined 值的键整体剔除，
    // 于是「没填这个字段」与「模板根本没这个字段」会哈希成同一个值。
    value: input.snapshot.input[field.id] ?? '',
  }));

  const skill = {
    id: input.skill.id,
    version: input.skill.version,
    injectedSectionIds: [...injectedSectionIds],
  };

  if (input.operation === 'create_structure') {
    return {
      operation: 'create_structure',
      snapshotHash: input.snapshot.snapshotHash,
      taskInput,
      targetSlotId: null,
      slotInstruction: null,
      dependencies: [],
      skill,
      validation: null,
      revision: null,
    };
  }

  // fill_slot 与 review_slot 共享同一套语义输入形状
  return {
    operation: input.operation,
    snapshotHash: input.snapshot.snapshotHash,
    taskInput,
    targetSlotId: input.targetSlot.slotId,
    slotInstruction: input.targetSlot.instruction,
    dependencies: input.dependencies.map((d) => ({ slotId: d.slotId, content: d.content })),
    skill,
    validation: {
      minChars: input.slotType.validation.minChars,
      maxChars: input.slotType.validation.maxChars,
      forbidPattern: input.slotType.validation.forbidPattern,
      forbidPatternFlags: input.slotType.validation.forbidPatternFlags,
      forbidPatternMessage: input.slotType.validation.forbidPatternMessage,
    },
    /**
     * D-32：审核 Agent 每轮全新。`review_slot` 这一支恒为 null，
     * 不是「碰巧没传」——`ReviewSlotContextInput` 里根本没有可以装往轮记录的字段，
     * 于是「审核带上了历史」这件事在类型层就表达不出来（AC-R-016）。
     */
    revision:
      input.operation === 'fill_slot' && input.revision !== null
        ? {
            round: input.revision.round,
            priorRounds: input.revision.priorRounds.map((prior) => ({
              visibleOutput: prior.visibleOutput,
              readSlotIds: [...prior.readSlotIds],
              submittedContent: prior.submittedContent,
              findings: prior.findings.map((f) => ({
                criterionId: f.criterionId,
                quote: f.quote,
                problem: f.problem,
              })),
            })),
          }
        : null,
  };
}

/**
 * 构建一次 Assignment 的上下文。纯函数。
 *
 * `promptHash` 的输入写死为 `systemText + '\n\n' + userText`（D-12 逐字）。
 * 不用 `canonicalHash`：那会先把两段文本包进一个对象再序列化，
 * 于是 hash 的输入多了一层 JSON 转义，与决议里写的式子不再是同一个东西。
 */
export function buildContext(input: ContextBuilderInput): BuiltAssignmentContext {
  const rendered =
    input.operation === 'create_structure'
      ? buildStructureTexts(input)
      : input.operation === 'fill_slot'
        ? buildFillSlotTexts(input)
        : buildReviewSlotTexts(input);

  const contextJson = canonicalJson(structuredInputOf(input, rendered.injectedSectionIds));

  return {
    operation: input.operation,
    systemText: rendered.systemText,
    userText: rendered.userText,
    contextJson,
    // 对着**实际落库的那段文本**取哈希，而不是 canonicalHash(对象) 再序列化一次。
    // 两处各序列化一次，「拿库里那一列重算一遍对不对得上」就不再是一句有意义的话。
    contextHash: sha256Hex(contextJson),
    promptHash: sha256Hex(`${rendered.systemText}\n\n${rendered.userText}`),
  };
}
