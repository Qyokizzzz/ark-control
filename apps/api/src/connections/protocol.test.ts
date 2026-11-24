import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConnectionBootstrap, ConnectionManifest } from '@ark-control/common';
import { CONNECT_FOOTER, connectionNetworkSchema } from '@ark-control/common';
import { bootstrapTrailer, createSigningKeys, signManifest } from './protocol';

describe('friend connection protocol', () => {
  it('signs exact manifest bytes and rejects target tampering', () => {
    const keys = createSigningKeys();
    const item = {
      networkId: 'network-a',
      inviteId: 'invite-a',
      revision: 2,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 120000,
      enabled: true,
      peers: ['tcp://public.easytier.cn:11010'],
      game: {
        ipv4: '10.126.126.2',
        gamePort: 7777,
        queryPort: 27015,
        name: 'Island',
        mapLabel: '孤岛',
        running: true,
      },
    } satisfies ConnectionManifest;
    const result = signManifest(item, keys.privateKey);
    const publicKey = createPublicKey({ key: { kty: 'RSA', ...keys.publicKey }, format: 'jwk' });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(result.payload, 'base64'),
        publicKey,
        Buffer.from(result.signature, 'base64'),
      ),
    ).toBe(true);
    const changed = Buffer.from(JSON.stringify({ ...item, enabled: false }));
    expect(verify('RSA-SHA256', changed, publicKey, Buffer.from(result.signature, 'base64'))).toBe(
      false,
    );
    expect(result).not.toHaveProperty('privateKey');
  });
  it('writes a bounded UTF-8 PE trailer with a byte length', () => {
    const bootstrap = {
      version: 1,
      networkId: '中文地图',
      inviteId: 'friend',
      inviteToken: 'secret',
    } as ConnectionBootstrap;
    const trailer = bootstrapTrailer(bootstrap);
    const footerLength = Buffer.byteLength(CONNECT_FOOTER);
    expect(trailer.subarray(-footerLength).toString()).toBe(CONNECT_FOOTER);
    const length = trailer.readUInt32LE(trailer.length - footerLength - 4);
    expect(JSON.parse(trailer.subarray(0, length).toString())).toEqual(bootstrap);
    expect(() => bootstrapTrailer({ ...bootstrap, networkId: 'a'.repeat(65536) })).toThrow();
  });
  it('accepts TCP/UDP bootstrap nodes and rejects credentials or unsupported schemes', () => {
    const input = {
      name: '联机入口',
      controllerHostId: 'c982ae05-fcb2-4cdf-bd09-aa6af0106107',
      instanceId: 'b8556a02-0460-40b9-a215-2e9c5c2b65c9',
      peers: ['tcp://public.easytier.cn:11010'],
    };
    expect(connectionNetworkSchema.safeParse(input).success).toBe(true);
    for (const peer of [
      'file:///C:/private',
      'http://node:11010',
      'tcp://user:password@node:11010',
      'udp://node:11010?secret=x',
    ])
      expect(connectionNetworkSchema.safeParse({ ...input, peers: [peer] }).success).toBe(false);
  });
});
