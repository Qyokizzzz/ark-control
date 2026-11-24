import { open, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentInstance, TribeEventInput } from '@ark-control/common';
import { atomicJson, filesBelow, inside, readJson } from '@/files';
import { redactText } from '@/privacy';

interface Cursor {
  offset: number;
  birth: number;
  remainder: string;
}
interface ReaderState {
  cursors: Record<string, Cursor>;
  pending: TribeEventInput[];
}
export function parseTribeLine(line: string): {
  tribeId: string;
  tribeName: string;
  text: string;
  occurredAt: string;
  sourceId?: string;
} | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (
      /^\d{1,20}$/.test(String(value.tribeId)) &&
      typeof value.text === 'string' &&
      value.text.trim()
    )
      return {
        tribeId: String(value.tribeId),
        tribeName: String(value.tribeName || value.tribeId),
        text: value.text,
        occurredAt:
          typeof value.occurredAt === 'string' && !Number.isNaN(Date.parse(value.occurredAt))
            ? new Date(value.occurredAt).toISOString()
            : new Date().toISOString(),
        sourceId: typeof value.sourceId === 'string' ? value.sourceId : undefined,
      };
  } catch {
    /* Native ARK logs are text, plugin output is JSON lines. */
  }
  const match =
    line.match(/Tribe\s+(.+?),\s*(?:ID|Id)\s*[:=]?\s*(\d+)\s*[:：]\s*(.+)/i) ??
    line.match(/TribeLog\s*\[([^\]]+)\]\s*\[(\d+)\]\s*[:：]?\s*(.+)/i);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    tribeName: match[1].trim(),
    tribeId: match[2],
    text: match[3],
    occurredAt: new Date().toISOString(),
  };
}
export class LogReader {
  private state: ReaderState = { cursors: {}, pending: [] };
  private readonly statePath: string;
  private readonly startedAt = Date.now();
  constructor(
    private readonly root: string,
    private readonly report: (instanceId: string, text: string) => void,
    private readonly consoleLine: (instanceId: string, text: string) => void = () => undefined,
  ) {
    this.statePath = inside(root, 'log-cursors.json');
  }
  async initialize() {
    this.state = await readJson(this.statePath, this.state);
  }
  async collect(instances: AgentInstance[]) {
    const owned = new Set(instances.map((item) => item.id));
    this.state.pending = this.state.pending.filter((item) => owned.has(item.instanceId));
    for (const key of Object.keys(this.state.cursors)) {
      const [directory, id] = key.split(/[\\/]/);
      if (directory === 'instances' && id && !owned.has(id)) delete this.state.cursors[key];
    }
    if (this.state.pending.length > 20000) return;
    for (const instance of instances) {
      const directory = inside(this.root, 'instances', instance.id);
      const plugin = join(
        directory,
        'ShooterGame',
        'Binaries',
        'Win64',
        'ArkApi',
        'Plugins',
        'ArkTribeBridge',
        'events.jsonl',
      );
      let paths: string[];
      try {
        await stat(plugin);
        paths = [plugin];
        const processLog = join(directory, 'ShooterGame', 'Saved', 'Logs', 'ArkControlProcess.log');
        try {
          await stat(processLog);
          paths.push(processLog);
        } catch {
          /* Process has not started. */
        }
      } catch {
        paths = (await filesBelow(join(directory, 'ShooterGame', 'Saved', 'Logs'))).filter((file) =>
          /\.(log|txt)$/i.test(file),
        );
      }
      for (const path of paths) await this.readFile(instance, path);
    }
    await atomicJson(this.statePath, this.state);
  }
  private async readFile(instance: AgentInstance, path: string) {
    const info = await stat(path);
    const key = relative(this.root, path);
    let cursor = this.state.cursors[key];
    if (!cursor || cursor.birth !== info.birthtimeMs || info.size < cursor.offset) {
      // First discovery starts at EOF: subscribing does not flood a group with historical logs.
      cursor = {
        offset: cursor || info.birthtimeMs >= this.startedAt ? 0 : info.size,
        birth: info.birthtimeMs,
        remainder: '',
      };
      this.state.cursors[key] = cursor;
    }
    if (info.size === cursor.offset) return;
    const handle = await open(path, 'r');
    try {
      const size = Math.min(1024 * 1024, info.size - cursor.offset);
      const buffer = Buffer.alloc(size);
      const carry = Buffer.from(cursor.remainder, 'base64');
      const start = cursor.offset - carry.length;
      const { bytesRead } = await handle.read(buffer, 0, size, cursor.offset);
      cursor.offset += bytesRead;
      const combined = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const lastNewline = combined.lastIndexOf(10);
      const text = lastNewline < 0 ? '' : combined.subarray(0, lastNewline + 1).toString('utf8');
      const lines = text.split('\n');
      lines.pop();
      cursor.remainder = combined.subarray(lastNewline + 1).toString('base64');
      let offset = start;
      for (const line of lines) {
        if (basename(path) === 'ArkControlProcess.log') {
          if (line.trim())
            this.consoleLine(
              instance.id,
              redactText(line, [instance.rconPassword, instance.config.serverPassword]).slice(
                0,
                3000,
              ),
            );
          offset += Buffer.byteLength(line, 'utf8') + 1;
          continue;
        }
        const parsed = parseTribeLine(line);
        if (parsed) {
          const source =
            parsed.sourceId ??
            createHash('sha256')
              .update(`${key}:${info.birthtimeMs}:${offset}:${line}`)
              .digest('hex');
          this.state.pending.push({
            sourceId: source,
            instanceId: instance.id,
            tribeId: parsed.tribeId,
            tribeName: parsed.tribeName,
            text: redactText(parsed.text, [instance.rconPassword, instance.config.serverPassword]),
            occurredAt: parsed.occurredAt,
          });
        } else if (/Tribe|部落/i.test(line) && !/ServerRCON|commandline|command line/i.test(line))
          this.report(
            instance.id,
            '发现无法识别归属的部落日志，请检查日志格式或安装 ArkTribeBridge；该行未分发到其他部落。',
          );
        offset += Buffer.byteLength(line, 'utf8') + 1;
      }
      if (cursor.remainder.length > 1024 * 1024) {
        this.report(instance.id, `日志 ${basename(path)} 存在过长的未完成行，已暂停读取以便排查。`);
        throw new Error('日志单行长度异常。');
      }
    } finally {
      await handle.close();
    }
  }
  batch(): TribeEventInput[] {
    const items: TribeEventInput[] = [];
    let bytes = 0;
    for (const item of this.state.pending) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length >= 100 || (items.length > 0 && bytes + size > 2 * 1024 * 1024)) break;
      items.push(item);
      bytes += size;
    }
    return items;
  }
  async acknowledge(count: number) {
    this.state.pending.splice(0, count);
    await atomicJson(this.statePath, this.state);
  }
}
