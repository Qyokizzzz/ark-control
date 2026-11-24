import assert from 'node:assert/strict';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import dgram from 'node:dgram';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function findCore(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === 'easytier-core.exe') return path;
    if (entry.isDirectory()) {
      const result = await findCore(path);
      if (result) return result;
    }
  }
}
function fakeUdp(port, query = false) {
  const socket = dgram.createSocket('udp4');
  const pending = new Set();
  const infoRequest = Buffer.concat([
    Buffer.from([255, 255, 255, 255, 0x54]),
    Buffer.from('Source Engine Query\0'),
  ]);
  const challenge = Buffer.from([1, 47, 3, 91]);
  const challengedRequest = Buffer.concat([infoRequest, challenge]);
  const infoReply = Buffer.concat([
    Buffer.from([255, 255, 255, 255, 0x49, 17]),
    Buffer.from('ARK verification\0'),
  ]);
  socket.on('close', () => {
    for (const timer of pending) clearTimeout(timer);
  });
  socket.on('message', (packet, remote) => {
    if (!query || packet.toString() === 'ark-game-udp') {
      socket.send(query ? infoReply : packet, remote.port, remote.address);
      return;
    }
    let response;
    if (packet.equals(infoRequest))
      response = Buffer.concat([Buffer.from([255, 255, 255, 255, 0x41]), challenge]);
    else if (packet.equals(challengedRequest)) response = infoReply;
    else return;
    // A healthy relay can deliver both A2S replies beyond the previous 1.2-second cutoff.
    const timer = setTimeout(() => {
      pending.delete(timer);
      socket.send(response, remote.port, remote.address);
    }, 1500);
    pending.add(timer);
  });
  return new Promise((yes, no) => {
    socket.once('error', no);
    socket.bind(port, '127.0.0.1', () => yes(socket));
  });
}
function udpRoundTrip(port, timeout = 1800) {
  const socket = dgram.createSocket('udp4');
  return new Promise((yes) => {
    const timer = setTimeout(() => {
      socket.close();
      yes(null);
    }, timeout);
    socket.once('message', (message) => {
      clearTimeout(timer);
      socket.close();
      yes(message);
    });
    socket.send(Buffer.from('ark-game-udp'), port, '127.0.0.2');
  });
}
export async function verifyConnections(context) {
  const {
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
  } = context;
  const directory = resolve(work, 'connections');
  await mkdir(directory, { recursive: true });
  let network, hub, player;
  let playerOutput = '';
  const sockets = [];
  try {
    const hubPort = await availablePort();
    network = await api(
      '/connections',
      'POST',
      {
        name: '好友联机验收',
        controllerHostId: host.id,
        instanceId: instance.id,
        peers: [`tcp://127.0.0.1:${hubPort}`],
        enabled: true,
      },
      201,
    );
    const state = await api('/connections');
    assert.equal(state.launcherReady, true);
    const invite = await api(
      `/connections/${network.id}/invites`,
      'POST',
      { name: '验收好友', autoLaunch: false },
      201,
    );
    assert.equal('token' in invite, false);
    assert.equal('tokenHash' in invite, false);
    const response = await fetch(`${apiUrl}/api/connections/invites/${invite.id}/download`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const magic = Buffer.from('ARKCONNECT-V1-END');
    assert.equal(bytes.subarray(-magic.length).toString(), magic.toString());
    const size = bytes.readUInt32LE(bytes.length - magic.length - 4);
    const bootstrap = JSON.parse(
      bytes.subarray(bytes.length - magic.length - 4 - size, bytes.length - magic.length - 4),
    );
    assert.equal(bootstrap.networkId, network.id);
    assert.equal('privateKey' in bootstrap, false);
    assert.equal('rconPassword' in bootstrap, false);
    const manifestResponse = await fetch(`${apiUrl}/api/connect/${invite.id}/manifest`, {
      headers: { 'X-Connect-Key': bootstrap.inviteToken },
    });
    assert.equal(manifestResponse.status, 200);
    const signed = (await manifestResponse.json()).data;
    assert.equal(
      verify(
        'RSA-SHA256',
        Buffer.from(signed.payload, 'base64'),
        createPublicKey({ key: { kty: 'RSA', ...bootstrap.publicKey }, format: 'jwk' }),
        Buffer.from(signed.signature, 'base64'),
      ),
      true,
    );
    assert.equal(
      (
        await fetch(`${apiUrl}/api/connect/${invite.id}/manifest`, {
          headers: { 'X-Connect-Key': 'wrong-token' },
        })
      ).status,
      401,
    );
    await api('/connections', 'GET', undefined, 401, '');
    passed('好友联机包下载、最小权限凭据和签名地址验证');

    await waitFor(
      async () =>
        (await dashboard()).hosts
          .find((item) => item.id === host.id)
          ?.connections?.some((item) => item.networkId === network.id && item.status === 'started'),
      '主机组网组件启动',
      60000,
    );
    const executable = await waitFor(
      () => findCore(resolve(hostRoot, 'connect')),
      '主机自动下载并校验联机核心',
      60000,
    );
    const hubConfig = join(directory, 'hub.toml');
    await writeFile(
      hubConfig,
      `instance_id="${randomUUID()}"\nlisteners=["tcp://127.0.0.1:${hubPort}"]\nrpc_portal="127.0.0.1:0"\n[network_identity]\nnetwork_name="verification-public-node"\nnetwork_secret="verification-only"\n[flags]\nno_tun=true\nbind_device=false\ndisable_upnp=true\n`,
    );
    hub = launch(executable, ['-c', hubConfig], { cwd: directory, label: 'connect-shared-node' });
    for (const port of [instance.gamePort, instance.gamePort + 1])
      sockets.push(await fakeUdp(port));
    sockets.push(await fakeUdp(instance.queryPort, true));
    const playerPath = join(directory, 'ArkConnect-friend.exe');
    await writeFile(playerPath, bytes);
    player = launch(
      playerPath,
      [
        '--headless',
        '--no-launch',
        '--loopback',
        '127.0.0.2',
        '--state-dir',
        join(directory, 'friend-state'),
        '--duration',
        '240',
      ],
      { cwd: directory, label: 'connect-player' },
    );
    player.stdout.on('data', (part) => {
      playerOutput += part.toString();
    });
    await waitFor(
      async () => {
        const reply = await udpRoundTrip(instance.queryPort);
        return reply?.[4] === 0x49;
      },
      '好友客户端免网卡自动获取地址并完成 UDP 查询',
      60000,
    );
    for (const port of [instance.gamePort, instance.gamePort + 1])
      assert.equal((await udpRoundTrip(port))?.toString(), 'ark-game-udp');
    await waitFor(
      () => playerOutput.includes('READY revision=1 '),
      '客户端实际确认游戏可连接',
      20000,
    );
    passed('真实 EasyTier 无虚拟网卡联机，游戏/附加/查询三个 UDP 端口双向通过');
    passed('Steam 查询质询和信息回包各延迟 1.5 秒，联机客户端仍能确认可连接');

    // Move the target to a second, independently enrolled host; keep the original player EXE running.
    const targetHost = await api(
      '/hosts',
      'POST',
      { name: '联机迁移目标主机', address: '127.0.0.1' },
      201,
    );
    const enrolled = await api(
      '/agent/enroll',
      'POST',
      { code: targetHost.code, platform: 'windows', agentVersion: '1.0.0' },
      201,
      '',
    );
    const targetRoot = join(directory, 'target-host');
    const agentConfig = join(directory, 'target-agent.json');
    await writeFile(
      agentConfig,
      JSON.stringify({ apiUrl, hostId: targetHost.id, token: enrolled.token, root: targetRoot }),
    );
    const startTargetAgent = () =>
      launch(process.execPath, [join(root, 'apps/agent/dist/main.js'), '--config', agentConfig], {
        cwd: root,
        label: 'connect-target-agent',
      });
    let targetAgent = startTargetAgent();
    const gamePort = await availablePort(),
      queryPort = await availablePort();
    const targetMap = await api(
      '/instances',
      'POST',
      {
        hostId: targetHost.id,
        name: '迁移后的仙境',
        map: 'Ragnarok',
        gamePort,
        queryPort,
        rconPort: await availablePort(),
        autoRestart: false,
      },
      201,
    );
    for (const port of [gamePort, gamePort + 1]) sockets.push(await fakeUdp(port));
    sockets.push(await fakeUdp(queryPort, true));
    network = await api(`/connections/${network.id}`, 'PATCH', {
      ...network,
      instanceId: targetMap.id,
    });
    await waitFor(
      async () => (await udpRoundTrip(queryPort))?.[4] === 0x49,
      '同一个好友客户端跟随新主机虚拟地址',
      60000,
    );
    assert.equal((await udpRoundTrip(gamePort))?.toString(), 'ark-game-udp');
    await waitFor(
      () => playerOutput.includes(`READY revision=${network.revision} `),
      '客户端实际确认新主机游戏可连接',
      20000,
    );
    assert.equal(await udpRoundTrip(instance.queryPort, 1000), null);
    passed('后台热切换至第二台主机和地图，原客户端自动改用新地址且旧端口关闭');
    const ownershipPath = join(targetRoot, 'connect', 'owned-processes.json');
    const previousCore = JSON.parse(await readFile(ownershipPath, 'utf8'))[network.id];
    assert.ok(previousCore?.pid);
    const exitedTarget = new Promise((yes) => targetAgent.once('exit', yes));
    targetAgent.kill();
    await exitedTarget;
    targetAgent = startTargetAgent();
    await waitFor(
      async () => {
        const records = JSON.parse(await readFile(ownershipPath, 'utf8'));
        return records[network.id]?.pid && records[network.id].pid !== previousCore.pid;
      },
      '助手重新启动并清理旧组网进程',
      25000,
    );
    let oldCoreAlive = true;
    try {
      process.kill(previousCore.pid, 0);
    } catch {
      oldCoreAlive = false;
    }
    assert.equal(oldCoreAlive, false);
    await waitFor(
      async () => (await udpRoundTrip(queryPort))?.[4] === 0x49,
      '好友客户端自动恢复助手重启后的游戏通道',
      30000,
    );
    passed('助手重启核对并清理旧组网进程，原好友客户端自动恢复');

    network = await api(`/connections/${network.id}`, 'PATCH', { ...network, enabled: false });
    await waitFor(
      () => playerOutput.includes(`TARGET revision=${network.revision} `),
      '客户端接收暂停配置并关闭游戏通道',
      20000,
    );
    assert.equal(await udpRoundTrip(queryPort, 1000), null);
    network = await api(`/connections/${network.id}`, 'PATCH', { ...network, enabled: true });
    await waitFor(
      async () => (await udpRoundTrip(queryPort))?.[4] === 0x49,
      '恢复开放后原客户端自动连接',
      45000,
    );
    passed('暂停关闭游戏通道，恢复后原联机包自动重连');

    await api(`/connections/invites/${invite.id}`, 'PATCH', { enabled: false });
    await waitFor(() => player.exitCode !== null, '停用联机包后标准客户端自动退出组网', 20000);
    assert.equal(await udpRoundTrip(queryPort, 1000), null);
    passed('停用联机凭据后客户端停止游戏转发并清理自己的组网进程');
    return { network, invite, targetMap };
  } catch (error) {
    const core = await findCore(join(directory, 'friend-state')).catch(() => null);
    const configuration = await readFile(
      join(directory, 'friend-state', 'core.toml'),
      'utf8',
    ).catch(() => '');
    const rpc = configuration.match(/rpc_portal = "([\d.:]+)"/)?.[1];
    const debug = {
      error: error.message,
      state: await dashboard().catch(() => null),
      playerOutput,
    };
    if (core && rpc) {
      debug.routes = spawnSync(
        core.replace('easytier-core.exe', 'easytier-cli.exe'),
        ['-p', rpc, '-o', 'json', 'route'],
        { windowsHide: true, encoding: 'utf8', timeout: 10000 },
      ).stdout;
      debug.forwards = spawnSync(
        core.replace('easytier-core.exe', 'easytier-cli.exe'),
        ['-p', rpc, '-o', 'json', 'port-forward', 'list'],
        { windowsHide: true, encoding: 'utf8', timeout: 10000 },
      ).stdout;
    }
    await writeFile(join(directory, 'failure-details.json'), JSON.stringify(debug, null, 2));
    throw error;
  } finally {
    player?.kill();
    if (network) {
      await api(`/connections/${network.id}`, 'DELETE').catch(() => undefined);
      // Both agents receive the removal before the verifier shuts them down.
      await waitFor(
        async () =>
          (await dashboard()).hosts.every(
            (item) => !item.connections?.some((entry) => entry.networkId === network.id),
          ),
        '联机进程清理',
        20000,
      ).catch(() => undefined);
    }
    hub?.kill();
    for (const socket of sockets) socket.close();
  }
}
