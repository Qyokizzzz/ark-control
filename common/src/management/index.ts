import type { GameBranch, Instance, Json, PlayerScope } from '@common/types';

export * from './independent-shop';

export const GAME_BRANCHES = [
  { value: 'public', label: '公开分支（361 系列，跟随 Steam 更新）' },
  { value: 'preaquatica', label: 'preaquatica（358 系列，跟随 Steam 更新）' },
] as const;
export const gameBranch = (value: string | undefined): GameBranch =>
  value === 'preaquatica' ? 'preaquatica' : 'public';
export const playerScope = (instance: Pick<Instance, 'id' | 'clusterId'>) =>
  instance.clusterId ? `cluster:${instance.clusterId}` : `instance:${instance.id}`;
export function playerScopes(instances: Instance[]): PlayerScope[] {
  const values = new Map<string, PlayerScope>();
  for (const instance of instances) {
    const id = playerScope(instance);
    const scope = values.get(id) ?? {
      id,
      name: instance.clusterId || `独立服 · ${instance.name}`,
      instanceIds: [],
      branch: gameBranch(instance.branch),
    };
    scope.instanceIds.push(instance.id);
    values.set(id, scope);
  }
  return [...values.values()];
}
export const playerKey = (scopeId: string, steamId: string) => `${scopeId}:${steamId}`;
export const activeManagement = (task: { status: string }) =>
  ['queued', 'leased', 'executing'].includes(task.status);
export const activeBan = (ban: { revokedAt: string | null; expiresAt: string | null }) =>
  !ban.revokedAt && (!ban.expiresAt || Date.parse(ban.expiresAt) > Date.now());
export function emptyPlayer(
  scopeId: string,
  steamId: string,
  name = steamId,
): import('@common/types').ManagedPlayer {
  const now = new Date().toISOString();
  return {
    id: playerKey(scopeId, steamId),
    scopeId,
    steamId,
    name,
    names: [name],
    firstSeenAt: now,
    lastSeenAt: now,
    onlineMaps: [],
    lastMapId: null,
    onlineSeconds: 0,
    tribeId: null,
    tribeName: null,
    addresses: [],
    devices: [],
    note: '',
    balance: null,
    balanceUpdatedAt: null,
    vip: [],
    vipUpdatedAt: null,
  };
}
/** Keep database and webhook credentials on the game host, never in the web editor. */
export function publicShopConfig(input: Record<string, Json>): Record<string, Json> {
  const result = JSON.parse(JSON.stringify(input)) as Record<string, Json>;
  for (const key of Object.keys(result)) if (/mysql|database/i.test(key)) delete result[key];
  const general = result.General;
  if (general && typeof general === 'object' && !Array.isArray(general)) delete general.Discord;
  return result;
}
export function validateShopConfig(config: Record<string, Json>): string[] {
  const errors: string[] = [];
  if (
    config.General !== undefined &&
    (!config.General || typeof config.General !== 'object' || Array.isArray(config.General))
  )
    errors.push('General 必须是对象。');
  for (const category of ['ShopItems', 'SellItems', 'Kits']) {
    const entries = config[category];
    if (entries === undefined) continue;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      errors.push(`${category} 必须是对象。`);
      continue;
    }
    for (const [id, value] of Object.entries(entries)) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) errors.push(`商品 ID 格式无效：${id}`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${id} 必须是商品对象。`);
        continue;
      }
      for (const key of ['Price', 'DefaultAmount', 'MinLevel', 'MaxLevel']) {
        const number = value[key];
        if (
          number !== undefined &&
          (!Number.isSafeInteger(number) ||
            (number as number) < 0 ||
            (number as number) > 2147483647)
        )
          errors.push(`${id}.${key} 必须是 0～2147483647 的整数。`);
      }
      if (
        typeof value.MinLevel === 'number' &&
        typeof value.MaxLevel === 'number' &&
        value.MinLevel > value.MaxLevel
      )
        errors.push(`${id} 的最低等级高于最高等级。`);
    }
  }
  if (JSON.stringify(config).length > 1_000_000) errors.push('商店配置超过 1 MB。');
  return errors;
}
