import { create } from 'zustand';
import type { ConnectionState } from '@ark-control/common';
import { request } from '@/api';

let pending: Promise<void> | null = null;
let generation = 0;
export const useConnectionsStore = create<{
  data: ConnectionState | null;
  error: string | null;
  load: () => Promise<void>;
  clear: () => void;
}>((set) => ({
  data: null,
  error: null,
  load: async () => {
    if (pending) return pending;
    const current = generation;
    pending = (async () => {
      try {
        const data = await request<ConnectionState>('/connections');
        if (current === generation) set({ data, error: null });
      } catch (error) {
        if (current === generation)
          set({ error: error instanceof Error ? error.message : '加载失败。' });
      } finally {
        if (current === generation) pending = null;
      }
    })();
    return pending;
  },
  clear: () => {
    generation++;
    pending = null;
    set({ data: null, error: null });
  },
}));
