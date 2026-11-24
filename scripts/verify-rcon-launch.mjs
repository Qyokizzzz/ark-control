import assert from 'node:assert/strict';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
if (process.platform !== 'win32')
  throw new Error('此专项验收需要 Windows 与 .NET Framework C# 编译器。');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'apps/agent');
async function run(file, args = []) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
  });
  const code = await new Promise((yes, no) => {
    child.once('error', no);
    child.once('exit', yes);
  });
  assert.equal(code, 0);
}
await run(join(root, 'scripts/build-backend.mjs'), ['agent', '--rcon-fixture']);
await run(join(app, '.data/rcon-launch-built/main.mjs'));
