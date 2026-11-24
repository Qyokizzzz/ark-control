import type { CapacityEstimate, Command, Host, Instance } from '@common/types';

export function isHostOnline(host: Host | null | undefined, now = Date.now()): boolean {
  return (
    !!host &&
    host.status === 'online' &&
    !!host.lastSeenAt &&
    now - Date.parse(host.lastSeenAt) < 30000
  );
}
export function canDeleteStoppedInstance(instance: Instance, busy = false): boolean {
  return !busy && !instance.pid && ['stopped', 'error'].includes(instance.status);
}
export function canTerminateStartup(
  instance: Pick<Instance, 'status' | 'pid' | 'startup'>,
  active?: Pick<Command, 'kind' | 'payload'>,
): boolean {
  const starting =
    instance.status === 'starting' ||
    (instance.status === 'unknown' &&
      !!instance.startup &&
      ['preparing', 'launching', 'loading'].includes(instance.startup.stage));
  if (!active) return starting;
  if (active.kind === 'start') return instance.status !== 'running';
  if (active.kind === 'restart')
    return starting || (instance.status === 'stopped' && !instance.pid);
  return active.kind === 'update' && active.payload.maintenance === true && starting;
}
export function createOperationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeTribeLog(text: string): string {
  return text
    .replace(/<\/?RichColor[^>]*>/gi, '')
    .replace(/<\/>/g, '')
    .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
    .replace(
      /^\s*(?:\[\d{4}[./-]\d{2}[./-]\d{2}[^\]]*\]\s*)?(?:Day\s+\d+\s*,\s*\d{1,2}:\d{2}:\d{2}\s*:\s*)?/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatTribeMessage(
  map: string,
  tribe: string,
  text: string,
  count: number,
): string {
  return `${map}-${tribe}： ${text} (${count})`;
}

const mapMemoryBudget = (maxPlayers: number, mods: number) => 6144 + maxPlayers * 128 + mods * 384;
const memoryGb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export function estimateCapacity(
  host: Host,
  existing: Instance[],
  maxPlayers: number,
  mods: number,
): CapacityEstimate {
  const estimatedMemoryMb = mapMemoryBudget(maxPlayers, mods);
  const reserveMemoryMb = 3072;
  if (!host.metrics || host.status !== 'online') {
    return {
      verdict: 'unknown',
      availableMemoryMb: 0,
      estimatedMemoryMb,
      reserveMemoryMb,
      blockingReasons: [],
      explanation: ['主机尚未提供在线资源数据，接入后才能评估。'],
    };
  }
  const { freeMemoryMb, cpuPercent, diskFreeGb, diskTotalGb, gameDiskMeasured } = host.metrics;
  const reservations = existing
    .filter((item) => item.hostId === host.id && item.status === 'starting')
    .reduce(
      (sum, item) =>
        sum +
        Math.max(
          0,
          mapMemoryBudget(item.config.maxPlayers, item.config.modIds.length) - item.memoryMb,
        ),
      0,
    );
  const availableMemoryMb = Math.max(0, freeMemoryMb - reserveMemoryMb - reservations);
  const diskKnown = gameDiskMeasured === true && diskTotalGb > 0;
  const diskLow = diskKnown && diskFreeGb < 5;
  const blockingReasons: string[] = [];
  if (availableMemoryMb < estimatedMemoryMb) {
    const pending = reservations ? `、其他待启动地图 ${memoryGb(reservations)}` : '';
    blockingReasons.push(
      `主机可用内存 ${memoryGb(freeMemoryMb)}，预留系统 ${memoryGb(reserveMemoryMb)}${pending}后剩余 ${memoryGb(availableMemoryMb)}，低于本地图的启动预算 ${memoryGb(estimatedMemoryMb)}。`,
    );
  }
  if (cpuPercent >= 90)
    blockingReasons.push(`主机采样 CPU 使用率为 ${cpuPercent.toFixed(1)}%，达到 90% 的启动上限。`);
  if (diskKnown && diskFreeGb === 0)
    blockingReasons.push('游戏工作盘已满，启动后无法写入日志和存档。');

  const explanation = ['地图的内存预算按玩家上限和模组数量估算。', ...blockingReasons];
  if (diskLow && diskFreeGb > 0)
    explanation.push(`游戏工作盘剩余 ${diskFreeGb.toFixed(2)} GB，存档和日志仍会增长。`);

  const tight = availableMemoryMb < estimatedMemoryMb * 1.3 || cpuPercent >= 65 || diskLow;
  const verdict = blockingReasons.length ? 'insufficient' : tight ? 'tight' : 'sufficient';
  return {
    verdict,
    availableMemoryMb,
    estimatedMemoryMb,
    reserveMemoryMb,
    blockingReasons,
    explanation,
  };
}

export function validatePortAllocation(
  candidate: Pick<Instance, 'id' | 'hostId' | 'gamePort' | 'queryPort' | 'rconPort'>,
  existing: Instance[],
): string | null {
  const udp = [candidate.gamePort, candidate.gamePort + 1, candidate.queryPort];
  if (new Set(udp).size !== udp.length) return '游戏端口、游戏附属端口和查询端口不能重复。';
  for (const item of existing) {
    if (item.id === candidate.id || item.hostId !== candidate.hostId) continue;
    const used = [item.gamePort, item.gamePort + 1, item.queryPort];
    if (udp.some((port) => used.includes(port)) || candidate.rconPort === item.rconPort)
      return `端口与「${item.name}」冲突。`;
  }
  return null;
}
