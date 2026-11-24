import { isIPv6 } from 'node:net';

const address = process.env.SERVER_HOST?.trim() ?? '';
const authority = isIPv6(address) ? `[${address}]` : address.replace(/^https:\/\//i, '');
const origin = `https://${authority}`;
const authorityPattern = /^(?:[a-z0-9][a-z0-9._-]*|\[[a-f0-9:.]+\])(?::\d+)?\/?$/i;

if (!authorityPattern.test(authority) || !URL.canParse(origin)) {
  console.error('SERVER_HOST 请填写 API 的域名、IP 地址或 HTTPS 来源。');
  process.exit(1);
}

console.log(new URL(origin).origin);
