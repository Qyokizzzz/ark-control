import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function verifyManagement(context) {
  const {
    api,
    apiUrl,
    page,
    host,
    hostRoot,
    work,
    root,
    launch,
    availablePort,
    waitFor,
    dashboard,
    passed,
    agent,
    fakeMetrics,
  } = context;
  const steamId = '76561198000000001';
  const map = await api(
    '/instances',
    'POST',
    {
      name: '经济联调孤岛',
      hostId: host.id,
      map: 'TheIsland',
      clusterId: 'economy-verification',
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
      serverFileSource: 'download',
      autoBranchUpdate: false,
    },
    201,
  );
  const scopeId = `cluster:${map.clusterId}`;
  const binary = join(
    hostRoot,
    'instances',
    map.id,
    'ShooterGame/Binaries/Win64/ShooterGameServer.exe',
  );
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(join(dirname(binary), '../../ShooterGame.uproject'), '{"FileVersion":3}');
  const compiler = join(
    process.env.WINDIR ?? 'C:/Windows',
    'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  );
  const compiled = launch(
    compiler,
    ['/nologo', '/target:exe', `/out:${binary}`, join(root, 'tests/fixtures/FakeArk.cs')],
    { label: 'compile-economy-fixture' },
  );
  assert.equal(
    await new Promise((yes, no) => {
      compiled.once('error', no);
      compiled.once('exit', yes);
    }),
    0,
  );
  const plugins = join(dirname(binary), 'ArkApi/Plugins');
  const configPath = join(plugins, 'ArkShop/config.json');
  const original = {
    Mysql: { UseMysql: false, MysqlPass: 'fixture-private-password' },
    General: { Discord: { WebhookURL: 'fixture-private-webhook' } },
    ShopItems: {
      stone: {
        Type: 'item',
        Price: 10,
        Description: '石头',
        Items: [{ Amount: 1, Quality: 0, Blueprint: 'fixture-only' }],
      },
    },
    Kits: {},
    SellItems: {},
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(original));
  await mkdir(join(plugins, 'Permissions'), { recursive: true });
  await writeFile(join(plugins, 'Permissions/config.json'), JSON.stringify({ UseMysql: false }));
  const scope = () => api(`/management?${new URLSearchParams({ scopeId })}`);
  await waitFor(
    async () => (await dashboard()).instances.find((instance) => instance.id === map.id)?.installed,
    '经济测试文件识别',
  );
  await fakeMetrics();
  await api(
    `/instances/${map.id}/commands`,
    'POST',
    { kind: 'start', idempotencyKey: randomUUID() },
    201,
  );
  await waitFor(
    async () =>
      (await dashboard()).instances.find((instance) => instance.id === map.id)?.status ===
      'running',
    '经济测试地图启动',
    60000,
  );
  const password = 'fixture-admin-' + randomUUID();
  const settingsPath = join(
    hostRoot,
    'instances',
    map.id,
    'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini',
  );
  const adminGroups = () => api('/clusters/admin-passwords');
  const passwordStatus = async () =>
    (await adminGroups()).find(({ id }) => id === map.clusterId).maps[0].status;
  assert.equal(await passwordStatus(), 'individual');
  assert.ok(!(await readFile(settingsPath, 'utf8')).includes(password));
  await page.goto(`${apiUrl}/instances`);
  await page.getByRole('link', { name: '互通组设置', exact: true }).click();
  await page.getByLabel('输入新的游戏管理员密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '保存密码', exact: true }).click();
  await page.getByText('等待下次启动', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('输入新的游戏管理员密码', { exact: true }).inputValue(), '');
  assert.equal(await passwordStatus(), 'restart');
  assert.ok(!(await readFile(settingsPath, 'utf8')).includes(password));
  assert.ok(!JSON.stringify(await adminGroups()).includes(password));
  assert.ok(!JSON.stringify(await dashboard()).includes(password));
  const restart = await api(
    `/instances/${map.id}/commands`,
    'POST',
    { kind: 'restart', idempotencyKey: randomUUID(), countdownSeconds: 0 },
    201,
  );
  await waitFor(
    async () => {
      const command = (await dashboard()).commands.find(({ id }) => id === restart.id);
      if (command?.status === 'failed') throw new Error(command.error);
      return command?.status === 'succeeded' && (await passwordStatus()) === 'applied';
    },
    '旧密码正常停服，新密码启动并通过 RCON',
    60000,
  );
  const ini = await readFile(settingsPath, 'utf8');
  assert.ok(ini.split(/\r?\n/).includes(`ServerAdminPassword=${password}`));
  passed('互通组密码由页面设置，运行中的地图沿用旧密码停服，重启后使用新密码通过 RCON');
  await api(
    '/management/players',
    'POST',
    { scopeId, steamId, name: '中文经济玩家', note: '联调档案' },
    201,
  );
  await waitFor(
    async () =>
      (await scope()).players.some(
        (player) => player.steamId === steamId && player.onlineMaps.length,
      ),
    '后台自动采样玩家',
    50000,
  );
  const action = async (kind, values = {}) => {
    const jobs = await api(
      '/management/actions',
      'POST',
      {
        scopeId,
        steamId,
        kind,
        idempotencyKey: randomUUID(),
        reason: '本地联调（游戏插件由替身模拟）',
        ...values,
      },
      201,
    );
    return jobs[0];
  };
  const finished = async (id, status = 'succeeded') =>
    waitFor(
      async () => {
        const task = (await scope()).tasks.find((item) => item.id === id);
        if (task && !['queued', 'leased', 'executing'].includes(task.status)) {
          assert.equal(task.status, status, JSON.stringify(task));
          return task;
        }
        return false;
      },
      `管理任务 ${id}`,
      60000,
    );
  await finished((await action('shop-read')).id);
  let state = await scope();
  assert.ok(state.shop);
  assert.ok(!JSON.stringify(state).includes('fixture-private'));
  const key = randomUUID();
  const coinInput = {
    scopeId,
    steamId,
    kind: 'coins',
    amount: 100,
    idempotencyKey: key,
    reason: '重复提交验收',
  };
  const grant = (await api('/management/actions', 'POST', coinInput, 201))[0];
  const duplicate = (await api('/management/actions', 'POST', coinInput, 201))[0];
  assert.equal(grant.id, duplicate.id);
  await finished(grant.id);
  assert.equal((await scope()).players.find((player) => player.steamId === steamId).balance, 1100);
  await api('/management/actions', 'POST', { ...coinInput, amount: 101 }, 400);
  const commandLog = join(
    hostRoot,
    'instances',
    map.id,
    'ShooterGame/Saved/management-commands.txt',
  );
  assert.equal(
    (await readFile(commandLog, 'utf8'))
      .split('\n')
      .filter((line) => line.startsWith('ChangePoints')).length,
    1,
  );
  passed('真实 API / MySQL / 助手链路：重复请求只执行一次金币变动，读取实际回执余额');
  await finished((await action('vip-grant', { group: 'VIP', hours: 24 })).id);
  state = await scope();
  assert.equal(state.players.find((player) => player.steamId === steamId).vip[0].group, 'VIP');
  await finished((await action('vip-revoke', { group: 'VIP' })).id);
  assert.equal((await scope()).players.find((player) => player.steamId === steamId).vip.length, 0);
  passed('Permissions RCON 适配：限时 VIP 发放和撤销，按互通组保存权益与操作流水');
  const other = await api(
    '/instances',
    'POST',
    {
      name: '经济隔离独立服',
      hostId: host.id,
      map: 'TheIsland',
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
      autoBranchUpdate: false,
    },
    201,
  );
  const otherScope = `instance:${other.id}`;
  await api(
    '/management/players',
    'POST',
    { scopeId: otherScope, steamId, name: '同一玩家的独立服档案' },
    201,
  );
  const isolated = await api(`/management?${new URLSearchParams({ scopeId: otherScope })}`);
  assert.equal(isolated.players[0].balance, null);
  assert.equal(isolated.players[0].vip.length, 0);
  await api(
    '/instances',
    'POST',
    {
      name: '混用分支',
      hostId: host.id,
      map: 'TheIsland',
      clusterId: map.clusterId,
      branch: 'preaquatica',
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
    },
    400,
  );
  const beta = await api(
    '/instances',
    'POST',
    {
      name: '358 兼容分支',
      hostId: host.id,
      map: 'TheIsland',
      branch: 'preaquatica',
      autoBranchUpdate: false,
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
    },
    201,
  );
  assert.equal(beta.branch, 'preaquatica');
  passed('同 SteamID 跨独立服经济隔离，公开 / preaquatica 分支选择及互通组混用拒绝');
  const event = {
    eventId: randomUUID(),
    instanceId: map.id,
    steamId,
    kind: 'shop-purchase',
    occurredAt: new Date().toISOString(),
    detail: {
      productId: 'stone',
      amount: 20,
      quantity: 2,
      status: 'delivered',
      label: '中文消费记录',
    },
  };
  const commercePath = join(
    hostRoot,
    'instances',
    map.id,
    'ShooterGame/Saved/Logs/ArkControlCommerce.jsonl',
  );
  const bytes = Buffer.from(JSON.stringify(event) + '\r\n');
  const split = bytes.indexOf(Buffer.from('中文')) + 1;
  await writeFile(commercePath, bytes.subarray(0, split));
  await new Promise((yes) => setTimeout(yes, 3000));
  await appendFile(commercePath, bytes.subarray(split));
  await waitFor(
    async () => (await scope()).ledger.some((entry) => entry.operationId === event.eventId),
    '消费日志采集',
  );
  await agent('/management/events', { events: [event, event] });
  assert.equal(
    (await scope()).ledger.filter((entry) => entry.operationId === event.eventId).length,
    1,
  );
  await api(
    '/agent/management/events',
    'POST',
    { events: [{ ...event, eventId: randomUUID(), instanceId: randomUUID() }] },
    403,
    context.hostToken,
  );
  const full = await api(`/management/ledger?${new URLSearchParams({ scopeId })}`);
  assert.ok(full.total >= 4);
  assert.equal(full.entries.filter((entry) => entry.operationId === event.eventId).length, 1);
  passed('中文分片消费日志、持久游标、重复事件去重、主机隔离和完整流水分页');
  const shop = state.shop;
  const draft = {
    ...shop.config,
    ShopItems: {
      stone: {
        Type: 'item',
        Price: 20,
        Description: '石头',
        Items: [{ Amount: 1, Blueprint: 'fixture-only' }],
      },
    },
  };
  const saved = await api(
    '/management/shop',
    'POST',
    { scopeId, revision: shop.revision, config: draft },
    201,
  );
  await api('/management/shop', 'POST', { scopeId, revision: shop.revision, config: draft }, 400);
  const peer = await api(
    '/instances',
    'POST',
    {
      name: '发布预检第二张地图',
      hostId: host.id,
      map: 'Ragnarok',
      clusterId: map.clusterId,
      gamePort: await availablePort(),
      queryPort: await availablePort(),
      rconPort: await availablePort(),
    },
    201,
  );
  const prepare = async () => {
    const id = randomUUID();
    await api(
      '/management/shop/preflight',
      'POST',
      {
        scopeId,
        revision: saved.revision,
        idempotencyKey: id,
      },
      201,
    );
    const path = `/management/shop/preflight/${id}?${new URLSearchParams({ scopeId })}`;
    const result = await waitFor(async () => {
      const preview = await api(path);
      return !preview.pending && preview;
    }, '各地图读取结果');
    return { id, result };
  };
  const blockedPreview = await prepare();
  assert.equal(blockedPreview.result.ready, false);
  assert.match(blockedPreview.result.maps.find(({ id }) => id === peer.id).error, /ArkShop/);
  await api(
    '/management/actions',
    'POST',
    {
      scopeId,
      kind: 'shop-publish',
      reason: '预检失败的发布应被拒绝',
      idempotencyKey: randomUUID(),
      revision: saved.revision,
      preflightId: blockedPreview.id,
    },
    409,
  );
  const peerConfig = join(
    hostRoot,
    'instances',
    peer.id,
    'ShooterGame/Binaries/Win64/ArkApi/Plugins/ArkShop/config.json',
  );
  await mkdir(dirname(peerConfig), { recursive: true });
  await writeFile(peerConfig, JSON.stringify(original));
  await page.goto(`${apiUrl}/shop`);
  await page.getByRole('combobox', { name: '互通组 / 独立服' }).click();
  await page.getByRole('option', { name: map.clusterId, exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '读取主机配置', exact: true }).count(), 0);
  await page.getByRole('button', { name: '发布到组内地图', exact: true }).click();
  const publishDialog = page.getByRole('dialog', { name: '发布商店', exact: true });
  await publishDialog.getByText('新增 0，修改 1，移除 0').last().waitFor();
  await waitFor(
    async () => (await publishDialog.getByText('新增 0，修改 1，移除 0').count()) === 2,
    '两张地图都显示改动摘要',
  );
  await publishDialog.getByRole('textbox', { name: '发布说明' }).fill('核对两张地图的变更后发布');
  await publishDialog.getByRole('button', { name: '确认发布', exact: true }).click();
  await publishDialog.waitFor({ state: 'hidden' });
  const publishedTasks = (await scope()).tasks.filter(({ kind }) => kind === 'shop-publish');
  assert.equal(publishedTasks.length, 2);
  assert.ok(publishedTasks.every(({ payload }) => payload.preflightId));
  await Promise.all(publishedTasks.map(({ id }) => finished(id)));
  const publish = publishedTasks.find(({ instanceId }) => instanceId === map.id);
  const published = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(JSON.parse(await readFile(peerConfig, 'utf8')).ShopItems.stone.Price, 20);
  assert.equal(published.Mysql.MysqlPass, original.Mysql.MysqlPass);
  assert.equal(published.General.Discord.WebhookURL, original.General.Discord.WebhookURL);
  assert.equal(published.ShopItems.stone.Price, 20);
  const backup = JSON.parse(
    await readFile(join(hostRoot, 'shop-backups', map.id, `${publish.id}.json`), 'utf8'),
  );
  assert.equal(backup.ShopItems.stone.Price, 10);
  const stale = await prepare();
  assert.equal(stale.result.ready, true);
  await appendFile(configPath, '\n');
  const staleJobs = await api(
    '/management/actions',
    'POST',
    {
      scopeId,
      kind: 'shop-publish',
      reason: '核对预检后外部修改的处理',
      idempotencyKey: randomUUID(),
      revision: saved.revision,
      preflightId: stale.id,
    },
    201,
  );
  const staleTask = staleJobs.find(({ instanceId }) => instanceId === map.id);
  await finished(staleTask.id, 'failed');
  await finished(staleJobs.find(({ instanceId }) => instanceId === peer.id).id);
  assert.ok((await readFile(configPath, 'utf8')).endsWith('\n'));
  await api(
    `/instances/${peer.id}/commands`,
    'POST',
    { kind: 'delete', idempotencyKey: randomUUID() },
    201,
  );
  await waitFor(
    async () => !(await dashboard()).instances.some(({ id }) => id === peer.id),
    '移除验收用地图',
  );
  passed('商店发布自动读取两张地图、显示变更、拦截预检失败，保留凭据及备份，并保护预检后主机改动');
  const network = await api(
    '/connections',
    'POST',
    {
      name: '设备联调入口',
      controllerHostId: host.id,
      instanceId: map.id,
      peers: ['tcp://127.0.0.1:11010'],
      enabled: true,
    },
    201,
  );
  const invite = await api(
    `/connections/${network.id}/invites`,
    'POST',
    { name: '已绑定玩家', steamId, autoLaunch: false },
    201,
  );
  const response = await fetch(`${apiUrl}/api/connections/invites/${invite.id}/download`, {
    headers: { Authorization: `Bearer ${context.accessToken}` },
  });
  assert.equal(response.status, 200);
  const binaryPackage = Buffer.from(await response.arrayBuffer());
  const magic = Buffer.from('ARKCONNECT-V1-END');
  const size = binaryPackage.readInt32LE(binaryPackage.length - magic.length - 4);
  const bootstrap = JSON.parse(
    binaryPackage
      .subarray(
        binaryPackage.length - magic.length - 4 - size,
        binaryPackage.length - magic.length - 4,
      )
      .toString(),
  );
  assert.equal(bootstrap.steamId, steamId);
  const device = 'a'.repeat(64);
  const manifest = async (includeDevice = true) => {
    const result = await fetch(`${apiUrl}/api/connect/${invite.id}/manifest`, {
      headers: {
        'x-connect-key': bootstrap.inviteToken,
        ...(includeDevice ? { 'x-connect-device': device, 'x-connect-device-consent': 'v1' } : {}),
      },
    });
    return { status: result.status, body: await result.json() };
  };
  assert.equal((await manifest(false)).status, 403);
  const initial = await manifest();
  assert.equal(initial.status, 200);
  assert.equal(JSON.parse(Buffer.from(initial.body.data.payload, 'base64')).enabled, true);
  await agent('/management/presence', {
    samples: [
      {
        instanceId: map.id,
        sampledAt: new Date().toISOString(),
        source: 'bridge',
        players: [{ steamId, name: '设备玩家', ip: '127.0.0.1' }],
      },
    ],
  });
  await action('ban', { ips: ['127.0.0.1'] }).then(
    () => assert.fail('回环地址不能封禁'),
    () => undefined,
  );
  await finished((await action('ban', { devices: [device] })).id);
  const blocked = JSON.parse(Buffer.from((await manifest()).body.data.payload, 'base64'));
  assert.equal(blocked.deviceBlocked, true);
  assert.equal(blocked.enabled, false);
  const ban = (await scope()).bans.find((item) => !item.revokedAt);
  await finished((await action('unban', { banId: ban.id })).id);
  assert.equal(
    JSON.parse(Buffer.from((await manifest()).body.data.payload, 'base64')).enabled,
    true,
  );
  await api(`/connections/${network.id}`, 'DELETE');
  passed('绑定客户端凭据、无同意信息拒绝、设备封禁与解封的签名配置，回环 IP 封禁拒绝');
  const timeoutMarker = join(hostRoot, 'instances', map.id, 'ShooterGame/Saved/coins-timeout.txt');
  await writeFile(timeoutMarker, 'timeout after mutation');
  const unknown = await action('coins', { amount: 10 });
  await finished(unknown.id, 'uncertain');
  await api(
    '/management/actions',
    'POST',
    {
      scopeId,
      steamId,
      kind: 'coins',
      amount: 10,
      reason: '禁止盲目重发',
      idempotencyKey: randomUUID(),
    },
    400,
  );
  await rm(timeoutMarker);
  await new Promise((yes) => setTimeout(yes, 6000));
  await finished((await action('sync')).id);
  assert.equal((await scope()).players.find((player) => player.steamId === steamId).balance, 1110);
  assert.equal((await scope()).tasks.find((task) => task.id === unknown.id).status, 'uncertain');
  await api(
    '/management/actions',
    'POST',
    {
      scopeId,
      steamId,
      kind: 'coins',
      amount: 10,
      reason: '同步不解除未知结果锁',
      idempotencyKey: randomUUID(),
    },
    400,
  );
  await api(
    `/management/tasks/${unknown.id}/resolve`,
    'POST',
    { outcome: 'succeeded', evidence: '本地替身 points.txt 与命令日志确认已加十金币' },
    201,
  );
  passed('金币响应丢失保持未知，允许只读同步核对余额，但核实前仍禁止再次发币');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [path, title] of [
      ['players', '用户管理'],
      ['shop', '商店管理'],
    ]) {
      await page.goto(`${apiUrl}/${path}`);
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      const selector = page.getByRole('combobox').first();
      await selector.click();
      await page.getByRole('option', { name: map.clusterId, exact: true }).click();
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      await page
        .getByText(path === 'players' ? 'SteamID ' + steamId : '石头', { exact: true })
        .first()
        .waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({
        path: join(work, `${path}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  passed('用户与原生商店页面真实浏览器检查：1440px 桌面、390px 手机无横向溢出');
  await api(
    `/instances/${map.id}/commands`,
    'POST',
    { kind: 'stop', countdownSeconds: 0, idempotencyKey: randomUUID() },
    201,
  );
  await waitFor(
    async () =>
      (await dashboard()).instances.find((item) => item.id === map.id)?.status === 'stopped',
    '关闭经济测试地图',
    30000,
  );
  for (const item of [map, other, beta])
    await api(
      `/instances/${item.id}/commands`,
      'POST',
      { kind: 'delete', idempotencyKey: randomUUID() },
      201,
    );
  await waitFor(
    async () =>
      (await dashboard()).commands
        .filter(
          (item) => item.kind === 'delete' && [map.id, other.id, beta.id].includes(item.instanceId),
        )
        .every((item) => item.status === 'succeeded'),
    '经济测试地图清理',
    30000,
  );
}
