import { Body, Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { fileTaskSchema } from '@ark-control/common';
import { Public } from '@/auth';
import { AgentGuard } from '@/agents/agent.guard';
import type { AgentRequest } from '@/agents/agent.guard';
import { parse } from '@/infrastructure';
import { ServerFilesService } from '@/server-files/server-files.service';

@Controller()
export class ServerFilesController {
  constructor(@Inject(ServerFilesService) private readonly files: ServerFilesService) {}
  @Post('server-files/tasks') create(@Body() body: unknown) {
    return this.files.enqueue(parse(fileTaskSchema, body));
  }
  @Post('server-files/tasks/:id/cancel') cancel(@Param('id') id: string) {
    return this.files.cancel(id);
  }
  @Post('server-files/tasks/:id/retry') retry(@Param('id') id: string) {
    return this.files.retry(id);
  }
}
@Public()
@UseGuards(AgentGuard)
@Controller('agent/file-tasks')
export class AgentFileTasksController {
  constructor(@Inject(ServerFilesService) private readonly files: ServerFilesService) {}
  @Post(':id/ack') ack(
    @Req() request: AgentRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        status: z.enum(['executing', 'succeeded', 'failed', 'cancelled']),
        progress: z.string().max(1000).default(''),
        result: z.record(z.string(), z.json()).nullable().default(null),
        error: z.string().max(3000).nullable().default(null),
      }),
      body,
    );
    return this.files.acknowledge(
      request.agentHostId,
      id,
      input.status,
      input.progress,
      input.result,
      input.error,
    );
  }
}
