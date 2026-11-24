import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  gameBranch,
  isHostOnline,
  playerScope,
  SHARED_MAP_FILES_FEATURE,
} from '@ark-control/common';
import type { BranchRollout, Instance } from '@ark-control/common';
import { BusinessError, Database } from '@/infrastructure';
import type { Connection } from '@/infrastructure';
import { ControlService, activeCommand, nowIso } from '@/control';
import { ManagementService } from './management.service';
import { gameTarget, requireAccess } from '@/workspaces/access';

const sharedKey = (instance: Instance) =>
  instance.serverFileId ? `${instance.hostId}:${instance.serverFileId}` : '';

function updateScopes(instances: Instance[]) {
  const remaining = new Set(instances);
  const result: { id: string; name: string; members: Instance[]; scopes: Set<string> }[] = [];
  for (const first of remaining) {
    remaining.delete(first);
    const members = [first];
    for (const member of members)
      for (const next of remaining) {
        if (
          playerScope(member) === playerScope(next) ||
          (sharedKey(member) && sharedKey(member) === sharedKey(next))
        ) {
          remaining.delete(next);
          members.push(next);
        }
      }
    const scopes = new Set(members.map(playerScope));
    result.push({
      id:
        scopes.size === 1
          ? playerScope(first)
          : `shared:${members.map((item) => item.id).sort()[0]}`,
      name: scopes.size === 1 ? first.clusterId || first.name : '共用服务端的地图',
      members,
      scopes,
    });
  }
  return result;
}

