import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Bot, BotInput, QqGroup, Subscription, SubscriptionInput } from '@ark-control/common';
import {
  BusinessError,
  Database,
  config,
  encryptSecret,
  hashToken,
  newToken,
  tokensEqual,
} from '@/infrastructure';
import { ControlService, nowIso } from '@/control';
import { QqClient, requireBot } from '@/qq/qq.client';
import { QuotaService } from '@/qq/quota.service';
import { requireMapAccess, resource } from '@/workspaces/access';
import { findBot, isPlatformBot, withPlatformBot } from './platform-bot';

export function groupBindingCode(content: string) {
  return content.match(/(?:绑定|bind)\s+([A-Za-z0-9_-]{16})(?![A-Za-z0-9_-])/i)?.[1]?.toUpperCase();
}

@Injectable()
export class BotsService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ControlService) private readonly control: ControlService,
    @Inject(QqClient) private readonly client: QqClient,
    @Inject(QuotaService) private readonly quotas: QuotaService,
  ) {}
  async save(input: Partial<BotInput>, id?: string) {
    if ((id && isPlatformBot(id)) || (input.appId && input.appId === config.PLATFORM_QQ_APP_ID))
      throw new BusinessError('PLATFORM_BOT_MANAGED', '平台 QQ 机器人的凭据由平台设置。', 403);
    const result = await this.db.transaction(async (connection) => {
      const previous = id ? requireBot(await this.db.get('bots', id, connection)) : null;
      const bots = await this.db.list('bots', connection);
      if (bots.some((item) => item.id !== id && item.appId === input.appId))
        throw new BusinessError('BOT_EXISTS', '该 AppID 已经接入，请直接选择现有机器人。');
      if (
        previous &&
        input.appId &&
        input.appId !== previous.appId &&
        (await this.db.list('groups', connection)).some((group) => group.botId === id)
      )
        throw new BusinessError(
          'BOT_ID_IMMUTABLE',
          '已绑定群的机器人不能更换 AppID，请添加新机器人后重新绑定。',
        );
      if (!previous && (!input.name || !input.appId || !input.appSecret))
        throw new BusinessError(
          'BOT_CREDENTIALS_REQUIRED',
          '请填写机器人名称、AppID 和 AppSecret。',
        );
      const bot: Bot = {
        id: id ?? randomUUID(),
        name: input.name ?? previous!.name,
        appId: input.appId ?? previous!.appId,
        owner: input.owner ?? previous?.owner ?? '',
        isDefault: input.isDefault ?? previous?.isDefault ?? false,
        enabled: input.enabled ?? previous?.enabled ?? true,
        certified: input.certified ?? previous?.certified ?? false,
        eventMode: input.eventMode ?? previous?.eventMode ?? 'webhook',
        status: input.appSecret ? 'unconfigured' : (previous?.status ?? 'unconfigured'),
        lastError: null,
        verifiedAt: input.appSecret ? null : (previous?.verifiedAt ?? null),
        createdAt: previous?.createdAt ?? nowIso(),
        hasSecret: true,
      };
      if (bot.isDefault)
        for (const item of bots)
          if (item.id !== bot.id && item.isDefault)
            await this.db.put('bots', { ...item, isDefault: false }, connection);
      await this.db.put('bots', bot, connection);
      if (input.appSecret)
        await this.db.put(
          'bot-credentials',
          { id: bot.id, secret: encryptSecret(input.appSecret) },
          connection,
        );
      await this.control.audit(
        previous ? '更新机器人' : '接入机器人',
        bot.name,
        '密钥加密保存，未写入操作记录。',
        connection,
      );
      return bot;
    });
    this.client.invalidate(result.id);
    return result;
  }
  async verify(id: string) {
    const bot = requireBot(await findBot(this.db, id));
    try {
      await this.client.token(bot);
      await this.setStatus(id, 'verified', null, true);
      return { success: true, message: '凭据有效，请继续绑定群并测试主动推送。' };
    } catch (error) {
      const message = error instanceof Error ? error.message : '验证失败。';
      await this.setStatus(id, 'error', message);
      throw new BusinessError('QQ_VERIFY_FAILED', message);
    }
  }
  async setStatus(id: string, status: string, lastError: string | null, verified = false) {
    if (isPlatformBot(id)) return;
    await this.db.transaction(async (connection) => {
      const bot = await this.db.get('bots', id, connection);
      if (bot)
        await this.db.put(
          'bots',
          { ...bot, status, lastError, verifiedAt: verified ? nowIso() : bot.verifiedAt },
          connection,
        );
    });
  }
  async bindingCode(botId: string) {
    requireBot(await findBot(this.db, botId));
    const code = newToken().slice(0, 16).toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
    await this.db.transaction((connection) =>
      this.db.put(
        'binding-codes',
        {
          id: randomUUID(),
          botId,
          codeHash: hashToken(code),
          expiresAt,
          usedAt: null,
          groupId: null,
        },
        connection,
      ),
    );
    return { code, expiresAt, instruction: `请在目标群 @此机器人 并发送：绑定 ${code}` };
  }
  async receiveGroupBinding(botId: string, openId: string, content: string) {
    const binding = groupBindingCode(content);
    if (!binding) return false;
    return this.db.transaction(async (connection) => {
      const code = (
        await this.db.listBy('binding-codes', 'codeHash', hashToken(binding), connection)
      ).find(
        (item) =>
          item.botId === botId &&
          !item.usedAt &&
          item.expiresAt > nowIso() &&
          tokensEqual(binding, item.codeHash),
      );
      if (!code) return false;
      const groups = await this.db.list('groups', connection);
      const old = groups.find((group) => group.botId === botId && group.openId === openId);
      const group: QqGroup = old
        ? { ...old, verifiedAt: nowIso() }
        : {
            id: randomUUID(),
            botId,
            openId,
            name: `QQ群 ${openId.slice(-6)}`,
            groupNumber: '',
            verifiedAt: nowIso(),
            createdAt: nowIso(),
          };
      await this.db.put('groups', group, connection);
      await this.db.put(
        'binding-codes',
        { ...code, usedAt: nowIso(), groupId: group.id },
        connection,
      );
      await this.control.audit(
        '绑定 QQ 群',
        group.name,
        '群身份已取得，需要在后台测试主动发送并设置部落订阅。',
        connection,
        'QQ 绑定事件',
      );
      return true;
    });
  }
  async renameGroup(id: string, name: string, groupNumber: string) {
    return this.db.transaction(async (connection) => {
      const group = await this.db.get('groups', id, connection);
      if (!group) throw new BusinessError('GROUP_NOT_FOUND', '群不存在。');
      return this.db.put('groups', { ...group, name, groupNumber }, connection);
    });
  }
  async testGroup(id: string) {
    const group = await this.db.get('groups', id);
    if (!group) throw new BusinessError('GROUP_NOT_FOUND', '请先完成群绑定。');
    const bot = requireBot(await findBot(this.db, group.botId));
    if (!(await this.quotas.reserve(bot, group.openId)))
      throw new BusinessError('RATE_LIMITED', '当前发送配额不足，请稍后测试。', 429);
    try {
      const messageId = await this.client.send(
        bot,
        group.openId,
        '方舟控制台： QQ 群日志推送连接测试 (1)',
      );
      await this.setStatus(bot.id, 'verified', null, true);
      await this.control.audit('测试群推送', group.name, `QQ 已接受消息 ${messageId}`);
      return { messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : '测试失败。';
      await this.setStatus(bot.id, 'error', message);
      throw new BusinessError('QQ_SEND_FAILED', message);
    }
  }
  async subscription(input: SubscriptionInput, id?: string) {
    return this.db.transaction(async (connection) => {
      const current = id ? await this.db.get('subscriptions', id, connection) : null;
      if (id && !current) throw new BusinessError('NOT_FOUND', '订阅不存在。', 404);
      if (current)
        await requireMapAccess(this.db, 'subscriptions.write', current.instanceId, connection);
      await requireMapAccess(this.db, 'subscriptions.write', input.instanceId, connection);
      const bot = requireBot(
        withPlatformBot(await this.db.list('bots', connection)).find(
          (item) => item.id === input.botId,
        ) ?? null,
      );
      const group = await this.db.get('groups', input.groupId, connection);
      if (!group || group.botId !== bot.id)
        throw new BusinessError('BOT_GROUP_MISMATCH', '目标群必须属于所选择的机器人，请重新绑定。');
      if (!current && input.botMode === 'default' && !bot.isDefault)
        throw new BusinessError(
          'DEFAULT_BOT_CHANGED',
          '默认机器人已变更，请重新选择并确认目标群。',
        );
      const duplicate = (await this.db.list('subscriptions', connection)).some(
        (item) =>
          item.id !== id &&
          item.instanceId === input.instanceId &&
          item.tribeId === input.tribeId &&
          item.groupId === input.groupId,
      );
      if (duplicate) throw new BusinessError('SUBSCRIPTION_EXISTS', '这个地图、部落与群已经绑定。');
      const value: Subscription = {
        ...input,
        id: id ?? randomUUID(),
        createdAt: current?.createdAt ?? nowIso(),
      };
      await this.db.put('subscriptions', value, connection);
      await this.control.audit(
        '保存部落订阅',
        input.customer,
        `${input.tribeName} → ${group.name}，机器人：${bot.name}`,
        connection,
      );
      return value;
    });
  }
  async removeSubscription(id: string) {
    return this.db.transaction(async (connection) => {
      const value = await resource(this.db, 'subscriptions', id, connection);
      await requireMapAccess(this.db, 'subscriptions.write', value.instanceId, connection);
      await this.db.remove('subscriptions', id, connection);
      await this.control.audit('删除部落订阅', value.tribeName, value.customer, connection);
      return null;
    });
  }
  async deleteBot(id: string) {
    if (isPlatformBot(id))
      throw new BusinessError('PLATFORM_BOT_MANAGED', '平台 QQ 机器人由平台维护。', 403);
    await this.db.transaction(async (connection) => {
      if ((await this.db.list('subscriptions', connection)).some((item) => item.botId === id))
        throw new BusinessError('BOT_IN_USE', '请先移除使用此机器人的订阅。');
      for (const group of await this.db.list('groups', connection))
        if (group.botId === id) await this.db.remove('groups', group.id, connection);
      await this.db.remove('bots', id, connection);
      await this.db.remove('bot-credentials', id, connection);
      await this.control.audit('删除机器人', id, '已删除其加密密钥和群绑定。', connection);
    });
    this.client.invalidate(id);
  }
}
