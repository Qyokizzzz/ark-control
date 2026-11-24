import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import archiver from 'archiver';
import type { AgentInstance } from '@ark-control/common';
import type { AgentClient } from '@/client';
import { checksum, extractZip, filesBelow, inside } from '@/files';
import { exists } from '@/runtime/install';
import { delay } from '@/runtime/processes';

async function fingerprint(directory: string): Promise<string> {
  const files = await filesBelow(directory);
  const parts: string[] = [];
  for (const file of files) {
    const info = await stat(file);
    parts.push(`${relative(directory, file)}:${info.size}:${info.mtimeMs}`);
  }
  return parts.sort().join('|');
}
export async function createBackup(
  root: string,
  instance: AgentInstance,
  commandId: string,
  client: AgentClient,
  report: (text: string) => void,
) {
  const saved = inside(root, 'instances', instance.id, 'ShooterGame', 'Saved');
  if (!(await exists(saved))) throw new Error('尚未生成存档，请至少完成一次地图启动。');
  const snapshotId = `${commandId}-${instance.id}-${Date.now()}`;
  const staging = inside(root, 'backup-staging', snapshotId);
  await mkdir(staging, { recursive: true });
  let stableSaved: string | null = null;
  for (let attempt = 0; attempt < 3; ++attempt) {
    const snapshot = join(staging, String(attempt), 'Saved');
    const before = await fingerprint(saved);
    await cp(saved, snapshot, {
      recursive: true,
      force: true,
      filter: async (source) => !(await lstat(source)).isSymbolicLink(),
    });
    const after = await fingerprint(saved);
    if (before === after) {
      stableSaved = snapshot;
      break;
    }
    report('复制期间存档有变化，正在重新获取稳定副本。');
    await delay(2000);
  }
  if (!stableSaved) throw new Error('存档持续写入，未生成可确认的一致备份；请停服后重试。');
  const directory = inside(root, 'backups');
  await mkdir(directory, { recursive: true });
  const path = inside(root, 'backups', `${snapshotId}.zip`);
  report('正在压缩世界、人物、部落与配置文件。');
  await new Promise<void>((yes, no) => {
    const destination = createWriteStream(path, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 1 } });
    destination.on('close', yes);
    destination.on('error', no);
    archive.on('error', no);
    archive.pipe(destination);
    archive.append(
      JSON.stringify({
        version: 1,
        instanceId: instance.id,
        map: instance.map,
        createdAt: new Date().toISOString(),
        clusterIncluded: false,
      }),
      { name: 'manifest.json' },
    );
    archive.directory(stableSaved, 'Saved');
    void archive.finalize();
  });
  const sha256 = await checksum(path);
  report('正在上传并校验备份。');
  const result = await client.uploadBackup(commandId, path, sha256, instance.id);
  return { backupId: result.id, sha256, path };
}
export async function restoreBackup(
  root: string,
  instance: AgentInstance,
  commandId: string,
  backupId: string,
  client: AgentClient,
  report: (text: string) => void,
) {
  report('恢复前先备份当前存档。');
  await createBackup(root, instance, commandId, client, report);
  const staging = inside(root, 'restore-staging', `${commandId}-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  const archive = join(staging, 'download.zip');
  const expected = await client.downloadBackup(backupId, archive);
  if (!expected || (await checksum(archive)) !== expected)
    throw new Error('备份下载校验失败，当前存档未变更。');
  const extracted = join(staging, 'extracted');
  await extractZip(archive, extracted);
  const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8')) as {
    version?: number;
    instanceId?: string;
    map?: string;
  };
  if (
    manifest.version !== 1 ||
    manifest.instanceId !== instance.id ||
    manifest.map !== instance.map ||
    !(await exists(join(extracted, 'Saved')))
  )
    throw new Error('备份归属、地图或格式不匹配，当前存档未变更。');
  const saved = inside(root, 'instances', instance.id, 'ShooterGame', 'Saved');
  const previous = inside(
    root,
    'instances',
    instance.id,
    'ShooterGame',
    `Saved-before-${Date.now()}`,
  );
  await rename(saved, previous);
  try {
    await rename(join(extracted, 'Saved'), saved);
  } catch (error) {
    await rename(previous, saved);
    throw error;
  }
  report('存档已恢复，原存档同时保留在本机和后台备份中。');
}
