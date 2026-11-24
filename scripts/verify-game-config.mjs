import assert from 'node:assert/strict';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyGameConfig({
  page,
  instance,
  hostRoot,
  work,
  command,
  dashboard,
  waitFor,
  passed,
}) {
  const open = () => page.getByRole('tab', { name: '游戏配置', exact: true }).click();
  const section = (name) => page.getByRole('region', { name, exact: true });
  await open();
  const basic = section('基础配置');
  const advanced = section('高级配置');
  const manual = section('手写配置');
  const steamName = basic.getByRole('textbox', { name: 'Steam 服务器名称' });
  const turret = advanced.getByRole('spinbutton', { name: '炮塔数量上限' });
  const limit = advanced.getByRole('switch', { name: '启用区域炮塔限制' });
  const search = advanced.getByRole('textbox', { name: '搜索高级配置' });
  const savedName = '孤岛 Steam 验收';
  const harvest = basic.getByRole('spinbutton', { name: '采集倍率' });
  const saveButton = page.getByRole('button', { name: '保存配置', exact: true });
  const saved = join(hostRoot, 'instances', instance.id, 'ShooterGame', 'Saved');
  const settingsPath = join(saved, 'Config/WindowsServer/GameUserSettings.ini');
  const gamePath = join(saved, 'Config/WindowsServer/Game.ini');
  const mapState = async () =>
    (await dashboard()).instances.find((item) => item.id === instance.id);
  const confirmed = () =>
    page
      .getByRole('status')
      .filter({
        hasText: '主机已写入并校验 INI。',
      })
      .waitFor();
  assert.equal(await steamName.inputValue(), instance.config.sessionName);
  assert.equal(await turret.inputValue(), '100');
  assert.equal(await limit.isChecked(), true);
  assert((await basic.boundingBox()).y < (await advanced.boundingBox()).y);
  assert((await advanced.boundingBox()).y < (await manual.boundingBox()).y);
  await steamName.fill(savedName);
  await harvest.fill('25');
  await basic.getByRole('spinbutton', { name: '经验倍率' }).fill('3');
  await turret.fill('130');
  await limit.uncheck();
  await search.fill('PerLevelStatsMultiplier_Player[7]');
  const weight = advanced.getByRole('spinbutton', { name: '负重 · 玩家每级属性' });
  assert.equal(await weight.inputValue(), '1');
  await weight.fill('2.5');
  await search.fill('');
  await advanced.getByRole('button', { name: '自定义 INI 键值', exact: true }).click();
  await advanced.getByRole('textbox', { name: 'INI 节名' }).fill('ExampleMod');
  await advanced.getByRole('textbox', { name: 'INI 键名' }).fill('SomeModSwitch');
  await advanced.getByRole('combobox', { name: '值类型' }).click();
  await page.getByRole('option', { name: '开关', exact: true }).click();
  await advanced.getByRole('button', { name: '添加配置项' }).click();
  await advanced.getByRole('switch', { name: 'SomeModSwitch' }).check();
  await search.fill('SomeModSwitch');
  assert.equal(await advanced.getByRole('switch', { name: 'SomeModSwitch' }).isChecked(), true);
  await search.fill('');
  await manual
    .getByRole('textbox', { name: 'GameUserSettings.ini', exact: true })
    .fill('xpmultiplier=6');
  await manual.getByRole('textbox', { name: 'Game.ini', exact: true }).fill('limitturretsnum=180');
  await basic.getByText('手写覆盖 · 6', { exact: true }).waitFor();
  await advanced.getByText('手写覆盖 · 180', { exact: true }).waitFor();
  await saveButton.click();
  const savePreview = page.getByRole('list', { name: '本次修改', exact: true });
  await savePreview.getByText('采集倍率 · 2 → 25', { exact: true }).waitFor();
  assert.equal(await savePreview.getByRole('listitem').count(), 3);
  await savePreview.getByText('…', { exact: true }).waitFor();
  await confirmed();
  const snapshot = await dashboard();
  const receipt = snapshot.commands.find(
    (task) =>
      task.id === snapshot.instances.find((map) => map.id === instance.id).configSyncCommandId,
  ).result;
  assert.equal(
    (await realpath(receipt.settingsPath)).toLowerCase(),
    (await realpath(settingsPath)).toLowerCase(),
  );
  assert.equal(
    (await realpath(receipt.gamePath)).toLowerCase(),
    (await realpath(gamePath)).toLowerCase(),
  );
  await page.getByText('查看配置文件路径', { exact: true }).click();
  await page.getByText(receipt.settingsPath, { exact: true }).waitFor();
  await page.getByText(receipt.gamePath, { exact: true }).waitFor();
  await page.getByText('查看配置文件路径', { exact: true }).click();
  assert.equal((await mapState()).pid, null);

  const stored = (await dashboard()).instances.find((item) => item.id === instance.id).config;
  assert.equal(stored.sessionName, savedName);
  assert.equal(stored.xp, 3);
  assert.match(stored.advancedIni.game, /LimitTurretsNum=130/);
  assert.match(stored.advancedIni.game, /bLimitTurretsInRange=False/);
  assert.match(stored.advancedIni.game, /PerLevelStatsMultiplier_Player\[7\]=2.5/);
  assert.match(stored.advancedIni.settings, /\[ExampleMod\]\nSomeModSwitch=True/);
  assert.equal(stored.extraGameIni, 'limitturretsnum=180');
  assert.equal(stored.extraSettingsIni, 'xpmultiplier=6');
  await page.getByRole('tab', { name: '概况', exact: true }).click();
  await page.getByText(savedName, { exact: true }).waitFor();
  await open();
  assert.equal(await turret.inputValue(), '130');
  assert.equal(await limit.isChecked(), false);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(work, 'game-config-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await turret.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(work, 'game-config-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const settingsBytes = await readFile(settingsPath);
  assert.deepEqual([...settingsBytes.subarray(0, 2)], [0xff, 0xfe]);
  const settings = settingsBytes.toString('utf16le', 2);
  const game = await readFile(gamePath, 'utf8');
  assert.match(settings, /^HarvestAmountMultiplier=25$/m);
  assert.match(settings, /^SessionName=孤岛 Steam 验收$/m);
  assert.deepEqual(settings.match(/^xpmultiplier=.*$/gim), ['xpmultiplier=6']);
  assert.match(settings, /\[ExampleMod\]\nSomeModSwitch=True/);
  assert.deepEqual(game.match(/^limitturretsnum=.*$/gim), ['limitturretsnum=180']);
  assert.match(game, /^bLimitTurretsInRange=False$/m);
  assert.match(game, /^PerLevelStatsMultiplier_Player\[7\]=2.5$/m);
  await page.getByRole('link', { name: '查看完整记录', exact: true }).click();
  const record = page.getByRole('dialog', { name: '配置修改记录', exact: true });
  await record.getByText(/verification@ark.local/).waitFor();
  await record.getByText('手写配置 · 炮塔数量上限', { exact: true }).waitFor();
  assert.ok(
    (await record
      .getByRole('list', { name: '修改项', exact: true })
      .getByRole('listitem')
      .count()) > 3,
  );
  await page.goBack();
  await open();
  await command('start');
  assert.equal(await readFile(join(saved, 'launch-session-name.txt'), 'utf8'), savedName);
  const running = await waitFor(async () => {
    const map = await mapState();
    return map.status === 'running' && map.pid && map;
  }, '地图首次读取配置');
  await harvest.fill('50');
  await saveButton.click();
  await savePreview.getByText('采集倍率 · 25 → 50', { exact: true }).waitFor();
  assert.equal(await savePreview.getByRole('listitem').count(), 1);
  assert.equal(await savePreview.getByText('…', { exact: true }).count(), 0);
  await confirmed();
  assert.match(await readFile(settingsPath, 'utf16le'), /^HarvestAmountMultiplier=50$/m);
  assert.equal((await mapState()).pid, running.pid);
  assert.equal(await readFile(join(saved, 'launch-harvest.txt'), 'utf8'), '25');
  const rewriteMarker = join(saved, 'rewrite-harvest-on-start.txt');
  await writeFile(rewriteMarker, '');
  await command('restart');
  await rm(rewriteMarker);
  assert.doesNotMatch(await readFile(settingsPath, 'utf16le'), /^HarvestAmountMultiplier=/im);
  assert.equal(await readFile(join(saved, 'launch-harvest.txt'), 'utf8'), '50');
  await command('stop');
  await waitFor(
    async () =>
      (await dashboard()).instances.find((item) => item.id === instance.id)?.status === 'stopped',
    '配置验收地图已停止',
  );
  passed('地图同页表单和 390px 布局、Steam 名进入真实 Windows 进程参数、手写覆盖写入两份 INI');
  passed('保存摘要最多三行，超出显示省略号，完整操作记录展示所有修改、时间和操作者');
  passed('运行中保存采集倍率 50 至 INI，重启时模拟覆盖该项，进程仍从启动参数读到 50');
}
