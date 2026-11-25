import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type {
  Admin,
  ClusterAdminSettings,
  ClusterPreset,
  ClusterPresetContent,
  ClusterPresetGroup,
  Command,
  CommandInput,
  ConfigAuditEntry,
  CreateInstanceInput,
  Dashboard,
  Host,
  Instance,
  InstanceUpdateResult,
  Json,
  SaveClusterPresetInput,
  Schedule,
  UpdateInstanceInput,
} from '@ark-control/common';
import {
  CLUSTER_ADMIN_PASSWORD_FEATURE,
  CONFIG_CHANGE_PREVIEW_LIMIT,
  MAPS,
  SHARED_MAP_FILES_FEATURE,
  STEAM_SERVER_NAME_LIMIT,
  canDeleteStoppedInstance,
  canTerminateStartup,
  applyClusterPreset,
  clusterGameConfig,
  defaultSteamServerName,
  effectiveGameConfig,
  estimateCapacity,
  gameConfigSchema,
  isHostOnline,
  validatePortAllocation,
  gameBranch,
  shareableServerFiles,
  commandPermission,
  instanceTarget,
} from '@ark-control/common';
import { configurationChanges } from '@/control/config-changes';
import { newInstanceCommand, removeInstanceResources } from '@/control/lifecycle';
import {
  BusinessError,
  Database,
  config,
  encryptSecret,
  hashToken,
  newToken,
  parse,
  tokensEqual,
} from '@/infrastructure';
import type { Connection } from '@/infrastructure';
import { runInWorkspace, workspaceContext } from '@/workspaces/context';
import {
  allowed,
  hostTarget,
  requireAccountAccess,
  requireAccess,
  requireMapAccess,
  resource,
} from '@/workspaces/access';
import { workspaceDashboard } from '@/workspaces/dashboard';
import { withPlatformBot } from '@/qq/platform-bot';

export const nowIso = () => new Date().toISOString();
export const activeCommand = (item: Command) =>
  ['queued', 'leased', 'executing', 'cancelling'].includes(item.status);
