import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export function inside(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const destination = resolve(base, ...parts);
  const rel = relative(base, destination);
  if (
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel) ||
    parts.some((part) => part.includes('\0'))
  )
    throw new Error('文件路径必须位于专用工作目录内。');
  return destination;
}
export async function ensureSafeParent(root: string, target: string) {
  const base = await realpath(root);
  const rel = relative(resolve(root), resolve(target));
  inside(root, rel);
  let current = base;
  for (const part of rel.split(/[\\/]/).slice(0, -1)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('工作路径不允许包含符号链接。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
        const data = await lstat(current);
        if (!data.isDirectory() || data.isSymbolicLink()) throw mkdirError;
      }
    }
  }
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}
export async function checksum(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part as Buffer);
  return hash.digest('hex');
}
export async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await filesBelow(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
export async function extractZip(
  file: string,
  destination: string,
  maxBytes = 1024 ** 4,
  options?: { signal: AbortSignal; maxEntries: number },
) {
  await mkdir(destination, { recursive: true });
  let total = 0;
  await new Promise<void>((resolvePromise, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('压缩包无效。'));
        return;
      }
      if (options && zip.entryCount > options.maxEntries) {
        zip.close();
        reject(new Error('压缩包包含过多文件。'));
        return;
      }
      const fail = (reason: unknown) => {
        zip.close();
        reject(reason);
      };
      zip.on('error', fail);
      zip.on('end', resolvePromise);
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          options?.signal.throwIfAborted();
          if (
            entry.fileName.includes('\\') ||
            entry.fileName.includes(':') ||
            yauzl.validateFileName(entry.fileName) ||
            (options &&
              process.platform === 'win32' &&
              entry.fileName
                .split('/')
                .some((part) =>
                  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)|[ .]$/iu.test(part),
                ))
          )
            throw new Error('压缩包包含不安全的路径。');
          if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000)
            throw new Error('压缩包不允许包含符号链接。');
          total += entry.uncompressedSize;
          if (total > maxBytes) throw new Error('解压体积超过允许范围。');
          const target = inside(destination, entry.fileName);
          await ensureSafeParent(destination, target);
          if (entry.fileName.endsWith('/')) {
            await mkdir(target, { recursive: true });
            zip.readEntry();
            return;
          }
          await mkdir(dirname(target), { recursive: true });
          const stream = await new Promise<import('node:stream').Readable>((yes, no) =>
            zip.openReadStream(entry, (streamError, value) =>
              streamError || !value ? no(streamError) : yes(value),
            ),
          );
          await pipeline(stream, createWriteStream(target, { flags: 'wx' }), {
            signal: options?.signal,
          });
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  });
}
