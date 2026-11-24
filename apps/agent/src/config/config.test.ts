import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentWorkspaceRoot, loadAgentConfig, saveAgentConfig, validateApiUrl } from './index';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ark-config-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const name = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(name) || name.includes('..') || !name.startsWith('ark-config-test-'))
      throw new Error('拒绝清理非测试目录。');
    await rm(resolve(root), { recursive: true, force: true });
  }
});
const config = (root: string) => ({
  apiUrl: 'http://192.168.1.20:3000',
  hostId: '00000000-0000-4000-8000-000000000001',
  token: 'private-test-token',
  root: join(root, 'ArkLive'),
  clusterRoot: join(root, 'Cluster'),
});
describe('agent reconnect configuration', () => {
  it('uses the project root for compiled and development entry points regardless of current directory', () => {
    const root = resolve('work/project');
    expect(
      agentWorkspaceRoot(join(root, 'apps/agent/dist/main.js'), resolve('work/elsewhere')),
    ).toBe(root);
    expect(
      agentWorkspaceRoot(join(root, 'apps/agent/src/main.ts'), resolve('work/elsewhere')),
    ).toBe(root);
  });
  it('migrates the old pnpm configuration and retains credentials, game paths and trusted HTTP choice', async () => {
    const root = await fixture();
    const old = join(root, 'apps/agent/.data/agent/config.json');
    const target = join(root, '.data/agent/config.json');
    await mkdir(join(root, 'apps/agent/.data/agent'), { recursive: true });
    await writeFile(old, JSON.stringify(config(root)));
    const migrated = await loadAgentConfig(target, [old]);
    expect(migrated).toEqual({ ...config(root), allowHttp: true });
    expect(validateApiUrl(migrated.apiUrl, migrated.allowHttp)).toBe(migrated.apiUrl);
    expect(await loadAgentConfig(target)).toEqual(migrated);
    expect(await readFile(old, 'utf8')).toContain('private-test-token');
  });
  it('requires consent for a new remote HTTP address and accepts the persisted consent on restart', () => {
    expect(() => validateApiUrl('http://192.168.1.20:3000')).toThrow('--allow-http');
    expect(validateApiUrl('http://192.168.1.20:3000', true)).toBe('http://192.168.1.20:3000');
    expect(validateApiUrl('https://ark.example.com')).toBe('https://ark.example.com');
  });
  it('does not replace a damaged explicit configuration with credentials belonging to another host', async () => {
    const root = await fixture();
    const target = join(root, 'agent.json');
    const legacy = join(root, 'legacy.json');
    await writeFile(target, '{ "token": "sensitive-test-token"');
    await writeFile(legacy, JSON.stringify(config(root)));
    const error = await loadAgentConfig(target, [legacy]).catch((value: unknown) => value);
    expect((error as Error).message).toContain('配置格式无效');
    expect((error as Error).message).not.toContain('sensitive-test-token');
    expect(await readFile(target, 'utf8')).toContain('sensitive-test-token');
  });
  it('saves atomically at the selected path without changing game directory or leaving temporary credentials', async () => {
    const root = await fixture();
    const target = join(root, 'agent.json');
    await saveAgentConfig(target, { ...config(root), allowHttp: true });
    await saveAgentConfig(target, { ...config(root), token: 'new-private-token', allowHttp: true });
    expect(await loadAgentConfig(target)).toMatchObject({
      root: config(root).root,
      token: 'new-private-token',
    });
    expect(await readdir(root)).toEqual(['agent.json']);
  });
});
