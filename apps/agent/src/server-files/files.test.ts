import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameConfigSchema } from '@ark-control/common';
import type { AgentFileTask, AgentInstance, FileOperation, ServerFiles } from '@ark-control/common';
import { FileLibrary, copyServerTree } from './index';
import * as install from '@/runtime/install';
import * as processes from '@/runtime/processes';
import { writeSettings } from '@/runtime/settings';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  for (const root of roots.splice(0)) {
    const name = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(name) || name.includes('..') || !name.startsWith('ark-files-test-'))
      throw new Error('拒绝清理非测试目录。');
    await rm(resolve(root), { recursive: true, force: true });
  }
});
async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'ark-files-test-'));
  roots.push(root);
  return root;
}
async function fixture() {
  const root = await folder();
  const config = { root, hostId: randomUUID(), token: 'fixture', apiUrl: 'http://127.0.0.1:1' };
  const library = new FileLibrary(config);
  await library.initialize();
  return { root, config, library };
}
async function seed(directory: string) {
  const executable = install.serverExecutableAt(directory);
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(join(directory, 'ShooterGame/Content/Maps'), { recursive: true });
  await mkdir(join(directory, 'ShooterGame/SeekFreeContent/Maps'), { recursive: true });
  await mkdir(join(directory, 'ShooterGame/Saved/Config'), { recursive: true });
  await mkdir(join(directory, 'steamapps'), { recursive: true });
  await writeFile(executable, 'server-binary');
  await writeFile(join(directory, 'ShooterGame/ShooterGame.uproject'), '{"FileVersion":3}');
  await writeFile(join(directory, 'ShooterGame/AssetRegistry.bin'), 'asset-index');
  await writeFile(join(directory, 'ShooterGame/SeekFreeContent/Maps/TheIsland.umap'), 'cooked-map');
  await writeFile(join(directory, 'PackageInfo.bin'), 'package-index');
  await writeFile(join(directory, 'ShooterGame/Content/Maps/TheIsland.umap'), 'island-content');
  await writeFile(join(directory, 'steamapps/appmanifest_376030.acf'), '"buildid" "123456"');
  await writeFile(join(directory, '.ark-control-install.json'), '{"branch":"public"}');
  await writeFile(join(directory, 'ShooterGame/Saved/world.ark'), 'original-world');
  const oldEvents = join(dirname(executable), 'ArkApi/Plugins/ArkTribeBridge/events.jsonl');
  await mkdir(dirname(oldEvents), { recursive: true });
  await writeFile(oldEvents, 'old-tribe-event\n');
  await writeFile(
    join(directory, 'ShooterGame/Saved/Config/private.ini'),
    'private-map-configuration',
  );
}
function asset(hostId: string, id = randomUUID()): ServerFiles {
  const date = new Date().toISOString();
  return {
    id,
    hostId,
    name: 'ASE fixture',
    path: '',
    platform: process.platform === 'win32' ? 'windows' : 'linux',
    status: 'ready',
    instanceId: null,
    sizeBytes: 0,
    fileCount: 0,
    buildId: null,
    origin: 'import',
    sourceId: null,
    verifiedAt: null,
    lastError: null,
    createdAt: date,
    updatedAt: date,
  };
}
function task(
  kind: FileOperation,
  file: ServerFiles,
  payload: AgentFileTask['payload'] = {},
  source: ServerFiles | null = null,
): AgentFileTask {
  return {
    id: randomUUID(),
    hostId: file.hostId,
    assetId: file.id,
    kind,
    payload,
    status: 'executing',
    progress: '',
    error: null,
    result: null,
    idempotencyKey: randomUUID(),
    leaseUntil: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    asset: file,
    source,
  };
}
function map(hostId: string): AgentInstance {
  return {
    id: randomUUID(),
    hostId,
    name: 'independent map',
    map: 'TheIsland',
    mapLabel: '孤岛',
    clusterId: '',
    gamePort: 7777,
    queryPort: 27015,
    rconPort: 27020,
    status: 'stopped',
    desiredState: 'stopped',
    installed: false,
    config: gameConfigSchema.parse({}),
    autoRestart: false,
    cpuPercent: 0,
    memoryMb: 0,
    pid: null,
    startedAt: null,
    lastError: null,
    buildId: null,
    createdAt: new Date().toISOString(),
    rconPassword: 'new-map-password',
  };
}
const signal = () => new AbortController().signal;
async function imported() {
  const value = await fixture();
  const source = await folder();
  await seed(source);
  const file = asset(value.config.hostId);
  await value.library.execute(
    task('import', file, { sourcePath: source }),
    signal(),
    () => undefined,
  );
  return { ...value, source, file: value.library.reports().find((item) => item.id === file.id)! };
}
describe('server file library', () => {
  it('imports programs and mods while leaving source files and Saved untouched', async () => {
    const value = await imported();
    expect(value.file.status).toBe('ready');
    expect(value.file.buildId).toBe('123456');
    expect(await readFile(install.serverExecutableAt(value.file.path), 'utf8')).toBe(
      'server-binary',
    );
    expect(
      await readFile(join(value.file.path, 'ShooterGame/Content/Maps/TheIsland.umap'), 'utf8'),
    ).toBe('island-content');
    expect(await stat(join(value.file.path, 'ShooterGame/Saved')).catch(() => null)).toBeNull();
    expect(await readFile(join(value.source, 'ShooterGame/Saved/world.ark'), 'utf8')).toBe(
      'original-world',
    );
    expect(value.file.fileCount).toBe(8);
  });
  it('uses one package for two Island maps without copying the executable or sharing writable files', async () => {
    const value = await imported();
    const first = map(value.config.hostId);
    const second = map(value.config.hostId);
    first.serverFileSource = value.file.id;
    first.config.sessionName = 'Island PVE';
    second.config.sessionName = 'Island PVP';
    const oldWallet = join(
      dirname(install.serverExecutableAt(value.file.path)),
      'ArkApi/Plugins/ArkShop/players.db',
    );
    await mkdir(dirname(oldWallet), { recursive: true });
    await writeFile(oldWallet, 'old-wallet');
    const steam = vi.spyOn(install, 'installServer');
    await Promise.all(
      [first, second].map(async (instance) => {
        expect(await value.library.prepare(instance, {}, () => undefined, signal())).toEqual({
          reused: true,
          fileId: value.file.id,
        });
        const exe = install.serverExecutable(value.root, instance.id);
        const [actual, original] = await Promise.all([
          stat(exe, { bigint: true }),
          stat(install.serverExecutableAt(value.file.path), { bigint: true }),
        ]);
        expect(actual.ino).toBe(original.ino);
        expect(actual.dev).toBe(original.dev);
        const project = join(dirname(exe), '../../../ShooterGame/ShooterGame.uproject');
        const sharedProject = join(value.file.path, 'ShooterGame/ShooterGame.uproject');
        expect(await readFile(project, 'utf8')).toBe('{"FileVersion":3}');
        expect((await stat(project, { bigint: true })).ino).toBe(
          (await stat(sharedProject, { bigint: true })).ino,
        );
        const folder = join(value.root, 'instances', instance.id, 'ShooterGame');
        expect(await readFile(join(folder, 'AssetRegistry.bin'), 'utf8')).toBe('asset-index');
        expect(await readFile(join(folder, 'SeekFreeContent/Maps/TheIsland.umap'), 'utf8')).toBe(
          'cooked-map',
        );
        expect(await readFile(join(folder, '../PackageInfo.bin'), 'utf8')).toBe('package-index');
        expect((await lstat(join(folder, 'Content/Maps'))).isSymbolicLink()).toBe(true);
        expect(await readFile(join(folder, 'Content/Maps/TheIsland.umap'), 'utf8')).toBe(
          'island-content',
        );
        expect(await stat(join(dirname(exe), 'ArkApi')).catch(() => null)).toBeNull();
        await writeSettings(value.root, instance);
        const ini = join(
          folder,
          'Saved/Config',
          process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer',
          'GameUserSettings.ini',
        );
        expect((await lstat(join(folder, 'Saved'))).isSymbolicLink()).toBe(false);
        expect(await readFile(ini, 'utf8')).toContain(`SessionName=${instance.config.sessionName}`);
      }),
    );
    expect(value.library.reports()).toEqual([
      expect.objectContaining({ status: 'in-use', instanceIds: [first.id, second.id] }),
    ]);
    expect(await stat(join(value.file.path, 'ShooterGame/Saved')).catch(() => null)).toBeNull();
    expect(steam).not.toHaveBeenCalled();
    const removed = await value.library.removeMap(first, randomUUID());
    expect(removed.retainedDirectory).toBe(value.file.path);
    expect(value.library.reports()[0]?.instanceIds).toEqual([second.id]);
    expect(await value.library.installation(second)).toMatchObject({
      installed: true,
      serverFileId: value.file.id,
    });
    await expect(
      value.library.execute(task('delete', value.file), signal(), () => undefined),
    ).rejects.toThrow('使用或预留');
  });
  it('retains map downloads after recycling saves, and purges them only on explicit file deletion', async () => {
    const value = await fixture();
    const instance = map(value.config.hostId);
    const directory = join(value.root, 'instances', instance.id);
    await seed(directory);
    const result = await value.library.removeMap(instance, randomUUID());
    expect(await stat(directory).catch(() => null)).toBeNull();
    expect(await readFile(install.serverExecutableAt(result.retainedDirectory!), 'utf8')).toBe(
      'server-binary',
    );
    const retained = value.library.reports().find((item) => item.id === instance.id)!;
    expect(retained).toMatchObject({ status: 'ready', instanceIds: [] });
    await value.library.execute(task('delete', retained), signal(), () => undefined);
    expect(await stat(retained.path).catch(() => null)).toBeNull();
    expect(await readFile(join(result.savedArchive!, 'world.ark'), 'utf8')).toBe('original-world');
  });
  it('downloads once when maps are prepared together, with a separate package for another Steam branch', async () => {
    const value = await fixture();
    const one = map(value.config.hostId);
    const two = map(value.config.hostId);
    const beta = { ...map(value.config.hostId), branch: 'preaquatica' as const };
    const steam = vi
      .spyOn(install, 'installServer')
      .mockImplementation(async (_root, selected, _report, _signal, _log, target) => {
        const exe = install.serverExecutableAt(target!);
        await mkdir(dirname(exe), { recursive: true });
        await writeFile(exe, 'fixture');
        await writeFile(
          join(target!, '.ark-control-install.json'),
          JSON.stringify({ branch: selected.branch ?? 'public' }),
        );
      });
    const [first, second, third] = await Promise.all(
      [one, two, beta].map((instance) =>
        value.library.prepare(instance, {}, () => undefined, signal()),
      ),
    );
    expect(first!.reused).toBe(false);
    expect(second).toEqual({ reused: true, fileId: first!.fileId });
    expect(third!.fileId).not.toBe(first!.fileId);
    expect(steam.mock.calls.map((call) => call[1].branch)).toEqual(['public', 'preaquatica']);
    expect(value.library.reports()).toHaveLength(2);
  });
  it('completes an interrupted migration and preserves the old map save, plugin state and package name', async () => {
    const value = await fixture();
    const instance = map(value.config.hostId);
    const { id } = instance;
    const old = join(value.root, 'instances', id);
    const shared = join(value.root, 'maps', id);
    await seed(old);
    await writeFile(
      join(value.root, 'map-bindings', `${id}.json`),
      JSON.stringify({ assetId: id, migrating: true }),
    );
    await rename(old, shared);
    const library = new FileLibrary(value.config);
    await library.initialize();
    library.sync([instance]);
    await library.scan(true);
    const file = library.reports().find((item) => item.id === id)!;
    expect(file).toMatchObject({ path: shared, instanceIds: [id], status: 'in-use' });
    expect(await readFile(join(old, 'ShooterGame/Saved/world.ark'), 'utf8')).toBe('original-world');
    expect(
      await readFile(
        join(
          dirname(install.serverExecutableAt(old)),
          'ArkApi/Plugins/ArkTribeBridge/events.jsonl',
        ),
        'utf8',
      ),
    ).toContain('old-tribe-event');
    expect(await stat(join(shared, 'ShooterGame/Saved')).catch(() => null)).toBeNull();
    await library.execute(
      task('rename', file, { name: 'My retained server' }),
      signal(),
      () => undefined,
    );
    const restored = new FileLibrary(value.config);
    await restored.initialize();
    expect(restored.reports().find((item) => item.id === id)?.name).toBe('My retained server');
  });
  it('recycles any Saved data found in a cached download before explicitly purging its files', async () => {
    const value = await imported();
    await mkdir(join(value.file.path, 'ShooterGame/Saved'), { recursive: true });
    await writeFile(join(value.file.path, 'ShooterGame/Saved/unexpected.ark'), 'keep-this-save');
    const result = await value.library.execute(
      task('delete', value.file),
      signal(),
      () => undefined,
    );
    expect(await stat(value.file.path).catch(() => null)).toBeNull();
    expect(await readFile(join(String(result.savedArchive), 'unexpected.ark'), 'utf8')).toBe(
      'keep-this-save',
    );
  });
  it('recovers misplaced assets from a previously migrated map and keeps its saves and old duplicates', async () => {
    const value = await fixture();
    const first = map(value.config.hostId);
    const second = { ...map(value.config.hostId), serverFileSource: first.id };
    const shared = join(value.root, 'maps', first.id);
    const old = join(value.root, 'instances', first.id);
    await seed(shared);
    await mkdir(join(old, 'ShooterGame/Saved'), { recursive: true });
    await writeFile(join(old, 'ShooterGame/Saved/existing.ark'), 'keep-this-world');
    for (const name of ['ShooterGame.uproject', 'SeekFreeContent'])
      await rename(join(shared, 'ShooterGame', name), join(old, 'ShooterGame', name));
    await writeFile(join(old, 'ShooterGame/AssetRegistry.bin'), 'older-index');
    await writeFile(
      join(value.root, 'map-bindings', `${first.id}.json`),
      JSON.stringify({ assetId: first.id }),
    );
    const library = new FileLibrary(value.config);
    await library.initialize();
    const steam = vi.spyOn(install, 'installServer');
    const pidFile = join(value.root, 'processes.json');
    await writeFile(pidFile, JSON.stringify({ [first.id]: { pid: 12345 } }));
    const active = vi.spyOn(processes, 'processMatches').mockResolvedValueOnce(true);
    await expect(library.prepare(second, {}, () => undefined, signal())).rejects.toThrow(
      '请先关闭共用',
    );
    expect(await readFile(join(old, 'ShooterGame/ShooterGame.uproject'), 'utf8')).toBe(
      '{"FileVersion":3}',
    );
    active.mockResolvedValue(false);
    await writeFile(pidFile, '{}');
    expect(await library.prepare(second, {}, () => undefined, signal())).toEqual({
      reused: true,
      fileId: first.id,
    });
    await library.prepareLaunch(second, () => undefined, signal());
    await library.prepareLaunch(first, () => undefined, signal());
    expect(steam).not.toHaveBeenCalled();
    expect(await readFile(join(shared, 'ShooterGame/ShooterGame.uproject'), 'utf8')).toBe(
      '{"FileVersion":3}',
    );
    expect(
      await readFile(join(shared, 'ShooterGame/SeekFreeContent/Maps/TheIsland.umap'), 'utf8'),
    ).toBe('cooked-map');
    expect(await readFile(join(old, 'ShooterGame/Saved/existing.ark'), 'utf8')).toBe(
      'keep-this-world',
    );
    const [recycled] = await readdir(join(value.root, 'recycle'));
    expect(
      await readFile(
        join(value.root, 'recycle', recycled!, 'ShooterGame/AssetRegistry.bin'),
        'utf8',
      ),
    ).toBe('older-index');
  });
  it('reports a missing project descriptor before launching the game and points to repair', async () => {
    const value = await imported();
    const instance = map(value.config.hostId);
    await unlink(join(value.file.path, 'ShooterGame/ShooterGame.uproject'));
    await value.library.prepare(instance, {}, () => undefined, signal());
    await expect(value.library.prepareLaunch(instance, () => undefined, signal())).rejects.toThrow(
      /ShooterGame\.uproject.*更新服务端/,
    );
  });
  it('repairs a missing ArkApi PDB for the selected branch and shares it between stopped maps', async () => {
    const value = await fixture();
    const source = await folder();
    const executable = install.serverExecutableAt(source);
    const pdb = 'ShooterGame/Binaries/Win64/ShooterGameServer.pdb';
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, 'server-binary');
    await writeFile(join(source, '.ark-control-install.json'), '{"branch":"preaquatica"}');
    const file = asset(value.config.hostId);
    await value.library.execute(
      task('import', file, { sourcePath: source }),
      signal(),
      () => undefined,
    );
    const selected = {
      branch: 'preaquatica' as const,
      serverFileSource: file.id,
    };
    const first = { ...map(value.config.hostId), ...selected };
    const second = { ...map(value.config.hostId), ...selected };
    const shared = join(value.root, 'maps', file.id, pdb);
    const firstPdb = join(value.root, 'instances', first.id, pdb);
    const secondPdb = join(value.root, 'instances', second.id, pdb);
    await value.library.prepare(first, {}, () => undefined, signal());
    await value.library.prepare(second, {}, () => undefined, signal());
    await mkdir(dirname(firstPdb), { recursive: true });
    await writeFile(firstPdb, 'manually copied PDB');
    await writeFile(
      join(value.root, 'processes.json'),
      JSON.stringify({ [second.id]: { pid: 12345 } }),
    );
    const running = vi.spyOn(processes, 'processMatches').mockResolvedValue(true);
    const steam = vi.spyOn(install, 'installServer').mockImplementation(async () => {
      await mkdir(dirname(shared), { recursive: true });
      await writeFile(shared, 'official branch PDB');
    });
    const preparePlugins = (instance: AgentInstance) =>
      value.library.prepare(instance, { requireArkApiPdb: true }, () => undefined, signal());

    await expect(preparePlugins(first)).rejects.toThrow('请先关闭共用此文件的地图');
    expect(steam).not.toHaveBeenCalled();
    running.mockResolvedValue(false);
    await expect(preparePlugins(first)).resolves.toEqual({ reused: false, fileId: file.id });
    await expect(preparePlugins(second)).resolves.toEqual({ reused: true, fileId: file.id });
    expect(steam).toHaveBeenCalledOnce();
    expect(steam.mock.calls[0]?.[1].branch).toBe('preaquatica');
    expect(await readFile(firstPdb, 'utf8')).toBe('official branch PDB');
    expect(await readFile(secondPdb, 'utf8')).toBe('official branch PDB');
    expect((await stat(shared)).nlink).toBe(3);
    const [backup] = await readdir(join(value.root, 'recycle'));
    expect(await readFile(join(value.root, 'recycle', backup!, pdb), 'utf8')).toBe(
      'manually copied PDB',
    );
    steam.mockImplementationOnce(async () => {
      expect((await stat(shared)).nlink).toBe(1);
      await writeFile(shared, 'updated branch PDB');
    });
    await value.library.prepare(first, { update: true }, () => undefined, signal());
    await expect(preparePlugins(second)).resolves.toEqual({ reused: true, fileId: file.id });
    expect(await readFile(firstPdb, 'utf8')).toBe('updated branch PDB');
    expect(await readFile(secondPdb, 'utf8')).toBe('updated branch PDB');
  });
  it('rejects a Steam game client and retains an incomplete import for retry', async () => {
    const value = await fixture();
    const source = await folder();
    await writeFile(join(source, 'ShooterGame.exe'), 'client-only');
    const file = asset(value.config.hostId);
    await expect(
      value.library.execute(
        task('import', file, { sourcePath: source }),
        signal(),
        () => undefined,
      ),
    ).rejects.toThrow('Steam 游戏客户端');
    expect(value.library.reports().find((item) => item.id === file.id)?.status).toBe('partial');
    await seed(source);
    await value.library.execute(
      task('import', file, { sourcePath: source }),
      signal(),
      () => undefined,
    );
    expect(value.library.reports().find((item) => item.id === file.id)?.status).toBe('ready');
  });
  it('refuses redirected content before deleting any managed or external file', async () => {
    const value = await imported();
    const external = await folder();
    await writeFile(join(external, 'keep.txt'), 'keep');
    await symlink(external, join(value.file.path, 'redirected'), 'junction');
    await expect(
      value.library.execute(task('delete', value.file), signal(), () => undefined),
    ).rejects.toThrow('链接');
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await readFile(install.serverExecutableAt(value.file.path), 'utf8')).toBe(
      'server-binary',
    );
  });
  it('rejects overlapping copy directories and cancellation without touching the source', async () => {
    const value = await fixture();
    const source = join(value.root, 'source');
    await seed(source);
    await expect(
      copyServerTree(source, join(source, 'nested'), value.root, signal(), () => undefined),
    ).rejects.toThrow('重叠');
    const abort = new AbortController();
    abort.abort();
    await expect(
      copyServerTree(source, join(value.root, 'copy'), value.root, abort.signal, () => undefined),
    ).rejects.toThrow();
    expect(await readFile(install.serverExecutableAt(source), 'utf8')).toBe('server-binary');
  });
  it('blocks updates while any sharing map is running, and refreshes views after one package update', async () => {
    const value = await imported();
    const first = map(value.config.hostId);
    const second = map(value.config.hostId);
    await value.library.prepare(first, {}, () => undefined, signal());
    await value.library.prepare(second, {}, () => undefined, signal());
    await writeFile(
      join(value.root, 'processes.json'),
      JSON.stringify({ [second.id]: { pid: 12345 } }),
    );
    const running = vi.spyOn(processes, 'processMatches').mockResolvedValue(true);
    const steam = vi
      .spyOn(install, 'installServer')
      .mockImplementation(async (_root, _instance, _report, _signal, _log, target) => {
        expect(target).toBe(value.file.path);
        const file = install.serverExecutableAt(target!);
        expect((await stat(file)).nlink).toBe(1);
        await writeFile(file, 'server-updated');
      });
    await expect(
      value.library.prepare(first, { update: true }, () => undefined, signal()),
    ).rejects.toThrow('请先关闭共用此文件的地图');
    expect(steam).not.toHaveBeenCalled();
    expect(await readFile(install.serverExecutableAt(value.file.path), 'utf8')).toBe(
      'server-binary',
    );
    running.mockResolvedValue(false);
    await value.library.prepare(first, { update: true }, () => undefined, signal());
    await value.library.prepareLaunch(second, () => undefined, signal());
    expect(steam).toHaveBeenCalledOnce();
    expect(await readFile(install.serverExecutable(value.root, second.id), 'utf8')).toBe(
      'server-updated',
    );
  });
  it('preserves downloads reserved by a map even when a previously queued deletion is retried', async () => {
    const value = await imported();
    const instance = map(value.config.hostId);
    instance.serverFileSource = value.file.id;
    value.library.sync([instance]);
    await expect(
      value.library.execute(task('delete', value.file), signal(), () => undefined),
    ).rejects.toThrow('使用或预留');
    expect(await readFile(install.serverExecutableAt(value.file.path), 'utf8')).toBe(
      'server-binary',
    );
  });
  it('opens the managed location on the agent host using an argument without a shell', async () => {
    const value = await imported();
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ReturnType<typeof spawn>;
    });
    if (process.platform !== 'win32') {
      await expect(
        value.library.execute(task('open', value.file), signal(), () => undefined),
      ).rejects.toThrow('请复制路径');
      return;
    }
    expect(
      await value.library.execute(task('open', value.file), signal(), () => undefined),
    ).toMatchObject({ requested: true, path: value.file.path });
    expect(spawn).toHaveBeenCalledWith(
      'explorer.exe',
      [value.file.path],
      expect.objectContaining({ shell: false }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });
  it('retries a failed download in its original managed directory without removing partial files', async () => {
    const value = await fixture();
    const file = asset(value.config.hostId);
    file.origin = 'download';
    const steam = vi
      .spyOn(install, 'installServer')
      .mockImplementationOnce(async (_root, _instance, _report, _signal, _log, target) => {
        await mkdir(target!, { recursive: true });
        await writeFile(join(target!, 'partial.bin'), 'resume-me');
        throw new Error('download interrupted');
      })
      .mockImplementationOnce(async (_root, _instance, _report, _signal, _log, target) => {
        expect(await readFile(join(target!, 'partial.bin'), 'utf8')).toBe('resume-me');
        await seed(target!);
      });
    await expect(
      value.library.execute(task('download', file), signal(), () => undefined),
    ).rejects.toThrow('interrupted');
    const incomplete = value.library.reports().find((item) => item.id === file.id)!;
    await value.library.execute(task('download', incomplete), signal(), () => undefined);
    expect(steam).toHaveBeenCalledTimes(2);
    expect(value.library.reports().find((item) => item.id === file.id)).toMatchObject({
      status: 'ready',
      verifiedAt: expect.any(String),
    });
  });
});
