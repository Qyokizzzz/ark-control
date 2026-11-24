import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { atomicJson, ensureSafeParent, inside, readJson } from '@/files';

export const managedId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function managedPath(
  root: string,
  group: 'maps' | 'instances' | 'server-files',
  id: string,
) {
  if (!managedId.test(id)) throw new Error('目录标识无效。');
  return inside(root, group, id);
}

export const info = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

export async function ownedDirectory(root: string, path: string, allowMissing = false) {
  await ensureSafeParent(root, path);
  const data = await info(path);
  if (!data && allowMissing) return false;
  if (!data?.isDirectory() || data.isSymbolicLink() || relative(path, await realpath(path)))
    throw new Error('目录身份无法确认，不能通过链接或普通文件管理服务端。');
  return true;
}

type Role = 'walk' | 'directory' | 'file' | 'private' | 'metadata';
const modItem = /^\d+(?:\.mod)?$/i;
const binaries = /^shootergame\/binaries\/(?:win64|linux)$/;
const engineBinaries = /^engine\/binaries(?:\/(?:win64|linux))?$/;
const runtimeBinary = /^(?:shootergameserver(?:\.exe)?|.*\.(?:dll|so(?:\.\d+)*|exe))$/i;
const pluginLoader = /^(?:version|arkapi|winmm|dinput8|d3d9)\.dll$/i;
const projectDescriptor = 'ShooterGame/ShooterGame.uproject';
const packagedAssets = [
  { name: projectDescriptor, kind: 'file' },
  { name: 'ShooterGame/AssetRegistry.bin', kind: 'file' },
  { name: 'ShooterGame/SeekFreeContent', kind: 'directory' },
  { name: 'PackageInfo.bin', kind: 'file' },
  { name: 'Engine/Source', kind: 'directory' },
] as const;

function role(name: string, directory: boolean): Role {
  const path = name.toLowerCase();
  const kind = directory ? 'directory' : 'file';
  if (packagedAssets.some((item) => item.kind === kind && item.name.toLowerCase() === path))
    return kind;
  const segments = path.split('/');
  const leaf = segments.at(-1)!;
  const parent = segments.slice(0, -1).join('/');
  if (['steamapps', '.ark-control-install.json', '.ark-control-view.json'].includes(path))
    return 'metadata';
  if (
    directory &&
    [
      'engine',
      'engine/binaries',
      'engine/binaries/win64',
      'engine/binaries/linux',
      'engine/binaries/thirdparty',
      'shootergame',
      'shootergame/binaries',
      'shootergame/binaries/win64',
      'shootergame/binaries/linux',
      'shootergame/content',
      'shootergame/content/mods',
    ].includes(path)
  )
    return 'walk';
  // ARK and Workshop write into Saved, the platform bin directory, and numeric Mods folders.
  if (
    parent === 'shootergame/content' ||
    (parent === 'shootergame/content/mods' && !modItem.test(leaf))
  )
    return directory ? 'directory' : 'file';
  if (
    (parent === 'engine' && ['config', 'content', 'plugins', 'shaders'].includes(leaf)) ||
    (parent === 'shootergame' && ['config', 'localization', 'plugins'].includes(leaf)) ||
    (parent === 'engine/binaries/thirdparty' && leaf !== 'steamcmd')
  )
    return directory ? 'directory' : 'file';
  if (
    !directory &&
    (engineBinaries.test(parent) || binaries.test(parent)) &&
    runtimeBinary.test(leaf) &&
    !pluginLoader.test(leaf)
  )
    return 'file';
  return 'private';
}

type LayoutItem = { name: string; kind: Exclude<Role, 'walk' | 'metadata'> };
async function* layout(directory: string, prefix = ''): AsyncGenerator<LayoutItem> {
  const current = prefix ? inside(directory, prefix) : directory;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
      throw new Error(`服务端资源包含不支持的链接或文件：${name}`);
    const kind = role(name, entry.isDirectory());
    if (kind === 'walk') yield* layout(directory, name);
    else if (kind !== 'metadata') yield { name, kind };
  }
}

