import { describe, expect, it } from 'vitest';
import { compileNarrativePlan, type NarrativeBudget } from './narrative-plan.ts';

const budget: NarrativeBudget = { minHan: 8000, targetHan: 10_000, maxHan: 15_000 };

const TEST_OUTLINE_V2 = `1. 冷开场
变化：读者不知危险 → 主角收到异常消息
重点：P0 P001
展开：轻过渡
模式：快叙
容量：对白轮次 1；动作反馈闭环 1；认知转折 1；事后余波 0
出场：我、室友
目标：用反常消息建立阅读动力
冲突：我把消息当玩笑
结束状态：门外出现脚步
信息控制：不解释来者身份
正向有限清单：人物：我、室友；在场对象：手机；可用事实：大冒险输了

2. 当面对峙
变化：我以为是玩笑 → 对方迫使我重新判断关系
重点：P0 P002
展开：细写
模式：冲突场景
容量：对白轮次 5（不可概述的交锋）；动作反馈闭环 2（行动得到两次反馈）；认知转折 1；事后余波 1
出场：我、室友
目标：完成关系第一次翻面
冲突：双方对消息真假的判断相反
结束状态：我无法再把消息当玩笑
信息控制：只建立关系变化
正向有限清单：人物：我、室友；在场对象：手机、床；可用事实：两人是发小

3. 次日过渡
变化：关系悬置 → 我决定暂时观察
重点：bridge
展开：标准
模式：自定义
容量：对白轮次 0；动作反馈闭环 1；认知转折 0；事后余波 1
出场：我
目标：把上一节状态带到次日
冲突：我不知道该如何定义关系
结束状态：我决定先去上课
信息控制：不下永久结论
正向有限清单：人物：我；在场对象：无；可用事实：昨晚发生过对峙

4. 进入教室
变化：我决定去上课 → 我在教室发现室友缺席
重点：bridge
展开：轻过渡
模式：快叙
容量：对白轮次 0；动作反馈闭环 1；认知转折 0；事后余波 0
出场：我
目标：把观察带入新的日常环境
冲突：室友没有按惯例出现
结束状态：我确认室友缺席

5. 追问去向
变化：我只知道室友缺席 → 同学说室友一早离校
重点：bridge
展开：标准
模式：悬疑发现
容量：对白轮次 1；动作反馈闭环 1；认知转折 1；事后余波 0
出场：我、同学
目标：让缺席变成需要追查的信息
冲突：同学只看到离校，没有原因
结束状态：我知道室友已经离校

6. 返回住处
变化：我得知室友离校 → 我回到空宿舍寻找线索
重点：bridge
展开：轻过渡
模式：快叙
容量：对白轮次 0；动作反馈闭环 1；认知转折 0；事后余波 0
出场：我
目标：把追查推进到宿舍
冲突：宿舍没有室友留下的解释
结束状态：我开始检查昨晚的消息

7. 看懂消息
变化：我把消息视为孤立玩笑 → 我看出消息对应共同经历
重点：bridge
展开：标准
模式：悬疑发现
容量：对白轮次 0；动作反馈闭环 1；认知转折 1；事后余波 1
出场：我
目标：让旧信息改变当前判断
冲突：共同经历意味着室友早有准备
结束状态：我决定按消息给出的时间赴约

8. 兑现约定
变化：我仍不确定室友意图 → 我在约定地点确认室友的选择
重点：P0 P003
展开：细写
模式：现实情感
容量：对白轮次 3；动作反馈闭环 1；认知转折 1；事后余波 1
出场：我、室友
目标：兑现关系变化与故事结局
冲突：我必须决定是否接受室友的解释
结束状态：我作出不可撤回的回应
信息控制：结局在本节完整兑现`;

const outline = TEST_OUTLINE_V2;

