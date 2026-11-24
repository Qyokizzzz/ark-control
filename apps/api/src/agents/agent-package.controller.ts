import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BusinessError, Database, config } from '@/infrastructure';
import { allowed, hostTarget } from '@/workspaces/access';
import { agentPackageOrigin, prepareAgentArchive } from '@/agents/agent-package';

@Controller('agent-package')
export class AgentPackageController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('windows') async windows(@Req() request: Request, @Res() response: Response) {
    if (
      !allowed('hosts.create') &&
      !(await this.db.list('hosts')).some((host) => allowed('hosts.enroll', hostTarget(host.id)))
    )
      throw new BusinessError('WORKSPACE_FORBIDDEN', '你没有接入主机的权限。', 403);
    const path = resolve(config.AGENT_WINDOWS_PACKAGE_PATH);
    const file = await open(path, 'r').catch(() => null);
    if (!file)
      throw new BusinessError(
        'AGENT_PACKAGE_MISSING',
        '平台尚未上传 Windows 主机助手安装包。',
        503,
      );
    try {
      const origin = agentPackageOrigin(config, request.socket.localAddress);
      const archive = await prepareAgentArchive(file, origin);
      response.set({
        'Content-Type': 'application/zip',
        'Content-Length': String(archive.length),
        'Content-Disposition': 'attachment; filename="ArkHostAgent-Windows-x64.zip"',
        'Cache-Control': 'no-store',
      });
      await pipeline(archive.stream, response);
    } finally {
      await file.close();
    }
  }
}
