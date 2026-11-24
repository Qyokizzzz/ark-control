import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { inside } from '@/files';
import { redactText } from '@/privacy';

export const STARTUP_TIMEOUT_MS = 30 * 60_000;
export function startupLogPaths(root: string, instanceId: string) {
  return ['ArkControlProcess.log', 'ShooterGame.log'].map((name) =>
    inside(root, 'instances', instanceId, 'ShooterGame', 'Saved', 'Logs', name),
  );
}
export function redactStartupText(text: string, secrets: string[]) {
  // eslint-disable-next-line no-control-regex -- Strip terminal ANSI sequences from game output.
  let result = text.replace(/\x1b\[[0-9;]*m/g, '');
  result = redactText(result, secrets);
  return (
    result
      .replace(
        /((?:ServerAdminPassword|ServerPassword|RCONPassword)\s*[=:]\s*)[^\s?&;]+/gi,
        '$1[已隐藏]',
      )
      // eslint-disable-next-line no-control-regex -- Remove non-printing bytes before displaying logs.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      .slice(0, 500)
  );
}
interface Cursor {
  position: number;
  identity: string;
  decoder: StringDecoder;
  pending: string;
}
/** Read a bounded amount of new output, preserving split UTF-8 and handling log rotation. */
export class StartupLogReader {
  private readonly cursors = new Map<string, Cursor>();
  constructor(
    private readonly paths: string[],
    private readonly secrets: string[],
  ) {}
  async begin() {
    for (const path of this.paths) {
      const info = await stat(path).catch(() => null);
      this.cursors.set(path, {
        position: info?.size ?? 0,
        identity: info ? `${info.ino}:${info.birthtimeMs}` : '',
        decoder: new StringDecoder('utf8'),
        pending: '',
      });
    }
  }
  async collect(): Promise<string[]> {
    const lines: string[] = [];
    for (const path of this.paths) {
      const file = await open(path, 'r').catch(() => null);
      if (!file) continue;
      try {
        const info = await file.stat();
        const identity = `${info.ino}:${info.birthtimeMs}`;
        let cursor = this.cursors.get(path);
        if (!cursor || cursor.identity !== identity || cursor.position > info.size) {
          cursor = { position: 0, identity, decoder: new StringDecoder('utf8'), pending: '' };
          this.cursors.set(path, cursor);
        }
        let skipped = false;
        if (info.size - cursor.position > 32 * 1024) {
          cursor.position = info.size - 32 * 1024;
          cursor.decoder = new StringDecoder('utf8');
          cursor.pending = '';
          skipped = true;
        }
        const data = Buffer.alloc(Math.max(0, info.size - cursor.position));
        if (!data.length) continue;
        const { bytesRead } = await file.read(data, 0, data.length, cursor.position);
        cursor.position += bytesRead;
        const text = cursor.pending + cursor.decoder.write(data.subarray(0, bytesRead));
        const parts = text.split(/\r?\n|\r/);
        cursor.pending = parts.pop()!.slice(-2000);
        if (skipped) parts.shift();
        for (const line of parts.slice(-10))
          if (line.trim())
            lines.push(`[${basename(path)}] ${redactStartupText(line.trim(), this.secrets)}`);
      } finally {
        await file.close();
      }
    }
    return lines.slice(-10);
  }
}
