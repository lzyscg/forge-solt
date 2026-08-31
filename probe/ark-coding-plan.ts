/**
 * 火山方舟 Coding Plan 接入前的实打验证。
 *
 * ── 为什么必须先跑这个，而不是直接写 providers.yaml ──────────────
 *
 * `config/providers.yaml` 的注释里写着（用血换来的）：models 列表只过加载期的
 * 格式校验，**不校验这个模型在上游走哪条路由**。写错要到运行期才失败，
 * 那时烧掉的是一次真实 Assignment。所以顺序永远是先实打、后配置。
 *
 * ── 它要答的四个问题 ──────────────────────────────────────────
 *
 * 1. `/api/coding/v3/chat/completions` 通不通、鉴权对不对；
 * 2. **tool_calls 能不能用**——这是生死线。本引擎没有任何一处从自由文本里
 *    解析结果，结构树、正文、审核裁决全部经 `complete_assignment` 工具提交。
 *    不支持 function calling 的套餐，再便宜也一个字都跑不出来；
 * 3. 流式分片里 `arguments` 增量**拼不拼得起来**（多参数、含中文、含换行）；
 * 4. **吞吐**。OpenCode Go 就是栽在这：单章 85.6s → 1370s（约 23 分钟）。
 *    套餐制普遍拿速度换价格，而下一阶段是 Skill 迭代，慢会直接拖垮节奏。
 *    这个数必须在接进来之前就知道。
 *
 * ── 为什么挂 onDroppedChunk ───────────────────────────────────
 *
 * `openai-compatible.ts` 里那个钩子是上次事故后补的机制：OpenCode Go 回
 * `"name": null`，schema 接不住，于是每个续传分片连同 arguments 碎片被整片丢掉，
 * **不报错、不计数、不留痕**，上层表现酷似「模型能力不行」。
 * 火山方舟正是「下一个 Provider」，它的下一个字段差异会以同样方式静默丢数据。
 * 这里把丢弃汇总打进结果，有信号才有得查。
 *
 * ── 安全 ──────────────────────────────────────────────────────
 *
 * Key 只从 process.env.ARK_API_KEY 读，只进 Authorization 头。
 * 不打印、不写进结果 JSON（REQ §13 / NFR-005）。
 *
 * 用法：
 *   npx tsx --env-file=.env probe/ark-coding-plan.ts
 *   npx tsx --env-file=.env probe/ark-coding-plan.ts --model glm-5.3
 */

import { writeFileSync } from 'node:fs';
import { OpenAiCompatibleAdapter, type DroppedChunkSummary } from '../src/server/runtime/provider/openai-compatible.ts';
import type { ProviderToolCall, ProviderToolDefinition } from '../src/server/runtime/provider/provider-adapter.ts';

/**
 * 文档原文：「兼容 OpenAI 接口协议工具：https://ark.cn-beijing.volces.com/api/coding/v3」
 *
 * ⚠️ 绝不能写成 https://ark.cn-beijing.volces.com/api/v3。文档原文：
 *    「请勿使用 …/api/v3：该 Base URL 不会消耗您的 Coding Plan 额度，
 *      而是会产生额外费用。」
 *
 *    这与 OpenCode 的 /zen/v1 vs /zen/go/v1 是同一类陷阱，但更阴：
 *    OpenCode 打错会回 401「余额不足」，吵得很大声；
 *    火山打错**不报错、照常返回、账单另算**，除非对账否则跑几周都发现不了。
 */
const BASE_URL_REF = { value: 'https://ark.cn-beijing.volces.com/api/coding/v3' };

/** Coding Plan 套餐覆盖的 Model Name（文档「模型配置」一节照录） */
const PLAN_MODELS = [
  'deepseek-v4-flash', // ← 我们当前在跑的就是它（官方 deepseek-chat 解析到这个）
  'deepseek-v4-pro',
  'glm-5.3',
  'glm-5.3-flash',
  'kimi-k2.7-code',
  'minimax-m3',
  'doubao-seed-evolving',
  'doubao-seed-2.1-turbo',
  'doubao-seed-2.0-lite',
] as const;

/**
 * 刻意做成「多参数 + 中文 + 换行 + 嵌套数组」的形状。
 *
 * 无参工具能成功、有参工具失败，正是上次 OpenCode 事故的表现分布。
 * 只测无参工具等于把那个 bug 的检出概率归零。
 */
const PROBE_TOOL: ProviderToolDefinition = {
  name: 'complete_assignment' as ProviderToolDefinition['name'],
  description: '提交本次任务的产出。必须调用它来结束任务，不要把结果写在正文里。',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['slot_edits'], description: '固定填 slot_edits' },
      slotId: { type: 'string', description: '槽位 id' },
      edits: {
        type: 'array',
        description: '定点编辑清单',
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: '要被替换的原文，必须逐字出现在正文中' },
            newText: { type: 'string', description: '替换后的文本' },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['kind', 'slotId', 'edits'],
  },
};

const SYSTEM = '你负责按指令提交结构化产出。你必须通过调用 complete_assignment 工具来提交，不要把结果写在回复正文里。';

