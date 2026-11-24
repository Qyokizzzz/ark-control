import { AbilityBuilder, createMongoAbility, subject } from '@casl/ability';
import type { MongoAbility } from '@casl/ability';
import {
  grantAllowsArea,
  grantConditions,
  instanceTarget,
  permissionsFromMask,
} from '@ark-control/common';
import type {
  Instance,
  PermissionTarget,
  WorkspaceInfo,
  WorkspacePermission,
} from '@ark-control/common';
import { BusinessError } from '@/infrastructure/errors';
import type { Connection, Database, RecordMap } from '@/infrastructure/database';
import { workspaceContext } from './context';

type Target = Omit<PermissionTarget, 'workspaceId'>;
type Resource = PermissionTarget & { __caslSubjectType__: 'Resource' };
type WorkspaceAbility = MongoAbility<[WorkspacePermission | 'manage', 'Resource' | Resource]>;
const abilities = new WeakMap<WorkspaceInfo, WorkspaceAbility>();
const workspaceTarget = { kind: 'workspace' } as const;
export const hostTarget = (hostId: string) => ({ kind: 'host' as const, hostId });

function abilityFor(workspace: WorkspaceInfo) {
  const current = abilities.get(workspace);
  if (current) return current;
  const { can, build } = new AbilityBuilder<WorkspaceAbility>(createMongoAbility);
  if (workspace.role === 'owner') can('manage', 'Resource', { workspaceId: workspace.id });
  else
    for (const { scope, mask } of workspace.grants) {
      const actions = permissionsFromMask(mask).filter((action) => grantAllowsArea(scope, action));
      if (actions.length) can(actions, 'Resource', grantConditions(workspace.id, scope));
    }
  const ability = build();
  abilities.set(workspace, ability);
  return ability;
}

export function allowed(action: WorkspacePermission, target: Target = workspaceTarget) {
  const context = workspaceContext.getStore();
  const workspace = context?.workspace;
  return Boolean(
    workspace &&
    context?.workspaceId === workspace.id &&
    abilityFor(workspace).can(
      action,
      subject('Resource', { ...target, workspaceId: workspace.id }),
    ),
  );
}

export function requireAccess(action: WorkspacePermission, target?: Target) {
  if (!allowed(action, target))
    throw new BusinessError('WORKSPACE_FORBIDDEN', '你没有这项操作权限。', 403);
}

// The public, agent and maintenance entry points authenticate independently.
export function requireAccountAccess(action: WorkspacePermission, target?: Target) {
  if (workspaceContext.getStore()?.actor) requireAccess(action, target);
}

export async function resource<K extends keyof RecordMap>(
  db: Database,
  kind: K,
  id: string,
  connection?: Connection,
): Promise<RecordMap[K]> {
  const item = await db.get(kind, id, connection);
  if (!item) throw new BusinessError('NOT_FOUND', '当前工作空间没有这项资源。', 404);
  return item;
}

export async function requireMapAccess(
  db: Database,
  action: WorkspacePermission,
  id: string,
  connection?: Connection,
) {
  const instance = await resource(db, 'instances', id, connection);
  requireAccess(action, instanceTarget(instance));
  return instance;
}

export async function requireHostAccess(
  db: Database,
  action: WorkspacePermission,
  id: string,
  connection?: Connection,
) {
  const host = await resource(db, 'hosts', id, connection);
  requireAccess(action, hostTarget(host.id));
  return host;
}

export async function requireGameAccess(
  db: Database,
  action: WorkspacePermission,
  scope: string,
  connection?: Connection,
) {
  if (scope.startsWith('cluster:')) {
    const clusterId = scope.slice('cluster:'.length);
    if (!clusterId || !(await db.listBy('instances', 'clusterId', clusterId, connection)).length)
      throw new BusinessError('NOT_FOUND', '当前工作空间没有这个互通组。', 404);
    requireAccess(action, { kind: 'cluster', clusterId });
    return;
  }
  if (!scope.startsWith('instance:')) throw new BusinessError('NOT_FOUND', '游戏范围不存在。', 404);
  const instance = await resource(db, 'instances', scope.slice('instance:'.length), connection);
  if (instance.clusterId) throw new BusinessError('NOT_FOUND', '地图已加入互通组。', 404);
  requireAccess(action, instanceTarget(instance));
}

export function gameTarget(instance: Instance) {
  return instance.clusterId
    ? { kind: 'cluster' as const, clusterId: instance.clusterId }
    : instanceTarget(instance);
}
