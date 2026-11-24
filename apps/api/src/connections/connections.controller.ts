import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  CONNECT_RUNTIME,
  connectionInviteSchema,
  connectionNetworkSchema,
} from '@ark-control/common';
import { BusinessError, config, parse } from '@/infrastructure';
import { Public } from '@/auth';
import { AgentGuard } from '@/agents/agent.guard';
import { ConnectionsService } from '@/connections/connections.service';
import { bootstrapTrailer } from '@/connections/protocol';

@Controller('connections')
export class ConnectionsController {
  constructor(@Inject(ConnectionsService) private readonly connections: ConnectionsService) {}
  @Get() state() {
    return this.connections.state();
  }
  @Post() create(@Body() body: unknown) {
    return this.connections.save(parse(connectionNetworkSchema, body));
  }
  @Patch(':id') update(@Param('id') id: string, @Body() body: unknown) {
    return this.connections.save(parse(connectionNetworkSchema, body), id);
  }
  @Post(':id/invites') invite(@Param('id') id: string, @Body() body: unknown) {
    const input = parse(connectionInviteSchema, body);
    return this.connections.invite(id, input.name, input.autoLaunch, input.steamId);
  }
  @Delete(':id') remove(@Param('id') id: string) {
    return this.connections.remove(id);
  }
  @Patch('invites/:id') setInvite(@Param('id') id: string, @Body() body: unknown) {
    return this.connections.setInviteEnabled(
      id,
      parse(z.object({ enabled: z.boolean() }), body).enabled,
    );
  }
  @Get('invites/:id/download') async download(@Param('id') id: string, @Res() response: Response) {
    const path = resolve(config.CONNECT_LAUNCHER_PATH);
    if (!existsSync(path))
      throw new BusinessError(
        'LAUNCHER_MISSING',
        '请先在 Windows 上运行 pnpm run build:connect 生成客户端。',
        503,
      );
    const trailer = bootstrapTrailer(await this.connections.bootstrap(id));
    response.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="ArkConnect-${id.slice(0, 8)}.exe"`,
      'Cache-Control': 'no-store',
      'Content-Length': String((await stat(path)).size + trailer.length),
    });
    // Keep the PE image unchanged; the launcher reads its bootstrap configuration from the tail.
    for await (const chunk of createReadStream(path)) {
      if (response.destroyed) return;
      if (!response.write(chunk)) await new Promise<void>((yes) => response.once('drain', yes));
    }
    response.end(trailer);
  }
}
@Public()
@Controller('connect')
export class ConnectionManifestController {
  constructor(@Inject(ConnectionsService) private readonly connections: ConnectionsService) {}
  @Get(':id/manifest') manifest(
    @Param('id') id: string,
    @Headers('x-connect-key') token: string | undefined,
    @Headers('x-connect-device') deviceId: string | undefined,
    @Headers('x-connect-device-consent') consent: string | undefined,
  ) {
    return this.connections.manifest(
      id,
      typeof token === 'string' && token.length <= 200 ? token : '',
      typeof deviceId === 'string' && deviceId.length === 64 ? deviceId : undefined,
      consent,
    );
  }
}
@Public()
@UseGuards(AgentGuard)
@Controller('agent/connections')
export class ConnectionRuntimeController {
  @Get('runtime/windows') async runtime(@Res() response: Response) {
    const runtime = CONNECT_RUNTIME.windows;
    const path = resolve(config.CONNECT_VENDOR_DIR, runtime.file);
    if (!existsSync(path))
      throw new BusinessError(
        'RUNTIME_MISSING',
        '联机组件缺失，请运行 pnpm run build:connect。',
        503,
      );
    response.set({
      'Content-Type': 'application/zip',
      'X-Connect-Sha256': runtime.sha256,
      'Content-Length': String((await stat(path)).size),
    });
    await pipeline(createReadStream(path), response);
  }
}
