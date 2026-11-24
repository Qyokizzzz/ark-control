import { Inject, Injectable } from '@nestjs/common';
import {
  ARKSHOP_UI_PLUGIN_FEATURE,
  CONFIG_SYNC_FEATURE,
  SERVER_PLUGINS_FEATURE,
  SHARED_MAP_FILES_FEATURE,
  effectiveGameConfig,
  independentShopFeature,
  pluginPlanSchema,
  pluginReportSchema,
  playerScope,
} from '@ark-control/common';
import type {
  AgentInstance,
  AgentPoll,
  ConsoleEntry,
  InstanceReport,
  Json,
  ResourceMetrics,
  ConnectionReport,
  ServerFiles,
  BranchBuild,
} from '@ark-control/common';
import { createHash, randomUUID } from 'node:crypto';
import { BusinessError, Database, decryptSecret } from '@/infrastructure';
import type { Connection } from '@/infrastructure';
import { activeCommand, nowIso } from '@/control';
import { ConnectionsService } from '@/connections';
import { removeInstanceResources } from '@/control/lifecycle';
import { ServerFilesService } from '@/server-files';

@Injectable()
export class AgentsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ConnectionsService) private readonly connections: ConnectionsService,
    @Inject(ServerFilesService) private readonly files: ServerFilesService,
  ) {}
  private async instances(hostId: string, connection: Connection): Promise<AgentInstance[]> {
    const results: AgentInstance[] = [];
    const configured = new Set(
      (await this.db.list('cluster-admin-passwords', connection)).map(({ id }) => id),
    );
    for (const instance of await this.db.list('instances', connection)) {
      if (instance.hostId !== hostId) continue;
      const credential = await this.db.get('instance-credentials', instance.id, connection);
      const shopMode = (await this.db.get('shop-modes', playerScope(instance), connection))?.mode;
      results.push(
        this.withCredential(
          {
            ...instance,
            shopMode,
            useClusterAdminPassword: configured.has(instance.clusterId),
            clusterAdminRevision: credential?.clusterAdminRevision,
          },
          credential?.rconPassword,
        ),
      );
    }
    return results;
  }
  private withCredential(
    instance: AgentInstance | Omit<AgentInstance, 'rconPassword'>,
    encrypted?: string,
  ): AgentInstance {
    const runtimeClusterId = instance.clusterId
      ? 'ark-' +
        createHash('sha256')
          .update(`${this.db.workspaceId}\0${instance.clusterId}`)
          .digest('hex')
          .slice(0, 32)
      : undefined;
    const config = {
      ...instance.config,
      serverPassword: effectiveGameConfig(instance.config).serverPassword,
    };
    try {
      if (!encrypted) throw new Error('missing');
      return { ...instance, config, runtimeClusterId, rconPassword: decryptSecret(encrypted) };
    } catch {
      return {
        ...instance,
        config,
        runtimeClusterId,
        rconPassword: '',
        credentialError: `地图「${instance.name}」的管理凭据缺失或无法解密，请检查后台是否保留原 ENCRYPTION_KEY；该问题不会阻断主机连接。`,
      };
    }
  }
  async poll(hostId: string, features: string[] = []): Promise<AgentPoll> {
    const supportsFiles = features.includes(SHARED_MAP_FILES_FEATURE);
    const supportsConfigSync = features.includes(CONFIG_SYNC_FEATURE);
    const supportsPlugins = features.includes(SERVER_PLUGINS_FEATURE);
    return this.db.transaction(async (connection) => {
      const instances = await this.instances(hostId, connection);
      const host = await this.db.get('hosts', hostId, connection);
      if (!host || host.status === 'disconnected')
        throw new BusinessError('AGENT_UNAUTHORIZED', '主机已断开，请重新接入。', 401);
      if (host?.status === 'disconnecting')
        return {
          instances,
          commands: [],
          cancellations: [
            ...(await this.db.inStates(
              'commands',
              ['leased', 'executing', 'cancelling'],
              connection,
            )),
            ...(await this.db.inStates(
              'file-tasks',
              ['leased', 'executing', 'cancelling'],
              connection,
            )),
          ]
            .filter((item) => item.hostId === hostId)
            .map((item) => item.id),
          connections: [],
          disconnectRequested: true,
        };
      const now = nowIso();
      const all = (
        await this.db.inStates(
          'commands',
          ['waiting-agent', 'queued', 'leased', 'executing', 'cancelling'],
          connection,
        )
      ).filter((item) => item.hostId === hostId);
      for (const item of all)
        if (
          ['leased', 'executing', 'cancelling'].includes(item.status) &&
          item.leaseUntil &&
          item.leaseUntil < now
        ) {
          if (item.kind === 'sync-config') {
            const latest = instances.find(
              (instance) => instance.id === item.instanceId,
            )?.configSyncCommandId;
            item.status = latest === item.id ? 'waiting-agent' : 'cancelled';
            item.progress =
              latest === item.id ? '等待主机重新确认配置写入。' : '已有更新的配置或地图已删除。';
          } else {
            item.status =
              item.status === 'leased' || item.payload.cleanup === true ? 'queued' : 'failed';
          }
          item.completedAt = ['failed', 'cancelled'].includes(item.status) ? now : null;
          item.error =
            item.status === 'failed'
              ? '主机任务失去响应，实际进程状态需要核对；未自动重复执行。'
              : null;
          item.leaseUntil = null;
          await this.db.put('commands', item, connection);
        }
      for (const item of all) {
        if (item.kind !== 'install-plugins' || item.status !== 'queued') continue;
        const plan = pluginPlanSchema.safeParse(item.payload);
        const needsArkShopUi =
          plan.success && plan.data.items.some(({ pluginId }) => pluginId === 'arkshop-ui');
        if (supportsPlugins && (!needsArkShopUi || features.includes(ARKSHOP_UI_PLUGIN_FEATURE)))
          continue;
        item.status = 'failed';
        item.error = '主机助手版本过旧，请更新并重启后重新安装。';
        item.completedAt = now;
        await this.db.put('commands', item, connection);
      }
      const managed = new Set(
        (await this.db.inStates('management-tasks', ['leased', 'executing'], connection)).map(
          (task) => task.instanceId,
        ),
      );
      let candidate = all
        .filter(
          (item) =>
            (item.status === 'queued' || (item.status === 'waiting-agent' && supportsConfigSync)) &&
            !managed.has(item.instanceId) &&
            !all.some(
              (other) =>
                other.instanceId === item.instanceId &&
                other.id !== item.id &&
                ['leased', 'executing', 'cancelling'].includes(other.status),
            ),
        )
        .sort(
          (a, b) =>
            Number(b.payload.terminateStartup === true) -
              Number(a.payload.terminateStartup === true) || a.createdAt.localeCompare(b.createdAt),
        )[0];
      const commands: AgentPoll['commands'] = [];
      const requiresUpdate =
        !!candidate &&
        !supportsFiles &&
        (['install', 'update', 'delete'].includes(candidate.kind) ||
          (['start', 'restart'].includes(candidate.kind) &&
            !!instances.find((item) => item.id === candidate?.instanceId)?.serverFileId));
      if (candidate && requiresUpdate) {
        await this.db.put(
          'commands',
          {
            ...candidate,
            progress: '请更新并重启主机助手后继续；旧版助手不能管理共享地图文件。',
          },
          connection,
        );
        candidate = undefined;
      }
      if (candidate) {
        let instance = instances.find((item) => item.id === candidate.instanceId);
        if (
          instance?.shopMode === 'independent' &&
          (['start', 'restart'].includes(candidate.kind) ||
            candidate.payload.maintenance === true) &&
          !features.includes(independentShopFeature)
        ) {
          await this.db.put(
            'commands',
            {
              ...candidate,
              status: 'failed',
              error: '请更新并重启主机助手，以使用独立商店。',
              progress: '旧版主机助手无法启动使用独立商店的地图。',
              completedAt: nowIso(),
              leaseUntil: null,
            },
            connection,
          );
          instance = undefined;
        }
        if (!instance && candidate.kind === 'delete' && candidate.payload.cleanup === true) {
          const cleanup = await this.db.get('instance-cleanups', candidate.instanceId, connection);
          if (cleanup?.hostId === hostId && cleanup.commandId === candidate.id)
            instance = this.withCredential(cleanup.instance, cleanup.rconPassword);
        }
        if (
          instance?.credentialError &&
          !['install', 'install-plugins', 'stop', 'force-stop', 'delete'].includes(candidate.kind)
        ) {
          await this.db.put(
            'commands',
            {
              ...candidate,
              status: 'failed',
              error: instance.credentialError,
              progress: '地图管理凭据不可用，操作未下发。',
              completedAt: nowIso(),
              leaseUntil: null,
            },
            connection,
          );
          instance = undefined;
        }
        if (instance) {
          if (candidate.kind === 'sync-config' && !instance.configFilesTouched) {
            // A never-installed map may now have private INIs to recycle on deletion.
            const live = await this.db.get('instances', instance.id, connection);
            if (live)
              await this.db.put('instances', { ...live, configFilesTouched: true }, connection);
          } else if (
            ['install', 'update', 'start', 'restart', 'restore', 'mods-update'].includes(
              candidate.kind,
            )
          ) {
            const live = await this.db.get('instances', instance.id, connection);
            if (live) await this.db.put('instances', { ...live, filesTouched: true }, connection);
          }
          const command = {
            ...candidate,
            status: 'leased' as const,
            leaseUntil: new Date(Date.now() + 30000).toISOString(),
          };
          await this.db.put('commands', command, connection);
          commands.push({ ...command, instance });
        }
      }
      const warnings = instances.flatMap((item) =>
        item.credentialError ? [item.credentialError] : [],
      );
      if (requiresUpdate) warnings.push('旧版助手不支持共享地图文件，请更新后继续任务。');
      const connectionConfigs = await this.connections.agentConfigurations(
        hostId,
        connection,
        warnings,
      );
      return {
        fileTasks: supportsFiles ? await this.files.poll(hostId, connection) : [],
        instances,
        connections: connectionConfigs,
        warnings,
        commands,
        cancellations: [
          ...all.filter((item) => item.status === 'cancelling'),
          ...(await this.db.inStates('file-tasks', ['cancelling'], connection)).filter(
            (item) => item.hostId === hostId,
          ),
        ].map((item) => item.id),
      };
    });
  }
  async heartbeat(
    hostId: string,
    metrics: ResourceMetrics,
    reports: InstanceReport[],
    runningCommands: string[],
    entries: Omit<ConsoleEntry, 'id' | 'createdAt'>[],
    connections: ConnectionReport[] = [],
    warnings: string[] = [],
    features?: string[],
    serverFiles?: ServerFiles[],
    filesScanComplete = false,
    branchBuilds?: BranchBuild[],
  ) {
    await this.db.transaction(async (connection) => {
      const host = await this.db.get('hosts', hostId, connection);
      if (!host) throw new BusinessError('NOT_FOUND', '主机不存在。', 404);
      if (host.status === 'disconnected')
        throw new BusinessError('AGENT_UNAUTHORIZED', '主机已断开，请重新接入。', 401);
      await this.db.put(
        'hosts',
        {
          ...host,
          ...(branchBuilds ? { branchBuilds } : {}),
          status: host.status === 'disconnecting' ? 'disconnecting' : 'online',
          metrics,
          agentWarnings: warnings,
          ...(features ? { features } : {}),
          connections,
          lastSeenAt: nowIso(),
        },
        connection,
      );
      await this.files.heartbeat(
        hostId,
        serverFiles,
        filesScanComplete,
        runningCommands,
        connection,
      );
      const instances = await this.db.list('instances', connection);
      const owned = new Set(
        instances.filter((item) => item.hostId === hostId).map((item) => item.id),
      );
      for (const report of reports) {
        const instance = instances.find((item) => item.id === report.id && item.hostId === hostId);
        if (!instance) continue;
        const { plugins, verifiedClusterAdminRevision, ...processReport } = report;
        await this.db.put(
          'instances',
          {
            ...instance,
            ...processReport,
            ...(plugins && (!instance.plugins || plugins.checkedAt >= instance.plugins.checkedAt)
              ? { plugins }
              : {}),
          },
          connection,
        );
        if (
          verifiedClusterAdminRevision &&
          report.pid &&
          report.status === 'running' &&
          report.startup?.rconReady
        )
          await this.confirmLaunchCredential(instance.id, verifiedClusterAdminRevision, connection);
      }
      for (const id of runningCommands) {
        const command = await this.db.get('commands', id, connection);
        if (command?.hostId === hostId && activeCommand(command))
          await this.db.put(
            'commands',
            { ...command, leaseUntil: new Date(Date.now() + 120000).toISOString() },
            connection,
          );
      }
      for (const entry of entries)
        if (owned.has(entry.instanceId))
          await this.db.put(
            'console',
            { ...entry, id: randomUUID(), text: entry.text.slice(0, 3000), createdAt: nowIso() },
            connection,
          );
    });
  }
  async acknowledge(
    hostId: string,
    id: string,
    status: 'executing' | 'succeeded' | 'failed' | 'cancelled',
    progress: string,
    result: Record<string, Json> | null,
    error: string | null,
  ) {
    return this.db.transaction(async (connection) => {
      const command = await this.db.get('commands', id, connection);
      if (!command || command.hostId !== hostId)
        throw new BusinessError('NOT_FOUND', '任务不存在。', 404);
      if (!activeCommand(command))
        throw new BusinessError('LEASE_EXPIRED', '任务已结束或租约失效，请核对状态。');
      if (command.status === 'cancelling' && status === 'executing') return null;
      if (
        command.kind === 'force-stop' &&
        command.payload.terminateStartup === true &&
        status === 'succeeded'
      ) {
        if (result?.stopped !== true)
          throw new BusinessError('STOP_UNCONFIRMED', '主机助手尚未确认游戏进程退出。', 409);
        const instance = await this.db.get('instances', command.instanceId, connection);
        if (instance?.hostId === hostId)
          await this.db.put(
            'instances',
            {
              ...instance,
              status: 'stopped',
              desiredState: 'stopped',
              pid: null,
              startedAt: null,
              startup: null,
              lastError: null,
              cpuPercent: 0,
              memoryMb: 0,
            },
            connection,
          );
      }
      if (
        command.kind === 'sync-config' &&
        status === 'succeeded' &&
        (result?.verified !== true ||
          typeof result.settingsPath !== 'string' ||
          typeof result.gamePath !== 'string')
      )
        throw new BusinessError('CONFIG_UNCONFIRMED', '助手尚未回读确认两份配置文件。', 409);
      if (command.kind === 'install-plugins' && status === 'succeeded') {
        const receipt = pluginReportSchema.safeParse(result?.plugins);
        const plan = pluginPlanSchema.safeParse(command.payload);
        if (
          !receipt.success ||
          receipt.data.pid !== null ||
          !plan.success ||
          !plan.data.items.every(({ pluginId }) => receipt.data.installed.includes(pluginId))
        )
          throw new BusinessError('PLUGIN_UNCONFIRMED', '助手尚未回读确认插件安装结果。', 409);
        const instance = await this.db.get('instances', command.instanceId, connection);
        if (
          instance?.hostId === hostId &&
          (!instance.plugins || receipt.data.checkedAt >= instance.plugins.checkedAt)
        )
          await this.db.put('instances', { ...instance, plugins: receipt.data }, connection);
      }
      if (command.kind === 'delete' && status === 'succeeded') {
        if (result?.deleted !== true)
          throw new BusinessError('DELETE_INCOMPLETE', '助手尚未确认地图资源清理完成。', 409);
        await removeInstanceResources(this.db, command.instanceId, connection);
        await this.db.remove('instance-cleanups', command.instanceId, connection);
        await this.db.put(
          'audit',
          {
            id: randomUUID(),
            actor: '主机助手',
            action: '删除地图完成',
            target: command.instanceId,
            detail: `已停服并保留已下载文件：${String(result.retainedDirectory ?? '无文件')}；存档回收位置：${String(result.savedArchive ?? '无存档')}。`,
            createdAt: nowIso(),
          },
          connection,
        );
      }
      if (
        command.payload.cleanup === true &&
        ['failed', 'cancelled', 'executing'].includes(status)
      ) {
        const cleanup = await this.db.get('instance-cleanups', command.instanceId, connection);
        if (cleanup?.commandId === command.id)
          await this.db.put(
            'instance-cleanups',
            {
              ...cleanup,
              lastError: status === 'executing' ? null : (error ?? '文件清理尚未完成。'),
            },
            connection,
          );
      }
      await this.db.put(
        'commands',
        {
          ...command,
          status,
          progress,
          result: status === 'executing' && result === null ? command.result : result,
          error,
          completedAt: status === 'executing' ? null : nowIso(),
          leaseUntil: status === 'executing' ? new Date(Date.now() + 120000).toISOString() : null,
        },
        connection,
      );
      const revision = command.payload.clusterAdminRevision;
      if (status === 'succeeded' && typeof revision === 'string')
        await this.confirmLaunchCredential(command.instanceId, revision, connection);
      return null;
    });
  }
  private async confirmLaunchCredential(mapId: string, revision: string, connection: Connection) {
    const credential = await this.db.get('instance-credentials', mapId, connection);
    if (credential?.clusterAdminRevision === revision && !credential.clusterAdminAppliedAt)
      await this.db.put(
        'instance-credentials',
        { ...credential, clusterAdminAppliedAt: nowIso() },
        connection,
      );
  }
  async launchCredential(hostId: string, id: string) {
    return this.db.transaction(async (connection) => {
      const command = await this.db.get('commands', id, connection);
      if (
        !command ||
        command.hostId !== hostId ||
        command.status !== 'executing' ||
        !command.leaseUntil ||
        command.leaseUntil < nowIso() ||
        !(
          ['start', 'restart'].includes(command.kind) ||
          (command.kind === 'update' && command.payload.maintenance === true)
        )
      )
        throw new BusinessError('COMMAND_INVALID', '地图启动任务不存在或已结束。', 409);
      const map = await this.db.get('instances', command.instanceId, connection);
      if (!map?.clusterId || map.hostId !== hostId)
        throw new BusinessError('NOT_FOUND', '没有可应用的互通组密码。', 404);
      const group = await this.db.get('cluster-admin-passwords', map.clusterId, connection);
      const previous = await this.db.get('instance-credentials', map.id, connection);
      if (!group || !previous)
        throw new BusinessError('NOT_FOUND', '没有可应用的互通组密码。', 404);

      if (
        command.payload.clusterAdminRevision === previous.clusterAdminRevision &&
        previous.clusterAdminRevision !== undefined
      ) {
        return {
          rconPassword: decryptSecret(previous.rconPassword),
          revision: previous.clusterAdminRevision,
        };
      }
      // The helper calls this after confirming the old game process has exited.
      const rconPassword = decryptSecret(group.password);
      if (previous.clusterAdminRevision !== group.revision) {
        await this.db.put(
          'instance-credentials',
          {
            id: map.id,
            rconPassword: group.password,
            clusterAdminRevision: group.revision,
            clusterAdminAppliedAt: null,
          },
          connection,
        );
      }
      await this.db.put(
        'commands',
        {
          ...command,
          payload: { ...command.payload, clusterAdminRevision: group.revision },
        },
        connection,
      );
      return { rconPassword, revision: group.revision };
    });
  }
  async commitStop(hostId: string, id: string) {
    return this.db.transaction(async (connection) => {
      const command = await this.db.get('commands', id, connection);
      if (
        !command ||
        command.hostId !== hostId ||
        !['stop', 'restart', 'update', 'delete'].includes(command.kind) ||
        !activeCommand(command)
      )
        throw new BusinessError('COMMAND_INVALID', '停服任务不存在或已结束。', 409);
      if (command.status === 'cancelling') return { cancelled: true };
      await this.db.put(
        'commands',
        {
          ...command,
          result: { ...command.result, stopCommitted: true },
          progress: '倒计时已结束，正在保存世界。',
          leaseUntil: new Date(Date.now() + 120000).toISOString(),
        },
        connection,
      );
      return { cancelled: false };
    });
  }
  async completeDisconnect(hostId: string, reports: InstanceReport[], error: string | null) {
    return this.db.transaction(async (connection) => {
      const host = await this.db.get('hosts', hostId, connection);
      if (!host || host.status !== 'disconnecting')
        throw new BusinessError('DISCONNECT_INVALID', '没有待完成的主机断开操作。', 409);
      const owned = (await this.db.list('instances', connection)).filter(
        (item) => item.hostId === hostId,
      );
      if (
        !error &&
        owned.some(
          (item) =>
            !reports.some(
              (report) =>
                report.id === item.id &&
                report.status === 'stopped' &&
                report.pid === null &&
                report.memoryMb === 0,
            ),
        )
      )
        throw new BusinessError('HOST_STILL_RUNNING', '仍有地图未确认停止，不能完成断开。', 409);
      for (const instance of owned) {
        const report = reports.find((item) => item.id === instance.id);
        if (report) {
          const processReport = { ...report };
          delete processReport.verifiedClusterAdminRevision;
          await this.db.put(
            'instances',
            { ...instance, ...processReport, desiredState: 'stopped' },
            connection,
          );
        }
      }
      await this.db.put(
        'hosts',
        {
          ...host,
          status: error ? 'online' : 'disconnected',
          disconnectError: error,
          metrics: error ? host.metrics : null,
          connections: [],
          lastSeenAt: error ? nowIso() : null,
        },
        connection,
      );
      if (!error) {
        const credential = await this.db.get('host-credentials', hostId, connection);
        if (credential)
          await this.db.put(
            'host-credentials',
            { ...credential, tokenHash: null, codeHash: '', codeExpiresAt: nowIso() },
            connection,
          );
      }
      return { disconnected: !error };
    });
  }
}
