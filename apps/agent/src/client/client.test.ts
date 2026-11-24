import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAgentEnvelope } from './index';

afterEach(() => vi.unstubAllGlobals());
describe('agent connection diagnostics', () => {
  it('reports the failed endpoint and server request identifier for an internal error', async () => {
    const response = new Response(
      JSON.stringify({ code: 'INTERNAL_ERROR', message: '服务处理失败', requestId: 'request-123' }),
      { status: 500 },
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const error = await fetchAgentEnvelope('http://127.0.0.1:3000/api/agent/poll', {
      headers: { Authorization: 'Bearer private-test-token' },
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect((error as Error).message).toContain('/api/agent/poll');
    expect((error as Error).message).toContain('request-123');
    expect((error as Error).message).not.toContain('private-test-token');
  });
  it('distinguishes an unreachable server from a rejected agent credential', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
        ),
    );
    await expect(fetchAgentEnvelope('http://127.0.0.1:3000/api/agent/poll')).rejects.toMatchObject({
      code: 'AGENT_CONNECTION_FAILED',
      message: expect.stringContaining('ECONNREFUSED'),
    });
  });
  it('explains a wrong endpoint without printing the returned HTML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>private-server-output</html>')),
    );
    const error = await fetchAgentEnvelope('http://127.0.0.1:3000/api/agent/poll').catch(
      (value: unknown) => value,
    );
    expect(error).toMatchObject({ code: 'AGENT_RESPONSE_INVALID' });
    expect((error as Error).message).not.toContain('private-server-output');
  });
});
