import { Inject, Injectable } from '@nestjs/common';
import { requireMapAccess } from '@/workspaces/access';
import type { Delivery } from '@ark-control/common';
import { formatTribeMessage } from '@ark-control/common';
import { BusinessError, Database } from '@/infrastructure';
import { nowIso } from '@/control';
import { QqClient, QqFailure } from '@/qq/qq.client';
import { QuotaService } from '@/qq/quota.service';
import { findBot } from '@/qq/platform-bot';

@Injectable()
export class OutboxService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(QqClient) private readonly qq: QqClient,
    @Inject(QuotaService) private readonly quotas: QuotaService,
  ) {}
  async recover() {
    await this.db.transaction(async (connection) => {
      for (const item of await this.db.inStates('deliveries', ['sending'], connection))
        if (item.status === 'sending')
          await this.db.put(
            'deliveries',
            {
              ...item,
              status: 'uncertain',
              lastError: '发送过程中后台重启，请核对群消息后手动处理，避免重复推送。',
            },
            connection,
          );
    });
  }
  async tick() {
    const stale = (await this.db.inStates('deliveries', ['sending'])).filter(
      (item) => item.nextAttemptAt <= nowIso(),
    );
    if (stale.length) {
      await this.db.transaction(async (connection) => {
        for (const item of stale) {
          const current = await this.db.get('deliveries', item.id, connection);
          if (current?.status === 'sending' && current.nextAttemptAt <= nowIso())
            await this.db.put(
              'deliveries',
              {
                ...current,
                status: 'uncertain',
                lastError: '未能确认发送结果，请核对群消息后处理。',
              },
              connection,
            );
        }
      });
    }
    for (const item of await this.db.dueDeliveries()) await this.deliver(item.id);
  }
  private async deliver(id: string) {
    const claim = await this.db.transaction(async (connection) => {
      const item = await this.db.get('deliveries', id, connection);
      if (
        !item ||
        !['pending', 'ready', 'retry'].includes(item.status) ||
        item.nextAttemptAt > nowIso()
      )
        return null;
      const subscription = await this.db.get('subscriptions', item.subscriptionId, connection);
      if (
        !subscription?.enabled ||
        subscription.botId !== item.botId ||
        subscription.groupId !== item.groupId ||
        (subscription.expiresAt && subscription.expiresAt <= nowIso())
      ) {
        await this.db.put(
          'deliveries',
          {
            ...item,
            status: 'skipped',
            lastError: '订阅已暂停、过期或变更目标；请核对后决定是否补发。',
          },
          connection,
        );
        return null;
      }
      const bot = await findBot(this.db, item.botId, connection);
      const group = await this.db.get('groups', item.groupId, connection);
      if (!bot?.enabled || !group || group.botId !== bot.id) {
        await this.db.put(
          'deliveries',
          {
            ...item,
            status: 'blocked',
            lastError: '指定机器人停用或群绑定失效，未切换到其他机器人。',
          },
          connection,
        );
        return null;
      }
      const sending: Delivery = {
        ...item,
        status: 'sending',
        attempts: item.attempts + 1,
        nextAttemptAt: new Date(Date.now() + 120000).toISOString(),
      };
      await this.db.put('deliveries', sending, connection);
      return { item: sending, bot, group };
    });
    if (!claim) return;
    if (!(await this.quotas.reserve(claim.bot, claim.group.openId))) {
      await this.finish(claim.item.id, {
        status: 'retry',
        nextAttemptAt: new Date(Date.now() + 60000).toISOString(),
        lastError: '发送配额已用完，消息已保存并延后。',
      });
      return;
    }
    try {
      if ((await this.db.get('deliveries', claim.item.id))?.status !== 'sending') return;
      const messageId = await this.qq.send(
        claim.bot,
        claim.group.openId,
        formatTribeMessage(
          claim.item.mapLabel,
          claim.item.tribeName,
          claim.item.body,
          claim.item.count,
        ),
      );
      await this.finish(claim.item.id, {
        status: 'sent',
        sentAt: nowIso(),
        qqMessageId: messageId,
        lastError: null,
      });
    } catch (error) {
      const failure =
        error instanceof QqFailure
          ? error
          : new QqFailure('发送过程发生异常，需要核对实际群消息。', 'uncertain');
      await this.finish(claim.item.id, {
        status: failure.outcome,
        nextAttemptAt: new Date(
          Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(claim.item.attempts, 5)),
        ).toISOString(),
        lastError: failure.message,
      });
    }
  }
  private async finish(id: string, patch: Partial<Delivery>) {
    await this.db.transaction(async (connection) => {
      const item = await this.db.get('deliveries', id, connection);
      if (item?.status === 'sending')
        await this.db.put('deliveries', { ...item, ...patch }, connection);
    });
  }
  async retry(id: string, acknowledgeUncertain: boolean) {
    await this.db.transaction(async (connection) => {
      const item = await this.db.get('deliveries', id, connection);
      if (!item) throw new BusinessError('NOT_FOUND', '推送记录不存在。', 404);
      await requireMapAccess(this.db, 'logs.retry', item.instanceId, connection);
      if (item.status === 'uncertain' && !acknowledgeUncertain)
        throw new BusinessError(
          'CONFIRM_UNCERTAIN',
          '请先确认群内没有收到该消息，再重试以免重复。',
        );
      if (!['blocked', 'retry', 'uncertain'].includes(item.status))
        throw new BusinessError('RETRY_INVALID', '当前消息不需要重试。');
      await this.db.put(
        'deliveries',
        { ...item, status: 'ready', nextAttemptAt: nowIso(), lastError: null },
        connection,
      );
    });
  }
}
