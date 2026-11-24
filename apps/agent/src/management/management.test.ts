import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentManagementTask, Json } from '@ark-control/common';
import { AgentClient } from '@/client';
import {
  ManagementRuntime,
  parseCommerceLine,
  parsePlayerList,
  parsePoints,
  parsePermissionGroups,
} from './index';
import { ManagedFirewall } from './firewall';
import { databaseSignature, pluginDirectory, publishShop, readShop } from './shop';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const name = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(name) || name.includes('..') || !name.startsWith('ark-management-test-'))
      throw new Error('拒绝清理非测试目录');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ark-management-test-'));
  roots.push(root);
  const config = { root, apiUrl: 'http://127.0.0.1:3000', hostId: randomUUID(), token: 'test' };
  const task = {
    id: randomUUID(),
    kind: 'coins',
    steamId: '76561198000000001',
    payload: { amount: 50 },
    instance: { id: randomUUID(), rconPort: 27020, rconPassword: 'test' },
  } as unknown as AgentManagementTask;
  return { root, config, task };
}
describe('ArkShop management execution', () => {
  it('replays a persisted receipt after restart without replaying the game mutation', async () => {
    const { config, task } = await fixture();
    task.instanceId = task.instance.id;
    const client = new AgentClient(config);
    let polls = 0,
      receipts = 0,
      mutations = 0;
    vi.spyOn(client, 'request').mockImplementation(
      async <T>(path: string, data?: unknown): Promise<T> => {
        if (path === '/management/poll') return (polls++ === 0 ? [task] : []) as T;
        if ((data as { status?: string })?.status === 'succeeded') {
          receipts++;
          if (receipts === 1) throw new Error('receipt connection lost');
        }
        return {} as T;
      },
    );
    const send = async (_instance: unknown, command: string) => {
      if (command.startsWith('GetPlayerPoints')) return 'Player has 100 points';
      mutations++;
      return 'Successfully set points';
    };
    await expect(new ManagementRuntime(config, client, new Set(), send).cycle([])).rejects.toThrow(
      'receipt connection lost',
    );
    await new ManagementRuntime(config, client, new Set(), send).cycle([]);
    expect(mutations).toBe(1);
    expect(receipts).toBe(2);
  });
  it('journals non-idempotent mutations and returns the saved outcome without sending twice', async () => {
    const { config, task } = await fixture();
    let balance = 100;
    const commands: string[] = [];
    const runtime = new ManagementRuntime(
      config,
      new AgentClient(config),
      new Set(),
      async (_instance, command) => {
        commands.push(command);
        if (command.startsWith('GetPlayerPoints')) return `Player has ${balance} points\n`;
        balance += 50;
        return 'Successfully set points\n';
      },
    );
    const first = await runtime.runTask(task);
    const second = await runtime.runTask(task);
    expect(first).toEqual(second);
    expect(first.status).toBe('succeeded');
    expect(first.result.balance).toBe(150);
    expect(commands.filter((command) => command.startsWith('ChangePoints'))).toHaveLength(1);
  });
  it('never retries a mutation after a timeout, including after an agent restart', async () => {
    const { config, task } = await fixture();
    let sends = 0;
    const send = async (_instance: unknown, command: string) => {
      if (command.startsWith('GetPlayerPoints')) return 'Player has 100 points';
      sends++;
      throw new Error('RCON response timeout');
    };
    const runtime = new ManagementRuntime(config, new AgentClient(config), new Set(), send);
    expect((await runtime.runTask(task)).status).toBe('uncertain');
    const restarted = new ManagementRuntime(config, new AgentClient(config), new Set(), send);
    expect((await restarted.runTask(task)).status).toBe('uncertain');
    expect(sends).toBe(1);
  });
  it('treats a crash after the durable mutation checkpoint as uncertain', async () => {
    const { config, task, root } = await fixture();
    await mkdir(join(root, 'management-journal'));
    await writeFile(
      join(root, 'management-journal', `${task.id}.json`),
      JSON.stringify({ status: 'mutating' }),
    );
    let called = false;
    const runtime = new ManagementRuntime(config, new AgentClient(config), new Set(), async () => {
      called = true;
      return '';
    });
    expect((await runtime.runTask(task)).status).toBe('uncertain');
    expect(called).toBe(false);
  });
  it('rejects an unknown or missing balance before touching coins', async () => {
    const { config, task } = await fixture();
    const commands: string[] = [];
    const runtime = new ManagementRuntime(
      config,
      new AgentClient(config),
      new Set(),
      async (_instance, command) => {
        commands.push(command);
        return 'Unknown command';
      },
    );
    expect((await runtime.runTask(task)).status).toBe('failed');
    expect(commands).toHaveLength(1);
  });
  it('does not mistake a failed reload containing the word reload for success', async () => {
    const { config, task, root } = await fixture();
    const plugin = pluginDirectory(root, task.instance.id, 'ArkShop');
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, 'config.json'), JSON.stringify({ General: {}, ShopItems: {} }));
    const read = await readShop(root, task.instance.id);
    task.kind = 'shop-publish';
    task.instance.status = 'running';
    task.payload = { config: { General: {}, ShopItems: {} }, expectedHash: read.shopHash };
    const runtime = new ManagementRuntime(
      config,
      new AgentClient(config),
      new Set(),
      async () => "Couldn't reload config",
    );
    const result = await runtime.runTask(task);
    expect(result.status).toBe('failed');
    expect(result.result.filePublished).toBe(true);
  });
  it('parses exact ArkShop balance replies and validates player samples', () => {
    expect(parsePoints('Player has 126 points\n')).toBe(126);
    expect(() => parsePoints("Couldn't get points amount")).toThrow();
    expect(parsePlayerList('0. 中文玩家, 76561198000000001\n')[0]?.name).toBe('中文玩家');
    expect(() => parsePlayerList('Unknown command')).toThrow();
  });
  it('retains raw shop events without inventing a debit or fulfilment', () => {
    const event = parseCommerceLine(
      '[2026-11-05 12:00:00] [TheIsland] 玩家(76561198000000001) Bought kit: starter',
      'map',
      'file:offset',
    );
    expect(event?.kind).toBe('arkshop-log');
    expect(event?.detail.raw).toContain('starter');
    expect(event?.detail.amount).toBeUndefined();
    expect(parseCommerceLine('map started', 'map', 'other')).toBeNull();
  });
});
describe('shop publication boundaries', () => {
  it('keeps host credentials, backs up bytes and rejects a stale file hash', async () => {
    const { root, task } = await fixture();
    const directory = pluginDirectory(root, task.instance.id, 'ArkShop');
    await mkdir(directory, { recursive: true });
    const original = {
      Mysql: { UseMysql: true, MysqlHost: 'db.example.test', MysqlDB: 'ark', MysqlPass: 'private' },
      General: { Discord: { WebhookURL: 'private-webhook' } },
      ShopItems: { stone: { Price: 10, Type: 'item' } },
    };
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(original));
    const info = await readShop(root, task.instance.id);
    expect(JSON.stringify(info)).not.toContain('private');
    const config = { ...info.config, ShopItems: { stone: { Price: 20, Type: 'item' } } } as Record<
      string,
      Json
    >;
    const published = await publishShop(root, task.instance.id, task.id, config, info.shopHash);
    const result = JSON.parse(await readFile(path, 'utf8'));
    expect(result.Mysql.MysqlPass).toBe('private');
    expect(result.General.Discord.WebhookURL).toBe('private-webhook');
    expect(result.ShopItems.stone.Price).toBe(20);
    expect(JSON.parse(await readFile(published.backupPath, 'utf8'))).toEqual(original);
    await expect(
      publishShop(root, task.instance.id, randomUUID(), config, info.shopHash),
    ).rejects.toThrow('已变化');
  });
  it('does not claim independent SQLite or per-host localhost databases are shared', () => {
    expect(databaseSignature({ UseMysql: false }, 'Permissions')).toBeNull();
    expect(
      databaseSignature({ UseMysql: true, MysqlHost: 'localhost', MysqlDB: 'ark' }, 'Permissions'),
    ).toBeNull();
    const first = databaseSignature(
      { UseMysql: true, MysqlHost: 'db.test', MysqlDB: 'ark', MysqlPass: 'a' },
      'Permissions',
    );
    expect(first).toBeTruthy();
    expect(first).toBe(
      databaseSignature(
        { UseMysql: true, MysqlHost: 'db.test', MysqlDB: 'ark', MysqlPass: 'b' },
        'Permissions',
      ),
    );
    expect(first).not.toBe(
      databaseSignature({ UseMysql: true, MysqlHost: 'db.test', MysqlDB: 'other' }, 'Permissions'),
    );
  });
});

