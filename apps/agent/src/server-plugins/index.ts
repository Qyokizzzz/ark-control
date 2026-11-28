import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, realpath, rm, unlink } from 'node:fs/promises';
import { basename, dirname, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  defaultShopMode,
  gameBranch,
  pluginIdSchema,
  pluginPlanSchema,
  requiredPlugins,
  serverPlugins,
} from '@ark-control/common';
import type {
  AgentCommand,
  InstanceReport,
  PluginReport,
  ServerPluginId,
} from '@ark-control/common';
import type { AgentClient } from '@/client';
import { checksum, ensureSafeParent, extractZip, filesBelow, inside } from '@/files';
import { hasServerPdb, info, managedId, managedPath, ownedDirectory } from '@/runtime/layout';
import { serverExecutableAt } from '@/runtime/install';
import type { FileLibrary } from '@/server-files';

const diaDll = 'msdia140.dll';
const execute = promisify(execFile);
const powershell = (command: string) =>
  execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ${command}`,
    ],
    {
      windowsHide: true,
      timeout: 8000,
    },
  ).then(({ stdout }) =>
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );

function directory(win64: string, id: ServerPluginId) {
  return id === 'arkapi' ? win64 : inside(win64, 'ArkApi', 'Plugins', serverPlugins[id].folder);
}

const dllPath = (win64: string, id: ServerPluginId) =>
  inside(directory(win64, id), serverPlugins[id].dll);

async function regularFile(path: string, shareable = false) {
  const file = await info(path);
  return (
    !!file?.isFile() &&
    !file.isSymbolicLink() &&
    (shareable || file.nlink === 1) &&
    !relative(path, await realpath(path))
  );
}

async function installedDia(win64: string) {
  const path = inside(win64, diaDll);
  return (await regularFile(path, true)) && (await isWindowsDll(path));
}

async function installedPlugins(win64: string) {
  const installed = await Promise.all(
    pluginIdSchema.options.map(async (id) => {
      const path = dllPath(win64, id);
      if (!(await regularFile(path)) || !(await isWindowsDll(path))) return null;
      if (id === 'arkapi') {
        const apiFolder = inside(win64, 'ArkApi');
        const folder = await info(apiFolder);
        return folder?.isDirectory() &&
          !folder.isSymbolicLink() &&
          !relative(apiFolder, await realpath(apiFolder)) &&
          (await installedDia(win64))
          ? id
          : null;
      }
      return (await regularFile(inside(directory(win64, id), 'PluginInfo.json'))) ? id : null;
    }),
  );
  return installed.filter((id): id is ServerPluginId => id !== null);
}

async function isWindowsDll(path: string) {
  const file = await open(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    const header = Buffer.alloc(24);
    const { bytesRead } = await file.read(dos, 0, dos.length, 0);
    if (bytesRead === dos.length && dos.readUInt16LE(0) === 0x5a4d) {
      const offset = dos.readUInt32LE(60);
      const result = await file.read(header, 0, header.length, offset);
      if (
        result.bytesRead === header.length &&
        header.readUInt32LE(0) === 0x4550 &&
        header.readUInt16LE(4) === 0x8664 &&
        (header.readUInt16LE(22) & 0x2000) !== 0
      )
        return true;
    }
    return false;
  } finally {
    await file.close();
  }
}

type PluginFile = { source: string; target: string; marker: boolean };
async function packageFiles(win64: string, extracted: string, id: ServerPluginId) {
  const { name, dll } = serverPlugins[id];
  const files = await filesBelow(extracted);
  const markers = files.filter((path) => basename(path).toLowerCase() === dll.toLowerCase());
  if (markers.length !== 1) throw new Error(`${name} 安装包应包含一份 ${dll}。`);
  const marker = markers[0]!;
  if (!(await isWindowsDll(marker))) throw new Error(`${name} 安装包没有有效的 Windows x64 DLL。`);
  const base = dirname(marker);
  if (id !== 'arkapi') {
    const manifest = files.find(
      (path) => dirname(path) === base && basename(path).toLowerCase() === 'plugininfo.json',
    );
    if (!manifest) throw new Error(`${name} 安装包缺少 PluginInfo.json。`);
  }
  const targetDirectory = directory(win64, id);
  const selected = files.flatMap((source): PluginFile[] => {
    const name = relative(base, source).replaceAll('\\', '/');
    if (name.startsWith('../') || !name || name.includes(':')) return [];
    if (
      id === 'arkapi' &&
      source !== marker &&
      !/^config\.json$|^ArkApi\/(?!Plugins\/)/i.test(name)
    )
      return [];
    return [
      {
        source,
        target: source === marker ? dllPath(win64, id) : inside(targetDirectory, name),
        marker: source === marker,
      },
    ];
  });
  if (id === 'arkapi' && !(await installedDia(win64))) {
    const source = files.find(
      (path) => dirname(path) === base && basename(path).toLowerCase() === diaDll,
    );
    if (!source || !(await isWindowsDll(source)))
      throw new Error(
        `ASE ArkApi 安装包缺少有效的 ${diaDll}，请导入包含该文件的 Windows x64 ZIP。`,
      );
    const target = inside(win64, diaDll);
    if (await info(target))
      throw new Error(`当前地图的 ${diaDll} 无效，请备份并移出 Win64 目录后重试。`);
    selected.push({ source, target, marker: false });
  }
  return selected;
}

async function copyNewFiles(
  win64: string,
  backup: string,
  files: PluginFile[],
  signal: AbortSignal,
  confirmStopped: () => Promise<void>,
) {
  const pending: PluginFile[] = [];
  const keys = new Set<string>();
  for (const file of files) {
    signal.throwIfAborted();
    const relativeName = relative(win64, file.target);
    const key = relativeName.toLowerCase();
    if (keys.has(key)) throw new Error(`安装包内存在重复的插件文件：${relativeName}`);
    keys.add(key);
    await ensureSafeParent(win64, file.target);
    if (!(await info(file.target))) {
      pending.push(file);
      continue;
    }
    if (!(await regularFile(file.target, key === diaDll)))
      throw new Error(`无法确认插件文件属于当前地图：${relativeName}`);
    if (file.marker && (await checksum(file.target)) !== (await checksum(file.source)))
      throw new Error(`地图已有不同版本的 ${basename(file.target)}，请先备份并处理现有插件。`);
    if (/\.json$|\.ini$|\.cfg$/i.test(relativeName)) {
      const copy = inside(backup, relativeName);
      await ensureSafeParent(win64, copy);
      await copyFile(file.target, copy, constants.COPYFILE_EXCL);
    }
  }
  await confirmStopped();
  const written: string[] = [];
  try {
    // Copy configuration and dependencies before exposing any DLL to the loader.
    pending.sort((left, right) => Number(left.marker) - Number(right.marker));
    for (const { source, target } of pending) {
      signal.throwIfAborted();
      await copyFile(source, target, constants.COPYFILE_EXCL);
      written.push(target);
    }
    return written;
  } catch (error) {
    await rollback(written);
    throw error;
  }
}

async function rollback(paths: string[]) {
  const removed = await Promise.allSettled(paths.reverse().map((path) => unlink(path)));
  if (removed.some((item) => item.status === 'rejected'))
    throw new Error('安装中断且部分新文件无法回收，请检查这张地图的插件目录。');
}

export class PluginRuntime {
  private readonly reports = new Map<string, PluginReport>();
  private refreshing = false;

  constructor(
    private readonly root: string,
    private readonly client: Pick<AgentClient, 'downloadPlugin'>,
    private readonly files?: Pick<FileLibrary, 'prepare' | 'isBusy'>,
  ) {}

  private win64(id: string) {
    return inside(managedPath(this.root, 'instances', id), 'ShooterGame', 'Binaries', 'Win64');
  }

  private async inspect(id: string, pid: number | null): Promise<PluginReport> {
    const checkedAt = new Date().toISOString();
    const bin = this.win64(id);
    const installed = await installedPlugins(bin);
    const modules =
      pid && Number.isSafeInteger(pid) && pid > 0 && installed.length
        ? await powershell(
            `(Get-Process -Id ${pid} -ErrorAction Stop).Modules | ForEach-Object { $_.FileName }`,
          ).catch(() => null)
        : null;
    const loaded = modules?.length
      ? installed.filter((id) => modules.some((path) => !relative(dllPath(bin, id), path)))
      : null;
    return { checkedAt, pid, installed, loaded };
  }

  current(id: string) {
    return this.reports.get(id);
  }

  refresh(instances: Pick<InstanceReport, 'id' | 'pid' | 'installed'>[]) {
    if (process.platform !== 'win32' || this.refreshing) return;
    const ids = new Set(instances.filter(({ installed }) => installed).map(({ id }) => id));
    for (const id of this.reports.keys()) if (!ids.has(id)) this.reports.delete(id);
    const pending = instances.filter(({ id, pid, installed }) => {
      const previous = this.reports.get(id);
      return (
        installed &&
        (!previous || previous.pid !== pid || Date.now() - Date.parse(previous.checkedAt) > 30000)
      );
    });
    if (!pending.length) return;
    this.refreshing = true;
    void (async () => {
      try {
        for (let index = 0; index < pending.length; index += 4)
          await Promise.allSettled(
            pending.slice(index, index + 4).map(async ({ id, pid }) => {
              const next = await this.inspect(id, pid);
              const previous = this.reports.get(id);
              if (!previous || previous.checkedAt <= next.checkedAt) this.reports.set(id, next);
            }),
          );
      } finally {
        this.refreshing = false;
      }
    })();
  }

  async install(command: AgentCommand, signal: AbortSignal, output: (message: string) => void) {
    if (process.platform !== 'win32') throw new Error('服务端插件需要 Windows ASE。');
    const { instance } = command;
    const plan = pluginPlanSchema.parse(command.payload);
    const selection = plan.items.map(({ pluginId }) => pluginId);
    if (
      plan.branch !== gameBranch(instance.branch) ||
      requiredPlugins(selection).join() !== selection.join()
    )
      throw new Error('地图分支或插件依赖已变化，请重新提交安装。');
    if (!managedId.test(command.id)) throw new Error('安装任务标识无效。');
    const win64 = this.win64(instance.id);
    const instanceDirectory = managedPath(this.root, 'instances', instance.id);
    const executable = serverExecutableAt(instanceDirectory);
    await ownedDirectory(this.root, win64, true);
    const confirmStopped = async () => {
      signal.throwIfAborted();
      if (this.files?.isBusy(instance.id)) throw new Error('此地图的服务端文件正在操作。');
      const processes = await powershell(
        '$ErrorActionPreference = "Stop"; Get-Process | Where-Object { $_.ProcessName -eq "ShooterGameServer" } | ForEach-Object { if ($_.Path) { $_.Path } elseif (-not $_.HasExited) { "unknown" } }',
      ).catch(() => {
        throw new Error('无法检查本机游戏进程，请修复 Windows PowerShell 后重试。');
      });
      if (processes.some((path) => path === 'unknown' || !relative(executable, path)))
        throw new Error('无法确认游戏进程已停，请先停止此地图。');
    };
    await confirmStopped();
    const shop =
      (instance.shopMode ?? defaultShopMode) === 'arkshop' ? 'arkshop' : 'ark-control-shop';
    const opposite = dllPath(win64, shop === 'arkshop' ? 'ark-control-shop' : 'arkshop');
    if (selection.includes(shop) && ((await info(opposite)) || (await info(`${opposite}.ArkApi`))))
      throw new Error('地图仍装有另一种商店插件。请先备份原配置并将旧插件移出 Plugins 目录。');
    if (selection.some((id) => ['arkshop', 'ark-control-shop'].includes(id) && id !== shop))
      throw new Error('地图的商店模式已更换，请刷新后重新安装。');
    const existing = await installedPlugins(win64);
    const prefix = inside(this.root, 'plugin-staging', `${command.id}-`);
    await ensureSafeParent(this.root, prefix);
    const staging = await mkdtemp(prefix);
    try {
      const files: PluginFile[] = [];
      for (const { pluginId, archive } of plan.items) {
        if (existing.includes(pluginId)) continue;
        const { name } = serverPlugins[pluginId];
        if (!archive) throw new Error(`${name} 已从地图移除，请导入对应分支的安装包后重试。`);
        output(`正在准备 ${name}`);
        const zip = inside(staging, `${pluginId}.zip`);
        await this.client.downloadPlugin(command.id, pluginId, zip, archive.size, signal);
        if ((await checksum(zip)) !== archive.sha256) throw new Error(`${name} 安装包校验失败。`);
        const extracted = inside(staging, pluginId);
        await extractZip(zip, extracted, 256 * 1024 ** 2, { signal, maxEntries: 2500 });
        files.push(...(await packageFiles(win64, extracted, pluginId)));
      }
      await confirmStopped();
      if (this.files) {
        await this.files.prepare(
          instance,
          {
            requireArkApiPdb: true,
            logFile: inside(this.root, 'logs', 'steamcmd', `${command.id}.log`),
          },
          output,
          signal,
        );
      }
      if (!(await hasServerPdb(instanceDirectory)))
        throw new Error('地图运行目录缺少 ShooterGameServer.pdb，请校验同分支服务端文件后重试。');
      output('正在安装并核对插件文件');
      if (!(await ownedDirectory(this.root, win64, true))) await mkdir(win64);
      await ensureSafeParent(win64, inside(win64, 'ArkApi', 'Plugins', 'placeholder'));
      const backup = inside(win64, 'ArkControlPluginBackups', command.id);
      const written = await copyNewFiles(win64, backup, files, signal, confirmStopped);
      try {
        const plugins = await this.inspect(instance.id, null);
        if (!selection.every((id) => plugins.installed.includes(id)))
          throw new Error('回读未确认所有选定的插件文件。');
        this.reports.set(instance.id, plugins);
        output('安装完成，启动地图后可验证 DLL 是否加载');
        return { plugins };
      } catch (error) {
        await rollback(written);
        throw error;
      }
    } finally {
      await ownedDirectory(this.root, staging)
        .then(() =>
          rm(inside(this.root, relative(this.root, staging)), { recursive: true, force: true }),
        )
        .catch(() => undefined);
    }
  }
}
