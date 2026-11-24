import { mkdir, chmod, copyFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import type { AgentInstance } from '@ark-control/common';
import { STEAM_APP_ID, STEAM_WORKSHOP_APP_ID, gameBranch, workshopMods } from '@ark-control/common';
import { extractZip, inside } from '@/files';
import { runSteamCmd } from '@/program';
import { markInstalledBranch } from '@/runtime/branches';

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function download(url: string, target: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`下载 SteamCMD 失败（${response.status}）。`);
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
    createWriteStream(target),
  );
}
export async function steamCmd(
  root: string,
  report: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const directory = inside(root, 'tools', 'steamcmd');
  await mkdir(directory, { recursive: true });
  const executable = join(directory, process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh');
  if (await exists(executable)) return executable;
  report('正在下载 Valve 官方 SteamCMD。');
  if (process.platform === 'win32') {
    const file = inside(root, 'tools', `steamcmd-${Date.now()}.zip`);
    await download('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip', file, signal);
    await extractZip(file, directory);
  } else {
    const file = inside(root, 'tools', `steamcmd-${Date.now()}.tar.gz`);
    await download(
      'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
      file,
      signal,
    );
    await tar.x({
      file,
      cwd: directory,
      noChmod: true,
      filter: (path, entry) =>
        !path.startsWith('/') &&
        !path.split('/').includes('..') &&
        !('type' in entry && ['SymbolicLink', 'Link'].includes(entry.type)),
    });
    await chmod(executable, 0o755);
    await chmod(join(directory, 'linux32', 'steamcmd'), 0o755);
  }
  return executable;
}
export async function installServer(
  root: string,
  instance: Pick<AgentInstance, 'id' | 'branch'>,
  report: (text: string) => void,
  signal?: AbortSignal,
  logFile?: string,
  targetDirectory?: string,
) {
  const executable = await steamCmd(root, report, signal);
  const directory = targetDirectory ?? inside(root, 'instances', instance.id);
  await mkdir(directory, { recursive: true });
  const diagnosticFiles = [
    'bootstrap_log.txt',
    'stderr.txt',
    'content_log.txt',
    'connection_log.txt',
  ].map((name) => join(dirname(executable), 'logs', name));
  report('正在检查 SteamCMD 自更新与运行环境。');
  await runSteamCmd(executable, ['+quit'], report, signal, {
    label: 'SteamCMD 自更新/初始化',
    logFile,
    diagnosticFiles,
  });
  report('正在下载或更新 ASE 专用服务端，这可能需要较长时间。');
  await runSteamCmd(
    executable,
    [
      '+force_install_dir',
      directory,
      '+login',
      'anonymous',
      '+app_info_update',
      '1',
      '+app_update',
      STEAM_APP_ID,
      '-beta',
      gameBranch(instance.branch),
      'validate',
      '+quit',
    ],
    report,
    signal,
    {
      label: 'SteamCMD 安装/更新服务端',
      logFile,
      diagnosticFiles,
    },
  );
  if (!(await exists(serverExecutableAt(directory))))
    throw new Error('SteamCMD 未生成服务端程序，请检查下载日志和网络。');
  if (process.platform !== 'win32') await chmod(serverExecutableAt(directory), 0o755);
  if (process.platform === 'win32') {
    const modTool = join(directory, 'Engine', 'Binaries', 'ThirdParty', 'SteamCMD', 'Win64');
    await mkdir(modTool, { recursive: true });
    await copyFile(executable, join(modTool, 'steamcmd.exe'));
  }
  await markInstalledBranch(directory, gameBranch(instance.branch));
  report('服务端文件已安装。首次启动仍需确认系统运行库和游戏端口可达。');
}
export async function updateMods(
  root: string,
  instance: AgentInstance,
  report: (text: string) => void,
  signal?: AbortSignal,
  logFile?: string,
) {
  const executable = await steamCmd(root, report, signal);
  for (const id of workshopMods(instance.config)) {
    report(`正在获取 Workshop 模组 ${id}。`);
    await runSteamCmd(
      executable,
      [
        '+login',
        'anonymous',
        '+workshop_download_item',
        STEAM_WORKSHOP_APP_ID,
        id,
        'validate',
        '+quit',
      ],
      report,
      signal,
      {
        label: `SteamCMD 下载模组 ${id}`,
        logFile,
        diagnosticFiles: [
          join(dirname(executable), 'logs', 'bootstrap_log.txt'),
          join(dirname(executable), 'logs', 'stderr.txt'),
        ],
      },
    );
  }
  report(
    'Workshop 下载任务完成；模组解包与加载由下一次启动的 ASE 自动模组管理执行，请检查启动日志。',
  );
}
export function serverExecutable(root: string, id: string) {
  return serverExecutableAt(inside(root, 'instances', id));
}
export function serverExecutableAt(directory: string) {
  return inside(
    directory,
    'ShooterGame',
    'Binaries',
    process.platform === 'win32' ? 'Win64' : 'Linux',
    process.platform === 'win32' ? 'ShooterGameServer.exe' : 'ShooterGameServer',
  );
}
