import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ARKSHOP_UI_PLUGIN_FEATURE,
  defaultShopMode,
  gameBranch,
  instanceTarget,
  isHostOnline,
  PLUGIN_ARCHIVE_LIMIT,
  playerScope,
  playerScopes,
  pluginBranchSchema,
  pluginIdSchema,
  pluginInstallSchema,
  pluginPlanSchema,
  requiredPlugins,
  SERVER_PLUGINS_FEATURE,
  serverPlugins,
} from '@ark-control/common';
import type {
  Command,
  FileTask,
  GameBranch,
  Host,
  Instance,
  PluginArchive,
  PluginInstallRequest,
  PluginMap,
  PluginPackage,
  PluginPlan,
  ServerPluginId,
  ServerPluginsView,
} from '@ark-control/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { AgentGuard } from '@/agents/agent.guard';
import type { AgentRequest } from '@/agents/agent.guard';
import { Public } from '@/auth';
import { ControlService } from '@/control';
import { newInstanceCommand } from '@/control/lifecycle';
import { BusinessError, Database, dataDir, parse } from '@/infrastructure';
import type { Connection } from '@/infrastructure';
import { allowed, gameTarget, requireAccess, requireMapAccess } from '@/workspaces/access';

const activeStates = ['queued', 'leased', 'executing', 'cancelling'];
const builtinName = 'ArkControlShop-Windows-x64.zip';
const packageKey = (branch: GameBranch, pluginId: ServerPluginId) => `${branch}:${pluginId}`;
const archiveAction = 'plugins.install';

function affectsFiles(task: FileTask, map: Instance) {
  const asset = map.serverFileId ?? map.serverFileSource;
  return (
    task.hostId === map.hostId &&
    [task.assetId, task.payload.sourceId].some((id) => id && (id === map.id || id === asset))
  );
}

function blockedReason(map: Instance, host: Host | undefined, busy: boolean) {
  if (!isHostOnline(host)) return '主机未连接';
  if (host?.platform !== 'windows') return '此插件需要 Windows ASE';
  if (!host.features?.includes(SERVER_PLUGINS_FEATURE)) return '请更新并重启主机助手';
  if (!map.installed) return '请先安装地图服务端';
  if (map.pid || !['stopped', 'error'].includes(map.status)) return '请先停止地图';
  if (busy) return '地图已有进行中的任务';
  return null;
}

