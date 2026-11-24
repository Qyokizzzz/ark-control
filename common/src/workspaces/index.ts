// Positions are persisted in decimal masks. Append new permissions at the end.
export const workspacePermissions = [
  ['hosts.read', '查看主机', 'host'],
  ['hosts.create', '新增主机', 'workspace'],
  ['hosts.enroll', '接入主机并接管主机上的全部地图', 'host'],
  ['hosts.disconnect', '断开主机、关闭该主机的地图和重试清理', 'host'],
  ['hosts.delete', '删除主机', 'host'],
  ['files.read', '查看服务端文件和文件任务', 'host'],
  ['files.manage', '下载、导入、更新和管理服务端文件', 'host'],
  ['maps.read', '查看地图', 'map'],
  ['maps.create', '在主机上新建地图', 'host'],
  ['maps.configure', '查看和编辑地图配置', 'map'],
  ['maps.install', '安装地图', 'map'],
  ['maps.update', '更新地图和模组', 'map'],
  ['maps.start', '启动地图', 'map'],
  ['maps.stop', '关闭和强制停止地图', 'map'],
  ['maps.restart', '重启地图', 'map'],
  ['maps.delete', '删除地图', 'map'],
  ['maps.save', '保存世界', 'map'],
  ['maps.broadcast', '发送游戏公告', 'map'],
  ['maps.players', '查看在线玩家', 'map'],
  ['maps.kick', '踢出玩家', 'map'],
  ['backups.read', '查看备份', 'map'],
  ['backups.create', '创建备份', 'map'],
  ['backups.download', '下载备份', 'map'],
  ['backups.restore', '恢复备份', 'map'],
  ['schedules.read', '查看维护计划', 'map'],
  ['schedules.write', '管理维护计划', 'map'],
  ['connections.read', '查看和下载好友联机包', 'map'],
  ['connections.write', '配置好友联机和生成联机包', 'map'],
  ['subscriptions.read', '查看部落订阅', 'map'],
  ['subscriptions.write', '配置部落订阅', 'map'],
  ['bots.read', '查看机器人和已绑定群', 'workspace'],
  ['bots.write', '管理机器人、绑定群和测试推送', 'workspace'],
  ['logs.read', '查看地图启动、运行和部落日志', 'map'],
  ['logs.retry', '重试部落日志推送', 'map'],
  ['audit.read', '查看工作空间操作记录', 'workspace'],
  ['players.read', '查看用户、设备、IP 和封禁记录', 'game'],
  ['players.write', '编辑用户资料', 'game'],
  ['players.ban', '封禁和解封玩家', 'game'],
  ['commerce.read', '查看金币、VIP 和消费流水', 'game'],
  ['commerce.write', '调整金币和 VIP', 'game'],
  ['shop.read', '查看商店草稿', 'game'],
  ['shop.write', '编辑和发布商店', 'game'],
  ['branches.retry', '重试互通组分支更新', 'game'],
  ['maps.ban', '通过地图封禁和解封玩家', 'map'],
  ['branches.read', '查看互通组分支更新', 'game'],
  ['hosts.connections', '允许主机承载好友联机控制入口', 'host'],
  ['plugins.install', '安装服务端插件', 'map'],
  ['clusters.admin-password', '设置互通组游戏管理员密码', 'cluster'],
] as const;

export type WorkspacePermission = (typeof workspacePermissions)[number][0];
export type GrantScope =
  | { kind: 'workspace' }
  | { kind: 'host'; id: string; includeMaps: boolean }
  | { kind: 'map' | 'cluster'; id: string };

export interface WorkspaceGrant {
  scope: GrantScope;
  mask: string;
}
export type WorkspaceRole = 'owner' | 'member';
export type WorkspaceStatus = 'pending' | 'active' | 'rejected' | 'suspended';
export const workspaceStatuses: Record<WorkspaceStatus, string> = {
  active: '已开通',
  pending: '待审核',
  rejected: '未通过',
  suspended: '已暂停',
};
export interface Workspace {
  id: string;
  ownerId: string;
  name: string;
  status: WorkspaceStatus;
  createdAt: string;
  reviewedAt?: string;
  limits: { hosts: number | null; maps: number | null; members: number | null };
}
export interface WorkspaceInfo extends Workspace {
  role: WorkspaceRole;
  grants: WorkspaceGrant[];
}
export interface WorkspaceMember {
  id: string;
  accountId: string;
  name: string;
  email: string;
  grants: WorkspaceGrant[];
  createdAt: string;
}
export interface WorkspaceInvitation {
  id: string;
  email: string;
  expiresAt: string;
  grants: WorkspaceGrant[];
}
export interface WorkspaceTeam {
  members: WorkspaceMember[];
  invitations: WorkspaceInvitation[];
}
export interface PlatformWorkspace extends Workspace {
  owner: { name: string; email: string } | null;
}
export interface PermissionTarget {
  workspaceId: string;
  kind: 'workspace' | 'host' | 'map' | 'cluster';
  hostId?: string;
  instanceId?: string;
  clusterId?: string;
}

