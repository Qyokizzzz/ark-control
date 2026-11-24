import { setTimeout } from 'node:timers/promises';
import { AgentClient } from '@/client';
import { readConfig } from '@/config';
import { IndependentShopBridge } from '@/management';

const id = process.argv[2];
if (!id) throw new Error('Missing verification map ID');
const config = await readConfig();
const bridge = new IndependentShopBridge(config.root, new AgentClient(config));
while (true) {
  await bridge.cycle([{ id }]);
  await setTimeout(250);
}