@Injectable()
export class ServerPluginsService {
  private builtin: { path: string; mtime: number; archive: PluginArchive } | null = null;

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ControlService) private readonly control: ControlService,
  ) {}

  private archivePath(archiveId: string) {
    return join(
      dataDir,
      'plugin-packages',
      this.db.workspaceId,
      `${parse(z.uuid(), archiveId)}.zip`,
    );
  }

  private async builtinPackage() {
    for (const path of [
      resolve('../../artifacts', builtinName),
      resolve('artifacts', builtinName),
    ]) {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size < 4 || info.size > PLUGIN_ARCHIVE_LIMIT) continue;
      if (
        this.builtin?.path === path &&
        this.builtin.mtime === info.mtimeMs &&
        this.builtin.archive.size === info.size
      )
        return this.builtin;
      const hash = createHash('sha256');
      for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer);
      this.builtin = {
        path,
        mtime: info.mtimeMs,
        archive: { id: 'builtin', size: info.size, sha256: hash.digest('hex') },
      };
      return this.builtin;
    }
    return null;
  }

  private async snapshot(connection?: Connection) {
    const [instances, hosts, commands, fileTasks, management] = await Promise.all([
      this.db.list('instances', connection),
      this.db.list('hosts', connection),
      this.db.inStates('commands', activeStates, connection),
      this.db.inStates('file-tasks', activeStates, connection),
      this.db.inStates('management-tasks', ['leased', 'executing'], connection),
    ]);
    const byHost = new Map(hosts.map((host) => [host.id, host]));
    const busyMaps = new Set([...commands, ...management].map((task) => task.instanceId));
    return {
      instances,
      byHost,
      blocked: (map: Instance) =>
        blockedReason(
          map,
          byHost.get(map.hostId),
          busyMaps.has(map.id) || fileTasks.some((task) => affectsFiles(task, map)),
        ),
    };
  }

  async view(): Promise<ServerPluginsView> {
    const [snapshot, modes, history, packages, builtin] = await Promise.all([
      this.snapshot(),
      this.db.list('shop-modes'),
      this.db.listBy('commands', 'kind', 'install-plugins'),
      this.db.list('plugin-packages'),
      this.builtinPackage(),
    ]);
    const visible = snapshot.instances.filter(
      (map) =>
        allowed('maps.read', instanceTarget(map)) ||
        allowed(archiveAction, instanceTarget(map)) ||
        allowed('shop.read', gameTarget(map)) ||
        allowed('shop.write', gameTarget(map)),
    );
    const latest = new Map<string, Command>();
    for (const task of history) {
      const previous = latest.get(task.instanceId);
      if (!previous || previous.createdAt < task.createdAt) latest.set(task.instanceId, task);
    }
    const maps: PluginMap[] = visible.map((map) => {
      const host = snapshot.byHost.get(map.hostId);
      const task = latest.get(map.id);
      const plugins = map.plugins;
      return {
        id: map.id,
        name: map.name,
        scopeId: playerScope(map),
        hostName: host?.name ?? '—',
        branch: gameBranch(map.branch),
        running: isHostOnline(host) && map.pid !== null,
        arkShopUiSupported: !!host?.features?.includes(ARKSHOP_UI_PLUGIN_FEATURE),
        blocked: allowed(archiveAction, instanceTarget(map))
          ? snapshot.blocked(map)
          : '没有此地图的插件安装权限',
        report:
          plugins && isHostOnline(host) && host?.features?.includes(SERVER_PLUGINS_FEATURE)
            ? { ...plugins, loaded: plugins.pid === map.pid && map.pid ? plugins.loaded : null }
            : null,
        task:
          (task && {
            id: task.id,
            status: task.status,
            progress: task.progress,
            error: task.error,
            createdAt: task.createdAt,
          }) ||
          null,
      };
    });
    const byScope = new Map(modes.map(({ id, mode }) => [id, mode]));
    return {
      maps,
      scopes: playerScopes(visible).map((scope) => ({
        ...scope,
        mode: byScope.get(scope.id) ?? defaultShopMode,
      })),
      packages: packages.map(({ pluginId, branch, name, uploadedAt }) => ({
        pluginId,
        branch,
        name,
        uploadedAt,
      })),
      builtinShop: !!builtin,
      canUpload: allowed(archiveAction),
    };
  }

  async upload(branch: GameBranch, pluginId: ServerPluginId, name: string, request: Request) {
    requireAccess(archiveAction);
    if (!serverPlugins[pluginId].officialUrl)
      throw new BusinessError('PLUGIN_BUILTIN_ONLY', '独立商店插件由后台自带。');
    const length = Number(request.headers['content-length']);
    if (!request.is('application/octet-stream') || !/\.zip$/i.test(name))
      throw new BusinessError('PLUGIN_ZIP_REQUIRED', '请选择 ZIP 格式的插件安装包。');
    if (length > PLUGIN_ARCHIVE_LIMIT)
      throw new BusinessError('PLUGIN_TOO_LARGE', '插件安装包最多 64 MiB。', 413);

    const id = randomUUID();
    const path = this.archivePath(id);
    await mkdir(dirname(path), { recursive: true });
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(bytes: Buffer, _encoding, done) {
        size += bytes.length;
        if (size > PLUGIN_ARCHIVE_LIMIT) {
          done(new BusinessError('PLUGIN_TOO_LARGE', '插件安装包最多 64 MiB。', 413));
          return;
        }
        if (head.length < 4) head = Buffer.concat([head, bytes.subarray(0, 4 - head.length)]);
        hash.update(bytes);
        done(null, bytes);
      },
    });
    let saved = false;
    try {
      await pipeline(request, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      if (head.length < 4 || head.readUInt32LE(0) !== 0x04034b50)
        throw new BusinessError('PLUGIN_ZIP_REQUIRED', '文件内容不是有效的 ZIP 安装包。');
      const record: PluginPackage = {
        id: packageKey(branch, pluginId),
        pluginId,
        branch,
        name,
        uploadedAt: new Date().toISOString(),
        archive: { id, size, sha256: hash.digest('hex') },
      };
      const previous = await this.db.transaction(async (connection) => {
        const existing = await this.db.get('plugin-packages', record.id, connection);
        if (existing) {
          const commands = await this.db.inStates('commands', activeStates, connection);
          const inUse = commands.some((task) => {
            if (task.kind !== 'install-plugins') return false;
            const plan = pluginPlanSchema.safeParse(task.payload);
            return (
              plan.success &&
              plan.data.items.some(({ archive }) => archive?.id === existing.archive.id)
            );
          });
          if (inUse)
            throw new BusinessError(
              'PLUGIN_PACKAGE_IN_USE',
              '有地图正在使用此安装包，请等待任务完成。',
              409,
            );
        }
        await this.db.put('plugin-packages', record, connection);
        await this.control.audit('导入服务端插件', record.id, name, connection);
        return existing;
      });
      saved = true;
      if (previous) await unlink(this.archivePath(previous.archive.id)).catch(() => undefined);
      return { pluginId, branch, name, uploadedAt: record.uploadedAt };
    } finally {
      if (!saved) await unlink(path).catch(() => undefined);
    }
  }

  async enqueue(input: PluginInstallRequest) {
    const ids = [...new Set(input.mapIds)].sort();
    const plugins = requiredPlugins(input.pluginIds);
    const fingerprint = JSON.stringify([input.scopeId, ids, plugins]);
    return this.db.transaction(async (connection) => {
      const selected = [];
      for (const id of ids) {
        const map = await requireMapAccess(this.db, archiveAction, id, connection);
        if (playerScope(map) !== input.scopeId)
          throw new BusinessError(
            'PLUGIN_SCOPE_CHANGED',
            '地图所属互通组已变化，请刷新选择。',
            409,
          );
        selected.push(map);
      }
      const previous = await this.db.get('plugin-requests', input.idempotencyKey, connection);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new BusinessError('IDEMPOTENCY_CONFLICT', '重复请求标识与原操作不一致。', 409);
        return { commandIds: previous.commandIds };
      }
      const mode =
        (await this.db.get('shop-modes', input.scopeId, connection))?.mode ?? defaultShopMode;
      if (plugins.includes(mode === 'independent' ? 'arkshop' : 'ark-control-shop'))
        throw new BusinessError('PLUGIN_SHOP_MODE', '请选择当前商店模式对应的插件。', 409);

      const snapshot = await this.snapshot(connection);
      const packages = await this.db.list('plugin-packages', connection);
      const builtin = plugins.includes('ark-control-shop') ? await this.builtinPackage() : null;
      const commands: Command[] = [];
      for (const map of selected) {
        const blocked = snapshot.blocked(map);
        if (blocked) throw new BusinessError('PLUGIN_MAP_BUSY', `「${map.name}」${blocked}。`, 409);
        if (
          plugins.includes('arkshop-ui') &&
          !snapshot.byHost.get(map.hostId)?.features?.includes(ARKSHOP_UI_PLUGIN_FEATURE)
        )
          throw new BusinessError(
            'PLUGIN_AGENT_OUTDATED',
            `请更新「${map.name}」的主机助手后安装 ArkShopUI。`,
            409,
          );
        const branch = gameBranch(map.branch);
        const items = plugins.map((pluginId) => {
          const archive =
            (pluginId === 'ark-control-shop'
              ? builtin?.archive
              : packages.find((item) => item.id === packageKey(branch, pluginId))?.archive) ?? null;
          if (!archive && !map.plugins?.installed.includes(pluginId))
            throw new BusinessError(
              'PLUGIN_PACKAGE_MISSING',
              `「${map.name}」缺少 ${serverPlugins[pluginId].name} 的对应分支安装包。`,
              409,
            );
          return { pluginId, archive };
        });
        const plan: PluginPlan = { branch, items };
        commands.push(
          newInstanceCommand(
            map,
            { kind: 'install-plugins', idempotencyKey: randomUUID() },
            { ...plan },
          ),
        );
      }
      for (const command of commands) await this.db.put('commands', command, connection);
      const commandIds = commands.map(({ id }) => id);
      await this.db.put(
        'plugin-requests',
        { id: input.idempotencyKey, fingerprint, commandIds },
        connection,
      );
      await this.control.audit(
        '安装服务端插件',
        input.scopeId,
        `${plugins.map((id) => serverPlugins[id].name).join('、')} → ${selected.map(({ name }) => name).join('、')}`,
        connection,
      );
      return { commandIds };
    });
  }

  async download(hostId: string, commandId: string, pluginId: ServerPluginId, response: Response) {
    const task = await this.db.get('commands', commandId);
    if (task?.hostId !== hostId || task.kind !== 'install-plugins' || task.status !== 'executing')
      throw new BusinessError('PLUGIN_TASK_NOT_FOUND', '没有可下载的插件任务。', 404);
    const plan = parse(pluginPlanSchema, task.payload);
    const archive = plan.items.find((item) => item.pluginId === pluginId)?.archive;
    if (!archive) throw new BusinessError('PLUGIN_PACKAGE_MISSING', '任务没有此安装包。', 404);
    const builtin = archive.id === 'builtin' ? await this.builtinPackage() : null;
    const path =
      archive.id === 'builtin'
        ? builtin?.archive.sha256 === archive.sha256
          ? builtin.path
          : null
        : this.archivePath(archive.id);
    const file = path ? await open(path, 'r').catch(() => null) : null;
    if (!file)
      throw new BusinessError(
        'PLUGIN_PACKAGE_CHANGED',
        '安装包已更换或缺失，请重新提交安装。',
        409,
      );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== archive.size)
        throw new BusinessError('PLUGIN_PACKAGE_CHANGED', '安装包大小已变化，请重新导入。', 409);
      response.set({
        'Content-Type': 'application/zip',
        'Content-Length': String(archive.size),
        'Cache-Control': 'no-store',
      });
      await pipeline(file.createReadStream(), response);
    } finally {
      await file.close();
    }
  }
}

