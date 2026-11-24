import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Admin } from '@ark-control/common';
import { AuthService } from '@/auth/auth.service';
import { workspaceContext } from '@/workspaces/context';
import { WorkspacesService } from '@/workspaces/workspaces.service';

export const Public = () => SetMetadata('public', true);
export const AccountOnly = () => SetMetadata('accountOnly', true);
export type AdminRequest = Request & { admin: Admin };
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const request = context.switchToHttp().getRequest<AdminRequest>();
    request.admin = await this.auth.verify(
      request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '',
    );
    const scope = workspaceContext.getStore();
    if (!scope) throw new Error('Request context is missing');
    scope.actor = request.admin;
    if (
      !this.reflector.getAllAndOverride<boolean>('accountOnly', [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      const selected = await this.workspaces.resolve(
        request.admin.id,
        request.get('x-ark-workspace'),
      );
      scope.workspaceId = selected.workspace.id;
      scope.workspace = selected.workspace;
      scope.membershipVersion = selected.memberVersion;
    }
    return true;
  }
}
