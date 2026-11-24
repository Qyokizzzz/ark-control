import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  INI_FILES,
  configuredIni,
  effectiveGameConfig,
  gameIniIssue,
  iniAddress,
  iniEntries,
  mergeIni,
  workshopMods,
} from '@ark-control/common';
import type { AgentInstance, IniFile } from '@ark-control/common';
import { ensureSafeParent, inside } from '@/files';

type ManagedIniKeys = Record<IniFile, string[]>;
type ConfigFile = { path: string; before: Buffer | null; after: Buffer };

const iniValue = (value: string) =>
  value
    .replace(/[\r\n]/g, ' ')
    .replaceAll('\0', '')
    .trim();
// UE4 recognizes the UTF-16 byte-order mark for names and messages containing Unicode.
const iniEncoding = (value: string) =>
  Buffer.byteLength(value, 'utf8') !== value.length
    ? Buffer.from('\uFEFF' + value, 'utf16le')
    : Buffer.from(value, 'utf8');

function iniText(bytes: Buffer | null, path: string) {
  if (!bytes) return '';
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`无法读取 ${path} 的编码，请将文件转为 UTF-8 或带 BOM 的 UTF-16。`);
  }
}

function launchPassword(instance: AgentInstance) {
  // Control-generated passwords use base64url; URL separators or whitespace would change ARK options.
  if (
    typeof instance.rconPassword !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(instance.rconPassword)
  )
    throw new Error('地图管理员密码为空或格式异常，请检查后台保存的地图管理凭据。');
  return instance.rconPassword;
}

function harvestOption(harvest: number) {
  if (!Number.isFinite(harvest)) throw new Error('采集倍率需要填写有效数值。');
  return `HarvestAmountMultiplier=${harvest}`;
}

async function readConfigFile(path: string): Promise<Buffer | null> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`配置路径 ${path} 需要是普通文件。`);
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function replaceConfigFile(path: string, contents: Buffer) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function commitConfigFiles(files: ConfigFile[]) {
  const written: ConfigFile[] = [];
  try {
    for (const file of files) {
      if (file.before?.equals(file.after)) continue;
      const current = await readConfigFile(file.path);
      if (file.before ? !current?.equals(file.before) : current !== null)
        throw new Error(`${file.path} 在保存期间发生变化，请再次保存。`);
      await replaceConfigFile(file.path, file.after);
      written.push(file);
    }
    const saved = await Promise.all(files.map((file) => readConfigFile(file.path)));
    const mismatch = files.find((file, index) => !saved[index]?.equals(file.after));
    if (mismatch) throw new Error(`写入后回读内容不一致，请检查 ${mismatch.path}。`);
  } catch (error) {
    const rollback = await Promise.allSettled(
      written.map(async (file) => {
        // Do not roll back changes made independently by the game after our write.
        if (!(await readConfigFile(file.path))?.equals(file.after)) return;
        if (file.before) await replaceConfigFile(file.path, file.before);
        else await rm(file.path, { force: true });
      }),
    );
    if (rollback.some((result) => result.status === 'rejected'))
      throw new Error('写入配置失败，且部分配置未能还原。请检查文件后再次保存。', { cause: error });
    throw error;
  }
}

function keysIn(file: IniFile, text: string) {
  return [
    ...new Set(iniEntries(file, text).map(({ section, key }) => iniAddress(section, key))),
  ].sort();
}

function previousIniKeys(contents: Buffer | null): ManagedIniKeys {
  if (!contents) return { settings: [], game: [] };
  try {
    const { settings, game } = JSON.parse(contents.toString('utf8')) as Record<IniFile, unknown>;
    const validKeys = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((key) => typeof key === 'string');
    if (validKeys(settings) && validKeys(game)) return { settings, game };
  } catch {
    // A broken key list must not cause unknown entries to be dropped from the existing INIs.
  }
  return { settings: [], game: [] };
}

