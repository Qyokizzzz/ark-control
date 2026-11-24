import { describe, expect, it } from 'vitest';
import { gameConfigSchema } from '@ark-control/common';
import type { Instance } from '@ark-control/common';
import { configurationChanges } from './config-changes';

const base = {
  name: '原服名',
  branch: 'public',
  autoRestart: false,
  config: gameConfigSchema.parse({ serverPassword: 'original-join-password' }),
} as Instance;

describe('configuration changes', () => {
  it('captures instance options, form fields and every changed INI key in their own scope', () => {
    const before = {
      ...base,
      config: {
        ...base.config,
        advancedIni: { settings: '[ServerSettings]\nAllowAnyoneBabyImprintCuddle=False', game: '' },
        extraGameIni: '[SomeMod]\n+Levels=1\n+Levels=3\nRemovedOption=true',
      },
    };
    const after = {
      ...before,
      name: '新服名',
      autoRestart: true,
      config: {
        ...before.config,
        harvest: 30,
        modIds: ['200', '100'],
        advancedIni: {
          settings: '[serversettings]\nallowanyonebabyimprintcuddle=True',
          game: 'LimitTurretsNum=90',
        },
        extraGameIni: '[SomeMod]\n+Levels=3\n+Levels=1\nNewOption=4',
        extraSettingsIni: 'HarvestAmountMultiplier=25',
      },
    };
    const changes = configurationChanges(before, after);
    expect(changes).toHaveLength(10);
    expect(changes).toEqual(
      expect.arrayContaining([
        { source: 'instance', key: 'name', before: '原服名', after: '新服名' },
        { source: 'instance', key: 'autoRestart', before: false, after: true },
        { source: 'basic', key: 'harvest', before: 2, after: 30 },
        { source: 'basic', key: 'modIds', before: [], after: ['200', '100'] },
        {
          source: 'advanced',
          file: 'settings',
          section: 'serversettings',
          key: 'allowanyonebabyimprintcuddle',
          before: 'False',
          after: 'True',
        },
        {
          source: 'advanced',
          file: 'game',
          section: '/script/shootergame.shootergamemode',
          key: 'LimitTurretsNum',
          before: null,
          after: '90',
        },
        {
          source: 'manual',
          file: 'settings',
          section: 'ServerSettings',
          key: 'HarvestAmountMultiplier',
          before: null,
          after: '25',
        },
        {
          source: 'manual',
          file: 'game',
          section: 'SomeMod',
          key: 'Levels',
          before: ['+Levels=1', '+Levels=3'],
          after: ['+Levels=3', '+Levels=1'],
        },
        {
          source: 'manual',
          file: 'game',
          section: 'SomeMod',
          key: 'RemovedOption',
          before: 'true',
          after: null,
        },
        {
          source: 'manual',
          file: 'game',
          section: 'SomeMod',
          key: 'NewOption',
          before: null,
          after: '4',
        },
      ]),
    );
  });

  it('reports changed credentials without retaining values in the summary or log', () => {
    const after = {
      ...base,
      config: {
        ...base.config,
        serverPassword: 'new-join-password',
        extraSettingsIni:
          '[SomeMod]\nSpectatorPassword=private-spectator-value\nAuthToken=private-token-value\nEndpoint=https://apiuser:private-web-value@example.com',
      },
    };
    const changes = configurationChanges(base, after);
    expect(changes).toHaveLength(4);
    expect(changes[0]).toEqual({
      source: 'basic',
      key: 'serverPassword',
      before: true,
      after: true,
      redacted: true,
    });
    expect(
      changes
        .slice(1)
        .every(({ redacted, before, after }) => redacted && before === null && after === true),
    ).toBe(true);
    expect(JSON.stringify(changes)).not.toMatch(
      /original-join-password|new-join-password|private-.*-value/,
    );
  });

  it('distinguishes a no-op save from a manual edit of comments', () => {
    const before = {
      ...base,
      branch: undefined,
      config: { ...base.config, extraGameIni: '; diagnostic note\r\nLimitTurretsNum=100' },
    };
    const after = {
      ...base,
      serverFileSource: 'auto',
      autoBranchUpdate: false,
      config: {
        ...base.config,
        advancedIni: { settings: '', game: '' },
        extraGameIni: '; diagnostic note\nLimitTurretsNum=100',
      },
    };
    expect(configurationChanges(before, after)).toEqual([]);
    expect(
      configurationChanges(after, {
        ...after,
        config: { ...after.config, extraGameIni: '; updated note\nLimitTurretsNum=100' },
      }),
    ).toEqual([{ source: 'manual', file: 'game', before: null, after: null }]);
  });
});
