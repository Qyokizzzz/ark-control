import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BranchBuild, GameBranch } from '@ark-control/common';
import { STEAM_APP_ID, gameBranch } from '@ark-control/common';
import { runSteamCmd } from '@/program';

type Vdf = { [key: string]: string | Vdf };
export function parseVdf(text: string): Vdf {
  const tokens = [...text.matchAll(/"((?:\\.|[^"\\])*)"|([{}])|([^\s{}"]+)/g)].map((match) =>
    match[1] !== undefined ? match[1].replace(/\\(["\\])/g, '$1') : (match[2] ?? match[3]!),
  );
  let index = 0;
  const object = (depth = 0): Vdf => {
    if (depth > 30) throw new Error('Steam 配置信息嵌套过深。');
    const result: Vdf = {};
    while (index < tokens.length) {
      const key = tokens[index++]!;
      if (key === '}') break;
      const value = tokens[index++];
      if (value === undefined) break;
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error('Steam 配置键无效。');
      result[key] = value === '{' ? object(depth + 1) : value;
    }
    return result;
  };
  return object();
}
export async function installationBranch(directory: string): Promise<GameBranch | 'unknown'> {
  try {
    const marker = JSON.parse(await readFile(join(directory, '.ark-control-install.json'), 'utf8'));
    if (['public', 'preaquatica'].includes(marker.branch)) return marker.branch;
  } catch {
    /* Older directories must be verified instead of guessed. */
  }
  try {
    const text = await readFile(join(directory, 'steamapps/appmanifest_376030.acf'), 'utf8');
    const beta = text.match(/"BetaKey"\s+"([^"]*)"/i)?.[1];
    if (beta === '' || beta === 'public') return 'public';
    if (beta === 'preaquatica') return beta;
  } catch {
    /* No trusted branch metadata. */
  }
  return 'unknown';
}
export async function markInstalledBranch(directory: string, branch: GameBranch) {
  await writeFile(
    join(directory, '.ark-control-install.json'),
    JSON.stringify({ branch, verifiedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
}
export async function queryBranchBuilds(
  executable: string,
  signal?: AbortSignal,
): Promise<BranchBuild[]> {
  let text = '';
  await runSteamCmd(
    executable,
    ['+login', 'anonymous', '+app_info_update', '1', '+app_info_print', STEAM_APP_ID, '+quit'],
    () => undefined,
    signal,
    {
      label: 'Steam 分支更新检查',
      onOutput: (part) => {
        text = (text + part).slice(-2_000_000);
      },
    },
  );
  const start = text.search(/"?376030"?\s*\{/);
  if (start < 0) throw new Error('Steam 未返回专用服务端分支信息。');
  const data = parseVdf(text.slice(start))['376030'] as Vdf | undefined;
  const depots = data?.depots as Vdf | undefined;
  const branches = depots?.branches as Vdf | undefined;
  return (['public', 'preaquatica'] as const).flatMap((branch) => {
    const value = branches?.[branch] as Vdf | undefined;
    return typeof value?.buildid === 'string' && /^\d+$/.test(value.buildid)
      ? [
          {
            branch: gameBranch(branch),
            buildId: value.buildid,
            checkedAt: new Date().toISOString(),
          },
        ]
      : [];
  });
}
