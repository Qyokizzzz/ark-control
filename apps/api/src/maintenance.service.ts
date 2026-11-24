import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { Database } from '@/infrastructure';
import { ControlService, activeCommand, nowIso } from '@/control';
import { OutboxService } from '@/logs';

@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ControlService) private readonly control: ControlService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}
  async onModuleInit() {
    await this.db.forEachActiveWorkspace(() => this.outbox.recover());
    this.timer = setInterval(
      () =>
        void this.tick().catch((error: unknown) =>
          console.error('维护任务失败：', error instanceof Error ? error.name : 'UnknownError'),
        ),
      1000,
    );
    this.timer.unref();
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.db.forEachActiveWorkspace(() => this.tickWorkspace());
    } finally {
      this.busy = false;
    }
  }
  private async tickWorkspace() {
    await this.outbox.tick();
    await this.db.transaction(async (connection) => {
      const now = nowIso();
      for (const schedule of await this.db.list('schedules', connection)) {
        if (!schedule.enabled || !schedule.nextRunAt || schedule.nextRunAt > now) continue;
        try {
          await this.control.enqueue(
            schedule.instanceId,
            {
              kind: schedule.kind,
              countdownSeconds: schedule.countdownSeconds,
              idempotencyKey: randomUUID(),
              maintenance: schedule.kind === 'update',
            },
            connection,
          );
        } catch (error) {
          await this.control.audit(
            '计划未执行',
            schedule.name,
            error instanceof Error ? error.message : '任务无法执行。',
            connection,
            '维护计划',
          );
        }
        const next = CronExpressionParser.parse(schedule.cron, { tz: schedule.timezone })
          .next()
          .toISOString();
        await this.db.put(
          'schedules',
          { ...schedule, nextRunAt: next, lastRunAt: now },
          connection,
        );
      }
      const commands = await this.db.list('commands', connection);
      const rolling = (await this.db.list('branch-rollouts', connection))
        .filter((item) => !['succeeded', 'failed'].includes(item.phase))
        .flatMap((item) => item.instanceIds);
      const hosts = await this.db.list('hosts', connection);
      for (const instance of await this.db.list('instances', connection)) {
        if (
          !instance.autoRestart ||
          rolling.includes(instance.id) ||
          !!instance.pid ||
          instance.desiredState !== 'running' ||
          !['error', 'stopped'].includes(instance.status)
        )
          continue;
        const host = hosts.find((item) => item.id === instance.hostId);
        if (!host?.lastSeenAt || Date.now() - Date.parse(host.lastSeenAt) > 30000) continue;
        if (commands.some((item) => item.instanceId === instance.id && activeCommand(item)))
          continue;
        const recent = commands.filter(
          (item) =>
            item.instanceId === instance.id &&
            item.kind === 'start' &&
            Date.now() - Date.parse(item.createdAt) < 10 * 60000,
        );
        if (recent.length >= 3) {
          await this.db.put(
            'instances',
            {
              ...instance,
              desiredState: 'stopped',
              lastError: '十分钟内启动失败达到三次，已暂停自动拉起，请检查日志。',
            },
            connection,
          );
          continue;
        }
        const latest = recent.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (latest && Date.now() - Date.parse(latest.createdAt) < 30000) continue;
        try {
          await this.control.enqueue(
            instance.id,
            {
              kind: 'start',
              countdownSeconds: 0,
              idempotencyKey: randomUUID(),
              maintenance: false,
            },
            connection,
          );
        } catch {
          /* Resource or host precondition will be re-evaluated on the next tick. */
        }
      }
    });
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
