import { describe, expect, it } from 'vitest';
import type { Instance } from '@common/types';
import {
  emptyPlayer,
  playerScope,
  playerScopes,
  publicShopConfig,
  validateShopConfig,
} from './index';
describe('player scopes and shop drafts', () => {
  it('shares identities within a cluster and isolates standalone maps and other clusters', () => {
    const a = { id: 'a', clusterId: 'one', name: 'A' } as Instance;
    const b = { id: 'b', clusterId: 'one', name: 'B' } as Instance;
    const c = { id: 'c', clusterId: '', name: 'C' } as Instance;
    const d = { id: 'd', clusterId: '', name: 'D' } as Instance;
    expect(playerScope(a)).toBe(playerScope(b));
    expect(playerScope(c)).not.toBe(playerScope(d));
    expect(playerScopes([a, b, c, d])).toHaveLength(3);
    expect(emptyPlayer(playerScope(a), '76561198000000001').id).not.toBe(
      emptyPlayer('cluster:two', '76561198000000001').id,
    );
  });
  it('redacts database and webhook configuration without mutating the host object', () => {
    const host = {
      Mysql: { MysqlPass: 'private' },
      UseMysql: true,
      General: { Discord: { WebhookURL: 'secret' }, WelcomeMessage: 'hello' },
      ShopItems: { stone: { Price: 100 } },
    };
    const safe = publicShopConfig(host);
    expect(safe.Mysql).toBeUndefined();
    expect(safe.UseMysql).toBeUndefined();
    expect(safe.General).toEqual({ WelcomeMessage: 'hello' });
    expect(host.Mysql.MysqlPass).toBe('private');
  });
  it('rejects invalid price, ID, category and level ranges while preserving unknown item fields', () => {
    expect(
      validateShopConfig({ ShopItems: { stone: { Price: 10, CustomPluginField: true } } }),
    ).toEqual([]);
    expect(
      validateShopConfig({ ShopItems: { 'bad id': { Price: -1, MinLevel: 100, MaxLevel: 1 } } }),
    ).toHaveLength(3);
    expect(validateShopConfig({ Kits: [] })).toHaveLength(1);
  });
});
