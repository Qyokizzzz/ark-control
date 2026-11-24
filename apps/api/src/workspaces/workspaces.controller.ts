import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AccountOnly } from '@/auth/auth.guard';
import type { AdminRequest } from '@/auth/auth.guard';
import { parse } from '@/infrastructure';
import { WorkspacesService } from './workspaces.service';

const workspaceId = z.uuid();
const mask = z.string().regex(/^[0-9]{1,40}$/);
const grants = z
  .array(
    z.object({
      scope: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('workspace') }),
        z.object({
          kind: z.literal('host'),
          id: z.uuid(),
          includeMaps: z.boolean().default(false),
        }),
        z.object({ kind: z.literal('map'), id: z.uuid() }),
        z.object({ kind: z.literal('cluster'), id: z.string().regex(/^[A-Za-z0-9_-]{1,48}$/) }),
      ]),
      mask,
    }),
  )
  .min(1)
  .max(100);

@AccountOnly()
@Controller('workspaces')
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly service: WorkspacesService) {}
  @Get() index(@Req() request: AdminRequest) {
    return this.service.available(request.admin.id);
  }
  @Post() apply(@Req() request: AdminRequest, @Body() body: unknown) {
    return this.service.apply(
      request.admin,
      parse(z.object({ name: z.string().trim().min(1).max(80) }), body).name,
    );
  }
  @Post('accept') accept(@Req() request: AdminRequest, @Body() body: unknown) {
    return this.service.accept(
      request.admin,
      parse(
        z.object({
          code: z
            .string()
            .trim()
            .regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32,128}$/i),
        }),
        body,
      ).code,
    );
  }
  @Get(':id/members') team(@Req() request: AdminRequest, @Param('id') id: string) {
    return this.service.team(request.admin.id, parse(workspaceId, id));
  }
  @Post(':id/invitations') invite(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(z.object({ email: z.email().max(254), grants }), body);
    return this.service.invite(
      request.admin,
      parse(workspaceId, id),
      input.email.toLowerCase(),
      input.grants,
    );
  }
  @Delete(':id/invitations/:inviteId') revoke(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
  ) {
    return this.service.revokeInvite(
      request.admin,
      parse(workspaceId, id),
      parse(z.uuid(), inviteId),
    );
  }
  @Patch(':id/members/:accountId') grants(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    return this.service.setGrants(
      request.admin,
      parse(workspaceId, id),
      parse(z.uuid(), accountId),
      parse(z.object({ grants }), body).grants,
    );
  }
  @Delete(':id/members/:accountId') member(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Param('accountId') accountId: string,
  ) {
    return this.service.removeMember(
      request.admin,
      parse(workspaceId, id),
      parse(z.uuid(), accountId),
    );
  }
}

const limit = z.number().int().min(0).max(100000).nullable();
@AccountOnly()
@Controller('platform/workspaces')
export class PlatformWorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly service: WorkspacesService) {}
  @Get() index(@Req() request: AdminRequest) {
    return this.service.platformList(request.admin);
  }
  @Patch(':id') review(
    @Req() request: AdminRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const patch = parse(
      z
        .object({
          status: z.enum(['active', 'rejected', 'suspended']).optional(),
          limits: z.object({ hosts: limit, maps: limit, members: limit }).optional(),
        })
        .refine((value) => value.status || value.limits),
      body,
    );
    return this.service.review(request.admin, parse(z.uuid(), id), patch);
  }
}
