import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = resolve(root, 'native/ArkConnect');
const archive = resolve(native, 'vendor/easytier-windows-x86_64-v2.6.4.zip');
const expected = '27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84';
const url =
  'https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/easytier-windows-x86_64-v2.6.4.zip';
function request(address, headers, depth = 0) {
  if (depth > 6) return Promise.reject(new Error('组件下载重定向过多。'));
  return new Promise((yes, no) => {
    const req = https.get(address, { headers }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        request(new URL(response.headers.location, address), headers, depth + 1).then(yes, no);
      } else yes(response);
    });
    req.setTimeout(30000, () => req.destroy(new Error('组件下载超时，请稍后重试。')));
    req.on('error', no);
  });
}
async function valid() {
  if (!existsSync(archive)) return false;
  return (
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex') === expected
  );
}
if (process.platform !== 'win32') {
  console.log('好友联机客户端需要在 Windows 上构建；本次继续构建管理后台。');
  process.exit(0);
}
await mkdir(resolve(native, 'vendor'), { recursive: true });
if (!(await valid())) {
  console.log('正在下载并校验 EasyTier 官方联机组件（约 32 MB）…');
  for (let attempt = 0; attempt < 4 && !(await valid()); attempt++) {
    const size = await stat(archive)
      .then((item) => item.size)
      .catch(() => 0);
    try {
      const response = await request(url, {
        'User-Agent': 'ArkControl-build',
        ...(size > 0 && size < 32657720 ? { Range: `bytes=${size}-` } : {}),
      });
      if (![200, 206].includes(response.statusCode)) {
        response.resume();
        throw new Error(`组件下载失败：${response.statusCode}`);
      }
      await pipeline(
        response,
        createWriteStream(archive, { flags: response.statusCode === 206 ? 'a' : 'w' }),
      );
    } catch (error) {
      if (attempt === 3) throw error;
      console.log('下载中断，正在续传…');
    }
  }
  if (!(await valid()))
    throw new Error('联机组件校验失败，请删除 native/ArkConnect/vendor 中的损坏压缩包后重试。');
}
await mkdir(resolve(native, 'dist'), { recursive: true });
const compiler = [
  resolve(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  resolve(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework/v4.0.30319/csc.exe'),
].find(existsSync);
if (!compiler)
  throw new Error(
    '未找到 .NET Framework 编译器，请使用已启用 .NET Framework 4.8 的 Windows 10/11 构建。',
  );
const args = [
  '/nologo',
  '/target:winexe',
  '/platform:x64',
  '/optimize+',
  '/langversion:5',
  `/out:${resolve(native, 'dist/ArkConnect.exe')}`,
  `/win32manifest:${resolve(native, 'app.manifest')}`,
  `/resource:${archive},EasyTier.zip`,
  `/resource:${resolve(native, 'vendor/EasyTier-LICENSE.txt')},EasyTier-LICENSE.txt`,
  `/resource:${resolve(native, 'vendor/GPL-3.0.txt')},GPL-3.0.txt`,
  `/resource:${resolve(native, 'THIRD-PARTY-NOTICES.md')},THIRD-PARTY-NOTICES.md`,
  '/reference:System.dll',
  '/reference:System.Core.dll',
  '/reference:System.Drawing.dll',
  '/reference:System.Windows.Forms.dll',
  '/reference:System.Net.Http.dll',
  '/reference:System.Web.Extensions.dll',
  '/reference:System.IO.Compression.dll',
  '/reference:System.IO.Compression.FileSystem.dll',
  ...['Protocol.cs', 'Core.cs', 'Client.cs', 'Program.cs'].map((file) => resolve(native, file)),
];
await new Promise((yes, no) => {
  const child = spawn(compiler, args, { windowsHide: true, stdio: 'inherit' });
  child.once('error', no);
  child.once('exit', (code) => (code === 0 ? yes() : no(new Error(`客户端构建失败：${code}`))));
});
console.log('好友联机客户端已构建，请在后台“好友联机”创建并下载专属联机包。');
