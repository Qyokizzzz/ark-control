import { describe, expect, it } from 'vitest';
import { INI_SECTIONS, effectiveGameConfig, gameConfigSchema, mergeIni } from '@ark-control/common';
import {
  advancedById,
  imprintEstimate,
  manualOverrides,
  optionId,
  readGameForm,
  saveGameForm,
  validCustomKey,
} from './index';

const turret = { file: 'game', section: INI_SECTIONS.game, key: 'LimitTurretsNum' } as const;
const limit = { ...turret, key: 'bLimitTurretsInRange' };
const interval = { ...turret, key: 'BabyCuddleIntervalMultiplier' };
const wildHealth = { ...turret, key: 'PerLevelStatsMultiplier_DinoWild[0]' };

describe('the instance INI form', () => {
  it('shows documented defaults without adding rows to a new INI', () => {
    expect(advancedById.get(optionId(turret))).toMatchObject({
      kind: 'integer',
      defaultValue: 100,
    });
    expect(advancedById.get(optionId(limit))).toMatchObject({ kind: 'switch', defaultValue: true });
    expect(advancedById.get(optionId(wildHealth))).toMatchObject({
      kind: 'number',
      defaultValue: 1,
    });
    expect(advancedById.size).toBeGreaterThan(400);
    const current = gameConfigSchema.parse({});
    const draft = readGameForm(current);
    const next = saveGameForm(current, draft.basic, draft.advanced, draft.manual);
    expect(next.advancedIni).toEqual({ settings: '', game: '' });
    expect(next.babyMature).toBe(current.babyMature);
  });

  it('preserves old raw INI and lets manual overrides take precedence without losing the form value', () => {
    const current = gameConfigSchema.parse({
      extraGameIni: 'limitturretsnum=125\n; existing note\n[ModInstaller]\nModIDS=1234',
      extraSettingsIni: 'harvestamountmultiplier=9\n[MyMod]\nRate=0.5',
    });
    const draft = readGameForm(current);
    expect(manualOverrides(draft.manual).get(optionId(turret))?.[0]?.value).toBe('125');
    draft.basic.harvest = '3';
    draft.advanced.set(optionId(turret), [{ ...turret, value: '150', modifier: '' }]);
    const next = saveGameForm(current, draft.basic, draft.advanced, draft.manual);
    expect(next.extraGameIni).toBe(current.extraGameIni);
    expect(next.extraSettingsIni).toBe(current.extraSettingsIni);
    expect(next.advancedIni?.game).toContain('LimitTurretsNum=150');
    expect(effectiveGameConfig(next).harvest).toBe(9);
    const combined = mergeIni('game', next.advancedIni!.game, next.extraGameIni);
    expect(combined).toContain('limitturretsnum=125');
    expect(combined).not.toContain('LimitTurretsNum=150');

    const reopened = readGameForm(next);
    expect(reopened.advanced.get(optionId(turret))?.[0]?.value).toBe('150');
    reopened.manual.game = '';
    reopened.manual.settings = '';
    const revealed = saveGameForm(next, reopened.basic, reopened.advanced, reopened.manual);
    expect(revealed.advancedIni?.game).toContain('LimitTurretsNum=150');
    expect(effectiveGameConfig(revealed).harvest).toBe(3);
  });

  it('keeps false switches, indexed keys and repeatable mod values as distinct INI entries', () => {
    const current = gameConfigSchema.parse({});
    const draft = readGameForm(current);
    const custom = { file: 'settings', section: 'ExampleMod', key: 'Rule' } as const;
    draft.advanced.set(optionId(custom), [
      { ...custom, modifier: '', value: '(Name="A",Rate=2)' },
      { ...custom, modifier: '+', value: '(Name="B",Rate=3)' },
    ]);
    draft.advanced.set(optionId(limit), [{ ...limit, modifier: '', value: 'False' }]);
    draft.advanced.set(optionId(wildHealth), [{ ...wildHealth, modifier: '', value: '2.5' }]);
    const saved = saveGameForm(current, draft.basic, draft.advanced, draft.manual);
    expect(saved.advancedIni?.game).toContain('bLimitTurretsInRange=False');
    expect(saved.advancedIni?.game).toContain('PerLevelStatsMultiplier_DinoWild[0]=2.5');
    expect(readGameForm(saved).advanced.get(optionId(custom))).toEqual(
      draft.advanced.get(optionId(custom)),
    );
    expect(validCustomKey('game', INI_SECTIONS.game, 'limitturretsnum')).toMatch(/已有表单/);
    expect(validCustomKey('settings', 'ExampleMod', 'ExampleStats[1]')).toBeUndefined();
  });

  it('validates entered numbers and calculates imprinting from effective INI values', () => {
    const current = gameConfigSchema.parse({ babyMature: 10 });
    const draft = readGameForm(current);
    draft.advanced.set(optionId(turret), [{ ...turret, value: '1.5', modifier: '' }]);
    expect(() => saveGameForm(current, draft.basic, draft.advanced, draft.manual)).toThrow(
      '炮塔数量上限',
    );
    draft.advanced.delete(optionId(turret));
    draft.advanced.set(optionId(interval), [{ ...interval, value: '0.5', modifier: '' }]);
    draft.manual.game = 'BabyMatureSpeedMultiplier=20\nBabyCuddleIntervalMultiplier=0.1';
    const next = saveGameForm(current, draft.basic, draft.advanced, draft.manual);
    expect(imprintEstimate(next)).toEqual({ opportunities: 5, intervalMinutes: 48 });
  });
});
