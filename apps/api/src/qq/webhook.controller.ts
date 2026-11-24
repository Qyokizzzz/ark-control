import { Controller, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '@/auth';
import { BusinessError, Database, config, decryptSecret, hashToken, parse } from '@/infrastructure';
import { BotsService, groupBindingCode } from '@/qq/bots.service';
import { signQqChallenge, verifyQqRequest } from '@/qq/signatures';
import { runInWorkspace } from '@/workspaces/context';
import { findBot, isPlatformBot } from './platform-bot';

export interface QqWebhookRequest extends Request {
  rawBody?: Buffer;
}
const packetSchema = z.object({
  op: z.number().int(),
  t: z.string().max(100).optional(),
  id: z.string().max(300).optional(),
  d: z
    .object({
      // A validation nonce must never accept a JSON event: otherwise this public
      // handshake would become a signing oracle for forged event callbacks.
      plain_token: z
        .string()
        .regex(/^[A-Za-z0-9+/=_-]{16,256}$/)
        .optional(),
      event_ts: z
        .string()
        .regex(/^\d{10,13}$/)
        .optional(),
      group_openid: z.string().min(1).max(200).optional(),
      content: z.string().max(64000).optional(),
    })
    .passthrough(),
});

@Public()
@Controller('qq/webhook')
export class QqWebhookController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(BotsService) private readonly bots: BotsService,
  ) {}

  @Post(':botId') async receive(
    @Param('botId') botId: string,
    @Req() request: QqWebhookRequest,
    @Res() response: Response,
  ) {
    if (isPlatformBot(botId)) return this.receiveForWorkspace(botId, request, response);
    const workspaceId = await this.db.locate('bots', botId);
    if (!workspaceId || (await this.db.get('workspaces', workspaceId))?.status !== 'active')
      throw new BusinessError('QQ_CALLBACK_DISABLED', '机器人回调未启用。', 404);
    return runInWorkspace(workspaceId, () => this.receiveForWorkspace(botId, request, response));
  }

  private async receiveForWorkspace(botId: string, request: QqWebhookRequest, response: Response) {
    const bot = await findBot(this.db, botId);
    if (!bot?.enabled || bot.eventMode !== 'webhook')
      throw new BusinessError('QQ_CALLBACK_DISABLED', '机器人回调未启用。', 404);
    if (request.get('X-Bot-Appid') !== bot.appId)
      throw new BusinessError('QQ_CALLBACK_APPID', '回调 AppID 不匹配。', 403);
    const credential = isPlatformBot(botId) ? null : await this.db.get('bot-credentials', botId);
    const secret = isPlatformBot(botId)
      ? config.PLATFORM_QQ_APP_SECRET
      : credential && decryptSecret(credential.secret);
    if (!secret) throw new BusinessError('QQ_CALLBACK_SECRET', '机器人尚未配置密钥。', 403);
    const packet = parse(packetSchema, request.body);
    if (packet.op === 13 && packet.d.plain_token && packet.d.event_ts) {
      response.status(200).json({
        plain_token: packet.d.plain_token,
        signature: signQqChallenge(secret, packet.d.event_ts, packet.d.plain_token),
      });
      return;
    }
    const timestamp = request.get('X-Signature-Timestamp') ?? '';
    const signature = request.get('X-Signature-Ed25519') ?? '';
    const epoch = Number(timestamp) * (timestamp.length === 13 ? 1 : 1000);
    if (
      !request.rawBody ||
      !verifyQqRequest(secret, timestamp, request.rawBody, signature) ||
      Math.abs(Date.now() - epoch) > 5 * 60000
    )
      throw new BusinessError('QQ_CALLBACK_SIGNATURE', '回调签名或时间戳无效。', 401);
    if (
      packet.op === 0 &&
      ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(packet.t ?? '') &&
      packet.d.group_openid &&
      packet.d.content
    ) {
      // Persist the one-time binding before acknowledging, so a retry cannot lose it.
      if (isPlatformBot(bot.id)) {
        const code = groupBindingCode(packet.d.content);
        const workspaceId = code && (await this.db.locateBindingWorkspace(bot.id, hashToken(code)));
        if (workspaceId && (await this.db.get('workspaces', workspaceId))?.status === 'active') {
          const { group_openid, content } = packet.d;
          await runInWorkspace(workspaceId, () =>
            this.bots.receiveGroupBinding(bot.id, group_openid, content),
          );
        }
      } else await this.bots.receiveGroupBinding(bot.id, packet.d.group_openid, packet.d.content);
      await this.bots.setStatus(bot.id, 'verified', null, true);
    }
    // QQ callbacks require their native acknowledgment, outside the admin envelope.
    response
      .status(200)
      .json({ op: 12, d: { event_id: packet.id ?? '', status: 0, message: 'success' } });
  }
}