export async function moveLegacyState(root: string, source: string, target: string) {
  await ownedDirectory(root, source);
  await ownedDirectory(root, target, true);
  for await (const item of layout(source)) {
    if (item.kind !== 'private') continue;
    const from = inside(source, item.name);
    const to = inside(target, item.name);
    await ensureSafeParent(root, from);
    await ensureSafeParent(root, to);
    if (await info(to)) throw new Error(`迁移目标已存在，未覆盖原数据：${item.name}`);
    await rename(from, to);
  }
}

interface View {
  assetId: string;
  links: { name: string; kind: 'directory' | 'file'; identity?: string }[];
}
async function readView(root: string, target: string) {
  if (!(await ownedDirectory(root, target, true))) return null;
  const path = inside(target, '.ark-control-view.json');
  const data = await info(path);
  if (data && (!data.isFile() || data.isSymbolicLink() || data.nlink !== 1))
    throw new Error('地图文件引用索引不安全。');
  return readJson<View | null>(path, null);
}

async function fileIdentity(path: string) {
  const value = await lstat(path, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink())
    throw new Error('服务端程序不能通过符号链接引用。');
  return `${value.dev}:${value.ino}`;
}

async function matchesLink(
  source: string,
  target: string,
  kind: 'directory' | 'file',
  identity?: string,
) {
  const targetInfo = await info(target);
  if (!targetInfo) return false;
  if (kind === 'directory') {
    if (!targetInfo.isSymbolicLink()) return false;
    const linked = (await readlink(target)).replace(/^\\\\\?\\/, '');
    return !relative(source, resolve(dirname(target), linked));
  }
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) return false;
  if (identity) return (await fileIdentity(target)) === identity;
  const [a, b] = await Promise.all([fileIdentity(source), fileIdentity(target)]);
  return a === b;
}

// Earlier migrations put these packaged assets back in the original instance.
export async function restorePackagedAssets(
  root: string,
  originalId: string,
  beforeMove: () => Promise<void>,
) {
  const original = managedPath(root, 'instances', originalId);
  const shared = managedPath(root, 'maps', originalId);
  if (!(await ownedDirectory(root, original, true)) || !(await ownedDirectory(root, shared, true)))
    return false;

  const archive = inside(root, 'recycle', `${originalId}-layout-${randomUUID()}`);
  let moved = false;
  for (const { name, kind } of packagedAssets) {
    const from = inside(original, name);
    const to = inside(shared, name);
    await ensureSafeParent(root, from);
    const local = await info(from);
    if (!local || local.isSymbolicLink()) continue;
    const isExpectedType = (data: typeof local) =>
      kind === 'file' ? data.isFile() : data.isDirectory();
    if (!isExpectedType(local)) continue;

    await ensureSafeParent(root, to);
    const packaged = await info(to);
    if (packaged) {
      if (packaged.isSymbolicLink() || !isExpectedType(packaged))
        throw new Error(`共享资源路径异常：${name}。原有文件已保留。`);
      if (await matchesLink(to, from, kind)) continue;
    }
    if (kind === 'file' && local.nlink !== 1) continue;
    const destination = packaged ? inside(archive, name) : to;
    if (!moved) await beforeMove();
    await ensureSafeParent(root, destination);
    if (await info(destination)) throw new Error(`修复目标已存在，未覆盖文件：${name}`);
    await rename(from, destination);
    moved = true;
  }
  return moved;
}

export async function assertProjectDescriptor(root: string, instanceId: string) {
  const descriptor = inside(managedPath(root, 'instances', instanceId), projectDescriptor);
  await ensureSafeParent(root, descriptor);
  const file = await info(descriptor);
  if (!file?.isFile() || file.size === 0)
    throw new Error(
      '服务端缺少 ShooterGame/ShooterGame.uproject。请关闭共用这套文件的地图，在地图详情执行「更新服务端」以校验并补齐同分支文件。',
    );
}

export async function detachView(root: string, instanceId: string, assetId: string) {
  const target = managedPath(root, 'instances', instanceId);
  const source = managedPath(root, 'maps', assetId);
  const view = await readView(root, target);
  if (!view) return;
  if (view.assetId !== assetId || !Array.isArray(view.links))
    throw new Error('地图文件引用记录不匹配，请先检查实例目录。');
  for (const item of view.links) {
    if (
      !['file', 'directory'].includes(item.kind) ||
      role(item.name, item.kind === 'directory') !== item.kind
    )
      throw new Error('地图文件引用索引无效。');
    const destination = inside(target, item.name);
    await ensureSafeParent(root, destination);
    if (!(await info(destination))) continue;
    const origin = inside(source, item.name);
    if (!(await matchesLink(origin, destination, item.kind, item.identity)))
      throw new Error(`地图文件引用已改变，未删除本地文件：${item.name}`);
    // Unlink the entry only. Never walk or recursively remove a linked directory.
    await unlink(destination);
  }
  await unlink(inside(target, '.ark-control-view.json'));
}

