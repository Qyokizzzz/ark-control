import type { Database, Connection } from '@/infrastructure';
import { randomUUID } from 'node:crypto';
import type { Command, Instance, Json } from '@ark-control/common';

export function newInstanceCommand(
  instance: Instance,
  input: Pick<Command, 'kind' | 'idempotencyKey'>,
  payload: Record<string, Json>,
): Command {
  return {
    id: randomUUID(),
    hostId: instance.hostId,
    instanceId: instance.id,
    clusterId: instance.clusterId,
    kind: input.kind,
    payload,
    status: input.kind === 'sync-config' ? 'waiting-agent' : 'queued',
    progress:
      input.kind === 'sync-config'
        ? '配置已保存，等待主机助手写入 INI。'
        : payload.cleanup
          ? '地图已删除，等待助手回收存档并保留下载文件。'
          : '已加入主机任务队列',
    result: null,
    error: null,
    leaseUntil: null,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

// Keep backups and historical tasks/logs; remove live configuration and revoke map-specific launchers.
export async function removeInstanceResources(
  db: Database,
  instanceId: string,
  connection: Connection,
) {
  for (const task of await db.inStates('commands', ['waiting-agent'], connection))
    if (task.instanceId === instanceId)
      await db.put(
        'commands',
        {
          ...task,
          status: 'cancelled',
          progress: '地图已删除，配置同步已取消。',
          completedAt: new Date().toISOString(),
        },
        connection,
      );
  for (const schedule of await db.list('schedules', connection))
    if (schedule.instanceId === instanceId) await db.remove('schedules', schedule.id, connection);
  for (const subscription of await db.list('subscriptions', connection))
    if (subscription.instanceId === instanceId)
      await db.remove('subscriptions', subscription.id, connection);
  for (const tribe of await db.list('tribes', connection))
    if (tribe.instanceId === instanceId) await db.remove('tribes', tribe.id, connection);
  for (const delivery of await db.list('deliveries', connection))
    if (
      delivery.instanceId === instanceId &&
      !['sent', 'skipped', 'uncertain'].includes(delivery.status)
    )
      await db.put(
        'deliveries',
        {
          ...delivery,
          status: delivery.status === 'sending' ? 'uncertain' : 'skipped',
          lastError:
            delivery.status === 'sending'
              ? '地图删除时消息已在发送，请核对实际群消息。'
              : '地图已删除，停止后续推送。',
        },
        connection,
      );
  for (const network of await db.list('connection-networks', connection)) {
    if (network.instanceId !== instanceId) continue;
    for (const invite of await db.list('connection-invites', connection))
      if (invite.networkId === network.id)
        await db.remove('connection-invites', invite.id, connection);
    await db.remove('connection-networks', network.id, connection);
    await db.remove('connection-credentials', network.id, connection);
  }
  await db.remove('instance-credentials', instanceId, connection);
  await db.remove('instances', instanceId, connection);
}
