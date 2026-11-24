import { readFile } from 'node:fs/promises';
import type { AgentCommand } from '@ark-control/common';
import { AgentClient } from '../../apps/agent/src/client';
import type { AgentConfig } from '../../apps/agent/src/config';
import { GameRuntime } from '../../apps/agent/src/runtime/runtime';

const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  config: AgentConfig;
  command: AgentCommand;
};
const client = new AgentClient(input.config);
const runtime = new GameRuntime(input.config, client, () => {});
await runtime.initialize();
const ack = `/commands/${input.command.id}/ack`;
let progress = '正在安装插件';
try {
  const result = await runtime.execute(input.command, new AbortController().signal, (value) => {
    progress = value;
  });
  await client.request(ack, { status: 'succeeded', progress, result });
} catch (error) {
  await client.request(ack, { status: 'failed', progress, error: (error as Error).message });
}
