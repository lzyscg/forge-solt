// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 分层依赖约束（文档 §2.4 / REQ §29）。
 *
 * 规则不是风格建议，是架构边界的机器化执行：
 *   domain      纯函数、零 IO —— 不得依赖 SQLite / HTTP / React / fs / Provider / 上层
 *   application 编排层 —— 不得依赖 HTTP 框架与前端
 *   client      前端 —— 只能碰 @shared，不得反向依赖 @server
 *   shared      契约层 —— 谁都不许依赖，只许被依赖
 *
 * CI 中 lint 失败即阻断。
 */

/** domain 层禁止触碰的一切 */
const DOMAIN_FORBIDDEN = [
  'better-sqlite3',
  'fastify',
  'fastify/**',
  'react',
  'react-dom',
  'yaml',
  'markdown-it',
  'dompurify',
  'node:fs',
  'node:fs/*',
  'node:http',
  'node:https',
  'node:net',
  'node:child_process',
  '@server/infrastructure/**',
  '@server/runtime/**',
  '@server/api/**',
  '@server/application/**',
  '@client/**',
];

const APPLICATION_FORBIDDEN = ['fastify', 'fastify/**', 'react', 'react-dom', '@server/api/**', '@client/**'];

const CLIENT_FORBIDDEN = ['@server/**', 'better-sqlite3', 'fastify', 'node:*'];

const SHARED_FORBIDDEN = ['@server/**', '@client/**', 'better-sqlite3', 'fastify', 'react', 'react-dom'];

const restrict = (patterns, message) => ({
  'no-restricted-imports': ['error', { patterns: patterns.map((group) => ({ group: [group], message })) }],
});

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'data/**', 'design_handoff_forge_core_vnext/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  {
    files: ['src/shared/**/*.ts'],
    rules: restrict(SHARED_FORBIDDEN, 'shared 是契约层，不得依赖任何实现层（文档 §2.4）'),
  },

  {
    files: ['src/server/domain/**/*.ts'],
    rules: {
      ...restrict(DOMAIN_FORBIDDEN, 'domain 必须是零 IO 的纯函数层，不得依赖基础设施或上层（REQ §29 / 文档 §2.4）'),
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'domain 不得依赖浏览器全局' },
        { name: 'document', message: 'domain 不得依赖浏览器全局' },
        { name: 'fetch', message: 'domain 不得发起网络请求' },
      ],
    },
  },

  {
    files: ['src/server/application/**/*.ts'],
    rules: restrict(APPLICATION_FORBIDDEN, 'application 不得依赖 HTTP 框架或前端（文档 §2.4）'),
  },

  {
    files: ['src/server/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: '服务端不得使用浏览器全局' },
        { name: 'document', message: '服务端不得使用浏览器全局' },
        { name: 'localStorage', message: '服务端不得使用浏览器全局' },
      ],
    },
  },

  {
    files: ['src/client/**/*.{ts,tsx}'],
    rules: restrict(CLIENT_FORBIDDEN, '前端只能依赖 @shared，不得反向依赖服务端实现（文档 §2.4）'),
  },

  {
    files: ['src/server/cli/**/*.ts', 'src/server/main.ts', 'src/server/dev-fake.ts', 'migrations/**', '*.config.ts', 'eslint.config.js'],
    rules: { 'no-console': 'off' },
  },

  {
    // `.tsx` 必须一起写进来：vitest 的 include 收了 `src/**/*.test.tsx`，
    // 而组件测试天然要造夹具对象（`any` 的主要用途）。漏掉扩展名的表现是
    // 「同一条豁免对 .ts 生效、对 .tsx 不生效」，下一个人会以为是 eslint 抽风。
    files: ['tests/**/*.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
);
