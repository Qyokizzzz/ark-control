import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyNavigationStartup({
  page,
  apiUrl,
  api,
  agent,
  hostToken,
  instance,
  dashboard,
  fakeMetrics,
  waitFor,
  passed,
}) {
  const state = async () => (await dashboard()).instances.find(({ id }) => id === instance.id);
  const task = async (id) => (await dashboard()).commands.find((command) => command.id === id);
  const submit = (kind, extra = {}, status = 201) =>
    api(
      `/instances/${instance.id}/commands`,
      'POST',
      {
        kind,
        countdownSeconds: 0,
        idempotencyKey: randomUUID(),
        ...extra,
      },
      status,
    );
  const heartbeat = (status, pid = null) =>
    fakeMetrics([
      {
        id: instance.id,
        status,
        installed: true,
        pid,
        startedAt: pid ? new Date().toISOString() : null,
        cpuPercent: 0,
        memoryMb: pid ? 3500 : 0,
        lastError: null,
        buildId: null,
      },
    ]);
  const termination = async () =>
    (await dashboard()).commands.find(
      ({ instanceId, payload, status }) =>
        instanceId === instance.id && payload.terminateStartup === true && status === 'queued',
    );
  const complete = async (id) => {
    await api(`/agent/commands/${id}/ack`, 'POST', { status: 'succeeded' }, 409, hostToken);
    await agent(`/commands/${id}/ack`, { status: 'succeeded', result: { stopped: true } });
    const map = await state();
    assert.equal(map.status, 'stopped');
    assert.equal(map.desiredState, 'stopped');
    assert.equal(map.pid, null);
    assert.equal(map.memoryMb, 0);
  };
  const confirmTerminate = async () => {
    await page.getByRole('button', { name: '终止启动', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '终止启动', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '正在终止启动', exact: true }).waitFor();
  };

  await heartbeat('stopped');
  const queued = await submit('start');
  await page.goto(`${apiUrl}/instances`);
  await confirmTerminate();
  const queuedStop = await termination();
  assert.equal((await task(queued.id)).status, 'cancelled');
  assert.ok((await task(queued.id)).completedAt);
  assert.equal((await agent('/poll')).commands[0].id, queuedStop.id);
  await complete(queuedStop.id);
  passed('地图列表在启动任务排队时可终止，助手仅领取终止任务');

  const loading = await submit('start');
  assert.equal((await agent('/poll')).commands[0].id, loading.id);
  await agent(`/commands/${loading.id}/ack`, { status: 'executing' });
  await heartbeat('starting', 12345);
  await page.goto(`${apiUrl}/instances/${instance.id}`);
  await confirmTerminate();
  const loadingStop = await termination();
  assert.equal((await task(loading.id)).status, 'cancelling');
  const poll = await agent('/poll');
  assert.deepEqual(poll.cancellations, [loading.id]);
  assert.deepEqual(poll.commands, []);
  await agent(`/commands/${loading.id}/ack`, { status: 'cancelled' });
  assert.equal((await agent('/poll')).commands[0].id, loadingStop.id);
  await complete(loadingStop.id);
  passed('详情可终止加载中的地图，助手先中断启动任务，进程退出回执后立即释放 PID 和资源状态');

  await heartbeat('running', 12345);
  const restart = await submit('restart');
  assert.equal((await agent('/poll')).commands[0].id, restart.id);
  await agent(`/commands/${restart.id}/ack`, { status: 'executing' });
  assert.equal((await agent(`/commands/${restart.id}/commit-stop`, {})).cancelled, false);
  await submit('force-stop', { terminateStartup: true }, 409);
  await heartbeat('starting', 23456);
  const restartStop = await submit('force-stop', { terminateStartup: true });
  assert.deepEqual((await agent('/poll')).cancellations, [restart.id]);
  await agent(`/commands/${restart.id}/ack`, { status: 'cancelled' });
  assert.equal((await agent('/poll')).commands[0].id, restartStop.id);
  await complete(restartStop.id);
  passed('重启提交保存时保持正常停服流程，下一轮加载可终止');

  await page.goto(`${apiUrl}/shop`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const scope = page.getByRole('combobox', { name: '互通组 / 独立服' });
    const mode = page.getByRole('combobox', { name: '商店模式' });
    const hint = page.getByText('同一互通组共享用户和经济', { exact: true });
    const orders = page.getByRole('button', { name: '独立商店订单', exact: true });
    await orders.waitFor();
    assert.ok(Math.abs((await scope.boundingBox()).width - (await mode.boundingBox()).width) <= 1);
    assert.ok(Math.abs((await hint.boundingBox()).width - (await orders.boundingBox()).width) <= 1);
    assert.equal(await page.getByText(/独立服各自管理/).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  passed('商店页在 1440px 和 390px 下两个 Select 等宽，订单按钮与提示对齐');

  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole('list', { name: '目录' });
  const firstPath = () => nav.getByRole('link').first().getAttribute('href');
  const grip = (label) => nav.getByRole('button', { name: `拖动排序 ${label}` });
  await nav.waitFor();
  assert.equal(await firstPath(), '/');
  const top = await grip('总览').boundingBox();
  const shop = await grip('商店管理').boundingBox();
  const x = shop.x + shop.width / 2;
  await page.mouse.move(x, shop.y + shop.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, top.y + top.height / 2, { steps: 12 });
  await page.mouse.up();
  await waitFor(async () => (await firstPath()) === '/shop', '鼠标把商店目录拖到第一位');
  assert.equal(new URL(page.url()).pathname, '/shop');
  await page.reload();
  await nav.waitFor();
  assert.equal(await firstPath(), '/shop');
  await grip('总览').focus();
  await page.keyboard.press('ArrowUp');
  await waitFor(async () => (await firstPath()) === '/', '键盘将总览移回第一位');

  await page.setViewportSize({ width: 390, height: 850 });
  await page.getByRole('button', { name: '打开导航' }).click();
  await nav.waitFor();
  const mobileTop = await grip('总览').boundingBox();
  const mobileShop = await grip('商店管理').boundingBox();
  const session = await page.context().newCDPSession(page);
  const touch = (type, box) =>
    session.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: box
        ? [{ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }]
        : [],
    });
  await touch('touchStart', mobileShop);
  await touch('touchMove', mobileTop);
  await touch('touchEnd');
  await waitFor(async () => (await firstPath()) === '/shop', '手机导航触控拖拽');
  await session.detach();
  passed('侧栏总览默认首位，鼠标、键盘、触屏可排序，刷新保留选择');
}
