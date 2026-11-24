import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  isHostOnline,
  reservesServerFiles,
  SHARED_MAP_FILES_FEATURE,
  usesServerFiles,
} from '@ark-control/common';
import type { AgentFileTask, FileTask, Json, ServerFiles } from '@ark-control/common';
import type { z } from 'zod';
import type { fileTaskSchema } from '@ark-control/common';
import { BusinessError, Database } from '@/infrastructure';
import type { Connection } from '@/infrastructure';
import { hostTarget, requireAccess } from '@/workspaces/access';

const now = () => new Date().toISOString();
const active = (task: { status: string }) =>
  ['queued', 'leased', 'executing', 'cancelling'].includes(task.status);
export const FILES_FEATURE = SHARED_MAP_FILES_FEATURE;
@Injectable()
export class ServerFilesService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async enqueue(input: z.infer<typeof fileTaskSchema>) {
    requireAccess('files.manage', hostTarget(input.hostId));
    return this.db.transaction(async (connection) => {
      const previous = (await this.db.list('file-tasks', connection)).find(
        (item) => item.idempotencyKey === input.idempotencyKey,
      );
      if (previous) {
        if (
          previous.hostId !== input.hostId ||
          previous.kind !== input.kind ||
          previous.payload.requestAssetId !== (input.assetId ?? null)
        )
          throw new BusinessError('IDEMPOTENCY_CONFLICT', '重复请求标识与原文件操作不一致。');
        return previous;
      }
      const host = await this.db.get('hosts', input.hostId, connection);
      if (!host || !isHostOnline(host) || ['disconnecting', 'disconnected'].includes(host.status))
        throw new BusinessError('HOST_OFFLINE', '请先连接文件所在的主机。');
      if (!host.features?.includes(FILES_FEATURE))
        throw new BusinessError(
          'AGENT_UPDATE_REQUIRED',
          '请更新并重启游戏主机的助手，旧版不支持文件独立管理。',
        );
      if (
        ['download', 'verify', 'update'].includes(input.kind) &&
        input.branch &&
        !host.features?.includes('steam-branches-v1')
      )
        throw new BusinessError(
          'AGENT_UPDATE_REQUIRED',
          '请更新主机助手后再安装或校验指定 Steam 分支。',
        );
      let asset = input.assetId
        ? await this.db.get('server-files', input.assetId, connection)
        : null;
      const creates = ['download', 'import', 'clone'].includes(input.kind);
      if (
        !['scan', 'download', 'import'].includes(input.kind) &&
        (!asset || asset.hostId !== host.id || asset.status === 'deleted')
      )
        throw new BusinessError('FILES_NOT_FOUND', '所选服务端文件不存在或不属于此主机。');
      if (input.kind === 'import' && !input.sourcePath)
        throw new BusinessError('PATH_REQUIRED', '请输入已有专用服务端根目录的完整路径。');
      if (input.kind === 'rename' && !input.name)
        throw new BusinessError('NAME_REQUIRED', '请输入文件名称。');
      await this.validateOperation(host.id, input.kind, asset, connection);
      const source = input.kind === 'clone' ? asset : null;
      if (creates) {
        asset = {
          branch:
            input.kind === 'clone'
              ? (source?.branch ?? 'unknown')
              : input.kind === 'import'
                ? 'unknown'
                : (input.branch ?? 'public'),
          id: randomUUID(),
          hostId: host.id,
          name: input.name ?? (source ? `${source.name} · 副本`.slice(0, 100) : 'ASE 专用服务端'),
          path: '',
          platform: host.platform === 'linux' ? 'linux' : 'windows',
          status: 'busy',
          instanceId: null,
          instanceIds: [],
          sizeBytes: 0,
          fileCount: 0,
          buildId: source?.buildId ?? null,
          origin: input.kind === 'import' ? 'import' : input.kind === 'clone' ? 'copy' : 'download',
          sourceId: source?.id ?? null,
          verifiedAt: null,
          lastError: null,
          createdAt: now(),
          updatedAt: now(),
        };
        await this.db.put('server-files', asset, connection);
      }
      const task: FileTask = {
        id: randomUUID(),
        hostId: host.id,
        assetId: asset?.id ?? null,
        kind: input.kind,
        payload: {
          ...(input.branch ? { branch: input.branch } : {}),
          requestAssetId: input.assetId ?? null,
          sourceId: source?.id ?? null,
          assetName: asset?.name ?? '扫描主机文件',
          previousStatus: asset?.status ?? 'ready',
          ...(input.name ? { name: input.name } : {}),
          ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
        },
        status: 'queued',
        progress: '已加入主机文件任务队列',
        error: null,
        result: null,
        idempotencyKey: input.idempotencyKey,
        leaseUntil: null,
        createdAt: now(),
        completedAt: null,
      };
      await this.db.put('file-tasks', task, connection);
      await this.audit(task, '提交文件操作', connection);
      return task;
    });
  }
  private async validateOperation(
    hostId: string,
    kind: FileTask['kind'],
    asset: ServerFiles | null,
    connection: Connection,
    destinationId?: string | null,
  ) {
    const ids = [asset?.id, destinationId].filter((id): id is string => !!id);
    const fileTasks = await this.db.inStates(
      'file-tasks',
      ['queued', 'leased', 'executing', 'cancelling'],
      connection,
    );
    if (
      ids.length &&
      fileTasks.some(
        (task) =>
          task.hostId === hostId &&
          (ids.includes(task.assetId ?? '') || ids.includes(String(task.payload.sourceId ?? ''))),
      )
    )
      throw new BusinessError('FILES_BUSY', '此文件已有操作进行中，请等待完成或取消原任务。');
    if (!asset) return;
    const instances = await this.db.list('instances', connection);
    const commands = await this.db.inStates(
      'commands',
      ['queued', 'leased', 'executing', 'cancelling'],
      connection,
    );
    if (!['open', 'rename'].includes(kind)) {
      const references = instances.filter(
        (item) => usesServerFiles(item, asset) || reservesServerFiles(item, asset),
      );
      const bound =
        !!asset.instanceId ||
        !!asset.instanceIds?.length ||
        references.some((item) => usesServerFiles(item, asset));
      if (['verify', 'update'].includes(kind) && bound)
        throw new BusinessError(
          'MAP_UPDATE_REQUIRED',
          '请先关闭所有共用地图，再到地图管理更新，会先备份各自的存档。',
        );
      if (kind === 'delete' && (bound || references.length))
        throw new BusinessError(
          'FILES_IN_USE',
          '文件仍被地图使用或预留，请先删除关联地图或更改未安装地图的文件来源。',
        );
      if (
        kind !== 'clone' &&
        references.some(
          (item) =>
            item.pid ||
            !['stopped', 'error'].includes(item.status) ||
            commands.some((command) => command.instanceId === item.id),
        )
      )
        throw new BusinessError(
          'FILES_IN_USE',
          '关联地图仍在运行或执行任务，请先关闭地图并等待任务结束。',
        );
    }
    if (kind === 'clone' && !['ready', 'in-use'].includes(asset.status))
      throw new BusinessError('FILES_INCOMPLETE', '当前文件尚不可复用，请先完成下载或校验。');
  }
  private audit(task: FileTask, action: string, connection: Connection) {
    return this.db.put(
      'audit',
      {
        id: randomUUID(),
        actor: '管理员',
        action,
        target: task.assetId ?? task.hostId,
        detail: `${task.kind}：${String(task.payload.assetName ?? '')}`,
        createdAt: now(),
      },
      connection,
    );
  }
  async poll(hostId: string, connection: Connection): Promise<AgentFileTask[]> {
    const host = await this.db.get('hosts', hostId, connection);
    if (!host?.features?.includes(FILES_FEATURE)) return [];
    const all = (
      await this.db.inStates(
        'file-tasks',
        ['queued', 'leased', 'executing', 'cancelling'],
        connection,
      )
    ).filter((item) => item.hostId === hostId);
    for (const task of all)
      if (task.leaseUntil && task.leaseUntil < now()) {
        task.status = 'failed';
        task.completedAt = now();
        task.leaseUntil = null;
        task.error = '文件操作失去响应，请重新扫描后重试；未自动重复执行。';
        await this.db.put('file-tasks', task, connection);
      }
    if (all.some((item) => ['leased', 'executing', 'cancelling'].includes(item.status))) return [];
    const task = all
      .filter((item) => item.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!task) return [];
    const leased: FileTask = {
      ...task,
      status: 'leased',
      leaseUntil: new Date(Date.now() + 30000).toISOString(),
    };
    await this.db.put('file-tasks', leased, connection);
    return [
      {
        ...leased,
        asset: task.assetId ? await this.db.get('server-files', task.assetId, connection) : null,
        source:
          typeof task.payload.sourceId === 'string'
            ? await this.db.get('server-files', task.payload.sourceId, connection)
            : null,
      },
    ];
  }
  async heartbeat(
    hostId: string,
    files: ServerFiles[] | undefined,
    complete: boolean,
    running: string[],
    connection: Connection,
  ) {
    const tasks = (
      await this.db.inStates(
        'file-tasks',
        ['queued', 'leased', 'executing', 'cancelling'],
        connection,
      )
    ).filter((item) => item.hostId === hostId);
    for (const task of tasks)
      if (running.includes(task.id))
        await this.db.put(
          'file-tasks',
          { ...task, leaseUntil: new Date(Date.now() + 120000).toISOString() },
          connection,
        );
    if (!files) return;
    for (const entry of files) {
      if (entry.hostId !== hostId)
        throw new BusinessError('FILES_FORBIDDEN', '不能上报其他主机的文件。', 403);
      const previous = await this.db.get('server-files', entry.id, connection);
      if (previous && previous.hostId !== hostId)
        throw new BusinessError('FILES_FORBIDDEN', '文件标识已属于其他主机。', 403);
      if (previous?.status === 'deleted') continue;
      await this.db.put('server-files', entry, connection);
    }
    if (complete)
      for (const entry of await this.db.list('server-files', connection)) {
        if (
          entry.hostId === hostId &&
          entry.status !== 'deleted' &&
          !files.some((item) => item.id === entry.id) &&
          !tasks.some((item) => item.assetId === entry.id)
        )
          await this.db.put(
            'server-files',
            { ...entry, status: 'missing', instanceId: null, instanceIds: [], updatedAt: now() },
            connection,
          );
      }
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
      const task = await this.db.get('file-tasks', id, connection);
      if (!task || task.hostId !== hostId || !active(task))
        throw new BusinessError('FILE_TASK_EXPIRED', '文件任务不存在或已结束。', 409);
      if (task.status === 'cancelling' && status === 'executing') return null;
      if (task.kind === 'delete' && status === 'succeeded' && result?.deleted !== true)
        throw new BusinessError('DELETE_INCOMPLETE', '助手尚未确认文件删除完成。', 409);
      await this.db.put(
        'file-tasks',
        {
          ...task,
          status,
          progress,
          result,
          error,
          completedAt: status === 'executing' ? null : now(),
          leaseUntil: status === 'executing' ? new Date(Date.now() + 120000).toISOString() : null,
        },
        connection,
      );
      if (task.assetId && task.kind === 'delete' && status === 'succeeded') {
        const asset = await this.db.get('server-files', task.assetId, connection);
        if (asset)
          await this.db.put(
            'server-files',
            { ...asset, status: 'deleted', updatedAt: now() },
            connection,
          );
      }
      if (status !== 'executing')
        await this.audit(
          task,
          `文件操作${status === 'succeeded' ? '完成' : status === 'cancelled' ? '已取消' : '失败'}`,
          connection,
        );
      return null;
    });
  }
  async cancel(id: string) {
    return this.db.transaction(async (connection) => {
      const task = await this.db.get('file-tasks', id, connection);
      if (!task || !active(task)) throw new BusinessError('FILE_TASK_FINISHED', '文件任务已结束。');
      requireAccess('files.manage', hostTarget(task.hostId));
      if (task.status !== 'queued' && ['delete', 'open', 'rename'].includes(task.kind))
        throw new BusinessError('FILE_TASK_COMMITTED', '此文件操作已开始，不能取消。');
      await this.db.put(
        'file-tasks',
        {
          ...task,
          status: task.status === 'queued' ? 'cancelled' : 'cancelling',
          completedAt: task.status === 'queued' ? now() : null,
        },
        connection,
      );
      return null;
    });
  }
  async retry(id: string) {
    return this.db.transaction(async (connection) => {
      const task = await this.db.get('file-tasks', id, connection);
      if (!task || !['failed', 'cancelled'].includes(task.status))
        throw new BusinessError('FILE_RETRY_INVALID', '仅失败或已取消的文件任务可以重试。');
      requireAccess('files.manage', hostTarget(task.hostId));
      const host = await this.db.get('hosts', task.hostId, connection);
      if (!host || !isHostOnline(host) || ['disconnecting', 'disconnected'].includes(host.status))
        throw new BusinessError('HOST_OFFLINE', '请先连接文件所在的主机。');
      if (!host.features?.includes(FILES_FEATURE))
        throw new BusinessError('AGENT_UPDATE_REQUIRED', '请更新并重启游戏主机的助手。');
      const target = task.assetId
        ? await this.db.get('server-files', task.assetId, connection)
        : null;
      const source =
        task.kind === 'clone' && typeof task.payload.sourceId === 'string'
          ? await this.db.get('server-files', task.payload.sourceId, connection)
          : target;
      if (
        task.kind !== 'scan' &&
        (!target ||
          target.status === 'deleted' ||
          target.hostId !== task.hostId ||
          !source ||
          source.status === 'deleted' ||
          source.hostId !== task.hostId)
      )
        throw new BusinessError('FILES_NOT_FOUND', '原文件已不存在，无法重试此操作。');
      await this.validateOperation(task.hostId, task.kind, source, connection, target?.id);
      const retry: FileTask = {
        ...task,
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        status: 'queued',
        progress: '已安排重试，沿用已下载或复制的文件。',
        error: null,
        result: null,
        createdAt: now(),
        completedAt: null,
        leaseUntil: null,
      };
      await this.db.put('file-tasks', retry, connection);
      return retry;
    });
  }
}
