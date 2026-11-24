import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CONNECT_CORE_VERSION, CONNECT_RUNTIME } from '@ark-control/common';
import type { ConnectionReport, HostConnectionConfig } from '@ark-control/common';
import type { AgentConfig } from '@/config';
import type { AgentClient } from '@/client';
import { atomicJson, checksum, extractZip, filesBelow, inside, readJson } from '@/files';
import { processMatches } from '@/runtime/processes';

const quote = (value: string) => JSON.stringify(value);
export function hostCoreConfig(config: HostConnectionConfig, instanceId: string, rpcPort: number) {
  return (
    [
      `instance_id = ${quote(instanceId)}`,
      `instance_name = "ArkControl"`,
      `ipv4 = ${quote(config.ipv4)}`,
      'dhcp = false',
      'listeners = ["udp://0.0.0.0:0", "tcp://0.0.0.0:0"]',
      `rpc_portal = "127.0.0.1:${rpcPort}"`,
      `tcp_whitelist = ${JSON.stringify(config.tcpPorts.length ? config.tcpPorts.map(String) : ['0'])}`,
      `udp_whitelist = ${JSON.stringify(config.udpPorts.length ? config.udpPorts.map(String) : ['0'])}`,
      '[network_identity]',
      `network_name = ${quote(config.networkName)}`,
      `network_secret = ${quote(config.networkSecret)}`,
      ...config.peers.flatMap((uri) => ['[[peer]]', `uri = ${quote(uri)}`]),
      '[flags]',
      'no_tun = true',
      'enable_encryption = true',
      'enable_ipv6 = true',
      'disable_upnp = true',
      'bind_device = false',
      'relay_network_whitelist = ""',
    ].join('\n') + '\n'
  );
}
interface ActiveCore {
  process: ChildProcess;
  fingerprint: string;
  report: ConnectionReport;
}
interface OwnedCore {
  pid: number;
  executable: string;
  configPath: string;
}
export class ConnectionRuntime {
  private readonly active = new Map<string, ActiveCore>();
  private readonly errors = new Map<string, ConnectionReport>();
  private readonly retryAfter = new Map<string, number>();
  private executable: string | null = null;
  private preparing: Promise<string> | null = null;
  private readonly sessionId = randomUUID();
  private desired: HostConnectionConfig[] = [];
  private syncing: Promise<void> | null = null;
  private owned: Record<string, OwnedCore> = {};
  private saving = Promise.resolve();
  private get ownershipPath() {
    return resolve(this.config.root, 'connect', 'owned-processes.json');
  }
  constructor(
    private readonly config: AgentConfig,
    private readonly client: AgentClient,
  ) {}
  async initialize() {
    const previous = await readJson<Record<string, OwnedCore>>(this.ownershipPath, {});
    const root = resolve(this.config.root, 'connect');
    for (const record of Object.values(previous)) {
      try {
        if (!Number.isSafeInteger(record.pid) || record.pid < 1) continue;
        inside(root, record.executable);
        inside(root, record.configPath);
        if (!(await processMatches(record.pid, record.executable))) continue;
        // Recover only recorded children whose executable still belongs to this host's private runtime.
        process.kill(record.pid);
      } catch {
        /* An already exited process needs no cleanup. */
      }
    }
    await this.persist();
    process.once('exit', () => {
      for (const active of this.active.values()) active.process.kill();
    });
  }
  private persist() {
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => atomicJson(this.ownershipPath, this.owned));
    return this.saving;
  }
  private async prepare(): Promise<string> {
    if (this.executable) return this.executable;
    if (this.preparing) return this.preparing;
    this.preparing = (async () => {
      if (process.platform !== 'win32' || process.arch !== 'x64')
        throw new Error('此版好友联机组件支持 Windows x64。');
      const runtime = CONNECT_RUNTIME.windows;
      const root = resolve(this.config.root, 'connect', CONNECT_CORE_VERSION);
      await mkdir(root, { recursive: true });
      const archive = resolve(root, runtime.file);
      if (!(await stat(archive).catch(() => null)) || (await checksum(archive)) !== runtime.sha256)
        await this.client.downloadConnectionRuntime(archive);
      if ((await checksum(archive)) !== runtime.sha256) throw new Error('联机组件完整性校验失败。');
      const marker = resolve(root, 'ready.json');
      let executable: string | undefined;
      if (await stat(marker).catch(() => null))
        executable = (await filesBelow(root)).find((path) => path.endsWith(runtime.executable));
      if (!executable) {
        const unpacked = resolve(root, `runtime-${randomUUID()}`);
        await extractZip(archive, unpacked, 300 * 1024 ** 2);
        executable = (await filesBelow(unpacked)).find((path) => path.endsWith(runtime.executable));
        if (!executable) throw new Error('联机组件缺少执行文件。');
        await writeFile(marker, JSON.stringify({ version: CONNECT_CORE_VERSION }), { mode: 0o600 });
      }
      this.executable = executable;
      return executable;
    })();
    try {
      return await this.preparing;
    } finally {
      this.preparing = null;
    }
  }
  sync(configs: HostConnectionConfig[]) {
    this.desired = configs;
    if (this.syncing) return;
    this.syncing = (async () => {
      let applied = '';
      while (applied !== JSON.stringify(this.desired)) {
        const next = this.desired;
        applied = JSON.stringify(next);
        await this.reconcile(next);
      }
    })().finally(() => {
      this.syncing = null;
    });
    void this.syncing.catch(() => undefined);
  }
  private async reconcile(configs: HostConnectionConfig[]) {
    const requested = new Set(configs.map((item) => item.networkId));
    for (const id of this.active.keys()) if (!requested.has(id)) await this.stop(id);
    for (const id of this.errors.keys()) if (!requested.has(id)) this.errors.delete(id);
    for (const id of this.retryAfter.keys()) if (!requested.has(id)) this.retryAfter.delete(id);
    for (const config of configs) {
      const fingerprint = JSON.stringify(config);
      const previous = this.active.get(config.networkId);
      if (previous?.fingerprint === fingerprint && previous.process.exitCode === null) continue;
      if ((this.retryAfter.get(config.networkId) ?? 0) > Date.now() && !previous) continue;
      await this.stop(config.networkId);
      try {
        const executable = await this.prepare();
        const directory = resolve(this.config.root, 'connect', 'sessions', this.sessionId);
        await mkdir(directory, { recursive: true });
        const path = resolve(directory, `${config.networkId}.toml`);
        // Explicit ports avoid upstream's default RPC port being reused by another network.
        const rpcPort = await new Promise<number>((yes, no) => {
          const listener = createServer();
          listener.once('error', no);
          listener.listen(0, '127.0.0.1', () => {
            const address = listener.address();
            const value = address && typeof address !== 'string' ? address.port : 0;
            listener.close(() => (value ? yes(value) : no(new Error('无法分配联机管理端口。'))));
          });
        });
        await writeFile(`${path}.tmp`, hostCoreConfig(config, randomUUID(), rpcPort), {
          mode: 0o600,
        });
        await rename(`${path}.tmp`, path);
        const child = spawn(
          executable,
          [
            '-c',
            path,
            '--rpc-portal',
            `127.0.0.1:${rpcPort}`,
            '--no-tun',
            'true',
            '--disable-upnp',
            'true',
          ],
          {
            cwd: directory,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
          },
        );
        const active: ActiveCore = {
          process: child,
          fingerprint,
          report: { networkId: config.networkId, status: 'starting', message: '正在启动联机组件' },
        };
        this.active.set(config.networkId, active);
        const details: string[] = [];
        for (const stream of [child.stdout, child.stderr])
          if (stream) {
            const reader = createInterface({ input: stream });
            reader.on('line', (line) => {
              if (!line.includes('ERROR') && !details.length) return;
              details.push(line.replaceAll(config.networkSecret, '[redacted]').slice(-500));
              if (details.length > 10) details.shift();
            });
          }
        this.errors.delete(config.networkId);
        child.once('spawn', () => {
          active.report = {
            networkId: config.networkId,
            status: 'started',
            message: '组网进程已启动，等待好友连接验证',
          };
          this.owned[config.networkId] = { pid: child.pid!, executable, configPath: path };
          void this.persist().catch(() => undefined);
        });
        const failed = () => {
          if (this.active.get(config.networkId) !== active) return;
          this.active.delete(config.networkId);
          delete this.owned[config.networkId];
          void this.persist().catch(() => undefined);
          this.errors.set(config.networkId, {
            networkId: config.networkId,
            status: 'error',
            message: details.length
              ? `联机组件退出：${details.join(' ').slice(-400)}`
              : '联机组件退出，将在 30 秒后重试。请检查组件文件和端口。',
          });
          this.retryAfter.set(config.networkId, Date.now() + 30000);
        };
        child.once('error', failed);
        child.once('exit', failed);
      } catch (error) {
        this.errors.set(config.networkId, {
          networkId: config.networkId,
          status: 'error',
          message: error instanceof Error ? error.message.slice(0, 500) : '联机组件启动失败。',
        });
        this.retryAfter.set(config.networkId, Date.now() + 30000);
      }
    }
  }
  reports() {
    return [...this.active.values()].map((item) => item.report).concat([...this.errors.values()]);
  }
  private async stop(id: string) {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    if (active.process.exitCode === null)
      await new Promise<void>((yes) => {
        const timer = setTimeout(yes, 3000);
        active.process.once('exit', () => {
          clearTimeout(timer);
          yes();
        });
        active.process.kill();
      });
    delete this.owned[id];
    await this.persist();
  }
  async dispose() {
    this.desired = [];
    await this.syncing;
    for (const id of this.active.keys()) await this.stop(id);
    this.errors.clear();
    this.retryAfter.clear();
    await this.saving;
  }
}