export async function writeSettings(root: string, instance: AgentInstance) {
  launchPassword(instance);
  const cfg = instance.config;
  const issue = gameIniIssue(cfg);
  if (issue) throw new Error(issue);
  const directory = inside(
    root,
    'instances',
    instance.id,
    'ShooterGame',
    'Saved',
    'Config',
    process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer',
  );
  const settingsPath = join(directory, INI_FILES.settings);
  const gamePath = join(directory, INI_FILES.game);
  const keysPath = join(directory, '.ark-control-ini-keys.json');
  await ensureSafeParent(root, settingsPath);
  const [previousSettings, previousGame, previousKeys] = await Promise.all([
    readConfigFile(settingsPath),
    readConfigFile(gamePath),
    readConfigFile(keysPath),
  ]);
  const prior = previousIniKeys(previousKeys);
  const effective = effectiveGameConfig(cfg);
  const managedSettings = mergeIni(
    'settings',
    `[ServerSettings]\nServerAdminPassword=${instance.rconPassword}\nRCONEnabled=True\nRCONPort=${instance.rconPort}\nServerPVE=${cfg.pve ? 'True' : 'False'}\nXPMultiplier=${cfg.xp}\nTamingSpeedMultiplier=${cfg.taming}\nOverrideOfficialDifficulty=${cfg.difficulty}\nAutoSavePeriodMinutes=${cfg.autoSaveMinutes}\nRCONServerGameLogBuffer=6000`,
    ...configuredIni(cfg, 'settings'),
    `[ServerSettings]\n${harvestOption(effective.harvest)}\nServerPassword=${iniValue(effective.serverPassword)}\nActiveMods=${effective.modIds.join(',')}\n\n[SessionSettings]\nSessionName=${iniValue(effective.sessionName)}\n\n[/Script/Engine.GameSession]\nMaxPlayers=${effective.maxPlayers}`,
  );
  const managedGame = mergeIni(
    'game',
    `[/script/shootergame.shootergamemode]\nMatingIntervalMultiplier=${cfg.breeding}\nEggHatchSpeedMultiplier=${cfg.eggHatch}\nBabyMatureSpeedMultiplier=${cfg.babyMature}\n\n[ModInstaller]\n${effective.modIds.map((id) => `ModIDS=${id}`).join('\n')}`,
    ...configuredIni(cfg, 'game'),
  );
  const settings = mergeIni(
    'settings',
    { text: iniText(previousSettings, settingsPath), withoutKeys: new Set(prior.settings) },
    managedSettings,
  );
  const game = mergeIni(
    'game',
    { text: iniText(previousGame, gamePath), withoutKeys: new Set(prior.game) },
    managedGame,
  );
  // Values that the panel no longer supplies must be removable even when other INI keys are kept.
  const keys: ManagedIniKeys = {
    settings: keysIn('settings', managedSettings),
    game: keysIn('game', managedGame),
  };
  await commitConfigFiles([
    { path: gamePath, before: previousGame, after: iniEncoding(game) },
    { path: settingsPath, before: previousSettings, after: iniEncoding(settings) },
    { path: keysPath, before: previousKeys, after: Buffer.from(JSON.stringify(keys)) },
  ]);
  return { verified: true, settingsPath, gamePath, harvest: effective.harvest };
}
export async function launchArguments(
  root: string,
  clusterRoot: string | undefined,
  instance: AgentInstance,
): Promise<string[]> {
  const config = effectiveGameConfig(instance.config);
  const name = iniValue(config.sessionName);
  const options = [
    instance.map,
    'listen',
    `Port=${instance.gamePort}`,
    `QueryPort=${instance.queryPort}`,
    `MaxPlayers=${config.maxPlayers}`,
    'RCONEnabled=True',
    `RCONPort=${instance.rconPort}`,
    `ServerAdminPassword=${launchPassword(instance)}`,
    // ASE may rewrite its INI during startup. Pass the effective rate to the process too.
    harvestOption(config.harvest),
  ];
  // Leave URL delimiters and quotes in the INI, where they are ordinary text.
  if (!/[?#"]/u.test(name)) options.push(`SessionName=${name}`);
  const args = [
    options.join('?'),
    '-server',
    '-log',
    '-servergamelog',
    '-servergamelogincludetribelogs',
    '-ServerRCONOutputTribeLogs',
  ];
  if (workshopMods(instance.config).length) args.push('-automanagedmods');
  const clusterId = instance.runtimeClusterId ?? instance.clusterId;
  if (clusterId) {
    const directory = clusterRoot
      ? inside(clusterRoot, clusterId)
      : inside(root, 'clusters', clusterId);
    await mkdir(directory, { recursive: true });
    args.push(`-clusterid=${clusterId}`, `-ClusterDirOverride=${directory}`);
  }
  return args;
}
