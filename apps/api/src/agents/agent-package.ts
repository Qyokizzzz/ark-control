import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { BusinessError } from '@/infrastructure';

const trimAddress = (value: string) =>
  value
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:/i, '');
const isLoopback = (address: string) =>
  address.toLowerCase() === 'localhost' ||
  address === '::1' ||
  (isIP(address) === 4 && address.startsWith('127.'));
const isWildcard = (address: string) => ['0.0.0.0', '::'].includes(address);
const isNetworkAddress = (address: string) =>
  isIP(address) !== 0 &&
  !isLoopback(address) &&
  !isWildcard(address) &&
  !/^(169\.254\.|fe80:)/i.test(address);

export function agentPackageOrigin(
  settings: { APP_ORIGIN: string; API_HOST: string; API_PORT: number },
  localAddress?: string,
) {
  const configured = new URL(settings.APP_ORIGIN);
  if (
    !['http:', 'https:'].includes(configured.protocol) ||
    configured.username ||
    configured.password
  )
    throw new BusinessError(
      'AGENT_ADDRESS_INVALID',
      '请将 APP_ORIGIN 配置为有效的 HTTP 或 HTTPS 管理地址。',
      503,
    );
  const configuredHost = trimAddress(configured.hostname);
  if (!isLoopback(configuredHost) && !isWildcard(configuredHost)) return configured.origin;

  const bindHost = trimAddress(settings.API_HOST) || '0.0.0.0';
  let host = bindHost;
  if (isWildcard(bindHost)) {
    const boundAddress = trimAddress(localAddress ?? '');
    const networks = Object.entries(networkInterfaces());
    const virtual =
      /virtual|vmware|vbox|vethernet|wsl|hyper-v|docker|geph|tailscale|easytier|wireguard|wintun|tap|tun/i;
    const orderedNetworks = [
      ...networks.filter(([name]) => !virtual.test(name)),
      ...networks.filter(([name]) => virtual.test(name)),
    ];
    host = isNetworkAddress(boundAddress)
      ? boundAddress
      : (orderedNetworks
          .flatMap(([, addresses]) => addresses ?? [])
          .find(
            (address) =>
              !address.internal && address.family === 'IPv4' && isNetworkAddress(address.address),
          )?.address ?? '127.0.0.1');
  }
  return new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}:${settings.API_PORT}`).origin;
}

const settingsName = Buffer.from('ArkHostAgent.json');
const endRecordSize = 22;
const centralHeaderSize = 46;
const archiveLimit = 0xffffffff;

function invalidArchive(): never {
  throw new BusinessError(
    'AGENT_PACKAGE_INVALID',
    'Windows 主机助手包格式无效，请在后台更新构建包。',
    503,
  );
}

// Append a stored ZIP entry and replace the central directory. The Node runtime and
// its dependencies remain compressed and can be streamed directly from the base archive.
export async function prepareAgentArchive(file: FileHandle, origin: string) {
  const info = await file.stat();
  const { size } = info;
  if (!info.isFile() || size <= endRecordSize || size >= archiveLimit) invalidArchive();
  const end = Buffer.alloc(endRecordSize);
  const footer = await file.read(end, 0, end.length, size - end.length);
  const directoryOffset = end.readUInt32LE(16);
  const directorySize = end.readUInt32LE(12);
  const entryCount = end.readUInt16LE(10);
  if (
    footer.bytesRead !== end.length ||
    end.readUInt32LE(0) !== 0x06054b50 ||
    end.readUInt32LE(4) !== 0 ||
    end.readUInt16LE(8) !== entryCount ||
    end.readUInt16LE(20) !== 0 ||
    entryCount >= 0xfffe ||
    directoryOffset <= 0 ||
    directorySize < centralHeaderSize ||
    directorySize > 16 * 1024 * 1024 ||
    directoryOffset + directorySize !== size - end.length
  )
    invalidArchive();

  const directory = Buffer.alloc(directorySize);
  if ((await file.read(directory, 0, directorySize, directoryOffset)).bytesRead !== directorySize)
    invalidArchive();
  const retained: Buffer[] = [];
  let entries = 0;
  for (let start = 0; start < directory.length;) {
    if (
      start + centralHeaderSize > directory.length ||
      directory.readUInt32LE(start) !== 0x02014b50
    )
      invalidArchive();
    const nameStart = start + centralHeaderSize;
    const nameEnd = nameStart + directory.readUInt16LE(start + 28);
    const next = nameEnd + directory.readUInt16LE(start + 30) + directory.readUInt16LE(start + 32);
    if (next > directory.length) invalidArchive();
    if (!directory.subarray(nameStart, nameEnd).equals(settingsName))
      retained.push(directory.subarray(start, next));
    entries++;
    start = next;
  }
  if (entries !== entryCount) invalidArchive();

  const payload = Buffer.from(`${JSON.stringify({ apiUrl: origin })}\n`);
  const checksum = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x21, 12); // DOS date 1980-01-01.
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(settingsName.length, 26);
  const settings = Buffer.concat([local, settingsName, payload]);

  const central = Buffer.alloc(centralHeaderSize);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(settingsName.length, 28);
  central.writeUInt32LE(directoryOffset, 42);
  const newDirectory = Buffer.concat([...retained, central, settingsName]);
  const newDirectoryOffset = directoryOffset + settings.length;
  const length = newDirectoryOffset + newDirectory.length + end.length;
  if (length >= archiveLimit) invalidArchive();
  end.writeUInt16LE(retained.length + 1, 8);
  end.writeUInt16LE(retained.length + 1, 10);
  end.writeUInt32LE(newDirectory.length, 12);
  end.writeUInt32LE(newDirectoryOffset, 16);

  async function* contents() {
    yield* file.createReadStream({ start: 0, end: directoryOffset - 1, autoClose: false });
    yield settings;
    yield newDirectory;
    yield end;
  }
  return { length, stream: Readable.from(contents(), { objectMode: false }) };
}
