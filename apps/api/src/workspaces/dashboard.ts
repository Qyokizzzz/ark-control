import {
  commandPermission,
  effectiveGameConfig,
  instanceTarget,
  workspacePermissions,
} from '@ark-control/common';
import type { Dashboard, Host, Instance, WorkspacePermission } from '@ark-control/common';
import { allowed, hostTarget } from './access';
import { workspaceContext } from './context';

const mapActions = workspacePermissions.filter(([, , area]) => area === 'map').map(([key]) => key);
const hostActions = workspacePermissions
  .filter(([, , area]) => area === 'host')
  .map(([key]) => key);

function publicInstance(instance: Instance): Instance {
  const target = instanceTarget(instance);
  const canConfigure = allowed('maps.configure', target);
  const canSeeLogs = allowed('logs.read', target);
  return {
    ...instance,
    config: canConfigure
      ? instance.config
      : {
          ...instance.config,
          ...effectiveGameConfig(instance.config),
          serverPassword: '',
          advancedIni: undefined,
          extraGameIni: '',
          extraSettingsIni: '',
        },
    lastError: canSeeLogs ? instance.lastError : null,
    startup:
      !canSeeLogs && instance.startup
        ? {
            ...instance.startup,
            lastRconError: null,
            logs: [],
            logPaths: [],
          }
        : instance.startup,
  };
}

function hostLabel(host: Host): Host {
  return {
    id: host.id,
    name: host.name,
    status: host.status,
    platform: host.platform,
    address: '',
    metrics: null,
    lastSeenAt: null,
    createdAt: host.createdAt,
    agentVersion: null,
  };
}

export function workspaceDashboard(dashboard: Dashboard): Dashboard {
  if (workspaceContext.getStore()?.workspace?.role === 'owner') return dashboard;
  const maps = new Map(
    dashboard.instances.map((instance) => [instance.id, instanceTarget(instance)]),
  );
  const allows = (id: string, ...actions: WorkspacePermission[]) => {
    const target = maps.get(id);
    return !!target && actions.some((action) => allowed(action, target));
  };
  const instances = dashboard.instances
    .filter((item) => allows(item.id, ...mapActions))
    .map(publicInstance);
  const visibleHosts = new Set(instances.map((item) => item.hostId));
  const hosts = dashboard.hosts.flatMap((host) =>
    hostActions.some((action) => allowed(action, hostTarget(host.id)))
      ? [host]
      : visibleHosts.has(host.id)
        ? [hostLabel(host)]
        : [],
  );
  const subscriptions = dashboard.subscriptions.filter((item) =>
    allows(item.instanceId, 'subscriptions.read', 'subscriptions.write'),
  );
  const editSubscriptions = instances.some((item) => allows(item.id, 'subscriptions.write'));
  const canSeeBots = allowed('bots.read') || allowed('bots.write');
  const deliveries = dashboard.deliveries.filter((item) =>
    allows(item.instanceId, 'logs.read', 'logs.retry'),
  );
  const chinaDate = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
  const today = chinaDate(Date.now());
  return {
    ...dashboard,
    instances,
    hosts,
    subscriptions,
    deliveries,
    bots: canSeeBots
      ? dashboard.bots
      : editSubscriptions
        ? dashboard.bots.map((item) => ({
            ...item,
            appId: '',
            owner: '',
            lastError: null,
            verifiedAt: null,
          }))
        : [],
    groups: canSeeBots
      ? dashboard.groups
      : dashboard.groups
          .filter(
            (item) => editSubscriptions || subscriptions.some((sub) => sub.groupId === item.id),
          )
          .map((item) => ({ ...item, openId: '', groupNumber: '' })),
    tribes: dashboard.tribes.filter((item) =>
      allows(item.instanceId, 'logs.read', 'subscriptions.read', 'subscriptions.write'),
    ),
    events: dashboard.events.filter((item) => allows(item.instanceId, 'logs.read')),
    console: dashboard.console.filter((item) => allows(item.instanceId, 'logs.read')),
    commands: dashboard.commands.filter((item) =>
      allows(item.instanceId, commandPermission[item.kind]),
    ),
    backups: dashboard.backups.filter((item) =>
      (['backups.read', 'backups.create', 'backups.download', 'backups.restore'] as const).some(
        (action) =>
          allowed(
            action,
            maps.get(item.instanceId) ?? { kind: 'map', instanceId: item.instanceId },
          ),
      ),
    ),
    schedules: dashboard.schedules.filter((item) =>
      allows(item.instanceId, 'schedules.read', 'schedules.write'),
    ),
    audit: dashboard.audit.filter(
      (item) =>
        allowed('audit.read') || (item.instanceId && allows(item.instanceId, 'maps.configure')),
    ),
    serverFiles: dashboard.serverFiles?.filter((item) =>
      (['files.read', 'files.manage', 'maps.create'] as const).some((permission) =>
        allowed(permission, hostTarget(item.hostId)),
      ),
    ),
    fileTasks: dashboard.fileTasks?.filter(
      (item) =>
        allowed('files.read', hostTarget(item.hostId)) ||
        allowed('files.manage', hostTarget(item.hostId)),
    ),
    summary: {
      total: instances.length,
      running: instances.filter((item) => item.status === 'running').length,
      sentToday: deliveries.filter(
        (item) => item.sentAt && chinaDate(Date.parse(item.sentAt)) === today,
      ).length,
      pending: deliveries.filter((item) =>
        ['pending', 'ready', 'retry', 'sending'].includes(item.status),
      ).length,
      errors: deliveries.filter((item) => ['blocked', 'uncertain'].includes(item.status)).length,
    },
  };
}
