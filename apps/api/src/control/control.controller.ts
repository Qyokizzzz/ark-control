import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  commandSchema,
  createHostSchema,
  createInstanceSchema,
  gameAdminPasswordSchema,
  scheduleSchema,
  updateInstanceSchema,
} from '@ark-control/common';
import { z } from 'zod';
import type { AdminRequest } from '@/auth';
import { ControlService } from '@/control/control.service';
import { parse } from '@/infrastructure';
import { requireAccess, requireHostAccess } from '@/workspaces/access';

@Controller()
export class ControlController {
  constructor(@Inject(ControlService) private readonly control: ControlService) {}
  @Get('dashboard') dashboard() {
    return this.control.dashboard();
  }
  @Get('audit/:id') configAudit(@Param('id') id: string) {
    return this.control.configAudit(parse(z.uuid(), id));
  }
  @Post('hosts') createHost(@Body() body: unknown) {
    requireAccess('hosts.create');
    const input = parse(createHostSchema, body);
    return this.control.createHost(input.name, input.address);
  }
  @Post('hosts/:id/enrollment') async renewCode(@Param('id') id: string) {
    await requireHostAccess(this.control.db, 'hosts.enroll', id);
    return this.control.renewHostCode(id);
  }
  @Post('hosts/:id/disconnect') async disconnect(@Param('id') id: string) {
    await requireHostAccess(this.control.db, 'hosts.disconnect', id);
    return this.control.disconnectHost(id);
  }
  @Post('hosts/:id/cleanup-retry') async retryCleanup(@Param('id') id: string) {
    await requireHostAccess(this.control.db, 'hosts.disconnect', id);
    return this.control.retryHostCleanups(id);
  }
  @Delete('hosts/:id') async removeHost(@Param('id') id: string) {
    await requireHostAccess(this.control.db, 'hosts.delete', id);
    return this.control.removeHost(id);
  }
  @Get('hosts/:id/capacity') capacity(@Param('id') id: string, @Query() query: unknown) {
    const input = parse(
      z.object({
        players: z.coerce.number().int().min(1).max(200).default(20),
        mods: z.coerce.number().int().min(0).max(60).default(0),
      }),
      query,
    );
    return this.control.capacity(id, input.players, input.mods);
  }
  @Post('instances') create(@Body() body: unknown) {
    return this.control.createInstance(parse(createInstanceSchema, body));
  }
  @Get('clusters/admin-passwords') clusterAdminSettings() {
    return this.control.clusterAdminSettings();
  }
  @Patch('clusters/:id/admin-password') configureClusterAdmin(
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { password } = parse(z.object({ password: gameAdminPasswordSchema }), body);
    return this.control.configureClusterAdmin(id, password);
  }
  @Patch('instances/:id') update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ) {
    return this.control.updateInstance(
      id,
      Object.fromEntries(
        Object.entries(parse(updateInstanceSchema, body)).filter(([key]) =>
          Object.hasOwn(body as object, key),
        ),
      ),
      request.admin,
    );
  }
  @Post('instances/:id/commands') command(@Param('id') id: string, @Body() body: unknown) {
    return this.control.enqueue(id, parse(commandSchema, body));
  }
  @Post('commands/:id/cancel') cancel(@Param('id') id: string) {
    return this.control.cancelCommand(id);
  }
  @Post('schedules') schedule(@Body() body: unknown) {
    return this.control.saveSchedule(parse(scheduleSchema, body));
  }
  @Patch('schedules/:id') updateSchedule(@Param('id') id: string, @Body() body: unknown) {
    return this.control.saveSchedule(parse(scheduleSchema, body), id);
  }
  @Delete('schedules/:id') removeSchedule(@Param('id') id: string) {
    return this.control.removeSchedule(id);
  }
}
