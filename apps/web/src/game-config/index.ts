import {
  INI_FILES,
  INI_SECTIONS,
  effectiveGameConfig,
  gameConfigSchema,
  iniEntries,
  manualIni,
  serializeIni,
} from '@ark-control/common';
import type {
  ConfigChange,
  ConfigChangeValue,
  GameConfig,
  IniEntry,
  IniFile,
} from '@ark-control/common';
import type { Field, FormValues } from '@/components';
import { advancedById, optionId } from './catalog';
import type { IniOption } from './catalog';

export { advancedGroups, advancedById, optionId } from './catalog';
export type { IniOption } from './catalog';

export type DraftEntry = IniEntry & { file: IniFile; asSwitch?: boolean };
export type EntriesByOption = Map<string, DraftEntry[]>;
export type ManualIni = Record<IniFile, string>;
const files: IniFile[] = ['settings', 'game'];
export const configGrid = {
  display: 'grid',
  gridTemplateColumns: {
    xs: 'minmax(0, 1fr)',
    md: 'repeat(2, minmax(0, 1fr))',
    lg: 'repeat(3, minmax(0, 1fr))',
  },
  alignItems: 'start',
  gap: { xs: 2, md: 2.5 },
} as const;

export const basicGameFields = [
  {
    key: 'sessionName',
    label: 'Steam 服务器名称',
    required: true,
    maxLength: 80,
    helper: 'Steam 收藏夹和游戏服务器列表显示的名称。',
  },
  { key: 'serverPassword', label: '入服密码', kind: 'password', maxLength: 80 },
  {
    key: 'maxPlayers',
    label: '玩家上限',
    kind: 'number',
    min: 1,
    max: 200,
    step: '1',
    required: true,
  },
  { key: 'xp', label: '经验倍率', kind: 'number', min: 0.1, max: 100, required: true },
  { key: 'harvest', label: '采集倍率', kind: 'number', min: 0.1, max: 100, required: true },
  { key: 'taming', label: '驯服倍率', kind: 'number', min: 0.1, max: 100, required: true },
  { key: 'breeding', label: '繁殖间隔倍率', kind: 'number', min: 0.01, max: 100, required: true },
  { key: 'eggHatch', label: '孵化倍率', kind: 'number', min: 0.1, max: 1000, required: true },
  { key: 'difficulty', label: '难度上限倍率', kind: 'number', min: 0.1, max: 20, required: true },
  {
    key: 'autoSaveMinutes',
    label: '自动存档间隔（分钟）',
    kind: 'number',
    min: 5,
    max: 60,
    step: '1',
    required: true,
  },
  { key: 'pve', label: 'PvE 模式', kind: 'switch' },
  { key: 'modIds', label: '启用的 Workshop 模组 ID', helper: '按加载顺序填写，使用逗号分隔。' },
] satisfies Field[];

type Address = Pick<IniOption, 'file' | 'section' | 'key'>;
const settings = (key: string): Address => ({
  file: 'settings',
  section: INI_SECTIONS.settings,
  key,
});
const game = (key: string): Address => ({ file: 'game', section: INI_SECTIONS.game, key });

export const basicIniAddresses: Record<string, Address> = {
  sessionName: { file: 'settings', section: INI_SECTIONS.session, key: 'SessionName' },
  serverPassword: settings('ServerPassword'),
  maxPlayers: { file: 'settings', section: INI_SECTIONS.players, key: 'MaxPlayers' },
  pve: settings('ServerPVE'),
  xp: settings('XPMultiplier'),
  harvest: settings('HarvestAmountMultiplier'),
  taming: settings('TamingSpeedMultiplier'),
  breeding: game('MatingIntervalMultiplier'),
  eggHatch: game('EggHatchSpeedMultiplier'),
  babyMature: game('BabyMatureSpeedMultiplier'),
  difficulty: settings('OverrideOfficialDifficulty'),
  autoSaveMinutes: settings('AutoSavePeriodMinutes'),
  modIds: settings('ActiveMods'),
};
export const maturityId = optionId(basicIniAddresses.babyMature!);
const basicIds = new Set(Object.values(basicIniAddresses).map(optionId));

const instanceConfigLabels: Record<string, string> = {
  name: '后台地图名称',
  map: '地图',
  clusterId: '互通组',
  gamePort: '游戏端口',
  queryPort: '查询端口',
  rconPort: 'RCON 端口',
  autoRestart: '自动拉起',
  branch: 'Steam 版本分支',
  autoBranchUpdate: '自动跟随分支更新（备份后维护重启）',
  serverFileSource: '服务端文件来源',
};

const basicConfigLabel = (key: string) =>
  basicGameFields.find((field) => field.key === key)?.label ??
  (key === 'babyMature' ? '恐龙成长速度倍率' : key);

export function configChangeLabel(change: ConfigChange, t: (key: string) => string) {
  if (!('file' in change))
    return t(
      change.source === 'basic'
        ? basicConfigLabel(change.key)
        : (instanceConfigLabels[change.key] ?? change.key),
    );
  const source = t(change.source === 'manual' ? '手写配置' : '高级配置');
  if (!change.section || !change.key)
    return `${source} · ${INI_FILES[change.file]} ${t('文本调整')}`;
  const id = optionId({ file: change.file, section: change.section, key: change.key });
  const basic = Object.entries(basicIniAddresses).find(([, address]) => optionId(address) === id);
  const label = advancedById.get(id)?.label ?? (basic ? basicConfigLabel(basic[0]) : change.key);
  return `${source} · ${t(label)}`;
}