/** 让模型必须产出含中文、含换行、多条目的 arguments —— 增量拼接最容易在这里裂开 */
const USER = `下面是一段正文：

走廊尽头那台呼叫铃每隔几秒响一声，响了很久了。
赵敏心里觉得很累，她想着这已经是第三个夜班了。
小林很紧张，她害怕自己出错。

审核检出两处「用心理解释代替可见行动」的问题：
1. 「赵敏心里觉得很累，她想着这已经是第三个夜班了。」
2. 「小林很紧张，她害怕自己出错。」

请把这两处各改写成可见的动作描写，然后调用 complete_assignment 提交编辑清单。
slotId 填 scene_er，kind 填 slot_edits。
oldText 必须逐字抄录上面被指出的原句，一个字都不能差。`;

interface ProbeResult {
  model: string;
  ok: boolean;
  error?: string;
  stopReason?: string;
  /**
   * 从发起请求到第一个**回调**触发。注意：模型只发工具调用、不发正文时（本探针的
   * 常态），onToolCall 是在流读完之后才触发的，此时这个数≈totalMs，
   * **它不是首字延迟**。真正的首帧时间看 frames.firstFrameMs。
   */
  firstCallbackMs?: number;
  totalMs?: number;
  /** SSE 帧统计。toolCallFrames > 1 才证明 arguments 是增量下发并被拼装的 */
  frames?: FrameStats;
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** 吞吐：输出 token / 秒。与 OpenCode Go 实测的 ~14.5 字/秒 对照 */
  outputTokensPerSec?: number;
  toolCall?: {
    name: string;
    /** arguments 原样落盘，用来肉眼验证增量拼接没裂 */
    argumentsJson: string;
    parsed: boolean;
    parseError?: string;
    /** 结构是否符合预期：kind/slotId/edits 齐不齐 */
    shapeOk?: boolean;
    editCount?: number;
    /** oldText 是否逐字命中原文 —— D-62 那条契约在这个模型上成不成立 */
    verbatimHits?: number;
  };
  droppedChunks?: {
    droppedFrames: number;
    reasons: Record<string, number>;
  };
  textLength: number;
}

const ORIGINAL_LINES = [
  '赵敏心里觉得很累，她想着这已经是第三个夜班了。',
  '小林很紧张，她害怕自己出错。',
];

/**
 * 数 SSE 帧，顺便拿到**真正的**首帧时间。
 *
 * 不这么做就答不了「arguments 增量拼不拼得起来」：若上游一帧把整个 tool call
 * 发下来，我们的增量拼接路径根本没被走到，测了等于没测——而 OpenCode 那次事故
 * 恰恰就藏在这条路径里。tee 一路出来数，不碰生产代码。
 */
interface FrameStats {
  /** data: 开头的 SSE 帧总数 */
  frames: number;
  /** 其中带 tool_calls 增量的帧数。>1 才说明真的在增量下发 */
  toolCallFrames: number;
  /** 从发起请求到第一帧落地 */
  firstFrameMs?: number;
}

function countingFetch(stats: FrameStats, startedAt: () => number): typeof fetch {
  return async (input, init) => {
    const res = await globalThis.fetch(input as RequestInfo, init as RequestInit);
    if (!res.body) return res;
    const [a, b] = res.body.tee();
    void (async () => {
      const reader = b.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            stats.frames += 1;
            stats.firstFrameMs ??= Date.now() - startedAt();
            if (line.includes('tool_calls')) stats.toolCallFrames += 1;
          }
        }
      } catch {
        /* 计数失败不影响主流程 */
      }
    })();
    return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