describe('owned Windows firewall rules', () => {
  it('rejects loopback and forwarding addresses before any OS command', async () => {
    const { root, task } = await fixture();
    let calls = 0;
    const rules = new ManagedFirewall(
      root,
      async () => {
        calls++;
      },
      'win32',
    );
    for (const ip of ['127.0.0.1', '10.126.126.1', '10.126.126.2', '0.0.0.0'])
      await expect(rules.apply(task, ip)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it('persists ownership and cleans only the deleted maps own rule', async () => {
    const { root, task } = await fixture();
    task.instanceId = task.instance.id;
    task.instance.gamePort = 7777;
    task.instance.queryPort = 27015;
    task.kind = 'ban';
    task.payload.banId = randomUUID();
    const calls: { file: string; args: string[] }[] = [];
    const rules = new ManagedFirewall(
      root,
      async (file, args) => {
        calls.push({ file, args });
      },
      'win32',
    );
    await rules.apply(task, '198.51.100.20');
    expect(calls[0]?.args).toContain('localport=7777,7778,27015');
    await rules.release(randomUUID());
    expect(calls).toHaveLength(1);
    await rules.release(task.instanceId);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.file).toBe('powershell.exe');
    const script = Buffer.from(calls[1]!.args.at(-1)!, 'base64').toString('utf16le');
    expect(script).toContain(task.instanceId);
    expect(script).toContain('-ceq');
  });
  it('retains an unknown OS result for later cleanup after a timeout', async () => {
    const { root, task } = await fixture();
    task.instanceId = task.instance.id;
    task.payload.banId = randomUUID();
    task.kind = 'ban';
    const rules = new ManagedFirewall(
      root,
      async () => {
        throw new Error('process timed out');
      },
      'win32',
    );
    await expect(rules.apply(task, '198.51.100.20')).rejects.toThrow();
    let cleaned = 0;
    await new ManagedFirewall(
      root,
      async () => {
        cleaned++;
      },
      'win32',
    ).release(task.instanceId);
    expect(cleaned).toBe(1);
  });
  it('does not retain a rule when Windows explicitly rejects its creation', async () => {
    const { root, task } = await fixture();
    task.instanceId = task.instance.id;
    task.payload.banId = randomUUID();
    task.kind = 'ban';
    const rules = new ManagedFirewall(
      root,
      async () => {
        throw Object.assign(new Error('access denied'), { code: 1 });
      },
      'win32',
    );
    await expect(rules.apply(task, '198.51.100.20')).rejects.toThrow();
    let cleaned = 0;
    await new ManagedFirewall(
      root,
      async () => {
        cleaned++;
      },
      'win32',
    ).release(task.instanceId);
    expect(cleaned).toBe(0);
  });
  it('reports unsupported Permissions replies instead of displaying a false successful sync', () => {
    expect(parsePermissionGroups('Groups: Default, VIP')).toContain('VIP');
    expect(() => parsePermissionGroups('Server received')).toThrow('未返回');
    expect(() => parsePermissionGroups('Unknown command')).toThrow('未返回');
  });
});

describe('configuration diagnostics and concurrent resource ownership', () => {
  it('does not expose credential fragments in malformed JSON errors', async () => {
    const { root, task } = await fixture();
    const directory = pluginDirectory(root, task.instance.id, 'ArkShop');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'config.json'),
      '{"MysqlPass":"private-credential-fragment",broken}',
    );
    await expect(readShop(root, task.instance.id)).rejects.toThrow('ArkShop 配置不是有效');
    try {
      await readShop(root, task.instance.id);
    } catch (error) {
      expect(String(error)).not.toContain('private-credential-fragment');
    }
  });
  it('serializes ownership changes from different maps using the same host root', async () => {
    const { root, task } = await fixture();
    task.instanceId = task.instance.id;
    task.payload.banId = randomUUID();
    task.kind = 'ban';
    const other = {
      ...task,
      id: randomUUID(),
      instanceId: randomUUID(),
      payload: { ...task.payload, banId: randomUUID() },
    };
    const executor = async () => {
      await new Promise((yes) => setTimeout(yes, 10));
    };
    await Promise.all([
      new ManagedFirewall(root, executor, 'win32').apply(task, '198.51.100.20'),
      new ManagedFirewall(root, executor, 'win32').apply(other, '198.51.100.21'),
    ]);
    const registry = JSON.parse(await readFile(join(root, 'managed-firewall.json'), 'utf8'));
    expect(registry[task.instanceId]).toHaveLength(1);
    expect(registry[other.instanceId]).toHaveLength(1);
  });
});

describe('partial shop import', () => {
  it('preserves private host settings even when an imported file omits General', async () => {
    const { root, task } = await fixture();
    const directory = pluginDirectory(root, task.instance.id, 'ArkShop');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        Mysql: { MysqlPass: 'private' },
        General: { Discord: { WebhookURL: 'private-webhook' } },
        ShopItems: {},
      }),
    );
    const current = await readShop(root, task.instance.id);
    await publishShop(root, task.instance.id, task.id, { ShopItems: {} }, current.shopHash);
    const written = JSON.parse(await readFile(path, 'utf8'));
    expect(written.General.Discord.WebhookURL).toBe('private-webhook');
    expect(written.Mysql.MysqlPass).toBe('private');
  });
});
