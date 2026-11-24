import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import type { AgentManagementTask } from '@ark-control/common';
import { CONNECT_CONTROLLER_IP, CONNECT_GAME_IP } from '@ark-control/common';
import { atomicJson, inside, readJson } from '@/files';

type Executor = (file: string, args: string[]) => Promise<unknown>;
const native: Executor = (file, args) =>
  promisify(execFile)(file, args, { windowsHide: true, timeout: 30000 });
const locks = new Map<string, Promise<void>>();
export class ManagedFirewall {
  constructor(
    private readonly root: string,
    private readonly execute: Executor = native,
    private readonly platform = process.platform,
  ) {}
  private async serial<T>(operation: () => Promise<T>) {
    const previous = locks.get(this.root) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((yes) => {
      release = yes;
    });
    locks.set(this.root, next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (locks.get(this.root) === next) locks.delete(this.root);
    }
  }
  private path() {
    return inside(this.root, 'managed-firewall.json');
  }
  private async remove(name: string) {
    if (!/^ArkControl-[a-f0-9-]{36}-[a-f0-9-]{36}-[\d.]+$/i.test(name))
      throw new Error('防火墙规则名称不属于主机助手。');
    const script = `$ErrorActionPreference='Stop'; Get-NetFirewallRule -ErrorAction Stop | Where-Object { $_.DisplayName -ceq '${name}' } | Remove-NetFirewallRule -ErrorAction Stop`;
    await this.execute('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);
  }
  async apply(task: AgentManagementTask, address: string) {
    return this.serial(() => this.applyOwned(task, address));
  }
  private async applyOwned(task: AgentManagementTask, address: string) {
    if (this.platform !== 'win32')
      throw new Error('IP 封禁需要 Windows 主机的防火墙权限；Linux 需要另行适配。');
    if (
      isIP(address) !== 4 ||
      /^(0\.|127\.|169\.254\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(address) ||
      [CONNECT_CONTROLLER_IP, CONNECT_GAME_IP].includes(address)
    )
      throw new Error('拒绝封禁转发网关或无效 IP。');
    if (
      !/^[a-f0-9-]{36}$/i.test(task.instanceId) ||
      !/^[a-f0-9-]{36}$/i.test(String(task.payload.banId))
    )
      throw new Error('封禁规则标识无效。');
    const name = `ArkControl-${task.payload.banId}-${task.instanceId}-${address}`;
    const registry = await readJson<Record<string, string[]>>(this.path(), {});
    if (task.kind === 'unban') {
      await this.remove(name);
      registry[task.instanceId] = (registry[task.instanceId] ?? []).filter((rule) => rule !== name);
      await atomicJson(this.path(), registry);
      return;
    }
    registry[task.instanceId] = [...new Set([...(registry[task.instanceId] ?? []), name])];
    // Persist ownership before changing the OS, so a crash still leaves enough information for cleanup.
    await atomicJson(this.path(), registry);
    try {
      await this.execute('netsh.exe', [
        'advfirewall',
        'firewall',
        'add',
        'rule',
        `name=${name}`,
        'dir=in',
        'action=block',
        'protocol=UDP',
        `localport=${task.instance.gamePort},${task.instance.gamePort + 1},${task.instance.queryPort}`,
        `remoteip=${address}`,
      ]);
    } catch (error) {
      if (typeof (error as { code?: unknown }).code === 'number') {
        registry[task.instanceId] = (registry[task.instanceId] ?? []).filter(
          (rule) => rule !== name,
        );
        await atomicJson(this.path(), registry);
      }
      throw error;
    }
  }
  async release(instanceId: string) {
    return this.serial(() => this.releaseOwned(instanceId));
  }
  private async releaseOwned(instanceId: string) {
    const registry = await readJson<Record<string, string[]>>(this.path(), {});
    const names = registry[instanceId] ?? [];
    for (const name of names) {
      if (!name.includes(`-${instanceId}-`)) throw new Error('拒绝清理其他地图的规则。');
      await this.remove(name);
      registry[instanceId] = registry[instanceId]!.filter((rule) => rule !== name);
      await atomicJson(this.path(), registry);
    }
  }
}