const bits = new Map<WorkspacePermission, bigint>(
  workspacePermissions.map(([key], index) => [key, 1n << BigInt(index)]),
);
export const allWorkspacePermissionsMask = ((1n << BigInt(bits.size)) - 1n).toString();
export function permissionMask(actions: Iterable<WorkspacePermission>) {
  let mask = 0n;
  for (const action of actions) mask |= bits.get(action) ?? 0n;
  return mask.toString();
}
export function permissionsFromMask(value: string): WorkspacePermission[] {
  if (!/^[0-9]{1,40}$/.test(value)) return [];
  const mask = BigInt(value);
  if (mask > BigInt(allWorkspacePermissionsMask)) return [];
  return [...bits].filter(([, bit]) => (mask & bit) !== 0n).map(([action]) => action);
}
export function grantAllowsArea(scope: GrantScope, permission: WorkspacePermission) {
  const area = workspacePermissions.find(([key]) => key === permission)?.[2];
  if (scope.kind === 'workspace') return !!area;
  if (area === 'cluster') return scope.kind === 'cluster';
  if (scope.kind === 'host')
    return area === 'host' || (scope.includeMaps && (area === 'map' || area === 'game'));
  return area === 'map' || area === 'game';
}
export function grantConditions(workspaceId: string, scope: GrantScope): Partial<PermissionTarget> {
  if (scope.kind === 'workspace') return { workspaceId };
  if (scope.kind === 'host')
    return {
      workspaceId,
      hostId: scope.id,
      ...(scope.includeMaps ? {} : { kind: 'host' as const }),
    };
  if (scope.kind === 'map') return { workspaceId, kind: 'map', instanceId: scope.id };
  return { workspaceId, clusterId: scope.id };
}
export const instanceTarget = (instance: { id: string; hostId: string; clusterId: string }) => ({
  kind: 'map' as const,
  instanceId: instance.id,
  hostId: instance.hostId,
  clusterId: instance.clusterId,
});
export const commandPermission = {
  install: 'maps.install',
  start: 'maps.start',
  stop: 'maps.stop',
  restart: 'maps.restart',
  'force-stop': 'maps.stop',
  delete: 'maps.delete',
  update: 'maps.update',
  save: 'maps.save',
  backup: 'backups.create',
  restore: 'backups.restore',
  players: 'maps.players',
  broadcast: 'maps.broadcast',
  kick: 'maps.kick',
  ban: 'maps.ban',
  unban: 'maps.ban',
  'mods-update': 'maps.update',
  'sync-config': 'maps.configure',
  'install-plugins': 'plugins.install',
} as const satisfies Record<import('@common/types').Command['kind'], WorkspacePermission>;
export const managementPermission = {
  sync: 'commerce.write',
  coins: 'commerce.write',
  'vip-grant': 'commerce.write',
  'vip-revoke': 'commerce.write',
  ban: 'players.ban',
  unban: 'players.ban',
  'shop-read': 'shop.write',
  'shop-publish': 'shop.write',
} as const satisfies Record<import('@common/types').ManagementTask['kind'], WorkspacePermission>;
export function workspaceCan(
  workspace: Pick<WorkspaceInfo, 'id' | 'role' | 'grants'>,
  permission: WorkspacePermission,
  target: Omit<PermissionTarget, 'workspaceId'>,
) {
  return (
    workspace.role === 'owner' ||
    workspace.grants.some(
      ({ scope, mask }) =>
        grantAllowsArea(scope, permission) &&
        permissionsFromMask(mask).includes(permission) &&
        Object.entries(grantConditions(workspace.id, scope)).every(
          ([key, value]) => key === 'workspaceId' || target[key as keyof typeof target] === value,
        ),
    )
  );
}
