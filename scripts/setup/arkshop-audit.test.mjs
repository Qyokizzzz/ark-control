import { describe, it, expect } from 'vitest';
import { instrumentPoints } from '../../native/ArkShopAudit/instrument.mjs';
describe('optional ArkShop source instrumentation', () => {
  it('adds observations only on the three known successful mutation paths', () => {
    const source = ['AddPoints', 'SpendPoints', 'SetPoints']
      .map(
        (name) =>
          `bool ${name}(int ${name === 'SetPoints' ? 'new_amount' : 'amount'}, uint64 steam_id) { const bool ok = database->Change(steam_id); if(!ok) return false; return true; }`,
      )
      .join('\n');
    const result = instrumentPoints(source);
    expect((result.match(/ArkControlCommerce::Record/g) ?? []).length).toBe(3);
    expect(result).toContain('points-debit');
    expect(result).toContain('-static_cast<long long>(amount)');
    expect(result).toContain('#include "ArkControlCommerce.h"');
    expect(() => instrumentPoints(result)).toThrow('已插入');
  });
  it('fails closed on an unknown plugin signature rather than guessing a hook', () => {
    expect(() => instrumentPoints('bool Other(){return true;}')).toThrow('未适配');
  });
});