async function seedRuntime(root: string, source: string, target: string, item: LayoutItem) {
  const name = item.name.toLowerCase();
  const src = inside(source, item.name);
  const dest = inside(target, item.name);
  if (name.endsWith('/battleye') && binaries.test(name.slice(0, name.lastIndexOf('/')))) {
    await ensureSafeParent(root, dest);
    if (!(await info(dest)))
      await cp(src, dest, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (path) => {
          const data = await lstat(path);
          return !data.isSymbolicLink() && !/\.log$/i.test(path);
        },
      });
    return;
  }
  if (
    (name === 'steam_appid.txt' ||
      (binaries.test(name.slice(0, name.lastIndexOf('/'))) && name.endsWith('/steam_appid.txt'))) &&
    (await info(src))?.isFile()
  ) {
    await ensureSafeParent(root, dest);
    if (!(await info(dest))) await copyFile(src, dest, constants.COPYFILE_EXCL);
  }
}

export async function prepareView(
  root: string,
  instanceId: string,
  assetId: string,
  withMods = false,
) {
  const source = managedPath(root, 'maps', assetId);
  const target = managedPath(root, 'instances', instanceId);
  await ownedDirectory(root, source);
  await ownedDirectory(root, target, true);
  await mkdir(target, { recursive: true });
  await ownedDirectory(root, inside(target, 'ShooterGame', 'Saved'), true);
  const previous = await readView(root, target);
  if (previous && previous.assetId !== assetId)
    throw new Error('此实例仍关联另一套文件，请先解除原文件引用。');
  const links: View['links'] = [];
  for await (const item of layout(source)) {
    if (item.kind === 'private') {
      await seedRuntime(root, source, target, item);
      continue;
    }
    const path = inside(target, item.name);
    await ensureSafeParent(root, path);
    const origin = inside(source, item.name);
    const identity = item.kind === 'file' ? await fileIdentity(origin) : undefined;
    if ((await info(path)) && !(await matchesLink(origin, path, item.kind, identity)))
      throw new Error(`实例中已有同名文件，未覆盖：${item.name}`);
    links.push({ name: item.name, kind: item.kind, identity });
  }
  const existing = new Set(links.map((item) => item.name));
  if (previous?.links.some((item) => !existing.has(item.name)))
    await detachView(root, instanceId, assetId);
  if (withMods && process.platform === 'win32') {
    const mods = inside(target, 'ShooterGame', 'Content', 'Mods');
    if (!(await ownedDirectory(root, mods, true))) await mkdir(mods);
    // Workshop's embedded SteamCMD can self-update; keep its writable bootstrap per instance.
    const rel = 'Engine/Binaries/ThirdParty/SteamCMD/Win64/steamcmd.exe';
    const dest = inside(target, rel);
    await ensureSafeParent(root, dest);
    if (!(await info(dest))) {
      for (const candidate of [
        inside(source, rel),
        inside(root, 'tools', 'steamcmd', 'steamcmd.exe'),
      ]) {
        if (!(await info(candidate))?.isFile()) continue;
        await ensureSafeParent(root, candidate);
        await copyFile(candidate, dest, constants.COPYFILE_EXCL);
        break;
      }
    }
  }
  await atomicJson(inside(target, '.ark-control-view.json'), { assetId, links } satisfies View);
  for (const item of links) {
    const dest = inside(target, item.name);
    if (await info(dest)) continue;
    const origin = inside(source, item.name);
    if (item.kind === 'directory')
      await symlink(origin, dest, process.platform === 'win32' ? 'junction' : 'dir');
    else {
      try {
        await link(origin, dest);
      } catch (error) {
        if (['EXDEV', 'ENOTSUP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw new Error('共享地图文件需要同一磁盘上的工作目录；Windows 请使用本地 NTFS。', {
            cause: error,
          });
        throw error;
      }
    }
  }
}
