import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function verifyWorkspaces({
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
}) {
  const request = async (
    path,
    { token = accessToken, workspace, method = 'GET', body, status = 200, headers = {} } = {},
  ) => {
    const response = await fetch(`${apiUrl}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(workspace ? { 'x-ark-workspace': workspace } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 200 && response.headers.get('content-type') === 'application/zip')
      return response;
    const content = await response.json();
    assert.equal(response.status, status, `${method} ${path} ${JSON.stringify(content)}`);
    return content.data;
  };
  const post = (path, body, options = {}) =>
    request(path, { method: 'POST', body, status: 201, ...options });
  const patch = (path, body, options = {}) => request(path, { method: 'PATCH', body, ...options });
  const own = (await request('/workspaces')).find((item) => item.role === 'owner');
  assert.equal(own.status, 'active');
  const workspaceA = { workspace: own.id };

  const guest = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors = [];
  guest.on('pageerror', (error) => errors.push(error.message));
  try {
    await guest.goto(apiUrl);
    await guest.getByRole('button', { name: '创建账号' }).click();
    await guest.getByLabel('显示名称').fill('协管乙');
    await guest.getByLabel('邮箱').fill('guest@ark.local');
    const registrationPassword = guest.getByLabel(/密码/);
    await registrationPassword.fill('short');
    await guest.getByRole('button', { name: '注册', exact: true }).click();
    await guest.getByText('密码至少 12 个字符。', { exact: true }).waitFor();
    assert.equal(await registrationPassword.getAttribute('aria-invalid'), 'true');
    assert.equal(await registrationPassword.evaluate((input) => input.form.noValidate), true);
    await registrationPassword.fill('Sc0ped-verification-account');
    assert.equal(await registrationPassword.getAttribute('aria-invalid'), 'false');
    const registration = guest.waitForResponse(
      (response) =>
        response.url().endsWith('/api/auth/register') && response.request().method() === 'POST',
    );
    await guest.getByRole('button', { name: '注册', exact: true }).click();
    const identity = (await (await registration).json()).data;
    assert.equal(identity.admin.platformAdmin, false);
    const guestToken = { token: identity.accessToken };
    await guest.getByRole('heading', { name: '我的工作空间' }).waitFor();
    await guest.getByLabel('工作空间名称').fill('乙的工作空间');
    await guest.getByRole('button', { name: '提交审核' }).click();
    await guest.getByText('待审核', { exact: true }).waitFor();
    const [other] = await request('/workspaces', guestToken);
    const workspaceB = { ...guestToken, workspace: other.id };
    await request('/dashboard', { ...workspaceB, status: 403 });
    await request('/platform/workspaces', { ...workspaceB, status: 403 });
    await ownerPage.goto(`${apiUrl}/platform`);
    await ownerPage.getByRole('button', { name: '开通', exact: true }).click();
    await ownerPage.getByRole('button', { name: '确认', exact: true }).click();
    await waitFor(
      async () => (await request('/workspaces', guestToken))[0]?.status === 'active',
      '平台审核生效',
    );
    await request('/dashboard', { workspace: other.id, status: 403 });
    passed('手机宽度自助注册和申请，平台审批后开通自己的工作空间');

    await patch(`/platform/workspaces/${other.id}`, { limits: { hosts: 1, maps: 1, members: 0 } });
    const hostA = await post('/hosts', { name: '甲授权主机', address: '127.0.0.1' }, workspaceA);
    const hiddenHost = await post('/hosts', { name: '甲保留主机' }, workspaceA);
    const hostB = await post('/hosts', { name: '乙自己的主机' }, workspaceB);
    await post('/hosts', { name: '超限' }, { ...workspaceB, status: 409 });

    await ownerPage.goto(`${apiUrl}/hosts`);
    const enrollmentHost = ownerPage.getByRole('region', { name: '主机 甲保留主机' });
    await enrollmentHost.waitFor();
    const sidebar = ownerPage.getByRole('navigation', { name: '工作空间' });
    assert.deepEqual((await sidebar.getByRole('link').allTextContents()).slice(0, 5), [
      '主机管理',
      '地图管理',
      '商店管理',
      '用户管理',
      '服务端文件',
    ]);
    assert.equal(
      await sidebar
        .locator('.MuiDrawer-paper')
        .evaluate((paper) => getComputedStyle(paper).scrollbarWidth),
      'thin',
    );
    await enrollmentHost.getByRole('button', { name: '重新连接', exact: true }).click();
    const enrollmentDialog = ownerPage.getByRole('dialog', { name: /重新连接主机/ });
    await enrollmentDialog.waitFor();
    assert.doesNotMatch(await enrollmentDialog.innerText(), /管理后台地址|127\.0\.0\.1/);
    await ownerPage.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      window.__arkTestClipboard = '接入码之前的剪贴板内容';
      document.addEventListener('copy', (event) => {
        const selected = document.activeElement;
        if (selected instanceof HTMLTextAreaElement && selected.closest('[role="dialog"]')) {
          window.__arkTestClipboard = selected.value.slice(
            selected.selectionStart,
            selected.selectionEnd,
          );
          event.preventDefault();
        }
      });
    });
    await enrollmentDialog.getByRole('button', { name: '复制接入码' }).click();
    assert.equal(
      await ownerPage.evaluate(() => window.__arkTestClipboard),
      await enrollmentDialog.getByLabel('一次性接入码').inputValue(),
    );
    await enrollmentDialog.getByRole('button', { name: '关闭', exact: true }).click();
    passed('侧栏顺序与细滚动条、接入弹窗隐藏地址，兼容复制替换旧剪贴板内容');
    const createMap = async (hostId, name, scope, config = {}) =>
      post(
        '/instances',
        {
          hostId,
          name,
          map: 'TheIsland',
          clusterId: 'shared_name',
          gamePort: await availablePort(),
          queryPort: await availablePort(),
          rconPort: await availablePort(),
          autoBranchUpdate: false,
          config,
        },
        scope,
      );
    const mapA = await createMap(hostA.id, '甲公开地图', workspaceA, {
      serverPassword: 'read-only-never-return',
    });
    const hiddenMap = await createMap(hiddenHost.id, '甲保留地图', workspaceA);
    const mapB = await createMap(hostB.id, '乙的地图', workspaceB);
    const disposable = await createMap(hiddenHost.id, '未启动的临时地图', workspaceA);
    const plan = { kind: 'delete', idempotencyKey: randomUUID() };
    const first = await post(`/instances/${disposable.id}/commands`, plan, workspaceA);
    assert.equal(
      (await post(`/instances/${disposable.id}/commands`, plan, workspaceA)).id,
      first.id,
    );
    await createMap(hostB.id, '地图超额', { ...workspaceB, status: 409 });
    const nameOf = (rows) => rows.map(({ name }) => name).sort();
    assert.deepEqual(nameOf((await request('/dashboard', workspaceB)).instances), ['乙的地图']);
    await patch(`/instances/${mapA.id}`, { name: '越权修改' }, { ...workspaceB, status: 404 });
    await post(
      '/management/players',
      { scopeId: 'cluster:shared_name', steamId: '76561198012345678', name: '甲服玩家' },
      workspaceA,
    );
    await post(
      '/management/players',
      { scopeId: 'cluster:shared_name', steamId: '76561198012345678', name: '乙服玩家' },
      workspaceB,
    );
    assert.equal(
      (await request('/management?scopeId=cluster:shared_name', workspaceB)).players[0].name,
      '乙服玩家',
    );
    passed('同名互通组和同一 SteamID 按工作空间隔离，主机和地图上限生效');

    const teamPath = `/workspaces/${own.id}`;
    await ownerPage.goto(`${apiUrl}/team`);
    await ownerPage.getByRole('button', { name: '邀请协管', exact: true }).click();
    await ownerPage.getByRole('checkbox', { name: '查看地图', exact: true }).waitFor();
    await ownerPage.getByRole('button', { name: '取消', exact: true }).click();
    const requestedScope = { scope: { kind: 'map', id: mapA.id }, mask: String(1n << 7n) };
    const hostScope = { scope: { kind: 'host', id: hostA.id, includeMaps: false }, mask: '1' };
    const invitation = await post(
      `${teamPath}/invitations`,
      { email: identity.admin.email, grants: [hostScope, requestedScope] },
      workspaceA,
    );
    const stranger = await post(
      '/auth/register',
      { email: 'stranger@ark.local', name: '第三方', password: 'Outside-scope-password-42' },
      { token: '' },
    );
    await post(
      '/workspaces/accept',
      { code: invitation.code },
      { token: stranger.accessToken, status: 403 },
    );
    await guest.getByLabel('邀请代码').fill(invitation.code);
    await guest.getByRole('button', { name: '接受邀请' }).click();
    await guest.getByRole('heading', { name: '运行概况' }).waitFor();
    const delegated = { ...guestToken, workspace: own.id };
    const snapshot = await request('/dashboard', delegated);
    assert.deepEqual(nameOf(snapshot.hosts), ['甲授权主机']);
    assert.deepEqual(nameOf(snapshot.instances), ['甲公开地图']);
    assert.equal(snapshot.instances[0].config.serverPassword, '');
    assert.equal((await request('/management', delegated)).players.length, 0);
    await request(`${teamPath}/members`, { ...delegated, status: 403 });
    await post('/workspaces/accept', { code: invitation.code }, { ...delegated, status: 403 });
    await patch(`/instances/${mapA.id}`, { name: '没有保存权限' }, { ...delegated, status: 403 });
    await request(`/hosts/${hiddenHost.id}/capacity`, { ...delegated, status: 403 });
    await request('/agent-package/windows', { ...delegated, status: 403 });
    await guest.goto(`${apiUrl}/instances`);
    await guest.getByRole('region', { name: '地图 甲公开地图' }).waitFor();
    assert.equal(await guest.getByRole('region', { name: '地图 甲保留地图' }).count(), 0);
    assert.equal(await guest.getByRole('button', { name: '删除地图' }).count(), 0);
    assert.equal(await guest.getByRole('link', { name: '成员与权限' }).count(), 0);
    assert.equal(
      await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await guest.getByRole('combobox', { name: '当前工作空间' }).click();
    await guest.getByRole('option', { name: '乙的工作空间 · 服主' }).click();
    await guest.getByText('乙的地图', { exact: true }).first().waitFor();
    assert.equal(await guest.getByText('甲公开地图', { exact: true }).count(), 0);
    passed('协管邀请仅匹配受邀账号且只用一次，手机页面和接口只返回获授权的主机、地图与字段');

    await patch(
      `${teamPath}/members/${identity.admin.id}`,
      { grants: [hostScope, { ...requestedScope, mask: String((1n << 7n) | (1n << 9n)) }] },
      workspaceA,
    );
    const receipt = await patch(`/instances/${mapA.id}`, { name: '甲协管改名' }, delegated);
    const audit = await request(`/audit/${receipt.configSave.auditId}`, delegated);
    assert.equal(audit.actorId, identity.admin.id);
    await post(
      `/instances/${hiddenMap.id}/commands`,
      { kind: 'delete', idempotencyKey: randomUUID() },
      { ...delegated, status: 403 },
    );
    await request(`${teamPath}/members/${identity.admin.id}`, { ...workspaceA, method: 'DELETE' });
    await request('/dashboard', { ...delegated, status: 403 });
    passed('已登录协管立即获得新授权、写入实名审计，被移除后立即失去原空间访问权');

    const platformBot = (await request('/dashboard', workspaceA)).bots.find(
      (bot) => bot.platformManaged,
    );
    assert.equal(platformBot.appId, '1999009999');
    const bind = async (scope, openId) => {
      const { code } = await post(`/bots/${platformBot.id}/binding-code`, {}, scope);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const body = {
        op: 0,
        t: 'GROUP_AT_MESSAGE_CREATE',
        id: randomUUID(),
        d: { group_openid: openId, content: `绑定 ${code}` },
      };
      await request(`/qq/webhook/${platformBot.id}`, {
        token: '',
        method: 'POST',
        body,
        headers: {
          'x-bot-appid': platformBot.appId,
          'x-signature-timestamp': timestamp,
          'x-signature-ed25519': callbackSignature(
            'workspace-verification-secret',
            timestamp,
            JSON.stringify(body),
          ),
        },
      });
    };
    await bind(workspaceA, 'test-qq-space-a');
    await bind(workspaceB, 'test-qq-space-b');
    const [groupA] = (await request('/dashboard', workspaceA)).groups;
    const [groupB] = (await request('/dashboard', workspaceB)).groups;
    assert.equal(groupA.openId, 'test-qq-space-a');
    assert.equal(groupB.openId, 'test-qq-space-b');
    await post(
      '/subscriptions',
      {
        customer: '乙',
        instanceId: mapB.id,
        tribeId: '1',
        tribeName: '乙部落',
        botId: platformBot.id,
        groupId: groupA.id,
      },
      { ...workspaceB, status: 400 },
    );
    await post(`/groups/${groupB.id}/test`, {}, workspaceB);
    passed('平台 QQ 机器人由多空间共享，签名回调只绑定接码的空间，群和订阅相互隔离');

    const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
    const baseArchive = join(root, 'artifacts/ArkHostAgent-Windows-x64.zip');
    const baseHash = digest(await readFile(baseArchive));
    const downloaded = await request('/agent-package/windows', workspaceB);
    const packageBytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(packageBytes.length, Number(downloaded.headers.get('content-length')));
    assert.equal(digest(await readFile(baseArchive)), baseHash);
    const archive = join(work, 'ArkHostAgent-Windows-x64.zip');
    await writeFile(archive, packageBytes);
    const kit = join(work, 'kit');
    const extract = launch(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::ExtractToDirectory($env:ARK_VERIFY_AGENT_ARCHIVE, $env:ARK_VERIFY_AGENT_FOLDER)",
      ],
      {
        env: { ...process.env, ARK_VERIFY_AGENT_ARCHIVE: archive, ARK_VERIFY_AGENT_FOLDER: kit },
        label: 'extract-agent',
      },
    );
    assert.equal((await once(extract, 'exit'))[0], 0, '解压 Windows 助手');
    assert.deepEqual(JSON.parse(await readFile(join(kit, 'ArkHostAgent.json'), 'utf8')), {
      apiUrl,
    });
    const state = join(kit, 'state/config.json');
    const runWizard = (code, label) =>
      launch(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          [
            'function global:Read-Host([string]$Prompt, [switch]$AsSecureString) {',
            '  if ($AsSecureString) {',
            '    $arkInput = [System.Security.SecureString]::new()',
            '    foreach ($arkChar in $env:ARK_VERIFY_ENROLL_CODE.ToCharArray()) { $arkInput.AppendChar($arkChar) }',
            '    return $arkInput',
            '  }',
            "  if ($Prompt.StartsWith('游戏工作目录')) { return '' }",
            "  throw ('Unexpected prompt: ' + $Prompt)",
            '}',
            "& (Join-Path $env:ARK_VERIFY_AGENT_FOLDER 'ArkHostAgent.ps1')",
          ].join('\n'),
        ],
        {
          cwd: kit,
          label,
          env: { ...process.env, ARK_VERIFY_AGENT_FOLDER: kit, ARK_VERIFY_ENROLL_CODE: code },
        },
      );
    const invalidCode = 'workspace-invalid-enroll-code-test';
    const failed = runWizard(invalidCode, 'bundle-rejected-enrollment');
    assert.equal((await once(failed, 'exit'))[0], 1);
    const failureLog = await readFile(join(kit, 'state/agent.log'), 'utf8');
    assert.match(failureLog, /接入码无效或已过期/);
    assert.match(failureLog, /退出码 1/);
    assert.ok(!failureLog.includes(invalidCode));
    const realAgent = runWizard(hostB.code, 'bundle-agent');
    const stored = await waitFor(
      async () => JSON.parse(await readFile(state, 'utf8')),
      '助手保存配置',
    );
    assert.equal(stored.hostId, hostB.id);
    assert.equal(stored.apiUrl, apiUrl);
    const agentB = { token: `${stored.hostId}.${stored.token}`, workspace: own.id };
    await waitFor(
      async () => Boolean((await request('/dashboard', workspaceB)).hosts[0]?.metrics),
      '独立助手上报资源',
    );
    const agentSnapshot = await request('/agent/poll', agentB);
    assert.deepEqual(nameOf(agentSnapshot.instances), ['乙的地图']);
    const rawA = await post(
      '/agent/enroll',
      { code: hostA.code, platform: 'windows', agentVersion: '1.1.0' },
      { token: '' },
    );
    const agentA = { token: `${rawA.hostId}.${rawA.token}` };
    const pollA = await request('/agent/poll', agentA);
    assert.equal(pollA.instances.length, 1);
    assert.equal(pollA.instances[0].clusterId, agentSnapshot.instances[0].clusterId);
    assert.notEqual(
      pollA.instances[0].runtimeClusterId,
      agentSnapshot.instances[0].runtimeClusterId,
    );
    await post(
      '/agent/enroll',
      { code: hostB.code, platform: 'windows', agentVersion: '1.1.0' },
      { token: '', status: 401 },
    );
    passed('Windows 下载包写入地址，向导不询问地址，失败会写日志，成功可接入并上报心跳');

    await patch(`/platform/workspaces/${other.id}`, { status: 'suspended' });
    await request('/dashboard', { ...workspaceB, status: 403 });
    await request('/agent/poll', { ...agentB, status: 403 });
    await patch(`/platform/workspaces/${other.id}`, { status: 'active' });
    assert.equal((await request('/agent/poll', agentB)).instances.length, 1);
    await post(`/hosts/${hostB.id}/disconnect`, undefined, workspaceB);
    await waitFor(async () => realAgent.exitCode !== null, 'Windows 助手确认断开并退出');
    assert.equal(realAgent.exitCode, 0);
    assert.deepEqual(errors, []);
    passed('暂停同时撤销账号和助手访问，恢复后原助手凭据继续可用');
  } finally {
    await guest.close();
  }
}
