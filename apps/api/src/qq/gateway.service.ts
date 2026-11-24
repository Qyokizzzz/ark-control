import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import WebSocket from 'ws';
import type { Bot } from '@ark-control/common';
import { Database, config } from '@/infrastructure';
import { BotsService } from '@/qq/bots.service';
import { QqClient } from '@/qq/qq.client';
import { runInWorkspace } from '@/workspaces/context';

type Session = {
  workspaceId: string;
  socket?: WebSocket;
  heartbeat?: ReturnType<typeof setInterval>;
  reconnect?: ReturnType<typeof setTimeout>;
  fingerprint: string;
  stopped: boolean;
  retry: number;
};
@Injectable()
export class GatewayService implements OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<string, Session>();
  private timer?: ReturnType<typeof setInterval>;
  private syncing = false;
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QqClient) private readonly client: QqClient,
    @Inject(BotsService) private readonly bots: BotsService,
  ) {}
  onModuleInit() {
    if (config.QQ_GATEWAY_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.sync().catch(() => undefined), 10000);
    this.timer.unref();
    void this.sync().catch(() => undefined);
  }
  private async sync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const active = new Set<string>();
      await this.db.forEachActiveWorkspace(async (workspaceId) => {
        for (const bot of await this.db.list('bots')) {
          if (!bot.enabled || bot.eventMode !== 'websocket') continue;
          const credential = await this.db.get('bot-credentials', bot.id);
          if (!credential) continue;
          active.add(bot.id);
          const fingerprint = `${bot.appId}:${credential.secret}`;
          const existing = this.sessions.get(bot.id);
          if (existing?.fingerprint === fingerprint) continue;
          if (existing) this.stop(existing);
          const session: Session = { workspaceId, fingerprint, stopped: false, retry: 0 };
          this.sessions.set(bot.id, session);
          void this.connect(bot, session);
        }
      });
      for (const [id, session] of this.sessions)
        if (!active.has(id)) {
          this.stop(session);
          this.sessions.delete(id);
        }
    } finally {
      this.syncing = false;
    }
  }
  private async connect(bot: Bot, session: Session) {
    if (session.stopped) return;
    try {
      const url = await this.client.gateway(bot);
      const token = await this.client.token(bot);
      if (session.stopped) return;
      const socket = new WebSocket(url);
      session.socket = socket;
      let sequence: number | null = null;
      let acknowledged = true;
      socket.on('message', (buffer) => {
        if (session.stopped) return;
        void runInWorkspace(session.workspaceId, async () => {
          const packet = JSON.parse(String(buffer)) as {
            op: number;
            s?: number;
            t?: string;
            d?: { heartbeat_interval?: number; group_openid?: string; content?: string };
          };
          if (typeof packet.s === 'number') sequence = packet.s;
          if (packet.op === 10) {
            socket.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: `QQBot ${token}`,
                  intents: 1 << 25,
                  shard: [0, 1],
                  properties: {
                    os: process.platform,
                    browser: 'ark-control',
                    device: 'ark-control',
                  },
                },
              }),
            );
            session.heartbeat = setInterval(
              () => {
                if (!acknowledged) {
                  socket.terminate();
                  return;
                }
                acknowledged = false;
                if (socket.readyState === WebSocket.OPEN)
                  socket.send(JSON.stringify({ op: 1, d: sequence }));
              },
              Math.max(1000, packet.d?.heartbeat_interval ?? 30000),
            );
          } else if (packet.op === 11) acknowledged = true;
          else if (packet.op === 7 || packet.op === 9) socket.close();
          else if (packet.op === 0 && packet.t === 'READY') {
            session.retry = 0;
            await this.bots.setStatus(bot.id, 'online', null, true);
          } else if (
            packet.op === 0 &&
            ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(packet.t ?? '') &&
            packet.d?.group_openid &&
            packet.d.content
          )
            await this.bots.receiveGroupBinding(bot.id, packet.d.group_openid, packet.d.content);
        }).catch(() => undefined);
      });
      socket.on('error', () => socket.close());
      socket.on('close', () => {
        if (session.heartbeat) clearInterval(session.heartbeat);
        if (session.stopped) return;
        runInWorkspace(session.workspaceId, () => {
          void this.bots
            .setStatus(bot.id, 'offline', 'QQ 事件连接断开，正在重连。')
            .catch(() => undefined);
          this.reconnect(bot, session);
        });
      });
    } catch (error) {
      await this.bots
        .setStatus(bot.id, 'error', error instanceof Error ? error.message : 'QQ 连接失败。')
        .catch(() => undefined);
      this.reconnect(bot, session);
    }
  }
  private reconnect(bot: Bot, session: Session) {
    if (session.stopped) return;
    const delay = Math.min(300000, 5000 * 2 ** Math.min(session.retry++, 6));
    session.reconnect = setTimeout(() => void this.connect(bot, session), delay);
    session.reconnect.unref();
  }
  private stop(session: Session) {
    session.stopped = true;
    if (session.heartbeat) clearInterval(session.heartbeat);
    if (session.reconnect) clearTimeout(session.reconnect);
    session.socket?.close();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    for (const session of this.sessions.values()) this.stop(session);
  }
}
