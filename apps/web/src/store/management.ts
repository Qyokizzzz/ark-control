import { create } from 'zustand';
import type { ManagementState, ShopDraft } from '@ark-control/common';
import { request } from '@/api';

interface State {
  data: ManagementState | null;
  scopeId: string;
  query: string;
  filter: string;
  page: number;
  loading: boolean;
  error: string | null;
  draftText: string;
  draftRevision: number;
  dirty: boolean;
  select: (scopeId: string) => void;
  search: (query: string) => void;
  setFilter: (filter: string) => void;
  setPage: (page: number) => void;
  load: () => Promise<void>;
  setDraft: (text: string) => void;
  saveDraft: () => Promise<void>;
  resetDraft: () => void;
  clear: () => void;
}
let generation = 0;
const initial = {
  data: null,
  scopeId: '',
  query: '',
  filter: 'all',
  page: 1,
  loading: false,
  error: null,
  draftText: '',
  draftRevision: 0,
  dirty: false,
};
export const useManagementStore = create<State>((set, get) => ({
  ...initial,
  select: (scopeId) => {
    generation++;
    set({ scopeId, data: null, page: 1, draftText: '', draftRevision: 0, dirty: false });
    void get().load();
  },
  search: (query) => {
    generation++;
    set({ query, page: 1 });
    void get().load();
  },
  setFilter: (filter) => {
    generation++;
    set({ filter, page: 1 });
    void get().load();
  },
  setPage: (page) => {
    generation++;
    set({ page });
    void get().load();
  },
  load: async () => {
    const token = ++generation;
    const { scopeId, query, filter, page } = get();
    set({ loading: true });
    try {
      const params = new URLSearchParams({
        q: query,
        filter,
        page: String(page),
        ...(scopeId ? { scopeId } : {}),
      });
      const data = await request<ManagementState>(`/management?${params}`);
      if (token !== generation) return;
      const state = get();
      set({
        data,
        page: data.page,
        scopeId: data.scopes.some(({ id }) => id === scopeId)
          ? scopeId
          : (data.scopes[0]?.id ?? ''),
        error: null,
        ...(!state.dirty
          ? {
              draftText: JSON.stringify(
                data.shop?.config ?? { General: {}, ShopItems: {}, SellItems: {}, Kits: {} },
                null,
                2,
              ),
              draftRevision: data.shop?.revision ?? 0,
            }
          : {}),
      });
    } catch (error) {
      if (token === generation)
        set({ error: error instanceof Error ? error.message : '加载失败。' });
    } finally {
      if (token === generation) set({ loading: false });
    }
  },
  setDraft: (draftText) => set({ draftText, dirty: true }),
  resetDraft: () => {
    const { data } = get();
    set({
      draftText: JSON.stringify(data?.shop?.config ?? {}, null, 2),
      draftRevision: data?.shop?.revision ?? 0,
      dirty: false,
    });
  },
  saveDraft: async () => {
    const state = get();
    const draft = await request<ShopDraft>('/management/shop', 'POST', {
      scopeId: state.scopeId,
      revision: state.draftRevision,
      config: JSON.parse(state.draftText),
    });
    set({
      draftText: JSON.stringify(draft.config, null, 2),
      draftRevision: draft.revision,
      dirty: false,
    });
    await get().load();
  },
  clear: () => {
    generation++;
    set(initial);
  },
}));
