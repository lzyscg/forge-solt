import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@server': r('./src/server'),
      '@client': r('./src/client'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      include: ['src/server/domain/**', 'src/server/application/**', 'src/server/cli/**', 'src/shared/**'],
      // 纯类型文件没有可执行语句，v8 会把它们记成 0%，把总体数字拖成噪音
      exclude: ['**/*.test.ts', 'src/server/domain/types.ts'],
      // `cli/` 是 M4 加进来的。它看起来只是几个入口脚本，但 `measure-runs.ts` 里
      // 那段统计逻辑**就是 M4 的产出本身**（决定进不进 M5 的那个数字），
      // 不度量它等于让唯一的量化闸门自己不受任何约束。
      // 这些文件的行覆盖注定偏低——真正发起模型调用的那半边只有花钱才跑得到，
      // 那部分由真实实测覆盖，不由单测覆盖。
      thresholds: {
        // 全局是**下限**，不是目标。真正的门槛在下面按目录设。
        lines: 70,
        functions: 70,
        // §11.1：Domain 是纯函数集合，编码了系统的全部不变量，
        // 且是唯一能在没有数据库和模型的情况下完整验证的部分——所以要求 100% 分支。
        // 这条门槛写在配置里而不是文档里，才是真门槛（D-19 的一贯态度：
        // 「靠自觉遵守的约定」等于没有约定）。
        'src/server/domain/**': {
          branches: 100,
          functions: 100,
          lines: 100,
          statements: 100,
        },
      },
    },
  },
});
