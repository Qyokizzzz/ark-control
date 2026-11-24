import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { loginSchema, registerSchema } from '@ark-control/common';
import { AuthService } from '@/auth/auth.service';
import { Public } from '@/auth/auth.guard';
import { BusinessError, browserOrigins, config, parse, separateWebOrigin } from '@/infrastructure';

function sessionCookie(request: Request): { name: string; options: CookieOptions } {
  const origin = request.get('Origin');
  if (separateWebOrigin && origin !== undefined && !browserOrigins.includes(origin))
    throw new BusinessError('AUTH_ORIGIN_FORBIDDEN', '此页面来源未获授权。', 403);
  const remote = origin === separateWebOrigin && !!separateWebOrigin;
  return {
    name: remote ? '__Secure-ark_web_refresh' : 'ark_refresh',
    options: {
      httpOnly: true,
      secure: remote || config.NODE_ENV === 'production',
      sameSite: remote ? 'none' : 'strict',
      partitioned: remote,
      path: '/api/auth',
    },
  };
}

@Public()
@Controller('auth')
export class AuthController {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly registrations = new Map<string, { count: number; until: number }>();
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private cookie(response: Response, session: ReturnType<typeof sessionCookie>, token: string) {
    response.set('Cache-Control', 'no-store');
    response.cookie(session.name, token, { ...session.options, maxAge: 7 * 86400000 });
  }
  @Post('register') async register(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = sessionCookie(request);
    const input = parse(registerSchema, body);
    const now = Date.now();
    for (const [ip, value] of this.registrations)
      if (value.until < now) this.registrations.delete(ip);
    const ip = request.ip ?? 'unknown';
    const entry = this.registrations.get(ip) ?? { count: 0, until: now + 15 * 60000 };
    if (entry.count >= 8)
      throw new BusinessError('RATE_LIMITED', '注册尝试过多，请稍后重试。', 429);
    entry.count++;
    this.registrations.set(ip, entry);
    const { refreshToken, ...result } = await this.auth.register(
      input.name,
      input.email.toLowerCase(),
      input.password,
    );
    this.cookie(response, session, refreshToken);
    return result;
  }
  @Post('login') async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = sessionCookie(request);
    const key = request.ip ?? 'unknown';
    const now = Date.now();
    for (const [ip, value] of this.attempts) if (value.until < now) this.attempts.delete(ip);
    const attempt = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60000 };
    if (attempt.count >= 10)
      throw new BusinessError('RATE_LIMITED', '尝试次数过多，请 15 分钟后重试。', 429);
    ++attempt.count;
    this.attempts.set(key, attempt);
    const data = parse(loginSchema, body);
    const { refreshToken, ...result } = await this.auth.login(data.email, data.password);
    this.attempts.delete(key);
    this.cookie(response, session, refreshToken);
    return result;
  }
  @Post('refresh') async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = sessionCookie(request);
    const { refreshToken, ...result } = await this.auth.refresh(
      String(request.cookies?.[session.name] ?? ''),
    );
    this.cookie(response, session, refreshToken);
    return result;
  }
  @Post('logout') async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = sessionCookie(request);
    await this.auth.logout(String(request.cookies?.[session.name] ?? ''));
    response.clearCookie(session.name, session.options);
    return null;
  }
}
