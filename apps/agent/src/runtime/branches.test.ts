import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as program from '@/program';
import { installationBranch, parseVdf, queryBranchBuilds } from './branches';
import { installServer } from './install';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(rel) || rel.includes('..') || !rel.startsWith('ark-branch-test-'))
      throw new Error('拒绝清理非测试目录');
    await rm(root, { recursive: true, force: true });
  }
});
async function root() {
  const value = await mkdtemp(join(tmpdir(), 'ark-branch-test-'));
  roots.push(value);
  return value;
}
describe('Steam branch selection', () => {
  it('explicitly selects both the beta and public branch on subsequent updates', async () => {
    const directory = await root();
    const id = randomUUID();
    const tool = join(directory, 'tools/steamcmd');
    await mkdir(tool, { recursive: true });
    await writeFile(
      join(tool, process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh'),
      'fixture',
    );
    const executable = join(
      directory,
      'instances',
      id,
      'ShooterGame/Binaries',
      process.platform === 'win32' ? 'Win64' : 'Linux',
      process.platform === 'win32' ? 'ShooterGameServer.exe' : 'ShooterGameServer',
    );
    await mkdir(join(executable, '..'), { recursive: true });
    await writeFile(executable, 'fixture');
    const run = vi.spyOn(program, 'runSteamCmd').mockResolvedValue();
    await installServer(directory, { id, branch: 'preaquatica' }, () => undefined);
    expect(run.mock.calls.at(-1)?.[1]).toContain('preaquatica');
    expect(await installationBranch(join(directory, 'instances', id))).toBe('preaquatica');
    await installServer(directory, { id, branch: 'public' }, () => undefined);
    expect(run.mock.calls.at(-1)?.[1]).toContain('public');
    expect(await installationBranch(join(directory, 'instances', id))).toBe('public');
  });
  it('parses branch build metadata from full untruncated output', async () => {
    vi.spyOn(program, 'runSteamCmd').mockImplementation(
      async (_file, _args, _report, _signal, options) => {
        options?.onOutput?.(
          'Steam metadata\n"376030" { "depots" { "branches" { "public" { "buildid" "123456" } "preaquatica" { "buildid" "987654" } } } }\n',
        );
      },
    );
    const branches = await queryBranchBuilds('fixture');
    expect(branches.map((value) => [value.branch, value.buildId])).toEqual([
      ['public', '123456'],
      ['preaquatica', '987654'],
    ]);
    expect(parseVdf('"key" { "text" "quoted \\"word\\"" }')).toHaveProperty('key');
  });
  it('does not infer a legacy directory branch from the executable alone', async () => {
    const directory = await root();
    expect(await installationBranch(directory)).toBe('unknown');
    expect(() => parseVdf('"__proto__" { "polluted" "yes" }')).toThrow('键无效');
  });
});
