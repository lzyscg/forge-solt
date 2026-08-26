import { describe, expect, it } from 'vitest';
import type { PriorRound, RawAssistantTurn } from './revision-context.ts';
import { renderRevisionContext, stripReasoning } from './revision-context.ts';
import type { RawFinding } from './review-evidence.ts';

describe('返修上下文装配（D-31）', () => {
  describe('stripReasoning（AC-R-014）', () => {
    it('剥离隐藏推理字段，只保留可见内容', () => {
      const turn: RawAssistantTurn = {
        content: '可见内容',
        reasoningContent: '隐藏推理',
      };
      expect(stripReasoning(turn)).toBe('可见内容');
    });

    it('无 reasoningContent 字段时正常返回可见内容', () => {
      const turn: RawAssistantTurn = {
        content: '可见内容',
      };
      expect(stripReasoning(turn)).toBe('可见内容');
    });
  });

  describe('renderRevisionContext', () => {
    it('确定性：同一输入逐字同输出', () => {
      const prior: PriorRound = {
        visibleOutput: '上一轮输出',
        readSlotIds: ['slot_01'],
        submittedContent: '上一稿正文',
        findings: [{ criterionId: 'S1', quote: '引文', problem: '问题说明' }],
      };
      const deps = new Map([['slot_01', '依赖内容']]);
      const result1 = renderRevisionContext(prior, deps);
      const result2 = renderRevisionContext(prior, deps);
      expect(result1).toBe(result2);
    });

    // 补 2：D-31「可复现」真正要守的属性——输出顺序只由 readSlotIds 决定，
    // 不依赖 dependencyContents 的 Map 插入顺序。若实现改成遍历 Map entries，
    // 两个内容相同、插入顺序不同的 Map 会产出不同上下文，且重启后重建的
    // Map 顺序可能与原运行不同——确定性就静默失守。
    it('Map 插入顺序无关：输出顺序只按 readSlotIds 声明的顺序', () => {
      // readSlotIds 的顺序与两个 Map 的插入顺序都不同
      const prior: PriorRound = {
        visibleOutput: '输出',
        readSlotIds: ['slot_c', 'slot_a', 'slot_b'],
        submittedContent: '正文',
        findings: [],
      };
      const mapA = new Map([
        ['slot_a', '内容A'],
        ['slot_b', '内容B'],
        ['slot_c', '内容C'],
      ]);
      const mapB = new Map([
        ['slot_b', '内容B'],
        ['slot_c', '内容C'],
        ['slot_a', '内容A'],
      ]);
      const resultA = renderRevisionContext(prior, mapA);
      const resultB = renderRevisionContext(prior, mapB);
      // 两个内容相同、插入顺序不同的 Map 必须产出逐字相同的上下文
      expect(resultA).toBe(resultB);
      // 输出顺序匹配 readSlotIds（C、A、B），不是任一 Map 的插入顺序
      expect(resultA.indexOf('内容C')).toBeLessThan(resultA.indexOf('内容A'));
      expect(resultA.indexOf('内容A')).toBeLessThan(resultA.indexOf('内容B'));
    });

    it('包含上一轮公开输出、依赖槽位内容、上一稿正文、审核意见', () => {
      const prior: PriorRound = {
        visibleOutput: '上一轮输出',
        readSlotIds: ['slot_01', 'slot_02'],
        submittedContent: '上一稿正文',
        findings: [{ criterionId: 'S1', quote: '引文', problem: '问题说明' }],
      };
      const deps = new Map([
        ['slot_01', '依赖一'],
        ['slot_02', '依赖二'],
      ]);
      const result = renderRevisionContext(prior, deps);
      expect(result).toContain('上一轮输出');
      expect(result).toContain('依赖一');
      expect(result).toContain('依赖二');
      expect(result).toContain('上一稿正文');
      expect(result).toContain('S1');
      expect(result).toContain('引文');
      expect(result).toContain('问题说明');
    });

    it('readSlotIds 里的 ID 不在 dependencyContents 里则跳过', () => {
      const prior: PriorRound = {
        visibleOutput: '输出',
        readSlotIds: ['exists', 'missing'],
        submittedContent: '正文',
        findings: [],
      };
      const deps = new Map([['exists', '存在的内容']]);
      const result = renderRevisionContext(prior, deps);
      expect(result).toContain('存在的内容');
      expect(result).not.toContain('missing:\n');
    });

    it('readSlotIds 为空时不输出依赖槽位段落', () => {
      const prior: PriorRound = {
        visibleOutput: '输出',
        readSlotIds: [],
        submittedContent: '正文',
        findings: [],
      };
      const result = renderRevisionContext(prior, new Map());
      expect(result).not.toContain('依赖槽位');
    });

    it('findings 为空时不输出审核意见段落', () => {
      const prior: PriorRound = {
        visibleOutput: '输出',
        readSlotIds: [],
        submittedContent: '正文',
        findings: [],
      };
      const result = renderRevisionContext(prior, new Map());
      expect(result).not.toContain('审核意见');
    });

    it('多条 findings 按输入顺序排列', () => {
      const findings: RawFinding[] = [
        { criterionId: 'S1', quote: '引文一', problem: '问题一' },
        { criterionId: 'S2', quote: '引文二', problem: '问题二' },
      ];
      const prior: PriorRound = {
        visibleOutput: '输出',
        readSlotIds: [],
        submittedContent: '正文',
        findings,
      };
      const result = renderRevisionContext(prior, new Map());
      const idx1 = result.indexOf('S1');
      const idx2 = result.indexOf('S2');
      expect(idx1).toBeLessThan(idx2);
    });

    // AC-R-014 反证：带隐藏推理的 Provider 响应走完整链路，产物不含隐藏推理文本
    it('AC-R-014：仿真实 Provider 响应 → 剥离 → 装配 → 产物不含隐藏推理文本', () => {
      // 仿真实 Provider 响应：reasoning model 的 assistant 轮次
      // 参照 openai-compatible.ts 里 reasoning 响应的字段形状（reasoning_content）
      const rawTurn: RawAssistantTurn = {
        content: '我需要查看首段内容。',
        reasoningContent: '这是隐藏的推理过程，不应该出现在返修上下文中。',
      };

      // 剥离 → PriorRound.visibleOutput
      const visible = stripReasoning(rawTurn);

      // 装配返修上下文
      const prior: PriorRound = {
        visibleOutput: visible,
        readSlotIds: ['scene_01'],
        submittedContent: '他走出了房间。',
        findings: [
          { criterionId: 'S1', quote: '他走出了房间', problem: '首段未承接上一场结尾' },
        ],
      };
      const deps = new Map([['scene_01', '上一场结尾：她关上了门。']]);
      const context = renderRevisionContext(prior, deps);

      // 断言产物不含隐藏推理文本
      expect(context).not.toContain('这是隐藏的推理过程');
      expect(context).not.toContain('不应该出现在返修上下文中');
      // 断言产物含可见内容
      expect(context).toContain('我需要查看首段内容。');
    });
  });
});
