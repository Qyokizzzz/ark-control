import { createHash } from 'node:crypto';
import { readFile, copyFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '@ark-control/common';
import { publicShopConfig, validateShopConfig } from '@ark-control/common';
import { ensureSafeParent, inside } from '@/files';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function parsePlugin(text: string, plugin: string): Record<string, Json> {
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('object required');
    return value as Record<string, Json>;
  } catch {
    throw new Error(`${plugin} 配置不是有效的 JSON 对象，请在游戏主机修复后重新读取。`);
  }
}
export const pluginDirectory = (root: string, id: string, plugin: string) =>
  inside(root, 'instances', id, 'ShooterGame', 'Binaries', 'Win64', 'ArkApi', 'Plugins', plugin);
export function databaseSignature(
  config: Record<string, Json>,
  plugin: 'ArkShop' | 'Permissions',
  hostIdentity?: string,
): string | null {
  const mysql = config.Mysql as Record<string, Json> | undefined;
  const enabled = plugin === 'ArkShop' ? !!mysql?.UseMysql : config.UseMysql === true;
  if (!enabled) return null;
  const source = plugin === 'ArkShop' ? mysql! : config;
  const keys =
    plugin === 'ArkShop'
      ? ['MysqlHost', 'MysqlPort', 'MysqlDB', 'MysqlTable', 'MysqlPlayersTable']
      : ['MysqlHost', 'MysqlPort', 'MysqlDB', 'MysqlPlayersTable', 'MysqlGroupsTable'];
  const descriptor = Object.fromEntries(
    keys.map((key) => [key, String(source[key] ?? (key === 'MysqlPort' ? 3306 : ''))]),
  );
  if (!descriptor.MysqlHost || !descriptor.MysqlDB) return null;
  // Localhost on different hosts is not evidence of a shared database.
  if (/^(localhost|127\.|::1)/i.test(descriptor.MysqlHost)) {
    if (!hostIdentity) return null;
    descriptor.MysqlHost = 'host:' + hostIdentity;
  }
  return sha(JSON.stringify(descriptor));
}
export async function readShop(root: string, id: string, hostIdentity?: string) {
  const path = join(pluginDirectory(root, id, 'ArkShop'), 'config.json');
  await ensureSafeParent(root, path);
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    throw new Error(
      error.code === 'ENOENT'
        ? '未找到 ArkShop/config.json，请先在此地图安装 ASE ArkApi、Permissions 和 ArkShop。'
        : '无法读取 ArkShop 配置。',
    );
  });
  const config = parsePlugin(text, 'ArkShop');
  const permissionsText = await readFile(
    join(pluginDirectory(root, id, 'Permissions'), 'config.json'),
    'utf8',
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{}';
    throw new Error('无法读取 Permissions 配置。');
  });
  const permissions = parsePlugin(permissionsText, 'Permissions');
  return {
    shopHash: sha(text),
    config: publicShopConfig(config),
    shopDatabase: databaseSignature(config, 'ArkShop', hostIdentity),
    permissionsDatabase: databaseSignature(permissions, 'Permissions', hostIdentity),
  };
}
export async function publishShop(
  root: string,
  id: string,
  operationId: string,
  input: Record<string, Json>,
  expectedHash: string,
  hostIdentity?: string,
) {
  const path = join(pluginDirectory(root, id, 'ArkShop'), 'config.json');
  await ensureSafeParent(root, path);
  const text = await readFile(path, 'utf8');
  if (sha(text) !== expectedHash)
    throw new Error('主机上的商店配置已变化，请重新读取并合并后发布。');
  const safe = publicShopConfig(input);
  const errors = validateShopConfig(safe);
  if (errors.length) throw new Error(errors.join('\n'));
  const original = parsePlugin(text, 'ArkShop');
  const merged = { ...safe };
  for (const key of Object.keys(original))
    if (/mysql|database/i.test(key)) merged[key] = original[key]!;
  const general =
    merged.General && typeof merged.General === 'object' && !Array.isArray(merged.General)
      ? merged.General
      : {};
  const oldGeneral = original.General;
  if (
    general &&
    oldGeneral &&
    typeof general === 'object' &&
    !Array.isArray(general) &&
    typeof oldGeneral === 'object' &&
    !Array.isArray(oldGeneral) &&
    oldGeneral.Discord !== undefined
  ) {
    general.Discord = oldGeneral.Discord;
    merged.General = general;
  }
  const backup = inside(root, 'shop-backups', id, `${operationId}.json`);
  await ensureSafeParent(root, backup);
  await copyFile(path, backup);
  const temporary = `${path}.${operationId}.tmp`;
  await writeFile(temporary, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await rename(temporary, path);
  return { ...(await readShop(root, id, hostIdentity)), backupPath: backup };
}
