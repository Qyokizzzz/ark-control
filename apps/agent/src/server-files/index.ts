import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentFileTask, AgentInstance, Json, ServerFiles } from '@ark-control/common';
import type { AgentConfig } from '@/config';
import { atomicJson, ensureSafeParent, inside, readJson } from '@/files';
import { installServer, serverExecutableAt } from '@/runtime/install';
import { processMatches } from '@/runtime/processes';
import { recycleManagedSaved, recycleSharedInstance } from '@/runtime/cleanup';
import { installationBranch } from '@/runtime/branches';
import {
  assertProjectDescriptor,
  detachView,
  info,
  managedId as uuid,
  managedPath,
  moveLegacyState,
  ownedDirectory,
  prepareView,
  restorePackagedAssets,
} from '@/runtime/layout';
import { gameBranch, workshopMods } from '@ark-control/common';

const now = () => new Date().toISOString();
async function* tree(
  directory: string,
  base = directory,
): AsyncGenerator<{ path: string; rel: string; size: number; links: number }> {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const path = join(directory, entry.name);
    const rel = relative(base, path);
    if (/^ShooterGame[\\/]Saved(?:[\\/]|$)/i.test(rel)) continue;
    const data = await lstat(path);
    if (data.isSymbolicLink()) throw new Error(`文件包含链接，已停止操作：${rel}`);
    if (relative(base, await realpath(path)).startsWith('..'))
      throw new Error('文件路径已改变，已停止操作。');
    if (data.isDirectory()) yield* tree(path, base);
    else if (data.isFile()) yield { path, rel, size: data.size, links: data.nlink };
  }
}
export async function copyServerTree(
  source: string,
  destination: string,
  ownerRoot: string,
  signal: AbortSignal,
  report: (text: string) => void,
) {
  source = await realpath(source);
  const overlap = relative(source, destination);
  const reverse = relative(destination, source);
  if (
    !overlap ||
    (!overlap.startsWith('..') && !isAbsolute(overlap)) ||
    (!reverse.startsWith('..') && !isAbsolute(reverse))
  )
    throw new Error('复制来源和目标目录不能重叠。');
  await ensureSafeParent(ownerRoot, destination);
  const existing = await info(destination);
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory()))
    throw new Error('复制目标目录身份无效。');
  await mkdir(destination, { recursive: true });
  let count = 0;
  let bytes = 0;
  let lastProgress = 0;
  for await (const file of tree(source)) {
    signal.throwIfAborted();
    if (/(?:^|[\\/])Logs(?:[\\/]|$)|\.log$|[\\/]ArkTribeBridge[\\/]events\.jsonl$/i.test(file.rel))
      continue;
    if (
      /[\\/]ArkApi[\\/]Plugins[\\/](ArkShop|Permissions)[\\/].*\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i.test(
        file.rel,
      )
    )
      continue;
    const target = inside(destination, file.rel);
    await ensureSafeParent(ownerRoot, target);
    const prior = await info(target);
    if (prior?.isSymbolicLink() || (prior && (!prior.isFile() || prior.nlink > 1)))
      throw new Error('复制目标文件包含链接或其他异常内容。');
    await copyFile(file.path, target, constants.COPYFILE_FICLONE);
    bytes += file.size;
    ++count;
    if (Date.now() - lastProgress > 3000) {
      report(
        `正在本机复制服务端文件：${count} 个文件，${(bytes / 1024 ** 3).toFixed(2)} GB；存档和地图配置不复制。`,
      );
      lastProgress = Date.now();
    }
  }
  signal.throwIfAborted();
  return { count, bytes };
}

type Binding = { assetId: string; migrating?: true };
type PrepareOptions = {
  update?: boolean;
  logFile?: string;
  beforeUpdate?: (instances: AgentInstance[]) => Promise<void>;
};

export class FileLibrary {
  private entries: Record<string, ServerFiles> = {};
  private readonly bindings = new Map<string, Binding>();
  private readonly locked = new Set<string>();
  private instances: AgentInstance[] = [];
  private pending: Promise<void> = Promise.resolve();
  private steamQueue: Promise<void> = Promise.resolve();
  private scanning: Promise<void> | null = null;
  private lastScan = 0;
  private scanned = false;
  private readonly catalog: string;

