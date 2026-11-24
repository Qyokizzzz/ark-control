import type { GameConfig } from '@common/types';

export const INI_FILES = {
  settings: 'GameUserSettings.ini',
  game: 'Game.ini',
};
export const INI_SECTIONS = {
  settings: 'ServerSettings',
  game: '/script/shootergame.shootergamemode',
  session: 'SessionSettings',
  players: '/Script/Engine.GameSession',
  workshop: 'ModInstaller',
};
export type IniFile = keyof typeof INI_FILES;
export interface IniEntry {
  section: string;
  key: string;
  value: string;
  modifier: string;
}

const sectionPattern = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/;
const entryPattern = /^\s*([+.!-]?)([^=\s;#]+)\s*=\s*(.*)$/;
const lower = (value: string) => value.trim().toLowerCase();
export const iniAddress = (section: string, key: string) => `${lower(section)}\0${lower(key)}`;

function parse(file: IniFile, text: string) {
  let section = INI_SECTIONS[file];
  return text.split(/\r\n?|\n/).flatMap((line, index) => {
    if (index === 0) line = line.replace(/^\uFEFF/, '');
    const header = sectionPattern.exec(line);
    if (header) {
      section = header[1]!.trim();
      return [];
    }
    const match = entryPattern.exec(line);
    const entry: IniEntry | undefined = match
      ? { section, modifier: match[1]!, key: match[2]!, value: match[3]!.trim() }
      : undefined;
    return [{ section, line, entry }];
  });
}

export function iniEntries(file: IniFile, text: string): IniEntry[] {
  return parse(file, text).flatMap(({ entry }) => (entry ? [entry] : []));
}

function lineAddress({ section, line, entry }: ReturnType<typeof parse>[number]) {
  if (entry) return iniAddress(entry.section, entry.key);
  return line.trim() ? `${lower(section)}\0\0${line.trim()}` : undefined;
}

// A later layer owns the entire key in its file and section. Keep duplicate rows and
// Unreal array operators within that layer, including the order of repeated values.
export function mergeIni(
  file: IniFile,
  ...layers: (string | { text: string; withoutKeys: ReadonlySet<string> })[]
): string {
  const parsed = layers.map((layer) => {
    if (typeof layer === 'string') return parse(file, layer.trim());
    return parse(file, layer.text.trim()).filter(
      ({ line, entry }) =>
        line.trim() && (!entry || !layer.withoutKeys.has(iniAddress(entry.section, entry.key))),
    );
  });
  const lastLayer = new Map<string, number>();
  parsed.forEach((lines, index) => {
    for (const row of lines) {
      const address = lineAddress(row);
      if (address) lastLayer.set(address, index);
    }
  });
  const sections = new Map<string, { name: string; lines: string[] }>();
  parsed.forEach((lines, index) => {
    for (const row of lines) {
      const address = lineAddress(row);
      if (address && lastLayer.get(address) !== index) continue;
      const { section, line } = row;
      const key = lower(section);
      const block = sections.get(key) ?? { name: section, lines: [] };
      block.lines.push(line);
      sections.set(key, block);
    }
  });
  const contents = [...sections.values()].flatMap(({ name, lines }) => {
    const body = lines.join('\n').trim();
    return body ? [`[${name}]\n${body}`] : [];
  });
  return contents.length ? contents.join('\n\n') + '\n' : '';
}

export function serializeIni(entries: IniEntry[]): string {
  const sections = new Map<string, string[]>();
  for (const { section, key, value, modifier } of entries) {
    const lines = sections.get(section) ?? [];
    lines.push(`${modifier}${key}=${value}`);
    sections.set(section, lines);
  }
  return [...sections].map(([section, lines]) => `[${section}]\n${lines.join('\n')}`).join('\n\n');
}

export function manualIni(config: GameConfig, file: IniFile) {
  return (file === 'settings' ? config.extraSettingsIni : config.extraGameIni) ?? '';
}

export function configuredIni(config: GameConfig, file: IniFile) {
  return [config.advancedIni?.[file] ?? '', manualIni(config, file)] as const;
}

function iniOptions(config: GameConfig, file: IniFile) {
  const [form, manual] = configuredIni(config, file);
  const overrides = iniEntries(file, manual);
  const keys = new Set(overrides.map((entry) => iniAddress(entry.section, entry.key)));
  return [
    ...iniEntries(file, form).filter((entry) => !keys.has(iniAddress(entry.section, entry.key))),
    ...overrides,
  ];
}

function getScalar(entries: IniEntry[], section: string, key: string) {
  const address = iniAddress(section, key);
  return entries.findLast(
    (entry) => !entry.modifier && iniAddress(entry.section, entry.key) === address,
  )?.value;
}

const modId = /^\d{1,20}$/;
const modList = (value: string) => (value ? value.split(',').map((id) => id.trim()) : []);
const playerLimit = (value: string) => /^\d+$/.test(value) && +value >= 1 && +value <= 200;

export function effectiveGameConfig(config: GameConfig) {
  const settings = iniOptions(config, 'settings');
  const game = iniOptions(config, 'game');
  const get = (key: string) => getScalar(settings, INI_SECTIONS.settings, key);
  const getGame = (key: string) => getScalar(game, INI_SECTIONS.game, key);
  const maxPlayers = getScalar(settings, INI_SECTIONS.players, 'MaxPlayers');
  const activeMods = get('ActiveMods');
  const modIds =
    activeMods === undefined ? config.modIds : modList(activeMods).filter((id) => modId.test(id));
  const number = (value: string | undefined, fallback: number) =>
    value && Number.isFinite(Number(value)) ? Number(value) : fallback;
  return {
    sessionName: getScalar(settings, INI_SECTIONS.session, 'SessionName') || config.sessionName,
    serverPassword: get('ServerPassword') ?? config.serverPassword,
    maxPlayers: maxPlayers && playerLimit(maxPlayers) ? Number(maxPlayers) : config.maxPlayers,
    modIds,
    pve: /^(true|1)$/i.test(get('ServerPVE') ?? String(config.pve)),
    xp: number(get('XPMultiplier'), config.xp),
    harvest: number(get('HarvestAmountMultiplier'), config.harvest),
    taming: number(get('TamingSpeedMultiplier'), config.taming),
    autoSaveMinutes: number(get('AutoSavePeriodMinutes'), config.autoSaveMinutes),
    babyMature: number(getGame('BabyMatureSpeedMultiplier'), config.babyMature),
    imprintInterval: number(getGame('BabyCuddleIntervalMultiplier'), 1),
    singlePlayerRates: /^(true|1)$/i.test(getGame('bUseSingleplayerSettings') ?? ''),
  };
}

export function workshopMods(config: GameConfig): string[] {
  const extra = iniOptions(config, 'game').filter(
    (entry) =>
      iniAddress(entry.section, entry.key) === iniAddress(INI_SECTIONS.workshop, 'ModIDS') &&
      ['', '+', '.'].includes(entry.modifier) &&
      modId.test(entry.value),
  );
  return [
    ...new Set([...effectiveGameConfig(config).modIds, ...extra.map((entry) => entry.value)]),
  ];
}

const protectedKeys = new Set([
  'serveradminpassword',
  'rconenabled',
  'rconport',
  'port',
  'queryport',
  'peerport',
  'gameport',
]);
const serverSections = new Set(
  [INI_SECTIONS.settings, INI_SECTIONS.session, INI_SECTIONS.players].map(lower),
);

export function gameIniIssue(config: GameConfig): string | undefined {
  for (const layer of configuredIni(config, 'settings')) {
    for (const entry of iniEntries('settings', layer)) {
      if (serverSections.has(lower(entry.section)) && protectedKeys.has(lower(entry.key)))
        return `「${entry.key}」属于主机助手的保留设置，请在地图端口或主机管理中配置。`;
    }
  }
  const entries = iniOptions(config, 'settings');
  for (const entry of entries) {
    const id = iniAddress(entry.section, entry.key);
    if (
      id === iniAddress(INI_SECTIONS.session, 'SessionName') &&
      (entry.modifier || !entry.value || entry.value.length > 80)
    )
      return '手写 SessionName 需要填写 1～80 个字符的服务器名称。';
    if (
      id === iniAddress(INI_SECTIONS.players, 'MaxPlayers') &&
      (entry.modifier || !playerLimit(entry.value))
    )
      return '手写 MaxPlayers 需要填写 1～200 的整数。';
    if (
      id === iniAddress(INI_SECTIONS.settings, 'ServerPassword') &&
      (entry.modifier || entry.value.length > 80)
    )
      return '手写 ServerPassword 最多可填写 80 个字符。';
    if (
      id === iniAddress(INI_SECTIONS.settings, 'ActiveMods') &&
      (entry.modifier ||
        modList(entry.value).length > 60 ||
        modList(entry.value).some((id) => !modId.test(id)))
    )
      return '手写 ActiveMods 需要填写逗号分隔的 Workshop 数字 ID，最多 60 个。';
  }
  return undefined;
}
