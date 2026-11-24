import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { BusinessError, Database, tokensEqual } from '@/infrastructure';
import { runInWorkspace, workspaceContext } from '@/workspaces/context';

export interface AgentRequest extends Request {
  agentHostId: string;
}
@Injectable()
export class AgentGuard implements CanActivate {
  constructor(@Inject(Database) private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AgentRequest>();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
    const separator = token.indexOf('.');
    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    const workspaceId = separator > 0 ? await this.db.locate('hosts', id) : null;
    const workspace = workspaceId ? await this.db.get('workspaces', workspaceId) : null;
    const credential =
      workspaceId && workspace
        ? await runInWorkspace(workspaceId, () => this.db.get('host-credentials', id))
        : null;
    if (!workspaceId || !credential?.tokenHash || !tokensEqual(secret, credential.tokenHash))
      throw new BusinessError('AGENT_UNAUTHORIZED', '主机助手认证失败，请重新接入。', 401);
    if (workspace?.status !== 'active')
      throw new BusinessError('WORKSPACE_SUSPENDED', '工作空间已暂停，主机助手正在等待恢复。', 403);
    const scope = workspaceContext.getStore();
    if (!scope) throw new Error('Agent request context is missing');
    scope.workspaceId = workspaceId;
    scope.agentHostId = id;
    scope.agentTokenHash = credential.tokenHash;
    request.agentHostId = id;
    return true;
  }
}