describe('NarrativePlanCompiler', () => {
  it('解析 outline v2 并按权重非均分预算，三种总量逐字守恒', () => {
    const result = compileNarrativePlan({ outlineMarkdown: outline, storyBudget: budget });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.units).toHaveLength(8);
    expect(result.plan.units.map((unit) => unit.expansion)).toEqual([
      'light', 'detailed', 'standard', 'light', 'standard', 'light', 'standard', 'detailed',
    ]);
    expect(result.plan.units[1]!.budget.targetHan).toBeGreaterThan(result.plan.units[0]!.budget.targetHan);
    for (const key of ['minHan', 'targetHan', 'maxHan'] as const) {
      expect(result.plan.units.reduce((sum, unit) => sum + unit.budget[key], 0)).toBe(budget[key]);
    }
    expect(result.plan.units[0]).not.toHaveProperty('allowlist');
    expect(result.plan.weightProfile).toBe('i0-three-mode-v1');
  });

  it('对一组窄预算始终同时满足逐 unit 嵌套与三项总量守恒', () => {
    for (let minHan = 8; minHan <= 24; minHan += 1) {
      for (let targetHan = minHan; targetHan <= minHan + 8; targetHan += 1) {
        for (let maxHan = targetHan; maxHan <= targetHan + 8; maxHan += 1) {
          const storyBudget = { minHan, targetHan, maxHan };
          const result = compileNarrativePlan({ outlineMarkdown: outline, storyBudget });
          expect(result.ok, JSON.stringify(storyBudget)).toBe(true);
          if (!result.ok) continue;
          for (const unit of result.plan.units) {
            expect(unit.budget.minHan).toBeGreaterThan(0);
            expect(unit.budget.minHan).toBeLessThanOrEqual(unit.budget.targetHan);
            expect(unit.budget.targetHan).toBeLessThanOrEqual(unit.budget.maxHan);
          }
          for (const key of ['minHan', 'targetHan', 'maxHan'] as const) {
            expect(result.plan.units.reduce((sum, unit) => sum + unit.budget[key], 0)).toBe(storyBudget[key]);
          }
        }
      }
    }
  });

  it('story min budget 不足以覆盖每个 unit 时明确返回不可满足', () => {
    expect(compileNarrativePlan({
      outlineMarkdown: outline,
      storyBudget: { minHan: 7, targetHan: 7, maxHan: 8 },
    })).toEqual({
      ok: false,
      violations: [{
        rule: 'STORY_BUDGET_UNSATISFIABLE',
        unitId: null,
        message: 'story budget 的 minHan=7 无法让 8 个 unit 各获得至少 1 汉字',
      }],
    });
  });

  it('同一输入编译结果逐字确定', () => {
    const first = compileNarrativePlan({ outlineMarkdown: outline, storyBudget: budget });
    const second = compileNarrativePlan({ outlineMarkdown: outline, storyBudget: budget });
    expect(first).toEqual(second);
  });

  it('兼容旧实验中的正向有限清单，但不把 I4 权限字段编入 I1 plan', () => {
    const withLegacyField = compileNarrativePlan({ outlineMarkdown: outline, storyBudget: budget });
    const withoutLegacyField = compileNarrativePlan({
      outlineMarkdown: outline.replace(/^正向有限清单：.*$/gmu, ''),
      storyBudget: budget,
    });
    expect(withLegacyField).toEqual(withoutLegacyField);
  });

  it('归一化 CRLF 与 Unicode 后得到同一份 plan', () => {
    const decomposed = outline
      .replace('冷开场', '冷开场é')
      .replaceAll('\n', '\r\n');
    const composed = outline.replace('冷开场', '冷开场é');
    expect(compileNarrativePlan({ outlineMarkdown: decomposed, storyBudget: budget })).toEqual(
      compileNarrativePlan({ outlineMarkdown: composed, storyBudget: budget }),
    );
  });

  it.each([
    ['对象', '{"sections":[]}'],
    ['数组', '[{"title":"冷开场"}]'],
  ])('明确拒绝 JSON %s输入，而不伪装成空 Markdown', (_label, outlineMarkdown) => {
    expect(compileNarrativePlan({ outlineMarkdown, storyBudget: budget })).toEqual({
      ok: false,
      violations: [{
        rule: 'OUTLINE_FORMAT_UNSUPPORTED',
        unitId: null,
        message: '大纲只接受 Outline v2 Markdown，不接受 JSON 对象或数组',
      }],
    });
  });

  it('一次返回缺字段、编号跳号、容量越界、重复重点和全同档位', () => {
    const broken = outline
      .replace('2. 当面对峙', '4. 当面对峙')
      .replace('对白轮次 5（不可概述的交锋）；动作反馈闭环 2（行动得到两次反馈）', '对白轮次 9（超限）；动作反馈闭环 5（超限）')
      .replace('P0 P002', 'P0 P001')
      .replaceAll('展开：细写', '展开：轻过渡')
      .replaceAll('展开：标准', '展开：轻过渡')
      .replace('结束状态：我决定先去上课', '');
    const result = compileNarrativePlan({ outlineMarkdown: broken, storyBudget: budget });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((violation) => violation.rule)).toEqual(expect.arrayContaining([
      'SECTION_NUMBER',
      'CAPACITY_EXCEEDED',
      'PRIORITY_ID_DUPLICATE',
      'UNIFORM_EXPANSION',
      'FIELD_MISSING',
    ]));
  });

  it('强制 8–30 个连续编号小节', () => {
    const tooShort = compileNarrativePlan({
      outlineMarkdown: outline.replace(/\n8\. 兑现约定[\s\S]*$/u, ''),
      storyBudget: budget,
    });
    expect(tooShort.ok).toBe(false);
    if (!tooShort.ok) {
      expect(tooShort.violations).toContainEqual({
        rule: 'SECTION_COUNT',
        unitId: null,
        message: '大纲需要 8–30 个小节，实际为 7',
      });
    }
  });

  it('P0/P1 共用从 P001 开始的首次出现序列，且最后一节必须以 P0 兑现结局', () => {
    const result = compileNarrativePlan({
      outlineMarkdown: outline
        .replace('重点：P0 P002', '重点：P0 P004')
        .replace('重点：P0 P003', '重点：P1 P003'),
      storyBudget: budget,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toEqual(expect.arrayContaining([
      {
        rule: 'PRIORITY_ID_SEQUENCE',
        unitId: 'unit_02',
        message: 'unit_02 的重点 ID 应为 P002，实际为 P004',
      },
      {
        rule: 'ENDING_NOT_P0',
        unitId: 'unit_08',
        message: '最后一个小节必须以 P0 兑现原文结局',
      },
    ]));
  });

  it('没有 P0 与非法 story budget 都明确失败', () => {
    const result = compileNarrativePlan({
      outlineMarkdown: outline.replaceAll(/重点：P0 P\d{3}/gu, '重点：P1 P101'),
      storyBudget: { minHan: 10_000, targetHan: 9000, maxHan: 8000 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((violation) => violation.rule)).toEqual(expect.arrayContaining([
      'NO_P0', 'PRIORITY_ID_DUPLICATE', 'STORY_BUDGET_INVALID',
    ]));
  });

  it('空大纲失败且不继续制造无意义违规', () => {
    expect(compileNarrativePlan({ outlineMarkdown: '没有编号', storyBudget: budget })).toEqual({
      ok: false,
      violations: [{ rule: 'OUTLINE_EMPTY', unitId: null, message: '大纲没有 N. 标题形式的编号小节' }],
    });
  });
});
