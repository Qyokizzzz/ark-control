import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function diagnosticError(error: unknown) {
  const value = error as { name?: string; code?: string; message?: string; stack?: string };
  const redact = (text: string) =>
    text
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
      .replace(
        /((?:\w*(?:password|secret|token)|ENCRYPTION_KEY|JWT_SECRET)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
        '$1[redacted]',
      );
  return {
    name: value?.name ?? 'UnknownError',
    code: value?.code,
    message: redact(value?.message ?? 'Unknown error'),
    stack: redact(value?.stack ?? '').slice(0, 8000),
  };
}
export async function appendDiagnostic(path: string, entry: Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', { mode: 0o600 });
}
