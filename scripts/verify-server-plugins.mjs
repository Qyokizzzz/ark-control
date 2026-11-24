import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { buffer } from 'node:stream/consumers';

const require = createRequire(new URL('../apps/agent/package.json', import.meta.url));
const archiver = require('archiver');
const capability = 'server-plugins-v1';
const uiCapability = 'arkshop-ui-plugin-v1';

async function archive(entries) {
  const zip = archiver('zip');
  const output = zip.pipe(new PassThrough());
  const contents = buffer(output);
  zip.on('error', (error) => output.destroy(error));
  for (const [name, value] of Object.entries(entries)) zip.append(value, { name });
  await zip.finalize();
  return contents;
}

const fakeDll = Buffer.alloc(88);
fakeDll.writeUInt16LE(0x5a4d);
fakeDll.writeUInt32LE(64, 60);
fakeDll.writeUInt32LE(0x4550, 64);
fakeDll.writeUInt16LE(0x8664, 68);
fakeDll.writeUInt16LE(0x2000, 86);

const report = (id, overwrite = {}) => ({
  id,
  status: 'stopped',
  installed: true,
  cpuPercent: 0,
  memoryMb: 0,
  pid: null,
  startedAt: null,
  lastError: null,
  buildId: 'verification',
  ...overwrite,
});

