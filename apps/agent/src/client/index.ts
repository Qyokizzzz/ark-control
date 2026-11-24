import type { ApiEnvelope } from '@ark-control/common';
import {
  ARKSHOP_UI_PLUGIN_FEATURE,
  CONFIG_SYNC_FEATURE,
  SERVER_PLUGINS_FEATURE,
  SHARED_MAP_FILES_FEATURE,
  independentShopFeature,
} from '@ark-control/common';
import type { AgentConfig } from '@/config';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

export class AgentRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentRequestError';
  }
}
export async function fetchAgentEnvelope<T>(url: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(20000),
    });
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new AgentRequestError(
      'AGENT_CONNECTION_FAILED',
      `无法连接后台 ${new URL(url).origin}${cause ? `（${cause}）` : ''}，请检查后台是否已启动，以及此地址是否能从游戏电脑访问。`,
    );
  }
  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new AgentRequestError(
      'AGENT_RESPONSE_INVALID',
      `后台地址 ${new URL(url).origin} 未返回管理接口数据，请检查地址、端口和反向代理设置。`,
    );
  }
  if (!response.ok || envelope.code !== 'OK')
    throw new AgentRequestError(
      envelope.code ?? 'AGENT_RESPONSE_INVALID',
      `${envelope.message || `请求失败 ${response.status}`}${response.status >= 500 ? `（接口：${new URL(url).pathname}；请求编号：${envelope.requestId ?? '未知'}；请查看后台电脑的 logs/api-errors.log）` : ''}`,
    );
  return envelope.data;
}
export class AgentClient {
  constructor(readonly config: AgentConfig) {}
  async request<T>(path: string, data?: unknown): Promise<T> {
    return fetchAgentEnvelope<T>(`${this.config.apiUrl}/api/agent${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.config.hostId}.${this.config.token}`,
        'content-type': 'application/json',
        'x-ark-agent-features': [
          'server-files-v1',
          SHARED_MAP_FILES_FEATURE,
          CONFIG_SYNC_FEATURE,
          independentShopFeature,
          SERVER_PLUGINS_FEATURE,
          ARKSHOP_UI_PLUGIN_FEATURE,
        ].join(','),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(20000),
    });
  }
  async uploadBackup(commandId: string, file: string, sha256: string, instanceId?: string) {
    const size = (await stat(file)).size;
    const response = await fetch(`${this.config.apiUrl}/api/agent/backups/${commandId}/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.hostId}.${this.config.token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(size),
        'x-backup-sha256': sha256,
        ...(instanceId ? { 'x-backup-instance': instanceId } : {}),
      },
      body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
      duplex: 'half',
      signal: AbortSignal.timeout(3600000),
    } as RequestInit);
    const envelope = (await response.json()) as ApiEnvelope<{ id: string }>;
    if (!response.ok || envelope.code !== 'OK')
      throw new Error(envelope.message || '备份上传失败。');
    return envelope.data;
  }
  async downloadBackup(id: string, target: string): Promise<string> {
    const response = await fetch(`${this.config.apiUrl}/api/agent/backups/${id}/download`, {
      headers: { Authorization: `Bearer ${this.config.hostId}.${this.config.token}` },
      signal: AbortSignal.timeout(3600000),
    });
    if (!response.ok || !response.body) throw new Error('备份下载失败。');
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      createWriteStream(target, { flags: 'wx' }),
    );
    return response.headers.get('x-backup-sha256') ?? '';
  }
  async downloadConnectionRuntime(target: string): Promise<void> {
    const response = await fetch(`${this.config.apiUrl}/api/agent/connections/runtime/windows`, {
      headers: { Authorization: `Bearer ${this.config.hostId}.${this.config.token}` },
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok || !response.body)
      throw new Error('联机组件下载失败，请在后台主机运行 pnpm run build:connect。');
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      createWriteStream(target, { flags: 'w', mode: 0o600 }),
    );
  }

  async downloadPlugin(
    commandId: string,
    pluginId: string,
    target: string,
    size: number,
    signal: AbortSignal,
  ) {
    const response = await fetch(
      `${this.config.apiUrl}/api/agent/server-plugins/tasks/${commandId}/${pluginId}`,
      {
        headers: { Authorization: `Bearer ${this.config.hostId}.${this.config.token}` },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      },
    );
    if (!response.ok || !response.body) {
      const error = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(error?.message ?? '服务端插件安装包下载失败。');
    }
    let received = 0;
    const meter = new Transform({
      transform(bytes: Buffer, _encoding, done) {
        received += bytes.length;
        if (received > size) return done(new Error('服务端插件安装包大小与任务不一致。'));
        done(null, bytes);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      meter,
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (received !== size) throw new Error('服务端插件安装包未下载完整。');
  }
}
