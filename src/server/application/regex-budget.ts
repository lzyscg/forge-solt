/**
 * 用户正则的时间预算闸门（§12.2 M2 完成判据「forbidPattern 超时」）。
 *
 * `template.yaml` 的 `validation.forbidPattern` 是**模板作者手写的正则**，
 * 而它会被拿去跑**模型生成的长文本**。这两件事撞在一起就是灾难性回溯的经典配方：
 * 一个形如 `(\s+)+$` 的模式配上几 KB 正文，会把 Node 的唯一主线程钉死几分钟，
 * 期间整个服务不响应——不是慢，是死。P0 只有一条串行生产线，这等于全站停摆。
 *
 * 因此策略是**加载期拒绝，而不是运行期防御**：模板加载时就用代表性输入
 * 把每个 pattern 跑一遍，超出预算的模板直接判为非法。理由有二：
 * 1. 加载期失败只影响一个模板，运行期失败影响整个进程；
 * 2. 加载期是唯一还能把错误归因到「哪个槽位类型的哪条正则」的时刻，
 *    运行期只会看到一个无栈的挂起。
 *
 * **为什么必须用 worker，不能用「跑之前记时间、跑之后比一下」**：
 * 回溯发生在 V8 的正则引擎内部，`re.test()` 一旦进去就不再回到 JS，
 * 主线程上没有任何检查点能观察到超时。只有把它放进独立线程、
 * 由父线程 `terminate()`（走 V8 的 TerminateExecution 中断）才是真的超时。
 *
 * **为什么不用静态 ReDoS 分析**：需要额外依赖，且指数级回溯的判定本身是
 * 保守近似——会把合法模式误杀，也会漏掉真实的病态模式。直接量一遍实际耗时
 * 既没有误报也不需要依赖，代价只是一次 worker 启动（~30ms，每次模板加载一次）。
 */

import { Worker } from 'node:worker_threads';

/** 待检查的一条正则。`key` 只用于报错定位，形如 `slotType:scene` */
export interface PatternBudgetSpec {
  key: string;
  source: string;
  flags: string;
}

export type PatternBudgetResult =
  | { ok: true }
  | { ok: false; key: string; reason: 'timeout' | 'worker_error'; detail: string };

/**
 * 代表性输入。
 *
 * 选取标准不是「像真实正文」，而是「像**最坏情况**的真实正文」——
 * 病态回溯只在特定形状下爆发，用一段普通中文散文去跑等于没跑。
 * 因此这里同时覆盖三类诱因：
 * - 长同字符游程 + 末尾失配：`(a+)+$` / `(x|x)*y` 这类嵌套量词的引爆点
 * - 长空白游程：`(\s+)+` 与 `^\s*(\S+\s*)*$` 这类「按空白切词」正则的引爆点
 * - 真实形状的 Markdown 正文：保证正常模式（如文档示例的 `(?m)^#{1,6}\s`）
 *   在有代表性长度下确实很快，而不是因为输入太短才通过
 *
 * 长度取 4000 左右：既能让指数级回溯在毫秒预算内明显爆掉，
 * 又不会让线性模式本身耗满预算造成误杀。
 */
export const DEFAULT_PATTERN_SAMPLES: readonly string[] = [
  '',
  'a'.repeat(4000),
  `${'a'.repeat(4000)}!`,
  `${' '.repeat(2000)}\t${' '.repeat(2000)}x`,
  `${'ab'.repeat(2000)}!`,
  `## 小标题\n\n${'她推开门，屋里没有人。'.repeat(200)}\n\n### 又一个标题\n`,
  `${'0123456789'.repeat(400)}\n`,
];

/** 单条正则的默认预算。线性模式跑上面的样本在 1ms 量级，50ms 有两个数量级的余量 */
export const DEFAULT_PATTERN_BUDGET_MS = 50;

/**
 * worker 侧脚本。用 `eval: true` 内联而不是单独建文件：
 * 单独文件在 tsx / vitest / 打包后三种运行方式下路径解析各不相同，
 * 而这段逻辑只有十几行、且必须与父侧的协议逐字对应，放在一起更不容易漂。
 *
 * 协议：每条 pattern 开跑**前**发 `start`、跑完发 `done`。
 * 计时器由父侧在收到 `start` 时启动——这样 worker 的启动耗时不算进预算，
 * 否则慢一点的机器会把所有模板都判成超时。
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { patterns, samples } = workerData;
for (let i = 0; i < patterns.length; i++) {
  parentPort.postMessage({ type: 'start', index: i });
  const re = new RegExp(patterns[i].source, patterns[i].flags);
  for (const sample of samples) {
    re.lastIndex = 0;
    re.test(sample);
  }
  parentPort.postMessage({ type: 'done', index: i });
}
parentPort.postMessage({ type: 'finished' });
`;

interface WorkerMessage {
  type: 'start' | 'done' | 'finished';
  index?: number;
}

/**
 * 按条给定预算跑一遍所有正则，返回第一条超预算的。
 *
 * 注意这里**不返回「跑了多久」**：耗时随机器负载浮动，把它写进错误信息
 * 会让同一个模板在 CI 和本机给出不同的报错文本。判据只有「过 / 不过」。
 *
 * @param specs 已确认可被 `new RegExp` 编译的正则（语法错误应在调用前拦下，
 *              那是另一类模板错误，不该混进超时报告里）
 */
export async function checkPatternBudget(
  specs: readonly PatternBudgetSpec[],
  budgetMs: number = DEFAULT_PATTERN_BUDGET_MS,
  samples: readonly string[] = DEFAULT_PATTERN_SAMPLES,
): Promise<PatternBudgetResult> {
  // 没有正则就不要付 worker 启动的钱——绝大多数模板会走到这条分支
  if (specs.length === 0) return { ok: true };

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { patterns: specs.map((s) => ({ source: s.source, flags: s.flags })), samples },
    // worker 只跑正则，不需要继承父进程的环境变量。
    // 顺带堵死一条泄密路径：API Key 不进入这个线程（REQ §13）。
    env: {},
  });

  try {
    return await new Promise<PatternBudgetResult>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const clear = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };

      worker.on('message', (raw: WorkerMessage) => {
        clear();
        if (raw.type === 'start') {
          const index = raw.index ?? 0;
          timer = setTimeout(() => {
            const spec = specs[index];
            resolve({
              ok: false,
              key: spec?.key ?? `pattern[${index}]`,
              reason: 'timeout',
              detail: spec?.source ?? '',
            });
          }, budgetMs);
          // 计时器不该拖住进程退出：真超时了我们也是靠 terminate 收场
          timer.unref();
        } else if (raw.type === 'finished') {
          resolve({ ok: true });
        }
      });

      worker.on('error', (error: Error) => {
        clear();
        resolve({ ok: false, key: specs[0]?.key ?? '', reason: 'worker_error', detail: error.message });
      });

      worker.on('exit', (code) => {
        clear();
        // 正常路径上 `finished` 已经 resolve 过了，这里的 resolve 是空操作；
        // 只有 worker 被外力杀掉（OOM 等）才会由这一条兜底，避免 Promise 永远挂着。
        resolve({ ok: false, key: specs[0]?.key ?? '', reason: 'worker_error', detail: `worker 退出码 ${code}` });
      });
    });
  } finally {
    // 无论超时、出错还是正常结束都要收线程。
    // 正常结束时 worker 已自行退出，terminate 是幂等的空操作。
    await worker.terminate();
  }
}
