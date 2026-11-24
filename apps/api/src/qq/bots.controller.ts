import { Body, Controller, Delete, Inject, Param, Patch, Post } from '@nestjs/common';
import { botSchema, subscriptionSchema } from '@ark-control/common';
import { z } from 'zod';
import { parse } from '@/infrastructure';
import { BotsService } from '@/qq/bots.service';
import { requireAccess } from '@/workspaces/access';

@Controller()
export class BotsController {
  constructor(@Inject(BotsService) private readonly bots: BotsService) {}
  @Post('bots') create(@Body() body: unknown) {
    requireAccess('bots.write');
    return this.bots.save(parse(botSchema, body));
  }
  @Patch('bots/:id') update(@Param('id') id: string, @Body() body: unknown) {
    requireAccess('bots.write');
    return this.bots.save(
      Object.fromEntries(
        Object.entries(parse(botSchema.partial(), body)).filter(([key]) =>
          Object.hasOwn(body as object, key),
        ),
      ),
      id,
    );
  }
  @Delete('bots/:id') remove(@Param('id') id: string) {
    requireAccess('bots.write');
    return this.bots.deleteBot(id);
  }
  @Post('bots/:id/verify') verify(@Param('id') id: string) {
    requireAccess('bots.write');
    return this.bots.verify(id);
  }
  @Post('bots/:id/binding-code') code(@Param('id') id: string) {
    requireAccess('bots.write');
    return this.bots.bindingCode(id);
  }
  @Patch('groups/:id') group(@Param('id') id: string, @Body() body: unknown) {
    requireAccess('bots.write');
    const input = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        groupNumber: z
          .string()
          .regex(/^\d{0,20}$/)
          .default(''),
      }),
      body,
    );
    return this.bots.renameGroup(id, input.name, input.groupNumber);
  }
  @Post('groups/:id/test') test(@Param('id') id: string) {
    requireAccess('bots.write');
    return this.bots.testGroup(id);
  }
  @Post('subscriptions') subscribe(@Body() body: unknown) {
    return this.bots.subscription(parse(subscriptionSchema, body));
  }
  @Patch('subscriptions/:id') updateSubscription(@Param('id') id: string, @Body() body: unknown) {
    return this.bots.subscription(parse(subscriptionSchema, body), id);
  }
  @Delete('subscriptions/:id') unsubscribe(@Param('id') id: string) {
    return this.bots.removeSubscription(id);
  }
}
