import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StartupLogReader } from './startup';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const name = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(name) || name.includes('..') || !name.startsWith('ark-startup-test-'))
      throw new Error('拒绝清理非测试目录。');
    await rm(resolve(root), { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ark-startup-test-'));
  roots.push(root);
  await mkdir(join(root, 'Logs'));
  const path = join(root, 'Logs/ShooterGame.log');
  return { root, path, reader: new StartupLogReader([path], ['private-password']) };
}
describe('startup log feedback', () => {
  it('ignores the previous run and preserves Chinese split across writes', async () => {
    const item = await fixture();
    await writeFile(item.path, 'OLD READY\n');
    await item.reader.begin();
    const data = Buffer.from('正在加载地图\n');
    await appendFile(item.path, data.subarray(0, 4));
    expect(await item.reader.collect()).toEqual([]);
    await appendFile(item.path, data.subarray(4));
    expect(await item.reader.collect()).toEqual(['[ShooterGame.log] 正在加载地图']);
    expect(await item.reader.collect()).toEqual([]);
  });
  it('handles a missing log followed by creation and rotation', async () => {
    const item = await fixture();
    await item.reader.begin();
    expect(await item.reader.collect()).toEqual([]);
    await writeFile(item.path, 'first\n');
    expect(await item.reader.collect()).toEqual(['[ShooterGame.log] first']);
    await rename(item.path, `${item.path}.old`);
    await writeFile(item.path, 'second\n');
    expect(await item.reader.collect()).toEqual(['[ShooterGame.log] second']);
  });
  it('bounds verbose output and removes management and game passwords', async () => {
    const item = await fixture();
    await item.reader.begin();
    await writeFile(
      item.path,
      'verbose\n'.repeat(20000) +
        'ServerAdminPassword=private-password ServerPassword=another-secret\n',
    );
    const lines = await item.reader.collect();
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.join('\n')).not.toMatch(/private-password|another-secret/);
    expect(lines.at(-1)).toContain('[已隐藏]');
  });
});
