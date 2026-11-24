import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, relative, resolve } from 'node:path';
import { gameConfigSchema } from '@ark-control/common';
import type { AgentInstance } from '@ark-control/common';
import { LogReader, parseTribeLine } from './index';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const location = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(location) || location.startsWith('..') || !location.startsWith('ark-log-test-'))
      throw new Error('拒绝清理非测试目录。');
    await rm(root, { recursive: true, force: true });
  }
});
describe('部落来源解析', () => {
  it('按明确的部落 ID 识别原生日志', () => {
    expect(parseTribeLine('Tribe 飞龙部落, ID 12345: Your Rex died')?.tribeId).toBe('12345');
  });
  it('结构化日志保留上游幂等标识', () => {
    expect(
      parseTribeLine(
        JSON.stringify({
          tribeId: '123',
          tribeName: '海岸',
          text: '角色加入',
          sourceId: 'boot-1:7',
        }),
      )?.sourceId,
    ).toBe('boot-1:7');
  });
  it('无部落标识时不猜测归属', () => {
    expect(parseTribeLine('Your Rex was killed by tribe 飞龙部落')).toBeNull();
  });
  it('拒绝没有正文的结构化日志', () => {
    expect(parseTribeLine('{"tribeId":"123","text":""}')).toBeNull();
  });
  it('读取跨批次的中文 UTF8 行，重启后仍保留待上传事件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ark-log-test-'));
    roots.push(root);
    const instance: AgentInstance = {
      id: '00000000-0000-4000-8000-000000000001',
      hostId: 'host',
      name: '孤岛',
      map: 'TheIsland',
      mapLabel: '孤岛',
      clusterId: '',
      gamePort: 7777,
      queryPort: 27015,
      rconPort: 27020,
      status: 'running',
      desiredState: 'running',
      installed: true,
      config: gameConfigSchema.parse({}),
      autoRestart: false,
      cpuPercent: 0,
      memoryMb: 0,
      pid: null,
      startedAt: null,
      lastError: null,
      buildId: null,
      createdAt: new Date().toISOString(),
      rconPassword: 'test',
    };
    const folder = join(
      root,
      'instances',
      instance.id,
      'ShooterGame',
      'Binaries',
      'Win64',
      'ArkApi',
      'Plugins',
      'ArkTribeBridge',
    );
    await mkdir(folder, { recursive: true });
    const file = join(folder, 'events.jsonl');
    await appendFile(file, '');
    const reader = new LogReader(root, () => undefined);
    await reader.initialize();
    await reader.collect([instance]);
    const payload = Buffer.from(
      JSON.stringify({
        tribeId: '123',
        tribeName: '飞龙部落',
        text: '你的霸王龙已死亡',
        occurredAt: new Date().toISOString(),
      }) + '\n',
    );
    const firstChinese = payload.indexOf(Buffer.from('飞'));
    const split = firstChinese + 1;
    await appendFile(file, payload.subarray(0, split));
    await reader.collect([instance]);
    expect(reader.batch()).toHaveLength(0);
    await appendFile(file, payload.subarray(split));
    await reader.collect([instance]);
    expect(reader.batch()[0]?.tribeName).toBe('飞龙部落');
    expect(reader.batch()[0]?.text).toBe('你的霸王龙已死亡');
    const restored = new LogReader(root, () => undefined);
    await restored.initialize();
    expect(restored.batch()).toHaveLength(1);
    await restored.acknowledge(1);
    await restored.collect([instance]);
    expect(restored.batch()).toHaveLength(0);
    expect(await readFile(join(root, 'log-cursors.json'), 'utf8')).not.toContain('你的霸王龙');
    const longText = '完整部落日志'.repeat(1500);
    await appendFile(file, JSON.stringify({ tribeId: '123', text: longText }) + '\n');
    await restored.collect([instance]);
    expect(restored.batch()[0]?.text).toBe(longText);
    await restored.collect([]);
    expect(restored.batch()).toHaveLength(0);
    const remaining = JSON.parse(await readFile(join(root, 'log-cursors.json'), 'utf8')) as {
      cursors: object;
      pending: unknown[];
    };
    expect(remaining.cursors).toEqual({});
    expect(remaining.pending).toEqual([]);
  });
});

describe('credential-safe game output', () => {
  it('masks startup arguments and tribe payload credentials before the console and outbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ark-log-test-'));
    roots.push(root);
    const instance = {
      id: '00000000-0000-4000-8000-000000000002',
      rconPassword: 'private-admin-secret',
      config: gameConfigSchema.parse({ serverPassword: 'private-join-secret' }),
    } as AgentInstance;
    const output: string[] = [];
    const reader = new LogReader(
      root,
      () => undefined,
      (_id, line) => output.push(line),
    );
    await reader.initialize();
    const saved = join(root, 'instances', instance.id, 'ShooterGame/Saved/Logs');
    await mkdir(saved, { recursive: true });
    await writeFile(
      join(saved, 'ArkControlProcess.log'),
      'Commandline: TheIsland?RCONEnabled=True?ServerAdminPassword=private-admin-secret -log\n',
    );
    await writeFile(
      join(saved, 'tribe.log'),
      'Tribe test, ID 123: ServerPassword=private-join-secret\n',
    );
    await reader.collect([instance]);
    expect(output.join('\n')).toContain('ServerAdminPassword=[已隐藏]');
    expect(output.join('\n')).not.toContain('private-admin-secret');
    expect(reader.batch()[0]?.text).toContain('[已隐藏]');
    expect(await readFile(join(root, 'log-cursors.json'), 'utf8')).not.toMatch(
      /private-admin-secret|private-join-secret/,
    );
  });
});