  constructor(
    private readonly config: AgentConfig,
    private readonly gameBusy: (id: string) => boolean = () => false,
  ) {
    this.catalog = inside(config.root, 'server-files.json');
  }

  private path(group: 'maps' | 'instances' | 'server-files', id: string) {
    return managedPath(this.config.root, group, id);
  }
  private bindingPath(id: string) {
    if (!uuid.test(id)) throw new Error('地图标识无效。');
    return inside(this.config.root, 'map-bindings', `${id}.json`);
  }
  private async bind(id: string, binding: Binding) {
    const path = this.bindingPath(id);
    await ensureSafeParent(this.config.root, path);
    await atomicJson(path, binding);
    this.bindings.set(id, binding);
  }
  async initialize() {
    const root = this.config.root;
    await mkdir(root, { recursive: true });
    for (const group of ['maps', 'map-bindings']) {
      const directory = inside(root, group);
      if (!(await ownedDirectory(root, directory, true))) await mkdir(directory);
    }
    for await (const file of await opendir(inside(root, 'map-bindings'))) {
      const id = file.name.slice(0, -5);
      if (!file.name.endsWith('.json') || !uuid.test(id)) continue;
      if (!file.isFile()) throw new Error('地图文件关联记录不能为链接。');
      const binding = await readJson<Binding | null>(this.bindingPath(id), null);
      if (!binding || !uuid.test(binding.assetId) || (binding.migrating && binding.assetId !== id))
        throw new Error('地图文件关联记录无效，请核对 map-bindings 目录。');
      this.bindings.set(id, binding);
    }
    try {
      this.entries = await readJson(this.catalog, {});
    } catch {
      await copyFile(this.catalog, `${this.catalog}.unreadable-${Date.now()}`).catch(
        () => undefined,
      );
      console.error('服务端文件索引无法读取，原索引已保留，将重新扫描。');
      this.entries = {};
    }
    for (const [id, entry] of Object.entries(this.entries)) {
      if (!uuid.test(id) || !entry || typeof entry.path !== 'string') {
        delete this.entries[id];
        continue;
      }
      entry.hostId = this.config.hostId;
      if (entry.status === 'busy') {
        entry.status = 'partial';
        entry.lastError = '上次文件操作未确认完成，请重新扫描或重试。';
      }
    }
  }
  private save() {
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => atomicJson(this.catalog, this.entries));
    return this.pending;
  }
  private users(assetId: string) {
    return [...this.bindings]
      .filter(([, binding]) => binding.assetId === assetId)
      .map(([id]) => id);
  }
  reports() {
    return Object.values(this.entries).map((entry) => {
      if (entry.path !== this.path('maps', entry.id)) return { ...entry };
      const instanceIds = this.users(entry.id);
      return {
        ...entry,
        instanceId: null,
        instanceIds,
        status: this.locked.has(entry.id)
          ? ('busy' as const)
          : ['ready', 'in-use'].includes(entry.status)
            ? instanceIds.length
              ? ('in-use' as const)
              : ('ready' as const)
            : entry.status,
      };
    });
  }
  scanComplete() {
    return this.scanned;
  }
  async waitForScan() {
    await this.scanning;
  }
  isBusy(id: string) {
    return this.locked.has(id) || this.locked.has(this.bindings.get(id)?.assetId ?? '');
  }
  sync(instances: AgentInstance[]) {
    this.instances = instances;
    if (!this.scanning && Date.now() - this.lastScan > 60000)
      void this.scan().catch((error: unknown) =>
        console.error(`扫描服务端文件失败：${error instanceof Error ? error.message : '未知错误'}`),
      );
  }
  async steam<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const prior = this.steamQueue;
    let release!: () => void;
    this.steamQueue = new Promise<void>((yes) => {
      release = yes;
    });
    try {
      await prior;
      signal.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }
  private async lock<T>(ids: string[], operation: () => Promise<T>) {
    if (ids.some((id) => this.locked.has(id)))
      throw new Error('此套服务端文件正在操作，请稍后重试。');
    for (const id of ids) this.locked.add(id);
    try {
      return await operation();
    } finally {
      for (const id of ids) this.locked.delete(id);
    }
  }
  private async processes() {
    return readJson<Record<string, { pid?: number | null }>>(
      inside(this.config.root, 'processes.json'),
      {},
    );
  }
  private async active(id: string, processes: Awaited<ReturnType<FileLibrary['processes']>>) {
    const pid = processes[id]?.pid;
    return !!pid && (await processMatches(pid, serverExecutableAt(this.path('instances', id))));
  }
  private async assertIdle(assetId: string, except?: string, allowOwnProcess = false) {
    const processes = await this.processes();
    const ids = new Set([
      ...this.users(assetId),
      ...(this.entries[assetId]?.instanceId ? [this.entries[assetId].instanceId!] : []),
    ]);
    for (const id of ids) {
      if (
        (id !== except && this.gameBusy(id)) ||
        (!(allowOwnProcess && id === except) && (await this.active(id, processes)))
      ) {
        const name = this.instances.find((item) => item.id === id)?.name;
        throw new Error(`请先关闭共用此文件的地图${name ? `「${name}」` : ''}并等待地图任务完成。`);
      }
    }
  }

  private async repairLegacyLayout(
    assetId: string,
    currentId: string,
    report?: (text: string) => void,
  ) {
    if (this.bindings.get(assetId)?.assetId !== assetId) return;
    const moved = await restorePackagedAssets(this.config.root, assetId, () =>
      this.assertIdle(assetId, currentId),
    );
    if (!moved) return;
    const entry = await this.capture(assetId, this.path('maps', assetId));
    await this.save();
    report?.('已整理旧实例中的服务端项目文件和公共地图资源。');
    return entry;
  }

  private async capture(
    id: string,
    directory: string,
    options: {
      instance?: AgentInstance;
      origin?: ServerFiles['origin'];
      verified?: boolean;
      name?: string;
    } = {},
  ) {
    const prior = this.entries[id];
    const data = await info(directory);
    let sizeBytes = 0;
    let fileCount = 0;
    let lastError: string | null = null;
    let executable = false;
    if (data) {
      try {
        await ownedDirectory(this.config.root, directory);
        executable = !!(await info(serverExecutableAt(directory)))?.isFile();
        for await (const file of tree(directory)) {
          sizeBytes += file.size;
          ++fileCount;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : '文件扫描失败';
      }
    }
    const branch = await installationBranch(directory);
    let buildId: string | null = null;
    try {
      const manifest = await readFile(join(directory, 'steamapps/appmanifest_376030.acf'), 'utf8');
      buildId = manifest.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null;
    } catch {
      /* Imported installs may not include a Steam manifest. */
    }
    lastError ??= options.verified ? null : (prior?.lastError ?? null);
    const entry: ServerFiles = {
      branch,
      id,
      hostId: this.config.hostId,
      name:
        options.name ??
        prior?.name ??
        (options.instance
          ? `ASE 服务端 · ${options.instance.name}`.slice(0, 100)
          : 'ASE 专用服务端'),
      path: directory,
      platform: process.platform === 'win32' ? 'windows' : 'linux',
      status: !data
        ? 'missing'
        : executable && !lastError
          ? options.instance
            ? 'in-use'
            : 'ready'
          : 'partial',
      instanceId: options.instance?.id ?? null,
      sizeBytes,
      fileCount,
      buildId,
      origin: prior?.origin ?? options.origin ?? 'map',
      sourceId: prior?.sourceId ?? null,
      verifiedAt: options.verified ? now() : (prior?.verifiedAt ?? null),
      lastError: lastError?.slice(0, 3000) ?? null,
      createdAt: prior?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.entries[id] = entry;
    return entry;
  }

  private async migrateInstance(instance: AgentInstance) {
    const { id } = instance;
    const existing = this.bindings.get(id);
    if (existing && !existing.migrating) return existing.assetId;
    const source = this.path('instances', id);
    const target = this.path('maps', id);
    if (
      !existing &&
      !(await info(serverExecutableAt(source)))?.isFile() &&
      !(await info(inside(source, 'steamapps')))?.isDirectory() &&
      !(await info(inside(source, 'ShooterGame', 'Content')))?.isDirectory()
    )
      return null;
    if (await this.active(id, await this.processes()))
      throw new Error('请先关闭地图，再迁移原服务端文件。');
    if (!existing) {
      await ownedDirectory(this.config.root, source);
      if (await ownedDirectory(this.config.root, target, true))
        throw new Error('已有同标识的文件包，未覆盖原地图文件。');
      await this.bind(id, { assetId: id, migrating: true });
    }
    if (!(await ownedDirectory(this.config.root, target, true))) {
      await ownedDirectory(this.config.root, source);
      await rename(source, target);
    }
    // A persistent marker allows an interrupted move to resume without touching migrated saves.
    await moveLegacyState(this.config.root, target, source);
    await this.capture(id, target, { name: `ASE 服务端 · ${instance.name}`.slice(0, 100) });
    await this.save();
    await this.bind(id, { assetId: id });
    return id;
  }
  async scan(force = false) {
    if (this.scanning) return this.scanning;
    const operation = this.scanDirectories(force);
    this.scanning = operation;
    try {
      await operation;
      this.scanned = true;
    } finally {
      this.scanning = null;
      this.lastScan = Date.now();
    }
  }
  private async scanDirectories(force: boolean) {
    const root = this.config.root;
    for (const instance of this.instances) {
      if (this.isBusy(instance.id) || this.gameBusy(instance.id)) continue;
      if (this.bindings.has(instance.id) && !this.bindings.get(instance.id)!.migrating) continue;
      await this.lock([instance.id], async () => {
        if (await this.active(instance.id, await this.processes())) return;
        try {
          await this.migrateInstance(instance);
        } catch (error) {
          const text = error instanceof Error ? error.message : '地图文件迁移失败';
          console.error(`地图「${instance.name}」：${text}`);
        }
      });
    }
    // The previous file library lived in server-files. Move idle packages once; preserve their IDs.
    const old = inside(root, 'server-files');
    if (await ownedDirectory(root, old, true))
      for await (const folder of await opendir(old)) {
        if (!folder.isDirectory() || !uuid.test(folder.name) || this.locked.has(folder.name))
          continue;
        const id = folder.name;
        const source = this.path('server-files', id);
        const target = this.path('maps', id);
        await this.lock([id], async () => {
          await ownedDirectory(root, source);
          if (await ownedDirectory(root, target, true)) return;
          await rename(source, target);
        });
      }
    const seen = new Set<string>();
    for (const group of ['maps', 'instances'] as const) {
      const parent = inside(root, group);
      if (!(await ownedDirectory(root, parent, true))) continue;
      for await (const folder of await opendir(parent)) {
        if (!folder.isDirectory() || !uuid.test(folder.name)) continue;
        const id = folder.name;
        if (this.locked.has(id)) {
          seen.add(id);
          continue;
        }
        if (
          group === 'instances' &&
          (this.bindings.has(id) ||
            !(await info(serverExecutableAt(this.path(group, id))))?.isFile())
        )
          continue;
        if (seen.has(id)) continue;
        seen.add(id);
        const path = this.path(group, id);
        const prior = this.entries[id];
        if (
          !force &&
          prior?.path === path &&
          prior.status !== 'missing' &&
          Date.now() - Date.parse(prior.updatedAt) < 600000
        )
          continue;
        await this.lock([id], () =>
          this.capture(id, path, {
            instance:
              group === 'instances' ? this.instances.find((item) => item.id === id) : undefined,
          }),
        );
      }
    }
    for (const entry of Object.values(this.entries))
      if (!seen.has(entry.id) && !this.locked.has(entry.id)) {
        entry.status = 'missing';
        entry.instanceId = null;
      }
    await this.save();
  }

  private compatible(asset: ServerFiles | undefined, instance: AgentInstance) {
    return (
      asset &&
      asset.path === this.path('maps', asset.id) &&
      !this.bindings.get(asset.id)?.migrating &&
      ['ready', 'in-use'].includes(asset.status) &&
      asset.branch === gameBranch(instance.branch)
    );
  }
  async installation(instance: AgentInstance) {
    const binding = this.bindings.get(instance.id);
    const path = binding ? this.path('maps', binding.assetId) : this.path('instances', instance.id);
    const entry = binding ? this.entries[binding.assetId] : undefined;
    const installed =
      !!(await info(serverExecutableAt(path)))?.isFile() &&
      (!binding || (!!entry && ['ready', 'in-use'].includes(entry.status)));
    let buildId: string | null = entry?.buildId ?? null;
    if (installed && !entry) {
      const manifest = await readFile(join(path, 'steamapps/appmanifest_376030.acf'), 'utf8').catch(
        () => '',
      );
      buildId = manifest.match(/"buildid"\s+"(\d+)"/)?.[1] ?? null;
    }
    return { installed, buildId, serverFileId: binding?.assetId ?? null };
  }

  async prepare(
    instance: AgentInstance,
    options: PrepareOptions,
    report: (text: string) => void,
    signal: AbortSignal,
  ) {
    return this.steam(async () => {
      await this.scan();
      let id = this.bindings.get(instance.id)?.assetId;
      if (!id || this.bindings.get(instance.id)?.migrating)
        id = (await this.lock([instance.id], () => this.migrateInstance(instance))) ?? undefined;
      const branch = gameBranch(instance.branch);
      const selection = instance.serverFileSource ?? 'auto';
      const explicit = uuid.test(selection) ? selection : null;
      if (!id && explicit) {
        if (!this.compatible(this.entries[explicit], instance))
          throw new Error('所选文件不可用，请选择同主机、同分支且已校验的服务端文件。');
        id = explicit;
      }
      if (!id)
        id =
          Object.values(this.entries)
            .filter((entry) => this.compatible(entry, instance))
            .sort((a, b) => (b.verifiedAt ?? '').localeCompare(a.verifiedAt ?? ''))[0]?.id ??
          randomUUID();
      const assetId = id;
      return this.lock([assetId], async () => {
        signal.throwIfAborted();
        const directory = this.path('maps', assetId);
        const prior = this.entries[assetId];
        if (prior?.branch && prior.branch !== 'unknown' && prior.branch !== branch)
          throw new Error('服务端分支与地图设置不一致，请检查文件来源。');
        if (!this.bindings.has(instance.id)) await this.bind(instance.id, { assetId });
        const reused =
          !options.update &&
          !!this.compatible(prior, instance) &&
          !!(await info(serverExecutableAt(directory)))?.isFile();
        if (!reused) {
          await this.assertIdle(assetId, instance.id, options.update === true);
          const peers = this.users(assetId).filter((id) => id !== instance.id);
          if (options.beforeUpdate)
            await options.beforeUpdate([
              instance,
              ...this.instances.filter((item) => peers.includes(item.id)),
            ]);
          await this.assertIdle(assetId, instance.id);
        }
        const repaired = await this.repairLegacyLayout(assetId, instance.id, report);
        if (reused && repaired?.lastError) throw new Error(repaired.lastError);
        if (!reused) {
          await this.patchPackage(
            assetId,
            branch,
            report,
            signal,
            options.logFile,
            `ASE 服务端 · ${branch}`,
          );
        } else report(`正在关联「${prior!.name}」，直接使用同一份服务端文件。`);
        await prepareView(
          this.config.root,
          instance.id,
          assetId,
          workshopMods(instance.config).length > 0,
        );
        report('服务端已准备；各地图的配置、存档与日志独立。');
        return { reused, fileId: assetId };
      });
    }, signal);
  }
  async prepareLaunch(
    instance: AgentInstance,
    report: (text: string) => void,
    signal: AbortSignal,
  ) {
    await this.scanning;
    signal.throwIfAborted();
    const { id } = instance;
    const binding = this.bindings.get(id);
    const assetId =
      binding && !binding.migrating
        ? binding.assetId
        : await this.lock([id], () => this.migrateInstance(instance));
    if (!assetId) throw new Error('服务端程序不存在，请先准备服务端。');
    await this.lock([assetId], async () => {
      const entry = this.entries[assetId];
      const legacyPublic =
        assetId === id && entry?.branch === 'unknown' && gameBranch(instance.branch) === 'public';
      if (!this.compatible(entry, instance) && !(legacyPublic && entry?.status === 'ready'))
        throw new Error('服务端文件缺失、未完成或分支不符，请先准备或校验文件。');
      report('正在检查共享文件和此地图的运行目录。');
      const repaired = await this.repairLegacyLayout(assetId, id, report);
      if (repaired?.lastError) throw new Error(repaired.lastError);
      await prepareView(this.config.root, id, assetId, workshopMods(instance.config).length > 0);
      await assertProjectDescriptor(this.config.root, id);
    });
  }

  private async patchPackage(
    id: string,
    branch: 'public' | 'preaquatica',
    report: (text: string) => void,
    signal: AbortSignal,
    logFile?: string,
    name?: string,
  ) {
    const root = this.config.root;
    const directory = this.path('maps', id);
    const exists = await ownedDirectory(root, directory, true);
    for (const instanceId of this.users(id)) await detachView(root, instanceId, id);
    if (exists)
      for await (const file of tree(directory)) {
        signal.throwIfAborted();
        if (file.links > 1) throw new Error('文件含未受助手管理的硬链接，无法安全更新。');
      }
    const pending =
      this.entries[id] ?? (await this.capture(id, directory, { origin: 'download', name }));
    pending.status = 'partial';
    pending.lastError = '服务端更新尚未确认完成，请等待或重新安装。';
    await this.save();
    try {
      signal.throwIfAborted();
      await installServer(root, { id, branch }, report, signal, logFile, directory);
      if (this.entries[id]) this.entries[id]!.lastError = null;
      const entry = await this.capture(id, directory, {
        origin: 'download',
        verified: true,
        name: this.entries[id]?.name ?? name,
      });
      if (entry.status !== 'ready') throw new Error(entry.lastError ?? '服务端文件未安装完成。');
    } catch (error) {
      const entry = await this.capture(id, directory, {
        origin: 'download',
        name: this.entries[id]?.name ?? name,
      });
      entry.status = 'partial';
      entry.lastError = (error instanceof Error ? error.message : '文件安装失败').slice(0, 3000);
      throw error;
    } finally {
      await this.save();
    }
  }

  async removeMap(instance: AgentInstance, commandId: string) {
    await this.scanning;
    const { id } = instance;
    const bound = this.bindings.get(id);
    const assetId =
      bound && !bound.migrating
        ? bound.assetId
        : await this.lock([id], () => this.migrateInstance(instance));
    return this.lock([id, ...(assetId ? [assetId] : [])], async () => {
      if (await this.active(id, await this.processes())) throw new Error('请先关闭地图。');
      if (assetId === id) await this.repairLegacyLayout(id, id);
      if (assetId) await detachView(this.config.root, id, assetId);
      const savedArchive = await recycleSharedInstance(this.config.root, id, commandId);
      if (assetId) {
        await unlink(this.bindingPath(id));
        this.bindings.delete(id);
      }
      const retained = assetId ? this.path('maps', assetId) : this.path('maps', id);
      return { savedArchive, retainedDirectory: (await info(retained)) ? retained : null };
    });
  }

  execute(
    task: AgentFileTask,
    signal: AbortSignal,
    report: (text: string) => void,
  ): Promise<Record<string, Json>> {
    return ['scan', 'download', 'verify', 'update'].includes(task.kind)
      ? this.steam(() => this.executeTask(task, signal, report), signal)
      : this.executeTask(task, signal, report);
  }
  private async executeTask(
    task: AgentFileTask,
    signal: AbortSignal,
    report: (text: string) => void,
  ): Promise<Record<string, Json>> {
    if (task.kind === 'scan') {
      await this.scanning;
      await this.scan(true);
      return { scanned: true };
    }
    await this.scanning;
    const asset = this.entries[task.assetId ?? ''] ?? task.asset;
    const source = task.source ? (this.entries[task.source.id] ?? task.source) : null;
    if (!asset || asset.hostId !== this.config.hostId || (source && source.hostId !== asset.hostId))
      throw new Error('服务端文件不存在或不属于此主机。');
    const root = this.config.root;
    const directory = this.path('maps', asset.id);
    if (asset.path && relative(directory, resolve(asset.path)))
      throw new Error('此文件尚在旧目录；请关闭关联地图并扫描，等待迁移到 maps。');
    return this.lock<Record<string, Json>>(
      [...new Set([asset.id, ...(source ? [source.id] : [])])],
      async (): Promise<Record<string, Json>> => {
        const exists = await ownedDirectory(root, directory, true);
        signal.throwIfAborted();
        if (task.kind === 'open') {
          if (!exists) throw new Error('服务端目录不存在。');
          if (process.platform !== 'win32') throw new Error('请复制路径后在主机上打开。');
          await new Promise<void>((yes, no) => {
            const child = spawn('explorer.exe', [directory], {
              shell: false,
              detached: true,
              windowsHide: false,
              stdio: 'ignore',
            });
            child.once('error', no);
            child.once('spawn', () => {
              child.unref();
              yes();
            });
          });
          return { requested: true, path: directory };
        }
        if (task.kind === 'rename') {
          this.entries[asset.id] = { ...asset, name: String(task.payload.name), updatedAt: now() };
          await this.save();
          return { renamed: true };
        }
        if (task.kind === 'delete') {
          if (
            asset.instanceId ||
            this.users(asset.id).length ||
            this.instances.some(
              (item) => !this.bindings.has(item.id) && item.serverFileSource === asset.id,
            )
          )
            throw new Error('文件仍被地图使用或预留，请先移除关联。');
          let savedArchive: string | null = null;
          if (exists) {
            for await (const file of tree(directory)) {
              signal.throwIfAborted();
              if (file.links > 1) throw new Error('文件包含硬链接，已停止删除。');
            }
            await ownedDirectory(root, directory);
            savedArchive = await recycleManagedSaved(root, directory, asset.id, task.id);
            signal.throwIfAborted();
            await rm(directory, { recursive: true, force: true });
          }
          delete this.entries[asset.id];
          await this.save();
          return { deleted: true, path: directory, savedArchive };
        }
        let savedArchive: string | null = null;
        if (task.kind === 'import' || task.kind === 'clone') {
          this.entries[asset.id] = { ...asset, path: directory, status: 'partial' };
          try {
            if (!source && !isAbsolute(String(task.payload.sourcePath)))
              throw new Error('导入目录必须为游戏主机上的绝对路径。');
            const from = source
              ? this.path('maps', source.id)
              : resolve(String(task.payload.sourcePath));
            const data = await info(from);
            if (
              !data?.isDirectory() ||
              data.isSymbolicLink() ||
              !(await info(serverExecutableAt(from)))?.isFile()
            )
              throw new Error('请选择 ASE 专用服务端根目录；Steam 游戏客户端不能作为服务端导入。');
            if (source) await ownedDirectory(root, from);
            await copyServerTree(from, directory, root, signal, report);
            this.entries[asset.id]!.lastError = null;
            const entry = await this.capture(asset.id, directory);
            entry.sourceId = source?.id ?? null;
            if (entry.status !== 'ready')
              throw new Error(entry.lastError ?? '未找到专用服务端程序。');
          } catch (error) {
            this.entries[asset.id]!.lastError = (
              error instanceof Error ? error.message : '复制失败'
            ).slice(0, 3000);
            throw error;
          } finally {
            await this.save();
          }
        } else {
          if (this.users(asset.id).length || asset.instanceId)
            throw new Error('已关联地图的文件，请到地图管理更新，以便先备份各地图存档。');
          if (exists) savedArchive = await recycleManagedSaved(root, directory, asset.id, task.id);
          if (savedArchive) report(`原目录的存档和配置已回收到：${savedArchive}`);
          this.entries[asset.id] = { ...asset, path: directory, status: 'partial' };
          const branch =
            task.payload.branch === 'preaquatica' || task.payload.branch === 'public'
              ? task.payload.branch
              : gameBranch(asset.branch);
          await this.patchPackage(
            asset.id,
            branch,
            report,
            signal,
            inside(root, 'logs', 'server-files', `${task.id}.log`),
            asset.name,
          );
        }
        return {
          ready: true,
          path: directory,
          sizeBytes: this.entries[asset.id]?.sizeBytes ?? 0,
          savedArchive,
        };
      },
    );
  }
}
