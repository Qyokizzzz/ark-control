import { describe, expect, it, vi } from 'vitest';
import {
  formatTribeMessage,
  normalizeTribeLog,
  estimateCapacity,
  validatePortAllocation,
  isHostOnline,
  canDeleteStoppedInstance,
  createOperationId,
} from './index';
import { createInstanceSchema, gameConfigSchema } from '@common/schemas';
import type { Host, Instance } from '@common/types';

const host: Host = {
  id: '00000000-0000-4000-8000-000000000001',
  name: '测试主机',
  address: '',
  platform: 'windows',
  status: 'online',
  metrics: {
    cpuPercent: 25,
    cpuCores: 8,
    cpuModel: 'Test CPU',
    totalMemoryMb: 32768,
    freeMemoryMb: 22000,
    diskFreeGb: 200,
    diskTotalGb: 500,
    gameDiskMeasured: true,
    sampledAt: new Date().toISOString(),
  },
  lastSeenAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  agentVersion: '1.0.0',
};
const instance: Instance = {
  id: '00000000-0000-4000-8000-000000000002',
  hostId: host.id,
  name: '孤岛服',
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
};

describe('explicit host disconnect state', () => {
  it('a recent heartbeat does not make a disconnecting or disconnected host available', () => {
    const now = Date.now();
    expect(
      isHostOnline({ ...host, status: 'online', lastSeenAt: new Date(now).toISOString() }, now),
    ).toBe(true);
    for (const status of ['disconnecting', 'disconnected', 'unconfigured'] as const)
      expect(isHostOnline({ ...host, status, lastSeenAt: new Date(now).toISOString() }, now)).toBe(
        false,
      );
    expect(isHostOnline({ ...host, lastSeenAt: new Date(now - 31000).toISOString() }, now)).toBe(
      false,
    );
  });
});
describe('stopped map deletion and HTTP controls', () => {
  it('permits a confirmed stopped map without relying on host availability but rejects active work', () => {
    expect(canDeleteStoppedInstance(instance)).toBe(true);
    expect(canDeleteStoppedInstance({ ...instance, installed: true })).toBe(true);
    expect(canDeleteStoppedInstance({ ...instance, status: 'error' })).toBe(true);
    expect(canDeleteStoppedInstance(instance, true)).toBe(false);
    expect(canDeleteStoppedInstance({ ...instance, pid: 123 })).toBe(false);
    expect(canDeleteStoppedInstance({ ...instance, desiredState: 'running' })).toBe(true);
    expect(canDeleteStoppedInstance({ ...instance, status: 'unknown' })).toBe(false);
  });
  it('creates valid independent request identifiers when a browser has no randomUUID on HTTP', () => {
    const random = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal('crypto', { getRandomValues: random });
    try {
      const ids = [createOperationId(), createOperationId(), createOperationId()];
      expect(new Set(ids).size).toBe(3);
      for (const id of ids)
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('已确认的部落消息格式', () => {
  it('严格使用地图、部落、正文和半角计数', () => {
    expect(formatTribeMessage('孤岛', '飞龙部落', '你的霸王龙已死亡', 3)).toBe(
      '孤岛-飞龙部落： 你的霸王龙已死亡 (3)',
    );
  });
  it('单条也显示数量 1', () => {
    expect(formatTribeMessage('仙境', '海岸', '成员加入', 1)).toBe('仙境-海岸： 成员加入 (1)');
  });
  it('忽略游戏时间和颜色，相同事件才合并', () => {
    expect(
      normalizeTribeLog('Day 81, 12:13:14: <RichColor Color="1,0,0,1">你的霸王龙已死亡</>'),
    ).toBe('你的霸王龙已死亡');
  });
  it('保留实体名称和等级，避免不同对象混算', () => {
    expect(normalizeTribeLog('Day 82, 12:00:00: 阿强 - Lvl 247 (Rex) died')).not.toBe(
      normalizeTribeLog('Day 82, 12:00:01: 阿强 - Lvl 248 (Rex) died'),
    );
  });
  it('保留名称中的普通尖括号，不把玩家名当作颜色标记', () => {
    expect(normalizeTribeLog('Day 82, 12:00:00: <Bob> joined')).toBe('<Bob> joined');
    expect(normalizeTribeLog('<Bob> joined')).not.toBe(normalizeTribeLog('<Alice> joined'));
  });
  it('不吞掉带日期的日志正文', () => {
    expect(normalizeTribeLog('[2026.11.03-12.13.14:123] Day 81, 12:13:14: 成员加入')).toBe(
      '成员加入',
    );
  });
});
describe('资源预检与端口', () => {
  it('离线主机必须显示无法判断', () => {
    expect(estimateCapacity({ ...host, status: 'offline' }, [], 20, 0).verdict).toBe('unknown');
  });
  it('为运行系统和并发启动预留内存', () => {
    const result = estimateCapacity(
      host,
      [
        { ...instance, status: 'starting' },
        { ...instance, id: 'installing', status: 'installing' },
        { ...instance, id: 'other-host', hostId: 'other', status: 'starting' },
      ],
      20,
      0,
    );
    expect(result.availableMemoryMb).toBe(10224);
    expect(result.reserveMemoryMb).toBe(3072);
  });
  it('工作盘少于原来的 35 GB 仍可启动，空间很低时提示存档和日志占用', () => {
    const withDisk = (diskFreeGb: number) => ({
      ...host,
      metrics: { ...host.metrics!, diskFreeGb },
    });
    expect(estimateCapacity(withDisk(20), [], 20, 0).blockingReasons).toEqual([]);
    const low = estimateCapacity(withDisk(2), [], 20, 0);
    expect(low.verdict).toBe('tight');
    expect(low.explanation.join(' ')).toContain('2.00 GB');
  });
  it('仅以测得的游戏工作盘判断磁盘耗尽，旧采样或未采集都不阻止启动', () => {
    const diskFull = { ...host.metrics!, diskFreeGb: 0 };
    const full = estimateCapacity({ ...host, metrics: diskFull }, [], 20, 0);
    expect(full.verdict).toBe('insufficient');
    expect(full.blockingReasons).toEqual(['游戏工作盘已满，启动后无法写入日志和存档。']);
    const legacy = estimateCapacity(
      { ...host, metrics: { ...diskFull, gameDiskMeasured: undefined } },
      [],
      20,
      0,
    );
    expect(legacy.blockingReasons).toEqual([]);
    const unmeasured = estimateCapacity(
      { ...host, metrics: { ...diskFull, diskTotalGb: 0, gameDiskMeasured: false } },
      [],
      20,
      0,
    );
    expect(unmeasured.blockingReasons).toEqual([]);
  });
  it('区分内存预算和 CPU 拦截，显示实际采样值', () => {
    const metrics = { ...host.metrics!, freeMemoryMb: 16 * 1024, cpuPercent: 93 };
    const result = estimateCapacity(
      { ...host, metrics },
      [{ ...instance, status: 'starting' }],
      20,
      0,
    );
    expect(result.blockingReasons).toEqual([
      expect.stringMatching(/16\.0 GB.*其他待启动地图 8\.5 GB.*4\.5 GB.*8\.5 GB/),
      expect.stringContaining('93.0%'),
    ]);
  });
  it('附属游戏端口也参与 UDP 冲突检测', () => {
    expect(
      validatePortAllocation(
        { ...instance, id: 'other', gamePort: 7778, queryPort: 27016, rconPort: 27021 },
        [instance],
      ),
    ).toContain('冲突');
  });
  it('相同地图不同主机可以重复使用端口', () => {
    expect(
      validatePortAllocation({ ...instance, id: 'other', hostId: 'other-host' }, [instance]),
    ).toBeNull();
  });
  it('阻止附属端口与查询端口重叠', () => {
    expect(validatePortAllocation({ ...instance, queryPort: 7778 }, [])).not.toBeNull();
  });
});
describe('输入边界', () => {
  it('拒绝命令行式地图名称和非法模组 ID', () => {
    expect(
      createInstanceSchema.safeParse({ hostId: host.id, name: 'test', map: 'TheIsland; shutdown' })
        .success,
    ).toBe(false);
    expect(gameConfigSchema.safeParse({ modIds: ['123;shutdown'] }).success).toBe(false);
  });
  it('允许正常模组加载顺序', () => {
    expect(gameConfigSchema.parse({ modIds: ['731604991', '1404697612'] }).modIds).toEqual([
      '731604991',
      '1404697612',
    ]);
  });
});
