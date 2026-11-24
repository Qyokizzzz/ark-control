import { Catch, HttpException, Injectable } from '@nestjs/common';
import type {
  ArgumentsHost,
  CallHandler,
  ExceptionFilter,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';
import { z } from 'zod';
import { join } from 'node:path';
import { dataDir } from '@/infrastructure/config';
import { appendDiagnostic, diagnosticError } from '@/infrastructure/diagnostics';

export class BusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new BusinessError(
      'VALIDATION_ERROR',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '参数'}：${issue.message}`)
        .join('；'),
    );
  return parsed.data;
}
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const requestId = String(response.getHeader('X-Request-Id') ?? randomUUID());
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = '服务处理失败，请稍后重试或查看运行日志。';
    if (exception instanceof BusinessError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = status === 401 ? 'UNAUTHORIZED' : 'HTTP_ERROR';
      message = status >= 500 ? message : exception.message;
    }
    if (status >= 500) {
      const logFile = join(dataDir, 'logs', 'api-errors.log');
      const detail = {
        requestId,
        path: request.path,
        time: new Date().toISOString(),
        ...diagnosticError(exception),
        logFile,
      };
      console.error(JSON.stringify(detail));
      void appendDiagnostic(logFile, detail).catch(() => undefined);
    }
    if (!response.headersSent)
      response.status(status).json({ code, message, data: null, requestId });
  }
}
@Injectable()
export class ApiResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    const requestId = randomUUID();
    response.setHeader('X-Request-Id', requestId);
    return next
      .handle()
      .pipe(
        map((data: unknown) => ({ code: 'OK', message: '成功', data: data ?? null, requestId })),
      );
  }
}
