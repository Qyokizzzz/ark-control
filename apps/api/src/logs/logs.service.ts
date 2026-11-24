import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import type { Delivery, TribeEvent, TribeEventInput } from '@ark-control/common';
import { AGGREGATION_WINDOW_MS, normalizeTribeLog } from '@ark-control/common';
import { Database } from '@/infrastructure';
import { nowIso } from '@/control';

@Injectable()
export class LogsService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async ingest(inputs: TribeEventInput[]): Promise<{ accepted: number; duplicate: number }> {
    return this.db.transaction(async (connection) => {
      let accepted = 0;
      let duplicate = 0;
      const subscriptions = await this.db.list('subscriptions', connection);
      const instances = await this.db.list('instances', connection);
      for (const input of inputs) {
        const id = randomUUID();
        const receivedAt = nowIso();
        const [insert] = await connection.execute<ResultSetHeader>(
          'INSERT IGNORE INTO workspace_event_keys(workspace_id,instance_id,source_id,event_id) VALUES(?,?,?,?)',
          [this.db.workspaceId, input.instanceId, input.sourceId, id],
        );
        if (!insert.affectedRows) {
          ++duplicate;
          continue;
        }
        const event: TribeEvent = {
          ...input,
          id,
          normalizedText: normalizeTribeLog(input.text) || input.text.trim(),
          receivedAt,
        };
        await this.db.put('events', event, connection);
        await this.db.put(
          'tribes',
          {
            id: `${input.instanceId}:${input.tribeId}`,
            instanceId: input.instanceId,
            tribeId: input.tribeId,
            name: input.tribeName,
            lastSeenAt: receivedAt,
          },
          connection,
        );
        const instance = instances.find((item) => item.id === input.instanceId);
        if (!instance) continue;
        const pending = (await this.db.inStates('deliveries', ['pending'], connection)).filter(
          (item) => item.windowEndsAt > receivedAt,
        );
        for (const subscription of subscriptions) {
          if (
            !subscription.enabled ||
            subscription.instanceId !== input.instanceId ||
            subscription.tribeId !== input.tribeId ||
            (subscription.expiresAt && subscription.expiresAt <= receivedAt)
          )
            continue;
          const match = pending.find(
            (item) =>
              item.subscriptionId === subscription.id &&
              item.botId === subscription.botId &&
              item.groupId === subscription.groupId &&
              item.body === event.normalizedText,
          );
          const delivery: Delivery = match
            ? { ...match, count: match.count + 1 }
            : {
                id: randomUUID(),
                subscriptionId: subscription.id,
                botId: subscription.botId,
                groupId: subscription.groupId,
                instanceId: input.instanceId,
                tribeId: input.tribeId,
                mapLabel: instance.mapLabel,
                tribeName: input.tribeName,
                body: event.normalizedText,
                count: 1,
                firstAt: receivedAt,
                windowEndsAt: new Date(
                  Date.parse(receivedAt) + AGGREGATION_WINDOW_MS,
                ).toISOString(),
                status: 'pending',
                attempts: 0,
                nextAttemptAt: new Date(
                  Date.parse(receivedAt) + AGGREGATION_WINDOW_MS,
                ).toISOString(),
                qqMessageId: null,
                lastError: null,
                sentAt: null,
                createdAt: receivedAt,
              };
          await connection.execute(
            'INSERT INTO workspace_delivery_events(workspace_id,event_id,subscription_id,delivery_id) VALUES(?,?,?,?)',
            [this.db.workspaceId, event.id, subscription.id, delivery.id],
          );
          await this.db.put('deliveries', delivery, connection);
          if (match) Object.assign(match, delivery);
          else pending.push(delivery);
        }
        ++accepted;
      }
      return { accepted, duplicate };
    });
  }
}
