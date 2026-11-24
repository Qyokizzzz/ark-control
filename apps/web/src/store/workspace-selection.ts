import { useCallback } from 'react';
import { create } from 'zustand';
import { workspaceCan } from '@ark-control/common';
import type { PermissionTarget, WorkspaceInfo, WorkspacePermission } from '@ark-control/common';
import { request } from '@/api';
import { useConnectionsStore } from './connections';
import { useManagementStore } from './management';
import { useWorkspaceStore } from './workspace';

interface Selection {
  accountId: string;
  spaces: WorkspaceInfo[];
  active: WorkspaceInfo | null;
  revision: number;
  ready: boolean;
  error: string | null;
  load: (accountId: string) => Promise<void>;
  select: (id: string) => void;
  clear: () => void;
}
let latestLoad = 0;
const selectionKey = (accountId: string) => `ark-workspace:${accountId}`;
function clearResources() {
  useWorkspaceStore.getState().clear();
  useConnectionsStore.getState().clear();
  useManagementStore.getState().clear();
}

function preference(key: string, id?: string) {
  try {
    if (id) localStorage.setItem(key, id);
    else return localStorage.getItem(key);
  } catch {
    /* The current tab can still select a workspace. */
  }
  return null;
}

export const useWorkspaceSelection = create<Selection>((set, get) => ({
  accountId: '',
  spaces: [],
  active: null,
  revision: 0,
  ready: false,
  error: null,
  clear: () => {
    latestLoad++;
    clearResources();
    set(({ revision }) => ({
      accountId: '',
      spaces: [],
      active: null,
      revision: revision + 1,
      ready: false,
      error: null,
    }));
  },
  load: async (accountId) => {
    if (get().accountId !== accountId) {
      get().clear();
      set({ accountId });
    }
    const current = ++latestLoad;
    try {
      const spaces = await request<WorkspaceInfo[]>('/workspaces');
      if (current !== latestLoad) return;
      const previous = get().active;
      const activeSpaces = spaces.filter(({ status }) => status === 'active');
      const id = previous?.id ?? preference(selectionKey(accountId));
      const active =
        activeSpaces.find((space) => space.id === id) ??
        activeSpaces.find(({ role }) => role === 'owner') ??
        activeSpaces[0] ??
        null;
      const changed =
        active?.id !== previous?.id ||
        active?.role !== previous?.role ||
        JSON.stringify(active?.grants) !== JSON.stringify(previous?.grants);
      if (changed) clearResources();
      set(({ revision }) => ({
        spaces,
        active,
        ready: true,
        error: null,
        revision: revision + Number(changed),
      }));
    } catch (error) {
      if (current === latestLoad)
        set({ ready: true, error: error instanceof Error ? error.message : '工作空间加载失败。' });
    }
  },
  select: (id) => {
    const active = get().spaces.find((item) => item.id === id && item.status === 'active');
    if (!active || active.id === get().active?.id) return;
    preference(selectionKey(get().accountId), id);
    clearResources();
    set(({ revision }) => ({ active, revision: revision + 1 }));
  },
}));

export function useWorkspaceCan() {
  const workspace = useWorkspaceSelection((state) => state.active);
  return useCallback(
    (
      permission: WorkspacePermission,
      target: Omit<PermissionTarget, 'workspaceId'> = { kind: 'workspace' },
    ) => !!workspace && workspaceCan(workspace, permission, target),
    [workspace],
  );
}
