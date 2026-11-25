import {
  INI_SECTIONS,
  configuredIni,
  iniAddress,
  iniEntries,
  mergeIni,
  serializeIni,
} from '@common/game-config';
import type { IniEntry, IniFile } from '@common/game-config';
import type { GameBranch, GameConfig } from '@common/types';

export type ClusterGameConfig = Omit<GameConfig, 'sessionName' | 'serverPassword' | 'modIds'>;
export type ClusterPresetContent =
  { kind: 'game'; config: ClusterGameConfig } | { kind: 'mods'; modIds: string[] };
export type ClusterPreset = ClusterPresetContent & {
  id: string;
  clusterId: string;
  branch: GameBranch;
  name: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
};
export interface ClusterPresetGroup {
  id: string;
  branch: GameBranch;
  presets: ClusterPreset[];
  mapCount: number;
  canJoin: boolean;
  canSave: boolean;
}

const privateKeys = new Set([
  'sessionname',
  'port',
  'gameport',
  'peerport',
  'queryport',
  'rconport',
  'rconenabled',
  'multihome',
  'clusterid',
  'clusterdir',
  'clusterdirioverride',
  'activemods',
  'gamemodids',
  'modids',
]);
const privateKeyName =
  /password|passwd|passphrase|secret|token|credential|(?:api|access|private)[_. -]?key|connection[_. -]?string|webhook|authorization/i;
const modListKeys = {
  settings: new Set([
    iniAddress(INI_SECTIONS.settings, 'ActiveMods'),
    iniAddress(INI_SECTIONS.settings, 'GameModIds'),
  ]),
  game: new Set([iniAddress(INI_SECTIONS.workshop, 'ModIDS')]),
};
const isPrivate = (entry: IniEntry) =>
  privateKeys.has(entry.key.toLowerCase()) || privateKeyName.test(entry.key);

function publicIni(file: IniFile, text: string) {
  return serializeIni(iniEntries(file, text).filter((entry) => !isPrivate(entry)));
}

export function clusterGameConfig(config: GameConfig): ClusterGameConfig {
  const [advancedSettings, manualSettings] = configuredIni(config, 'settings');
  const [advancedGame, manualGame] = configuredIni(config, 'game');
  return {
    maxPlayers: config.maxPlayers,
    pve: config.pve,
    xp: config.xp,
    harvest: config.harvest,
    taming: config.taming,
    breeding: config.breeding,
    eggHatch: config.eggHatch,
    babyMature: config.babyMature,
    difficulty: config.difficulty,
    autoSaveMinutes: config.autoSaveMinutes,
    advancedIni: {
      settings: publicIni('settings', advancedSettings),
      game: publicIni('game', advancedGame),
    },
    extraSettingsIni: publicIni('settings', manualSettings),
    extraGameIni: publicIni('game', manualGame),
  };
}

function containsModList(file: IniFile, text: string) {
  return iniEntries(file, text).some(({ section, key }) =>
    modListKeys[file].has(iniAddress(section, key)),
  );
}

export function hasModListOverride(config: GameConfig) {
  return (['settings', 'game'] as const).some((file) =>
    configuredIni(config, file).some((text) => containsModList(file, text)),
  );
}

export function applyClusterPreset(current: GameConfig, preset: ClusterPresetContent): GameConfig {
  if (preset.kind === 'mods') {
    const withoutModList = (file: IniFile, text: string) =>
      containsModList(file, text) ? mergeIni(file, { text, withoutKeys: modListKeys[file] }) : text;
    return {
      ...current,
      modIds: [...preset.modIds],
      ...(current.advancedIni && {
        advancedIni: {
          settings: withoutModList('settings', current.advancedIni.settings),
          game: withoutModList('game', current.advancedIni.game),
        },
      }),
      extraSettingsIni: withoutModList('settings', current.extraSettingsIni ?? ''),
      extraGameIni: withoutModList('game', current.extraGameIni ?? ''),
    };
  }

  const gameplay = clusterGameConfig({ ...current, ...preset.config });
  const keepPrivate = (file: IniFile, previous: string, shared: string) => {
    const retained = serializeIni(iniEntries(file, previous).filter(isPrivate));
    return retained ? mergeIni(file, shared, retained) : shared;
  };
  const [advancedSettings, manualSettings] = configuredIni(current, 'settings');
  const [advancedGame, manualGame] = configuredIni(current, 'game');
  return {
    ...current,
    ...gameplay,
    advancedIni: {
      settings: keepPrivate('settings', advancedSettings, gameplay.advancedIni?.settings ?? ''),
      game: keepPrivate('game', advancedGame, gameplay.advancedIni?.game ?? ''),
    },
    extraSettingsIni: keepPrivate('settings', manualSettings, gameplay.extraSettingsIni),
    extraGameIni: keepPrivate('game', manualGame, gameplay.extraGameIni),
  };
}
