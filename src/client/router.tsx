/**
 * 代码式路由（不引 codegen 插件）。
 *
 * 路由与文档 §10.1 的「页面 → 数据源」表一一对应。`Register` 模块增强让
 * `Link` / `useNavigate` / `useParams` 获得全量类型推导。
 */

import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { AppShell } from './components/layout/AppShell.tsx';
import { TemplateList } from './pages/TemplateList.tsx';
import { TemplateDetail } from './pages/TemplateDetail.tsx';
import { TaskList } from './pages/TaskList.tsx';
import { NewTask } from './pages/NewTask.tsx';
import { TaskWorkbench } from './pages/TaskWorkbench.tsx';
import { ProviderSettings } from './pages/ProviderSettings.tsx';

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/tasks' });
  },
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/templates',
  component: TemplateList,
});

const templateDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/templates/$templateId',
  component: TemplateDetail,
});

const tasksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks',
  component: TaskList,
});

// `/tasks/new` 是静态段，优先级高于 `/tasks/$taskId` 的动态段
const newTaskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/new',
  component: NewTask,
  validateSearch: (search: Record<string, unknown>): { templateId?: string | undefined } => ({
    templateId: typeof search['templateId'] === 'string' ? (search['templateId'] as string) : undefined,
  }),
});

const taskWorkbenchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tasks/$taskId',
  component: TaskWorkbench,
  /**
   * **工作台的全部本地状态都是「这一个任务的」，所以换任务必须重挂。**
   *
   * TanStack Router 默认不因 params 变化重挂组件（`Match` 的 key 只在
   * `remountDeps` 有返回值时才变）。不声明这一条，从 `/tasks/A` 走到
   * `/tasks/B` 会复用同一个组件实例，于是至少三样东西被带过去：
   *
   * 1. `useWorkbench` 里累积的 `traces`。trace 的 `sequence` 是**每任务**
   *    从 1 开始的（`UNIQUE (task_id, sequence)`），而合并时按 sequence 去重——
   *    A 有 150 条、B 有 20 条时，B 的 1..20 会被整段判成「已经有了」丢掉，
   *    界面上是 B 的任务配 A 的时间线，没有任何报错。
   * 2. `selectedSlotId` / `followLive`。槽位 id 来自模板（`scene_01`、`title`），
   *    同模板的两个任务必然重名，于是选中的是「B 里同名的那个槽位」，
   *    且自动跟随停在 false——看起来一切正常，只是不再跟着当前工作走。
   * 3. `commandError`。A 上那条失败提示会挂在 B 的页头上。
   *
   * 修在这里而不是各组件里逐个 reset：那要在三个文件里维护「换任务要清哪些」，
   * 漏一个的表现同样是静默的错数据。重挂是一句话说完整条不变量。
   */
  remountDeps: ({ params }) => params.taskId,
});

const providerSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/providers',
  component: ProviderSettings,
});

/** 导出供测试用 memory history 另建一个 router；产品代码只用下面的 `router` 单例 */
export const routeTree = rootRoute.addChildren([
  indexRoute,
  templatesRoute,
  templateDetailRoute,
  tasksRoute,
  newTaskRoute,
  taskWorkbenchRoute,
  providerSettingsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
