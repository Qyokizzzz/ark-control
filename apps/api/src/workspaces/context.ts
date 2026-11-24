import { AsyncLocalStorage } from 'node:async_hooks';
import type { Admin, WorkspaceInfo } from '@ark-control/common';

export interface WorkspaceContext {
  workspaceId?: string;
  workspace?: WorkspaceInfo;
  actor?: Admin;
  membershipVersion?: string;
  agentHostId?: string;
  agentTokenHash?: string;
}
export const workspaceContext = new AsyncLocalStorage<WorkspaceContext>();

export function runInWorkspace<T>(workspaceId: string, callback: () => T) {
  return workspaceContext.run({ workspaceId }, callback);
}
