import { createHash } from 'node:crypto';
import { stat, open } from 'node:fs/promises';
import type {
  AgentInstance,
  AgentManagementTask,
  GameCommerceEvent,
  Json,
  PlayerPresence,
} from '@ark-control/common';
import { atomicJson, filesBelow, inside, readJson } from '@/files';
import type { AgentClient } from '@/client';
import type { AgentConfig } from '@/config';
import { rcon } from '@/rcon';
import { pluginDirectory, publishShop, readShop } from './shop';
import { ManagedFirewall } from './firewall';

export { IndependentShopBridge, checkIndependentShop } from './independent-shop';

type Outcome = {
  status: 'succeeded' | 'failed' | 'uncertain';
  result: Record<string, Json>;
  error: string | null;
};
interface Journal {
  status: 'prepared' | 'mutating' | 'finished';
  outcome?: Outcome;
}
type Sender = (instance: AgentInstance, command: string) => Promise<string>;
const sendDefault: Sender = (instance, command) =>
  rcon(instance.rconPort, instance.rconPassword, command);
export function parsePoints(text: string): number {
  const match = text.trim().match(/^Player has (\d+) points$/i);
  if (!match) throw new Error('ArkShop 未返回可识别余额，请检查插件是否加载及玩家是否进入过游戏。');
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new Error('ArkShop 余额超出支持范围。');
  return value;
}
export function parsePlayerList(text: string) {
  if (!text.trim() || /No Players Connected/i.test(text)) return [];
  const lines = text.trim().split(/\r?\n/);
  const parsed = lines.map((line) => line.match(/^\s*\d+\.\s*(.+),\s*(765\d{14})\s*$/));
  if (parsed.some((match) => !match)) throw new Error('玩家列表格式未知，保留上次采样。');
  return parsed.map((match) => ({ steamId: match![2]!, name: match![1]!.slice(0, 120) }));
}
export function parsePermissionGroups(text: string): string[] {
  if (
    /couldn.t|can.t|unable|not found|failed|error|unknown command|not exist/i.test(text) ||
    !/\bgroups?\b|\bDefault\b/i.test(text)
  )
    throw new Error('Permissions 未返回可识别的权限组，请检查插件与命令版本。');
  return [
    ...new Set(
      text
        .split(/[\s,:;[\]{}()]+/)
        .filter(
          (value) =>
            /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value) &&
            !/^(player|groups?|timed|permanent|has|is|in)$/i.test(value),
        ),
    ),
  ];
}
class Rejected extends Error {}
function expectSuccess(reply: string, pattern: RegExp) {
  if (
    /couldn.t|can.t|unable|not found|failed|error|invalid|not exist|doesn.t|no permissions|unknown command/i.test(
      reply,
    )
  )
    throw new Rejected(reply.slice(0, 600));
  if (pattern.test(reply.trim())) return;
  throw new Error(`插件未返回可识别的成功回执：${reply.trim().slice(0, 500) || '空响应'}`);
}
export class ManagementRuntime {
  private busy = false;
  private outcomes: Record<string, Outcome> | null = null;
  private lastSample = 0;
  private readonly cursors: Record<string, { offset: number; birth: number; remainder: string }> =
    {};
  constructor(
    private readonly config: AgentConfig,
    private readonly client: AgentClient,
    private readonly activeMaps: Set<string>,
    private readonly send: Sender = sendDefault,
  ) {}
  async runTask(task: AgentManagementTask): Promise<Outcome> {
    const path = inside(this.config.root, 'management-journal', `${task.id}.json`);
    const previous = await readJson<Journal | null>(path, null);
    if (previous?.status === 'finished' && previous.outcome) return previous.outcome;
    if (previous?.status === 'mutating')
      return {
        status: 'uncertain',
        result: {},
        error: '助手在操作后重启，禁止重复执行；请核实游戏中的结果。',
      };
    let mutating = false;
    const result: Record<string, Json> = {};
    const checkpoint = async () => {
      mutating = true;
      await atomicJson(path, { status: 'mutating' });
    };
    try {
      await atomicJson(path, { status: 'prepared' });
      const instance = task.instance;
      const ask = (command: string) => this.send(instance, command);
      const steam = task.steamId;
      if (task.kind === 'shop-read')
        Object.assign(result, await readShop(this.config.root, instance.id, this.config.hostId));
      else if (task.kind === 'shop-publish') {
        // Hash validation happens before any write. A crash after the checkpoint is uncertain.
        const current = await readShop(this.config.root, instance.id, this.config.hostId);
        if (current.shopHash !== task.payload.expectedHash)
          throw new Rejected('主机商店配置已改变，请先重新读取。');
        await checkpoint();
        Object.assign(
          result,
          await publishShop(
            this.config.root,
            instance.id,
            task.id,
            task.payload.config as Record<string, Json>,
            String(task.payload.expectedHash),
            this.config.hostId,
          ),
        );
        result.filePublished = true;
        if (instance.status === 'running') {
          result.reloadReply = await ask('ArkShop.Reload');
          expectSuccess(String(result.reloadReply), /success|reload(ed)?/i);
          result.reloaded = true;
        } else result.reloaded = false;
      } else if (task.kind === 'sync') {
        result.balance = parsePoints(await ask(`GetPlayerPoints ${steam}`));
        result.groupsReply = (await ask(`Permissions.PlayerGroups ${steam}`)).slice(0, 2000);
        result.groups = parsePermissionGroups(String(result.groupsReply));
      } else if (task.kind === 'coins') {
        const amount = Number(task.payload.amount);
        const before = parsePoints(await ask(`GetPlayerPoints ${steam}`));
        result.before = before;
        if (
          !Number.isSafeInteger(amount) ||
          !amount ||
          Math.abs(amount) > 100000000 ||
          before + amount < 0 ||
          before + amount > 2147483647
        )
          throw new Rejected('金币变动超限或余额不足，未执行。');
        await checkpoint();
        result.reply = await ask(`ChangePoints ${steam} ${amount}`);
        expectSuccess(String(result.reply), /^Successfully set points$/i);
        result.amount = amount;
        result.balance = parsePoints(await ask(`GetPlayerPoints ${steam}`));
      } else if (task.kind === 'vip-grant' || task.kind === 'vip-revoke') {
        const group = String(task.payload.group);
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(group) || /admin|default|everyone/i.test(group))
          throw new Rejected('VIP 权限组无效。');
        result.beforeGroups = (await ask(`Permissions.PlayerGroups ${steam}`)).slice(0, 2000);
        parsePermissionGroups(String(result.beforeGroups));
        await checkpoint();
        result.reply = await ask(
          task.kind === 'vip-grant'
            ? `Permissions.AddTimed ${steam} ${group} ${Number(task.payload.hours)} 0`
            : `Permissions.RemoveTimed ${steam} ${group}`,
        );
        expectSuccess(String(result.reply), /success|added|removed/i);
        result.groupsReply = (await ask(`Permissions.PlayerGroups ${steam}`)).slice(0, 2000);
        result.group = group;
        result.groups = parsePermissionGroups(String(result.groupsReply));
        result.expiresAt =
          task.kind === 'vip-grant'
            ? new Date(Date.now() + Number(task.payload.hours) * 3600000).toISOString()
            : null;
      } else if (task.kind === 'ban' || task.kind === 'unban') {
        const targets: Record<string, Json> = {
          devices: { status: 'succeeded', message: '后台设备规则已更新，仅覆盖绑定的联机客户端' },
        };
        result.targets = targets;
        const ips = Array.isArray(task.payload.ips)
          ? task.payload.ips.filter((ip): ip is string => typeof ip === 'string')
          : [];
        let errors = false;
        for (const ip of ips) {
          try {
            await checkpoint();
            await this.firewall(task, ip);
            targets[ip] = { status: 'succeeded' };
          } catch (error) {
            targets[ip] = {
              status: 'failed',
              message: error instanceof Error ? error.message : '防火墙操作失败',
            };
            errors = true;
          }
        }
        await checkpoint();
        const reply = await ask(`${task.kind === 'ban' ? 'BanPlayer' : 'UnBanPlayer'} ${steam}`);
        result.reply = reply.slice(0, 2000);
        expectSuccess(reply, /success|banned|unbanned|ban.*removed|already.*ban/i);
        targets.steam = { status: 'succeeded' };
        if (task.kind === 'ban') await ask(`KickPlayer ${steam}`).catch(() => undefined);
        if (errors) throw new Error('部分 IP 规则未应用，请查看逐项结果并核实。');
      }
      const outcome: Outcome = { status: 'succeeded', result, error: null };
      await this.remember(task.id, outcome);
      await atomicJson(path, { status: 'finished', outcome });
      return outcome;
    } catch (error) {
      const outcome: Outcome = {
        status: mutating && !(error instanceof Rejected) ? 'uncertain' : 'failed',
        result,
        error: error instanceof Error ? error.message.slice(0, 2000) : '用户管理操作失败。',
      };
      await this.remember(task.id, outcome);
      await atomicJson(path, { status: 'finished', outcome });
      return outcome;
    }
  }
  private async firewall(task: AgentManagementTask, address: string) {
    return new ManagedFirewall(this.config.root).apply(task, address);
  }
  async release(instanceId: string) {
    return new ManagedFirewall(this.config.root).release(instanceId);
  }
  private async remember(id: string, result: Outcome) {
    this.outcomes ??= await readJson<Record<string, Outcome>>(
      inside(this.config.root, 'management-outcomes.json'),
      {},
    );
    this.outcomes[id] = result;
    await atomicJson(inside(this.config.root, 'management-outcomes.json'), this.outcomes);
  }
  private async flushOutcomes() {
    this.outcomes ??= await readJson<Record<string, Outcome>>(
      inside(this.config.root, 'management-outcomes.json'),
      {},
    );
    for (const [id, result] of Object.entries(this.outcomes)) {
      await this.client.request(`/management/tasks/${id}/ack`, result);
      delete this.outcomes[id];
      await atomicJson(inside(this.config.root, 'management-outcomes.json'), this.outcomes);
    }
  }
  async cycle(instances: AgentInstance[]) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.flushOutcomes();
      for (const task of await this.client.request<AgentManagementTask[]>('/management/poll')) {
        if (this.activeMaps.has(task.instanceId)) continue;
        this.activeMaps.add(task.instanceId);
        let keepAlive: ReturnType<typeof setInterval> | undefined;
        try {
          await this.client.request(`/management/tasks/${task.id}/ack`, { status: 'executing' });
          keepAlive = setInterval(
            () =>
              void this.client
                .request(`/management/tasks/${task.id}/ack`, { status: 'executing' })
                .catch(() => undefined),
            15000,
          );
          const result = await this.runTask(task);
          await this.remember(task.id, result);
          await this.flushOutcomes();
        } finally {
          if (keepAlive) clearInterval(keepAlive);
          this.activeMaps.delete(task.instanceId);
        }
      }
      if (Date.now() - this.lastSample > 30000) {
        this.lastSample = Date.now();
        const samples: PlayerPresence[] = [];
        for (const instance of instances.filter(
          (item) => item.status === 'running' && !this.activeMaps.has(item.id),
        )) {
          try {
            let sample: PlayerPresence = {
              instanceId: instance.id,
              sampledAt: new Date().toISOString(),
              source: 'rcon',
              players: parsePlayerList(await this.send(instance, 'ListPlayers')),
            };
            const bridge = await readJson<PlayerPresence | null>(
              inside(
                this.config.root,
                'instances',
                instance.id,
                'ShooterGame',
                'Saved',
                'Logs',
                'ArkControlPlayers.json',
              ),
              null,
            );
            if (bridge && Date.now() - Date.parse(bridge.sampledAt) < 60000)
              sample = { ...bridge, instanceId: instance.id, source: 'bridge' };
            samples.push(sample);
          } catch {
            /* Leave stale samples to expire instead of reporting a fake empty list. */
          }
        }
        if (samples.length) await this.client.request('/management/presence', { samples });
      }
      await this.collectCommerce(instances);
    } finally {
      this.busy = false;
    }
  }
  private async collectCommerce(instances: AgentInstance[]) {
    const statePath = inside(this.config.root, 'commerce-cursors.json');
    if (!Object.keys(this.cursors).length)
      Object.assign(this.cursors, await readJson(statePath, {}));
    for (const instance of instances) {
      const paths = (await filesBelow(pluginDirectory(this.config.root, instance.id, 'ArkShop')))
        .filter((path) => /\.log$/i.test(path) && /shop|log/i.test(path))
        .slice(-30);
      const serverLogs = inside(
        this.config.root,
        'instances',
        instance.id,
        'ShooterGame',
        'Binaries',
        'Win64',
        'logs',
      );
      paths.push(
        ...(await filesBelow(serverLogs)).filter((path) => /shop.*\.log$/i.test(path)).slice(-30),
      );
      paths.push(
        inside(
          this.config.root,
          'instances',
          instance.id,
          'ShooterGame',
          'Saved',
          'Logs',
          'ArkControlCommerce.jsonl',
        ),
      );
      for (const path of paths) {
        let info;
        try {
          info = await stat(path);
        } catch {
          continue;
        }
        const cursor = this.cursors[path] ?? { offset: 0, birth: info.birthtimeMs, remainder: '' };
        if (info.size < cursor.offset || info.birthtimeMs !== cursor.birth) {
          cursor.offset = 0;
          cursor.birth = info.birthtimeMs;
          cursor.remainder = '';
        }
        if (info.size === cursor.offset) continue;
        const file = await open(path, 'r');
        const bytes = Buffer.alloc(Math.min(262144, info.size - cursor.offset));
        let count = 0;
        try {
          count = (await file.read(bytes, 0, bytes.length, cursor.offset)).bytesRead;
        } finally {
          await file.close();
        }
        const complete = bytes.subarray(0, count).lastIndexOf(10) + 1;
        if (!complete) {
          if (count === bytes.length && count >= 262144)
            throw new Error('商店日志单行超过 256 KB，请检查日志文件。');
          continue;
        }
        const events: GameCommerceEvent[] = [];
        let position = 0;
        while (position < complete) {
          const newline = bytes.indexOf(10, position);
          const line = bytes.subarray(position, newline).toString('utf8').replace(/\r$/, '');
          const event = parseCommerceLine(
            line,
            instance.id,
            `${path}:${cursor.birth}:${cursor.offset + position}`,
          );
          if (event) events.push(event);
          position = newline + 1;
        }
        for (let index = 0; index < events.length; index += 100)
          await this.client.request('/management/events', {
            events: events.slice(index, index + 100),
          });
        this.cursors[path] = {
          offset: cursor.offset + complete,
          birth: cursor.birth,
          remainder: '',
        };
        await atomicJson(statePath, this.cursors);
      }
    }
  }
}
export function parseCommerceLine(
  line: string,
  instanceId: string,
  key: string,
): GameCommerceEvent | null {
  const eventId = createHash('sha256').update(key).digest('hex');
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      /^765\d{14}$/.test(String(value.steamId)) &&
      typeof value.kind === 'string' &&
      typeof value.eventId === 'string' &&
      typeof value.occurredAt === 'string' &&
      !Number.isNaN(Date.parse(value.occurredAt)) &&
      value.detail &&
      typeof value.detail === 'object' &&
      !Array.isArray(value.detail)
    )
      return {
        eventId: value.eventId,
        instanceId,
        steamId: String(value.steamId),
        kind: value.kind,
        occurredAt: value.occurredAt,
        detail: value.detail as Record<string, Json>,
      };
  } catch {
    /* ArkShop's normal log is plain text. Preserve it without guessing the price or delivery. */
  }
  const steam = line.match(/\((765\d{14})\)/)?.[1];
  if (!steam || !/buy|bought|purchase|sold|sell|trade|kit|points/i.test(line)) return null;
  const time = line.match(/\[(\d{4}-\d\d-\d\d [\d:.]+)\]/)?.[1];
  return {
    eventId,
    instanceId,
    steamId: steam,
    kind: 'arkshop-log',
    occurredAt:
      time && !Number.isNaN(Date.parse(time))
        ? new Date(time).toISOString()
        : new Date().toISOString(),
    detail: {
      raw: line.slice(0, 4000),
      coverage: 'ArkShop 已记录的事件；没有记录的扣币无法由余额补全',
    },
  };
}
