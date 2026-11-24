import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INI_SECTIONS, gameConfigSchema, iniEntries, workshopMods } from '@ark-control/common';
import type { AgentInstance } from '@ark-control/common';
import { launchArguments, writeSettings } from './settings';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('ark-settings-test-'))
      throw new Error('拒绝清理非测试目录。');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ark-settings-test-'));
  roots.push(root);
  const instance = {
    id: randomUUID(),
    map: 'TheIsland',
    gamePort: 7777,
    queryPort: 27015,
    rconPort: 27020,
    rconPassword: 'private-admin-password',
    config: gameConfigSchema.parse({ serverPassword: 'private-join-password' }),
  } as AgentInstance;
  return { root, instance };
}
describe('managed RCON startup settings', () => {
  it('passes the same managed admin password in INI and the dedicated server URL', async () => {
    const { root, instance } = await fixture();
    instance.config = gameConfigSchema.parse({
      ...instance.config,
      xp: 4,
      harvest: 50,
      taming: 5,
    });
    await writeSettings(root, instance);
    const ini = await readFile(
      join(
        root,
        'instances',
        instance.id,
        'ShooterGame/Saved/Config',
        process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer',
        'GameUserSettings.ini',
      ),
      'utf8',
    );
    expect(ini).toContain('RCONEnabled=True\nRCONPort=27020');
    expect(ini).toContain('ServerAdminPassword=private-admin-password');
    expect(ini).toContain('XPMultiplier=4\nTamingSpeedMultiplier=5');
    expect(ini).toContain('HarvestAmountMultiplier=50\n');
    const args = await launchArguments(root, undefined, instance);
    expect(args[0]).toContain('?RCONEnabled=True?RCONPort=27020');
    expect(args[0]).toContain('?ServerAdminPassword=private-admin-password');
    expect(args[0]?.split('?')).toContain('HarvestAmountMultiplier=50');
    expect(args.join(' ')).not.toContain('private-join-password');
    const second = await launchArguments(root, undefined, { ...instance, rconPort: 27021 });
    expect(second[0]).toContain('?RCONPort=27021');
    expect(second[0]).not.toContain('?RCONPort=27020');
  });
  it('refuses an empty or unsafe credential before replacing the existing configuration', async () => {
    const { root, instance } = await fixture();
    await writeSettings(root, instance);
    const path = join(
      root,
      'instances',
      instance.id,
      'ShooterGame/Saved/Config',
      process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer',
      'GameUserSettings.ini',
    );
    const original = await readFile(path, 'utf8');
    for (const password of ['', 'bad?RCONPort=1', 'line\nbreak']) {
      const invalid = { ...instance, rconPassword: password };
      await expect(writeSettings(root, invalid)).rejects.toThrow('管理员密码');
      await expect(launchArguments(root, undefined, invalid)).rejects.toThrow('管理员密码');
      expect(await readFile(path, 'utf8')).toBe(original);
    }
  });

  it('keeps existing INI settings while replacing and clearing keys managed by the panel', async () => {
    const { root, instance } = await fixture();
    const receipt = await writeSettings(root, instance);
    await rm(join(dirname(receipt.settingsPath), '.ark-control-ini-keys.json'));
    await writeFile(
      receipt.settingsPath,
      '\uFEFF[ServerSettings]\n; 原配置备注\nServerCrosshair=True\nharvestamountmultiplier=1\n\n[UnknownMod]\n+AllowedValue=甲\n+AllowedValue=乙\n',
      'utf16le',
    );
    await writeFile(
      receipt.gamePath,
      '[/script/shootergame.shootergamemode]\nGlobalSpoilingTimeMultiplier=2\n\n[UnknownMod]\n+AllowedValue=1\n+AllowedValue=2\n',
    );
    instance.config.harvest = 50;
    instance.config.advancedIni = {
      settings: '[ServerSettings]\n; 表单说明\nAllowAnyoneBabyImprintCuddle=True',
      game: 'LimitTurretsNum=120',
    };
    instance.config.extraSettingsIni = '[ServerSettings]\nharvestamountmultiplier=7.25';
    expect((await writeSettings(root, instance)).harvest).toBe(7.25);
    const settings = await readFile(receipt.settingsPath, 'utf16le');
    const game = await readFile(receipt.gamePath, 'utf8');
    expect(settings.match(/^HarvestAmountMultiplier=.*$/gim)).toEqual([
      'HarvestAmountMultiplier=7.25',
    ]);
    expect(settings).toContain('; 原配置备注\nServerCrosshair=True');
    expect(settings).toContain('[UnknownMod]\n+AllowedValue=甲\n+AllowedValue=乙');
    expect(settings).toContain('AllowAnyoneBabyImprintCuddle=True');
    expect(game).toContain('GlobalSpoilingTimeMultiplier=2');
    expect(game).toContain('[UnknownMod]\n+AllowedValue=1\n+AllowedValue=2');
    expect(game).toContain('LimitTurretsNum=120');
    const args = await launchArguments(root, undefined, instance);
    expect(
      args[0]?.split('?').filter((option) => option.startsWith('HarvestAmountMultiplier=')),
    ).toEqual(['HarvestAmountMultiplier=7.25']);

    await writeSettings(root, instance);
    expect(await readFile(receipt.settingsPath, 'utf16le')).toBe(settings);
    expect(await readFile(receipt.gamePath, 'utf8')).toBe(game);

    instance.config.advancedIni = undefined;
    instance.config.extraSettingsIni = '';
    expect((await writeSettings(root, instance)).harvest).toBe(50);
    const updatedSettings = await readFile(receipt.settingsPath, 'utf16le');
    const updatedGame = await readFile(receipt.gamePath, 'utf8');
    expect(updatedSettings).toContain('HarvestAmountMultiplier=50');
    expect(updatedSettings).toContain('ServerCrosshair=True');
    expect(updatedSettings).not.toContain('AllowAnyoneBabyImprintCuddle');
    expect(updatedGame).toContain('GlobalSpoilingTimeMultiplier=2');
    expect(updatedGame).not.toContain('LimitTurretsNum');
  });
  it('refuses advanced settings that disable managed RCON or replace its port', async () => {
    const { root, instance } = await fixture();
    instance.config.extraSettingsIni = '[ServerSettings]\nRCONEnabled=False';
    await expect(writeSettings(root, instance)).rejects.toThrow('保留设置');
    instance.config.extraSettingsIni = '[ServerSettings]\nRCONPort=12345';
    await expect(writeSettings(root, instance)).rejects.toThrow('保留设置');
    instance.config.extraSettingsIni = '[SessionSettings]\n+QueryPort=27090';
    await expect(writeSettings(root, instance)).rejects.toThrow('保留设置');
  });

  it('writes hand-edited overrides by file and section and uses the effective Steam name at launch', async () => {
    const { root, instance } = await fixture();
    instance.config = gameConfigSchema.parse({
      ...instance.config,
      sessionName: '表单服名',
      xp: 3,
      advancedIni: {
        settings: '[ServerSettings]\nDayTimeSpeedScale=3\n[ExampleMod]\nXPMultiplier=2',
        game: 'LimitTurretsNum=120\nPerLevelStatsMultiplier_Player[7]=3\nPerLevelStatsMultiplier_Player[8]=5\nNPCReplacements=(FromClassName="A",ToClassName="B")',
      },
      extraSettingsIni:
        'xpMultiplier=7\n[serversettings]\ndaytimespeedscale=2\nActiveMods=12345\n[SessionSettings]\nSessionName=岛屿 PVE\n[/Script/Engine.GameSession]\nMaxPlayers=35',
      extraGameIni:
        'limitturretsnum=140\nPerLevelStatsMultiplier_Player[7]=4\nNPCReplacements=(FromClassName="A",ToClassName="C")\n.NPCReplacements=(FromClassName="D",ToClassName="E")\n[ModInstaller]\nModIDS=67890',
    });
    const directory = join(
      root,
      'instances',
      instance.id,
      'ShooterGame/Saved/Config',
      process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer',
    );
    await writeSettings(root, instance);
    const encoded = await readFile(join(directory, 'GameUserSettings.ini'));
    expect([...encoded.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const settings = iniEntries('settings', encoded.toString('utf16le'));
    const get = (key: string, section = INI_SECTIONS.settings) =>
      settings
        .filter((entry) => entry.section === section && entry.key.toLowerCase() === key)
        .map((entry) => entry.value);
    expect(get('xpmultiplier')).toEqual(['7']);
    expect(get('xpmultiplier', 'ExampleMod')).toEqual(['2']);
    expect(get('daytimespeedscale')).toEqual(['2']);
    expect(get('sessionname', INI_SECTIONS.session)).toEqual(['岛屿 PVE']);
    expect(get('rconenabled')).toEqual(['True']);
    expect(get('activemods')).toEqual(['12345']);
    const game = await readFile(join(directory, 'Game.ini'), 'utf8');
    expect(game).toContain('limitturretsnum=140');
    expect(game).not.toContain('LimitTurretsNum=120');
    expect(game).toContain('PerLevelStatsMultiplier_Player[7]=4');
    expect(game).toContain('PerLevelStatsMultiplier_Player[8]=5');
    expect(game).not.toContain('ToClassName="B"');
    expect(game).toContain('NPCReplacements=(FromClassName="A",ToClassName="C")');
    expect(game).toContain('.NPCReplacements=(FromClassName="D",ToClassName="E")');
    expect(game).toContain('ModIDS=67890');
    expect(workshopMods(instance.config)).toEqual(['12345', '67890']);
    const args = await launchArguments(root, undefined, instance);
    expect(args[0]).toContain('?SessionName=岛屿 PVE');
    expect(args[0]).toContain('?MaxPlayers=35');
    expect(args).toContain('-automanagedmods');
  });

  it('keeps literal URL delimiters in the INI without adding launch options', async () => {
    const { root, instance } = await fixture();
    instance.config.sessionName = 'ARK #297974?Test';
    await writeSettings(root, instance);
    const args = await launchArguments(root, undefined, instance);
    expect(args[0]).not.toContain('?SessionName=');
    expect(args[0]).not.toContain('?Test');
  });
});
