import os from 'node:os';
import { mkdir, realpath, statfs } from 'node:fs/promises';
import { parse, resolve } from 'node:path';
import si from 'systeminformation';
import {
  ARKSHOP_UI_PLUGIN_FEATURE,
  CLUSTER_ADMIN_PASSWORD_FEATURE,
  CONFIG_SYNC_FEATURE,
  SERVER_PLUGINS_FEATURE,
  SHARED_MAP_FILES_FEATURE,
  independentShopFeature,
} from '@ark-control/common';
import type {
  AgentCommand,
  AgentInstance,
  AgentPoll,
  ConsoleEntry,
  ResourceMetrics,
  AgentFileTask,
  BranchBuild,
} from '@ark-control/common';
import {
  argument,
  configPath,
  isRemoteHttp,
  readConfig,
  validateApiUrl,
  workspaceRoot,
  writeConfig,
} from '@/config';
import { AgentClient, AgentRequestError, fetchAgentEnvelope } from '@/client';
import { GameRuntime, delay } from '@/runtime';
import { LogReader } from '@/logs';
import { ConnectionRuntime } from '@/connections';
import { FileLibrary } from '@/server-files';
import { IndependentShopBridge, ManagementRuntime } from '@/management';
import { queryBranchBuilds } from '@/runtime/branches';
import { steamCmd } from '@/runtime/install';
import { redactText } from '@/privacy';

async function enrollmentCode() {
  if (!process.argv.includes('--code-stdin')) return argument('--code');
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 256) throw new Error('一次性接入码格式无效。');
  }
  return input.trim();
}

async function prepareGameRoot(value: string) {
  const path = resolve(value);
  if (path === parse(path).root) throw new Error('请使用专用子目录作为主机工作目录。');
  await mkdir(path, { recursive: true });
  const root = await realpath(path);
  if (root === parse(root).root) throw new Error('主机工作目录不能指向磁盘根目录。');
  return root;
}

