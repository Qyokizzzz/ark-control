import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDiagnostic, diagnosticError } from './diagnostics';

describe('server error diagnostics', () => {
  it('keeps the actual error code and stack while redacting credentials', () => {
    const error = Object.assign(
      new Error('token=abc123 password="password123" Authorization: Bearer private-bearer'),
      { code: 'ER_BAD_FIELD_ERROR' },
    );
    const result = diagnosticError(error);
    expect(result.code).toBe('ER_BAD_FIELD_ERROR');
    expect(result.stack).toContain('diagnostics.test');
    expect(JSON.stringify(result)).not.toContain('abc123');
    expect(JSON.stringify(result)).not.toContain('password123');
    expect(JSON.stringify(result)).not.toContain('private-bearer');
  });
  it('records the request identifier and endpoint for locating an otherwise generic 500 error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ark-diagnostic-test-'));
    const name = relative(resolve(tmpdir()), resolve(root));
    if (isAbsolute(name) || name.includes('..') || !name.startsWith('ark-diagnostic-test-'))
      throw new Error('拒绝清理非测试目录。');
    try {
      const path = join(root, 'logs/api-errors.log');
      await appendDiagnostic(path, {
        requestId: 'request-123',
        path: '/api/agent/poll',
        ...diagnosticError(new Error('Unknown column state')),
      });
      expect(JSON.parse((await readFile(path, 'utf8')).trim())).toMatchObject({
        requestId: 'request-123',
        path: '/api/agent/poll',
        message: 'Unknown column state',
      });
    } finally {
      await rm(resolve(root), { recursive: true, force: true });
    }
  });
});
