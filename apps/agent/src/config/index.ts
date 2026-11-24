import { randomUUID } from 'node:crypto';
import { readFile, open, mkdir, rename, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';

export interface AgentConfig {
  apiUrl: string;
  hostId: string;
  token: string;
  root: string;
  clusterRoot?: string;
  allowHttp?: boolean;
}
export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
export function agentWorkspaceRoot(entry = process.argv[1], cwd = process.cwd()) {
  const directory = dirname(resolve(entry ?? join(cwd, 'main.js')));
  return ['src', 'dist'].includes(basename(directory)) &&
    basename(dirname(directory)) === 'agent' &&
    basename(dirname(dirname(directory))) === 'apps'
    ? resolve(directory, '../../..')
    : cwd;
}
export const workspaceRoot = agentWorkspaceRoot();
const explicitConfig = argument('--config') ?? process.env.ARK_AGENT_CONFIG;
export const configPath = resolve(explicitConfig ?? join(workspaceRoot, '.data/agent/config.json'));
export function isRemoteHttp(value: string) {
  const url = new URL(value);
  return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
export async function saveAgentConfig(
  path: string,
  config: AgentConfig | (() => Promise<AgentConfig>),
) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      const settings = typeof config === 'function' ? await config() : config;
      await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function loadAgentConfig(
  path: string,
  legacyPaths: string[] = [],
): Promise<AgentConfig> {
  for (const candidate of [path, ...legacyPaths]) {
    let source: string;
    try {
      source = await readFile(candidate, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    let value: AgentConfig;
    try {
      const raw = JSON.parse(source) as AgentConfig;
      if (
        !raw ||
        ![raw.apiUrl, raw.hostId, raw.token, raw.root].every(
          (item) => typeof item === 'string' && item.length > 0,
        )
      )
        throw new Error('invalid');
      // Existing HTTP configuration records the address already chosen during the original enrollment.
      value = { ...raw, allowHttp: raw.allowHttp ?? isRemoteHttp(raw.apiUrl) };
      validateApiUrl(value.apiUrl, value.allowHttp);
    } catch {
      throw new Error(`主机助手配置格式无效，请使用原主机的新接入码修复。配置位置：${candidate}`);
    }
    if (candidate !== path || !source.includes('"allowHttp"')) await saveAgentConfig(path, value);
    return value;
  }
  const error = new Error(`找不到主机助手配置：${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  throw error;
}
export const readConfig = () =>
  loadAgentConfig(
    configPath,
    explicitConfig ? [] : [join(workspaceRoot, 'apps/agent/.data/agent/config.json')],
  );
export const writeConfig = (config: AgentConfig | (() => Promise<AgentConfig>)) =>
  saveAgentConfig(configPath, config);
export function validateApiUrl(value: string, allowHttp = false): string {
  const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol))
    throw new Error('管理地址格式无效。');
  if (
    url.protocol === 'http:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
    !allowHttp &&
    !process.argv.includes('--allow-http')
  )
    throw new Error('远程管理地址请使用 HTTPS；可信内网可显式使用 --allow-http。');
  return url.origin;
}
