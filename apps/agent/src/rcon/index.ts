import net from 'node:net';
import { randomInt } from 'node:crypto';

function packet(id: number, type: number, text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const data = Buffer.alloc(body.length + 14);
  data.writeInt32LE(body.length + 10, 0);
  data.writeInt32LE(id, 4);
  data.writeInt32LE(type, 8);
  body.copy(data, 12);
  return data;
}
/** Dedicated connection per request keeps Source RCON request IDs isolated. */
export async function rcon(
  port: number,
  password: string,
  command: string,
  timeout = 10000,
): Promise<string> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RCON 端口无效。');
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const authId = randomInt(1, 1000000);
    const commandId = authId + 1;
    let buffer = Buffer.alloc(0);
    let connected = false;
    let authenticated = false;
    let done = false;
    let response = '';
    let settle: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      if (settle) clearTimeout(settle);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    const endpoint = `127.0.0.1:${port}`;
    socket.setTimeout(timeout, () => {
      const phase = !connected
        ? 'TCP 连接未建立'
        : !authenticated
          ? 'TCP 已连接，但未收到密码验证结果'
          : '密码验证已通过，但未收到命令响应';
      finish(new Error(`RCON ${endpoint} 请求超时：${phase}。`));
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      const detail =
        error.code === 'ECONNREFUSED'
          ? '连接被拒绝，请检查本机 RCON 是否已监听'
          : error.code === 'ECONNRESET'
            ? '连接被重置，请检查游戏进程及本机安全软件'
            : error.code === 'EACCES' || error.code === 'EPERM'
              ? '访问被本机安全策略拒绝'
              : 'TCP 连接失败';
      finish(new Error(`RCON ${endpoint}：${detail}（${error.code ?? 'UNKNOWN'}）。`));
    });
    socket.on('connect', () => {
      connected = true;
      socket.write(packet(authId, 3, password));
    });
    socket.on('close', () => {
      if (!done)
        finish(
          authenticated && /^DoExit$/i.test(command) ? undefined : new Error('RCON 连接提前关闭。'),
        );
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0);
        if (size < 10 || size > 4 * 1024 * 1024) {
          finish(new Error('RCON 返回包长度无效。'));
          return;
        }
        if (buffer.length < size + 4) return;
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const text = buffer.subarray(12, size + 2).toString('utf8');
        buffer = buffer.subarray(size + 4);
        if (!authenticated && type === 2) {
          if (id === -1) {
            finish(new Error('RCON 密码验证失败。'));
            return;
          }
          if (id === authId) {
            authenticated = true;
            socket.write(packet(commandId, 2, command));
          }
        } else if (authenticated && id === commandId) {
          response += text;
          if (settle) clearTimeout(settle);
          settle = setTimeout(() => finish(), 200);
        }
      }
    });
  });
}