export function configChangeValue(
  value: ConfigChangeValue,
  redacted: boolean,
  t: (key: string) => string,
) {
  if (value === null) return t('未设置');
  if (redacted) return t('已隐藏');
  if (typeof value === 'boolean') return t(value ? '已开启' : '已关闭');
  if (value === '' || (Array.isArray(value) && !value.length)) return t('空值');
  return Array.isArray(value) ? value.join('\n') : String(value);
}

function byOption(entries: DraftEntry[]): EntriesByOption {
  const result: EntriesByOption = new Map();
  for (const entry of entries) {
    const id = optionId(entry);
    const group = result.get(id) ?? [];
    group.push(entry);
    result.set(id, group);
  }
  return result;
}

function readEntries(read: (file: IniFile) => string) {
  return byOption(
    files.flatMap((file) => iniEntries(file, read(file)).map((entry) => ({ ...entry, file }))),
  );
}

export function readGameForm(config: GameConfig) {
  const basic: FormValues = {};
  for (const key of Object.keys(basicIniAddresses)) {
    const value = config[key as keyof GameConfig];
    if (Array.isArray(value)) basic[key] = value.join(',');
    else basic[key] = typeof value === 'boolean' ? value : String(value ?? '');
  }
  const advanced = readEntries((file) => config.advancedIni?.[file] ?? '');
  for (const [id, entries] of advanced) {
    if (advancedById.has(id)) continue;
    for (const entry of entries) {
      if (/^(true|false)$/i.test(entry.value)) entry.asSwitch = true;
    }
  }
  return {
    basic,
    advanced,
    manual: { settings: manualIni(config, 'settings'), game: manualIni(config, 'game') },
  };
}

export function manualOverrides(manual: ManualIni) {
  return readEntries((file) => manual[file]);
}

export function validCustomKey(file: IniFile, section: string, key: string): string | undefined {
  if (
    !section.trim() ||
    /[[\]\r\n]/.test(section) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\[\d+\])?$/.test(key)
  )
    return '请输入有效的 INI 节名和键名，例如 ExampleMultiplier 或 Stat[0]。';
  const id = optionId({ file, section, key });
  if (advancedById.has(id) || basicIds.has(id)) return '此键已有表单，可用键名搜索后直接修改。';
  return undefined;
}

function validateOption(entry: DraftEntry) {
  const option = advancedById.get(optionId(entry));
  if (/[\r\n]/.test(entry.value))
    throw new Error(`「${option?.label ?? entry.key}」的值需要写在一行。`);
  if (entry.modifier || !option || !['integer', 'number'].includes(option.kind)) return;
  const value = Number(entry.value);
  if (
    !entry.value.trim() ||
    !Number.isFinite(value) ||
    (option.kind === 'integer' && !Number.isSafeInteger(value)) ||
    (option.key === 'LimitTurretsNum' && (value < 1 || value > 2147483647)) ||
    (option.key === 'BabyCuddleIntervalMultiplier' && value <= 0)
  )
    throw new Error(`「${option.label}」的数值无效，请检查输入。`);
}

function hasFormValue(entry: DraftEntry) {
  if (entry.value.trim() || entry.modifier) return true;
  const kind = advancedById.get(optionId(entry))?.kind;
  return kind === undefined || kind === 'text' || kind === 'password';
}

export function draftConfig(
  current: GameConfig,
  basic: FormValues,
  advanced: EntriesByOption,
  manual: ManualIni,
): GameConfig {
  const entries = [...advanced.values()].flat().filter(hasFormValue);
  return {
    ...current,
    sessionName: String(basic.sessionName),
    serverPassword: String(basic.serverPassword),
    maxPlayers: Number(basic.maxPlayers),
    pve: basic.pve === true,
    xp: Number(basic.xp),
    harvest: Number(basic.harvest),
    taming: Number(basic.taming),
    breeding: Number(basic.breeding),
    eggHatch: Number(basic.eggHatch),
    babyMature: Number(basic.babyMature),
    difficulty: Number(basic.difficulty),
    autoSaveMinutes: Number(basic.autoSaveMinutes),
    modIds: String(basic.modIds)
      .split(/[\s,]+/)
      .filter(Boolean),
    advancedIni: {
      settings: serializeIni(entries.filter((entry) => entry.file === 'settings')),
      game: serializeIni(entries.filter((entry) => entry.file === 'game')),
    },
    extraSettingsIni: manual.settings,
    extraGameIni: manual.game,
  };
}

export function saveGameForm(
  current: GameConfig,
  basic: FormValues,
  advanced: EntriesByOption,
  manual: ManualIni,
): GameConfig {
  for (const entries of advanced.values())
    for (const entry of entries) if (hasFormValue(entry)) validateOption(entry);
  const result = gameConfigSchema.safeParse(draftConfig(current, basic, advanced, manual));
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const label = [...basicGameFields, { key: 'babyMature', label: '恐龙成长速度倍率' }].find(
    (field) => field.key === issue?.path[0],
  )?.label;
  throw new Error(
    label ? `「${label}」的值无效，请检查输入。` : (issue?.message ?? '游戏配置无效。'),
  );
}

export function imprintEstimate(config: GameConfig) {
  const { babyMature, imprintInterval, singlePlayerRates } = effectiveGameConfig(config);
  if (!(babyMature > 0 && imprintInterval > 0)) return null;
  const intervalHours = imprintInterval * 8 * (singlePlayerRates ? 0.17 : 1);
  const maturityRate = babyMature * (singlePlayerRates ? 35 : 1);
  // Vanilla Rex maturity is about 333333 seconds at 1×.
  const opportunities = Math.max(
    0,
    Math.ceil(333333.3125 / 3600 / maturityRate / intervalHours) - 1,
  );
  return { opportunities, intervalMinutes: Number((intervalHours * 60).toPrecision(3)) };
}
