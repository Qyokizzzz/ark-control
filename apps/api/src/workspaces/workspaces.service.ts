import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { grantAllowsArea, permissionsFromMask } from '@ark-control/common';
import type {
  Admin,
  PlatformWorkspace,
  Workspace,
  WorkspaceGrant,
  WorkspaceInfo,
  WorkspaceTeam,
} from '@ark-control/common';
import {
  BusinessError,
  Database,
  hashToken,
  membershipId,
  newToken,
  tokensEqual,
} from '@/infrastructure';
import type { Connection, Membership } from '@/infrastructure';
import { runInWorkspace } from './context';

const time = () => new Date().toISOString();

export function newWorkspace(
  ownerId: string,
  name: string,
  status: Workspace['status'],
): Workspace {
  return {
    id: randomUUID(),
    ownerId,
    name,
    status,
    createdAt: time(),
    limits: { hosts: null, maps: null, members: null },
  };
}

@Injectable()
export class WorkspacesService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async available(accountId: string): Promise<WorkspaceInfo[]> {
    const [owned, memberships] = await Promise.all([
      this.db.listBy('workspaces', 'ownerId', accountId),
      this.db.listBy('memberships', 'accountId', accountId),
    ]);
    const joined = await Promise.all(
      memberships.map(async (member) => {
        const workspace = await this.db.get('workspaces', member.workspaceId);
        return workspace ? { ...workspace, role: 'member' as const, grants: member.grants } : null;
      }),
    );
    return [
      ...owned.map((workspace) => ({ ...workspace, role: 'owner' as const, grants: [] })),
      ...joined.filter((workspace) => workspace !== null),
    ];
  }

  async resolve(accountId: string, requested?: string) {
    if (requested && !/^[0-9a-f-]{36}$/i.test(requested)) this.unavailable();
    if (!requested) {
      const active = (await this.available(accountId)).filter(
        (workspace) => workspace.status === 'active',
      );
      requested =
        active.find((workspace) => workspace.role === 'owner')?.id ??
        (active.length === 1 ? active[0]?.id : undefined);
    }
    const space = requested ? await this.db.get('workspaces', requested) : null;
    if (space?.status !== 'active') this.unavailable();
    if (space.ownerId === accountId)
      return { workspace: { ...space, role: 'owner' as const, grants: [] } };
    const member = await this.db.get('memberships', membershipId(space.id, accountId));
    if (!member) this.unavailable();
    return {
      workspace: { ...space, role: 'member' as const, grants: member.grants },
      memberVersion: member.version,
    };
  }

  async apply(account: Admin, name: string) {
    return this.db.transaction(async (connection) => {
      const [existing] = await this.db.listBy('workspaces', 'ownerId', account.id, connection);
      if (existing && existing.status !== 'rejected')
        throw new BusinessError('WORKSPACE_EXISTS', '你已有自己的工作空间或待审核申请。', 409);
      const workspace: Workspace = existing
        ? { ...existing, name, status: 'pending' }
        : newWorkspace(account.id, name, 'pending');
      return this.db.put('workspaces', workspace, connection);
    });
  }

  async team(accountId: string, id: string): Promise<WorkspaceTeam> {
    await this.owner(accountId, id);
    const [members, invitations] = await Promise.all([
      this.db.listBy('memberships', 'workspaceId', id),
      this.db.listBy('invitations', 'workspaceId', id),
    ]);
    const accounts = await Promise.all(
      members.map((member) => this.db.get('accounts', member.accountId)),
    );
    return {
      members: members.map(({ id, accountId, grants, createdAt }, index) => ({
        id,
        accountId,
        grants,
        createdAt,
        name: accounts[index]?.name ?? '账号',
        email: accounts[index]?.email ?? '',
      })),
      invitations: invitations
        .filter((invite) => invite.expiresAt > time())
        .map(({ id, email, expiresAt, grants }) => ({
          id,
          email,
          expiresAt,
          grants,
        })),
    };
  }

  async invite(actor: Admin, id: string, email: string, grants: WorkspaceGrant[]) {
    return this.db.transaction(async (connection) => {
      const workspace = await this.owner(actor.id, id, connection);
      if (email === actor.email)
        throw new BusinessError('SELF_INVITE', '服主已经拥有本空间管理权限。');
      const [account] = await this.db.listBy('accounts', 'email', email, connection);
      if (account && (await this.db.get('memberships', membershipId(id, account.id), connection)))
        throw new BusinessError('MEMBER_EXISTS', '这个账号已经是本空间成员。', 409);
      await this.validateGrants(id, grants, connection);
      for (const invite of await this.db.listBy('invitations', 'workspaceId', id, connection))
        if (invite.email === email || invite.expiresAt <= time())
          await this.db.remove('invitations', invite.id, connection);
      const secret = newToken();
      const invitation = {
        id: randomUUID(),
        workspaceId: id,
        email,
        codeHash: hashToken(secret),
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        grants,
      };
      await this.db.put('invitations', invitation, connection);
      await this.audit(workspace.id, actor, '邀请协管成员', email, connection);
      return { code: invitation.id + '.' + secret, expiresAt: invitation.expiresAt };
    });
  }

  async accept(actor: Admin, code: string) {
    const [id, secret] = code.split('.');
    if (!id || !secret) this.invalidInvitation();
    return this.db.transaction(async (connection) => {
      const invite = await this.db.get('invitations', id, connection);
      if (
        !invite ||
        invite.email !== actor.email ||
        invite.expiresAt <= time() ||
        !tokensEqual(secret, invite.codeHash)
      )
        this.invalidInvitation();
      const workspace = await this.db.get('workspaces', invite.workspaceId, connection);
      if (workspace?.status !== 'active') this.unavailable();
      await this.validateGrants(workspace.id, invite.grants, connection);
      const key = membershipId(workspace.id, actor.id);
      if (!(await this.db.get('memberships', key, connection))) {
        const limit = workspace.limits.members;
        if (
          limit !== null &&
          (await this.db.listBy('memberships', 'workspaceId', workspace.id, connection)).length >=
            limit
        )
          throw new BusinessError('WORKSPACE_LIMIT', '这个工作空间的成员名额已满。', 409);
        await this.db.put(
          'memberships',
          {
            id: key,
            accountId: actor.id,
            workspaceId: workspace.id,
            grants: invite.grants,
            createdAt: time(),
            version: randomUUID(),
          },
          connection,
        );
        await this.audit(workspace.id, actor, '接受协管邀请', actor.email, connection);
      }
      await this.db.remove('invitations', invite.id, connection);
      return { workspaceId: workspace.id };
    });
  }

  async setGrants(actor: Admin, id: string, accountId: string, grants: WorkspaceGrant[]) {
    return this.db.transaction(async (connection) => {
      await this.owner(actor.id, id, connection);
      const member = await this.member(id, accountId, connection);
      await this.validateGrants(id, grants, connection);
      await this.db.put('memberships', { ...member, grants, version: randomUUID() }, connection);
      await this.audit(
        id,
        actor,
        '更新成员授权',
        (await this.db.get('accounts', accountId, connection))?.email ?? accountId,
        connection,
      );
      return null;
    });
  }

  async removeMember(actor: Admin, id: string, accountId: string) {
    return this.db.transaction(async (connection) => {
      await this.owner(actor.id, id, connection);
      const member = await this.member(id, accountId, connection);
      await this.db.remove('memberships', member.id, connection);
      await this.audit(
        id,
        actor,
        '撤销成员访问',
        (await this.db.get('accounts', accountId, connection))?.email ?? accountId,
        connection,
      );
      return null;
    });
  }

  async revokeInvite(actor: Admin, id: string, inviteId: string) {
    return this.db.transaction(async (connection) => {
      await this.owner(actor.id, id, connection);
      const invite = await this.db.get('invitations', inviteId, connection);
      if (invite?.workspaceId !== id) this.invalidInvitation();
      await this.db.remove('invitations', inviteId, connection);
      await this.audit(id, actor, '撤销协管邀请', invite.email, connection);
      return null;
    });
  }

  async platformList(actor: Admin): Promise<PlatformWorkspace[]> {
    this.platform(actor);
    return Promise.all(
      (await this.db.list('workspaces')).map(async (space) => {
        const account = await this.db.get('accounts', space.ownerId);
        return { ...space, owner: account ? { name: account.name, email: account.email } : null };
      }),
    );
  }

  async review(
    actor: Admin,
    id: string,
    patch: { status?: Workspace['status']; limits?: Workspace['limits'] },
  ) {
    this.platform(actor);
    return this.db.transaction(async (connection) => {
      const space = await this.db.get('workspaces', id, connection);
      if (!space) this.unavailable();
      const updated = { ...space, ...patch, reviewedAt: time() };
      await this.db.put('workspaces', updated, connection);
      await this.audit(id, actor, '平台更新工作空间', space.name, connection);
      return updated;
    });
  }

  private async owner(accountId: string, id: string, connection?: Connection) {
    const workspace = await this.db.get('workspaces', id, connection);
    if (workspace?.status !== 'active' || workspace.ownerId !== accountId)
      throw new BusinessError('OWNER_REQUIRED', '这项操作需要工作空间服主权限。', 403);
    return workspace;
  }

  private platform(actor: Admin) {
    if (!actor.platformAdmin)
      throw new BusinessError('PLATFORM_REQUIRED', '这项操作需要平台管理员权限。', 403);
  }

  private async member(id: string, accountId: string, connection: Connection): Promise<Membership> {
    const member = await this.db.get('memberships', membershipId(id, accountId), connection);
    if (!member) throw new BusinessError('MEMBER_MISSING', '这个工作空间成员不存在。', 404);
    return member;
  }

  private async validateGrants(id: string, grants: WorkspaceGrant[], connection: Connection) {
    await runInWorkspace(id, async () => {
      for (const { scope, mask } of grants) {
        const actions = permissionsFromMask(mask);
        if (!actions.length || !actions.every((action) => grantAllowsArea(scope, action)))
          throw new BusinessError('GRANT_INVALID', '授权的操作与资源范围不匹配。');
        if (
          (scope.kind === 'host' && !(await this.db.get('hosts', scope.id, connection))) ||
          (scope.kind === 'map' && !(await this.db.get('instances', scope.id, connection))) ||
          (scope.kind === 'cluster' &&
            !(await this.db.listBy('instances', 'clusterId', scope.id, connection)).length)
        )
          throw new BusinessError('GRANT_INVALID', '授权资源不存在于当前工作空间。');
      }
    });
  }

  private audit(id: string, actor: Admin, action: string, target: string, connection: Connection) {
    return runInWorkspace(id, () =>
      this.db.put(
        'audit',
        {
          id: randomUUID(),
          actor: actor.name + ' (' + actor.email + ')',
          actorId: actor.id,
          action,
          target,
          detail: '',
          createdAt: time(),
        },
        connection,
      ),
    );
  }

  private unavailable(): never {
    throw new BusinessError('WORKSPACE_UNAVAILABLE', '请选择已开通且你有权限的工作空间。', 403);
  }

  private invalidInvitation(): never {
    throw new BusinessError('INVITE_INVALID', '邀请无效、已过期或与当前账号不匹配。', 403);
  }
}
