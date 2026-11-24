import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ApiExceptionFilter,
  ApiResponseInterceptor,
  Database,
  browserOrigins,
  config,
} from '@/infrastructure';
import { AuthController, AuthGuard, AuthService, Public } from '@/auth';
import { ControlController, ControlService } from '@/control';
import {
  BotsController,
  BotsService,
  GatewayService,
  QqClient,
  QuotaService,
  QqWebhookController,
} from '@/qq';
import type { QqWebhookRequest } from '@/qq';
import { workspaceContext } from '@/workspaces/context';
import { WorkspacesService } from '@/workspaces/workspaces.service';
import {
  PlatformWorkspacesController,
  WorkspacesController,
} from '@/workspaces/workspaces.controller';
import { LogsController, LogsService, OutboxService } from '@/logs';
import { AgentGuard, AgentsController, AgentsService, EnrollmentController } from '@/agents';
import { AgentPackageController } from '@/agents/agent-package.controller';
import { AgentBackupsController, BackupsController } from '@/backups';
import { MaintenanceService } from '@/maintenance.service';
import {
  AgentServerPluginsController,
  ServerPluginsController,
  ServerPluginsService,
} from '@/server-plugins';
import {
  ManagementService,
  ManagementController,
  AgentManagementController,
  BranchUpdatesService,
  IndependentShopService,
} from '@/management';
import {
  ServerFilesService,
  ServerFilesController,
  AgentFileTasksController,
} from '@/server-files';
import {
  ConnectionsService,
  ConnectionsController,
  ConnectionManifestController,
  ConnectionRuntimeController,
} from '@/connections';

@Public()
@Controller('health')
class HealthController {
  @Get() health() {
    return {
      status: 'ok',
      version: '1.0.0',
      demo: config.DEMO_MODE === 'true',
      ...(config.ARK_RELEASE_ID ? { release: config.ARK_RELEASE_ID } : {}),
    };
  }
}
@Module({
  controllers: [
    WorkspacesController,
    PlatformWorkspacesController,
    ManagementController,
    AgentManagementController,
    ServerFilesController,
    AgentFileTasksController,
    ServerPluginsController,
    AgentServerPluginsController,
    HealthController,
    AuthController,
    ControlController,
    BotsController,
    QqWebhookController,
    LogsController,
    EnrollmentController,
    AgentPackageController,
    AgentsController,
    BackupsController,
    AgentBackupsController,
    ConnectionsController,
    ConnectionManifestController,
    ConnectionRuntimeController,
  ],
  providers: [
    WorkspacesService,
    ManagementService,
    IndependentShopService,
    BranchUpdatesService,
    ServerFilesService,
    ServerPluginsService,
    Database,
    AuthService,
    ControlService,
    QqClient,
    QuotaService,
    BotsService,
    GatewayService,
    LogsService,
    OutboxService,
    AgentGuard,
    AgentsService,
    ConnectionsService,
    MaintenanceService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
class AppModule {}

async function main() {
  const httpsOrigin = new URL(config.APP_ORIGIN).protocol === 'https:';
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn', 'log'],
  });
  app.setGlobalPrefix('api');
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
  app.use((_request: express.Request, _response: express.Response, next: express.NextFunction) => {
    workspaceContext.run({}, next);
  });
  app.use(
    helmet({
      strictTransportSecurity: httpsOrigin,
      contentSecurityPolicy: {
        directives: {
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'", 'data:'],
          'upgrade-insecure-requests': httpsOrigin ? [] : null,
        },
      },
    }),
  );
  app.use(
    express.json({
      limit: '4mb',
      verify(request, _response, buffer) {
        if (request.url?.startsWith('/api/qq/webhook/'))
          (request as QqWebhookRequest).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(cookieParser());
  app.enableCors({
    origin: browserOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Backup-Sha256', 'X-Ark-Workspace'],
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new ApiResponseInterceptor());
  const directory = resolve(config.WEB_DIST);
  if (existsSync(resolve(directory, 'index.html'))) {
    app.use(express.static(directory));
    app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
      if (request.method === 'GET' && !request.path.startsWith('/api'))
        response.sendFile(resolve(directory, 'index.html'));
      else next();
    });
  }
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, config.API_HOST);
}
void main().catch((error: unknown) => {
  console.error(
    '启动失败：',
    error instanceof Error
      ? error.message.replace(/password[^\s]*/gi, 'password=[redacted]')
      : '未知错误',
  );
  process.exitCode = 1;
});
