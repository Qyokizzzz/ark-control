import { configuredIni, gameConfigSchema, iniAddress, iniEntries } from '@ark-control/common';
import type {
  ConfigChange,
  ConfigChangeTarget,
  ConfigChangeValue,
  IniEntry,
  IniFile,
  Instance,
} from '@ark-control/common';

const instanceFields = [
  'name',
  'map',
  'clusterId',
  'gamePort',
  'queryPort',
  'rconPort',
  'autoRestart',
  'branch',
  'autoBranchUpdate',
  'serverFileSource',
] as const;
const instanceDefaults: Partial<Record<(typeof instanceFields)[number], ConfigChangeValue>> = {
  branch: 'public',
  autoBranchUpdate: false,
  serverFileSource: 'auto',
};
const basicFields = [
  'sessionName',
  'serverPassword',
  'maxPlayers',
  'pve',
  'xp',
  'harvest',
  'taming',
  'breeding',
  'eggHatch',
  'babyMature',
  'difficulty',
  'autoSaveMinutes',
  'modIds',
] as const;
const gameDefaults = gameConfigSchema.parse({});

const secretName =
  /password|passwd|passphrase|secret|token|credential|(?:api|access|private)[_. -]?key|connection[_. -]?string|webhook|authorization/i;
const secretValue =
  /(?:password|passwd|secret|token|credential|api[_. -]?key|authorization)\s*["']?\s*[:=]|(?:bearer\s+\S+)|\w+:\/\/[^\s/:@]+:[^\s/@]+@/i;

function addChange(
  changes: ConfigChange[],
  target: ConfigChangeTarget,
  before: ConfigChangeValue,
  after: ConfigChangeValue,
) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (
    secretName.test(target.key ?? '') ||
    [before, after].some((value) => secretValue.test(String(value ?? '')))
  ) {
    const hasValue = (value: ConfigChangeValue) =>
      Array.isArray(value) ? value.some(Boolean) : value !== null && value !== '';
    changes.push({
      ...target,
      before: hasValue(before) ? true : null,
      after: hasValue(after) ? true : null,
      redacted: true,
    });
    return;
  }
  changes.push({ ...target, before, after });
}

function iniRows(file: IniFile, text: string) {
  const groups = new Map<string, IniEntry[]>();
  for (const entry of iniEntries(file, text)) {
    const address = iniAddress(entry.section, entry.key);
    const group = groups.get(address) ?? [];
    group.push(entry);
    groups.set(address, group);
  }
  return groups;
}

function rowValues(rows: IniEntry[]) {
  const values = rows.map(({ modifier, key, value }) =>
    modifier ? modifier + key + '=' + value : value,
  );
  return values.length > 1 ? values : (values[0] ?? null);
}

function compareIni(
  changes: ConfigChange[],
  source: 'advanced' | 'manual',
  file: IniFile,
  before: string,
  after: string,
) {
  if (before === after) return;
  const start = changes.length;
  const oldRows = iniRows(file, before);
  const newRows = iniRows(file, after);
  for (const address of new Set([...oldRows.keys(), ...newRows.keys()])) {
    const previous = oldRows.get(address) ?? [];
    const next = newRows.get(address) ?? [];
    if (
      previous.length === next.length &&
      previous.every(
        (entry, index) =>
          entry.modifier === next[index]?.modifier && entry.value === next[index]?.value,
      )
    )
      continue;
    const { section, key } = next[0] ?? previous[0]!;
    addChange(changes, { source, file, section, key }, rowValues(previous), rowValues(next));
  }
  if (
    changes.length === start &&
    source === 'manual' &&
    before.replace(/\r\n?/g, '\n') !== after.replace(/\r\n?/g, '\n')
  )
    changes.push({ source, file, before: null, after: null });
}

export function configurationChanges(before: Instance, after: Instance): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const key of instanceFields) {
    addChange(
      changes,
      { source: 'instance', key },
      before[key] ?? instanceDefaults[key] ?? null,
      after[key] ?? instanceDefaults[key] ?? null,
    );
  }
  for (const key of basicFields) {
    addChange(
      changes,
      { source: 'basic', key },
      before.config[key] ?? gameDefaults[key],
      after.config[key] ?? gameDefaults[key],
    );
  }
  for (const file of ['settings', 'game'] as const) {
    const [oldForm, oldManual] = configuredIni(before.config, file);
    const [newForm, newManual] = configuredIni(after.config, file);
    compareIni(changes, 'advanced', file, oldForm, newForm);
    compareIni(changes, 'manual', file, oldManual, newManual);
  }
  return changes;
}