@Injectable()
export class BranchUpdatesService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ControlService) private readonly control: ControlService,
    @Inject(ManagementService) private readonly management: ManagementService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(
      () =>
        void this.tick().catch((error: unknown) =>
          console.error('分支与封禁维护：', error instanceof Error ? error.message : '维护失败'),
        ),
      10000,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private async commands(
    rollout: BranchRollout,
    kind: 'stop' | 'update' | 'start',
    instances: Instance[],
    connection: Connection,
  ) {
    const ids: string[] = [];
    const updated = new Set<string>();
    for (const instance of instances) {
      if (kind === 'stop' && !instance.pid && instance.status === 'stopped') continue;
      const key = sharedKey(instance);
      if (kind === 'update' && key) {
        if (updated.has(key)) continue;
        updated.add(key);
      }
      const command = await this.control.enqueue(
        instance.id,
        {
          kind,
          countdownSeconds: kind === 'stop' ? 60 : 0,
          idempotencyKey: randomUUID(),
          maintenance: false,
        },
        connection,
      );
      ids.push(command.id);
    }
    await this.db.put(
      'branch-rollouts',
      { ...rollout, commands: ids, updatedAt: nowIso() },
      connection,
    );
  }
  async retry(id: string) {
    return this.db.transaction(async (connection) => {
      const rollout = await this.db.get('branch-rollouts', id, connection);
      if (!rollout || rollout.phase !== 'failed')
        throw new BusinessError('ROLLOUT_STATE', '只能重试失败的分支更新。');
      const instances = (await this.db.list('instances', connection)).filter((instance) =>
        rollout.instanceIds.includes(instance.id),
      );
      for (const instance of instances) requireAccess('branches.retry', gameTarget(instance));
      if (instances.length !== rollout.instanceIds.length)
        throw new BusinessError('ROLLOUT_CHANGED', '组内地图已发生变化，请手动核对版本。');
      const scope = updateScopes(await this.db.list('instances', connection)).find(
        (item) => item.id === rollout.scopeId,
      );
      if (
        !scope ||
        scope.members.length !== instances.length ||
        scope.members.some((item) => !rollout.instanceIds.includes(item.id))
      )
        throw new BusinessError('ROLLOUT_CHANGED', '共用文件或互通组已变化，请手动核对版本。');
      const next = {
        ...rollout,
        phase: 'stopping' as const,
        commands: [],
        error: null,
        updatedAt: nowIso(),
      };
      const hosts = await this.db.list('hosts', connection);
      const latest = instances.map(
        (instance) =>
          hosts
            .find((host) => host.id === instance.hostId)
            ?.branchBuilds?.find(
              (build) =>
                build.branch === gameBranch(instance.branch) &&
                Date.now() - Date.parse(build.checkedAt) < 3600000,
            )?.buildId,
      );
      if (latest.every(Boolean) && new Set(latest).size === 1) next.buildId = latest[0]!;
      await this.commands(next, 'stop', instances, connection);
      await this.control.audit('重试互通组分支更新', rollout.scopeId, rollout.buildId, connection);
      return next;
    });
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.forEachActiveWorkspace(() => this.tickWorkspace());
    } finally {
      this.busy = false;
    }
  }
  private async tickWorkspace() {
    // Expiry queues unban tasks. Ordinary clients are released immediately; offline maps stay pending.
    await this.management.recoverLeases();
    await this.management.expireBans().catch(() => undefined);
    await this.db.transaction(async (connection) => {
      const instances = await this.db.list('instances', connection);
      const hosts = await this.db.list('hosts', connection);
      const rollouts = await this.db.list('branch-rollouts', connection);
      const commands = await this.db.list('commands', connection);
      const scopes = updateScopes(instances);
      for (const rollout of rollouts.filter(
        (item) => !['succeeded', 'failed'].includes(item.phase),
      )) {
        try {
          const members = scopes.find((item) => item.id === rollout.scopeId)?.members ?? [];
          if (
            members.length !== rollout.instanceIds.length ||
            members.some((instance) => !rollout.instanceIds.includes(instance.id))
          )
            throw new Error('互通组地图已变动，自动更新暂停。');
          const jobs = rollout.commands.map((id) => commands.find((command) => command.id === id));
          if (jobs.some((job) => !job || ['failed', 'cancelled'].includes(job.status)))
            throw new Error('组内更新任务失败；已暂停后续启动，请查看地图任务日志。');
          if (jobs.some((job) => job?.status !== 'succeeded')) continue;
          if (rollout.phase === 'stopping')
            await this.commands({ ...rollout, phase: 'updating' }, 'update', members, connection);
          else if (rollout.phase === 'updating') {
            if (members.some((instance) => instance.buildId !== rollout.buildId)) {
              const completed = Math.max(
                ...jobs.map((job) => Date.parse(job?.completedAt ?? rollout.updatedAt)),
              );
              if (Date.now() - completed > 2 * 60000)
                throw new Error(
                  'SteamCMD 返回成功后，报告的服务端 BuildID 仍与分支不符；请核对 Steam 下载结果。',
                );
              continue;
            }
            await this.commands(
              { ...rollout, phase: 'starting' },
              'start',
              members.filter((instance) => rollout.resumeIds.includes(instance.id)),
              connection,
            );
          } else
            await this.db.put(
              'branch-rollouts',
              { ...rollout, phase: 'succeeded', updatedAt: nowIso() },
              connection,
            );
        } catch (error) {
          await this.db.put(
            'branch-rollouts',
            {
              ...rollout,
              phase: 'failed',
              error: error instanceof Error ? error.message : '分支更新失败',
              updatedAt: nowIso(),
            },
            connection,
          );
        }
      }
      for (const scope of scopes) {
        const members = scope.members;
        const ids = members.map((instance) => instance.id);
        if (
          members.some(
            (instance) =>
              !instance.installed ||
              !instance.autoBranchUpdate ||
              !instance.buildId ||
              !['running', 'stopped'].includes(instance.status),
          )
        )
          continue;
        if (
          members.some((instance) => {
            const host = hosts.find((item) => item.id === instance.hostId);
            return (
              !host || !isHostOnline(host) || !host.features?.includes(SHARED_MAP_FILES_FEATURE)
            );
          })
        )
          continue;
        if (commands.some((command) => ids.includes(command.instanceId) && activeCommand(command)))
          continue;
        if (
          (
            await this.db.inStates(
              'management-tasks',
              ['queued', 'leased', 'executing', 'uncertain'],
              connection,
            )
          ).some((task) => scope.scopes.has(task.scopeId))
        )
          continue;
        const builds = members.map(
          (instance) =>
            hosts
              .find((host) => host.id === instance.hostId)
              ?.branchBuilds?.find(
                (build) =>
                  build.branch === gameBranch(instance.branch) &&
                  Date.now() - Date.parse(build.checkedAt) < 3600000,
              )?.buildId,
        );
        if (
          builds.some((build) => !build) ||
          new Set(builds).size !== 1 ||
          members.every((instance) => instance.buildId === builds[0])
        )
          continue;
        if (
          rollouts.some(
            (rollout) =>
              rollout.scopeId === scope.id &&
              (rollout.buildId === builds[0] || !['succeeded', 'failed'].includes(rollout.phase)),
          )
        )
          continue;
        const rollout: BranchRollout = {
          id: randomUUID(),
          scopeId: scope.id,
          buildId: builds[0]!,
          phase: 'stopping',
          instanceIds: ids,
          resumeIds: members
            .filter((instance) => !!instance.pid || instance.desiredState === 'running')
            .map((instance) => instance.id),
          commands: [],
          error: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        try {
          await this.commands(rollout, 'stop', members, connection);
          await this.control.audit(
            '自动更新 Steam 分支',
            scope.name,
            `服务端 BuildID ${rollout.buildId}；全组停服、备份更新、恢复运行`,
            connection,
          );
        } catch (error) {
          await this.db.put(
            'branch-rollouts',
            {
              ...rollout,
              phase: 'failed',
              error: error instanceof Error ? error.message : '无法开始更新',
            },
            connection,
          );
        }
      }
    });
  }
}
