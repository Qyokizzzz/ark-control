import { Body, Controller, Get, Header, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  INSTANCE_STATUSES,
  enrollSchema,
  pluginReportSchema,
  tribeEventSchema,
  serverFilesReportSchema,
} from '@ark-control/common';
import { Public } from '@/auth';
import { BusinessError, Database, parse } from '@/infrastructure';
import { ControlService } from '@/control';
import { LogsService } from '@/logs';
import { AgentGuard } from '@/agents/agent.guard';
import type { AgentRequest } from '@/agents/agent.guard';
import { AgentsService } from '@/agents/agents.service';

@Public()
@Controller('agent')
export class EnrollmentController {
  constructor(@Inject(ControlService) private readonly control: ControlService) {}
  @Post('enroll') enroll(@Body() body: unknown) {
    const input = parse(enrollSchema, body);
    return this.control.enroll(input.code, input.platform, input.agentVersion);
  }
}

const metricsSchema = z.object({
  cpuPercent: z.number().min(0).max(100),
  cpuCores: z.number().int().min(1).max(2048),
  cpuModel: z.string().max(200),
  totalMemoryMb: z.number().nonnegative(),
  freeMemoryMb: z.number().nonnegative(),
  diskFreeGb: z.number().nonnegative(),
  diskTotalGb: z.number().nonnegative(),
  gameDiskMeasured: z.boolean().optional(),
  sampledAt: z.string().datetime(),
});
const reportSchema = z.object({
  plugins: pluginReportSchema.optional(),
  verifiedClusterAdminRevision: z.uuid().optional(),
  startup: z
    .object({
      stage: z.enum(['preparing', 'launching', 'loading', 'ready', 'failed']),
      startedAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
      message: z.string().max(1000),
      rconReady: z.boolean(),
      lastRconError: z.string().max(1000).nullable(),
      logUpdatedAt: z.string().datetime().nullable(),
      logPaths: z.array(z.string().max(1000)).max(2),
      logs: z.array(z.string().max(600)).max(10),
    })
    .nullable()
    .optional(),
  id: z.string().uuid(),
  serverFileId: z.string().uuid().nullable().optional(),
  status: z.enum(INSTANCE_STATUSES),
  installed: z.boolean(),
  cpuPercent: z.number().nonnegative(),
  memoryMb: z.number().nonnegative(),
  pid: z.number().int().positive().nullable(),
  startedAt: z.string().datetime().nullable(),
  lastError: z.string().max(3000).nullable(),
  buildId: z.string().max(100).nullable(),
});
@Public()
@UseGuards(AgentGuard)
@Controller('agent')
export class AgentsController {
  constructor(
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(Database) private readonly db: Database,
    @Inject(LogsService) private readonly logs: LogsService,
  ) {}
  @Get('poll') poll(@Req() request: AgentRequest) {
    const features = String(request.headers['x-ark-agent-features'] ?? '').split(',');
    return this.agents.poll(request.agentHostId, features);
  }
  @Post('heartbeat') heartbeat(@Req() request: AgentRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        features: z.array(z.string().max(80)).max(20).optional(),
        branchBuilds: z
          .array(
            z.object({
              branch: z.enum(['public', 'preaquatica']),
              buildId: z.string().regex(/^\d{1,30}$/),
              checkedAt: z.string().datetime(),
            }),
          )
          .max(2)
          .optional(),
        serverFiles: z.array(serverFilesReportSchema).max(2000).optional(),
        filesScanComplete: z.boolean().default(false),
        metrics: metricsSchema,
        instances: z.array(reportSchema).max(200),
        runningCommands: z.array(z.string().uuid()).max(200),
        warnings: z.array(z.string().max(1000)).max(200).default([]),
        console: z
          .array(
            z.object({
              instanceId: z.string().uuid(),
              level: z.enum(['info', 'warn', 'error']),
              text: z.string().max(3000),
            }),
          )
          .max(100),
        connections: z
          .array(
            z.object({
              networkId: z.string().uuid(),
              status: z.enum(['starting', 'started', 'error']),
              message: z.string().max(500),
            }),
          )
          .max(200)
          .default([]),
      }),
      body,
    );
    return this.agents.heartbeat(
      request.agentHostId,
      input.metrics,
      input.instances,
      input.runningCommands,
      input.console,
      input.connections,
      input.warnings,
      input.features,
      input.serverFiles,
      input.filesScanComplete,
      input.branchBuilds,
    );
  }
  @Post('disconnect') disconnect(@Req() request: AgentRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        instances: z.array(reportSchema).max(200),
        error: z.string().max(3000).nullable(),
      }),
      body,
    );
    return this.agents.completeDisconnect(request.agentHostId, input.instances, input.error);
  }
  @Post('commands/:id/commit-stop') commitStop(
    @Req() request: AgentRequest,
    @Param('id') id: string,
  ) {
    return this.agents.commitStop(request.agentHostId, id);
  }
  @Post('commands/:id/launch-credential')
  @Header('Cache-Control', 'no-store')
  launchCredential(@Req() request: AgentRequest, @Param('id') id: string) {
    return this.agents.launchCredential(request.agentHostId, parse(z.uuid(), id));
  }
  @Post('commands/:id/ack') ack(
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
    return this.agents.acknowledge(
      request.agentHostId,
      id,
      input.status,
      input.progress,
      input.result,
      input.error,
    );
  }
  @Post('events') async events(@Req() request: AgentRequest, @Body() body: unknown) {
    const input = parse(z.object({ events: z.array(tribeEventSchema).max(500) }), body);
    const ids = new Set(
      (await this.db.list('instances'))
        .filter((item) => item.hostId === request.agentHostId)
        .map((item) => item.id),
    );
    if (input.events.some((item) => !ids.has(item.instanceId)))
      throw new BusinessError('INSTANCE_FORBIDDEN', '主机不能提交其他主机的地图日志。', 403);
    return this.logs.ingest(input.events);
  }
}
