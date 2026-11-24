import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { rcon } from './index';

const servers: net.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((yes) => server.close(() => yes()));
});
function response(id: number, type: number, text: string) {
  const bytes = Buffer.from(text);
  const output = Buffer.alloc(bytes.length + 14);
  output.writeInt32LE(bytes.length + 10, 0);
  output.writeInt32LE(id, 4);
  output.writeInt32LE(type, 8);
  bytes.copy(output, 12);
  return output;
}
async function serve(deny = false, silent?: 'authentication' | 'command') {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
        const length = buffer.readInt32LE(0);
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        buffer = buffer.subarray(length + 4);
        if (type === 3) {
          if (silent !== 'authentication') socket.write(response(deny ? -1 : id, 2, ''));
        } else {
          if (silent === 'command') continue;
          const value = response(id, 0, '0. 测试玩家, 76561198000000001');
          socket.write(value.subarray(0, 7));
          setTimeout(() => socket.write(value.subarray(7)), 10);
        }
      }
    });
  });
  servers.push(server);
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  return (server.address() as net.AddressInfo).port;
}
describe('Source RCON', () => {
  it('认证后接收被拆成多个 TCP 分片的中文响应', async () => {
    const port = await serve();
    expect(await rcon(port, 'password', 'ListPlayers')).toBe('0. 测试玩家, 76561198000000001');
  });
  it('认证拒绝时不会发送管理操作', async () => {
    const port = await serve(true);
    await expect(rcon(port, 'wrong', 'DoExit')).rejects.toThrow('密码验证失败');
  });
  it('preserves the local endpoint and refused connection reason without exposing passwords', async () => {
    const port = await serve();
    await new Promise<void>((yes) => servers.at(-1)!.close(() => yes()));
    const failure = await rcon(port, 'private-password', 'ListPlayers').catch(
      (error: Error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`127.0.0.1:${port}`);
    expect((failure as Error).message).toContain('ECONNREFUSED');
    expect((failure as Error).message).not.toContain('private-password');
  });
  it('distinguishes a silent authentication from a silent game command', async () => {
    const authPort = await serve(false, 'authentication');
    await expect(rcon(authPort, 'private-password', 'ListPlayers', 100)).rejects.toThrow(
      '未收到密码验证结果',
    );
    const commandPort = await serve(false, 'command');
    await expect(rcon(commandPort, 'private-password', 'ListPlayers', 100)).rejects.toThrow(
      '未收到命令响应',
    );
  });
});
