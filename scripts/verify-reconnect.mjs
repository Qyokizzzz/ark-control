import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyReconnect(context) {
  const {
    api,
    apiUrl,
    page,
    root,
    work,
    launch,
    connection,
    availablePort,
    waitFor,
    dashboard,
    passed,
    restartApi,
  } = context;
  const directory = join(work, 'reconnect');
  await mkdir(directory, { recursive: true });
  const stateOf = async (id) => (await dashboard()).hosts.find((item) => item.id === id);
  const newMap = async (hostId, name) =>
    api(
      '/instances',
      'POST',
      {
        hostId,
        name,
        map: 'TheIsland',
        gamePort: await availablePort(),
        queryPort: await availablePort(),
        rconPort: await availablePort(),
      },
      201,
    );
  async function deleteThroughUi(map) {
    await page.goto(`${apiUrl}/instances`);
    const region = page.getByRole('region', { name: `地图 ${map.name}`, exact: true });
    await region.waitFor();
    assert.equal(
      await region.getByRole('button', { name: '删除地图', exact: true }).isEnabled(),
      true,
    );
    await region.getByRole('button', { name: '删除地图', exact: true }).click();
    const response = page.waitForResponse(
      (item) =>
        item.url().endsWith(`/instances/${map.id}/commands`) && item.request().method() === 'POST',
    );
    await page.getByRole('dialog').getByRole('button', { name: '删除地图', exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 201, await result.text());
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await waitFor(
      async () => !(await dashboard()).instances.some((item) => item.id === map.id),
      '未运行地图立即移除',
    );
    return (await result.json()).data;
  }
  const emptyHost = await api('/hosts', 'POST', { name: '未接入删除验收' }, 201);
  const emptyMap = await newMap(emptyHost.id, '从未安装直接删除');
  const emptyCommand = await deleteThroughUi(emptyMap);
  assert.equal(emptyCommand.status, 'succeeded');
  assert.equal((await stateOf(emptyHost.id)).pendingCleanups, 0);
  const repeated = await api(
    `/instances/${emptyMap.id}/commands`,
    'POST',
    { kind: 'delete', idempotencyKey: emptyCommand.idempotencyKey },
    201,
  );
  assert.equal(repeated.id, emptyCommand.id);
  await api(`/hosts/${emptyHost.id}`, 'DELETE');
  passed('未接入主机上的未安装地图可在浏览器直接删除，无清理任务且重复请求幂等');

  const hostName = '助手重连验收';
  const host = await api('/hosts', 'POST', { name: hostName }, 201);
  const enrolled = await api(
    '/agent/enroll',
    'POST',
    { code: host.code, platform: 'windows', agentVersion: '1.0.0' },
    201,
  );
  const oldToken = `${host.id}.${enrolled.token}`;
  const map = await newMap(host.id, '离线地图直接删除');
  const hostRoot = join(directory, 'game-data');
  const saved = join(hostRoot, 'instances', map.id, 'ShooterGame/Saved');
  await mkdir(saved, { recursive: true });
  await writeFile(join(saved, 'world.ark'), 'offline-world');
  const executable = join(
    hostRoot,
    'instances',
    map.id,
    'ShooterGame/Binaries/Win64/ShooterGameServer.exe',
  );
  await mkdir(join(hostRoot, 'instances', map.id, 'ShooterGame/Binaries/Win64'), {
    recursive: true,
  });
  await writeFile(executable, 'unstarted fixture');
  const metrics = {
    cpuPercent: 0,
    cpuCores: 8,
    cpuModel: 'Verification',
    totalMemoryMb: 32768,
    freeMemoryMb: 20000,
    diskFreeGb: 100,
    diskTotalGb: 200,
    sampledAt: new Date().toISOString(),
  };
  await api(
    '/agent/heartbeat',
    'POST',
    {
      metrics,
      instances: [
        {
          id: map.id,
          status: 'stopped',
          installed: true,
          cpuPercent: 0,
          memoryMb: 0,
          pid: null,
          startedAt: null,
          lastError: null,
          buildId: null,
        },
      ],
      runningCommands: [],
      console: [],
    },
    201,
    oldToken,
  );
  await connection.execute(
    "UPDATE resources SET body=JSON_SET(body,'$.lastSeenAt',?,'$.status','offline') WHERE kind='hosts' AND id=?",
    [new Date(Date.now() - 60000).toISOString(), host.id],
  );
  const cleanupCommand = await deleteThroughUi(map);
  assert.equal(cleanupCommand.status, 'queued');
  assert.equal((await stateOf(host.id)).pendingCleanups, 1);
  assert.equal(await readFile(join(saved, 'world.ark'), 'utf8'), 'offline-world');
  assert.ok(!JSON.stringify(await dashboard()).includes('rconPassword'));
  await api(`/hosts/${host.id}`, 'DELETE', undefined, 400);
  passed('离线但已安装的未运行地图立即移除，存档先保留并显示待清理状态，防止提前删除主机');
  await api(`/hosts/${host.id}/disconnect`, 'POST', undefined, 201);
  await page.goto(`${apiUrl}/hosts`);
  const hostCard = page.getByRole('region', { name: `主机 ${hostName}`, exact: true });
  await hostCard.waitFor();
  await hostCard.getByRole('button', { name: '重新连接', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const commandText = await dialog.locator('pre').innerText();
  assert.ok(!commandText.includes('--root'));
  const code = commandText.match(/--code "([^"]+)"/)[1];
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.notEqual((await stateOf(host.id)).status, 'disconnecting');

  let failPolls = 1;
  const upstreamFailures = [];
  const proxy = createServer(async (request, response) => {
    try {
      if (request.url === '/api/agent/poll' && failPolls > 0) {
        failPolls--;
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            code: 'INTERNAL_ERROR',
            message: '服务处理失败，请稍后重试或查看运行日志。',
            requestId: 'reconnect-test-500',
          }),
        );
        return;
      }
      const bytes = [];
      for await (const chunk of request) bytes.push(chunk);
      const body = Buffer.concat(bytes);
      const upstream = await fetch(`${apiUrl}${request.url}`, {
        method: request.method,
        headers: {
          ...(request.headers.authorization
            ? { Authorization: request.headers.authorization }
            : {}),
          'content-type': 'application/json',
          ...(request.headers['x-ark-agent-features']
            ? { 'x-ark-agent-features': request.headers['x-ark-agent-features'] }
            : {}),
        },
        ...(body.length ? { body } : {}),
      });
      const result = Buffer.from(await upstream.arrayBuffer());
      if (upstream.status >= 500)
        upstreamFailures.push({ path: request.url, status: upstream.status });
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(result);
    } catch {
      response.writeHead(502);
      response.end();
    }
  });
  await new Promise((yes, no) => {
    proxy.once('error', no);
    proxy.listen(0, '127.0.0.2', yes);
  });
  const proxyUrl = `http://127.0.0.2:${proxy.address().port}`;
  const workspace = join(directory, 'workspace');
  const entry = join(workspace, 'apps/agent/dist/main.js');
  await mkdir(join(workspace, 'apps/agent/dist'), { recursive: true });
  await copyFile(join(root, 'apps/agent/dist/main.js'), entry);
  await writeFile(
    join(workspace, 'apps/agent/package.json'),
    JSON.stringify({ name: '@ark-control/agent', private: true }),
  );
  await symlink(
    join(root, 'apps/agent/node_modules'),
    join(workspace, 'apps/agent/node_modules'),
    'junction',
  );
  const legacy = join(workspace, 'apps/agent/.data/agent/config.json');
  await mkdir(join(workspace, 'apps/agent/.data/agent'), { recursive: true });
  await writeFile(
    legacy,
    JSON.stringify({
      apiUrl: proxyUrl,
      hostId: host.id,
      token: enrolled.token,
      root: hostRoot,
      clusterRoot: join(directory, 'cluster'),
    }),
  );
  const canonical = join(workspace, '.data/agent/config.json');
  let agent,
    output = '';
  const startAgent = (args, cwd) => {
    const environment = { ...process.env };
    delete environment.ARK_AGENT_CONFIG;
    const child = launch(process.execPath, [entry, ...args], {
      cwd,
      label: 'reconnect-agent',
      env: environment,
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
    return child;
  };
  try {
    agent = startAgent(['--enroll', proxyUrl, '--code', code], join(workspace, 'apps/agent'));
    await waitFor(
      async () => {
        const state = await dashboard();
        return (
          state.commands.some(
            (item) =>
              item.instanceId === map.id && item.kind === 'delete' && item.status === 'succeeded',
          ) && state.hosts.find((item) => item.id === host.id)?.pendingCleanups === 0
        );
      },
      '重连接收待清理文件任务',
      45000,
    );
    const config = JSON.parse(await readFile(canonical, 'utf8'));
    assert.equal(config.root, hostRoot);
    assert.equal(config.allowHttp, true);
    assert.equal(config.clusterRoot, join(directory, 'cluster'));
    assert.ok(output.includes('reconnect-test-500'));
    assert.ok(output.includes('/api/agent/poll'));
    assert.equal(await stat(join(hostRoot, 'instances', map.id)).catch(() => null), null);
    const cleaned = (await dashboard()).commands.find(
      (item) => item.instanceId === map.id && item.status === 'succeeded',
    );
    assert.equal(
      await readFile(join(cleaned.result.savedArchive, 'world.ark'), 'utf8'),
      'offline-world',
    );
    passed('重新连接可取消卡住的断开请求，迁移旧配置并保留目录与 HTTP 授权，自动完成存档回收');
    const exited = new Promise((yes) => agent.once('exit', yes));
    agent.kill();
    await exited;
    output = '';
    failPolls = 2;
    agent = startAgent([], directory);
    await waitFor(() => output.includes('主机连接成功'), '不同工作目录直接重启并自动重连', 30000);
    assert.equal(JSON.parse(await readFile(canonical, 'utf8')).token, config.token);
    assert.ok(output.includes('reconnect-test-500'));
    passed('助手更换启动目录后仍沿用配置，临时 500 恢复后自动连接，无需重复授权 HTTP');

    const badMap = await newMap(host.id, '凭据异常仍可管理');
    await connection.execute(
      "UPDATE resources SET body=JSON_SET(body,'$.rconPassword','invalid-cipher') WHERE kind='instance-credentials' AND id=?",
      [badMap.id],
    );
    const network = await api(
      '/connections',
      'POST',
      {
        name: '异常密钥隔离',
        controllerHostId: host.id,
        instanceId: badMap.id,
        peers: ['tcp://127.0.0.1:19999'],
        enabled: true,
      },
      201,
    );
    await connection.execute(
      "UPDATE resources SET body=JSON_SET(body,'$.secret','invalid-cipher') WHERE kind='connection-credentials' AND id=?",
      [network.id],
    );
    await waitFor(
      async () => {
        const value = await stateOf(host.id);
        return value?.status === 'online' && value.agentWarnings?.length >= 2;
      },
      '坏凭据不阻断主机心跳',
      30000,
    );
    const warningState = await dashboard();
    assert.match(
      warningState.instances.find((item) => item.id === badMap.id).lastError,
      /管理凭据/,
    );
    await deleteThroughUi(badMap);
    await waitFor(
      async () => !(await stateOf(host.id)).agentWarnings?.length,
      '移除问题地图后清除告警',
    );
    assert.deepEqual(upstreamFailures, []);
    passed('损坏的地图和联机密钥只产生明确告警，主机保持在线，问题地图仍可直接删除');

    const [sample] = await connection.query(
      "SELECT workspace_id,id,body FROM resources WHERE kind='audit' ORDER BY updated_at DESC LIMIT 1",
    );
    assert.equal(sample.length, 1);
    await connection.query('ALTER TABLE resources DROP INDEX idx_workspace_state');
    await connection.query('ALTER TABLE resources DROP COLUMN state');
    const failed = await fetch(`${proxyUrl}/api/agent/poll`, {
      headers: { Authorization: `${'Bearer '}${host.id}.${config.token}` },
    });
    assert.equal(failed.status, 500);
    const failure = await failed.json();
    const logPath = join(work, 'api-data/logs/api-errors.log');
    const log = await waitFor(async () => {
      const text = await readFile(logPath, 'utf8');
      return text.includes(failure.requestId) ? text : null;
    }, '后台记录真实 500 原因');
    assert.match(log, /ER_BAD_FIELD_ERROR/);
    assert.ok(!log.includes(config.token));
    const repairedAt = Date.now();
    await restartApi();
    await waitFor(
      async () => Date.parse((await stateOf(host.id))?.lastSeenAt ?? '') >= repairedAt,
      '补齐旧数据库字段后助手恢复连接',
      30000,
    );
    const [rows] = await connection.execute(
      "SELECT body FROM resources WHERE workspace_id=? AND kind='audit' AND id=?",
      [sample[0].workspace_id, sample[0].id],
    );
    assert.deepEqual(rows[0].body, sample[0].body);
    passed('复现旧数据库缺字段导致 500，错误日志可定位 SQL 原因，升级补齐字段后同一助手自动恢复');
    await api(`/hosts/${host.id}/disconnect`, 'POST', undefined, 201);
    await waitFor(
      async () => (await stateOf(host.id))?.status === 'disconnected',
      '重连验证主机正常断开',
    );
    await waitFor(() => agent.exitCode !== null, '重连验证助手退出');
    await api(`/hosts/${host.id}`, 'DELETE');
  } finally {
    agent?.kill();
    proxy.closeAllConnections();
    await new Promise((yes) => proxy.close(yes));
  }
}
