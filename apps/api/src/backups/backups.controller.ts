import { Controller, Get, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BusinessError, Database, config, dataDir } from '@/infrastructure';
import { Public } from '@/auth';
import { AgentGuard } from '@/agents';
import type { AgentRequest } from '@/agents';
import { nowIso } from '@/control';
import { allowed, requireAccess } from '@/workspaces/access';
import { instanceTarget } from '@ark-control/common';

@Controller('backups')
export class BackupsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get(':id/download') async download(@Param('id') id: string, @Res() response: Response) {
    const backup = await this.db.get('backups', id);
    if (!backup || backup.status !== 'ready')
      throw new BusinessError('NOT_FOUND', '备份不存在或未完成。', 404);
    if (!allowed('backups.download')) {
      const instance = await this.db.get('instances', backup.instanceId);
      requireAccess(
        'backups.download',
        instance ? instanceTarget(instance) : { kind: 'map', instanceId: backup.instanceId },
      );
    }
    response.setHeader('content-type', 'application/zip');
    response.setHeader('content-disposition', `attachment; filename="${backup.id}.zip"`);
    await pipeline(
      createReadStream(join(dataDir, 'backups', this.db.workspaceId, `${backup.id}.zip`)),
      response,
    );
  }
}
@Public()
@UseGuards(AgentGuard)
@Controller('agent/backups')
export class AgentBackupsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Post(':commandId/upload') async upload(
    @Req() request: AgentRequest,
    @Param('commandId') commandId: string,
  ) {
    const command = await this.db.get('commands', commandId);
    if (
      !command ||
      command.hostId !== request.agentHostId ||
      !['backup', 'restore', 'update'].includes(command.kind) ||
      !['executing', 'cancelling'].includes(command.status)
    )
      throw new BusinessError('BACKUP_FORBIDDEN', '没有有效的备份上传任务。', 403);
    const requested = request.headers['x-backup-instance'];
    const instanceId = typeof requested === 'string' ? requested : command.instanceId;
    if (instanceId !== command.instanceId) {
      const [owner, peer] = await Promise.all([
        this.db.get('instances', command.instanceId),
        this.db.get('instances', instanceId),
      ]);
      if (
        command.kind !== 'update' ||
        !owner?.serverFileId ||
        owner.serverFileId !== peer?.serverFileId ||
        peer.hostId !== request.agentHostId
      )
        throw new BusinessError('BACKUP_FORBIDDEN', '只能备份同一主机共用此文件的地图。', 403);
    }
    const id = randomUUID();
    const directory = join(dataDir, 'backups', this.db.workspaceId);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `${id}.upload`);
    const target = join(directory, `${id}.zip`);
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > config.MAX_BACKUP_GB * 1024 ** 3)
          callback(new BusinessError('BACKUP_TOO_LARGE', '备份超过允许大小。', 413));
        else {
          hash.update(chunk);
          callback(null, chunk);
        }
      },
    });
    try {
      await pipeline(request as Request, meter, createWriteStream(temporary, { flags: 'wx' }));
      const sha256 = hash.digest('hex');
      const expected = request.headers['x-backup-sha256'];
      if (typeof expected === 'string' && expected !== sha256)
        throw new BusinessError('BACKUP_CHECKSUM', '备份校验失败，请重试。');
      await rename(temporary, target);
      const backup = {
        id,
        instanceId,
        commandId,
        name: `备份 ${nowIso().replace('T', ' ').slice(0, 19)}`,
        size,
        sha256,
        createdAt: nowIso(),
        status: 'ready' as const,
      };
      await this.db.transaction((connection) => this.db.put('backups', backup, connection));
      return backup;
    } catch (error) {
      await rm(temporary, { force: true });
      await rm(target, { force: true });
      throw error;
    }
  }
  @Get(':id/download') async download(
    @Req() request: AgentRequest,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const backup = await this.db.get('backups', id);
    const instance = backup ? await this.db.get('instances', backup.instanceId) : null;
    if (!backup || instance?.hostId !== request.agentHostId || backup.status !== 'ready')
      throw new BusinessError('BACKUP_FORBIDDEN', '备份不属于此主机。', 403);
    response.setHeader('content-type', 'application/zip');
    response.setHeader('x-backup-sha256', backup.sha256);
    await pipeline(
      createReadStream(join(dataDir, 'backups', this.db.workspaceId, `${backup.id}.zip`)),
      response,
    );
  }
}
