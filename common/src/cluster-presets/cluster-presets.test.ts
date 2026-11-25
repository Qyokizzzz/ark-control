import { describe, expect, it } from 'vitest';
import { effectiveGameConfig, workshopMods } from '@common/game-config';
import { gameConfigSchema } from '@common/schemas';
import { applyClusterPreset, clusterGameConfig, hasModListOverride } from './index';

describe('cluster configuration presets', () => {
  it('copies gameplay while keeping the destination name, passwords and mods private', () => {
    const source = gameConfigSchema.parse({
      sessionName: 'source',
      serverPassword: 'source-password',
      harvest: 10,
      modIds: ['100'],
      extraSettingsIni:
        '[ServerSettings]\nHarvestAmountMultiplier=50\nActiveMods=101\nServerPassword=source-ini-password',
      extraGameIni: '[ModInstaller]\nModIDS=102\n[Custom]\nToken=source-token\nDifficulty=2',
    });
    const preset = clusterGameConfig(source);
    expect(JSON.stringify(preset)).not.toMatch(/source|ActiveMods|ModIDS/i);
    const target = gameConfigSchema.parse({
      sessionName: 'target',
      serverPassword: 'target-password',
      modIds: ['200'],
      extraSettingsIni: '[ServerSettings]\nActiveMods=201\nServerPassword=target-ini-password',
      extraGameIni: '[ModInstaller]\nModIDS=202\n[Custom]\nToken=target-token\nDifficulty=1',
    });
    const updated = applyClusterPreset(target, { kind: 'game', config: preset });
    expect(updated).toMatchObject({
      sessionName: 'target',
      serverPassword: 'target-password',
      modIds: ['200'],
    });
    expect(effectiveGameConfig(updated)).toMatchObject({
      harvest: 50,
      serverPassword: 'target-ini-password',
      modIds: ['201'],
    });
    expect(workshopMods(updated)).toEqual(['201', '202']);
    expect(updated.extraGameIni).toContain('Token=target-token');
    expect(updated.extraGameIni).toContain('Difficulty=2');
    expect(updated.extraGameIni).not.toContain('Difficulty=1');
  });

  it('replaces an explicit mod list and its INI overrides without altering gameplay', () => {
    const target = gameConfigSchema.parse({
      harvest: 12,
      modIds: ['300'],
      advancedIni: { settings: '[ServerSettings]\nActiveMods=301\nXPMultiplier=3', game: '' },
      extraSettingsIni:
        '[ServerSettings]\nActiveMods=302\nServerPassword=target-ini-password\nHarvestAmountMultiplier=50',
      extraGameIni: '[ModInstaller]\nModIDS=303\n[Custom]\nDifficulty=2',
    });
    expect(hasModListOverride(target)).toBe(true);
    const updated = applyClusterPreset(target, { kind: 'mods', modIds: ['500', '400'] });
    expect(hasModListOverride(updated)).toBe(false);
    expect(effectiveGameConfig(updated)).toMatchObject({
      xp: 3,
      harvest: 50,
      serverPassword: 'target-ini-password',
      modIds: ['500', '400'],
    });
    expect(workshopMods(updated)).toEqual(['500', '400']);
    expect(updated.extraGameIni).toContain('Difficulty=2');
    expect(workshopMods(applyClusterPreset(target, { kind: 'mods', modIds: [] }))).toEqual([]);
  });
});
