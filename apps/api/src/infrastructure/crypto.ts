import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from '@/infrastructure/config';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export function tokensEqual(token: string, expectedHash: string): boolean {
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashToken(token), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function encryptSecret(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.ENCRYPTION_KEY, 'hex'), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}
export function decryptSecret(value: string): string {
  const [iv, tag, data] = value.split('.');
  if (!iv || !tag || data === undefined) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(config.ENCRYPTION_KEY, 'hex'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
