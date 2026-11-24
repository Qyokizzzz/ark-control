import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeManagedInstance } from './cleanup';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ark-cleanup-test-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const name = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(name) || name.includes('..') || !name.startsWith('ark-cleanup-test-'))
      throw new Error('拒绝清理非测试目录。');
    await rm(resolve(root), { recursive: true, force: true });
  }
});
describe('managed map cleanup', () => {
  it('recycles saves and retains downloaded files without touching neighboring or linked files', async () => {
    const root = await fixture();
    const id = randomUUID();
    const directory = join(root, 'instances', id);
    const saved = join(directory, 'ShooterGame', 'Saved');
    const neighbor = join(root, 'instances', randomUUID());
    const external = await fixture();
    await mkdir(saved, { recursive: true });
    await mkdir(neighbor, { recursive: true });
    await writeFile(join(saved, 'world.ark'), 'saved-world');
    await writeFile(join(directory, 'server.exe'), 'server-files');
    await writeFile(join(neighbor, 'keep.txt'), 'other-map');
    await writeFile(join(external, 'keep.txt'), 'external');
    await symlink(external, join(directory, 'linked-content'), 'junction');
    const result = await removeManagedInstance(root, id, randomUUID());
    expect(await readFile(join(result.savedArchive!, 'world.ark'), 'utf8')).toBe('saved-world');
    expect(await stat(directory).catch(() => null)).toBeNull();
    expect(await readFile(join(result.retainedDirectory!, 'server.exe'), 'utf8')).toBe(
      'server-files',
    );
    expect(await readFile(join(neighbor, 'keep.txt'), 'utf8')).toBe('other-map');
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('external');
  });
  it('can clean an uninstalled map or an already removed private directory', async () => {
    const root = await fixture();
    await expect(removeManagedInstance(root, randomUUID(), randomUUID())).resolves.toEqual({
      savedArchive: null,
      retainedDirectory: null,
    });
  });
  it('rejects traversal and missing identifiers before touching the filesystem', async () => {
    const root = await fixture();
    await writeFile(join(root, 'keep.txt'), 'keep');
    await expect(removeManagedInstance(root, '../..', randomUUID())).rejects.toThrow('标识无效');
    await expect(removeManagedInstance(root, '', randomUUID())).rejects.toThrow('标识无效');
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep');
  });
  it('refuses a redirected parent instead of removing external server files', async () => {
    const root = await fixture();
    const external = await fixture();
    const id = randomUUID();
    await mkdir(join(external, id));
    await writeFile(join(external, id, 'keep.txt'), 'keep');
    await symlink(external, join(root, 'instances'), 'junction');
    await expect(removeManagedInstance(root, id, randomUUID())).rejects.toThrow('符号链接');
    expect(await readFile(join(external, id, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
