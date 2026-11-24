import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyIndependentShop(context) {
  const {
    api,
    apiUrl,
    agent,
    dashboard,
    fakeMetrics,
    hostRoot,
    instance,
    page,
    passed,
    useShopBridgeFixture,
    waitFor,
  } = context;
  const scopeId = `instance:${instance.id}`;
  const steamId = '76561198000000001';
  const target = `/management/shop/${instance.id}`;
  const state = () => api(`/management?${new URLSearchParams({ scopeId })}`);
  const orders = () => api(`/management/shop/orders?${new URLSearchParams({ scopeId })}`);
  const mapState = async () => (await dashboard()).instances.find(({ id }) => id === instance.id);
  const balance = async () =>
    (await state()).players.find((player) => player.steamId === steamId)?.balance;
  const ask = (kind, values = {}) => ({
    id: randomUUID(),
    kind,
    steamId,
    createdAt: Date.now(),
    ...values,
  });

  await page.setViewportSize({ width: 390, height: 850 });
  await page.goto(`${apiUrl}/instances/${instance.id}`);
  await page.getByRole('tab', { name: '模组', exact: true }).click();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const catalog = dialog.getByRole('combobox', { name: '常用模组' });
  await catalog.click();
  await page.getByRole('option', { name: /Structures Plus/ }).click();
  await page.getByRole('option', { name: /Awesome SpyGlass/ }).click();
  await page.keyboard.press('Escape');
  await dialog.getByLabel('手动输入 Workshop ID').fill('not-an-id');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.getByText('模组 ID 必须是 1～20 位数字。').waitFor();
  await dialog.getByLabel('手动输入 Workshop ID').fill('987654321，731604991');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await dialog.getByRole('button', { name: '上移 987654321' }).click();
  await dialog.getByRole('button', { name: '上移 987654321' }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual((await mapState()).config.modIds, ['987654321', '731604991', '1404697612']);
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await dialog.getByRole('button', { name: '移除 987654321' }).waitFor();
  await catalog.click();
  assert.equal(
    await page.getByRole('option', { name: /Structures Plus/ }).getAttribute('aria-selected'),
    'true',
  );
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: '取消' }).click();
  passed('地图模组：移动端多选、手输校验、去重、加载顺序和重新打开回填');

  assert.equal((await state()).shopMode, 'arkshop');
  await page.goto(`${apiUrl}/shop`);
  await page.getByRole('combobox', { name: '商店模式' }).click();
  await page.getByRole('option', { name: '独立商店', exact: true }).click();
  await dialog.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByRole('button', { name: '新增商品' }).click();
  await dialog.getByLabel('商品编号').fill('stone');
  await dialog.getByLabel('商品名称').fill('石头测试商品');
  await dialog.getByLabel('VIP 售价（金币）').fill('75');
  await dialog.getByLabel('每人累计限购（份）').fill('2');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('石头测试商品', { exact: true }).waitFor();
  assert.equal((await state()).independentCatalog.products[0].vipPrice, 75);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await api('/management/shop', 'POST', { scopeId, revision: 0, config: {} }, 409);
  await api('/management/players', 'POST', { scopeId, steamId, name: '测试买家' }, 201);
  const coins = {
    scopeId,
    steamId,
    kind: 'coins',
    amount: 500,
    reason: '联调发放',
    idempotencyKey: randomUUID(),
  };
  const [original] = await api('/management/actions', 'POST', coins, 201);
  const [duplicate] = await api('/management/actions', 'POST', coins, 201);
  assert.equal(original.status, 'succeeded');
  assert.equal(duplicate.id, original.id);
  assert.equal(await balance(), 500);
  await api(
    '/management/actions',
    'POST',
    {
      scopeId,
      steamId,
      kind: 'vip-grant',
      group: 'VIP',
      hours: 12,
      reason: '联调发放',
      idempotencyKey: randomUUID(),
    },
    201,
  );
  assert.equal(
    (await state()).players.find((player) => player.steamId === steamId).vip[0].group,
    'VIP',
  );
  passed('商店模式切换与商品表单：ArkShop 互斥，离线金币和限时 VIP 可发放');

  const mapRoot = join(hostRoot, 'instances', instance.id, 'ShooterGame');
  const bin = join(mapRoot, 'Binaries', 'Win64');
  const stock = join(bin, 'ArkApi', 'Plugins', 'ArkShop');
  await mkdir(stock, { recursive: true });
  await writeFile(join(stock, 'ArkShop.dll'), 'test fixture');
  await fakeMetrics();
  const blocked = await api(
    `/instances/${instance.id}/commands`,
    'POST',
    { kind: 'start', idempotencyKey: randomUUID() },
    201,
  );
  const failure = await waitFor(async () => {
    const result = (await dashboard()).commands.find(({ id }) => id === blocked.id);
    return result?.status === 'failed' ? result : null;
  }, '检测互斥插件的启动失败');
  assert.match(failure.error, /仍安装了 ArkShop/);
  await unlink(join(stock, 'ArkShop.dll'));
  const queue = join(mapRoot, 'Saved', 'ArkControlShop');
  await mkdir(queue, { recursive: true });
  await useShopBridgeFixture();
  const heartbeat = (status) =>
    fakeMetrics([
      {
        id: instance.id,
        installed: true,
        status,
        cpuPercent: 0,
        memoryMb: 0,
        pid: null,
        startedAt: null,
        lastError: null,
        buildId: null,
      },
    ]);
  await heartbeat('running');
  await api('/management/shop/mode', 'POST', { scopeId, mode: 'arkshop' }, 409);

  const writeRecord = async (name, record) => {
    const path = join(queue, `${record.id}.${name}.json`);
    await writeFile(`${path}.tmp`, JSON.stringify(record));
    await rename(`${path}.tmp`, path);
  };
  const game = async (request) => {
    await writeRecord('request', request);
    const path = join(queue, `${request.id}.reply.json`);
    const reply = await waitFor(async () => {
      const reply = JSON.parse(await readFile(path, 'utf8'));
      const requestFile = join(queue, `${request.id}.request.json`);
      const pending = await readFile(requestFile, 'utf8').then(
        () => true,
        (error) => {
          if (error.code !== 'ENOENT') throw error;
          return false;
        },
      );
      return pending ? null : reply;
    }, `独立商店回包 ${request.kind}`);
    await unlink(path);
    return reply;
  };
  const buy = (quantity) => ask('buy', { productId: 'stone', quantity });
  const report = (request, outcome) =>
    writeRecord('receipt', { id: request.id, steamId, outcome, reason: '游戏桥接测试回执' });
  await game(ask('shop', { page: 1 })).then((reply) =>
    assert.match(reply.lines.join('\n'), /石头测试商品 · 75 金币/),
  );
  await game(ask('points')).then((reply) => assert.match(reply.lines[0], /500 金币/));
  const order = buy(2);
  assert.equal((await game(order)).quantity, 2);
  assert.equal((await game(order)).quantity, 2);
  assert.equal(await balance(), 350);
  assert.match((await game(buy(1))).lines[0], /限购/);
  await report(order, 'failed');
  await waitFor(async () => (await balance()) === 500, '未发货自动退币');
  await agent(`${target}/receipt`, { id: order.id, steamId, outcome: 'failed' });
  assert.equal(await balance(), 500);
  const delivered = buy(1);
  assert.ok((await game(delivered)).delivery);
  await report(delivered, 'delivered');
  await waitFor(
    async () =>
      (await orders()).entries.some((row) => row.id === delivered.id && row.status === 'delivered'),
    '游戏回执记为发货',
  );
  const unknown = buy(1);
  assert.ok((await game(unknown)).delivery);
  await report(unknown, 'uncertain');
  await waitFor(
    async () =>
      (await orders()).entries.some((row) => row.id === unknown.id && row.status === 'uncertain'),
    '不确定订单待核实',
  );
  await page.getByRole('button', { name: '独立商店订单', exact: true }).click();
  await page.getByRole('button', { name: '核实结果', exact: true }).click();
  await dialog.getByRole('combobox', { name: '核实结果' }).click();
  await page.getByRole('option', { name: '确认完全未发货并退币', exact: true }).click();
  await dialog.getByLabel('核实依据').fill('游戏桥接测试确认未发货');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await balance(), 425);
  passed(
    '独立商店真实 API / MySQL / Agent 链路：VIP 价、重复请求、限购、明确失败退币、未知回执人工核实',
  );

  await heartbeat('stopped');
  await api('/management/shop/mode', 'POST', { scopeId, mode: 'arkshop' }, 201);
  assert.equal(await balance(), null);
  assert.equal((await orders()).entries.length, 3);
  passed('停止地图后切回 ArkShop，独立订单仍可查，两种余额分开保存');
}
