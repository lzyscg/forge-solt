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
 * 依赖槽位内容及其顺序、skill id+version+注入的 section id 列表、validation 限制。
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
import type { Slot } from '@server/domain/types.ts';
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

export interface StructureContextInput extends ContextBuilderCommonInput {
  operation: 'create_structure';
  retry: StructureRetryInput | null;
}

export interface FillSlotRetryInput {
  noSubmission: boolean;
  /**
   * 上次内容校验的失败原因，**已成文的完整中文**（D-19：成文责任在写入方）。
   * 本层原样列出，不解析、不改写。
   */
  reasons: readonly string[];
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
}

export type ContextBuilderInput = StructureContextInput | FillSlotContextInput;

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
    input.retry === null ? null : renderFillSlotRetry(input.retry, input.attemptNumber, input.maxAttempts),
  ]);

  return { systemText, userText, injectedSectionIds: skillBlock.injectedSectionIds };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

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
    };
  }

  return {
    operation: 'fill_slot',
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
    input.operation === 'create_structure' ? buildStructureTexts(input) : buildFillSlotTexts(input);

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