async function probeModel(model: string, apiKey: string): Promise<ProbeResult> {
  let dropped: DroppedChunkSummary | null = null;
  const frameStats: FrameStats = { frames: 0, toolCallFrames: 0 };
  let requestStartedAt = Date.now();

  const adapter = new OpenAiCompatibleAdapter({
    baseUrl: BASE_URL_REF.value,
    providerId: 'volcengine-ark-coding',
    fetchImpl: countingFetch(frameStats, () => requestStartedAt),
    onDroppedChunk: (info) => {
      dropped = info;
    },
  });

  const started = Date.now();
  requestStartedAt = started;
  let firstDeltaAt: number | null = null;
  let text = '';
  let captured: ProviderToolCall | null = null;

  const markFirst = () => {
    firstDeltaAt ??= Date.now();
  };

  try {
    const turn = await adapter.runTurn({
      model,
      apiKey,
      system: SYSTEM,
      messages: [{ role: 'user', content: USER }],
      tools: [PROBE_TOOL],
      maxTokens: 4096,
      signal: AbortSignal.timeout(300_000),
      onTextDelta: (d) => {
        markFirst();
        text += d;
      },
      onToolCall: async (call) => {
        markFirst();
        captured = call;
        // 探针不真的执行工具，回一个成功结果让本轮干净收尾
        return { toolCallId: call.id, content: '已收到', isError: false };
      },
    });

    const totalMs = Date.now() - started;
    const result: ProbeResult = {
      model,
      ok: false,
      stopReason: turn.stopReason,
      firstCallbackMs: firstDeltaAt ? firstDeltaAt - started : undefined,
      totalMs,
      frames: { ...frameStats },
      usage: turn.usage,
      textLength: text.length,
    };

    if (turn.usage && totalMs > 0) {
      result.outputTokensPerSec = Number(((turn.usage.outputTokens / totalMs) * 1000).toFixed(1));
    }

    if (dropped) {
      const d = dropped as DroppedChunkSummary;
      result.droppedChunks = {
        droppedFrames: d.droppedFrames,
        reasons: Object.fromEntries(d.reasons),
      };
    }

    if (captured) {
      const call = captured as ProviderToolCall;
      const tc: NonNullable<ProbeResult['toolCall']> = {
        name: call.name,
        argumentsJson: call.argumentsJson,
        parsed: false,
      };
      try {
        const parsed = JSON.parse(call.argumentsJson) as Record<string, unknown>;
        tc.parsed = true;
        const edits = parsed.edits;
        tc.shapeOk =
          parsed.kind === 'slot_edits' && typeof parsed.slotId === 'string' && Array.isArray(edits);
        if (Array.isArray(edits)) {
          tc.editCount = edits.length;
          // D-62：oldText 必须逐字命中。这里直接量它在这个模型上成不成立
          tc.verbatimHits = edits.filter(
            (e) =>
              e != null &&
              typeof (e as { oldText?: unknown }).oldText === 'string' &&
              ORIGINAL_LINES.some((line) => (e as { oldText: string }).oldText.includes(line.slice(0, 12))),
          ).length;
        }
      } catch (err) {
        tc.parseError = err instanceof Error ? err.message : String(err);
      }
      result.toolCall = tc;
      // 判定「可用」的门槛：发起了工具调用、arguments 解析得了、形状对
      result.ok = tc.parsed && tc.shapeOk === true;
    }

    return result;
  } catch (err) {
    return {
      model,
      ok: false,
      // 适配器保证 Key 不进 error message，这里原样透出
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      totalMs: Date.now() - started,
      textLength: text.length,
    };
  }
}

async function main(): Promise<void> {
  // --baseline：拿同一份 prompt 打 DeepSeek 官方，给「快了还是慢了」一个可比的数。
  // 不做这个，Ark 的 tok/s 就是个孤零零的数字，没法回答换不换。
  const baseline = process.argv.includes('--baseline');
  const keyEnv = baseline ? 'DEEPSEEK_API_KEY' : 'ARK_API_KEY';
  const apiKey = process.env[keyEnv];
  if (!apiKey) {
    console.error(`缺少 ${keyEnv}。请在 .env 里配置后用 --env-file=.env 运行。`);
    process.exit(1);
  }
  if (baseline) {
    BASE_URL_REF.value = 'https://api.deepseek.com/v1';
  }

  const onlyIdx = process.argv.indexOf('--model');
  const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : undefined;
  const models = only ? [only] : baseline ? ['deepseek-chat'] : [...PLAN_MODELS];

  console.log(`baseUrl: ${BASE_URL_REF.value}`);
  console.log(`待测模型 ${models.length} 个：${models.join(', ')}\n`);

  const results: ProbeResult[] = [];
  for (const model of models) {
    process.stdout.write(`[${model}] 打一次 tool call … `);
    const r = await probeModel(model, apiKey);
    results.push(r);
    if (r.ok) {
      console.log(
        `✅ ${r.totalMs}ms · 首帧 ${r.frames?.firstFrameMs ?? '?'}ms · ` +
          `${r.usage?.outputTokens ?? '?'} out · ${r.outputTokensPerSec ?? '?'} tok/s · ` +
          `帧 ${r.frames?.frames ?? '?'}(工具 ${r.frames?.toolCallFrames ?? '?'}) · ` +
          `${r.toolCall?.editCount ?? 0} 条编辑 · 逐字命中 ${r.toolCall?.verbatimHits ?? 0}`,
      );
    } else {
      console.log(`❌ ${r.error ?? `stopReason=${r.stopReason} 未产出合格的 tool call`}`);
    }
    if (r.droppedChunks && r.droppedChunks.droppedFrames > 0) {
      console.log(`   ⚠️ 丢弃分片 ${r.droppedChunks.droppedFrames} 个：`, r.droppedChunks.reasons);
    }
  }

  // 输出文件名随运行模式变化。
  // 血的教训（这个坑踩过两次）：子集重跑写回同一个路径，会把整跑的结果**静默冲掉**，
  // 而整跑是花了钱的、子集不是。文件名带上模式，子集就永远盖不住整跑。
  const out = baseline
    ? 'probe/results-ark-baseline-deepseek.json'
    : only
      ? `probe/results-ark-single-${only}.json`
      : 'probe/results-ark-coding-plan.json';
  writeFileSync(out, JSON.stringify({ baseUrl: BASE_URL_REF.value, at: new Date().toISOString(), results }, null, 2));
  console.log(`\n结果已写入 ${out}`);

  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n可用 ${okCount}/${results.length}`);
}

await main();