async function main() {
  if (!['win32', 'linux'].includes(process.platform))
    throw new Error('主机助手支持 Windows 或 Linux。');
  const enrollment = argument('--enroll');
  if (enrollment) {
    const previous = await readConfig().catch(() => undefined);
    const allowHttp =
      !!previous?.allowHttp && new URL(previous.apiUrl).origin === new URL(enrollment).origin;
    const apiUrl = validateApiUrl(enrollment, allowHttp);
    const code = await enrollmentCode();
    if (!code) throw new Error('请通过 --code 提供后台生成的一次性接入码。');
    const root = await prepareGameRoot(
      argument('--root') ?? previous?.root ?? `${workspaceRoot}/.data/ark-host`,
    );
    await writeConfig(async () => {
      const result = await fetchAgentEnvelope<{ hostId: string; token: string }>(
        `${apiUrl}/api/agent/enroll`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code,
            platform: process.platform === 'win32' ? 'windows' : 'linux',
            agentVersion: '1.1.0',
          }),
          signal: AbortSignal.timeout(15000),
        },
      );
      return {
        apiUrl,
        ...result,
        root,
        clusterRoot: argument('--cluster-root') ?? previous?.clusterRoot,
        allowHttp: isRemoteHttp(apiUrl),
      };
    });
    console.log('主机接入成功，凭据已保存。');
    if (process.argv.includes('--enroll-only')) return;
  }
  const config = await readConfig().catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(
      `尚未接入主机。配置位置：${configPath}。请在后台原主机上点击“重新连接”，执行新接入命令；不需要新建主机。`,
    );
  });
  config.apiUrl = validateApiUrl(config.apiUrl, config.allowHttp);
  config.root = await prepareGameRoot(config.root);
  const client = new AgentClient(config);
  const connections = new ConnectionRuntime(config, client);
  await connections.initialize();
  const consoleEntries: Omit<ConsoleEntry, 'id' | 'createdAt'>[] = [];
  const privateValues = new Map<string, string[]>();
  const log = (instanceId: string, text: string, level: 'info' | 'warn' | 'error' = 'info') => {
    consoleEntries.push({
      instanceId,
      text: redactText(text, privateValues.get(instanceId)).slice(-3000),
      level,
    });
    if (consoleEntries.length > 2000) consoleEntries.shift();
  };
  const activeMaps = new Set<string>();
  const library = new FileLibrary(config, (id) => activeMaps.has(id));
  await library.initialize();
  const runtime = new GameRuntime(config, client, log, library, (id, password) => {
    privateValues.set(id, [password, ...(privateValues.get(id) ?? [])]);
  });
  const management = new ManagementRuntime(config, client, activeMaps);
  const independentShop = new IndependentShopBridge(config.root, client);
  await runtime.initialize();
  const reader = new LogReader(
    config.root,
    (id, text) => log(id, text, 'warn'),
    (id, text) => log(id, text),
  );
  await reader.initialize();
  const running = new Map<string, AbortController>();
  const fileRunning = new Set<string>();
  const fileExecutions = new Set<Promise<void>>();
  let instances: AgentInstance[] = [];
  let stopping = false;
  let lastHeartbeat = 0;
  let connected = false;
  let lastWarnings = '';
  let branchBuilds: BranchBuild[] = [];
  let lastBranchCheck = 0;
  let branchChecking = false;
  let branchWarning = '';
  console.log(`正在连接后台 ${config.apiUrl}；配置：${configPath}；游戏目录：${config.root}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      stopping = true;
      for (const id of fileRunning) running.get(id)?.abort();
      console.log('主机助手将退出，游戏进程保持运行。');
    });
  async function execute(command: AgentCommand) {
    privateValues.set(command.instanceId, [
      command.instance.rconPassword,
      command.instance.config.serverPassword,
    ]);
    const abort = new AbortController();
    running.set(command.id, abort);
    activeMaps.add(command.instanceId);
    let progress = '正在执行';
    let lastProgress = 0;
    try {
      await client.request(`/commands/${command.id}/ack`, { status: 'executing', progress });
      const result = await runtime.execute(command, abort.signal, (text) => {
        progress = text.slice(-1000);
        if (Date.now() - lastProgress > 3000) {
          lastProgress = Date.now();
          void client
            .request(`/commands/${command.id}/ack`, { status: 'executing', progress })
            .catch(() => undefined);
        }
      });
      if (command.kind === 'delete') await management.release(command.instanceId);
      await client.request(`/commands/${command.id}/ack`, {
        status: 'succeeded',
        progress: ['sync-config', 'install-plugins'].includes(command.kind)
          ? progress
          : '任务已完成',
        result,
      });
    } catch (error) {
      const detail =
        error instanceof Error
          ? redactText(error.message, [
              command.instance.rconPassword,
              ...(privateValues.get(command.instanceId) ?? []),
            ])
          : '任务失败。';
      if (!abort.signal.aborted)
        console.error(`[${command.instance.name} · ${command.kind}] ${detail}`);
      await client
        .request(`/commands/${command.id}/ack`, {
          status:
            abort.signal.aborted || (error instanceof Error && error.name === 'AbortError')
              ? 'cancelled'
              : 'failed',
          progress,
          error: detail.slice(0, 3000),
        })
        .catch(() => undefined);
    } finally {
      running.delete(command.id);
      activeMaps.delete(command.instanceId);
    }
  }
  async function executeFile(task: AgentFileTask) {
    const abort = new AbortController();
    running.set(task.id, abort);
    fileRunning.add(task.id);
    let progress = '正在准备文件操作';
    let lastProgress = 0;
    try {
      await client.request(`/file-tasks/${task.id}/ack`, { status: 'executing', progress });
      const result = await library.execute(task, abort.signal, (text) => {
        progress = text.slice(-1000);
        if (Date.now() - lastProgress > 3000) {
          lastProgress = Date.now();
          void client
            .request(`/file-tasks/${task.id}/ack`, { status: 'executing', progress })
            .catch(() => undefined);
        }
      });
      await client.request(`/file-tasks/${task.id}/ack`, {
        status: 'succeeded',
        progress: typeof result.message === 'string' ? result.message : '文件操作已完成',
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '文件操作失败。';
      console.error(`[文件管理 · ${task.kind}] ${message}`);
      await client
        .request(`/file-tasks/${task.id}/ack`, {
          status: abort.signal.aborted ? 'cancelled' : 'failed',
          progress,
          error: message.slice(0, 3000),
        })
        .catch(() => undefined);
    } finally {
      running.delete(task.id);
      fileRunning.delete(task.id);
    }
  }
  while (!stopping) {
    try {
      const data = await client.request<AgentPoll>('/poll');
      if (!connected) console.log(`主机连接成功：${config.apiUrl}`);
      connected = true;
      const warnings = (data.warnings ?? []).join('\n');
      if (warnings && warnings !== lastWarnings) console.error(warnings);
      lastWarnings = warnings;
      instances = data.instances;
      for (const instance of instances)
        privateValues.set(instance.id, [instance.rconPassword, instance.config.serverPassword]);
      library.sync(instances);
      if (!data.disconnectRequested) {
        void independentShop.cycle(instances);
        void management
          .cycle(instances)
          .catch((error: unknown) =>
            console.error('用户管理：', error instanceof Error ? error.message : '采样失败'),
          );
        if (
          !branchChecking &&
          Date.now() - lastBranchCheck > 15 * 60000 &&
          instances.some((instance) => instance.installed && instance.autoBranchUpdate)
        ) {
          branchChecking = true;
          lastBranchCheck = Date.now();
          void library
            .steam(async () => {
              branchBuilds = await queryBranchBuilds(
                await steamCmd(config.root, () => undefined),
                AbortSignal.timeout(120000),
              );
              branchWarning = '';
            }, AbortSignal.timeout(150000))
            .catch((error: unknown) => {
              branchWarning = `Steam 分支检查失败：${error instanceof Error ? error.message : '检查失败'}`;
              console.error(branchWarning);
            })
            .finally(() => {
              branchChecking = false;
            });
        }
      }
      for (const id of data.cancellations) running.get(id)?.abort();
      if (data.disconnectRequested) {
        if (running.size || activeMaps.size) throw new Error('等待本机任务结束后关闭地图并断开。');
        await connections.dispose();
        let error: string | null = null;
        try {
          await runtime.disconnect(instances);
        } catch (failure) {
          error = failure instanceof Error ? failure.message.slice(0, 3000) : '地图关闭失败。';
        }
        if (!error) {
          await reader.collect(instances);
          for (let batch = reader.batch(); batch.length; batch = reader.batch()) {
            await client.request('/events', { events: batch });
            await reader.acknowledge(batch.length);
          }
        }
        await client.request('/disconnect', { instances: await runtime.reports(instances), error });
        if (!error) {
          console.log('全部地图已关闭，联机资源已释放，主机已断开；再次连接需重新接入。');
          stopping = true;
          break;
        }
        console.error(error);
        continue;
      }
      connections.sync(data.connections ?? []);
      for (const command of data.commands) if (!running.has(command.id)) void execute(command);
      for (const task of data.fileTasks ?? [])
        if (!running.has(task.id)) {
          const operation = executeFile(task);
          fileExecutions.add(operation);
          void operation.finally(() => fileExecutions.delete(operation));
        }
      await reader.collect(instances);
      const batch = reader.batch();
      if (batch.length) {
        await client.request('/events', { events: batch });
        await reader.acknowledge(batch.length);
      }
      if (Date.now() - lastHeartbeat > 5000) {
        const [memory, load, volume] = await Promise.all([
          si.mem(),
          si.currentLoad(),
          statfs(config.root).catch(() => null),
        ]);
        const metrics: ResourceMetrics = {
          cpuPercent: Math.max(0, Math.min(100, load.currentLoad)),
          cpuCores: os.cpus().length,
          cpuModel: os.cpus()[0]?.model ?? 'Unknown',
          totalMemoryMb: memory.total / 1024 ** 2,
          freeMemoryMb: memory.available / 1024 ** 2,
          diskFreeGb: volume ? (volume.bavail * volume.bsize) / 1024 ** 3 : 0,
          diskTotalGb: volume ? (volume.blocks * volume.bsize) / 1024 ** 3 : 0,
          gameDiskMeasured: volume !== null && volume.blocks > 0 && volume.bsize > 0,
          sampledAt: new Date().toISOString(),
        };
        const entries = consoleEntries.slice(0, 100);
        await client.request('/heartbeat', {
          features: [
            'server-files-v1',
            SHARED_MAP_FILES_FEATURE,
            CONFIG_SYNC_FEATURE,
            SERVER_PLUGINS_FEATURE,
            ARKSHOP_UI_PLUGIN_FEATURE,
            CLUSTER_ADMIN_PASSWORD_FEATURE,
            'management-v1',
            independentShopFeature,
            'steam-branches-v1',
          ],
          branchBuilds,
          serverFiles: library.reports(),
          filesScanComplete: library.scanComplete(),
          metrics,
          instances: await runtime.reports(instances),
          runningCommands: [...running.keys()],
          warnings: [
            ...(data.warnings ?? []),
            ...(branchWarning ? [branchWarning.slice(0, 1000)] : []),
          ],
          console: entries,
          connections: connections.reports(),
        });
        consoleEntries.splice(0, entries.length);
        lastHeartbeat = Date.now();
      }
    } catch (error) {
      connected = false;
      console.error(error instanceof Error ? error.message : '连接失败，稍后重试。');
      if (
        error instanceof AgentRequestError &&
        ['WORKSPACE_SUSPENDED', 'WORKSPACE_UNAVAILABLE'].includes(error.code)
      )
        connections.sync([]);
      if (error instanceof AgentRequestError && error.code === 'AGENT_UNAUTHORIZED') {
        console.error(
          `旧凭据已失效。请在后台原主机上点击“重新连接”，用新接入码重新接入。原配置：${configPath}`,
        );
        process.exitCode = 1;
        for (const abort of running.values()) abort.abort();
        stopping = true;
      }
    }
    await delay(2500);
  }
  await Promise.allSettled(fileExecutions);
  await connections.dispose();
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '主机助手启动失败。');
  process.exitCode = 1;
});
