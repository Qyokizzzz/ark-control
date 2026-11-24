import type { Bot } from '@ark-control/common';
import { config } from '@/infrastructure/config';
import type { Connection, Database } from '@/infrastructure/database';

const platformBotId = '00000000-0000-4000-8000-000000000001';
const defaultBot: Bot | null = config.PLATFORM_QQ_APP_ID
  ? {
      id: platformBotId,
      name: '平台 QQ 机器人',
      appId: config.PLATFORM_QQ_APP_ID,
      owner: '平台',
      isDefault: true,
      platformManaged: true,
      enabled: true,
      certified: config.PLATFORM_QQ_CERTIFIED === 'true',
      eventMode: 'webhook',
      status: 'configured',
      lastError: null,
      verifiedAt: null,
      createdAt: new Date(0).toISOString(),
      hasSecret: true,
    }
  : null;

export function isPlatformBot(id: string) {
  return id === platformBotId;
}
export function withPlatformBot(bots: Bot[]) {
  return defaultBot
    ? [{ ...defaultBot, isDefault: !bots.some((bot) => bot.isDefault) }, ...bots]
    : bots;
}
export async function findBot(db: Database, id: string, connection?: Connection) {
  return isPlatformBot(id) ? defaultBot : db.get('bots', id, connection);
}
