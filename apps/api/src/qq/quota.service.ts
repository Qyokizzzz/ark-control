import { Inject, Injectable } from '@nestjs/common';
import type { RowDataPacket } from 'mysql2/promise';
import type { Bot } from '@ark-control/common';
import { Database } from '@/infrastructure';
import { createHash } from 'node:crypto';

@Injectable()
export class QuotaService {
  constructor(@Inject(Database) private readonly db: Database) {}
  async reserve(bot: Bot, openId: string): Promise<boolean> {
    return this.db.transaction(async (connection) => {
      const minute = new Date().toISOString().slice(0, 16);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
        new Date(),
      );
      const group = createHash('sha256').update(`${bot.appId}:${openId}`).digest('hex');
      const budgets = [
        { scope: `bot:${bot.appId}`, period: `m:${minute}`, limit: bot.certified ? 60 : 30 },
        { scope: `group:${group}`, period: `m:${minute}`, limit: 20 },
        { scope: `group:${group}`, period: `d:${day}`, limit: 1000 },
      ];
      for (const budget of budgets) {
        const [rows] = await connection.execute<RowDataPacket[]>(
          'SELECT amount FROM quotas WHERE scope_key=? AND period_key=?',
          [budget.scope, budget.period],
        );
        if (Number(rows[0]?.amount ?? 0) >= budget.limit) return false;
      }
      for (const budget of budgets)
        await connection.execute(
          'INSERT INTO quotas(scope_key,period_key,amount) VALUES(?,?,1) ON DUPLICATE KEY UPDATE amount=amount+1',
          [budget.scope, budget.period],
        );
      return true;
    });
  }
}
