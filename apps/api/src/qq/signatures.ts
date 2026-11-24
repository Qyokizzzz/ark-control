import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// QQ derives an Ed25519 seed by repeating the UTF8 bytes of AppSecret to 32 bytes.
// The DER prefix wraps that seed using the standard PKCS#8 Ed25519 encoding.
export function qqSigningKey(secret: string) {
  const source = Buffer.from(secret, 'utf8');
  if (!source.length) throw new Error('QQ AppSecret is empty');
  const seed = Buffer.alloc(32);
  for (let index = 0; index < seed.length; ++index) seed[index] = source[index % source.length]!;
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function signQqChallenge(secret: string, timestamp: string, token: string): string {
  return sign(null, Buffer.from(timestamp + token), qqSigningKey(secret)).toString('hex');
}

export function verifyQqRequest(
  secret: string,
  timestamp: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-fA-F0-9]{128}$/.test(signature)) return false;
  try {
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp), rawBody]),
      createPublicKey(qqSigningKey(secret)),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}