@Injectable()
export class ControlService {
  constructor(@Inject(Database) readonly db: Database) {}
  async audit(
    action: string,
    target: string,
    detail: string,
    connection?: Connection,
    actor?: string,
  ) {
    const account = workspaceContext.getStore()?.actor;
    await this.db.put(
      'audit',
      {
        id: randomUUID(),
        actor: actor ?? (account ? account.name + ' (' + account.email + ')' : '系统'),
        actorId: actor ? undefined : account?.id,
        action,
        target,
        detail,
        createdAt: nowIso(),
      },
      connection,
    );
  }
  async requireInstance(id: string, connection?: Connection): Promise<Instance> {
    const instance = await this.db.get('instances', id, connection);
    if (!instance) throw new BusinessError('NOT_FOUND', '地图实例不存在。', 404);
    return instance;
  }
  async configAudit(id: string): Promise<ConfigAuditEntry> {
    const [entry, detail] = await Promise.all([
      this.db.get('audit', id),
      this.db.get('config-audit-details', id),
    ]);
    if (!entry || !detail) throw new BusinessError('NOT_FOUND', '配置修改记录不存在。', 404);
    if (!allowed('audit.read'))
      await requireMapAccess(this.db, 'maps.configure', entry.instanceId ?? '');
    return { ...entry, changes: detail.changes };
  }
  async dashboard(): Promise<Dashboard> {
    const [
      hostsRaw,
      instancesRaw,
      bots,
      groups,
      subscriptions,
      tribes,
      deliveries,
      events,
      commands,
      backups,
      schedules,
      audit,
      console,
      deliverySummary,
      cleanups,
      active,
      serverFiles,
      fileTasks,
    ] = await Promise.all([
      this.db.list('hosts'),
      this.db.list('instances'),
      this.db.list('bots'),
      this.db.list('groups'),
      this.db.list('subscriptions'),
      this.db.list('tribes'),
      this.db.list('deliveries', undefined, 1000),
      this.db.list('events', undefined, 1000),
      this.db.list('commands', undefined, 200),
      this.db.list('backups'),
      this.db.list('schedules'),
      this.db.list('audit', undefined, 100),
      this.db.list('console', undefined, 400),
      this.db.deliverySummary(),
      this.db.list('instance-cleanups'),
      this.db.inStates('commands', ['queued', 'leased', 'executing', 'cancelling']),
      this.db.list('server-files'),
      this.db.list('file-tasks', undefined, 200),
    ]);
    // Keep the latest configuration receipt visible even after it leaves the recent task history.
    const recentIds = new Set(commands.map((command) => command.id));
    const olderSyncIds = instancesRaw.flatMap(({ configSyncCommandId: id }) =>
      id && !recentIds.has(id) ? [id] : [],
    );
    commands.push(...(await this.db.commandsByIds(olderSyncIds)));
    const hosts = hostsRaw.map((item): Host => ({
      ...item,
      pendingCleanups: cleanups.filter((cleanup) => cleanup.hostId === item.id).length,
      cleanupError:
        cleanups.find((cleanup) => cleanup.hostId === item.id && cleanup.lastError)?.lastError ??
        null,
      status: ['disconnecting', 'disconnected'].includes(item.status)
        ? item.status
        : !item.lastSeenAt
          ? 'unconfigured'
          : Date.now() - Date.parse(item.lastSeenAt) > 30000
            ? 'offline'
            : 'online',
    }));
    const instances = instancesRaw.map((item): Instance => ({
      ...item,
      canDeleteDirectly: canDeleteStoppedInstance(
        item,
        active.some((command) => command.instanceId === item.id),
      ),
      status:
        hosts.find((host) => host.id === item.hostId)?.status !== 'online' &&
        item.status !== 'stopped'
          ? 'unknown'
          : item.status,
    }));
    return workspaceDashboard({
      demo: config.DEMO_MODE === 'true',
      serverFiles: serverFiles.filter((item) => item.status !== 'deleted'),
      fileTasks,
      hosts,
      instances,
      bots: withPlatformBot(bots),
      groups,
      subscriptions,
      tribes,
      deliveries,
      events,
      commands,
      backups,
      schedules,
      audit,
      console,
      summary: {
        running: instances.filter((item) => item.status === 'running').length,
        total: instances.length,
        ...deliverySummary,
      },
    });
  }
  async createHost(name: string, address: string) {
    const code = newToken();
    const id = randomUUID();
    await this.db.transaction(async (connection) => {
      await this.requireQuota('hosts', connection);
      await this.db.put(
        'hosts',
        {
          id,
          name,
          address,
          platform: 'unknown',
          status: 'unconfigured',
          metrics: null,
          lastSeenAt: null,
          createdAt: nowIso(),
          agentVersion: null,
        },
        connection,
      );
      await this.db.put(
        'host-credentials',
        {
          id,
          tokenHash: null,
          codeHash: hashToken(code),
          codeExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        connection,
      );
      await this.audit('添加主机', name, '已生成一次性接入码，有效期一小时。', connection);
    });
    return { id, code, expiresIn: 3600 };
  }
  async renewHostCode(id: string) {
    const code = newToken();
    await this.db.transaction(async (connection) => {
      const value = await this.db.get('host-credentials', id, connection);
      if (!value) throw new BusinessError('NOT_FOUND', '主机不存在。', 404);
      const host = await this.db.get('hosts', id, connection);
      if (host?.status === 'disconnecting') {
        await this.db.put(
          'hosts',
          { ...host, status: 'offline', disconnectError: null },
          connection,
        );
        await this.audit(
          '恢复主机连接',
          host.name,
          '已取消待执行的断开请求并生成新接入码。',
          connection,
        );
      }
      await this.db.put(
        'host-credentials',
        {
          ...value,
          codeHash: hashToken(code),
          codeExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
        connection,
      );
    });
    return { code, expiresIn: 3600 };
  }
  async disconnectHost(id: string) {
    return this.db.transaction(async (connection) => {
      const host = await this.db.get('hosts', id, connection);
      if (!host) throw new BusinessError('NOT_FOUND', '主机不存在。', 404);
      if (['disconnecting', 'disconnected'].includes(host.status)) return host;
      const commands = await this.db.inStates(
        'commands',
        ['queued', 'leased', 'executing', 'cancelling'],
        connection,
      );
      for (const command of commands.filter((item) => item.hostId === id))
        await this.db.put(
          'commands',
          {
            ...command,
            status: command.status === 'queued' ? 'cancelled' : 'cancelling',
            progress: '主机正在断开，等待本机任务结束并清理资源。',
            completedAt: command.status === 'queued' ? nowIso() : null,
          },
          connection,
        );
      for (const task of await this.db.inStates(
        'file-tasks',
        ['queued', 'leased', 'executing', 'cancelling'],
        connection,
      ))
        if (task.hostId === id)
          await this.db.put(
            'file-tasks',
            {
              ...task,
              status: task.status === 'queued' ? 'cancelled' : 'cancelling',
              progress: '主机正在断开，等待文件操作停止并保留已下载内容。',
              completedAt: task.status === 'queued' ? nowIso() : null,
            },
            connection,
          );
      const credential = await this.db.get('host-credentials', id, connection);
      if (credential)
        await this.db.put(
          'host-credentials',
          { ...credential, codeHash: '', codeExpiresAt: nowIso() },
          connection,
        );
      const updated: Host = {
        ...host,
        status: credential?.tokenHash ? 'disconnecting' : 'disconnected',
        disconnectError: null,
      };
      await this.db.put('hosts', updated, connection);
      for (const instance of await this.db.list('instances', connection))
        if (instance.hostId === id)
          await this.db.put('instances', { ...instance, desiredState: 'stopped' }, connection);
      await this.audit(
        '断开主机',
        host.name,
        '先正常关闭全部地图并结束联机组件，完成后撤销助手凭据；配置和存档保留。',
        connection,
      );
      return updated;
    });
  }
  async removeHost(id: string) {
    return this.db.transaction(async (connection) => {
      const host = await this.db.get('hosts', id, connection);
      if (!host) throw new BusinessError('NOT_FOUND', '主机不存在。', 404);
      if (
        (
          await this.db.inStates(
            'file-tasks',
            ['queued', 'leased', 'executing', 'cancelling'],
            connection,
          )
        ).some((item) => item.hostId === id)
      )
        throw new BusinessError('HOST_FILES_BUSY', '主机还有文件任务，请先完成或取消任务。');
      if ((await this.db.list('instances', connection)).some((item) => item.hostId === id))
        throw new BusinessError(
          'HOST_HAS_INSTANCES',
          '请先删除该主机下的地图，完成进程和文件清理后再删除主机。',
        );
      if ((await this.db.list('instance-cleanups', connection)).some((item) => item.hostId === id))
        throw new BusinessError(
          'HOST_CLEANUP_PENDING',
          '该主机还有已删除地图的文件待清理，请连接助手完成清理后再删除主机。',
        );
      if (host.status === 'disconnecting' || isHostOnline(host))
        throw new BusinessError('HOST_DISCONNECT_REQUIRED', '请先断开主机，等待助手释放联机资源。');
      if (
        (await this.db.list('connection-networks', connection)).some(
          (item) => item.controllerHostId === id,
        )
      )
        throw new BusinessError('HOST_HAS_CONNECTIONS', '请先删除或处理该主机上的好友联机入口。');
      await this.db.remove('host-credentials', id, connection);
      await this.db.remove('hosts', id, connection);
      for (const file of await this.db.list('server-files', connection))
        if (file.hostId === id) await this.db.remove('server-files', file.id, connection);
      await this.audit('删除主机', host.name, '已移除主机记录和接入凭据。', connection);
      return null;
    });
  }
  async enroll(code: string, platform: 'windows' | 'linux', agentVersion: string) {
    const located = await this.db.locateEnrollment(hashToken(code));
    if (!located)
      throw new BusinessError('ENROLLMENT_INVALID', '接入码无效或已过期，请在后台重新生成。', 401);
    return runInWorkspace(located.workspaceId, () =>
      this.db.transaction(async (connection) => {
        const secret = await this.db.get('host-credentials', located.hostId, connection);
        if (
          !secret?.codeHash ||
          !tokensEqual(code, secret.codeHash) ||
          secret.codeExpiresAt < nowIso()
        )
          throw new BusinessError(
            'ENROLLMENT_INVALID',
            '接入码无效或已过期，请在后台重新生成。',
            401,
          );
        const host = await this.db.get('hosts', secret.id, connection);
        if (!host) throw new BusinessError('NOT_FOUND', '主机不存在。', 404);
        const token = newToken();
        await this.db.put(
          'host-credentials',
          { ...secret, tokenHash: hashToken(token), codeHash: '', codeExpiresAt: nowIso() },
          connection,
        );
        await this.db.put(
          'hosts',
          {
            ...host,
            platform,
            agentVersion,
            status: 'online',
            lastSeenAt: nowIso(),
            disconnectError: null,
          },
          connection,
        );
        await this.retryHostCleanups(host.id, connection);
        return { hostId: host.id, token };
      }),
    );
  }
  private async requireQuota(kind: 'hosts' | 'instances', connection: Connection) {
    const workspace = await this.db.get('workspaces', this.db.workspaceId, connection);
    const limit = workspace?.limits[kind === 'hosts' ? 'hosts' : 'maps'];
    if (limit != null && (await this.db.list(kind, connection, limit + 1)).length >= limit)
      throw new BusinessError(
        'WORKSPACE_LIMIT',
        kind === 'hosts' ? '工作空间主机数已达上限。' : '工作空间地图数已达上限。',
        409,
      );
  }
  async capacity(hostId: string, maxPlayers: number, mods: number) {
    if (!allowed('maps.create', hostTarget(hostId)))
      requireAccess('hosts.read', hostTarget(hostId));
    const host = await this.db.get('hosts', hostId);
    if (!host) throw new BusinessError('NOT_FOUND', '主机不存在。', 404);
    const onlineHost: Host = {
      ...host,
      status: isHostOnline(host) ? 'online' : 'offline',
    };
    return estimateCapacity(onlineHost, await this.db.list('instances'), maxPlayers, mods);
  }
  async createInstance(input: CreateInstanceInput) {
    requireAccess('maps.create', hostTarget(input.hostId));
    return this.db.transaction(async (connection) => {
      await this.requireQuota('instances', connection);
      if (!(await this.db.get('hosts', input.hostId, connection)))
        throw new BusinessError('NOT_FOUND', '请先添加主机。');
      await this.validateFileSource(input.serverFileSource, input.hostId, connection, input.branch);
      const members = await this.db.list('instances', connection);
      const presets = await this.presetsForCluster(input.clusterId, connection);
      const settings = input.clusterId
        ? await this.db.get('cluster-settings', input.clusterId, connection)
        : null;
      if (
        input.clusterId &&
        (settings || presets.length || members.some((item) => item.clusterId === input.clusterId))
      )
        requireAccess('maps.configure', { kind: 'cluster', clusterId: input.clusterId });
      if (
        input.clusterId &&
        (await this.db.get('cluster-admin-passwords', input.clusterId, connection))
      )
        requireAccess('clusters.admin-password', { kind: 'cluster', clusterId: input.clusterId });
      if (
        input.clusterId &&
        ((settings && settings.branch !== gameBranch(input.branch)) ||
          presets.some((item) => item.branch !== gameBranch(input.branch)) ||
          members.some(
            (item) =>
              item.clusterId === input.clusterId &&
              gameBranch(item.branch) !== gameBranch(input.branch),
          ))
      )
        throw new BusinessError('BRANCH_CONFLICT', '同一互通组需要使用相同 Steam 分支。');
      const id = randomUUID();
      const mapLabel = MAPS.find((item) => item.value === input.map)?.label ?? input.map;
      const name = input.name ?? mapLabel;
      const sessionName =
        input.config.sessionName ?? defaultSteamServerName(name, settings?.serverNamePrefix);
      if (sessionName.length > STEAM_SERVER_NAME_LIMIT)
        throw new BusinessError(
          'SESSION_NAME_TOO_LONG',
          '默认 Steam 服名超过 80 个字符，请填写较短的服名。',
        );
      const instance: Instance = {
        ...input,
        id,
        name,
        mapLabel,
        config: parse(gameConfigSchema, { ...input.config, sessionName }),
        status: 'stopped',
        desiredState: 'stopped',
        installed: false,
        filesTouched: false,
        cpuPercent: 0,
        memoryMb: 0,
        pid: null,
        startedAt: null,
        lastError: null,
        buildId: null,
        createdAt: nowIso(),
      };
      const conflict = validatePortAllocation(instance, members);
      if (conflict) throw new BusinessError('PORT_CONFLICT', conflict);
      await this.db.put('instances', instance, connection);
      await this.db.put(
        'instance-credentials',
        { id, rconPassword: encryptSecret(newToken()) },
        connection,
      );
      await this.audit('创建地图', name, `地图：${mapLabel}，需要安装服务端后启动。`, connection);
      return instance;
    });
  }
  private async presetsForCluster(clusterId: string, connection: Connection) {
    if (!clusterId) return [];
    const records = await this.db.listBy('cluster-presets', 'clusterId', clusterId, connection);
    return records.filter((preset) => preset.clusterId === clusterId);
  }

  async clusterPresetGroups(): Promise<ClusterPresetGroup[]> {
    const [maps, presets, passwords, settings] = await Promise.all([
      this.db.list('instances'),
      this.db.list('cluster-presets'),
      this.db.list('cluster-admin-passwords'),
      this.db.list('cluster-settings'),
    ]);
    const protectedGroups = new Set(passwords.map(({ id }) => id));
    const groups = new Map<
      string,
      {
        branch: ClusterPresetGroup['branch'];
        maps: Instance[];
        presets: ClusterPreset[];
      }
    >();
    for (const map of maps) {
      if (!map.clusterId) continue;
      const group = groups.get(map.clusterId) ?? {
        branch: gameBranch(map.branch),
        maps: [],
        presets: [],
      };
      group.maps.push(map);
      groups.set(map.clusterId, group);
    }
    for (const preset of presets) {
      const group = groups.get(preset.clusterId) ?? {
        branch: preset.branch,
        maps: [],
        presets: [],
      };
      if (group.branch === preset.branch) group.presets.push(preset);
      groups.set(preset.clusterId, group);
    }
    const settingsById = new Map(settings.map((item) => [item.id, item]));
    for (const { id, branch } of settings) {
      if (!groups.has(id)) groups.set(id, { branch, maps: [], presets: [] });
    }
    return [...groups]
      .flatMap(([id, group]) => {
        const target = { kind: 'cluster', clusterId: id } as const;
        const canSave = allowed('maps.configure', target);
        const canLoad =
          canSave || group.maps.some((map) => allowed('maps.configure', instanceTarget(map)));
        const canManagePlugins =
          allowed('plugins.install', target) ||
          group.maps.some((map) => allowed('plugins.install', instanceTarget(map)));
        const canManageAdmin = group.maps.length > 0 && allowed('clusters.admin-password', target);
        if (!canLoad && !canManagePlugins && !canManageAdmin) return [];
        return [
          {
            id,
            branch: group.branch,
            serverNamePrefix: settingsById.get(id)?.serverNamePrefix ?? '',
            presets: canLoad
              ? group.presets.sort(
                  (left, right) =>
                    left.createdAt.localeCompare(right.createdAt) ||
                    left.id.localeCompare(right.id),
                )
              : [],
            mapCount: group.maps.length,
            canJoin:
              canSave && (!protectedGroups.has(id) || allowed('clusters.admin-password', target)),
            canSave,
            canManagePlugins,
            canManageAdmin,
          },
        ];
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async configureCluster(clusterId: string, serverNamePrefix: string) {
    const target = { kind: 'cluster', clusterId } as const;
    requireAccess('maps.configure', target);
    return this.db.transaction(async (connection) => {
      const previous = await this.db.get('cluster-settings', clusterId, connection);
      if (previous?.serverNamePrefix === serverNamePrefix) return previous;
      const members = await this.db.listBy('instances', 'clusterId', clusterId, connection);
      const map = members.find((item) => item.clusterId === clusterId);
      const branch = map
        ? gameBranch(map.branch)
        : (previous?.branch ?? (await this.presetsForCluster(clusterId, connection))[0]?.branch);
      if (!branch) throw new BusinessError('NOT_FOUND', '当前工作空间没有这个互通组。', 404);
      const settings = { id: clusterId, branch, serverNamePrefix };
      await this.db.put('cluster-settings', settings, connection);
      await this.audit('编辑互通组设置', clusterId, '已保存 Steam 服名公共前缀。', connection);
      return settings;
    });
  }

  async saveClusterPreset(clusterId: string, input: SaveClusterPresetInput, operator: Admin) {
    requireAccess('maps.configure', { kind: 'cluster', clusterId });
    if (input.updateMaps && !input.overwrite)
      throw new BusinessError('INVALID_INPUT', '覆盖已有配置时可以选择更新组内地图。');
    return this.db.transaction(async (connection) => {
      const [maps, presets] = await Promise.all([
        this.db.listBy('instances', 'clusterId', clusterId, connection),
        this.presetsForCluster(clusterId, connection),
      ]);
      const members = maps.filter((map) => map.clusterId === clusterId);
      const branch = members[0]
        ? gameBranch(members[0].branch)
        : (presets[0]?.branch ??
          (await this.db.get('cluster-settings', clusterId, connection))?.branch);
      if (!branch) throw new BusinessError('NOT_FOUND', '当前工作空间没有这个互通组。', 404);
      const previous = input.overwrite
        ? presets.find(({ id }) => id === input.overwrite?.id)
        : undefined;
      if (
        input.overwrite &&
        (!previous ||
          previous.kind !== input.kind ||
          previous.branch !== branch ||
          previous.revision !== input.overwrite.revision)
      )
        throw new BusinessError(
          'PRESET_CHANGED',
          '组配置已变化，请重新打开并选择要覆盖的配置。',
          409,
        );
      if (
        presets.some(
          (preset) =>
            preset.kind === input.kind &&
            preset.id !== previous?.id &&
            preset.name.toLowerCase() === input.name.toLowerCase(),
        )
      )
        throw new BusinessError(
          'PRESET_NAME_CONFLICT',
          '这一类组配置已有同名项，请改名或选择覆盖。',
          409,
        );
      const content: ClusterPresetContent =
        input.kind === 'game'
          ? { kind: 'game', config: clusterGameConfig(input.config) }
          : { kind: 'mods', modIds: [...new Set(input.modIds)] };
      const now = nowIso();
      const preset: ClusterPreset = {
        ...content,
        id: previous?.id ?? randomUUID(),
        clusterId,
        branch,
        name: input.name,
        revision: randomUUID(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      await this.db.put('cluster-presets', preset, connection);
      let updatedMaps = 0;
      if (input.updateMaps) {
        for (const before of members) {
          if (gameBranch(before.branch) !== branch)
            throw new BusinessError('BRANCH_CONFLICT', '同一互通组需要使用相同 Steam 分支。');
          const updated = {
            ...before,
            config: parse(gameConfigSchema, applyClusterPreset(before.config, content)),
          };
          const saved = await this.recordConfigChange(
            before,
            updated,
            operator,
            connection,
            '应用互通组配置',
          );
          if (saved.total) {
            // The next launch reads the saved values. Group updates do not enqueue a sync or restart.
            await this.db.put('instances', updated, connection);
            updatedMaps++;
          }
        }
      }
      await this.audit(
        previous ? '覆盖互通组配置' : '新建互通组配置',
        clusterId,
        `${input.kind === 'game' ? '游戏配置' : '模组'} · ${preset.name}${input.updateMaps ? `，${updatedMaps} 张地图下次启动时应用。` : ''}`,
        connection,
      );
      return { preset, updatedMaps };
    });
  }

  async clusterAdminSettings(): Promise<ClusterAdminSettings[]> {
    const [instances, groups, credentials, hosts] = await Promise.all([
      this.db.list('instances'),
      this.db.list('cluster-admin-passwords'),
      this.db.list('instance-credentials'),
      this.db.list('hosts'),
    ]);
    const byGroup = new Map(groups.map((item) => [item.id, item]));
    const byMap = new Map(credentials.map((item) => [item.id, item]));
    const byHost = new Map(hosts.map((item) => [item.id, item]));
    const settings = new Map<string, ClusterAdminSettings>();
    for (const map of instances) {
      const id = map.clusterId;
      if (!id || !allowed('clusters.admin-password', { kind: 'cluster', clusterId: id })) continue;
      const group = byGroup.get(id);
      const item = settings.get(id) ?? { id, updatedAt: group?.updatedAt ?? null, maps: [] };
      const credential = byMap.get(map.id);
      const host = byHost.get(map.hostId);
      let status: ClusterAdminSettings['maps'][number]['status'] = 'individual';
      if (group) {
        status = 'restart';
        if (credential?.clusterAdminRevision === group.revision) {
          status = credential.clusterAdminAppliedAt
            ? 'applied'
            : map.startup?.stage === 'failed' || map.status === 'error'
              ? 'failed'
              : map.status === 'starting'
                ? 'verifying'
                : 'restart';
        }
        if (
          status !== 'applied' &&
          isHostOnline(host) &&
          !host?.features?.includes(CLUSTER_ADMIN_PASSWORD_FEATURE)
        )
          status = 'update-agent';
      }
      item.maps.push({ id: map.id, name: map.name, status });
      settings.set(id, item);
    }
    return [...settings.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
  async configureClusterAdmin(clusterId: string, password: string) {
    return this.db.transaction(async (connection) => {
      requireAccess('clusters.admin-password', { kind: 'cluster', clusterId });
      const maps = await this.db.listBy('instances', 'clusterId', clusterId, connection);
      if (!clusterId || !maps.some((map) => map.clusterId === clusterId))
        throw new BusinessError('NOT_FOUND', '当前工作空间没有这个互通组。', 404);
      const updatedAt = nowIso();
      await this.db.put(
        'cluster-admin-passwords',
        {
          id: clusterId,
          password: encryptSecret(password),
          revision: randomUUID(),
          updatedAt,
        },
        connection,
      );
      await this.audit(
        '设置互通组游戏管理员密码',
        clusterId,
        '组内地图下次启动时应用。',
        connection,
      );
      return { updatedAt };
    });
  }
  private async validateFileSource(
    source: string | undefined,
    hostId: string,
    connection: Connection,
    branch?: string,
  ) {
    if (!source || ['auto', 'download'].includes(source)) return;
    const file = await this.db.get('server-files', source, connection);
    if (
      !file ||
      file.hostId !== hostId ||
      !shareableServerFiles(file) ||
      file.branch !== gameBranch(branch)
    )
      throw new BusinessError(
        'FILES_UNAVAILABLE',
        '请选择同一主机、同一 Steam 分支的可用共享文件。',
      );
    if (
      (
        await this.db.inStates(
          'file-tasks',
          ['queued', 'leased', 'executing', 'cancelling'],
          connection,
        )
      ).some((task) => task.assetId === source || task.payload.sourceId === source)
    )
      throw new BusinessError('FILES_BUSY', '所选文件正在操作，请稍后重试。');
  }
  async updateInstance(
    id: string,
    input: UpdateInstanceInput,
    operator: Admin,
  ): Promise<InstanceUpdateResult> {
    return this.db.transaction(async (connection) => {
      const current = await this.requireInstance(id, connection);
      requireAccess('maps.configure', instanceTarget(current));
      const clusterChanged = input.clusterId !== undefined && input.clusterId !== current.clusterId;
      const targetCluster = input.clusterId ?? current.clusterId;
      const settings =
        targetCluster && (input.clusterId !== undefined || input.branch)
          ? await this.db.get('cluster-settings', targetCluster, connection)
          : null;
      const presets =
        input.clusterId !== undefined || input.branch
          ? await this.presetsForCluster(targetCluster, connection)
          : [];
      if (clusterChanged) {
        for (const clusterId of new Set([current.clusterId, input.clusterId])) {
          if (
            clusterId &&
            ((clusterId === targetCluster && (settings || presets.length > 0)) ||
              (await this.db.listBy('instances', 'clusterId', clusterId, connection)).some(
                (peer) => peer.id !== id,
              ))
          )
            requireAccess('maps.configure', { kind: 'cluster', clusterId });
        }
        if (
          input.clusterId &&
          (await this.db.get('cluster-admin-passwords', input.clusterId, connection))
        )
          requireAccess('clusters.admin-password', { kind: 'cluster', clusterId: input.clusterId });
      }
      if (
        input.branch &&
        gameBranch(input.branch) !== gameBranch(current.branch) &&
        (current.installed || current.filesTouched || current.pid)
      )
        throw new BusinessError(
          'BRANCH_INSTALLED',
          '已安装地图更换分支需要新建实例并按对应版本恢复备份，不能直接覆盖现有存档。',
        );
      if (
        targetCluster &&
        ((settings && settings.branch !== gameBranch(input.branch ?? current.branch)) ||
          presets.some((item) => item.branch !== gameBranch(input.branch ?? current.branch)) ||
          (await this.db.list('instances', connection)).some(
            (item) =>
              item.id !== id &&
              item.clusterId === targetCluster &&
              gameBranch(item.branch) !== gameBranch(input.branch ?? current.branch),
          ))
      )
        throw new BusinessError('BRANCH_CONFLICT', '同一互通组需要使用相同 Steam 分支。');
      if (
        input.serverFileSource !== undefined &&
        input.serverFileSource !== current.serverFileSource
      ) {
        if (current.installed || current.pid || current.serverFileId)
          throw new BusinessError(
            'FILES_ALREADY_PREPARED',
            '此地图已绑定一套服务端文件，请使用重新安装修复，或新建地图选择其他文件。',
          );
        await this.validateFileSource(
          input.serverFileSource,
          current.hostId,
          connection,
          input.branch ?? current.branch,
        );
      }
      if (input.map && input.map !== current.map && current.installed)
        throw new BusinessError(
          'MAP_IMMUTABLE',
          '已安装实例不能直接换地图，请创建新实例以保留存档和部落订阅。',
        );
      if (
        ['starting', 'stopping', 'installing', 'updating', 'restoring', 'deleting'].includes(
          current.status,
        ) ||
        (
          await this.db.inStates(
            'commands',
            ['queued', 'leased', 'executing', 'cancelling'],
            connection,
          )
        ).some((item) => item.instanceId === id && (item.kind === 'delete' || clusterChanged))
      )
        throw new BusinessError('INSTANCE_BUSY', '请等待当前地图任务完成。');
      if (
        (input.gamePort || input.queryPort || input.rconPort || input.clusterId !== undefined) &&
        (current.status !== 'stopped' || !!current.pid)
      )
        throw new BusinessError('STOP_REQUIRED', '修改端口或互通组前请先停止地图。');
      const updated: Instance = {
        ...current,
        ...input,
        mapLabel:
          MAPS.find((item) => item.value === (input.map ?? current.map))?.label ?? current.mapLabel,
      };
      const conflict = validatePortAllocation(updated, await this.db.list('instances', connection));
      if (conflict) throw new BusinessError('PORT_CONFLICT', conflict);
      if (clusterChanged) {
        const credential = await this.db.get('instance-credentials', id, connection);
        if (credential?.clusterAdminRevision !== undefined)
          await this.db.put(
            'instance-credentials',
            { id, rconPassword: encryptSecret(newToken()) },
            connection,
          );
      }
      const syncConfig =
        input.config !== undefined ||
        (input.rconPort !== undefined && input.rconPort !== current.rconPort);
      if (syncConfig) {
        const previous = current.configSyncCommandId
          ? await this.db.get('commands', current.configSyncCommandId, connection)
          : null;
        // An unclaimed task reads the latest instance when leased. An in-flight write needs a successor.
        if (previous?.status !== 'waiting-agent') {
          const task = newInstanceCommand(
            updated,
            { kind: 'sync-config', idempotencyKey: randomUUID() },
            {},
          );
          await this.db.put('commands', task, connection);
          updated.configSyncCommandId = task.id;
        }
      }
      await this.db.put('instances', updated, connection);
      return {
        ...updated,
        configSave: await this.recordConfigChange(current, updated, operator, connection),
      };
    });
  }
  private async recordConfigChange(
    before: Instance,
    after: Instance,
    operator: Admin,
    connection: Connection,
    action = '修改地图配置',
  ) {
    const changes = configurationChanges(before, after);
    const auditId = changes.length ? randomUUID() : null;
    if (auditId) {
      await this.db.put(
        'audit',
        {
          id: auditId,
          actor: `${operator.name} (${operator.email})`,
          actorId: operator.id,
          action,
          target: after.name,
          instanceId: after.id,
          detail: `已保存 ${changes.length} 项配置修改。`,
          changeCount: changes.length,
          createdAt: nowIso(),
        },
        connection,
      );
      await this.db.put('config-audit-details', { id: auditId, changes }, connection);
    }
    return {
      auditId,
      total: changes.length,
      changes: changes.slice(0, CONFIG_CHANGE_PREVIEW_LIMIT),
    };
  }
  async enqueue(
    instanceId: string,
    input: CommandInput,
    connection?: Connection,
  ): Promise<Command> {
    if (!connection)
      return this.db.transaction((transaction) => this.enqueue(instanceId, input, transaction));
    const previous = await this.db.findIdempotentCommand(input.idempotencyKey, connection);
    const terminateStartup = input.kind === 'force-stop' && input.terminateStartup === true;
    if (
      previous?.instanceId === instanceId &&
      previous.kind === input.kind &&
      (previous.payload.terminateStartup === true) === terminateStartup
    ) {
      const current = await this.db.get('instances', instanceId, connection);
      requireAccountAccess(
        commandPermission[input.kind],
        current
          ? instanceTarget(current)
          : {
              kind: 'map',
              instanceId,
              hostId: previous.hostId,
              clusterId: previous.clusterId,
            },
      );
      return previous;
    }
    const instance = await this.requireInstance(instanceId, connection);
    requireAccountAccess(commandPermission[input.kind], instanceTarget(instance));
    if (previous) throw new BusinessError('IDEMPOTENCY_CONFLICT', '重复请求标识与原操作不一致。');
    if (input.kind === 'update') await this.requireSharedUpdateAccess(instance, connection);
    const commands = await this.db.inStates(
      'commands',
      ['queued', 'leased', 'executing', 'cancelling'],
      connection,
    );
    const host = await this.db.get('hosts', instance.hostId, connection);
    if (
      (await this.db.inStates('management-tasks', ['leased', 'executing'], connection)).some(
        (task) => task.instanceId === instanceId,
      )
    )
      throw new BusinessError('MANAGEMENT_BUSY', '用户或商店操作正在执行，请稍后管理地图。');
    const instanceCommands = commands.filter((item) => item.instanceId === instanceId);
    if (terminateStartup) {
      if (instanceCommands.length > 1 || !canTerminateStartup(instance, instanceCommands[0]))
        throw new BusinessError(
          'STARTUP_CHANGED',
          '地图启动状态已变化，请刷新后查看当前操作。',
          409,
        );
    } else if (instanceCommands.length) {
      throw new BusinessError('INSTANCE_BUSY', '该地图已有执行中的任务。');
    }
    const fileId = instance.serverFileId ?? instance.serverFileSource;
    if (input.kind === 'delete' && instance.serverFileId) {
      const updating = new Set(
        commands.filter((item) => item.kind === 'update').map((item) => item.instanceId),
      );
      if (
        updating.size &&
        (await this.db.list('instances', connection)).some(
          (item) =>
            updating.has(item.id) &&
            item.hostId === instance.hostId &&
            item.serverFileId === instance.serverFileId,
        )
      )
        throw new BusinessError('FILES_BUSY', '这套共享文件正在更新，请完成更新后再删除地图。');
    }
    if (
      ['install', 'update', 'start', 'restart', 'restore', 'mods-update', 'delete'].includes(
        input.kind,
      ) &&
      (
        await this.db.inStates(
          'file-tasks',
          ['queued', 'leased', 'executing', 'cancelling'],
          connection,
        )
      ).some(
        (task) =>
          task.hostId === instance.hostId &&
          (task.assetId === instance.id ||
            task.payload.sourceId === instance.id ||
            (!!fileId && (task.assetId === fileId || task.payload.sourceId === fileId))),
      )
    )
      throw new BusinessError('FILES_BUSY', '此地图的服务端文件正在操作，请等待文件任务完成。');
    if (input.kind === 'delete' && canDeleteStoppedInstance(instance)) {
      const needsCleanup =
        instance.installed ||
        !!instance.configFilesTouched ||
        !!instance.buildId ||
        !!instance.startedAt ||
        (instance.filesTouched !== false && host?.platform !== 'unknown');
      const command = newInstanceCommand(instance, input, {
        preserveServerFiles: true,
        countdownSeconds: 0,
        cleanup: needsCleanup,
        removedFromPanel: true,
      });
      if (needsCleanup) {
        const credential = await this.db.get('instance-credentials', instanceId, connection);
        await this.db.put(
          'instance-cleanups',
          {
            id: instanceId,
            hostId: instance.hostId,
            instance: { ...instance, desiredState: 'stopped' },
            rconPassword: credential?.rconPassword ?? '',
            commandId: command.id,
            lastError: null,
          },
          connection,
        );
      } else {
        command.status = 'succeeded';
        command.progress = '未运行地图已删除，未产生需要保留的服务端文件。';
        command.result = { deleted: true };
        command.completedAt = nowIso();
      }
      await removeInstanceResources(this.db, instanceId, connection);
      await this.db.put('commands', command, connection);
      await this.audit(
        '删除未运行地图',
        instance.name,
        needsCleanup ? '地图已移除，助手连接后将回收存档并保留下载文件。' : '地图已直接删除。',
        connection,
      );
      return command;
    }
    if (!host || (!terminateStartup && !isHostOnline(host)))
      throw new BusinessError('HOST_OFFLINE', '主机助手未在线，请先接入或恢复连接。');
    if (
      (['install', 'update', 'delete'].includes(input.kind) ||
        (!!instance.serverFileId && ['start', 'restart'].includes(input.kind))) &&
      !host.features?.includes(SHARED_MAP_FILES_FEATURE)
    )
      throw new BusinessError(
        'AGENT_UPDATE_REQUIRED',
        '请更新并重启游戏电脑上的主机助手，以使用共享地图文件。',
      );
    if (
      instance.serverFileId &&
      ['update', 'start', 'restart', 'install', 'restore', 'mods-update'].includes(input.kind)
    ) {
      const peers = (await this.db.list('instances', connection)).filter(
        (item) =>
          item.id !== instance.id &&
          item.hostId === instance.hostId &&
          item.serverFileId === instance.serverFileId,
      );
      if (
        peers.some((peer) =>
          commands.some(
            (item) =>
              item.instanceId === peer.id &&
              (item.kind === 'update' || input.kind === 'update') &&
              activeCommand(item),
          ),
        )
      )
        throw new BusinessError('FILES_BUSY', '共用此文件的地图有维护任务正在进行。');
      if (
        input.kind === 'update' &&
        peers.some((peer) => peer.pid || !['stopped', 'error'].includes(peer.status))
      )
        throw new BusinessError('FILES_IN_USE', '请先关闭共用这套文件的其他地图。');
    }
    if (
      ['install', 'update'].includes(input.kind) &&
      instance.branch &&
      !host.features?.includes('steam-branches-v1')
    )
      throw new BusinessError(
        'AGENT_UPDATE_REQUIRED',
        '请更新并重启游戏电脑的助手，旧助手不能按所选 Steam 分支安装或更新。',
      );
    if (!instance.installed && !['install', 'stop', 'force-stop', 'delete'].includes(input.kind))
      throw new BusinessError('INSTALL_REQUIRED', '请先安装服务端。');
    if (
      ['install', 'update', 'mods-update', 'restore'].includes(input.kind) &&
      instance.status !== 'stopped' &&
      !(
        ['install', 'update'].includes(input.kind) &&
        instance.status === 'error' &&
        !instance.pid
      ) &&
      !(input.kind === 'update' && input.maintenance && instance.status === 'running')
    )
      throw new BusinessError('STOP_REQUIRED', '此操作需要先停止地图。');
    if (input.kind === 'start' || (input.kind === 'restart' && !instance.pid)) {
      if (instance.status === 'running')
        throw new BusinessError('ALREADY_RUNNING', '地图已经在运行。');
      const pendingStarts = new Set(
        commands
          .filter((item) => ['start', 'restart'].includes(item.kind))
          .map((item) => item.instanceId),
      );
      const instances = (await this.db.list('instances', connection))
        .filter((item) => item.id !== instance.id)
        .map((item): Instance =>
          pendingStarts.has(item.id) && !item.pid ? { ...item, status: 'starting' } : item,
        );
      const settings = effectiveGameConfig(instance.config);
      const estimate = estimateCapacity(
        { ...host, status: 'online' },
        instances,
        settings.maxPlayers,
        settings.modIds.length,
      );
      if (estimate.blockingReasons.length)
        throw new BusinessError('CAPACITY_INSUFFICIENT', estimate.blockingReasons.join(' '));
    }
    if (input.kind === 'restore') {
      const backup = input.backupId
        ? await this.db.get('backups', input.backupId, connection)
        : null;
      if (!backup || backup.instanceId !== instanceId || backup.status !== 'ready')
        throw new BusinessError('BACKUP_INVALID', '请选择当前地图的有效备份。');
      const peers = (await this.db.list('instances', connection)).filter(
        (item) =>
          item.id !== instanceId &&
          instance.clusterId &&
          item.clusterId === instance.clusterId &&
          item.status !== 'stopped',
      );
      if (peers.length)
        throw new BusinessError('CLUSTER_ACTIVE', '恢复存档前请停止同一互通组的所有地图。');
    }
    if (
      ['broadcast', 'kick', 'ban', 'unban', 'players', 'save'].includes(input.kind) &&
      instance.status !== 'running'
    )
      throw new BusinessError('RUNNING_REQUIRED', '此操作需要地图处于运行状态。');
    if (['kick', 'ban', 'unban'].includes(input.kind) && !input.playerId)
      throw new BusinessError('PLAYER_REQUIRED', '缺少玩家 Steam ID。');
    if (input.kind === 'broadcast' && !input.message)
      throw new BusinessError('MESSAGE_REQUIRED', '公告不能为空。');
    const payload: Record<string, Json> = {
      ...(input.kind === 'delete' ? { preserveServerFiles: true } : {}),
      ...(terminateStartup ? { terminateStartup: true } : {}),
      countdownSeconds: input.countdownSeconds,
      maintenance: input.maintenance ?? false,
    };
    if (input.message) payload.message = input.message;
    if (input.playerId) payload.playerId = input.playerId;
    if (input.backupId) payload.backupId = input.backupId;
    const command = newInstanceCommand(instance, input, payload);
    if (terminateStartup) {
      const startup = instanceCommands[0];
      if (startup) {
        const queued = startup.status === 'queued';
        await this.db.put(
          'commands',
          {
            ...startup,
            status: queued ? 'cancelled' : 'cancelling',
            progress: queued ? '已取消排队的启动任务。' : '正在中断启动任务。',
            completedAt: queued ? nowIso() : null,
            leaseUntil: queued ? null : startup.leaseUntil,
          },
          connection,
        );
      }
      command.progress = isHostOnline(host)
        ? '等待主机助手终止启动。'
        : '主机助手恢复连接后将终止启动。';
    }
    await this.db.put('commands', command, connection);
    const desiredState = ['start', 'restart'].includes(input.kind)
      ? 'running'
      : ['stop', 'force-stop', 'delete', 'install'].includes(input.kind)
        ? 'stopped'
        : instance.desiredState;
    const startsNow = input.kind === 'start' || (input.kind === 'restart' && !instance.pid);
    await this.db.put(
      'instances',
      {
        ...instance,
        desiredState,
        ...(terminateStartup ? { status: 'stopping' as const } : {}),
        ...(startsNow ? { status: 'starting' as const, startup: null, lastError: null } : {}),
      },
      connection,
    );
    await this.audit(
      terminateStartup ? '终止地图启动' : `地图操作：${input.kind}`,
      instance.name,
      '任务已排队，完成后更新状态。',
      connection,
    );
    return command;
  }
  async cancelCommand(id: string) {
    return this.db.transaction(async (connection) => {
      const command = await this.db.get('commands', id, connection);
      if (!command || !activeCommand(command))
        throw new BusinessError('COMMAND_FINISHED', '任务已结束。');
      const instance = await requireMapAccess(
        this.db,
        commandPermission[command.kind],
        command.instanceId,
        connection,
      );
      if (command.payload.cleanup === true)
        throw new BusinessError('DELETE_COMMITTED', '地图已删除，待清理的文件任务不能撤销。');
      if (!['stop', 'restart', 'delete'].includes(command.kind))
        throw new BusinessError('CANCEL_UNSUPPORTED', '仅倒计时关闭、重启或删除地图任务支持取消。');
      if (command.result?.stopCommitted === true)
        throw new BusinessError(
          'COUNTDOWN_FINISHED',
          '倒计时已结束，保存或退出已开始，无法再取消。',
          409,
        );
      await this.db.put(
        'commands',
        { ...command, status: command.status === 'queued' ? 'cancelled' : 'cancelling' },
        connection,
      );
      await this.db.put(
        'instances',
        { ...instance, desiredState: instance.status === 'running' ? 'running' : 'stopped' },
        connection,
      );
      return null;
    });
  }
  async retryHostCleanups(hostId: string, connection?: Connection): Promise<null> {
    if (!connection)
      return this.db.transaction((transaction) => this.retryHostCleanups(hostId, transaction));
    if (!(await this.db.get('hosts', hostId, connection)))
      throw new BusinessError('NOT_FOUND', '主机不存在。', 404);
    for (const cleanup of await this.db.list('instance-cleanups', connection)) {
      if (cleanup.hostId !== hostId) continue;
      const previous = await this.db.get('commands', cleanup.commandId, connection);
      if (previous && activeCommand(previous)) continue;
      const command = newInstanceCommand(
        cleanup.instance,
        { kind: 'delete', idempotencyKey: randomUUID() },
        { countdownSeconds: 0, cleanup: true, removedFromPanel: true },
      );
      await this.db.put('commands', command, connection);
      await this.db.put(
        'instance-cleanups',
        { ...cleanup, commandId: command.id, lastError: null },
        connection,
      );
    }
    return null;
  }
  async saveSchedule(
    input: Omit<Schedule, 'id' | 'createdAt' | 'nextRunAt' | 'lastRunAt'>,
    id?: string,
  ) {
    let nextRunAt: string;
    try {
      nextRunAt = CronExpressionParser.parse(input.cron, { tz: input.timezone })
        .next()
        .toISOString()!;
    } catch {
      throw new BusinessError('INVALID_CRON', '计划表达式或时区无效。');
    }
    return this.db.transaction(async (connection) => {
      const existing = id ? await this.db.get('schedules', id, connection) : null;
      if (id && !existing) throw new BusinessError('NOT_FOUND', '计划不存在。', 404);
      if (existing)
        await requireMapAccess(this.db, 'schedules.write', existing.instanceId, connection);
      const instance = await requireMapAccess(
        this.db,
        'schedules.write',
        input.instanceId,
        connection,
      );
      requireAccess(commandPermission[input.kind], instanceTarget(instance));
      if (input.kind === 'update') await this.requireSharedUpdateAccess(instance, connection);
      const schedule: Schedule = {
        ...input,
        id: id ?? randomUUID(),
        nextRunAt,
        lastRunAt: existing?.lastRunAt ?? null,
        createdAt: existing?.createdAt ?? nowIso(),
      };
      await this.db.put('schedules', schedule, connection);
      await this.audit(
        '保存维护计划',
        schedule.name,
        `${schedule.cron}，时区 ${schedule.timezone}`,
        connection,
      );
      return schedule;
    });
  }
  async removeSchedule(id: string) {
    return this.db.transaction(async (connection) => {
      const schedule = await resource(this.db, 'schedules', id, connection);
      await requireMapAccess(this.db, 'schedules.write', schedule.instanceId, connection);
      await this.db.remove('schedules', id, connection);
      return null;
    });
  }

  private async requireSharedUpdateAccess(instance: Instance, connection: Connection) {
    if (!instance.serverFileId || !workspaceContext.getStore()?.actor) return;
    const peers = await this.db.listBy(
      'instances',
      'serverFileId',
      instance.serverFileId,
      connection,
    );
    for (const peer of peers) {
      if (peer.id !== instance.id && peer.hostId === instance.hostId)
        requireAccess('maps.update', instanceTarget(peer));
    }
  }
}
