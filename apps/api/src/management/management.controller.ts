import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  chatShopReceiptSchema,
  chatShopRequestSchema,
  independentCatalogSchema,
  shopModeSchema,
} from '@ark-control/common';
import { Public } from '@/auth';
import { AgentGuard } from '@/agents/agent.guard';
import type { AgentRequest } from '@/agents/agent.guard';
import { parse } from '@/infrastructure';
import { ManagementService } from '@/management/management.service';
import { BranchUpdatesService } from './branches.service';
import { IndependentShopService } from './independent-shop.service';

const scopeId = z.string().min(1).max(65);
const steamId = z.string().regex(/^765\d{14}$/, 'SteamID 需要为 17 位 SteamID64。');
const group = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,39}$/);
const actionSchema = z.object({
  scopeId,
  steamId: steamId.optional(),
  instanceId: z.string().uuid().optional(),
  kind: z.enum([
    'sync',
    'coins',
    'vip-grant',
    'vip-revoke',
    'ban',
    'unban',
    'shop-read',
    'shop-publish',
  ]),
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  amount: z.number().int().min(-100000000).max(100000000).optional(),
  group: group.optional(),
  hours: z.number().int().min(1).max(87600).optional(),
  ips: z.array(z.ipv4()).max(30).default([]),
  devices: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(30)
    .default([]),
  allowSharedIp: z.boolean().default(false),
  expiresAt: z
    .string()
    .datetime()
    .refine((value) => Date.parse(value) > Date.now(), '封禁到期时间需要晚于当前时间。')
    .nullable()
    .optional(),
  banId: z.string().uuid().optional(),
  revision: z.number().int().positive().optional(),
  preflightId: z.uuid().optional(),
});
@Controller('management')
export class ManagementController {
  constructor(
    @Inject(ManagementService) private readonly management: ManagementService,
    @Inject(BranchUpdatesService) private readonly branches: BranchUpdatesService,
    @Inject(IndependentShopService) private readonly independent: IndependentShopService,
  ) {}
  @Get('ledger') ledger(@Query() query: unknown) {
    const input = parse(
      z.object({
        scopeId,
        page: z.coerce.number().int().min(1).max(10000000).default(1),
        steamId: steamId.optional(),
        source: z.enum(['admin', 'game']).optional(),
        before: z.string().datetime().optional(),
      }),
      query,
    );
    return this.management.ledger(
      input.scopeId,
      input.page,
      input.steamId ?? '',
      input.source ?? '',
      input.before ?? new Date().toISOString(),
    );
  }
  @Post('branches/:id/retry') retryBranch(@Param('id') id: string) {
    return this.branches.retry(id);
  }
  @Get() state(@Query() query: unknown) {
    const input = parse(
      z.object({
        scopeId: scopeId.optional(),
        q: z.string().max(200).default(''),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        filter: z.enum(['all', 'online', 'banned', 'vip']).default('all'),
      }),
      query,
    );
    return this.management.state(input.scopeId, input.q, input.page, input.filter);
  }
  @Post('players') player(@Body() body: unknown) {
    return this.management.player(
      parse(
        z.object({
          scopeId,
          steamId,
          name: z.string().trim().max(120).default(''),
          note: z.string().trim().max(1000).default(''),
        }),
        body,
      ),
    );
  }
  @Post('actions') action(@Body() body: unknown) {
    return this.management.enqueue(parse(actionSchema, body));
  }
  @Post('shop/preflight') prepareShop(@Body() body: unknown) {
    const input = parse(
      z.object({ scopeId, revision: z.number().int().nonnegative(), idempotencyKey: z.uuid() }),
      body,
    );
    return this.management.enqueue({
      scopeId: input.scopeId,
      kind: 'shop-read',
      reason: '发布前读取各地图的 ArkShop 配置',
      idempotencyKey: input.idempotencyKey,
      preflightRevision: input.revision,
    });
  }
  @Get('shop/preflight/:id') previewShop(
    @Param('id') id: string,
    @Query('scopeId') scope: unknown,
  ) {
    return this.management.shopPreview(parse(scopeId, scope), parse(z.uuid(), id));
  }
  @Post('settings') settings(@Body() body: unknown) {
    const input = parse(z.object({ scopeId, vipGroups: z.array(group).min(1).max(20) }), body);
    return this.management.settings(input.scopeId, input.vipGroups);
  }
  @Post('shop') shop(@Body() body: unknown) {
    const input = parse(
      z.object({
        scopeId,
        revision: z.number().int().nonnegative(),
        config: z.record(z.string(), z.json()),
      }),
      body,
    );
    return this.management.saveShop(input.scopeId, input.revision, input.config);
  }
  @Post('shop/mode') shopMode(@Body() body: unknown) {
    const input = parse(z.object({ scopeId, mode: shopModeSchema }), body);
    return this.independent.setMode(input.scopeId, input.mode);
  }
  @Post('shop/catalog') catalog(@Body() body: unknown) {
    const input = parse(
      z.object({
        scopeId,
        revision: z.number().int().nonnegative(),
        products: independentCatalogSchema,
      }),
      body,
    );
    return this.independent.saveCatalog(input.scopeId, input.revision, input.products);
  }
  @Get('shop/orders') shopOrders(@Query() query: unknown) {
    const input = parse(
      z.object({ scopeId, page: z.coerce.number().int().min(1).max(100000).default(1) }),
      query,
    );
    return this.independent.orders(input.scopeId, input.page);
  }
  @Post('shop/orders/:id/resolve') resolveOrder(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        outcome: z.enum(['delivered', 'failed']),
        evidence: z.string().trim().min(5).max(500),
      }),
      body,
    );
    return this.independent.resolve(parse(z.uuid(), id), input.outcome, input.evidence);
  }
  @Post('tasks/:id/resolve') resolve(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(
      z.object({
        outcome: z.enum(['succeeded', 'failed']),
        evidence: z.string().trim().min(5).max(1000),
      }),
      body,
    );
    return this.management.resolve(id, input.outcome, input.evidence);
  }
  @Post('tasks/:id/cancel') cancel(@Param('id') id: string) {
    return this.management.cancel(id);
  }
}
@Public()
@UseGuards(AgentGuard)
@Controller('agent/management')
export class AgentManagementController {
  constructor(
    @Inject(ManagementService) private readonly management: ManagementService,
    @Inject(IndependentShopService) private readonly independent: IndependentShopService,
  ) {}
  @Get('poll') poll(@Req() request: AgentRequest) {
    return this.management.poll(request.agentHostId);
  }
  @Post('shop/:instanceId/request') shopRequest(
    @Req() request: AgentRequest,
    @Param('instanceId') instanceId: string,
    @Body() body: unknown,
  ) {
    return this.independent.message(
      request.agentHostId,
      parse(z.uuid(), instanceId),
      parse(chatShopRequestSchema, body),
    );
  }
  @Post('shop/:instanceId/receipt') shopReceipt(
    @Req() request: AgentRequest,
    @Param('instanceId') instanceId: string,
    @Body() body: unknown,
  ) {
    return this.independent.receipt(
      request.agentHostId,
      parse(z.uuid(), instanceId),
      parse(chatShopReceiptSchema, body),
    );
  }
  @Post('tasks/:id/ack') ack(
    @Req() request: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.management.acknowledge(
      request.agentHostId,
      id,
      parse(
        z.object({
          status: z.enum(['executing', 'succeeded', 'failed', 'uncertain']),
          result: z.record(z.string(), z.json()).nullable().default(null),
          error: z.string().max(3000).nullable().default(null),
          progress: z.string().max(1000).default(''),
        }),
        body,
      ),
    );
  }
  @Post('presence') presence(@Req() request: AgentRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        samples: z
          .array(
            z.object({
              instanceId: z.string().uuid(),
              sampledAt: z.string().datetime(),
              source: z.enum(['rcon', 'bridge']),
              players: z
                .array(
                  z.object({
                    steamId,
                    name: z.string().max(120),
                    ip: z.ipv4().optional(),
                    tribeId: z.string().max(50).optional(),
                    tribeName: z.string().max(150).optional(),
                  }),
                )
                .max(500),
            }),
          )
          .max(200),
      }),
      body,
    );
    return this.management.presence(request.agentHostId, input.samples);
  }
  @Post('events') events(@Req() request: AgentRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        events: z
          .array(
            z.object({
              eventId: z.string().min(1).max(200),
              instanceId: z.string().uuid(),
              steamId,
              kind: z.string().min(1).max(80),
              occurredAt: z.string().datetime(),
              detail: z.record(z.string(), z.json()),
            }),
          )
          .max(200),
      }),
      body,
    );
    return this.management.commerce(request.agentHostId, input.events);
  }
}
