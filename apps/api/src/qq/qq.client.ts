import { Inject, Injectable } from '@nestjs/common';
import type { Bot } from '@ark-control/common';
import { BusinessError, Database, config, decryptSecret } from '@/infrastructure';
import { isPlatformBot } from './platform-bot';

export class QqFailure extends Error {
  constructor(
    message: string,
    readonly outcome: 'blocked' | 'retry' | 'uncertain',
    readonly code?: number,
  ) {
    super(message);
  }
}
@Injectable()
export class QqClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly refreshes = new Map<string, Promise<string>>();
  constructor(@Inject(Database) private readonly db: Database) {}
  invalidate(id: string) {
    this.tokens.delete(id);
  }
  async token(bot: Bot): Promise<string> {
    const cached = this.tokens.get(bot.id);
    if (cached && cached.expiresAt - 60000 > Date.now()) return cached.token;
    const pending = this.refreshes.get(bot.id);
    if (pending) return pending;
    const promise = this.fetchToken(bot);
    this.refreshes.set(bot.id, promise);
    try {
      return await promise;
    } finally {
      this.refreshes.delete(bot.id);
    }
  }
  private async fetchToken(bot: Bot) {
    const credential = isPlatformBot(bot.id) ? null : await this.db.get('bot-credentials', bot.id);
    const secret = isPlatformBot(bot.id)
      ? config.PLATFORM_QQ_APP_SECRET
      : credential && decryptSecret(credential.secret);
    if (!secret) throw new QqFailure('机器人尚未配置密钥。', 'blocked');
    let response: Response;
    try {
      response = await fetch(`${config.QQ_API_BASE}/app/getAppAccessToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: bot.appId, clientSecret: secret }),
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new QqFailure('获取 QQ 访问凭证失败，将稍后重试。', 'retry');
    }
    const data = (await response.json()) as {
      access_token?: string;
      expires_in?: string | number;
      code?: number;
    };
    if (!response.ok || data.code || !data.access_token)
      throw new QqFailure(
        `QQ 凭据验证失败（${data.code ?? response.status}），请检查 AppID、Secret 和 IP 白名单。`,
        'blocked',
        data.code,
      );
    const expires = Number(data.expires_in ?? 7200);
    this.tokens.set(bot.id, { token: data.access_token, expiresAt: Date.now() + expires * 1000 });
    return data.access_token;
  }
  async gateway(bot: Bot): Promise<string> {
    const token = await this.token(bot);
    const response = await fetch(`${config.QQ_API_BASE}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(12000),
    });
    const data = (await response.json()) as { url?: string };
    if (!response.ok || !data.url?.startsWith('wss://'))
      throw new QqFailure('QQ 事件连接地址不可用，请检查机器人权限。', 'retry');
    return data.url;
  }
  async send(bot: Bot, openId: string, content: string): Promise<string> {
    if (!bot.enabled) throw new QqFailure('机器人已停用。', 'blocked');
    const token = await this.token(bot);
    let response: Response;
    try {
      response = await fetch(
        `${config.QQ_API_BASE}/v2/groups/${encodeURIComponent(openId)}/messages`,
        {
          method: 'POST',
          headers: { Authorization: `QQBot ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ msg_type: 0, content }),
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new QqFailure(
        'QQ 请求中断，无法确认是否已发送；请核对群消息后再手动重试。',
        'uncertain',
      );
    }
    let data: { id?: string; code?: number };
    try {
      data = (await response.json()) as typeof data;
    } catch {
      throw new QqFailure('QQ 返回内容不可识别，发送结果需要人工确认。', 'uncertain');
    }
    if (response.ok && !data.code && data.id) return data.id;
    if (data.code === 40034100 || response.status === 429)
      throw new QqFailure('QQ 平台发送限频，将保留消息并稍后重试。', 'retry', data.code);
    if (data.code === 11244 || response.status === 401) {
      this.invalidate(bot.id);
      throw new QqFailure('QQ 访问凭证失效，刷新后重试。', 'retry', data.code);
    }
    if (response.status >= 500)
      throw new QqFailure('QQ 服务暂时异常，发送结果需要人工确认。', 'uncertain', data.code);
    throw new QqFailure(
      `QQ 拒绝发送（${data.code ?? response.status}），请检查主动消息权限、群设置和消息长度。`,
      'blocked',
      data.code,
    );
  }
}

export function requireBot(bot: Bot | null): Bot {
  if (!bot) throw new BusinessError('BOT_NOT_FOUND', '机器人不存在。', 404);
  return bot;
}
