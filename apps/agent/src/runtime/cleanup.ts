import { lstat, realpath, rename } from 'node:fs/promises';
import { relative } from 'node:path';
import { atomicJson, ensureSafeParent, inside } from '@/files';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function stat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}
export async function recycleManagedSaved(
  root: string,
  directory: string,
  instanceId: string,
  commandId: string,
) {
  if (!uuid.test(instanceId) || !uuid.test(commandId)) throw new Error('存档回收标识无效。');
  const base = await realpath(root);
  await ensureSafeParent(base, directory);
  const savedArchive = inside(base, 'recycle', `${instanceId}-${commandId}`, 'Saved');
  const saved = inside(directory, 'ShooterGame', 'Saved');
  const directoryInfo = await stat(directory);
  if (!directoryInfo) return (await stat(savedArchive)) ? savedArchive : null;
  if (
    !directoryInfo.isDirectory() ||
    directoryInfo.isSymbolicLink() ||
    relative(directory, await realpath(directory))
  )
    throw new Error('存档所属目录身份无法确认。');
  await ensureSafeParent(base, saved);
  const savedInfo = await stat(saved);
  if (!savedInfo) return (await stat(savedArchive)) ? savedArchive : null;
  if (!savedInfo.isDirectory() || savedInfo.isSymbolicLink())
    throw new Error('存档目录不能是链接或普通文件。');
  await ensureSafeParent(base, savedArchive);
  if (await stat(savedArchive)) throw new Error('存档回收目标已存在，未覆盖任何存档。');
  await rename(saved, savedArchive);
  await atomicJson(inside(base, 'recycle', `${instanceId}-${commandId}`, 'instance.json'), {
    instanceId,
    commandId,
    originalDirectory: directory,
    deletedAt: new Date().toISOString(),
  });
  return savedArchive;
}
export async function removeManagedInstance(root: string, instanceId: string, commandId: string) {
  if (!uuid.test(instanceId) || !uuid.test(commandId)) throw new Error('地图清理标识无效。');
  const base = await realpath(root);
  const directory = inside(base, 'instances', instanceId);
  const retainedDirectory = inside(base, 'server-files', instanceId);
  await ensureSafeParent(base, directory);
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) {
    await ensureSafeParent(base, retainedDirectory);
    const retained = await lstat(retainedDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      retained &&
      (!retained.isDirectory() ||
        retained.isSymbolicLink() ||
        relative(retainedDirectory, await realpath(retainedDirectory)))
    )
      throw new Error('保留文件目录身份无法确认。');
    const priorArchive = inside(base, 'recycle', `${instanceId}-${commandId}`, 'Saved');
    return {
      savedArchive: (await stat(priorArchive)) ? priorArchive : null,
      retainedDirectory: retained ? retainedDirectory : null,
    };
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    relative(directory, await realpath(directory))
  )
    throw new Error('地图目录身份无法确认，已停止清理。');
  const savedArchive = await recycleManagedSaved(base, directory, instanceId, commandId);
  // Move only our checked map directory; downloaded files are managed separately and never purged here.
  await ensureSafeParent(base, directory);
  if ((await lstat(directory)).isSymbolicLink() || relative(directory, await realpath(directory)))
    throw new Error('地图清理目标已变化，已停止清理。');
  await ensureSafeParent(base, retainedDirectory);
  if (await lstat(retainedDirectory).catch(() => null))
    throw new Error('保留文件目标已存在，请先核对文件库，未覆盖任何文件。');
  await rename(directory, retainedDirectory);
  return { savedArchive, retainedDirectory };
}

export async function recycleSharedInstance(root: string, instanceId: string, commandId: string) {
  const base = await realpath(root);
  const directory = inside(base, 'instances', instanceId);
  const savedArchive = await recycleManagedSaved(base, directory, instanceId, commandId);
  if (await stat(directory)) {
    const target = inside(base, 'recycle', `${instanceId}-${commandId}`, 'runtime');
    await ensureSafeParent(base, target);
    if (await stat(target)) throw new Error('地图回收目录已存在，未覆盖本地文件。');
    await rename(directory, target);
  }
  return savedArchive;
}
