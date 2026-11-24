import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join, relative } from 'node:path';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function tcpPortFree(port) {
  const server = net.createServer();
  const free = await new Promise((yes) => {
    server.once('error', () => yes(false));
    server.listen(port, '127.0.0.1', () => yes(true));
  });
  if (free) await new Promise((yes) => server.close(yes));
  return free;
}
export async function verifyLifecycle(context) {
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
    agentConfig,
    hostToken,
    fakeMetrics,
    availablePort,
    waitFor,
    dashboard,
    passed,
  } = context;
  const directory = join(work, 'lifecycle');
  await mkdir(directory, { recursive: true });
  const hostName = (await dashboard()).hosts.find((item) => item.id === host.id).name;
  const mapState = async (id) => (await dashboard()).instances.find((item) => item.id === id);
  const commandDone = (id, expected = 'succeeded') =>
    waitFor(
      async () => {
        const item = (await dashboard()).commands.find((item) => item.id === id);
        if (item && ['failed', 'succeeded', 'cancelled'].includes(item.status)) {
          assert.equal(item.status, expected, item.error ?? item.progress);
          return item;
        }
      },
      `任务结束 ${id}`,
      120000,
    );
  async function enqueue(map, kind, expected = 'succeeded', payload = {}) {
    if (['start', 'restart'].includes(kind)) await fakeMetrics();
    const command = await api(
      `/instances/${map.id}/commands`,
      'POST',
      { kind, countdownSeconds: 0, idempotencyKey: randomUUID(), ...payload },
      201,
    );
    return commandDone(command.id, expected);
  }
  async function mapsPage() {
    await page.goto(`${apiUrl}/instances`);
    await page.getByRole('heading', { name: '地图管理', exact: true }).waitFor();
  }
  const card = (map) => page.getByRole('region', { name: `地图 ${map.name}`, exact: true });
  async function uiAction(map, label, during) {
    const button = card(map).getByRole('button', { name: label, exact: true });
    await waitFor(() => button.isEnabled(), `地图操作可用：${label}`);
    await button.click();
    const dialog = page.getByRole('dialog');
    const countdown = dialog.getByRole('spinbutton', { name: /倒计时/ });
    if (await countdown.count()) await countdown.fill('0');
    const response = page.waitForResponse(
      (item) =>
        item.url().endsWith(`/instances/${map.id}/commands`) && item.request().method() === 'POST',
    );
    if (['启动', '重启'].includes(label)) await fakeMetrics();
    await dialog.getByRole('button', { name: label, exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 201, await result.text());
    const command = (await result.json()).data;
    await dialog.waitFor({ state: 'hidden' });
    if (during) await during(command);
    return commandDone(command.id);
  }
  async function createMap(name, ports) {
    return api(
      '/instances',
      'POST',
      {
        hostId: host.id,
        name,
        map: 'TheIsland',
        serverFileSource: 'auto',
        ...ports,
        autoRestart: true,
      },
      201,
    );
  }
  async function connection(map) {
    const network = await api(
      '/connections',
      'POST',
      {
        name: `资源清理 ${map.name}`,
        controllerHostId: host.id,
        instanceId: map.id,
        peers: ['tcp://127.0.0.1:19999'],
        enabled: true,
      },
      201,
    );
    const invite = await api(
      `/connections/${network.id}/invites`,
      'POST',
      { name: '资源验证好友' },
      201,
    );
    const pid = await waitFor(async () => {
      const owned = JSON.parse(
        await readFile(join(hostRoot, 'connect/owned-processes.json'), 'utf8'),
      );
      return owned[network.id]?.pid;
    }, '地图联机进程已启动');
    return { network, invite, pid };
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fakeMetrics();
  await mapsPage();
  assert.equal(await card(instance).getByRole('button', { name: '重启', exact: true }).count(), 0);
  const startupDelay = join(
    hostRoot,
    'instances',
    instance.id,
    'ShooterGame/Saved/startup-delay.txt',
  );
  await writeFile(startupDelay, '30000');
  await uiAction(instance, '启动', async (command) => {
    const loading = await waitFor(async () => {
      const value = await mapState(instance.id);
      return value?.startup?.stage === 'loading' && value.startup.logs.length ? value : null;
    }, '持续启动反馈及日志');
    assert.equal(loading.status, 'starting');
    assert.equal(loading.startup.rconReady, false);
    assert.ok(loading.pid);
    await card(instance).getByRole('progressbar', { name: '地图启动检测中' }).waitFor();
    assert.equal(await card(instance).getByRole('progressbar').getAttribute('aria-valuenow'), null);
    await card(instance)
      .getByText(/已等待/)
      .waitFor();
    await card(instance).getByText('LOCAL VERIFICATION: loading map', { exact: false }).waitFor();
    await page.screenshot({ path: join(work, 'startup-maps-desktop.png'), fullPage: true });
    await page.goto(`${apiUrl}/instances/${instance.id}`);
    await page
      .getByRole('alert')
      .filter({ has: page.getByRole('progressbar') })
      .waitFor();
    await page.getByLabel('最近启动日志', { exact: true }).waitFor();
    await page.screenshot({ path: join(work, 'startup-detail-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(work, 'startup-detail-mobile.png'), fullPage: true });
    const updated = await waitFor(async () => {
      const state = await dashboard();
      const current = state.commands.find((item) => item.id === command.id);
      return current?.progress.includes('已等待') ? current : null;
    }, '持续上报等待时长和 RCON 结果');
    assert.match(updated.progress, /RCON/);
    passed('地图启动期间持续显示等待时长、进程和真实日志，桌面及 390px 手机无虚假百分比');
  });
  const ready = await waitFor(async () => {
    const value = await mapState(instance.id);
    return value?.status === 'running' && value.startup?.rconReady ? value : null;
  }, 'RCON 响应后确认地图启动成功');
  assert.equal(ready.startup.stage, 'ready');
  await page.getByText('启动检测通过', { exact: true }).waitFor();
  passed('RCON 实际响应后才确认启动检测通过，保留最终耗时与日志');
  await rm(startupDelay);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await mapsPage();
  const firstPid = await waitFor(async () => (await mapState(instance.id))?.pid, '地图进程启动');
  await uiAction(instance, '重启');
  const restartedPid = await waitFor(async () => {
    const value = await mapState(instance.id);
    return value?.status === 'running' && value.pid !== firstPid ? value.pid : null;
  }, '重启后产生新进程');
  assert.equal(alive(firstPid), false);
  passed('地图列表未启动显示启动，真实点击启动和重启，新进程替换并结束旧进程');
  await uiAction(instance, '关闭');
  await waitFor(async () => {
    const value = await mapState(instance.id);
    return (
      value?.status === 'stopped' &&
      value.pid === null &&
      value.memoryMb === 0 &&
      value.cpuPercent === 0
    );
  }, '关闭后清空资源上报');
  assert.equal(alive(restartedPid), false);
  assert.equal(await tcpPortFree(instance.rconPort), true);
  assert.equal((await mapState(instance.id)).desiredState, 'stopped');
  passed('关闭地图后释放真实 RCON 端口和进程，CPU/内存归零且关闭自动拉起意图');

  const crashMap = await createMap('启动失败诊断验收', {
    gamePort: await availablePort(),
    queryPort: await availablePort(),
    rconPort: await availablePort(),
  });
  await enqueue(crashMap, 'install');
  const crashSaved = join(hostRoot, 'instances', crashMap.id, 'ShooterGame/Saved');
  await mkdir(crashSaved, { recursive: true });
  await writeFile(join(crashSaved, 'startup-crash.txt'), 'yes');
  await writeFile(join(crashSaved, 'startup-delay.txt'), '2000');
  await waitFor(async () => (await mapState(crashMap.id))?.installed, '启动失败测试服务端文件可用');
  const failedStartup = await enqueue(crashMap, 'start', 'failed');
  assert.match(failedStartup.error, /退出码 42/);
  const crashed = await waitFor(async () => {
    const value = await mapState(crashMap.id);
    return value?.status === 'error' && value.startup?.stage === 'failed' ? value : null;
  }, '启动退出明确标记失败');
  assert.equal(crashed.pid, null);
  assert.equal(crashed.startup.rconReady, false);
  assert.match(crashed.startup.logs.join('\n'), /startup failed before RCON/);
  await mapsPage();
  await card(crashMap).getByText('启动检测失败', { exact: true }).waitFor();
  await page.screenshot({ path: join(work, 'startup-failed-desktop.png'), fullPage: true });
  await enqueue(crashMap, 'delete');
  passed('启动期间退出显示具体退出码与最后日志，状态为失败而非运行，释放资源后可删除');

  const retryMap = await createMap('安装失败重试验收', {
    branch: 'preaquatica',
    gamePort: await availablePort(),
    queryPort: await availablePort(),
    rconPort: await availablePort(),
  });
  const steamRoot = join(hostRoot, 'tools/steamcmd');
  await writeFile(join(steamRoot, 'missing-config.txt'), 'always');
  await enqueue(retryMap, 'install', 'failed');
  await waitFor(
    async () => (await mapState(retryMap.id))?.status === 'error',
    '未安装地图失败状态',
  );
  await mapsPage();
  await waitFor(
    () => card(retryMap).getByRole('button', { name: '重新安装', exact: true }).isEnabled(),
    '失败地图列表重新安装入口',
  );
  await page.goto(`${apiUrl}/instances/${retryMap.id}`);
  await page.getByRole('heading', { name: retryMap.name, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重新安装', exact: true }).isEnabled(), true);
  await writeFile(join(steamRoot, 'missing-config.txt'), 'once');
  await page.getByRole('button', { name: '重新安装', exact: true }).click();
  const retryResponse = page.waitForResponse(
    (item) =>
      item.url().endsWith(`/instances/${retryMap.id}/commands`) &&
      item.request().method() === 'POST',
  );
  await page.getByRole('dialog').getByRole('button', { name: '重新安装', exact: true }).click();
  const retried = (await (await retryResponse).json()).data;
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await commandDone(retried.id);
  await waitFor(
    async () => (await mapState(retryMap.id))?.lastError === null,
    '重新安装成功清除错误',
  );
  passed('未安装地图安装失败后，列表和详情均可重新安装，真实提交重试成功并清除错误');

  await fakeMetrics();
  await mapsPage();
  await uiAction(instance, '启动');
  const deletedPid = await waitFor(
    async () => (await mapState(instance.id))?.pid,
    '待删除地图进程',
  );
  const linked = await connection(instance);
  await api(
    '/schedules',
    'POST',
    {
      instanceId: instance.id,
      name: '删除清理验收',
      kind: 'backup',
      cron: '0 0 1 1 *',
      enabled: false,
      countdownSeconds: 0,
    },
    201,
  );
  const savedMarker = join(
    hostRoot,
    'instances',
    instance.id,
    'ShooterGame/Saved/lifecycle-preserve.txt',
  );
  await writeFile(savedMarker, '保留存档与邻近地图');
  const backupsBefore = (await dashboard()).backups.length;
  await page.screenshot({ path: join(work, 'lifecycle-maps-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(work, 'lifecycle-maps-mobile.png'), fullPage: true });
  const removed = await uiAction(instance, '删除地图');
  await waitFor(async () => !(await mapState(instance.id)), '后台移除地图记录');
  assert.equal(alive(deletedPid), false);
  await waitFor(() => !alive(linked.pid), '地图删除后释放联机进程');
  assert.equal(await stat(join(hostRoot, 'instances', instance.id)).catch(() => null), null);
  assert.ok(!relative(join(hostRoot, 'recycle'), removed.result.savedArchive).startsWith('..'));
  assert.equal(
    await readFile(join(removed.result.savedArchive, 'lifecycle-preserve.txt'), 'utf8'),
    '保留存档与邻近地图',
  );
  const state = await dashboard();
  for (const key of ['schedules', 'subscriptions', 'tribes'])
    assert.ok(state[key].every((item) => item.instanceId !== instance.id));
  assert.ok(state.backups.length >= backupsBefore);
  assert.equal(
    JSON.parse(await readFile(join(hostRoot, 'processes.json'), 'utf8'))[instance.id],
    undefined,
  );
  const connections = await api('/connections');
  assert.ok(connections.networks.every((item) => item.id !== linked.network.id));
  assert.ok(connections.invites.every((item) => item.id !== linked.invite.id));
  assert.ok(removed.result.retainedDirectory);
  assert.equal(
    (
      await stat(
        join(removed.result.retainedDirectory, 'ShooterGame/Binaries/Win64/ShooterGameServer.exe'),
      )
    ).isFile(),
    true,
  );
  passed('删除运行地图先停服，回收存档并保留下载文件，清理状态/订阅/计划和联机凭据，已有备份保留');
  const reused = await createMap('资源释放后复用端口', {
    gamePort: instance.gamePort,
    queryPort: instance.queryPort,
    rconPort: instance.rconPort,
  });
  await enqueue(reused, 'install');
  await waitFor(async () => (await mapState(reused.id))?.installed, '新地图识别服务端');
  await fakeMetrics();
  await mapsPage();
  await uiAction(reused, '启动');
  passed('删除后原游戏/查询/RCON 端口可重新分配，替代地图真实进程成功启动');

  const disconnectedPid = await waitFor(
    async () => (await mapState(reused.id))?.pid,
    '待断开主机地图进程',
  );
  const hostConnection = await connection(reused);
  const pendingRestart = await api(
    `/instances/${reused.id}/commands`,
    'POST',
    { kind: 'restart', countdownSeconds: 60, idempotencyKey: randomUUID() },
    201,
  );
  await waitFor(
    async () =>
      (await dashboard()).commands
        .find((item) => item.id === pendingRestart.id)
        ?.progress.includes('倒计时'),
    '断开前存在本机倒计时任务',
  );
  const oldCode = (await api(`/hosts/${host.id}/enrollment`, 'POST', undefined, 201)).code;
  const defaultBot = state.bots.find((item) => item.isDefault) ?? state.bots[0];
  const finalGroup = state.groups.find((item) => item.botId === defaultBot.id);
  await api(
    '/subscriptions',
    'POST',
    {
      customer: '关闭日志验收',
      instanceId: reused.id,
      tribeId: '789',
      tribeName: '断开部落',
      botId: defaultBot.id,
      botMode: 'default',
      groupId: finalGroup.id,
    },
    201,
  );
  await writeFile(
    join(hostRoot, 'instances', reused.id, 'ShooterGame/Saved/emit-final-event.txt'),
    'Tribe 断开部落, ID 789: 关闭前最后一条部落日志\n',
  );
  await page.goto(`${apiUrl}/hosts`);
  const hostCard = page.getByRole('region', { name: `主机 ${hostName}`, exact: true });
  await hostCard.waitFor();
  assert.equal(
    await hostCard.getByRole('button', { name: '删除主机', exact: true }).isEnabled(),
    false,
  );
  await api(`/hosts/${host.id}`, 'DELETE', undefined, 400);
  await hostCard.getByRole('button', { name: '断开主机', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await waitFor(
    async () =>
      (await dashboard()).hosts.find((item) => item.id === host.id)?.status === 'disconnected',
    '主机完成资源清理后断开',
    120000,
  );
  await commandDone(pendingRestart.id, 'cancelled');
  assert.ok(
    (await dashboard()).events.some(
      (item) => item.instanceId === reused.id && item.text === '关闭前最后一条部落日志',
    ),
  );
  assert.equal(alive(disconnectedPid), false);
  assert.equal(alive(hostConnection.pid), false);
  assert.equal(await tcpPortFree(reused.rconPort), true);
  for (const map of (await dashboard()).instances.filter((item) => item.hostId === host.id)) {
    assert.equal(map.status, 'stopped');
    assert.equal(map.pid, null);
    assert.equal(map.memoryMb, 0);
  }
  await api('/agent/poll', 'GET', undefined, 401, hostToken);
  await api(
    '/agent/enroll',
    'POST',
    { code: oldCode, platform: 'windows', agentVersion: '1.0.0' },
    401,
  );
  await waitFor(async () => (await hostCard.innerText()).includes('已断开'), '断开界面状态');
  await page.screenshot({ path: join(work, 'lifecycle-hosts-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(work, 'lifecycle-hosts-desktop.png'), fullPage: true });
  passed('主机断开取消倒计时并关闭全部地图/联机进程，释放端口、撤销旧令牌及接入码，配置存档保留');
  const code = (await api(`/hosts/${host.id}/enrollment`, 'POST', undefined, 201)).code;
  const enrollment = await api(
    '/agent/enroll',
    'POST',
    { code, platform: 'windows', agentVersion: '1.0.0' },
    201,
  );
  await writeFile(
    agentConfig,
    JSON.stringify({ apiUrl, hostId: host.id, token: enrollment.token, root: hostRoot }),
  );
  const reconnectedAgent = launch(
    process.execPath,
    [join(root, 'apps/agent/dist/main.js'), '--config', agentConfig],
    { cwd: root, label: 'reconnected-agent' },
  );
  await waitFor(
    async () => (await dashboard()).hosts.find((item) => item.id === host.id)?.metrics,
    '重新接入后助手心跳',
  );
  await mapsPage();
  for (const map of (await dashboard()).instances.filter((item) => item.hostId === host.id))
    await uiAction(map, '删除地图');
  await page.goto(`${apiUrl}/hosts`);
  await hostCard.getByRole('button', { name: '断开主机', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await waitFor(
    async () =>
      (await dashboard()).hosts.find((item) => item.id === host.id)?.status === 'disconnected',
    '空主机断开',
  );
  await waitFor(() => reconnectedAgent.exitCode !== null, '助手正常退出');
  await waitFor(
    () => hostCard.getByRole('button', { name: '删除主机', exact: true }).isEnabled(),
    '删除空主机入口',
  );
  await hostCard.getByRole('button', { name: '删除主机', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await waitFor(
    async () => !(await dashboard()).hosts.some((item) => item.id === host.id),
    '删除主机记录',
  );
  await api('/agent/poll', 'GET', undefined, 401, `${host.id}.${enrollment.token}`);
  passed('重新接入主机后可继续管理原地图，清理旗下地图后通过界面断开并删除主机及凭据');
  const pendingHost = await api('/hosts', 'POST', { name: '迟到心跳验收' }, 201);
  const pendingEnrollment = await api(
    '/agent/enroll',
    'POST',
    { code: pendingHost.code, platform: 'windows', agentVersion: '1.0.0' },
    201,
  );
  const pendingToken = `${pendingHost.id}.${pendingEnrollment.token}`;
  await api(`/hosts/${pendingHost.id}/disconnect`, 'POST', undefined, 201);
  assert.equal(
    (await api('/agent/poll', 'GET', undefined, 200, pendingToken)).disconnectRequested,
    true,
  );
  await api(
    '/agent/heartbeat',
    'POST',
    {
      metrics: {
        cpuPercent: 0,
        cpuCores: 8,
        cpuModel: 'Verification',
        totalMemoryMb: 32768,
        freeMemoryMb: 30000,
        diskFreeGb: 100,
        diskTotalGb: 200,
        sampledAt: new Date().toISOString(),
      },
      instances: [],
      runningCommands: [],
      console: [],
      connections: [],
    },
    201,
    pendingToken,
  );
  assert.equal(
    (await dashboard()).hosts.find((item) => item.id === pendingHost.id).status,
    'disconnecting',
  );
  await api('/agent/disconnect', 'POST', { instances: [], error: null }, 201, pendingToken);
  await api('/agent/poll', 'GET', undefined, 401, pendingToken);
  await api(`/hosts/${pendingHost.id}`, 'DELETE');
  passed('断开中的迟到心跳不会恢复在线，助手确认释放资源后旧凭据失效');
}
