import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { relative } from 'node:path';
import { chatShopReceiptSchema, chatShopRequestSchema } from '@ark-control/common';
import type { AgentInstance, ChatShopReply } from '@ark-control/common';
import { AgentRequestError } from '@/client';
import type { AgentClient } from '@/client';
import { atomicJson, inside } from '@/files';
import { pluginDirectory } from './shop';

const filename = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(request|reply|receipt)\.json$/;

async function fileInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function remove(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function readRecord(path: string, size: number) {
  if (size > 4096) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    throw error;
  }
}

export async function checkIndependentShop(root: string, instance: AgentInstance) {
  if (instance.shopMode !== 'independent') return;
  if (process.platform !== 'win32') throw new Error('独立商店需要 Windows ASE 游戏主机。');
  const stock = inside(pluginDirectory(root, instance.id, 'ArkShop'), 'ArkShop.dll');
  if ((await fileInfo(stock)) || (await fileInfo(`${stock}.ArkApi`)))
    throw new Error(
      '此地图仍安装了 ArkShop。请先将 ArkShop 插件目录移出 ArkApi/Plugins，再启动独立商店。',
    );
  const directory = pluginDirectory(root, instance.id, 'ArkControlShop');
  const loader = inside(
    root,
    'instances',
    instance.id,
    'ShooterGame',
    'Binaries',
    'Win64',
    'version.dll',
  );
  if (!(await fileInfo(loader))?.isFile())
    throw new Error(
      '此地图尚未安装 Windows ASE ArkApi，请在 ShooterGame\\Binaries\\Win64 安装对应分支的 ArkApi。',
    );
  if (
    !(await fileInfo(inside(directory, 'ArkControlShop.dll')))?.isFile() ||
    !(await fileInfo(inside(directory, 'PluginInfo.json')))?.isFile()
  )
    throw new Error(`请安装 ASE ArkApi，并将独立商店插件解压到 ${directory} 后重新启动。`);
}

export class IndependentShopBridge {
  private busy = false;
  private lastError = '';

  constructor(
    private readonly root: string,
    private readonly client: Pick<AgentClient, 'request'>,
  ) {}

  async cycle(instances: Pick<AgentInstance, 'id'>[]) {
    if (this.busy) return;
    this.busy = true;
    try {
      const errors = new Set<string>();
      // Each map owns its files. A blocked map does not delay the other maps indefinitely.
      for (let offset = 0; offset < instances.length; offset += 4) {
        const results = await Promise.allSettled(
          instances.slice(offset, offset + 4).map((instance) => this.sync(instance.id)),
        );
        for (const result of results)
          if (result.status === 'rejected') {
            const error = result.reason;
            errors.add(
              error instanceof AgentRequestError ? error.message : '读取或写入游戏桥接队列失败。',
            );
          }
      }
      const message = [...errors].join('\n');
      if (message && this.lastError !== message) console.error('独立商店', message);
      this.lastError = message;
    } finally {
      this.busy = false;
    }
  }

  private async sync(instanceId: string) {
    const directory = inside(
      this.root,
      'instances',
      instanceId,
      'ShooterGame',
      'Saved',
      'ArkControlShop',
    );
    if (
      !(await fileInfo(directory))?.isDirectory() ||
      relative(directory, await realpath(directory))
    )
      return;
    const files = (await readdir(directory, { withFileTypes: true })).filter(
      (file) => file.isFile() && filename.test(file.name),
    );
    const endpoint = `/management/shop/${instanceId}`;
    for (const file of files.filter(({ name }) => name.endsWith('.receipt.json')).slice(0, 30)) {
      const path = inside(directory, file.name);
      const info = await fileInfo(path);
      if (!info?.isFile()) continue;
      const receipt = chatShopReceiptSchema.safeParse(await readRecord(path, info.size));
      if (receipt.success && file.name === `${receipt.data.id}.receipt.json`) {
        await this.client.request(`${endpoint}/receipt`, receipt.data).catch((error: unknown) => {
          if (error instanceof AgentRequestError && error.code === 'SHOP_ORDER_NOT_FOUND') return;
          throw error;
        });
      }
      await remove(path);
    }
    for (const file of files.filter(({ name }) => name.endsWith('.request.json')).slice(0, 30)) {
      const path = inside(directory, file.name);
      const info = await fileInfo(path);
      if (!info?.isFile()) continue;
      const request = chatShopRequestSchema.safeParse(await readRecord(path, info.size));
      if (request.success && file.name === `${request.data.id}.request.json`) {
        const reply = await this.client.request<ChatShopReply>(`${endpoint}/request`, request.data);
        await atomicJson(inside(directory, `${request.data.id}.reply.json`), reply);
      }
      await remove(path);
    }
    for (const file of files.filter(({ name }) => name.endsWith('.reply.json'))) {
      const path = inside(directory, file.name);
      const info = await fileInfo(path);
      if (info?.isFile() && Date.now() - info.mtimeMs > 5 * 60_000) await remove(path);
    }
  }
}
