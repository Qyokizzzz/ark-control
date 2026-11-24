import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyBranches({ api, availablePort, waitFor, passed, connection }) {
  const host = await api(
    '/hosts',
    'POST',
    { name: '分支状态机验收（模拟助手）', address: '127.0.0.1' },
    201,
  );
  const enrolled = await api(
    '/agent/enroll',
    'POST',
    { code: host.code, platform: 'windows', agentVersion: 'branch-fixture' },
    201,
    '',
  );
  const token = `${enrolled.hostId}.${enrolled.token}`;
  const maps = [];
  for (const name of ['A', 'B'])
    maps.push(
      await api(
        '/instances',
        'POST',
        {
          name: `组内更新 ${name}`,
          hostId: host.id,
          map: 'TheIsland',
          clusterId: 'branch-rollout-verification',
          autoBranchUpdate: true,
          gamePort: await availablePort(),
          queryPort: await availablePort(),
          rconPort: await availablePort(),
        },
        201,
      ),
    );
  const scopeId = 'cluster:branch-rollout-verification';
  const ag = (path, body) =>
    api(
      `/agent${path}`,
      body === undefined ? 'GET' : 'POST',
      body,
      body === undefined ? 200 : 201,
      token,
      'shared-map-files-v1',
    );
  let running = true,
    build = '10';
  let target = '20';
  const fileId = randomUUID();
  const heartbeat = () =>
    ag('/heartbeat', {
      features: ['shared-map-files-v1', 'steam-branches-v1'],
      metrics: {
        cpuPercent: 1,
        cpuCores: 16,
        cpuModel: '模拟助手',
        totalMemoryMb: 65536,
        freeMemoryMb: 50000,
        diskFreeGb: 400,
        diskTotalGb: 500,
        sampledAt: new Date().toISOString(),
      },
      instances: maps.map((map, index) => ({
        id: map.id,
        status: running ? 'running' : 'stopped',
        installed: true,
        serverFileId: fileId,
        cpuPercent: 0,
        memoryMb: running ? 1024 : 0,
        pid: running ? 500000 + index : null,
        startedAt: running ? new Date().toISOString() : null,
        lastError: null,
        buildId: build,
      })),
      branchBuilds: [{ branch: 'public', buildId: target, checkedAt: new Date().toISOString() }],
      runningCommands: [],
      console: [],
      connections: [],
    });
  const state = () => api(`/management?${new URLSearchParams({ scopeId })}`);
  const order = [];
  const timer = setInterval(() => void heartbeat().catch(() => undefined), 5000);
  try {
    await heartbeat();
    let rollout = await waitFor(
      async () => (await state()).rollouts.find((item) => item.buildId === target),
      '自动分支更新创建',
      30000,
    );
    for (const [phase, kind] of [
      ['stopping', 'stop'],
      ['updating', 'update'],
      ['starting', 'start'],
    ]) {
      await waitFor(
        async () =>
          (await state()).rollouts.find((item) => item.id === rollout.id)?.phase === phase,
        `分支阶段 ${phase}`,
        30000,
      );
      if (kind === 'update')
        await connection.execute(
          "UPDATE resources SET body=JSON_SET(body,'$.updatedAt',?) WHERE kind='branch-rollouts' AND id=?",
          [new Date(Date.now() - 3600000).toISOString(), rollout.id],
        );
      for (let index = 0; index < (kind === 'update' ? 1 : 2); index++) {
        const task = await waitFor(async () => (await ag('/poll')).commands[0], `领取 ${kind}`);
        assert.equal(task.kind, kind);
        order.push(kind);
        await ag(`/commands/${task.id}/ack`, { status: 'executing', progress: '模拟游戏操作' });
        await ag(`/commands/${task.id}/ack`, {
          status: 'succeeded',
          progress: '模拟回执',
          result:
            kind === 'stop'
              ? { stopped: true }
              : kind === 'update'
                ? { installed: true }
                : { started: true },
        });
      }
      if (kind === 'stop') running = false;
      if (kind === 'update') {
        await new Promise((yes) => setTimeout(yes, 12000));
        assert.equal(
          (await state()).rollouts.find((item) => item.id === rollout.id)?.phase,
          'updating',
        );
        build = target;
        passed('长时间更新完成后重新等待本次回执之后的版本心跳，不使用更新开始时间误判超时');
      }
      if (kind === 'start') running = true;
      await heartbeat();
    }
    await waitFor(
      async () =>
        (await state()).rollouts.find((item) => item.id === rollout.id)?.phase === 'succeeded',
      '整组更新完成',
      30000,
    );
    assert.deepEqual(order, ['stop', 'stop', 'update', 'start', 'start']);
    passed('分支更新状态机：全部停服后共用包只更新一次，确认 BuildID 后恢复原运行地图');
    target = '30';
    await heartbeat();
    rollout = await waitFor(
      async () => (await state()).rollouts.find((item) => item.buildId === target),
      '第二轮分支更新',
      30000,
    );
    const task = await waitFor(async () => (await ag('/poll')).commands[0], '领取失败停服任务');
    await ag(`/commands/${task.id}/ack`, { status: 'failed', error: '模拟 RCON 停服失败' });
    await waitFor(
      async () =>
        (await state()).rollouts.find((item) => item.id === rollout.id)?.phase === 'failed',
      '组内更新失败暂停',
      30000,
    );
    const dashboard = await api('/dashboard');
    assert.equal(
      dashboard.commands.filter(
        (command) =>
          command.createdAt >= rollout.createdAt &&
          maps.some((map) => map.id === command.instanceId) &&
          command.kind === 'update',
      ).length,
      0,
    );
    passed('组内停服失败时暂停后续更新，不自动重复整组发布；保留失败原因');
  } finally {
    clearInterval(timer);
  }
}
