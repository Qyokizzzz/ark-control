import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, randomInt, randomUUID, createPrivateKey, sign } from 'node:crypto';
import { existsSync, createWriteStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { chromium } from '@playwright/test';
import { verifyConnections } from './verify-connections.mjs';
import { verifyLifecycle } from './verify-lifecycle.mjs';
import { verifyReconnect } from './verify-reconnect.mjs';
import { verifyServerFiles } from './verify-server-files.mjs';
import { verifyManagement } from './verify-management.mjs';
import { verifyBranches } from './verify-branches.mjs';
import { verifyGameConfig } from './verify-game-config.mjs';
import { verifyWorkspaces } from './verify-workspaces.mjs';
import { verifyIndependentShop } from './verify-independent-shop.mjs';
import { verifyNavigationStartup } from './verify-navigation-startup.mjs';
import { verifyServerPlugins } from './verify-server-plugins.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = resolve(
  process.env.ARK_CHECK_DIR ?? join(root, '.data', 'verification', String(Date.now())),
);
await mkdir(work, { recursive: true });
const children = [];
const checks = [];
let connection;
let apiChild;
let agentChild;
let browser;
let currentPage;
const browserErrors = [];
const configOnly = process.env.ARK_VERIFY_ONLY_CONFIG === '1';
const workspacesOnly = process.env.ARK_VERIFY_ONLY_WORKSPACES === '1';
const navigationStartupOnly = process.env.ARK_VERIFY_ONLY_NAVIGATION_STARTUP === '1';
const pluginsOnly = process.env.ARK_VERIFY_ONLY_PLUGINS === '1';
const focusedComplete = new Error('focused verification complete');
let instance;
let hostToken;
let accessToken;
let apiUrl;
const sleep = (ms) => new Promise((yes) => setTimeout(yes, ms));
const reservedPorts = new Set();
async function availablePort() {
  for (let attempt = 0; attempt < 100; ++attempt) {
    const port = randomInt(20000, 45000);
    if (reservedPorts.has(port)) continue;
    const server = net.createServer();
    const listening = await new Promise((yes) => {
      server.once('error', () => yes(false));
      server.listen(port, '127.0.0.1', () => yes(true));
    });
    if (!listening) continue;
    await new Promise((yes) => server.close(yes));
    if (port >= 65534 || reservedPorts.has(port)) continue;
    for (const adjacent of [port - 1, port, port + 1]) reservedPorts.add(adjacent);
    return port;
  }
  throw new Error('无法分配互不冲突的本地验收端口。');
}
function launch(executable, args, options = {}) {
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  const log = createWriteStream(
    join(work, `${options.label ?? basename(executable)}-${children.length}.log`),
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  return child;
}
async function waitFor(operation, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (failure) {
      error = failure;
    }
    await sleep(300);
  }
  throw new Error(`等待超时：${label}${error ? ` (${error.message})` : ''}`);
}
function passed(message) {
  checks.push(message);
  console.log(`PASS ${message}`);
}
async function focusedPage(password) {
  const edge =
    process.env.BROWSER_BIN ??
    [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ].find(existsSync);
  browser = await chromium.launch({ headless: true, ...(edge ? { executablePath: edge } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  currentPage = page;
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message));
  await page.goto(apiUrl);
  await page.getByRole('textbox', { name: /邮箱/ }).fill('verification@ark.local');
  await page.getByLabel(/密码/).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '运行概况' }).waitFor();
  return page;
}
async function api(
  path,
  method = 'GET',
  body,
  expected = 200,
  credential = accessToken,
  agentFeatures,
) {
  if (path === '/instances' && method === 'POST') body = { autoBranchUpdate: false, ...body };
  const response = await fetch(`${apiUrl}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(agentFeatures ? { 'x-ark-agent-features': agentFeatures } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
  return data.data;
}
async function agent(path, body) {
  return api(
    `/agent${path}`,
    body === undefined ? 'GET' : 'POST',
    body,
    body === undefined ? 200 : 201,
    hostToken,
  );
}
async function dashboard() {
  return api('/dashboard');
}
function callbackSignature(secret, timestamp, body) {
  const bytes = Buffer.from(secret.repeat(32)).subarray(0, 32);
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes]),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(timestamp + body), key).toString('hex');
}
async function command(kind, payload = {}) {
  await fakeMetrics();
  const item = await api(
    `/instances/${instance.id}/commands`,
    'POST',
    { kind, countdownSeconds: 0, idempotencyKey: randomUUID(), ...payload },
    201,
  );
  return waitFor(
    async () => {
      const state = await dashboard();
      const current = state.commands.find((value) => value.id === item.id);
      if (current?.status === 'failed') throw new Error(current.error);
      return current?.status === 'succeeded' ? current : null;
    },
    kind,
    90000,
  );
}
async function fakeMetrics(instances = [], features) {
  if (!hostToken) return;
  await agent('/heartbeat', {
    metrics: {
      cpuPercent: 8,
      cpuCores: 8,
      cpuModel: 'Verification fixture',
      totalMemoryMb: 65536,
      freeMemoryMb: 50000,
      diskFreeGb: 250,
      diskTotalGb: 500,
      sampledAt: new Date().toISOString(),
    },
    instances,
    runningCommands: [],
    console: [],
    features,
  });
}

const sent = [];
const qq = createServer(async (request, response) => {
  let text = '';
  for await (const part of request) text += part;
  const payload = text ? JSON.parse(text) : {};
  response.setHeader('content-type', 'application/json');
  if (request.url === '/app/getAppAccessToken') {
    response.end(JSON.stringify({ access_token: `token-${payload.appId}`, expires_in: 7200 }));
    return;
  }
  if (request.url?.includes('/messages')) {
    sent.push({
      path: request.url,
      authorization: request.headers.authorization,
      content: payload.content,
    });
    response.end(JSON.stringify({ id: randomUUID(), timestamp: new Date().toISOString() }));
    return;
  }
  response.statusCode = 404;
  response.end('{}');
});
await new Promise((yes) => qq.listen(0, '127.0.0.1', yes));
try {
  if (process.platform !== 'win32')
    throw new Error(
      '本地完整进程验收器当前使用 Windows C# 测试进程。纯规则测试可在 Linux 运行 pnpm test。',
    );
  const mysqld =
    process.env.MYSQLD_BIN ??
    process.env.PATH.split(delimiter)
      .map((entry) => join(entry, 'mysqld.exe'))
      .find(existsSync);
  if (!mysqld) throw new Error('未找到 mysqld.exe，请设置 MYSQLD_BIN。');
  const mysqlPort = await availablePort();
  const apiPort = await availablePort();
  const gamePort = await availablePort();
  const queryPort = await availablePort();
  const rconPort = await availablePort();
  apiUrl = `http://127.0.0.1:${apiPort}`;
  const mysqlDir = join(work, 'mysql-data');
  const init = launch(
    mysqld,
    [
      '--no-defaults',
      '--initialize-insecure',
      `--basedir=${dirname(dirname(mysqld))}`,
      `--datadir=${mysqlDir}`,
      `--log-error=${join(work, 'mysql-init.log')}`,
    ],
    { label: 'mysql-init' },
  );
  const exit = await new Promise((yes, no) => {
    init.on('error', no);
    init.on('exit', yes);
  });
  assert.equal(exit, 0, 'MySQL 初始化失败。');
  launch(
    mysqld,
    [
      '--no-defaults',
      `--basedir=${dirname(dirname(mysqld))}`,
      `--datadir=${mysqlDir}`,
      `--port=${mysqlPort}`,
      '--bind-address=127.0.0.1',
      '--mysqlx=OFF',
      '--skip-log-bin',
      `--log-error=${join(work, 'mysql.log')}`,
    ],
    { label: 'mysql' },
  );
  connection = await waitFor(
    () =>
      mysql.createConnection({ host: '127.0.0.1', port: mysqlPort, user: 'root', password: '' }),
    'MySQL',
  );
  await connection.query('CREATE DATABASE ark_verification CHARACTER SET utf8mb4');
  await connection.changeUser({ database: 'ark_verification' });
  const password = randomBytes(18).toString('base64url');
  const environment = {
    ...process.env,
    NODE_ENV: 'test',
    API_HOST: '127.0.0.1',
    API_PORT: String(apiPort),
    APP_ORIGIN: apiUrl,
    DATABASE_HOST: '127.0.0.1',
    DATABASE_PORT: String(mysqlPort),
    DATABASE_NAME: 'ark_verification',
    DATABASE_USER: 'root',
    DATABASE_PASSWORD: '',
    JWT_SECRET: randomBytes(40).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    INITIAL_ADMIN_EMAIL: 'verification@ark.local',
    INITIAL_ADMIN_PASSWORD: password,
    DATA_DIR: join(work, 'api-data'),
    WEB_DIST: join(root, 'apps/web/dist'),
    QQ_API_BASE: `http://127.0.0.1:${qq.address().port}`,
    QQ_GATEWAY_ENABLED: 'false',
    PLATFORM_QQ_APP_ID: workspacesOnly ? '1999009999' : '',
    PLATFORM_QQ_APP_SECRET: workspacesOnly ? 'workspace-verification-secret' : '',
    DEMO_MODE: 'true',
  };
  const startApi = () =>
    launch(process.execPath, [join(root, 'apps/api/dist/main.js')], {
      cwd: join(root, 'apps/api'),
      env: environment,
      label: 'api',
    });
  apiChild = startApi();
  const health = await waitFor(async () => {
    const response = await fetch(`${apiUrl}/api/health`);
    return response.ok ? response : null;
  }, '管理服务');
  passed('真实 MySQL 建表及管理服务启动');
  const contentPolicy = health.headers.get('content-security-policy') ?? '';
  assert.match(contentPolicy, /script-src 'self'/);
  assert.doesNotMatch(contentPolicy, /upgrade-insecure-requests/);
  assert.equal(health.headers.get('strict-transport-security'), null);
  passed('HTTP 保留内容安全策略，页面资源可使用原协议');
  const [schemaColumns] = await connection.query(
    "SHOW COLUMNS FROM resources WHERE Field IN ('workspace_id','state','due_at')",
  );
  assert.equal(schemaColumns.length, 3);
  passed('空库建表包含工作空间、状态与任务到期字段');
  const loginResponse = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'verification@ark.local', password }),
  });
  assert.equal(loginResponse.status, 201);
  const login = (await loginResponse.json()).data;
  accessToken = login.accessToken;
  const cookie = loginResponse.headers.getSetCookie()[0].split(';')[0];
  await api('/dashboard', 'GET', undefined, 401, '');
  passed('管理员登录与未授权请求隔离');
  if (workspacesOnly) {
    const ownerPage = await focusedPage(password);
    await verifyWorkspaces({
      apiUrl,
      accessToken,
      ownerPage,
      browser,
      work,
      root,
      passed,
      waitFor,
      launch,
      callbackSignature,
      availablePort,
    });
    assert.deepEqual(browserErrors, []);
    throw focusedComplete;
  }
  const host = await api('/hosts', 'POST', { name: '本机验收主机', address: '127.0.0.1' }, 201);
  const enrolled = await api(
    '/agent/enroll',
    'POST',
    { code: host.code, platform: 'windows', agentVersion: '1.0.0' },
    201,
    '',
  );
  hostToken = `${enrolled.hostId}.${enrolled.token}`;
  await api(
    '/agent/enroll',
    'POST',
    { code: host.code, platform: 'windows', agentVersion: '1.0.0' },
    401,
    '',
  );
  await fakeMetrics();
  passed('主机一次性接入码和独立助手认证');
  instance = await api(
    '/instances',
    'POST',
    {
      hostId: host.id,
      name: '孤岛 · 联调',
      map: 'TheIsland',
      gamePort,
      queryPort,
      rconPort,
      autoRestart: false,
      config: { sessionName: 'Local Verification', maxPlayers: 1 },
    },
    201,
  );
  await api(
    '/instances',
    'POST',
    {
      hostId: host.id,
      name: '冲突实例',
      map: 'Ragnarok',
      gamePort,
      queryPort: queryPort + 1,
      rconPort: rconPort + 1,
    },
    400,
  );
  passed('地图创建、默认配置和端口冲突拦截');
  if (pluginsOnly) {
    const page = await focusedPage(password);
    await verifyServerPlugins({
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
    });
    assert.deepEqual(browserErrors, []);
    throw focusedComplete;
  }
  if (navigationStartupOnly) {
    const page = await focusedPage(password);
    await verifyNavigationStartup({
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
    });
    assert.deepEqual(browserErrors, []);
    throw focusedComplete;
  }
  const patchHarvest = (harvest) =>
    api(`/instances/${instance.id}`, 'PATCH', {
      config: { ...instance.config, harvest },
    });
  const firstSave = await patchHarvest(12);
  const secondSave = await patchHarvest(18);
  assert.ok(firstSave.configSyncCommandId);
  assert.equal(firstSave.configSyncCommandId, secondSave.configSyncCommandId);
  assert.notEqual(firstSave.configSave.auditId, secondSave.configSave.auditId);
  const firstAudit = await api(`/audit/${firstSave.configSave.auditId}`, 'GET');
  const secondAudit = await api(`/audit/${secondSave.configSave.auditId}`, 'GET');
  assert.equal(firstAudit.actorId, login.admin.id);
  assert.ok(firstAudit.actor.includes(login.admin.email));
  assert.equal(firstAudit.instanceId, instance.id);
  assert.ok(Number.isFinite(Date.parse(firstAudit.createdAt)));
  assert.deepEqual(firstAudit.changes, [
    { source: 'basic', key: 'harvest', before: instance.config.harvest, after: 12 },
  ]);
  assert.deepEqual(secondAudit.changes, [
    { source: 'basic', key: 'harvest', before: 12, after: 18 },
  ]);
  assert.deepEqual((await patchHarvest(18)).configSave, { auditId: null, total: 0, changes: [] });
  await api(`/audit/${firstSave.configSave.auditId}`, 'GET', undefined, 401, '');
  passed('两次保存即使合并成同一写入任务，也保留各自的操作者、时间和修改值');
  assert.equal((await agent('/poll')).commands.length, 0);
  const syncPoll = await api('/agent/poll', 'GET', undefined, 200, hostToken, 'config-sync-v1');
  const claimed = syncPoll.commands[0];
  assert.equal(claimed.id, firstSave.configSyncCommandId);
  assert.equal(claimed.instance.config.harvest, 18);
  const latestSave = await patchHarvest(instance.config.harvest);
  assert.notEqual(latestSave.configSyncCommandId, claimed.id);
  assert.equal(
    (await api('/agent/poll', 'GET', undefined, 200, hostToken, 'config-sync-v1')).commands.length,
    0,
  );
  await api(`/agent/commands/${claimed.id}/ack`, 'POST', { status: 'succeeded' }, 409, hostToken);
  await agent(`/commands/${claimed.id}/ack`, { status: 'failed', error: '模拟主机写入失败' });
  assert.equal((await agent('/poll')).commands.length, 0);
  passed(
    '连续保存按最新值同步，旧助手不会领取写入任务，写入中再次保存生成后续任务，没有回读凭据时拒绝报成功',
  );
  const bot1 = await api(
    '/bots',
    'POST',
    {
      name: '默认机器人（本地替身）',
      appId: '100000001',
      appSecret: 'secret-for-default-test',
      isDefault: true,
      certified: true,
    },
    201,
  );
  const bot2 = await api(
    '/bots',
    'POST',
    {
      name: '客户机器人（本地替身）',
      appId: '100000002',
      appSecret: 'secret-for-customer-test',
      owner: '测试客户',
      certified: true,
    },
    201,
  );
  await api(`/bots/${bot1.id}/verify`, 'POST', {}, 201);
  await api(`/bots/${bot2.id}/verify`, 'POST', {}, 201);
  await api(`/bots/${bot2.id}`, 'PATCH', { isDefault: true });
  let state = await dashboard();
  assert.equal(state.bots.find((item) => item.id === bot2.id).owner, '测试客户');
  await api(`/bots/${bot1.id}`, 'PATCH', { isDefault: true });
  assert.ok(!JSON.stringify(state).includes('secret-for-'));
  const [storedCredentials] = await connection.query(
    "SELECT body FROM resources WHERE kind='bot-credentials'",
  );
  assert.ok(!JSON.stringify(storedCredentials).includes('secret-for-'));
  passed('默认/客户机器人凭据验证、加密及部分更新保留字段');
  const groups = [];
  for (let index = 0; index < 2; ++index) {
    const bot = index ? bot2 : bot1;
    const secret = index ? 'secret-for-customer-test' : 'secret-for-default-test';
    const callbackUrl = `${apiUrl}/api/qq/webhook/${bot.id}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const plainToken = randomUUID();
    const challenge = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Bot-Appid': bot.appId },
      body: JSON.stringify({ op: 13, d: { plain_token: plainToken, event_ts: timestamp } }),
    });
    assert.equal(challenge.status, 200);
    assert.deepEqual(await challenge.json(), {
      plain_token: plainToken,
      signature: callbackSignature(secret, timestamp, plainToken),
    });
    const binding = await api(`/bots/${bot.id}/binding-code`, 'POST', {}, 201);
    const openId = `verification-${index}-group`;
    const rawBody =
      ' \n' +
      JSON.stringify({
        op: 0,
        t: 'GROUP_AT_MESSAGE_CREATE',
        id: randomUUID(),
        d: { group_openid: openId, content: ` @机器人 绑定 ${binding.code}` },
      });
    const forgedChallenge = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Bot-Appid': bot.appId },
      body: JSON.stringify({ op: 13, d: { plain_token: rawBody, event_ts: timestamp } }),
    });
    assert.equal(forgedChallenge.status, 400);
    const sendCallback = (signedAt, signature) =>
      fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Bot-Appid': bot.appId,
          'X-Signature-Timestamp': signedAt,
          'X-Signature-Ed25519': signature,
        },
        body: rawBody,
      });
    assert.equal((await sendCallback(timestamp, '0'.repeat(128))).status, 401);
    const stale = String(Number(timestamp) - 600);
    assert.equal(
      (await sendCallback(stale, callbackSignature(secret, stale, rawBody))).status,
      401,
    );
    const signature = callbackSignature(secret, timestamp, rawBody);
    assert.equal((await sendCallback(timestamp, signature)).status, 200);
    assert.equal((await sendCallback(timestamp, signature)).status, 200);
    const group = (await dashboard()).groups.find(
      (item) => item.botId === bot.id && item.openId === openId,
    );
    assert.ok(group);
    groups.push(
      await api(`/groups/${group.id}`, 'PATCH', {
        name: index ? '客户推送验收群' : '默认推送验收群',
        groupNumber: '',
      }),
    );
    assert.equal((await dashboard()).groups.length, index + 1);
  }
  passed('QQ 回调验证、原始字节验签、伪造与过期拒绝、一次性群绑定');
  for (let index = 0; index < groups.length; ++index)
    await api(
      '/subscriptions',
      'POST',
      {
        customer: index ? '测试客户' : '测试默认订阅',
        instanceId: instance.id,
        tribeId: '123',
        tribeName: '飞龙部落',
        botMode: index ? 'custom' : 'default',
        botId: index ? bot2.id : bot1.id,
        groupId: groups[index].id,
      },
      201,
    );
  await api(
    '/subscriptions',
    'POST',
    {
      customer: '错误绑定',
      instanceId: instance.id,
      tribeId: '456',
      tribeName: '海岸部落',
      botId: bot1.id,
      groupId: groups[1].id,
    },
    400,
  );
  passed('机器人与群匹配、管理员订阅配置');
  const hostRoot = join(work, 'host-files');
  const executable = join(
    hostRoot,
    'instances',
    instance.id,
    'ShooterGame',
    'Binaries',
    'Win64',
    'ShooterGameServer.exe',
  );
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(join(dirname(executable), '../../ShooterGame.uproject'), '{"FileVersion":3}');
  const compiler = join(
    process.env.WINDIR ?? 'C:/Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  );
  const compile = launch(
    compiler,
    ['/nologo', '/target:exe', `/out:${executable}`, join(root, 'tests/fixtures/FakeArk.cs')],
    { label: 'compile-fixture' },
  );
  assert.equal(
    await new Promise((yes, no) => {
      compile.on('error', no);
      compile.on('exit', yes);
    }),
    0,
    '测试进程编译失败。',
  );
  const bridge = join(dirname(executable), 'ArkApi', 'Plugins', 'ArkTribeBridge', 'events.jsonl');
  await mkdir(dirname(bridge), { recursive: true });
  await writeFile(bridge, '');
  const steamRoot = join(hostRoot, 'tools', 'steamcmd');
  await mkdir(steamRoot, { recursive: true });
  await copyFile(executable, join(steamRoot, 'fixture-game.exe'));
  const agentConfig = join(work, 'agent.json');
  await writeFile(
    agentConfig,
    JSON.stringify({ apiUrl, hostId: host.id, token: enrolled.token, root: hostRoot }),
  );
  agentChild = launch(
    process.execPath,
    [join(root, 'apps/agent/dist/main.js'), '--config', agentConfig],
    { cwd: root, label: 'agent' },
  );
  await waitFor(async () => {
    const state = await dashboard();
    const map = state.instances.find((item) => item.id === instance.id);
    return (
      map?.installed &&
      map.serverFileId &&
      state.hosts.find((item) => item.id === host.id)?.features?.includes('shared-map-files-v1')
    );
  }, '助手识别服务端文件');
  if (configOnly) {
    const page = await focusedPage(password);
    await page.goto(`${apiUrl}/instances/${instance.id}`);
    await verifyGameConfig({ page, instance, hostRoot, work, command, dashboard, waitFor, passed });
    assert.deepEqual(browserErrors, []);
    throw focusedComplete;
  }
  if (process.env.ARK_VERIFY_ONLY_SHOP_MODS === '1') {
    const page = await focusedPage(password);
    const useShopBridgeFixture = async () => {
      const stopped = new Promise((yes) => agentChild.once('exit', yes));
      agentChild.kill();
      await stopped;
      agentChild = launch(
        process.execPath,
        [
          '--import',
          'tsx',
          join(root, 'tests/fixtures/shop-bridge.ts'),
          instance.id,
          '--config',
          agentConfig,
        ],
        {
          cwd: root,
          label: 'agent-shop-bridge',
          env: { ...process.env, TSX_TSCONFIG_PATH: join(root, 'apps/agent/tsconfig.json') },
        },
      );
    };
    await verifyIndependentShop({
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
    });
    assert.deepEqual(browserErrors, []);
    throw focusedComplete;
  }
  const compileSteam = launch(
    compiler,
    [
      '/nologo',
      '/target:exe',
      `/out:${join(steamRoot, 'steamcmd.exe')}`,
      join(root, 'tests/fixtures/FakeSteamCmd.cs'),
    ],
    { label: 'compile-steam-fixture' },
  );
  assert.equal(
    await new Promise((yes, no) => {
      compileSteam.on('error', no);
      compileSteam.on('exit', yes);
    }),
    0,
  );
  const failedInstall = await api(
    `/instances/${instance.id}/commands`,
    'POST',
    { kind: 'install', idempotencyKey: randomUUID() },
    201,
  );
  const installFailure = await waitFor(async () => {
    const item = (await dashboard()).commands.find((item) => item.id === failedInstall.id);
    return item?.status === 'failed' ? item : null;
  }, '安装失败详情回传');
  assert.match(installFailure.error, /Disk write failure/);
  assert.match(installFailure.error, /已自动重试一次/);
  assert.equal(await readFile(join(steamRoot, 'attempts.txt'), 'utf8'), '2');
  assert.match(
    await readFile(join(hostRoot, 'logs', 'steamcmd', `${failedInstall.id}.log`), 'utf8'),
    /Disk write failure/,
  );
  passed('SteamCMD 退出 7 仅重试一次，具体安装错误和日志路径回传后台');
  await waitFor(
    async () =>
      (await dashboard()).instances.find((item) => item.id === instance.id)?.status === 'error',
    '安装失败状态回传',
  );
  await writeFile(join(steamRoot, 'missing-config.txt'), 'always');
  const metadataInstall = await api(
    `/instances/${instance.id}/commands`,
    'POST',
    { kind: 'install', idempotencyKey: randomUUID() },
    201,
  );
  const metadataFailure = await waitFor(async () => {
    const item = (await dashboard()).commands.find((item) => item.id === metadataInstall.id);
    return item?.status === 'failed' ? item : null;
  }, 'Missing configuration 失败详情回传');
  assert.match(metadataFailure.error, /Missing configuration/);
  assert.match(metadataFailure.error, /已自动重试一次/);
  assert.match(metadataFailure.error, /Steam 应用安装信息/);
  assert.equal(await readFile(join(steamRoot, 'metadata-always-attempts.txt'), 'utf8'), '2');
  const metadataLog = await readFile(
    join(hostRoot, 'logs', 'steamcmd', `${metadataInstall.id}.log`),
    'utf8',
  );
  assert.match(metadataLog, /content_log.txt/);
  assert.match(metadataLog, /connection_log.txt/);
  assert.match(metadataLog, /installation metadata unavailable/);
  passed('SteamCMD Missing configuration 退出 8 有界重试，持续失败保留应用及连接诊断');
  await waitFor(
    async () =>
      (await dashboard()).instances.find((item) => item.id === instance.id)?.status === 'error',
    '元数据失败状态回传',
  );
  await writeFile(join(steamRoot, 'missing-config.txt'), 'once');
  await command('install');
  assert.equal(await readFile(join(steamRoot, 'metadata-once-attempts.txt'), 'utf8'), '2');
  assert.equal(await readFile(join(steamRoot, 'attempts.txt'), 'utf8'), '6');
  const steamCommands = (await readFile(join(steamRoot, 'commands.txt'), 'utf8'))
    .trim()
    .split(/\r?\n/);
  assert.equal(steamCommands.filter((line) => line === '+quit').length, 3);
  for (const line of steamCommands.filter((line) => line !== '+quit'))
    assert.match(
      line,
      /\+force_install_dir .+ \+login anonymous \+app_info_update 1 \+app_update 376030 -beta public validate \+quit$/,
    );
  await waitFor(
    async () =>
      (await dashboard()).instances.find((item) => item.id === instance.id)?.lastError === null,
    '安装成功清除历史错误',
  );
  passed('独立初始化及刷新应用信息后安装重试成功，清除旧错误并保留失败任务');
  await command('start');
  await waitFor(async () => {
    const state = await dashboard();
    return state.instances.find((item) => item.id === instance.id)?.status === 'running';
  }, '地图运行状态');
  passed('实际 Windows 子进程启动、RCON 就绪和心跳上报');
  if (process.env.ARK_VERIFY_ONLY_MANAGEMENT === '1') {
    const targetPage = await focusedPage(password);
    await verifyManagement({
      api,
      apiUrl,
      page: targetPage,
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
      hostToken,
      accessToken,
      fakeMetrics,
    });
    await verifyBranches({ api, availablePort, waitFor, passed, connection });
    assert.deepEqual(browserErrors, []);
    throw focusedComplete;
  }
  const event = (sourceId, day) => ({
    sourceId,
    tribeId: '123',
    tribeName: '飞龙部落',
    text: `Day ${day}, 12:00:00: 你的霸王龙已死亡`,
    occurredAt: new Date().toISOString(),
  });
  await appendFile(bridge, JSON.stringify(event('fixed-window-1', 81)) + '\n');
  const first = await waitFor(async () => {
    const state = await dashboard();
    return state.deliveries.find((item) => item.body === '你的霸王龙已死亡');
  }, '首条日志持久化');
  await appendFile(bridge, JSON.stringify(event('fixed-window-2', 82)) + '\n');
  await waitFor(async () => {
    const state = await dashboard();
    return state.deliveries
      .filter((item) => item.body === '你的霸王龙已死亡')
      .every((item) => item.count === 2);
  }, '同名日志计数');
  const duplicate = await agent('/events', {
    events: [{ ...event('fixed-window-1', 81), instanceId: instance.id }],
  });
  assert.equal(duplicate.duplicate, 1);
  const separate = await agent('/events', {
    events: [
      {
        ...event('other-tribe-1', 82),
        instanceId: instance.id,
        tribeId: '456',
        tribeName: '其他部落',
      },
    ],
  });
  assert.equal(separate.accepted, 1);
  await api(
    '/agent/events',
    'POST',
    { events: [{ ...event('foreign-instance', 82), instanceId: randomUUID() }] },
    403,
    hostToken,
  );
  assert.equal((await dashboard()).deliveries.length, 2);
  passed('其他部落日志独立保存，跨主机事件拒绝接收');
  apiChild.kill();
  await new Promise((yes) => apiChild.once('exit', yes));
  apiChild = startApi();
  await waitFor(async () => {
    const response = await fetch(`${apiUrl}/api/health`);
    return response.ok;
  }, '后台重启');
  state = await dashboard();
  assert.equal(
    state.deliveries.find((item) => item.id === first.id).windowEndsAt,
    first.windowEndsAt,
  );
  passed('重复上报去重、固定窗口及后台重启后队列恢复');
  const players = await command('players');
  assert.equal(players.result.players[0].steamId, '76561198000000001');
  passed('玩家列表通过 RCON 获取');
  const scheduledStop = await api(
    `/instances/${instance.id}/commands`,
    'POST',
    { kind: 'stop', countdownSeconds: 20, idempotencyKey: randomUUID() },
    201,
  );
  await waitFor(async () => {
    const state = await dashboard();
    return state.commands.find((item) => item.id === scheduledStop.id)?.status === 'executing';
  }, '倒计时开始');
  await api(`/commands/${scheduledStop.id}/cancel`, 'POST', {}, 201);
  await waitFor(async () => {
    const state = await dashboard();
    return state.commands.find((item) => item.id === scheduledStop.id)?.status === 'cancelled';
  }, '取消倒计时');
  passed('停服倒计时可取消且进程继续运行');
  await command('backup');
  state = await dashboard();
  assert.ok(state.backups.length);
  const backup = state.backups[0];
  const download = await fetch(`${apiUrl}/api/backups/${backup.id}/download`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(download.status, 200);
  assert.ok((await download.arrayBuffer()).byteLength > 100);
  passed('在线稳定备份、上传校验和授权下载');
  await waitFor(() => sent.length === 2, '30 秒窗口推送', 45000);
  assert.deepEqual(
    new Set(sent.map((item) => item.authorization)),
    new Set(['QQBot token-100000001', 'QQBot token-100000002']),
  );
  for (const item of sent) assert.equal(item.content, '孤岛-飞龙部落： 你的霸王龙已死亡 (2)');
  passed('30 秒合并后由指定默认/客户机器人分别发送，格式及数量正确');
  await command('restart');
  await waitFor(async () => {
    const state = await dashboard();
    return state.instances.find((item) => item.id === instance.id)?.status === 'running';
  }, '重启完成');
  passed('正常保存退出后重新启动');
  const processState = JSON.parse(await readFile(join(hostRoot, 'processes.json'), 'utf8'));
  const originalPid = processState[instance.id].pid;
  await waitFor(
    async () =>
      (await dashboard()).instances.find((item) => item.id === instance.id).pid === originalPid,
    '新进程心跳确认',
  );
  const stoppedAgent = new Promise((yes) => agentChild.once('exit', yes));
  agentChild.kill();
  await stoppedAgent;
  const recoveredAfter = Date.now();
  agentChild = launch(
    process.execPath,
    [join(root, 'apps/agent/dist/main.js'), '--config', agentConfig],
    { cwd: root, label: 'agent-recovery' },
  );
  await waitFor(async () => {
    const state = await dashboard();
    return (
      Date.parse(state.hosts.find((item) => item.id === host.id).lastSeenAt) >= recoveredAfter &&
      state.instances.find((item) => item.id === instance.id).pid === originalPid
    );
  }, '助手重启接管原进程');
  passed('助手重启后接管同一游戏进程，游戏 PID 保持不变');
  const finalStop = await api(
    `/instances/${instance.id}/commands`,
    'POST',
    { kind: 'stop', countdownSeconds: 0, idempotencyKey: randomUUID() },
    201,
  );
  await waitFor(
    async () =>
      (await dashboard()).commands.find((item) => item.id === finalStop.id)?.result
        ?.stopCommitted === true,
    '停服提交边界',
  );
  await api(`/commands/${finalStop.id}/cancel`, 'POST', {}, 409);
  await waitFor(
    async () =>
      (await dashboard()).commands.find((item) => item.id === finalStop.id)?.status === 'succeeded',
    '正常停服完成',
    90000,
  );
  passed('停服开始保存后拒绝迟到的取消请求');
  await waitFor(async () => {
    const state = await dashboard();
    return state.instances.find((item) => item.id === instance.id)?.status === 'stopped';
  }, '停止状态');
  const savedFile = join(
    hostRoot,
    'instances',
    instance.id,
    'ShooterGame',
    'Saved',
    'SavedArks',
    'TheIsland.ark',
  );
  await writeFile(savedFile, 'changed-after-backup');
  await command('restore', { backupId: backup.id });
  assert.notEqual(await readFile(savedFile, 'utf8'), 'changed-after-backup');
  state = await dashboard();
  assert.ok(state.backups.length >= 2);
  passed('停服恢复存档，恢复前自动保留旧存档');
  const refresh = await fetch(`${apiUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(refresh.status, 201);
  const nextCookie = refresh.headers.getSetCookie()[0].split(';')[0];
  const reuse = await fetch(`${apiUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(reuse.status, 401);
  assert.equal(
    (await fetch(`${apiUrl}/api/auth/refresh`, { method: 'POST', headers: { Cookie: nextCookie } }))
      .status,
    401,
  );
  passed('刷新令牌轮换和重复使用撤销');
  await verifyConnections({
    api,
    apiUrl,
    accessToken,
    root,
    work,
    host,
    instance,
    hostRoot,
    launch,
    availablePort,
    waitFor,
    dashboard,
    passed,
  });
  const instanceCountBeforeMobile = (await dashboard()).instances.length;
  const executablePath =
    process.env.BROWSER_BIN ??
    [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  currentPage = page;
  const pageErrors = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    browserErrors.push(error.stack ?? error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('requestfailed', (request) =>
    browserErrors.push(`${request.url()} ${request.failure()?.errorText}`),
  );
  await page.goto(apiUrl);
  await page.getByRole('textbox', { name: /邮箱/ }).fill('verification@ark.local');
  await page.getByLabel(/密码/).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '运行概况' }).waitFor();
  await page.screenshot({ path: join(work, 'desktop.png'), fullPage: true });
  const routes = [
    ['', '运行概况'],
    ['instances', '地图管理'],
    [`instances/${instance.id}`, instance.name],
    ['hosts', '主机管理'],
    ['connections', '好友联机'],
    ['players', '用户管理'],
    ['shop', '商店管理'],
    ['subscriptions', '部落订阅'],
    ['bots', 'QQ 机器人'],
    ['backups', '存档备份'],
    ['logs', '运行日志'],
    ['schedules', '维护计划'],
    ['settings', '设置'],
  ];
  async function openPage(path, heading) {
    await page.goto(`${apiUrl}/${path}`);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    assert.ok(!(await page.getByText('页面暂时无法显示', { exact: true }).count()), path);
  }
  for (const [path, heading] of routes) await openPage(path, heading);
  await openPage(`instances/${instance.id}`, instance.name);
  await page.getByRole('tab', { name: '任务', exact: true }).click();
  const installErrorCell = page
    .getByRole('cell')
    .filter({ hasText: 'SteamCMD 安装/更新服务端执行失败' })
    .filter({ hasText: 'Disk write failure' });
  await installErrorCell.waitFor();
  assert.match(await installErrorCell.innerText(), /Disk write failure/);
  assert.equal(
    await installErrorCell.evaluate((cell) => getComputedStyle(cell).whiteSpace),
    'pre-wrap',
  );
  const metadataErrorCell = page
    .getByRole('cell')
    .filter({ hasText: 'SteamCMD 安装/更新服务端执行失败' })
    .filter({ hasText: 'Missing configuration' });
  await metadataErrorCell.waitFor();
  assert.match(await metadataErrorCell.innerText(), /Steam 应用安装信息/);
  await verifyGameConfig({ page, instance, hostRoot, work, command, dashboard, waitFor, passed });
  await openPage('settings', '设置');
  for (const label of ['明亮', '蓝色', '粉色', '黄色', '深色']) {
    const choice = page.getByRole('button', { name: label, exact: true });
    await choice.click();
    assert.equal(await choice.getAttribute('aria-pressed'), 'true');
  }
  await openPage('connections', '好友联机');
  await page.getByRole('button', { name: '新建联机入口', exact: true }).click();
  const networkDialog = page.getByRole('dialog');
  await networkDialog.getByRole('textbox', { name: /^名称/ }).fill('好友联机 · 界面验收');
  await networkDialog.getByRole('combobox', { name: /后台所在主机/ }).click();
  await page.getByRole('option', { name: '本机验收主机', exact: true }).click();
  await networkDialog.getByRole('combobox', { name: /目标地图/ }).click();
  await page.getByRole('option', { name: `${instance.name} · 本机验收主机`, exact: true }).click();
  await networkDialog
    .getByRole('textbox', { name: /连接引导节点/ })
    .fill(`tcp://127.0.0.1:${await availablePort()}`);
  await networkDialog.getByRole('button', { name: '保存', exact: true }).click();
  await networkDialog.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '好友联机 · 界面验收', exact: true }).waitFor();
  await page.getByRole('button', { name: '创建联机包', exact: true }).click();
  const inviteDialog = page.getByRole('dialog');
  await inviteDialog.getByRole('textbox', { name: /联机包名称/ }).fill('朋友 A');
  await inviteDialog.getByRole('button', { name: '保存', exact: true }).click();
  await inviteDialog.waitFor({ state: 'hidden' });
  const fileDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载联机包', exact: true }).click();
  assert.match((await fileDownload).suggestedFilename(), /^ArkConnect-.*\.exe$/);
  await page.locator('.MuiSnackbar-root').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(work, 'connections-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    '联机卡片在手机端溢出',
  );
  await page.screenshot({ path: join(work, 'connections-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '切换地图 / 设置', exact: true }).click();
  const updateDialog = page.getByRole('dialog');
  assert.equal(
    await updateDialog
      .getByRole('combobox', { name: /后台所在主机/ })
      .getAttribute('aria-disabled'),
    'true',
  );
  await updateDialog.getByRole('textbox', { name: /^名称/ }).fill('好友联机 · 已更新');
  await updateDialog.getByRole('button', { name: '保存', exact: true }).click();
  await updateDialog.waitFor({ state: 'hidden' });
  const uiNetwork = (await api('/connections')).networks.find(
    (item) => item.name === '好友联机 · 已更新',
  );
  assert.equal(uiNetwork.revision, 2);
  await page.getByRole('button', { name: '删除联机入口', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认操作', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await waitFor(
    async () =>
      (await dashboard()).hosts.every(
        (item) => !item.connections?.some((entry) => entry.networkId === uiNetwork.id),
      ),
    '界面验收联机进程退出',
    20000,
  );
  passed('浏览器创建/更新/删除联机入口、真实下载专属客户端及 390px 手机界面');
  for (const [path, heading] of routes) {
    await openPage(path, heading);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `移动端页面溢出：${path}`,
    );
  }
  await openPage('', '运行概况');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('link', { name: '部落订阅', exact: true }).click();
  await page.getByRole('heading', { name: '部落订阅', exact: true }).waitFor();
  await openPage('', '运行概况');
  await page.getByRole('button', { name: '新建地图', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /^后台地图名称/ }).fill('移动端验收地图');
  await dialog.getByRole('button', { name: '创建地图', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '移动端验收地图', exact: true }).waitFor();
  assert.equal((await dashboard()).instances.length, instanceCountBeforeMobile + 1);
  await page.getByText('已保存', { exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
  await page.locator('.MuiSnackbar-root').waitFor({ state: 'hidden' });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(work, 'mobile.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);
  passed('真实浏览器登录、全部页面、五主题、390px 手机导航和实际创建地图');
  await verifyManagement({
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
    hostToken,
    accessToken,
    fakeMetrics,
  });
  await verifyServerFiles({
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
  });
  await verifyLifecycle({
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
  });
  await verifyReconnect({
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
    restartApi: async () => {
      const exited = new Promise((yes) => apiChild.once('exit', yes));
      apiChild.kill();
      await exited;
      apiChild = startApi();
      await waitFor(async () => (await fetch(`${apiUrl}/api/health`)).ok, '后台重新启动');
    },
  });
  assert.deepEqual(pageErrors, []);
  await verifyBranches({ api, availablePort, waitFor, passed, connection });
  await writeFile(
    join(work, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        checks,
        desktop: 'desktop.png',
        mobile: 'mobile.png',
        note: 'MySQL、浏览器、EasyTier 和 Windows 好友客户端真实运行；SteamCMD、游戏 UDP/RCON 与 QQ 使用本地替身。公网节点、真实 ASE 安装/进服与真实 QQ 送达仍需接入验证。',
      },
      null,
      2,
    ),
  );
  console.log(`验证完成：${checks.length} 项；报告目录 ${work}`);
} catch (error) {
  if (error === focusedComplete) {
    await writeFile(
      join(work, 'report.json'),
      JSON.stringify(
        {
          ok: true,
          partial: true,
          scope: workspacesOnly
            ? 'workspaces'
            : configOnly
              ? 'game-config'
              : navigationStartupOnly
                ? 'navigation-startup'
                : 'management-and-branches',
          checks,
        },
        null,
        2,
      ),
    );
    console.log('定向验收完成：' + checks.length + ' 项；' + work);
  } else {
    console.error(error.stack ?? error);
    if (currentPage) {
      await currentPage
        .screenshot({ path: join(work, 'failure.png'), fullPage: true })
        .catch(() => undefined);
      await writeFile(
        join(work, 'browser-failure.json'),
        JSON.stringify(
          {
            url: currentPage.url(),
            errors: browserErrors,
            body: await currentPage
              .locator('body')
              .innerText()
              .catch(() => ''),
          },
          null,
          2,
        ),
      );
      console.error(browserErrors.join('\n'));
    }
    await writeFile(
      join(work, 'report.json'),
      JSON.stringify({ ok: false, checks, error: error.message }, null, 2),
    );
    process.exitCode = 1;
  }
} finally {
  await browser?.close().catch(() => undefined);
  agentChild?.kill();
  // Stop only processes whose executable matches an owned verification map directory.
  if (instance) {
    try {
      const states = JSON.parse(await readFile(join(work, 'host-files', 'processes.json'), 'utf8'));
      for (const [mapId, state] of Object.entries(states)) {
        const pid = state.pid;
        if (!/^[a-f0-9-]{36}$/i.test(mapId) || !Number.isSafeInteger(pid) || pid <= 0) continue;
        const expected = join(
          work,
          'host-files',
          'instances',
          mapId,
          'ShooterGame',
          'Binaries',
          'Win64',
          'ShooterGameServer.exe',
        );
        const probe = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).Path`,
          ],
          { windowsHide: true },
        );
        let actual = '';
        for await (const part of probe.stdout) actual += part;
        if (resolve(actual.trim()).toLowerCase() === resolve(expected).toLowerCase())
          process.kill(pid);
      }
    } catch {
      /* Process already stopped. */
    }
  }
  agentChild?.kill();
  apiChild?.kill();
  try {
    await connection?.query('SHUTDOWN');
  } catch {
    /* Shutdown closes its own connection. */
  }
  await connection?.end().catch(() => undefined);
  for (const child of children) if (child.exitCode === null) child.kill();
  await new Promise((yes) => qq.close(yes));
}
