import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '@/infrastructure';
import { OutboxService } from '@/logs/outbox.service';

@Controller('deliveries')
export class LogsController {
  constructor(@Inject(OutboxService) private readonly outbox: OutboxService) {}
  @Post(':id/retry') retry(@Param('id') id: string, @Body() body: unknown) {
    return this.outbox.retry(
      id,
      parse(z.object({ acknowledgeUncertain: z.boolean().default(false) }), body)
        .acknowledgeUncertain,
    );
  }
}
