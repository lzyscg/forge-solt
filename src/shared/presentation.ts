/**
 * 基础词表（文档 §3.1 / D-07）。
 *
 * 这一层存在的理由：状态机的值（running / pending）是给引擎用的，不是给人看的。
 * 前端如果直接对状态机字符串做 switch 取色取文案，业务语义就会散落在多个组件里，
 * 且后端加一个状态前端必然漏改。因此由后端显式返回「语气 + 状态词 + 事实」三段式，
 * 前端只做渲染。
 */

import { z } from 'zod';

/**
 * 语气分类：驱动前端取色，与状态机值解耦（HANDOFF README 约定）。
 * 之所以独立于 status，是因为同一状态机值在不同上下文下语气不同——
 * 例如 running + attempt>1 是 warn 而不是 run。
 */
export const ToneSchema = z.enum([
  'idle', // 中性静止：Ready / Stopped
  'run', // 运行中：脉冲圆点
  'wait', // 等待：等待依赖 / 排队中
  'warn', // 异常但属正常流程：超时重试 / 限流退避
  'ok', // 完成
  'fail', // 失败：唯一使用 danger 色的分类
  'container', // 容器槽位：方形标记
]);
export type Tone = z.infer<typeof ToneSchema>;

/** 全部语气取值，供前端穷举渲染（如状态图例）与测试遍历使用 */
export const TONES = ToneSchema.options;

/**
 * 三段式业务化描述，见 D-07。
 * 派生逻辑集中在 domain/presentation.ts 的纯函数里，DTO 层只搬运不判断——
 * 这样全部状态组合可以被单元测试穷举覆盖（附录 B）。
 */
export const PresentationSchema = z.object({
  tone: ToneSchema,
  /** 业务化状态文字，如「正在填充 Slot」。不是状态机枚举 */
  state: z.string(),
  /** 可判断的业务事实，如「scene_2 场景正文生成中」。不是日志行 */
  detail: z.string(),
});
export type Presentation = z.infer<typeof PresentationSchema>;
