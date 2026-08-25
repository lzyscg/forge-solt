import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import './styles/tokens.css';
import './styles/app.css';
import { router } from './router.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 任务工作台靠 SSE 推送增量，轮询只作兜底，不要背地里重复拉取
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
