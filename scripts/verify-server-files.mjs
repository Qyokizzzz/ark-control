import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

async function readIni(path) {
  const contents = await readFile(path);
  return contents[0] === 0xff && contents[1] === 0xfe
    ? contents.toString('utf16le', 2)
    : contents.toString('utf8');
}

export async function verifyServerFiles(context) {
  const {
    api,
    apiUrl,
    page,
    host,
    instance,
    hostRoot,
    work,
    root,
    launch,
    connection,
    fakeMetrics,
    availablePort,
    waitFor,
    dashboard,
    passed,
  } = context;
  const directory = join(work, 'file-library');
  await mkdir(directory, { recursive: true });
  const executable = (base) => join(base, 'ShooterGame/Binaries/Win64/ShooterGameServer.exe');
  const original = join(hostRoot, 'instances', instance.id);
  const stateOf = async (id) => (await dashboard()).instances.find((item) => item.id === id);
  const fileOf = async (id) => (await dashboard()).serverFiles.find((item) => item.id === id);
  async function done(task, type = 'commands', status = 'succeeded') {
    return waitFor(
      async () => {
        const value = (await dashboard())[type].find((item) => item.id === task.id);
        if (value && ['failed', 'succeeded', 'cancelled'].includes(value.status)) {
          assert.equal(value.status, status, value.error ?? value.progress);
          return value;
        }
      },
      `${type} ${task.kind}`,
      120000,
    );
  }
  async function mapCommand(map, kind, payload = {}) {
    await fakeMetrics();
    return done(
      await api(
        `/instances/${map.id}/commands`,
        'POST',
        { kind, countdownSeconds: 0, idempotencyKey: randomUUID(), ...payload },
        201,
      ),
    );
  }
  async function fileCommand(kind, assetId, values = {}, expected = 'succeeded') {
    return done(
      await api(
        '/server-files/tasks',
        'POST',
        {
          kind,
          hostId: host.id,
          ...(assetId ? { assetId } : {}),
          idempotencyKey: randomUUID(),
          ...values,
        },
        201,
      ),
      'fileTasks',
      expected,
    );
  }
  const card = (id) => page.locator(`[data-file-id="${id}"]`);
  async function filesPage() {
    await page.goto(`${apiUrl}/server-files`);
    await page.getByRole('heading', { name: '服务端文件', exact: true }).waitFor();
  }
  async function uiFile(kind, label, assetId, values = {}) {
    await filesPage();
    const button = assetId
      ? card(assetId).getByRole('button', { name: label, exact: true })
      : page.getByRole('button', { name: label, exact: true });
    await waitFor(() => button.isEnabled(), `文件操作可用 ${label}`);
    await button.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const hostField = dialog.getByRole('combobox', { name: '文件所在主机', exact: true });
    if (await hostField.count()) {
      await hostField.click();
      await page
        .getByRole('option', {
          name: (await dashboard()).hosts.find((item) => item.id === host.id).name,
          exact: true,
        })
        .click();
    }
    for (const [name, value] of Object.entries(values))
      await dialog.getByRole('textbox', { name, exact: true }).fill(value);
    const response = page.waitForResponse(
      (item) =>
        item.url().endsWith('/api/server-files/tasks') &&
        item.request().method() === 'POST' &&
        item.request().postDataJSON().kind === kind,
    );
    await dialog.getByRole('button', { name: label, exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 201, await result.text());
    const task = (await result.json()).data;
    await dialog.waitFor({ state: 'hidden' });
    return done(task, 'fileTasks');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const originalFile = await waitFor(async () => {
    const file = await fileOf(instance.id);
    return file?.instanceIds?.includes(instance.id) && file.path && file.fileCount ? file : null;
  }, '旧版目录迁入共享文件库');
  assert.equal(originalFile.path, join(hostRoot, 'maps', instance.id));
  assert.ok(originalFile.sizeBytes > 0);
  await filesPage();
  await card(originalFile.id).getByText(originalFile.name, { exact: true }).waitFor();
  assert.equal(
    await card(originalFile.id)
      .getByRole('button', { name: '删除下载文件', exact: true })
      .isEnabled(),
    false,
  );
  await api(
    '/server-files/tasks',
    'POST',
    { hostId: host.id, assetId: originalFile.id, kind: 'delete', idempotencyKey: randomUUID() },
    400,
  );
  passed('文件库自动识别已有目录、实际路径、空间和关联地图，已关联文件不能直接删除');
  const originalIni = await readIni(
    join(original, 'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini'),
  );
  const copied = await uiFile('clone', '创建本机副本', originalFile.id, {
    文件名称: '可复用服务端验收',
  });
  const base = await waitFor(async () => {
    const file = await fileOf(copied.assetId);
    return file?.status === 'ready' ? file : null;
  }, '副本准备完成');
  assert.ok(!relative(join(hostRoot, 'maps'), base.path).startsWith('..'));
  assert.equal(await stat(join(base.path, 'ShooterGame/Saved')).catch(() => null), null);
  assert.equal(
    await stat(
      join(base.path, 'ShooterGame/Binaries/Win64/ArkApi/Plugins/ArkTribeBridge/events.jsonl'),
    ).catch(() => null),
    null,
  );
  assert.equal(
    await readIni(join(original, 'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini')),
    originalIni,
  );
  passed('通过浏览器创建独立本机副本，程序保留且不复制存档、地图配置与旧部落日志');
  await filesPage();
  await card(base.id).getByRole('button', { name: '用于新地图', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /^后台地图名称/ }).fill('复用文件新地图');
  await dialog.getByRole('spinbutton', { name: '玩家上限', exact: true }).fill('1');
  for (const name of ['游戏端口', '查询端口', 'RCON 端口'])
    await dialog.getByRole('spinbutton', { name, exact: true }).fill(String(await availablePort()));
  let response = page.waitForResponse(
    (item) => item.url().endsWith('/api/instances') && item.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '创建地图', exact: true }).click();
  let created = await response;
  assert.equal(created.status(), 201, await created.text());
  const map = (await created.json()).data;
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(map.serverFileSource, base.id);
  await api(
    '/server-files/tasks',
    'POST',
    { hostId: host.id, assetId: base.id, kind: 'delete', idempotencyKey: randomUUID() },
    400,
  );
  passed('文件库可直接新建地图并指定来源，未安装地图预留的源文件不能删除');
  const steamCommands = join(hostRoot, 'tools/steamcmd/commands.txt');
  const steamInstalls = async () =>
    (await readFile(steamCommands, 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.includes('+app_update'));
  const before = await steamInstalls();
  await page.goto(`${apiUrl}/instances/${map.id}`);
  await page.getByRole('button', { name: '准备服务端', exact: true }).click();
  dialog = page.getByRole('dialog');
  response = page.waitForResponse(
    (item) =>
      item.url().endsWith(`/instances/${map.id}/commands`) && item.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '准备服务端', exact: true }).click();
  created = await response;
  assert.equal(created.status(), 201, await created.text());
  const installed = await done((await created.json()).data);
  assert.equal(installed.result.reused, true);
  assert.deepEqual(await steamInstalls(), before);
  assert.equal(
    await stat(join(hostRoot, 'instances', map.id, 'ShooterGame/Saved')).catch(() => null),
    null,
  );
  await waitFor(async () => (await stateOf(map.id))?.installed, '复用地图已准备');
  await mapCommand(map, 'start');
  await waitFor(async () => (await stateOf(map.id))?.status === 'running', '复用文件实际启动');
  const newIni = await readIni(
    join(
      hostRoot,
      'instances',
      map.id,
      'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini',
    ),
  );
  assert.notEqual(
    newIni.match(/ServerAdminPassword=(.*)/)[1],
    originalIni.match(/ServerAdminPassword=(.*)/)[1],
  );
  assert.equal((await dashboard()).events.filter((event) => event.instanceId === map.id).length, 0);
  await filesPage();
  assert.ok(
    await card(base.id).getByRole('button', { name: '用于新地图', exact: true }).isEnabled(),
  );
  const second = await api(
    '/instances',
    'POST',
    {
      hostId: host.id,
      name: '同一文件的第二个孤岛',
      map: 'TheIsland',
      serverFileSource: base.id,
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
      config: { sessionName: 'Second Island PVP', maxPlayers: 3, pve: false },
    },
    201,
  );
  assert.equal((await mapCommand(second, 'install')).result.fileId, base.id);
  await waitFor(async () => (await stateOf(second.id))?.installed, '第二地图共用文件已准备');
  await mapCommand(second, 'start');
  const runningSecond = await waitFor(async () => {
    const value = await stateOf(second.id);
    return value?.status === 'running' && value;
  }, '第二个孤岛独立 RCON 已就绪');
  const runningFirst = await stateOf(map.id);
  assert.equal(runningFirst.status, 'running');
  assert.notEqual(runningFirst.pid, runningSecond.pid);
  assert.equal(runningFirst.serverFileId, runningSecond.serverFileId);
  assert.deepEqual(await steamInstalls(), before);
  const packageFile = await stat(executable(base.path), { bigint: true });
  for (const item of [map, second]) {
    const directory = join(hostRoot, 'instances', item.id);
    const linked = await stat(executable(directory), { bigint: true });
    assert.equal(linked.ino, packageFile.ino);
    assert.equal(linked.dev, packageFile.dev);
    assert.equal((await lstat(join(directory, 'ShooterGame/Content/Maps'))).isSymbolicLink(), true);
  }
  const secondIni = await readIni(
    join(
      hostRoot,
      'instances',
      second.id,
      'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini',
    ),
  );
  assert.match(secondIni, /SessionName=Second Island PVP/);
  assert.notEqual(newIni, secondIni);
  passed(
    '同一套 maps 文件同时启动两个孤岛，两个真实 Windows 进程有各自的端口、配置和存档，无重复下载或复制',
  );
  await api(
    `/instances/${map.id}/commands`,
    'POST',
    { kind: 'update', maintenance: true, idempotencyKey: randomUUID() },
    400,
  );
  assert.deepEqual(await steamInstalls(), before);
  await mapCommand(map, 'stop');
  await mapCommand(second, 'stop');
  await waitFor(
    async () =>
      (await stateOf(map.id))?.status === 'stopped' &&
      (await stateOf(second.id))?.status === 'stopped',
    '共用地图均停服',
  );
  const update = await mapCommand(map, 'update');
  const newSteam = (await steamInstalls()).slice(before.length);
  assert.equal(newSteam.length, 1);
  assert.ok(newSteam[0].includes(base.path));
  assert.deepEqual(
    new Set(
      (await dashboard()).backups
        .filter((item) => item.commandId === update.id)
        .map((item) => item.instanceId),
    ),
    new Set([map.id, second.id]),
  );
  await waitFor(
    async () =>
      (await stateOf(second.id))?.installed && (await stateOf(map.id))?.status === 'stopped',
    '共用文件更新完毕',
  );
  await mapCommand(second, 'start');
  passed('在线地图阻止共用包更新；停服后分别备份存档，只调用一次 SteamCMD，第二地图仍能启动');
  const removed = await mapCommand(map, 'delete');
  assert.equal(removed.result.retainedDirectory, base.path);
  assert.ok((await mapCommand(second, 'players')).result.players.length);
  assert.equal(await stat(join(hostRoot, 'instances', map.id)).catch(() => null), null);
  assert.equal(
    await readIni(join(removed.result.savedArchive, 'Config/WindowsServer/GameUserSettings.ini')),
    newIni,
  );
  await waitFor(
    async () => (await fileOf(base.id))?.instanceIds?.length === 1,
    '删除第一地图后仅解除其关联',
  );
  await mapCommand(second, 'stop');
  await waitFor(async () => (await stateOf(second.id))?.status === 'stopped', '第二地图已关闭');
  await mapCommand(second, 'delete');
  const retained = await waitFor(async () => {
    const file = await fileOf(base.id);
    return file?.status === 'ready' && !file.instanceIds?.length ? file : null;
  }, '删除最后一张地图后同一文件包仍保留');
  passed('删除一张地图只回收其存档，另一张继续运行；删除最后一张地图后文件包仍可使用');
  const automatic = await api(
    '/instances',
    'POST',
    {
      hostId: host.id,
      name: '自动复用下一地图',
      map: 'TheIsland',
      serverFileSource: 'auto',
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
      config: { maxPlayers: 1 },
      autoRestart: false,
    },
    201,
  );
  const beforeAutomatic = await steamInstalls();
  assert.equal((await mapCommand(automatic, 'install')).result.reused, true);
  assert.deepEqual(await steamInstalls(), beforeAutomatic);
  await waitFor(async () => (await stateOf(automatic.id))?.installed, '自动复用已准备');
  await mapCommand(automatic, 'delete');
  passed('下次开图自动选择本机可用文件，无需重新下载');
  await uiFile('rename', '重命名', base.id, { 文件名称: '改名后的本机服务端' });
  await waitFor(async () => (await fileOf(base.id))?.name === '改名后的本机服务端', '文件名称更新');
  assert.equal((await fileOf(base.id)).path, base.path);
  await filesPage();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.__copiedFilePath = value;
        },
      },
    });
  });
  await card(base.id).getByRole('button', { name: '复制路径', exact: true }).click();
  await waitFor(() => page.evaluate(() => window.__copiedFilePath), '复制主机文件路径');
  assert.equal(await page.evaluate(() => window.__copiedFilePath), base.path);
  await uiFile('verify', '校验 / 修复', base.id);
  await waitFor(async () => (await fileOf(base.id))?.verifiedAt, '校验时间更新');
  await uiFile('update', '更新文件', base.id);
  passed('文件名称可独立修改、路径可复制，校验更新作为可追踪主机任务执行');
  const source = join(directory, 'existing-dedicated-server');
  await mkdir(dirname(executable(source)), { recursive: true });
  await copyFile(executable(original), executable(source));
  await mkdir(join(source, 'ShooterGame/Saved'), { recursive: true });
  await writeFile(join(source, 'ShooterGame/Saved/import-world.ark'), 'original-import-world');
  const imported = await uiFile('import', '导入已有服务端', null, {
    文件名称: '导入文件验收',
    已有服务端根目录: source,
  });
  const importedFile = await waitFor(async () => {
    const file = await fileOf(imported.assetId);
    return file?.status === 'ready' ? file : null;
  }, '导入已有服务端完成');
  assert.equal(await stat(join(importedFile.path, 'ShooterGame/Saved')).catch(() => null), null);
  assert.equal(
    await readFile(join(source, 'ShooterGame/Saved/import-world.ark'), 'utf8'),
    'original-import-world',
  );
  passed('可导入已有专用服务端，原目录和原存档保持不变');
  const steamRoot = join(hostRoot, 'tools/steamcmd');
  await writeFile(join(steamRoot, 'missing-config.txt'), 'always');
  const download = await fileCommand('download', null, { name: '失败后继续下载验收' }, 'failed');
  assert.match(download.error, /Missing configuration/);
  const partial = await waitFor(async () => {
    const file = await fileOf(download.assetId);
    return file?.status === 'partial' && file.path ? file : null;
  }, '未完成下载仍可管理');
  await mkdir(dirname(executable(partial.path)), { recursive: true });
  await copyFile(executable(original), executable(partial.path));
  await writeFile(join(partial.path, 'resume-marker.txt'), 'keep-partial-files');
  await writeFile(join(steamRoot, 'missing-config.txt'), 'once');
  const retry = await api(`/server-files/tasks/${download.id}/retry`, 'POST', undefined, 201);
  await done(retry, 'fileTasks');
  const completed = await waitFor(async () => {
    const file = await fileOf(download.assetId);
    return file?.status === 'ready' ? file : null;
  }, '下载重试完成');
  assert.equal(completed.path, partial.path);
  assert.equal(retry.assetId, download.assetId);
  assert.equal(
    await readFile(join(completed.path, 'resume-marker.txt'), 'utf8'),
    'keep-partial-files',
  );
  assert.equal(
    (await dashboard()).fileTasks.find((item) => item.id === download.id).status,
    'failed',
  );
  passed('独立下载失败后仍有文件记录和错误，重试复用同一目录并保留失败历史');
  await filesPage();
  await page.getByRole('combobox', { name: '主机筛选', exact: true }).click();
  await page
    .getByRole('option', {
      name: (await dashboard()).hosts.find((item) => item.id === host.id).name,
      exact: true,
    })
    .click();
  await page.getByRole('listbox').waitFor({ state: 'hidden' });
  await page.screenshot({
    path: join(work, 'server-files-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({
    path: join(work, 'server-files-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await uiFile('delete', '删除下载文件', importedFile.id);
  assert.equal(await stat(importedFile.path).catch(() => null), null);
  assert.ok(await stat(executable(retained.path)));
  assert.equal(
    await readFile(join(source, 'ShooterGame/Saved/import-world.ark'), 'utf8'),
    'original-import-world',
  );
  assert.equal(
    await readIni(join(removed.result.savedArchive, 'Config/WindowsServer/GameUserSettings.ini')),
    newIni,
  );
  passed('桌面与手机文件管理可用，只有明确删除下载文件才物理释放空间，其他副本和回收存档保留');
  const legacyHost = await api('/hosts', 'POST', { name: '旧助手保留文件验收' }, 201);
  const enrollment = await api(
    '/agent/enroll',
    'POST',
    { code: legacyHost.code, platform: 'windows', agentVersion: '1.0.0' },
    201,
  );
  const credential = `${legacyHost.id}.${enrollment.token}`;
  const legacyRoot = join(directory, 'legacy-host');
  const reservedId = randomUUID();
  const reservedPath = join(legacyRoot, 'server-files', reservedId);
  await mkdir(dirname(executable(reservedPath)), { recursive: true });
  await copyFile(executable(original), executable(reservedPath));
  await api(
    '/agent/heartbeat',
    'POST',
    {
      metrics: (await dashboard()).hosts.find((item) => item.id === host.id).metrics,
      instances: [],
      runningCommands: [],
      console: [],
      features: ['shared-map-files-v1'],
      serverFiles: [{ ...base, id: reservedId, hostId: legacyHost.id, path: reservedPath }],
    },
    201,
    credential,
  );
  const cancelledDelete = await api(
    '/server-files/tasks',
    'POST',
    { kind: 'delete', assetId: reservedId, hostId: legacyHost.id, idempotencyKey: randomUUID() },
    201,
  );
  await api(`/server-files/tasks/${cancelledDelete.id}/cancel`, 'POST', undefined, 201);
  const reservedMap = await api(
    '/instances',
    'POST',
    {
      hostId: legacyHost.id,
      name: '重试删除预留保护',
      map: 'TheIsland',
      serverFileSource: reservedId,
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
    },
    201,
  );
  await api(`/server-files/tasks/${cancelledDelete.id}/retry`, 'POST', undefined, 400);
  await api(
    '/management/actions',
    'POST',
    {
      scopeId: `instance:${reservedMap.id}`,
      kind: 'shop-read',
      reason: '旧助手能力拦截',
      idempotencyKey: randomUUID(),
    },
    400,
  );
  await api(
    '/server-files/tasks',
    'POST',
    {
      hostId: legacyHost.id,
      assetId: reservedId,
      kind: 'verify',
      branch: 'preaquatica',
      idempotencyKey: randomUUID(),
    },
    400,
  );
  passed('旧助手拒绝执行新版商店和分支任务，防止忽略版本参数后安装错误分支');
  assert.equal(
    (await dashboard()).fileTasks.find((item) => item.id === cancelledDelete.id).status,
    'cancelled',
  );
  assert.ok(await stat(executable(reservedPath)));
  await api(
    `/instances/${reservedMap.id}/commands`,
    'POST',
    { kind: 'delete', countdownSeconds: 0, idempotencyKey: randomUUID() },
    201,
  );
  await api(
    '/server-files/tasks',
    'POST',
    { kind: 'delete', assetId: base.id, hostId: legacyHost.id, idempotencyKey: randomUUID() },
    400,
  );
  const cancelled = await api(
    '/server-files/tasks',
    'POST',
    { kind: 'download', name: '取消的下载', hostId: legacyHost.id, idempotencyKey: randomUUID() },
    201,
  );
  await api(`/server-files/tasks/${cancelled.id}/cancel`, 'POST', undefined, 201);
  assert.equal(
    (await dashboard()).fileTasks.find((item) => item.id === cancelled.id).status,
    'cancelled',
  );
  const clearEmpty = await api(
    '/server-files/tasks',
    'POST',
    {
      kind: 'delete',
      assetId: cancelled.assetId,
      hostId: legacyHost.id,
      idempotencyKey: randomUUID(),
    },
    201,
  );
  const oldMap = await api(
    '/instances',
    'POST',
    {
      hostId: legacyHost.id,
      name: '旧助手待删除地图',
      map: 'TheIsland',
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
    },
    201,
  );
  const oldDirectory = join(legacyRoot, 'instances', oldMap.id);
  await mkdir(dirname(executable(oldDirectory)), { recursive: true });
  await copyFile(executable(original), executable(oldDirectory));
  await mkdir(join(oldDirectory, 'ShooterGame/Saved'), { recursive: true });
  await writeFile(join(oldDirectory, 'ShooterGame/Saved/legacy.ark'), 'legacy-save');
  await connection.execute(
    "UPDATE resources SET body=JSON_SET(body,'$.installed',true,'$.filesTouched',true) WHERE kind='instances' AND id=?",
    [oldMap.id],
  );
  const pendingDelete = await api(
    `/instances/${oldMap.id}/commands`,
    'POST',
    { kind: 'delete', idempotencyKey: randomUUID() },
    201,
  );
  const oldPoll = await api('/agent/poll', 'GET', undefined, 200, credential);
  assert.deepEqual(oldPoll.commands, []);
  assert.deepEqual(oldPoll.fileTasks, []);
  assert.match(oldPoll.warnings.join('\n'), /旧版助手/);
  assert.ok(await stat(executable(oldDirectory)));
  const config = join(directory, 'legacy-agent.json');
  await writeFile(
    config,
    JSON.stringify({ apiUrl, hostId: legacyHost.id, token: enrollment.token, root: legacyRoot }),
  );
  const agent = launch(
    process.execPath,
    [join(root, 'apps/agent/dist/main.js'), '--config', config],
    { cwd: root, label: 'file-retention-upgrade-agent' },
  );
  const preserved = await done(pendingDelete);
  await done(clearEmpty, 'fileTasks');
  assert.ok(await stat(executable(preserved.result.retainedDirectory)));
  assert.equal(
    await readFile(join(preserved.result.savedArchive, 'legacy.ark'), 'utf8'),
    'legacy-save',
  );
  assert.equal(await stat(join(legacyRoot, 'tools/steamcmd')).catch(() => null), null);
  await api(`/hosts/${legacyHost.id}/disconnect`, 'POST', undefined, 201);
  await waitFor(
    async () =>
      (await dashboard()).hosts.find((item) => item.id === legacyHost.id)?.status ===
      'disconnected',
    '升级验证助手断开',
  );
  await waitFor(() => agent.exitCode !== null, '升级验证助手退出');
  await api(`/hosts/${legacyHost.id}`, 'DELETE');
  assert.ok(await stat(executable(preserved.result.retainedDirectory)));
  passed('重试删除仍受预留保护，旧助手不能领取删除任务，新助手接入后保留文件，取消的下载不执行');
}
