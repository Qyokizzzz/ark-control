import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import {
  BusinessError,
  Database,
  config,
  hashToken,
  newToken,
  tokensEqual,
} from '@/infrastructure';
import type { Admin } from '@ark-control/common';
import type { Account } from '@/infrastructure';
import { newWorkspace } from '@/workspaces/workspaces.service';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly key = new TextEncoder().encode(config.JWT_SECRET);
  constructor(@Inject(Database) private readonly db: Database) {}
  async onModuleInit() {
    if ((await this.db.list('accounts')).length) return;
    if (!config.INITIAL_ADMIN_PASSWORD)
      throw new Error('首次启动需要 INITIAL_ADMIN_PASSWORD，请运行 pnpm run setup。');
    await this.db.transaction(async (connection) => {
      if ((await this.db.list('accounts', connection)).length) return;
      const id = randomUUID();
      await this.db.put(
        'accounts',
        {
          id,
          email: config.INITIAL_ADMIN_EMAIL.toLowerCase(),
          name: '管理员',
          passwordHash: await bcrypt.hash(config.INITIAL_ADMIN_PASSWORD!, 12),
          platformAdmin: true,
        },
        connection,
      );
      await this.db.put('workspaces', newWorkspace(id, '我的工作空间', 'active'), connection);
    });
  }
  private async access(admin: Admin) {
    return new SignJWT({ email: admin.email, name: admin.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(admin.id)
      .setIssuer('ark-control')
      .setAudience('admin')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(this.key);
  }
  private async session(
    userId: string,
    familyId: string,
    connection: Parameters<Parameters<Database['transaction']>[0]>[0],
  ) {
    const id = randomUUID();
    const secret = newToken();
    const refreshToken = `${id}.${secret}`;
    await this.db.put(
      'sessions',
      {
        id,
        userId,
        familyId,
        hash: hashToken(secret),
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        revoked: false,
      },
      connection,
    );
    return refreshToken;
  }
  async login(email: string, password: string) {
    const [account] = await this.db.listBy('accounts', 'email', email.toLowerCase());
    if (!account || account.disabled || !(await bcrypt.compare(password, account.passwordHash)))
      throw new BusinessError('LOGIN_FAILED', '邮箱或密码不正确。', 401);
    const refreshToken = await this.db.transaction((connection) =>
      this.session(account.id, randomUUID(), connection),
    );
    const admin = this.publicAccount(account);
    return { accessToken: await this.access(admin), refreshToken, admin };
  }
  async register(name: string, email: string, password: string) {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await this.db.transaction(async (connection) => {
      if ((await this.db.listBy('accounts', 'email', email, connection)).length)
        throw new BusinessError('EMAIL_IN_USE', '邮箱已注册，请登录。', 409);
      const account: Account = { id: randomUUID(), email, name, passwordHash };
      await this.db.put('accounts', account, connection);
      return {
        admin: this.publicAccount(account),
        refreshToken: await this.session(account.id, randomUUID(), connection),
      };
    });
    return { ...result, accessToken: await this.access(result.admin) };
  }

  private publicAccount(account: Account): Admin {
    return {
      id: account.id,
      email: account.email,
      name: account.name,
      platformAdmin: !!account.platformAdmin,
    };
  }
  async refresh(token: string) {
    const [id, secret] = token.split('.');
    if (!id || !secret) throw new BusinessError('UNAUTHORIZED', '登录已过期，请重新登录。', 401);
    const result = await this.db.transaction(async (connection) => {
      const current = await this.db.get('sessions', id, connection);
      if (
        !current ||
        !tokensEqual(secret, current.hash) ||
        current.expiresAt < new Date().toISOString()
      )
        return null;
      if (current.revoked) {
        for (const session of await this.db.list('sessions', connection))
          if (session.familyId === current.familyId)
            await this.db.put('sessions', { ...session, revoked: true }, connection);
        return null;
      }
      const account = await this.db.get('accounts', current.userId, connection);
      if (!account || account.disabled) return null;
      await this.db.put('sessions', { ...current, revoked: true }, connection);
      const refreshToken = await this.session(account.id, current.familyId, connection);
      return { refreshToken, admin: this.publicAccount(account) };
    });
    if (!result) throw new BusinessError('UNAUTHORIZED', '登录已过期，请重新登录。', 401);
    return { ...result, accessToken: await this.access(result.admin) };
  }
  async logout(token: string) {
    const [id, secret] = token.split('.');
    if (!id || !secret) return;
    await this.db.transaction(async (connection) => {
      const current = await this.db.get('sessions', id, connection);
      if (!current || !tokensEqual(secret, current.hash)) return;
      for (const session of await this.db.list('sessions', connection))
        if (session.familyId === current.familyId)
          await this.db.put('sessions', { ...session, revoked: true }, connection);
    });
  }
  async verify(token: string): Promise<Admin> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: 'ark-control',
        audience: 'admin',
        algorithms: ['HS256'],
      });
      const account = payload.sub ? await this.db.get('accounts', payload.sub) : null;
      if (!account || account.disabled) throw new Error('Account unavailable');
      return this.publicAccount(account);
    } catch {
      throw new BusinessError('UNAUTHORIZED', '请先登录。', 401);
    }
  }
}