@Controller('server-plugins')
export class ServerPluginsController {
  constructor(@Inject(ServerPluginsService) private readonly plugins: ServerPluginsService) {}

  @Get() view() {
    return this.plugins.view();
  }

  @Post('install') install(@Body() body: unknown) {
    return this.plugins.enqueue(parse(pluginInstallSchema, body));
  }

  @Post('packages/:branch/:pluginId') upload(
    @Param('branch') branch: string,
    @Param('pluginId') pluginId: string,
    @Req() request: Request,
  ) {
    const name = parse(
      z
        .string()
        .min(1)
        .max(180)
        .refine(
          (name) => !/[\\/]/u.test(name) && [...name].every((char) => char.charCodeAt(0) >= 32),
        ),
      request.query.name,
    );
    return this.plugins.upload(
      parse(pluginBranchSchema, branch),
      parse(pluginIdSchema, pluginId),
      name,
      request,
    );
  }
}

@Public()
@UseGuards(AgentGuard)
@Controller('agent/server-plugins')
export class AgentServerPluginsController {
  constructor(@Inject(ServerPluginsService) private readonly plugins: ServerPluginsService) {}

  @Get('tasks/:id/:pluginId') download(
    @Param('id') id: string,
    @Param('pluginId') pluginId: string,
    @Req() request: AgentRequest,
    @Res() response: Response,
  ) {
    return this.plugins.download(
      request.agentHostId,
      parse(z.uuid(), id),
      parse(pluginIdSchema, pluginId),
      response,
    );
  }
}
