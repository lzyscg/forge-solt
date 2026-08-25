/**
 * 应用外壳：68px 侧栏（生产任务 / 模板 / 设置）+ 主内容区 <Outlet/>。
 * 各页侧栏互通（设计稿 Interactions §导航）。
 */

import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { listProviders } from '../../api/providers.ts';
import { IconTasks, IconTemplates, IconSettings } from '../icons.tsx';

interface NavItem {
  to: string;
  title: string;
  match: (pathname: string) => boolean;
  icon: () => React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/tasks', title: '生产任务', match: (p) => p.startsWith('/tasks'), icon: IconTasks },
  { to: '/templates', title: '模板', match: (p) => p.startsWith('/templates'), icon: IconTemplates },
  { to: '/settings/providers', title: '设置', match: (p) => p.startsWith('/settings'), icon: IconSettings },
];

/** 侧栏底部的 Provider 概览（真实数据，不硬编码「已连接」） */
function useProviderLabel(): string {
  const providers = useQuery({ queryKey: ['providers'], queryFn: listProviders });
  const data = providers.data;
  if (data === undefined) return '';
  if (data.providers.length === 0) return '无 Provider';
  if (data.providers.some((p) => p.health.status === 'down')) return '未连接';
  if (data.providers.some((p) => p.health.status === 'rate_limited')) return '限流中';
  return '已连接';
}

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const providerLabel = useProviderLabel();

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <div className="app-nav-logo">F</div>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            title={item.title}
            className="app-nav-btn"
            data-active={item.match(pathname)}
          >
            {item.icon()}
          </Link>
        ))}
        {providerLabel !== '' ? <div className="app-nav-provider">{providerLabel}</div> : null}
      </nav>
      <div className="app-main">
        <Outlet />
      </div>
    </div>
  );
}