export async function verifyServerPlugins({
  page,
  root,
  work,
  launch,
  apiUrl,
  accessToken,
  hostToken,
  host,
  instance,
  api,
  agent,
  fakeMetrics,
  availablePort,
  waitFor,
  passed,
}) {
  const group = 'plugin-verification';
  const makeMap = async (name) =>
    api(
      '/instances',
      'POST',
      {
        hostId: host.id,
        name,
        map: 'TheIsland',
        clusterId: group,
        branch: 'preaquatica',
        gamePort: await availablePort(),
        queryPort: await availablePort(),
        rconPort: await availablePort(),
        config: { sessionName: name, maxPlayers: 1 },
      },
      201,
    );
  const selected = await makeMap('勾选 · 孤岛');
  const excluded = await makeMap('取消 · 孤岛');
  const otherHost = await api(
    '/hosts',
    'POST',
    { name: '插件隔离验证主机', address: '127.0.0.1' },
    201,
  );
  const enrolled = await api(
    '/agent/enroll',
    'POST',
    {
      code: otherHost.code,
      platform: 'windows',
      agentVersion: '1.0.0',
    },
    201,
    '',
  );
  const reports = [report(instance.id), report(selected.id), report(excluded.id)];
  await fakeMetrics(reports, [capability]);
  const tsconfig = join(work, 'plugin-agent-tsconfig.json');
  await writeFile(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        paths: {
          '@/*': [join(root, 'apps/agent/src/*')],
          '@common/*': [join(root, 'common/src/*')],
          '@ark-control/common': [join(root, 'common/src/index.ts')],
        },
      },
    }),
  );
  const keepOnline = setInterval(
    () => void fakeMetrics(reports, [capability]).catch(() => {}),
    6500,
  );
  try {
    const hostRoot = join(work, 'plugin-host');
    const instanceBin = (id) => join(hostRoot, 'instances', id, 'ShooterGame', 'Binaries', 'Win64');
    const configured = join(instanceBin(selected.id), 'ArkApi', 'Plugins', 'ArkShop');
    const originalConfig = '{"original":true}\n';
    await mkdir(configured, { recursive: true });
    await writeFile(join(configured, 'config.json'), originalConfig);
    for (const id of [instance.id, selected.id, excluded.id]) {
      await mkdir(instanceBin(id), { recursive: true });
      await writeFile(join(instanceBin(id), 'ShooterGameServer.exe'), 'unused fixture file');
    }
    const shared = join(hostRoot, 'maps', randomUUID(), 'ShooterGame', 'Binaries', 'Win64');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'ShooterGameServer.exe'), 'shared fixture');

    await page.goto(`${apiUrl}/shop`);
    await page.getByRole('combobox', { name: '互通组 / 独立服' }).click();
    await page.getByRole('option', { name: group }).click();
    const link = page.getByRole('link', { name: '安装依赖' });
    await link.waitFor();
    const alert = page.getByRole('alert').filter({ has: link });
    const aligned = async () => {
      const icon = await alert.locator('.MuiAlert-icon svg').boundingBox();
      const body = await alert.locator('.MuiAlert-message').boundingBox();
      const action = await link.boundingBox();
      assert.ok(icon && body && action);
      const center = body.y + body.height / 2;
      assert.ok(Math.abs(icon.y + icon.height / 2 - center) < 1.5);
      assert.ok(Math.abs(action.y + action.height / 2 - center) < 1.5);
    };
    await aligned();
    await page.setViewportSize({ width: 390, height: 844 });
    await aligned();
    await link.click();
    await page.getByRole('heading', { name: '服务端插件', exact: true }).waitFor();
    assert.match(new URL(page.url()).searchParams.get('scopeId'), /cluster:plugin-verification/);
    assert.match(
      await page.getByRole('combobox', { name: '互通组 / 独立服' }).innerText(),
      /plugin-verification/,
    );
    const selectedCheck = page.getByRole('checkbox', { name: selected.name, exact: true });
    const excludedCheck = page.getByRole('checkbox', { name: excluded.name, exact: true });
    assert.equal(await selectedCheck.isChecked(), true);
    assert.equal(await excludedCheck.isChecked(), true);
    await excludedCheck.uncheck();
    assert.equal(await page.getByRole('button', { name: '为 1 张地图安装' }).isDisabled(), true);
    passed('商店依赖提示在桌面与手机对齐，并跳转到当前互通组，默认勾选所有可安装地图');

    const arkApi = await archive({
      'ShooterGame/Binaries/Win64/version.dll': fakeDll,
      'ShooterGame/Binaries/Win64/config.json': '{"settings":{}}',
      'ShooterGame/Binaries/Win64/ArkApi/Plugins/Unexpected/Unexpected.dll': fakeDll,
    });
    const permissions = await archive({
      'bundle/Permissions/Permissions.dll': fakeDll,
      'bundle/Permissions/PluginInfo.json': '{}',
    });
    const invalidShop = await archive({ 'unrelated/for-wrong-plugin.txt': 'verification' });
    const shop = await archive({
      'release/ArkShop/ArkShop.dll': fakeDll,
      'release/ArkShop/PluginInfo.json': '{}',
      'release/ArkShop/config.json': '{"new":true}',
    });
    async function upload(label, name, contents) {
      await page.locator(`input[aria-label^="${label} "][type=file]`).setInputFiles({
        name,
        mimeType: 'application/zip',
        buffer: contents,
      });
      await page.getByText(name, { exact: true }).waitFor();
    }
    await upload('ASE ArkApi', 'arkapi-358.zip', arkApi);
    await upload('Permissions', 'permissions-358.zip', permissions);
    await upload('ArkShop', 'wrong-arkshop-358.zip', invalidShop);
    const install = () => page.getByRole('button', { name: '为 1 张地图安装' });
    await install().click();
    await page.getByText('已提交 1 张地图的安装任务。', { exact: true }).waitFor();

    async function lease(id, features = capability) {
      const { commands } = await api('/agent/poll', 'GET', undefined, 200, hostToken, features);
      assert.equal(commands.length, 1);
      assert.equal(commands[0].instanceId, id);
      assert.equal(commands[0].kind, 'install-plugins');
      return commands[0];
    }
    async function run(command, expectedStatus) {
      await agent(`/commands/${command.id}/ack`, { status: 'executing' });
      const unauthorized = await fetch(
        `${apiUrl}/api/agent/server-plugins/tasks/${command.id}/arkapi`,
        { headers: { Authorization: `Bearer ${enrolled.hostId}.${enrolled.token}` } },
      );
      assert.equal(unauthorized.status, 404);
      const [hostId, token] = hostToken.split('.');
      const input = join(work, `plugin-task-${command.id}.json`);
      await writeFile(
        input,
        JSON.stringify({ config: { apiUrl, hostId, token, root: hostRoot }, command }),
      );
      const child = launch(
        process.execPath,
        ['--import', 'tsx', join(root, 'tests/fixtures/plugin-install.ts'), input],
        {
          cwd: root,
          label: 'plugin-install',
          env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
        },
      );
      const [exit] = await once(child, 'exit');
      assert.equal(exit, 0, '插件验收进程异常退出');
      const view = await api('/server-plugins');
      const target = view.maps.find(({ id }) => id === command.instanceId);
      assert.equal(target.task.status, expectedStatus, target.task.error);
      assert.equal(view.maps.find(({ id }) => id === excluded.id).task, null);
      return target;
    }

    const failed = await run(await lease(selected.id), 'failed');
    assert.match(failed.task.error, /安装包应包含一份 ArkShop\.dll/);
    await assert.rejects(stat(join(instanceBin(selected.id), 'version.dll')), { code: 'ENOENT' });
    await page.getByText(/安装包应包含一份 ArkShop\.dll/).waitFor();
    await upload('ArkShop', 'arkshop-358.zip', shop);
    await install().click();
    const result = await run(await lease(selected.id), 'succeeded');
    assert.deepEqual(result.report.installed, ['arkapi', 'permissions', 'arkshop']);
    assert.equal(result.report.loaded, null);
    assert.equal(await readFile(join(configured, 'config.json'), 'utf8'), originalConfig);
    assert.equal(
      await readFile(
        join(
          instanceBin(selected.id),
          'ArkControlPluginBackups',
          result.task.id,
          'ArkApi',
          'Plugins',
          'ArkShop',
          'config.json',
        ),
        'utf8',
      ),
      originalConfig,
    );
    await assert.rejects(stat(join(shared, 'version.dll')), { code: 'ENOENT' });
    await assert.rejects(stat(join(instanceBin(excluded.id), 'version.dll')), { code: 'ENOENT' });
    await assert.rejects(stat(join(instanceBin(selected.id), 'ArkApi', 'Plugins', 'Unexpected')), {
      code: 'ENOENT',
    });
    await page.getByText('ArkShop · 已安装，待启动验证', { exact: true }).waitFor();
    passed(
      '只有勾选的地图接收安装任务。无效包不会部分安装，重试保留配置、备份配置并保持共享文件不变',
    );

    const uiPlugin = page.getByRole('checkbox', { name: 'ArkShopUI', exact: true });
    assert.equal(await uiPlugin.isChecked(), false);
    assert.match(
      await page.getByRole('link', { name: /MX-E Ark Shop UI/ }).getAttribute('href'),
      /id=2693727499$/,
    );
    const uiZip = await archive({
      'release/ArkShopUI/ArkShopUI.dll': fakeDll,
      'release/ArkShopUI/PluginInfo.json': '{}',
    });
    await upload('ArkShopUI', 'arkshop-ui-358.zip', uiZip);
    const uiInstall = {
      scopeId: `cluster:${group}`,
      mapIds: [selected.id],
      pluginIds: ['arkshop-ui'],
      idempotencyKey: randomUUID(),
    };
    await api('/server-plugins/install', 'POST', uiInstall, 409);
    await fakeMetrics(reports, [capability, uiCapability]);
    await api('/server-plugins/install', 'POST', uiInstall, 201);
    const uiCommand = await lease(selected.id, [capability, uiCapability].join(','));
    assert.deepEqual(
      uiCommand.payload.items.map(({ pluginId }) => pluginId),
      ['arkapi', 'permissions', 'arkshop', 'arkshop-ui'],
    );
    const installedUi = await run(uiCommand, 'succeeded');
    assert.deepEqual(installedUi.report.installed, [
      'arkapi',
      'permissions',
      'arkshop',
      'arkshop-ui',
    ]);
    passed('ArkShopUI 下载链接和创意工坊编号正确，安装自动包含依赖，旧版助手收到升级提示');

    await page.goto(`${apiUrl}/instances/${selected.id}`);
    await page.getByRole('tab', { name: '模组', exact: true }).click();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByRole('combobox', { name: '常用模组' }).click();
    await page.getByRole('option', { name: /MX-E Ark Shop UI/ }).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    passed('地图编辑模组的常用列表包含 MX-E Ark Shop UI');

    await api(
      '/management/shop/mode',
      'POST',
      { scopeId: `instance:${instance.id}`, mode: 'independent' },
      201,
    );
    const rawUpload = await fetch(
      `${apiUrl}/api/server-plugins/packages/public/arkapi?name=arkapi-361.zip`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
        },
        body: arkApi,
      },
    );
    assert.equal(rawUpload.status, 201);
    const input = {
      scopeId: `instance:${instance.id}`,
      mapIds: [instance.id],
      pluginIds: ['ark-control-shop'],
      idempotencyKey: randomUUID(),
    };
    const batch = await api('/server-plugins/install', 'POST', input, 201);
    assert.deepEqual(await api('/server-plugins/install', 'POST', input, 201), batch);
    await api('/server-plugins/install', 'POST', { ...input, mapIds: [excluded.id] }, 409);
    const builtin = await run(await lease(instance.id), 'succeeded');
    assert.deepEqual(builtin.report.installed, ['arkapi', 'ark-control-shop']);
    await waitFor(async () => {
      const end = await api('/agent/poll', 'GET', undefined, 200, hostToken, capability);
      return end.commands.length === 0;
    }, '插件任务队列清空');
    passed('独立商店自动补齐 ArkApi 并从后台下载内置插件，重复提交复用任务，禁止跨组选择');
  } finally {
    clearInterval(keepOnline);
  }
}
