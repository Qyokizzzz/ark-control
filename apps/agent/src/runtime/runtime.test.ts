import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gameConfigSchema } from '@ark-control/common';
import type { AgentCommand, AgentInstance } from '@ark-control/common';
import { AgentClient } from '@/client';
import { GameRuntime } from './runtime';
import * as processes from '@/runtime/processes';
import * as rconModule from '@/rcon';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const name = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(name) || name.includes('..') || !name.startsWith('ark-runtime-test-'))
      throw new Error('拒绝清理非测试目录。');
    await rm(resolve(root), { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ark-runtime-test-'));
  roots.push(root);
  const instance: AgentInstance = {
    id: randomUUID(),
    hostId: randomUUID(),
    name: '未安装地图',
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
    autoRestart: true,
    cpuPercent: 0,
    memoryMb: 0,
    pid: null,
    startedAt: null,
    lastError: null,
    buildId: null,
    createdAt: new Date().toISOString(),
    rconPassword: 'local-test',
  };
  const command: AgentCommand = {
    id: randomUUID(),
    hostId: instance.hostId,
    instanceId: instance.id,
    instance,
    kind: 'delete',
    payload: { countdownSeconds: 0 },
    status: 'executing',
    progress: '',
    result: null,
    error: null,
    leaseUntil: null,
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  const config = {
    root,
    hostId: instance.hostId,
    token: 'local-test',
    apiUrl: 'http://127.0.0.1:1',
  };
  const client = new AgentClient(config);
  const runtime = new GameRuntime(config, client, () => undefined);
  await runtime.initialize();
  const directory = join(root, 'instances', instance.id);
  const saved = join(directory, 'ShooterGame/Saved');
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'world.ark'), 'keep-world');
  return { root, directory, saved, command, instance, client, runtime };
}
describe('configuration sync without a game restart', () => {
  it('writes and verifies both private INIs with no RCON connection or process action', async () => {
    const item = await fixture();
    const rcon = vi.spyOn(rconModule, 'rcon').mockRejectedValue(new Error('ECONNREFUSED'));
    item.instance.config.harvest = 50;
    item.instance.config.sessionName = '孤岛测试';
    const receipt = await item.runtime.execute(
      { ...item.command, kind: 'sync-config' },
      new AbortController().signal,
      () => undefined,
    );
    const directory = join(
      item.saved,
      'Config',
      process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer',
    );
    expect(receipt).toEqual({
      verified: true,
      harvest: 50,
      settingsPath: join(directory, 'GameUserSettings.ini'),
      gamePath: join(directory, 'Game.ini'),
    });
    expect(await readFile(String(receipt.settingsPath), 'utf16le')).toMatch(
      /^HarvestAmountMultiplier=50$/m,
    );
    expect(await readFile(String(receipt.gamePath), 'utf8')).toContain(
      'BabyMatureSpeedMultiplier=',
    );
    expect(await readFile(join(item.saved, 'world.ark'), 'utf8')).toBe('keep-world');
    expect(JSON.stringify(receipt)).not.toContain(item.instance.rconPassword);
    expect(rcon).not.toHaveBeenCalled();
  });
  it('keeps the prior Game.ini and process state if GameUserSettings.ini cannot be replaced', async () => {
    const item = await fixture();
    const directory = join(
      item.saved,
      'Config',
      process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer',
    );
    await mkdir(join(directory, 'GameUserSettings.ini'), { recursive: true });
    await writeFile(join(directory, 'Game.ini'), 'previous');
    await expect(
      item.runtime.execute(
        { ...item.command, kind: 'sync-config' },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow();
    expect(await readFile(join(directory, 'Game.ini'), 'utf8')).toBe('previous');
    expect((await item.runtime.reports([item.instance]))[0]).toMatchObject({
      status: 'stopped',
      lastError: null,
      pid: null,
    });
  });
});
describe('stopped map deletion checkpoint', () => {
  it('can clean a stopped map with unusable credentials while refusing to start with an empty RCON password', async () => {
    const item = await fixture();
    item.instance.credentialError = '地图管理凭据无法解密';
    item.instance.rconPassword = '';
    vi.spyOn(item.client, 'request').mockResolvedValue({ cancelled: false });
    await expect(
      item.runtime.execute(
        { ...item.command, kind: 'start' },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('无法解密');
    expect(await readFile(join(item.saved, 'world.ark'), 'utf8')).toBe('keep-world');
    const result = await item.runtime.execute(
      item.command,
      new AbortController().signal,
      () => undefined,
    );
    expect(result.deleted).toBe(true);
    expect(await readFile(join(String(result.savedArchive), 'world.ark'), 'utf8')).toBe(
      'keep-world',
    );
  });
  it('honors an accepted cancellation without deleting files or leaving an error state', async () => {
    const item = await fixture();
    vi.spyOn(item.client, 'request').mockResolvedValue({ cancelled: true });
    await expect(
      item.runtime.execute(item.command, new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readFile(join(item.saved, 'world.ark'), 'utf8')).toBe('keep-world');
    expect((await item.runtime.reports([item.instance]))[0]).toMatchObject({
      status: 'stopped',
      lastError: null,
      pid: null,
      memoryMb: 0,
    });
  });
  it('does not remove a stopped map when the server cannot confirm the cleanup phase', async () => {
    const item = await fixture();
    vi.spyOn(item.client, 'request').mockRejectedValue(new Error('确认连接中断'));
    await expect(
      item.runtime.execute(item.command, new AbortController().signal, () => undefined),
    ).rejects.toThrow('确认连接中断');
    expect(await readFile(join(item.saved, 'world.ark'), 'utf8')).toBe('keep-world');
  });
  it('enters the committed phase before recycling saves and removing an uninstalled map', async () => {
    const item = await fixture();
    vi.spyOn(item.client, 'request').mockImplementation(async (path) => {
      expect(path).toBe(`/commands/${item.command.id}/commit-stop`);
      expect(await readFile(join(item.saved, 'world.ark'), 'utf8')).toBe('keep-world');
      return { cancelled: false };
    });
    const result = await item.runtime.execute(
      item.command,
      new AbortController().signal,
      () => undefined,
    );
    expect(result.deleted).toBe(true);
    expect(await stat(item.directory).catch(() => null)).toBeNull();
    expect(await readFile(join(String(result.savedArchive), 'world.ark'), 'utf8')).toBe(
      'keep-world',
    );
    expect(
      JSON.parse(await readFile(join(item.root, 'processes.json'), 'utf8')),
    ).not.toHaveProperty(item.instance.id);
  });
});

describe('startup recovery', () => {
  async function recover(age = 0) {
    const item = await fixture();
    const startedAt = new Date(Date.now() - age).toISOString();
    await writeFile(
      join(item.root, 'processes.json'),
      JSON.stringify({
        [item.instance.id]: { pid: 12345, starting: true, startedAt, lastError: null },
      }),
    );
    vi.spyOn(processes, 'processMatches').mockResolvedValue(true);
    vi.spyOn(processes, 'processMetrics').mockResolvedValue({ cpuPercent: 0, memoryMb: 300 });
    const runtime = new GameRuntime(item.runtime.config, item.client, () => undefined);
    await runtime.initialize();
    return { ...item, runtime };
  }
  it('does not report a recovered process as running before RCON responds', async () => {
    const item = await recover();
    vi.spyOn(rconModule, 'rcon').mockRejectedValue(new Error('RCON 未响应'));
    expect((await item.runtime.reports([item.instance]))[0]).toMatchObject({
      status: 'starting',
      pid: 12345,
      startup: { stage: 'loading', rconReady: false },
    });
    vi.spyOn(item.client, 'request').mockResolvedValue({ cancelled: false });
    await expect(
      item.runtime.execute(
        { ...item.command, kind: 'stop' },
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('RCON 未响应');
    expect((await item.runtime.reports([item.instance]))[0]?.status).toBe('starting');
    vi.mocked(rconModule.rcon).mockResolvedValue('No Players Connected');
    expect((await item.runtime.reports([item.instance]))[0]).toMatchObject({
      status: 'running',
      startup: { stage: 'ready', rconReady: true },
      lastError: null,
    });
  });
  it('terminates a recovered startup without RCON and retains its saves', async () => {
    const item = await recover();
    const rcon = vi.spyOn(rconModule, 'rcon').mockRejectedValue(new Error('RCON 未响应'));
    const livePid = vi.spyOn(processes, 'pidInUse').mockReturnValue(true);
    const stop = vi.spyOn(processes, 'forceStop').mockImplementation(async () => {
      livePid.mockReturnValue(false);
      vi.mocked(processes.processMatches).mockResolvedValue(false);
    });
    const outcome = await item.runtime.execute(
      { ...item.command, kind: 'force-stop', payload: { terminateStartup: true } },
      new AbortController().signal,
      () => undefined,
    );
    expect(stop).toHaveBeenCalledExactlyOnceWith(12345, expect.stringContaining(item.instance.id));
    expect(rcon).not.toHaveBeenCalled();
    expect(outcome).toEqual({ stopped: true });
    expect((await item.runtime.reports([item.instance]))[0]).toMatchObject({
      status: 'stopped',
      pid: null,
      startup: null,
      memoryMb: 0,
    });
    expect(await readFile(join(item.saved, 'world.ark'), 'utf8')).toBe('keep-world');
  });
  it('marks a timed-out startup as failed while retaining its process for inspection', async () => {
    const item = await recover(31 * 60_000);
    vi.spyOn(rconModule, 'rcon').mockRejectedValue(new Error('RCON 未响应'));
    const report = (await item.runtime.reports([item.instance]))[0];
    expect(report).toMatchObject({
      status: 'error',
      pid: 12345,
      startup: { stage: 'failed', rconReady: false },
    });
    expect(report?.lastError).toContain('30 分钟');
    expect(report?.lastError).toContain('RCON 未响应');
    const runtime = new GameRuntime(item.runtime.config, item.client, () => undefined);
    await runtime.initialize();
    expect((await runtime.reports([item.instance]))[0]?.status).toBe('error');
  });
  it('marks a process that exited while the agent was stopped as a failed startup', async () => {
    const item = await recover();
    vi.mocked(processes.processMatches).mockResolvedValue(false);
    const report = (await item.runtime.reports([item.instance]))[0];
    expect(report).toMatchObject({ status: 'error', pid: null, memoryMb: 0 });
    expect(report?.lastError).toContain('启动期间退出');
  });
});
