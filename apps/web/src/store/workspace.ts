import { create } from 'zustand';
import type { Dashboard } from '@ark-control/common';
import { request } from '@/api';

interface WorkspaceState {
  data: Dashboard | null;
  loading: boolean;
  error: string | null;
  updatedAt: number;
  query: string;
  load: () => Promise<void>;
  setQuery: (query: string) => void;
  clear: () => void;
}
let pending: Promise<void> | null = null;
let generation = 0;
export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  data: null,
  loading: false,
  error: null,
  updatedAt: 0,
  query: '',
  load: async () => {
    if (pending) return pending;
    const current = generation;
    pending = (async () => {
      set({ loading: true });
      try {
        const data = await request<Dashboard>('/dashboard');
        if (current === generation) set({ data, error: null, updatedAt: Date.now() });
      } catch (error) {
        if (current === generation)
          set({ error: error instanceof Error ? error.message : '加载失败。' });
      } finally {
        if (current === generation) {
          set({ loading: false });
          pending = null;
        }
      }
    })();
    return pending;
  },
  setQuery: (query) => set({ query }),
  clear: () => {
    generation++;
    pending = null;
    set({ data: null, loading: false, error: null, updatedAt: 0, query: '' });
  },
}));
interface Notice {
  message: string;
  severity: 'success' | 'error' | 'info';
}
export const useUiStore = create<{
  notice: Notice | null;
  notify: (message: string, severity?: Notice['severity']) => void;
  dismiss: () => void;
}>((set) => ({
  notice: null,
  notify: (message, severity = 'success') => set({ notice: { message, severity } }),
  dismiss: () => set({ notice: null }),
}));
