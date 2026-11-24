import { generateKeyPairSync, sign } from 'node:crypto';
import { CONNECT_FOOTER } from '@ark-control/common';
import type { ConnectionBootstrap, ConnectionManifest } from '@ark-control/common';

export function createSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: { n: jwk.n!, e: jwk.e! },
  };
}
export function signManifest(manifest: ConnectionManifest, privateKey: string) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return {
    payload: bytes.toString('base64'),
    signature: sign('RSA-SHA256', bytes, privateKey).toString('base64'),
  };
}
export function bootstrapTrailer(bootstrap: ConnectionBootstrap) {
  const json = Buffer.from(JSON.stringify(bootstrap));
  if (json.length > 65536) throw new Error('联机配置过大。');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  return Buffer.concat([json, size, Buffer.from(CONNECT_FOOTER)]);
}
